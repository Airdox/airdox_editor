import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StemSeparationError } from './errors';
import { decodeWav, ensureStereo44k, encodeWavFloat32, fileFingerprint, sha256File } from './wavIo';

export interface WorkingCopyResult {
  path: string;
  data: Float32Array;
  frames: number;
  channels: 2;
  sampleRate: 44100;
  originalHash: string;
  originalSize: number;
  workingHash: string;
}

export async function createWorkingCopy(inputPath: string, workingRoot: string, jobId: string): Promise<WorkingCopyResult> {
  // ORIGINAL read-only check: sha256 before
  let beforeHash: string;
  let beforeSize: number;
  try {
    const fp = await fileFingerprint(inputPath);
    beforeHash = fp.sha256;
    beforeSize = fp.size;
  } catch (e) {
    throw new StemSeparationError('AUDIO_MISSING', `Original nicht lesbar: ${inputPath}`, e);
  }

  // Read and decode
  let wav;
  try {
    const bytes = await readFile(inputPath);
    wav = decodeWav(new Uint8Array(bytes));
  } catch (e) {
    throw new StemSeparationError('AUDIO_CORRUPT', `WAV decode fehlgeschlagen: ${inputPath}`, e);
  }

  if (!wav.frames || !wav.data.length) {
    throw new StemSeparationError('AUDIO_CORRUPT', `Leere Audiodatei: ${inputPath}`);
  }

  // Convert to 44.1k stereo float32 working copy
  let workingData: Float32Array;
  let workingFrames: number;
  try {
    const converted = ensureStereo44k(wav.data, wav.channels, wav.frames, wav.sampleRate);
    workingData = converted.data;
    workingFrames = converted.frames;
  } catch (e) {
    throw new StemSeparationError('WORKING_COPY_FAILED', `Working copy konnte nicht erstellt werden: ${inputPath}`, e);
  }

  // Write working copy to workingRoot/jobId/working.wav
  const jobDir = path.join(workingRoot, jobId);
  await mkdir(jobDir, { recursive: true });
  const workingPath = path.join(jobDir, 'working.wav');
  const wavBytes = encodeWavFloat32(44100, 2, workingData, workingFrames);
  await writeFile(workingPath, wavBytes);

  const workingHash = createHash('sha256').update(wavBytes).digest('hex');

  // ORIGINAL read-only check: sha256 after (must be unchanged)
  let afterHash: string;
  try {
    afterHash = await sha256File(inputPath);
  } catch (e) {
    throw new StemSeparationError('AUDIO_MISSING', `Original nach Working-Copy-Erstellung nicht lesbar: ${inputPath}`, e);
  }

  if (beforeHash !== afterHash) {
    throw new StemSeparationError('ORIGINAL_MODIFIED', `ORIGINAL wurde verändert! Vorher ${beforeHash.slice(0,16)} nachher ${afterHash.slice(0,16)} – HARD FAIL`, { beforeHash, afterHash });
  }

  return {
    path: workingPath,
    data: workingData,
    frames: workingFrames,
    channels: 2,
    sampleRate: 44100,
    originalHash: beforeHash,
    originalSize: beforeSize,
    workingHash,
  };
}

export async function verifyOriginalUnchanged(inputPath: string, expectedHash: string): Promise<void> {
  const actual = await sha256File(inputPath);
  if (actual !== expectedHash) {
    throw new StemSeparationError('ORIGINAL_MODIFIED', `Original-Hash hat sich geändert: erwartet ${expectedHash.slice(0,16)} tatsächlich ${actual.slice(0,16)}`);
  }
}
