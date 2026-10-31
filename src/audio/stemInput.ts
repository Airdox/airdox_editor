import { sha256Hex } from '../utils/sha256';

export interface PreparedStemInput {
  /** Canonical stereo 32-bit float WAV bytes sent to the separation engine. */
  wav: Uint8Array;
  /** Versioned SHA-256 identity of those exact working-copy bytes. */
  fingerprint: string;
}

/**
 * Encodes the exact input representation used by the local and remote stem
 * transports. Non-finite samples are normalized to silence; mono is duplicated
 * to stereo. Keep changes versioned because the fingerprint includes this WAV.
 */
function allocateStemInputWav(buffer: AudioBuffer): Uint8Array {
  const channels = 2;
  const bytesPerSample = 4;
  const dataSize = buffer.length * channels * bytesPerSample;
  if (!Number.isSafeInteger(dataSize) || dataSize > 0xffffffff - 36) {
    throw new RangeError('Die Stem-Arbeitskopie ist größer als das unterstützte RIFF-Format (4 GiB).');
  }

  const wav = new Uint8Array(44 + dataSize);
  const view = new DataView(wav.buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 32, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);

  return wav;
}

function encodeFrames(buffer: AudioBuffer, wav: Uint8Array, start: number, end: number): void {
  const view = new DataView(wav.buffer);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  for (let i = start; i < end; i++) {
    view.setFloat32(44 + i * 8, Number.isFinite(left[i]) ? left[i] : 0, true);
    view.setFloat32(48 + i * 8, Number.isFinite(right[i]) ? right[i] : 0, true);
  }
}

export function encodeStemInputWav(buffer: AudioBuffer): Uint8Array {
  const wav = allocateStemInputWav(buffer);
  encodeFrames(buffer, wav, 0, buffer.length);
  return wav;
}

export interface StemInputPreparationOptions {
  signal?: { readonly aborted: boolean };
}

function checkCancelled(signal?: { readonly aborted: boolean }): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('Die Separation wurde abgebrochen; es wurden keine Stems übernommen.'), { code: 'INFERENCE_CANCELLED' });
  }
}

// A macrotask lets React paint progress and lets a cancel click run between
// bounded PCM chunks. A resolved Promise would starve both on long tracks.
const yieldToRenderer = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Fingerprints the complete canonical bytes consumed by stem separation.
 * This is deliberately distinct from the original-file SHA-256.
 */
export async function fingerprintStemInputWav(wav: Uint8Array): Promise<string> {
  if (wav.byteOffset !== 0 || wav.byteLength !== wav.buffer.byteLength) {
    throw new RangeError('Stem-Input-Fingerprint erwartet einen vollständigen WAV-ArrayBuffer.');
  }
  const digest = await sha256Hex(wav.buffer as ArrayBuffer);
  return `stem-pcm-wav-v1:sha256:${digest}`;
}

export async function prepareStemInput(buffer: AudioBuffer, options: StemInputPreparationOptions = {}): Promise<PreparedStemInput> {
  checkCancelled(options.signal);
  await yieldToRenderer();
  checkCancelled(options.signal);
  const wav = allocateStemInputWav(buffer);
  const chunkFrames = 131_072;
  for (let start = 0; start < buffer.length; start += chunkFrames) {
    checkCancelled(options.signal);
    encodeFrames(buffer, wav, start, Math.min(buffer.length, start + chunkFrames));
    await yieldToRenderer();
  }
  checkCancelled(options.signal);
  const fingerprint = await fingerprintStemInputWav(wav);
  checkCancelled(options.signal);
  return { wav, fingerprint };
}
