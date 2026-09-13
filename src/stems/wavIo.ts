/**
 * Low level audio IO for the stem engine.
 *
 * - WAV decode for every common PCM/float layout (8/16/24/32 bit, float32/64,
 *   `WAVE_FORMAT_EXTENSIBLE`).
 * - Float32 WAV writer (the engine's internal transport format – no 16 bit
 *   quantisation anywhere between decode and inference).
 * - Kaiser windowed sinc resampling to 44.1 kHz.
 * - Channel handling that *preserves* stereo: mono is duplicated, stereo is
 *   never downmixed, >2 channels are reduced explicitly and reported.
 * - sha256 helpers for the non-destructive integrity checks and the cache key.
 *
 * Everything here is dependency free (node builtins only) so the core engine
 * runs in a bare `node`/`tsx` process.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

export interface DecodedAudio {
  sampleRate: number;
  channels: number;
  frames: number;
  /** Interleaved float32 in [-1, 1]. Length = frames * channels. */
  data: Float32Array;
  sourceFormat: string;
  /** e.g. `pcm_s16le`, `pcm_s24le`, `float32`, `float64`, `external-decoder` */
  encoding: string;
}

export class WavFormatError extends Error {}

export function sha256Bytes(bytes: Uint8Array | ArrayBuffer): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes));
  return hash.digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export async function fileFingerprint(path: string): Promise<{ sha256: string; size: number; mtimeMs: number }> {
  const [sha256, info] = await Promise.all([sha256File(path), stat(path)]);
  return { sha256, size: info.size, mtimeMs: info.mtimeMs };
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

interface WavLayout {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  formatTag: number;
  dataOffset: number;
  dataSize: number;
  blockAlign: number;
  validBitsPerSample?: number;
  channelMask?: number;
}

/** Parses RIFF/WAVE headers, including `WAVE_FORMAT_EXTENSIBLE`. */
export function parseWavLayout(bytes: Uint8Array): WavLayout {
  if (bytes.length < 44) throw new WavFormatError('Datei ist kleiner als ein WAV-Header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0, 4) !== 'RIFF') throw new WavFormatError('Kein RIFF-Container (RIFF-Chunk fehlt).');
  if (readAscii(view, 8, 4) !== 'WAVE') throw new WavFormatError('RIFF-Container enthält kein WAVE-Format.');

  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number; formatTag: number; blockAlign: number; validBitsPerSample?: number; channelMask?: number } | null = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      const formatTag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      let validBitsPerSample: number | undefined;
      let channelMask: number | undefined;
      if (formatTag === 0xfffe && chunkSize >= 40) {
        channelMask = view.getUint32(body + 20, true);
        validBitsPerSample = view.getUint16(body + 18, true);
      }
      if (channels === 0 || sampleRate === 0 || bitsPerSample === 0) {
        throw new WavFormatError('Ungültiger fmt-Chunk (Kanäle, Samplerate oder Bittiefe sind 0).');
      }
      fmt = { channels, sampleRate, bitsPerSample, formatTag, blockAlign, validBitsPerSample, channelMask };
    } else if (chunkId === 'data') {
      dataOffset = body;
      // A truncated file is accepted; the real byte count wins over the header.
      dataSize = Math.min(chunkSize, bytes.length - body);
    }
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (!fmt) throw new WavFormatError('fmt-Chunk fehlt.');
  if (dataOffset < 0) throw new WavFormatError('data-Chunk fehlt.');
  if (![1, 3, 0xfffe].includes(fmt.formatTag)) {
    throw new WavFormatError(`Nicht unterstütztes WAV-Format-Tag 0x${fmt.formatTag.toString(16)} (nur PCM/IEEE-Float/Extensible).`);
  }
  return { ...fmt, dataOffset, dataSize };
}

/** Converts a WAV buffer into interleaved float32 samples. */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const layout = parseWavLayout(bytes);
  const { channels, sampleRate, bitsPerSample, formatTag, blockAlign, dataOffset, dataSize } = layout;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = Math.floor(dataSize / Math.max(1, blockAlign));
  const data = new Float32Array(frames * channels);
  const bytesPerSample = bitsPerSample / 8;
  const isFloat = formatTag === 3 || (formatTag === 0xfffe && bitsPerSample === 32);

  let read = 0;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const at = dataOffset + f * blockAlign + c * bytesPerSample;
      if (at + bytesPerSample > bytes.length) break;
      let value = 0;
      if (bitsPerSample === 8) value = (view.getUint8(at) - 128) / 128;
      else if (bitsPerSample === 16) value = view.getInt16(at, true) / 32768;
      else if (bitsPerSample === 24) {
        const b0 = view.getUint8(at);
        const b1 = view.getUint8(at + 1);
        const b2 = view.getUint8(at + 2);
        let v = (b2 << 16) | (b1 << 8) | b0;
        if (v & 0x800000) v -= 0x1000000;
        value = v / 8388608;
      } else if (bitsPerSample === 32 && isFloat) value = view.getFloat32(at, true);
      else if (bitsPerSample === 32) value = view.getInt32(at, true) / 2147483648;
      else if (bitsPerSample === 64) value = view.getFloat64(at, true);
      else throw new WavFormatError(`Nicht unterstützte Bittiefe: ${bitsPerSample}`);
      data[read++] = Number.isFinite(value) ? value : 0;
    }
  }

  const encoding = isFloat
    ? bitsPerSample === 64 ? 'float64' : 'float32'
    : `pcm_s${bitsPerSample}le`;
  return { sampleRate, channels, frames, data, sourceFormat: 'wav', encoding };
}

/** Writes interleaved float32 audio as an IEEE-float WAV file. */
export function encodeWavFloat32(sampleRate: number, channels: number, data: Float32Array, frames?: number): Uint8Array {
  const ch = Math.max(1, Math.floor(channels));
  const frameCount = Math.floor(frames ?? data.length / ch);
  const bytesPerSample = 4;
  const blockAlign = ch * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, ch, true);
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let f = 0; f < frameCount; f++) {
    for (let c = 0; c < ch; c++) {
      const value = data[f * ch + c];
      view.setFloat32(44 + (f * ch + c) * 4, Number.isFinite(value) ? value : 0, true);
    }
  }
  return bytes;
}

/** Zeroth order modified Bessel function, used for the Kaiser window. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k <= 25; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

const KAISER_BETA = 9.0;
const KAISER_DENOM = besselI0(KAISER_BETA);

function kaiserWindow(x: number): number {
  // x in [-1, 1]
  if (x <= -1 || x >= 1) return 0;
  return besselI0(KAISER_BETA * Math.sqrt(1 - x * x)) / KAISER_DENOM;
}

/**
 * Band limited resampling with a Kaiser windowed sinc kernel (32 taps per
 * side). Anti-aliases on the way down, interpolates on the way up. This is the
 * only resampler used on the way to the working copy, so a 48 kHz master never
 * reaches the model through a cheap linear interpolation.
 */
export function resample(input: Float32Array, channels: number, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  if (fromRate <= 0 || toRate <= 0) throw new WavFormatError(`Ungültige Samplerate: ${fromRate} -> ${toRate}`);
  const ratio = fromRate / toRate;
  const inFrames = Math.floor(input.length / channels);
  const outFrames = Math.max(1, Math.round(inFrames / ratio));
  const output = new Float32Array(outFrames * channels);
  const halfTaps = 32;
  const cutoff = Math.min(1, 1 / ratio) * 0.95;
  const support = halfTaps * Math.max(1, ratio);

  for (let n = 0; n < outFrames; n++) {
    const center = n * ratio;
    const start = Math.max(0, Math.ceil(center - support));
    const end = Math.min(inFrames - 1, Math.floor(center + support));
    const weights: number[] = [];
    let weightSum = 0;
    for (let i = start; i <= end; i++) {
      const x = (i - center) / Math.max(1, ratio);
      const sincArg = Math.PI * cutoff * x;
      const sinc = Math.abs(sincArg) < 1e-9 ? 1 : Math.sin(sincArg) / sincArg;
      const w = cutoff * sinc * kaiserWindow(x / halfTaps);
      weights.push(w);
      weightSum += w;
    }
    const norm = weightSum !== 0 ? 1 / weightSum : 0;
    for (let c = 0; c < channels; c++) {
      let acc = 0;
      for (let k = 0, i = start; i <= end; i++, k++) acc += input[i * channels + c] * weights[k] * norm;
      output[n * channels + c] = acc;
    }
  }
  return output;
}

export interface ChannelPlanResult {
  data: Float32Array;
  frames: number;
  channels: 2;
  conversion: 'stereo-preserved' | 'mono-duplicated' | 'multichannel-reduced';
  detail: string;
}

/**
 * Stereo preservation rule (§9):
 *  - 2 channels: untouched, sample for sample.
 *  - 1 channel: duplicated, never silently treated as stereo content.
 *  - >2 channels: front pair kept (no summing, no phase tricks) and reported.
 */
export function ensureStereo(decoded: DecodedAudio): ChannelPlanResult {
  const { channels, frames, data } = decoded;
  if (channels === 2) {
    return { data, frames, channels: 2, conversion: 'stereo-preserved', detail: 'Stereo unverändert übernommen' };
  }
  if (channels === 1) {
    const out = new Float32Array(frames * 2);
    for (let f = 0; f < frames; f++) {
      out[f * 2] = data[f];
      out[f * 2 + 1] = data[f];
    }
    return { data: out, frames, channels: 2, conversion: 'mono-duplicated', detail: 'Mono nach Stereo dupliziert' };
  }
  const out = new Float32Array(frames * 2);
  for (let f = 0; f < frames; f++) {
    out[f * 2] = data[f * channels];
    out[f * 2 + 1] = data[f * channels + 1];
  }
  return {
    data: out,
    frames,
    channels: 2,
    conversion: 'multichannel-reduced',
    detail: `${channels} Kanäle auf das Front-Paar reduziert`,
  };
}

export interface ExternalDecoder {
  (filePath: string): Promise<DecodedAudio> | DecodedAudio;
}

/**
 * Decodes an audio file. WAV is handled natively; other containers are handed
 * to an injected decoder (browser `decodeAudioData`, ffmpeg, Electron bridge).
 * Without a decoder the format is rejected – never silently misread.
 */
export async function decodeAudioFile(filePath: string, external?: ExternalDecoder): Promise<DecodedAudio> {
  const ext = filePath.toLowerCase().split('.').pop() || '';
  if (ext === 'wav' || ext === 'wave' || ext === 'aif' || ext === 'aiff') {
    const bytes = await readFile(filePath);
    if (ext === 'aif' || ext === 'aiff') {
      if (!external) throw new WavFormatError('AIFF benötigt einen externen Decoder (ffmpeg oder Web Audio).');
      return external(filePath);
    }
    return decodeWav(new Uint8Array(bytes));
  }
  if (!external) {
    throw new WavFormatError(`Format .${ext} kann ohne externen Decoder nicht gelesen werden.`);
  }
  return external(filePath);
}

export interface AudioStats {
  peak: number;
  rms: number;
  dc: number;
  frames: number;
  channels: number;
  finite: boolean;
  /** Mid/side correlation in [-1, 1]; NaN for mono content. */
  stereoCorrelation: number;
  /** RMS of the side signal relative to mid – a stereo width indicator. */
  sideToMidRatio: number;
}

export function analyzeAudio(data: Float32Array, channels: number, frames: number): AudioStats {
  let peak = 0;
  let sumSq = 0;
  let sum = 0;
  let finite = true;
  const n = Math.min(data.length, frames * channels);
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) { finite = false; continue; }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
    sum += v;
  }
  let midSq = 0;
  let sideSq = 0;
  let midSide = 0;
  if (channels === 2) {
    for (let f = 0; f < frames; f++) {
      const l = data[f * 2] || 0;
      const r = data[f * 2 + 1] || 0;
      const m = (l + r) * 0.5;
      const s = (l - r) * 0.5;
      midSq += m * m;
      sideSq += s * s;
      midSide += m * s;
    }
  }
  const denom = Math.sqrt(midSq * sideSq);
  return {
    peak,
    rms: n > 0 ? Math.sqrt(sumSq / n) : 0,
    dc: n > 0 ? sum / n : 0,
    frames,
    channels,
    finite,
    stereoCorrelation: denom > 1e-12 ? midSide / denom : 0,
    sideToMidRatio: midSq > 1e-12 ? Math.sqrt(sideSq / midSq) : 0,
  };
}

/** Interleaved -> planar split, used by validators and metrics. */
export function toPlanar(data: Float32Array, channels: number, frames: number): Float32Array[] {
  const planar: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) planar[c][f] = data[f * channels + c] || 0;
  }
  return planar;
}

export async function readWavFile(path: string): Promise<DecodedAudio> {
  const bytes = await readFile(path);
  return decodeWav(new Uint8Array(bytes));
}
