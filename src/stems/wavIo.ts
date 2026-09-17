import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

export interface WavAudio {
  data: Float32Array;
  channels: number;
  frames: number;
  sampleRate: number;
  bitsPerSample: number;
  audioFormat: number;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWavFloat32(sampleRate: number, channels: number, data: Float32Array, frames = Math.floor(data.length / Math.max(1, channels))): Uint8Array {
  const ch = Math.max(1, Math.floor(channels));
  const count = Math.max(0, Math.min(Math.floor(frames), Math.floor(data.length / ch)));
  const dataSize = count * ch * 4;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, ch, true); view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * ch * 4, true); view.setUint16(32, ch * 4, true); view.setUint16(34, 32, true);
  writeAscii(view, 36, 'data'); view.setUint32(40, dataSize, true);
  for (let i = 0; i < count * ch; i++) view.setFloat32(44 + i * 4, Number.isFinite(data[i]) ? data[i] : 0, true);
  return bytes;
}

export function encodeWavInt24(sampleRate: number, channels: number, data: Float32Array, frames = Math.floor(data.length / Math.max(1, channels))): Uint8Array {
  const ch = Math.max(1, Math.floor(channels));
  const count = Math.max(0, Math.min(Math.floor(frames), Math.floor(data.length / ch)));
  const dataSize = count * ch * 3;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, ch, true); view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * ch * 3, true); view.setUint16(32, ch * 3, true); view.setUint16(34, 24, true);
  writeAscii(view, 36, 'data'); view.setUint32(40, dataSize, true);
  for (let i = 0; i < count * ch; i++) {
    let value = Math.round(Math.max(-1, Math.min(1, Number.isFinite(data[i]) ? data[i] : 0)) * 8388608);
    value = Math.max(-8388608, Math.min(8388607, value));
    const at = 44 + i * 3;
    view.setUint8(at, value & 255); view.setUint8(at + 1, (value >> 8) & 255); view.setUint8(at + 2, (value >> 16) & 255);
  }
  return bytes;
}

export function encodeWavInt16(sampleRate: number, channels: number, data: Float32Array, frames = Math.floor(data.length / Math.max(1, channels))): Uint8Array {
  const ch = Math.max(1, Math.floor(channels));
  const count = Math.max(0, Math.min(Math.floor(frames), Math.floor(data.length / ch)));
  const dataSize = count * ch * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, ch, true); view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * ch * 2, true); view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data'); view.setUint32(40, dataSize, true);
  for (let i = 0; i < count * ch; i++) {
    const v = Math.max(-1, Math.min(1, Number.isFinite(data[i]) ? data[i] : 0));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return bytes;
}

function findChunk(bytes: Uint8Array, id: string, from: number): { offset: number; size: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let p = from; p + 8 <= bytes.byteLength;) {
    let name = ''; for (let i = 0; i < 4; i++) name += String.fromCharCode(view.getUint8(p + i));
    const size = view.getUint32(p + 4, true);
    if (name === id) return { offset: p + 8, size: Math.min(size, bytes.byteLength - p - 8) };
    p += 8 + size + (size & 1);
  }
  return undefined;
}

export function decodeWav(bytes: Uint8Array): WavAudio {
  if (bytes.byteLength < 44) throw new Error('WAV-Datei ist zu kurz');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new Error('Kein RIFF/WAVE');
  const fmt = findChunk(bytes, 'fmt ', 12); const dataChunk = findChunk(bytes, 'data', 12);
  if (!fmt || !dataChunk || fmt.size < 16) throw new Error('WAV enthält kein gültiges fmt/data Chunk');
  const f = new DataView(bytes.buffer, bytes.byteOffset + fmt.offset, fmt.size);
  const audioFormat = f.getUint16(0, true); const channels = f.getUint16(2, true);
  const sampleRate = f.getUint32(4, true); const bits = f.getUint16(14, true);
  if (!channels || !sampleRate || ![1, 3].includes(audioFormat) || ![8, 16, 24, 32].includes(bits)) throw new Error('Nicht unterstütztes WAV-Format');
  const bytesPerSample = Math.ceil(bits / 8); const sampleCount = Math.floor(dataChunk.size / bytesPerSample);
  const out = new Float32Array(sampleCount);
  const d = new DataView(bytes.buffer, bytes.byteOffset + dataChunk.offset, dataChunk.size);
  for (let i = 0; i < sampleCount; i++) {
    const at = i * bytesPerSample;
    if (audioFormat === 3 && bits === 32) out[i] = d.getFloat32(at, true);
    else if (bits === 8) out[i] = (d.getUint8(at) - 128) / 128;
    else if (bits === 16) out[i] = d.getInt16(at, true) / 32768;
    else if (bits === 24) {
      const u = d.getUint8(at) | (d.getUint8(at + 1) << 8) | (d.getUint8(at + 2) << 16);
      out[i] = (u & 0x800000 ? u - 0x1000000 : u) / 8388608;
    } else out[i] = d.getInt32(at, true) / 2147483648;
  }
  return { data: out, channels, frames: Math.floor(out.length / channels), sampleRate, bitsPerSample: bits, audioFormat };
}

export async function readWavFile(filePath: string): Promise<WavAudio> {
  try { return decodeWav(new Uint8Array(await readFile(filePath))); }
  catch (error) { throw new Error(`WAV konnte nicht gelesen werden: ${filePath}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function toPlanar(data: Float32Array, channels: number, frames: number): Float32Array[] {
  const ch = Math.max(1, channels); const out = Array.from({ length: ch }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) for (let c = 0; c < ch; c++) out[c][f] = data[f * ch + c] || 0;
  return out;
}

export function fromPlanar(planar: Float32Array[], frames: number): Float32Array {
  const ch = planar.length;
  const out = new Float32Array(frames * ch);
  for (let f = 0; f < frames; f++) for (let c = 0; c < ch; c++) out[f * ch + c] = planar[c][f] || 0;
  return out;
}

export interface AudioAnalysis {
  peak: number; rms: number; durationSeconds: number; channels: number; sampleRate: number;
  stereoCorrelation: number; sideToMidRatio: number;
}

export function analyzeAudio(data: Float32Array, channels: number, frames: number, sampleRate = 44100): AudioAnalysis {
  const ch = Math.max(1, channels); let sum = 0; let peak = 0;
  for (let i = 0; i < Math.min(data.length, frames * ch); i++) { const v = data[i] || 0; sum += v * v; peak = Math.max(peak, Math.abs(v)); }
  let corr = 1; let side = 0; let mid = 0;
  if (ch >= 2) {
    let ll = 0, rr = 0, lr = 0;
    for (let f = 0; f < frames; f++) { const l = data[f * ch] || 0; const r = data[f * ch + 1] || 0; ll += l * l; rr += r * r; lr += l * r; const m = (l + r) * .5; const s = (l - r) * .5; mid += m * m; side += s * s; }
    corr = ll && rr ? lr / Math.sqrt(ll * rr) : 1;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, Math.min(data.length, frames * ch))), durationSeconds: frames / sampleRate, channels: ch, sampleRate, stereoCorrelation: Math.max(-1, Math.min(1, corr)), sideToMidRatio: Math.sqrt(side / Math.max(1e-18, mid)) };
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export async function fileFingerprint(filePath: string): Promise<{ sha256: string; size: number }> {
  const [hash, info] = await Promise.all([sha256File(filePath), stat(filePath)]);
  return { sha256: hash, size: info.size };
}

export function sha256Bytes(data: Uint8Array | Float32Array): string {
  const buf = data instanceof Float32Array ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data;
  return createHash('sha256').update(buf).digest('hex');
}

export function resampleLinear(data: Float32Array, channels: number, fromRate: number, toRate: number): { data: Float32Array; frames: number } {
  if (fromRate === toRate) return { data, frames: Math.floor(data.length / channels) };
  const ratio = toRate / fromRate;
  const inFrames = Math.floor(data.length / channels);
  const outFrames = Math.max(1, Math.floor(inFrames * ratio));
  const out = new Float32Array(outFrames * channels);
  for (let c = 0; c < channels; c++) {
    for (let f = 0; f < outFrames; f++) {
      const srcPos = f / ratio;
      const srcIdx = Math.floor(srcPos);
      const frac = srcPos - srcIdx;
      const s0 = srcIdx < inFrames ? data[srcIdx * channels + c] : 0;
      const s1 = srcIdx + 1 < inFrames ? data[(srcIdx + 1) * channels + c] : s0;
      out[f * channels + c] = s0 * (1 - frac) + s1 * frac;
    }
  }
  return { data: out, frames: outFrames };
}

export function ensureStereo44k(data: Float32Array, channels: number, frames: number, sampleRate: number): { data: Float32Array; frames: number; sampleRate: 44100; channels: 2 } {
  let currentData = data;
  let currentFrames = frames;
  let currentRate = sampleRate;
  let currentChannels = channels;

  // Resample to 44.1k if needed
  if (currentRate !== 44100) {
    const resampled = resampleLinear(currentData, currentChannels, currentRate, 44100);
    currentData = resampled.data;
    currentFrames = resampled.frames;
    currentRate = 44100;
  }

  // Convert to stereo if needed
  if (currentChannels === 1) {
    const stereo = new Float32Array(currentFrames * 2);
    for (let f = 0; f < currentFrames; f++) {
      const v = currentData[f] || 0;
      stereo[f * 2] = v;
      stereo[f * 2 + 1] = v;
    }
    currentData = stereo;
    currentChannels = 2;
  } else if (currentChannels > 2) {
    // Downmix to stereo: keep first two channels
    const stereo = new Float32Array(currentFrames * 2);
    for (let f = 0; f < currentFrames; f++) {
      stereo[f * 2] = currentData[f * currentChannels] || 0;
      stereo[f * 2 + 1] = currentData[f * currentChannels + 1] || 0;
    }
    currentData = stereo;
    currentChannels = 2;
  }

  return { data: currentData, frames: currentFrames, sampleRate: 44100 as const, channels: 2 as const };
}

export function hashSettings(settings: Record<string, unknown>): string {
  const canonical = JSON.stringify(settings, Object.keys(settings).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
