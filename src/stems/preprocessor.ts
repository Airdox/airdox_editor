/**
 * Preprocessor – non destructive preparation of the model input (§3, §8, §9).
 *
 * Pipeline: ORIGINAL (read only) -> fingerprint -> WORKING COPY -> 44.1 kHz
 * stereo float32 WAV. The original file is opened read-only, hashed before any
 * work happens and re-verified afterwards. Nothing in the engine ever writes
 * into the directory of the original.
 */
import { open, mkdir, writeFile, access, constants } from 'node:fs/promises';
import path from 'node:path';
import { StemSeparationError, classifyFailure } from './errors';
import {
  analyzeAudio,
  decodeAudioFile,
  encodeWavFloat32,
  ensureStereo,
  fileFingerprint,
  resample,
  sha256Bytes,
  sha256File,
  ResampleCancelledError,
  type DecodedAudio,
  type ExternalDecoder,
} from './wavIo';
import type { OriginalIntegrity } from './types';

export const TARGET_SAMPLE_RATE = 44100;
export const TARGET_CHANNELS = 2;

export interface WorkingCopy {
  originalPath: string;
  workingPath: string;
  /** sha256 of the ORIGINAL file – the identity used by jobs and cache. */
  inputAudioHash: string;
  sampleRate: number;
  channels: number;
  frames: number;
  seconds: number;
  sourceFormat: string;
  sourceEncoding: string;
  sourceSampleRate: number;
  sourceChannels: number;
  channelPlan: 'stereo-preserved' | 'mono-duplicated' | 'multichannel-reduced';
  channelPlanDetail: string;
  resampled: boolean;
  peak: number;
  rms: number;
  integrity: OriginalIntegrity;
}

/**
 * Phasen der Arbeitskopie-Vorbereitung. `fraction` ist der Fortschritt *innerhalb*
 * der Phase (0..1); die Engine mappt das auf den Job-Fortschritt, damit die UI
 * während mehrminütiger Preps (Resampling) keinen statischen Text sieht.
 */
export interface WorkingCopyProgress {
  phase: 'fingerprint' | 'decode' | 'resample' | 'encode' | 'verify';
  fraction: number;
}

export interface PrepareOptions {
  workingRoot: string;
  /** Override of the engine sample rate; the engine default is 44.1 kHz. */
  targetSampleRate?: number;
  externalDecoder?: ExternalDecoder;
  /** Base name for the working copy, defaults to the original base name. */
  baseName?: string;
  /** Job-Token (oder beliebiger Abbruchzustand) – Abbruch auch während der Prep. */
  token?: { readonly cancelled: boolean };
  onProgress?: (progress: WorkingCopyProgress) => void;
}

async function assertReadable(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.R_OK);
  } catch (error) {
    throw classifyFailure('AUDIO_MISSING', `Originaldatei ist nicht lesbar: ${filePath}`, error);
  }
  // Opening with 'r' only: a write attempt on the original must never happen.
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    throw classifyFailure('AUDIO_MISSING', `Originaldatei konnte nicht geöffnet werden: ${filePath}`, error);
  }
  await handle.close();
}

function sanitizeBaseName(value: string): string {
  const cleaned = value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'track';
}

export async function fingerprintOriginal(originalPath: string): Promise<OriginalIntegrity> {
  const info = await fileFingerprint(originalPath);
  return {
    path: originalPath,
    sha256Before: info.sha256,
    sizeBefore: info.size,
    mtimeMsBefore: info.mtimeMs,
    unchanged: true,
    checkedAt: Date.now(),
  };
}

/**
 * Re-reads the original and compares hash/size/mtime with the snapshot.
 * A changed original is a hard failure (`ORIGINAL_MODIFIED`) – no result is
 * presented, because the separation would describe a different file.
 */
export async function verifyOriginalIntegrity(snapshot: OriginalIntegrity): Promise<OriginalIntegrity> {
  let info;
  try {
    info = await fileFingerprint(snapshot.path);
  } catch (error) {
    throw classifyFailure('AUDIO_MISSING', `Originaldatei ist nach der Verarbeitung nicht mehr lesbar: ${snapshot.path}`, error);
  }
  const updated: OriginalIntegrity = {
    ...snapshot,
    sha256After: info.sha256,
    sizeAfter: info.size,
    mtimeMsAfter: info.mtimeMs,
    unchanged:
      info.sha256 === snapshot.sha256Before &&
      info.size === snapshot.sizeBefore &&
      info.mtimeMs === snapshot.mtimeMsBefore,
    checkedAt: Date.now(),
  };
  if (!updated.unchanged) {
    throw new StemSeparationError('ORIGINAL_MODIFIED', 'Die Originaldatei wurde während der Verarbeitung verändert', {
      path: snapshot.path,
      sha256Before: snapshot.sha256Before,
      sha256After: updated.sha256After,
      sizeBefore: snapshot.sizeBefore,
      sizeAfter: updated.sizeAfter,
    });
  }
  return updated;
}

/**
 * Creates the working copy: decode -> stereo plan -> 44.1 kHz -> float32 WAV.
 * The returned working copy is the only file the separation engine reads.
 */
export async function prepareWorkingCopy(originalPath: string, options: PrepareOptions): Promise<WorkingCopy> {
  const progress = options.onProgress;
  const token = options.token;
  const assertNotCancelled = (): void => {
    if (token?.cancelled) throw new StemSeparationError('INFERENCE_CANCELLED', 'Arbeitskopie-Vorbereitung abgebrochen');
  };

  await assertReadable(originalPath);
  progress?.({ phase: 'fingerprint', fraction: 0 });
  const integrity = await fingerprintOriginal(originalPath);
  progress?.({ phase: 'fingerprint', fraction: 1 });

  assertNotCancelled();
  progress?.({ phase: 'decode', fraction: 0 });
  let decoded: DecodedAudio;
  try {
    decoded = await decodeAudioFile(originalPath, options.externalDecoder);
  } catch (error) {
    if (error instanceof StemSeparationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code = /header|RIFF|fmt|data-Chunk|kleiner/i.test(message) ? 'AUDIO_CORRUPT' : 'AUDIO_UNSUPPORTED_FORMAT';
    throw classifyFailure(code, `Audiodatei konnte nicht dekodiert werden: ${originalPath}`, error);
  }
  progress?.({ phase: 'decode', fraction: 1 });

  if (!Number.isFinite(decoded.sampleRate) || decoded.sampleRate < 8000 || decoded.sampleRate > 384000) {
    throw new StemSeparationError('AUDIO_INVALID_SAMPLE_RATE', `Samplerate ${decoded.sampleRate} Hz wird nicht unterstützt`, {
      sampleRate: decoded.sampleRate,
    });
  }
  if (decoded.frames === 0) {
    throw new StemSeparationError('AUDIO_CORRUPT', 'Audiodatei enthält keine Samples');
  }

  const targetSampleRate = options.targetSampleRate ?? TARGET_SAMPLE_RATE;
  const stereo = ensureStereo(decoded);
  const resampled = decoded.sampleRate !== targetSampleRate;
  // Resampling ist der dominante Teil der Arbeitskopie (mehrere Minuten bei
  // 48 kHz-Quellen auf CPUs). Es gibt in Teilschritten an die Event-Loop-Hände
  // und meldet Fortschritt, damit IPC/UI weiterlaufen und Abbruch greift.
  const data = resampled
    ? await resample(stereo.data, TARGET_CHANNELS, decoded.sampleRate, targetSampleRate, {
        yieldEveryFrames: 100_000,
        isCancelled: token ? () => token.cancelled : undefined,
        onProgress: (fraction) => progress?.({ phase: 'resample', fraction }),
      }).catch((error) => {
        if (error instanceof ResampleCancelledError) {
          throw new StemSeparationError('INFERENCE_CANCELLED', 'Arbeitskopie-Vorbereitung abgebrochen');
        }
        throw error;
      })
    : stereo.data;
  const frames = resampled ? Math.floor(data.length / TARGET_CHANNELS) : stereo.frames;

  assertNotCancelled();
  const stats = analyzeAudio(data, TARGET_CHANNELS, frames);
  if (!stats.finite) {
    throw new StemSeparationError('AUDIO_CORRUPT', 'Audiodaten enthalten NaN/Infinity');
  }

  const targetSampleRateHz = targetSampleRate;
  if (targetSampleRateHz !== TARGET_SAMPLE_RATE) {
    throw new StemSeparationError('AUDIO_INVALID_SAMPLE_RATE', `Engine-Ziel-Samplerate ${targetSampleRateHz} Hz ist nicht 44100 Hz`, {});
  }

  assertNotCancelled();
  progress?.({ phase: 'encode', fraction: 0 });
  const baseName = sanitizeBaseName(options.baseName ?? path.basename(originalPath, path.extname(originalPath)));
  const workingPath = path.join(options.workingRoot, `${baseName}_${targetSampleRate / 1000}k_stereo.wav`);
  const wav = encodeWavFloat32(targetSampleRate, TARGET_CHANNELS, data, frames);

  await mkdir(options.workingRoot, { recursive: true });
  try {
    await writeFile(workingPath, wav);
  } catch (error) {
    throw classifyFailure('WRITE_DENIED', `Arbeitskopie konnte nicht geschrieben werden: ${workingPath}`, error);
  }

  // The working copy must be byte exact: re-read and compare before inference.
  // Beide Seiten per Stream/View hashen (statt Buffer-Kopien): bei 127 MB
  // Arbeitskopie spart das zwei Vollkopien plus einen kompletten Re-Read in
  // den Heap.
  progress?.({ phase: 'verify', fraction: 0 });
  const [diskHash, memoryHash] = await Promise.all([sha256File(workingPath), Promise.resolve(sha256Bytes(wav))]);
  if (diskHash !== memoryHash) {
    throw new StemSeparationError('AUDIO_CORRUPT', 'Arbeitskopie stimmt nicht mit dem geschriebenen Inhalt überein', { workingPath });
  }
  progress?.({ phase: 'verify', fraction: 1 });

  return {
    originalPath,
    workingPath,
    inputAudioHash: integrity.sha256Before,
    sampleRate: targetSampleRate,
    channels: TARGET_CHANNELS,
    frames,
    seconds: frames / targetSampleRate,
    sourceFormat: decoded.sourceFormat,
    sourceEncoding: decoded.encoding,
    sourceSampleRate: decoded.sampleRate,
    sourceChannels: decoded.channels,
    channelPlan: stereo.conversion,
    channelPlanDetail: stereo.detail,
    resampled,
    peak: stats.peak,
    rms: stats.rms,
    integrity,
  };
}
