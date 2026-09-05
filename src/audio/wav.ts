/**
 * @license
 * Airdox_intelligents_Editor – WAV-Codec (rein, ohne DOM)
 *
 * Kapselt das Format, in dem der Editor Audio verlässt (16-Bit-PCM-WAV) und in
 * dem Projekte ihre Audiodaten einbetten. Dasselbe Modul liest die Dateien wieder,
 * damit Tests den Export gegen die Arbeitsdaten prüfen können.
 */

import { PcmAudio, pcmSampleCount } from './pcm';

export interface WavDecodeResult {
  pcm: PcmAudio;
  format: number;
  bitDepth: number;
  warnings: string[];
}

/** 16-Bit-PCM-WAV, interleave Stereo/Mono – identisch zum bisherigen Export. */
export function encodeWav(pcm: PcmAudio): Uint8Array {
  const sampleRate = pcm.sampleRate;
  const channels = pcm.channels.length > 1 ? 2 : 1;
  const left = pcm.channels[0] ?? new Float32Array(0);
  const right = channels > 1 ? pcm.channels[1] : left;
  const numSamples = pcmSampleCount(pcm);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = numSamples * blockAlign;

  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);

  const str = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  str(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);

  const toInt16 = (value: number) => Math.max(-32768, Math.min(32767, Math.round(value * 32768)));

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const sL = Math.max(-1, Math.min(1, left[i] ?? 0));
    const sR = Math.max(-1, Math.min(1, right[i] ?? 0));
    view.setInt16(offset, toInt16(sL), true);
    offset += 2;
    if (channels > 1) {
      view.setInt16(offset, toInt16(sR), true);
      offset += 2;
    }
  }
  return bytes;
}

export function encodeWavBlob(pcm: PcmAudio): Blob {
  return new Blob([encodeWav(pcm).buffer as ArrayBuffer], { type: 'audio/wav' });
}

/** Liest RIFF/WAVE mit PCM8/16/24/32 und IEEE-float32; unbekannte Chunks werden übersprungen. */
export function decodeWav(input: ArrayBuffer | Uint8Array | ArrayBufferView): WavDecodeResult {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const warnings: string[] = [];
  const text = (offset: number, size: number) => {
    let out = '';
    for (let i = 0; i < size; i++) out += String.fromCharCode(bytes[offset + i]);
    return out;
  };

  if (bytes.length < 44) throw new Error('WAV-Datei zu kurz für einen RIFF-Header');
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') {
    throw new Error('Kein RIFF/WAVE-Container');
  }

  let audioFormat = 1;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const id = text(cursor, 4);
    const size = view.getUint32(cursor + 4, true);
    const body = cursor + 8;
    if (id === 'fmt ') {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, bytes.length - body);
    } else if (id === 'LIST' || id === 'fact' || id === 'bext' || id === 'iXML') {
      warnings.push(`Chunk „${id}" (${size} Bytes) wurde beim Lesen ignoriert.`);
    }
    cursor = body + size + (size % 2);
  }

  if (channels <= 0 || sampleRate <= 0 || bitDepth <= 0) {
    throw new Error('WAV-Datei enthält keinen gültigen fmt-Chunk');
  }
  if (dataOffset < 0) throw new Error('WAV-Datei enthält keinen data-Chunk');
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`Nur unkomprimierte WAVs unterstützt (Audioformat ${audioFormat}, z. B. IEEE-float=3)`);
  }

  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const sampleCount = Math.floor(dataLength / blockAlign);
  const out: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(sampleCount));

  for (let i = 0; i < sampleCount; i++) {
    const base = dataOffset + i * blockAlign;
    for (let ch = 0; ch < channels; ch++) {
      const at = base + ch * bytesPerSample;
      let value = 0;
      if (audioFormat === 3 && bitDepth === 32) {
        value = view.getFloat32(at, true);
      } else if (bitDepth === 16) {
        value = view.getInt16(at, true) / 32768;
      } else if (bitDepth === 8) {
        value = (view.getUint8(at) - 128) / 128;
      } else if (bitDepth === 24) {
        const raw = (view.getUint32(at, true) << 8) >> 8;
        value = raw / 8388608;
      } else if (bitDepth === 32) {
        value = view.getInt32(at, true) / 2147483648;
      }
      out[ch][i] = value;
    }
  }

  if (sampleCount === 0) warnings.push('Der data-Chunk enthält keine Samples.');
  return { pcm: { sampleRate, channels: out }, format: audioFormat, bitDepth, warnings };
}

/** Base64 für die Einbettung in Projektdateien (binär sicher, auch für große Daten). */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
