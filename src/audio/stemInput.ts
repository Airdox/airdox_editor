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
export function encodeStemInputWav(buffer: AudioBuffer): Uint8Array {
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

  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    const l = left[i];
    const r = right[i];
    view.setFloat32(offset, Number.isFinite(l) ? l : 0, true);
    view.setFloat32(offset + bytesPerSample, Number.isFinite(r) ? r : 0, true);
    offset += bytesPerSample * 2;
  }

  return wav;
}

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

export async function prepareStemInput(buffer: AudioBuffer): Promise<PreparedStemInput> {
  const wav = encodeStemInputWav(buffer);
  const fingerprint = await fingerprintStemInputWav(wav);
  return { wav, fingerprint };
}
