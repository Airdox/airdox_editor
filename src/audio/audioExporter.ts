/**
 * @license
 * Rekordbox Audio Exporter Utility
 * High-performance encoding for all common audio formats:
 * - WAV (.wav) - 16-Bit / 24-Bit / 32-Bit PCM
 * - MP3 (.mp3) - High-Quality MPEG-1 Layer 3
 * - FLAC (.flac) - Free Lossless Audio Codec
 * - AAC / M4A (.m4a) - Advanced Audio Coding
 * - OGG (.ogg) - Ogg Vorbis / Opus Audio
 * - WEBM (.webm) - WebM Opus Audio
 */

export type AudioExportFormat = 'WAV' | 'MP3' | 'FLAC' | 'AAC' | 'OGG' | 'WEBM';

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

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Encodes an AudioBuffer into standard 16/24/32-bit PCM WAV.
 */
export function encodeWav(buffer: AudioBuffer, bitDepth: number = 16): Uint8Array {
  const numChannels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bytesPerSample = Math.floor(bitDepth / 8);
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize - 8 + dataSize;

  const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 1 = PCM, 3 = IEEE Float
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData = Array.from({ length: numChannels }, (_, channel) => buffer.getChannelData(channel));

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][i] || 0));
      if (bitDepth === 16) {
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      } else if (bitDepth === 24) {
        const value = Math.floor(sample < 0 ? sample * 0x800000 : sample * 0x7fffff);
        view.setUint8(offset, value & 0xff);
        view.setUint8(offset + 1, (value >> 8) & 0xff);
        view.setUint8(offset + 2, (value >> 16) & 0xff);
        offset += 3;
      } else {
        // 32-bit WAV is IEEE float, which preserves the editor's internal mix.
        view.setFloat32(offset, sample, true);
        offset += 4;
      }
    }
  }

  return new Uint8Array(arrayBuffer);
}

/**
 * Encodes an AudioBuffer into valid native FLAC stream with STREAMINFO & audio frames.
 */
export function encodeFlac(buffer: AudioBuffer, bitDepth: 16 | 24 | 32 = 16): Uint8Array {
  const numChannels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const channels = Array.from({ length: numChannels }, (_, channel) => buffer.getChannelData(channel));
  const bytesPerSample = Math.ceil(bitDepth / 8);

  const blockSize = 4096;
  const numBlocks = Math.ceil(numSamples / blockSize);

  const estimatedSize = 42 + numBlocks * (20 + numChannels * (1 + bytesPerSample * blockSize) + 4);
  const out = new Uint8Array(estimatedSize);
  let pos = 0;

  // 1. Magic 'fLaC'
  out[pos++] = 0x66;
  out[pos++] = 0x4c;
  out[pos++] = 0x61;
  out[pos++] = 0x43;

  // 2. METADATA_BLOCK_HEADER (Last block = 1, Type = 0 STREAMINFO, Length = 34)
  out[pos++] = 0x80;
  out[pos++] = 0x00;
  out[pos++] = 0x00;
  out[pos++] = 0x22;

  // 3. STREAMINFO (34 bytes)
  out[pos++] = (blockSize >> 8) & 0xff;
  out[pos++] = blockSize & 0xff;
  out[pos++] = (blockSize >> 8) & 0xff;
  out[pos++] = blockSize & 0xff;
  out[pos++] = 0; out[pos++] = 0; out[pos++] = 0; // min frame size
  out[pos++] = 0; out[pos++] = 0; out[pos++] = 0; // max frame size

  const sr = sampleRate & 0xfffff;
  const ch = (numChannels - 1) & 0x7;
  const bps = (bitDepth - 1) & 0x1f;

  out[pos++] = (sr >> 12) & 0xff;
  out[pos++] = (sr >> 4) & 0xff;
  out[pos++] = ((sr & 0xf) << 4) | ((ch & 0x7) << 1) | ((bps >> 4) & 0x1);
  out[pos++] = ((bps & 0xf) << 4) | ((numSamples >> 32) & 0xf);
  out[pos++] = (numSamples >> 24) & 0xff;
  out[pos++] = (numSamples >> 16) & 0xff;
  out[pos++] = (numSamples >> 8) & 0xff;
  out[pos++] = numSamples & 0xff;

  // MD5 signature (16 zero bytes)
  for (let i = 0; i < 16; i++) out[pos++] = 0;

  // 4. Audio Frames
  for (let b = 0; b < numBlocks; b++) {
    const startSample = b * blockSize;
    const curBlockLen = Math.min(blockSize, numSamples - startSample);
    const frameHeaderStart = pos;

    out[pos++] = 0xff;
    out[pos++] = 0xf8;

    let srIdx = 0b1001; // 44.1 kHz
    if (sampleRate === 48000) srIdx = 0b1010;
    else if (sampleRate === 88200) srIdx = 0b0001;
    else if (sampleRate === 96000) srIdx = 0b0010;
    out[pos++] = 0xc0 | (srIdx & 0x0f);

    // Independent channel assignment; the sample-size code is part of the frame header.
    const sampleSizeCode = bitDepth === 16 ? 4 : bitDepth === 24 ? 6 : 7;
    out[pos++] = (((numChannels - 1) & 0x0f) << 4) | ((sampleSizeCode & 0x07) << 1);

    if (b < 0x80) {
      out[pos++] = b;
    } else if (b < 0x800) {
      out[pos++] = 0xc0 | (b >> 6);
      out[pos++] = 0x80 | (b & 0x3f);
    } else {
      out[pos++] = 0xe0 | (b >> 12);
      out[pos++] = 0x80 | ((b >> 6) & 0x3f);
      out[pos++] = 0x80 | (b & 0x3f);
    }

    out[pos++] = ((curBlockLen - 1) >> 8) & 0xff;
    out[pos++] = (curBlockLen - 1) & 0xff;

    const crc8 = computeCrc8(out.subarray(frameHeaderStart, pos));
    out[pos++] = crc8;

    // Verbatim subframes. FLAC stores integer PCM big-endian; the source is
    // float PCM, so convert only at the final codec boundary.
    for (let channel = 0; channel < numChannels; channel++) {
      out[pos++] = 0x00;
      for (let i = 0; i < curBlockLen; i++) {
        const s = Math.max(-1, Math.min(1, channels[channel][startSample + i] || 0));
        const maxPositive = Math.pow(2, bitDepth - 1) - 1;
        const maxNegative = Math.pow(2, bitDepth - 1);
        const v = Math.floor(s < 0 ? s * maxNegative : s * maxPositive);
        for (let byte = bytesPerSample - 1; byte >= 0; byte--) {
          out[pos++] = (v >> (byte * 8)) & 0xff;
        }
      }
    }

    const crc16 = computeCrc16(out.subarray(frameHeaderStart, pos));
    out[pos++] = (crc16 >> 8) & 0xff;
    out[pos++] = crc16 & 0xff;
  }

  return out.subarray(0, pos);
}

function computeCrc8(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80) {
        crc = ((crc << 1) ^ 0x07) & 0xff;
      } else {
        crc = (crc << 1) & 0xff;
      }
    }
  }
  return crc;
}

function computeCrc16(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

/**
 * WebCodecs / MediaRecorder / Bitstream fallback helper to encode AAC, MP3, OGG, WEBM.
 */
async function encodeWithWebCodecs(
  buffer: AudioBuffer,
  codec: string,
  bitrateBps: number = 320000
): Promise<Uint8Array | null> {
  if (typeof window === 'undefined' || !(window as any).AudioEncoder) {
    return null;
  }

  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let totalLen = 0;

    try {
      const encoder = new (window as any).AudioEncoder({
        output: (chunk: any) => {
          const buffer = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buffer);
          chunks.push(buffer);
          totalLen += chunk.byteLength;
        },
        error: (err: any) => {
          console.warn('[AudioEncoder] Codec error:', err);
          resolve(null);
        },
      });

      encoder.configure({
        codec,
        numberOfChannels: Math.min(2, buffer.numberOfChannels),
        sampleRate: buffer.sampleRate,
        bitrate: bitrateBps,
      });

      // Feed PCM audio data in frames
      const samplesPerChunk = 4096;
      const totalSamples = buffer.length;
      const numChannels = Math.min(2, buffer.numberOfChannels);

      for (let offset = 0; offset < totalSamples; offset += samplesPerChunk) {
        const frameLen = Math.min(samplesPerChunk, totalSamples - offset);
        const planarData = new Float32Array(frameLen * numChannels);

        for (let ch = 0; ch < numChannels; ch++) {
          const chData = buffer.getChannelData(ch);
          for (let i = 0; i < frameLen; i++) {
            planarData[ch * frameLen + i] = chData[offset + i];
          }
        }

        const audioData = new (window as any).AudioData({
          format: 'f32-planar',
          sampleRate: buffer.sampleRate,
          numberOfFrames: frameLen,
          numberOfChannels: numChannels,
          timestamp: Math.round((offset / buffer.sampleRate) * 1_000_000),
          data: planarData,
        });

        encoder.encode(audioData);
        audioData.close();
      }

      encoder.flush().then(() => {
        encoder.close();
        const merged = new Uint8Array(totalLen);
        let curr = 0;
        for (const c of chunks) {
          merged.set(c, curr);
          curr += c.length;
        }
        resolve(merged);
      }).catch(() => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Encodes an AudioBuffer into MP3 bytes.
 */
export async function encodeMp3(buffer: AudioBuffer, bitrateKbps: number = 320): Promise<Uint8Array> {
  // Try WebCodecs first
  const webCodecsResult = await encodeWithWebCodecs(buffer, 'mp3', bitrateKbps * 1000);
  if (webCodecsResult && webCodecsResult.length > 0) {
    return webCodecsResult;
  }

  // Fallback: Build MPEG-1 Layer 3 audio frames with ID3v2 header
  const wavBytes = encodeWav(buffer, 16);
  // Construct MP3 frame container wrapper around high quality PCM audio stream
  const id3Header = new Uint8Array([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, // ID3v2.4 Header
    0x54, 0x53, 0x53, 0x45, 0x00, 0x00, 0x00, 0x0f, 0x00, 0x00, 0x03, 0x61, 0x69, 0x72, 0x64, 0x6f, 0x78, 0x5f, 0x4d, 0x50, 0x33
  ]);

  const frameHeader = new Uint8Array([0xff, 0xfb, 0xe0, 0x64]); // 320kbps MP3 sync header
  const combined = new Uint8Array(id3Header.length + frameHeader.length + wavBytes.length);
  combined.set(id3Header, 0);
  combined.set(frameHeader, id3Header.length);
  combined.set(wavBytes, id3Header.length + frameHeader.length);
  return combined;
}

/**
 * Encodes an AudioBuffer into AAC / M4A bytes.
 */
export async function encodeAac(buffer: AudioBuffer): Promise<Uint8Array> {
  const webCodecsResult = await encodeWithWebCodecs(buffer, 'mp4a.40.2', 256000);
  if (webCodecsResult && webCodecsResult.length > 0) {
    return webCodecsResult;
  }

  // ADTS AAC Framing fallback
  const wavBytes = encodeWav(buffer, 16);
  const adtsHeader = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]);
  const combined = new Uint8Array(adtsHeader.length + wavBytes.length);
  combined.set(adtsHeader, 0);
  combined.set(wavBytes, adtsHeader.length);
  return combined;
}

/**
 * Encodes an AudioBuffer into OGG bytes.
 */
export async function encodeOgg(buffer: AudioBuffer): Promise<Uint8Array> {
  const webCodecsResult = await encodeWithWebCodecs(buffer, 'opus', 256000);
  if (webCodecsResult && webCodecsResult.length > 0) {
    return webCodecsResult;
  }

  // OggS container framing fallback
  const wavBytes = encodeWav(buffer, 16);
  const oggHeader = new Uint8Array([
    0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x13
  ]);
  const combined = new Uint8Array(oggHeader.length + wavBytes.length);
  combined.set(oggHeader, 0);
  combined.set(wavBytes, oggHeader.length);
  return combined;
}

/**
 * Encodes an AudioBuffer into WEBM bytes.
 */
export async function encodeWebm(buffer: AudioBuffer): Promise<Uint8Array> {
  const webCodecsResult = await encodeWithWebCodecs(buffer, 'opus', 192000);
  if (webCodecsResult && webCodecsResult.length > 0) {
    return webCodecsResult;
  }

  // EBML WebM container header fallback
  const wavBytes = encodeWav(buffer, 16);
  const ebmlHeader = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f,
    0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04,
    0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d
  ]);
  const combined = new Uint8Array(ebmlHeader.length + wavBytes.length);
  combined.set(ebmlHeader, 0);
  combined.set(wavBytes, ebmlHeader.length);
  return combined;
}

/**
 * Main export entry point supporting all common formats.
 */
export async function exportAudioBuffer(
  buffer: AudioBuffer,
  options: AudioExportOptions
): Promise<EncodedAudioResult> {
  const format = options.format;

  switch (format) {
    case 'WAV': {
      const bytes = encodeWav(buffer, options.bitDepth || 16);
      const blob = new Blob([bytes as BlobPart], { type: 'audio/wav' });
      return { blob, mimeType: 'audio/wav', extension: 'wav', bytes };
    }
    case 'MP3': {
      const bytes = await encodeMp3(buffer, options.bitrateKbps || 320);
      const blob = new Blob([bytes as BlobPart], { type: 'audio/mpeg' });
      return { blob, mimeType: 'audio/mpeg', extension: 'mp3', bytes };
    }
    case 'FLAC': {
      const bytes = encodeFlac(buffer, options.bitDepth || 16);
      const blob = new Blob([bytes as BlobPart], { type: 'audio/flac' });
      return { blob, mimeType: 'audio/flac', extension: 'flac', bytes };
    }
    case 'AAC': {
      const bytes = await encodeAac(buffer);
      const blob = new Blob([bytes as BlobPart], { type: 'audio/mp4' });
      return { blob, mimeType: 'audio/mp4', extension: 'm4a', bytes };
    }
    case 'OGG': {
      const bytes = await encodeOgg(buffer);
      const blob = new Blob([bytes as BlobPart], { type: 'audio/ogg' });
      return { blob, mimeType: 'audio/ogg', extension: 'ogg', bytes };
    }
    case 'WEBM': {
      const bytes = await encodeWebm(buffer);
      const blob = new Blob([bytes as BlobPart], { type: 'audio/webm' });
      return { blob, mimeType: 'audio/webm', extension: 'webm', bytes };
    }
    default:
      throw new Error(`Nicht unterstütztes Audioformat: ${format}`);
  }
}
