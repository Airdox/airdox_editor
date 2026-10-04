/**
 * @license
 * Rekordbox Audio Exporter Utility
 *
 * Only formats with a verified encoder/container are exposed as available.
 * WAV is currently implemented; compressed formats stay in the public format
 * union for UI compatibility, but fail explicitly until real encoders exist.
 */

export type AudioExportFormat = 'WAV' | 'MP3' | 'FLAC' | 'AAC' | 'OGG' | 'WEBM';
export type SupportedAudioExportFormat = 'WAV';

export interface AudioExportOptions {
  format: AudioExportFormat;
  bitDepth?: 16 | 24 | 32;
  sampleRate?: number;
  bitrateKbps?: number;
}

export interface EncodedAudioResult {
  blob: Blob;
  mimeType: string;
  extension: string;
  bytes: Uint8Array;
}

export class AudioExportFormatUnavailableError extends Error {
  constructor(readonly format: AudioExportFormat) {
    super(`Der ${format}-Export ist derzeit nicht verfügbar: Für dieses Format ist kein verifizierter Encoder mit passendem Container integriert. Bitte WAV verwenden.`);
    this.name = 'AudioExportFormatUnavailableError';
  }
}

export function isAudioExportFormatSupported(format: AudioExportFormat): format is SupportedAudioExportFormat {
  return format === 'WAV';
}

function writeString(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

/** Encodes an AudioBuffer into interleaved PCM/IEEE-float RIFF/WAVE bytes. */
export function encodeWav(buffer: AudioBuffer, bitDepth: 16 | 24 | 32 = 16): Uint8Array {
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) {
    throw new RangeError(`Nicht unterstützte WAV-Bittiefe: ${bitDepth}`);
  }

  const numChannels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  // RIFF uses 32-bit chunk lengths. Refuse RF64-sized output instead of
  // silently wrapping the header and producing an unreadable file.
  if (!Number.isSafeInteger(dataSize) || dataSize > 0xffffffff - 36) {
    throw new RangeError('Die WAV-Datei ist größer als das unterstützte RIFF-Format (4 GiB).');
  }

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // IEEE float for 32-bit, integer PCM otherwise
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: numChannels }, (_, channel) => buffer.getChannelData(channel));
  let offset = headerSize;
  for (let i = 0; i < numSamples; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const rawSample = channels[channel][i];
      const sample = Number.isFinite(rawSample) ? Math.max(-1, Math.min(1, rawSample)) : 0;

      if (bitDepth === 16) {
        view.setInt16(offset, Math.trunc(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
        offset += 2;
      } else if (bitDepth === 24) {
        const value = Math.trunc(sample < 0 ? sample * 0x800000 : sample * 0x7fffff);
        view.setUint8(offset, value & 0xff);
        view.setUint8(offset + 1, (value >> 8) & 0xff);
        view.setUint8(offset + 2, (value >> 16) & 0xff);
        offset += 3;
      } else {
        view.setFloat32(offset, sample, true);
        offset += 4;
      }
    }
  }

  return new Uint8Array(arrayBuffer);
}

/** Exports only a format backed by a real encoder. */
export async function exportAudioBuffer(
  buffer: AudioBuffer,
  options: AudioExportOptions
): Promise<EncodedAudioResult> {
  if (!isAudioExportFormatSupported(options.format)) {
    throw new AudioExportFormatUnavailableError(options.format);
  }

  const bytes = encodeWav(buffer, options.bitDepth ?? 16);
  const blob = new Blob([bytes as BlobPart], { type: 'audio/wav' });
  return { blob, mimeType: 'audio/wav', extension: 'wav', bytes };
}
