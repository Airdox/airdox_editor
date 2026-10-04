import assert from 'node:assert/strict';
import {
  AudioExportFormatUnavailableError,
  encodeWav,
  exportAudioBuffer,
  isAudioExportFormatSupported,
} from '../src/audio/audioExporter';
import type { AudioExportFormat } from '../src/audio/audioExporter';

function createMockAudioBuffer(channels: Float32Array[], sampleRate = 48000): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  return {
    numberOfChannels: channels.length,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (channel: number) => channels[channel],
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
}

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function readInt24LE(view: DataView, offset: number): number {
  const unsigned = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
  return unsigned & 0x800000 ? unsigned | 0xff000000 : unsigned;
}

async function runExportTests() {
  const input = createMockAudioBuffer([
    new Float32Array([-1, -0.5, 0, 0.5, 1]),
    new Float32Array([1, 0.5, 0, -0.5, -1]),
  ]);

  // PCM 16-bit output has a consistent RIFF/WAVE header and interleaved samples.
  const wav16 = await exportAudioBuffer(input, { format: 'WAV', bitDepth: 16 });
  assert.equal(wav16.extension, 'wav');
  assert.equal(wav16.mimeType, 'audio/wav');
  assert.equal(wav16.blob.type, 'audio/wav');
  assert.equal(fourCC(wav16.bytes, 0), 'RIFF');
  assert.equal(fourCC(wav16.bytes, 8), 'WAVE');
  assert.equal(fourCC(wav16.bytes, 12), 'fmt ');
  assert.equal(fourCC(wav16.bytes, 36), 'data');

  const view16 = new DataView(wav16.bytes.buffer, wav16.bytes.byteOffset, wav16.bytes.byteLength);
  assert.equal(view16.getUint32(4, true), wav16.bytes.length - 8, 'RIFF chunk size matches file length');
  assert.equal(view16.getUint16(20, true), 1, '16-bit output uses integer PCM');
  assert.equal(view16.getUint16(22, true), 2, 'stereo channel count is preserved');
  assert.equal(view16.getUint32(24, true), 48000, 'sample rate is preserved');
  assert.equal(view16.getUint16(34, true), 16, 'bit depth is declared correctly');
  assert.equal(view16.getUint32(40, true), 5 * 2 * 2, 'data chunk length matches interleaved stereo PCM');
  assert.equal(view16.getInt16(44, true), -32768, 'left -1.0 sample');
  assert.equal(view16.getInt16(46, true), 32767, 'right +1.0 sample');
  assert.equal(view16.getInt16(48, true), -16384, 'left -0.5 sample');
  assert.equal(view16.getInt16(50, true), 16383, 'right +0.5 sample');
  assert.equal(view16.getInt16(52, true), 0, 'left zero sample');
  assert.equal(view16.getInt16(54, true), 0, 'right zero sample');

  // 24-bit PCM and 32-bit float WAV are separate, correctly declared encodings.
  const wav24 = encodeWav(input, 24);
  const view24 = new DataView(wav24.buffer, wav24.byteOffset, wav24.byteLength);
  assert.equal(view24.getUint16(20, true), 1, '24-bit output uses integer PCM');
  assert.equal(view24.getUint16(34, true), 24);
  assert.equal(view24.getUint32(40, true), 5 * 2 * 3);
  assert.equal(readInt24LE(view24, 44), -8388608, 'left -1.0 sample at 24-bit depth');
  assert.equal(readInt24LE(view24, 47), 8388607, 'right +1.0 sample at 24-bit depth');

  const wav32 = encodeWav(input, 32);
  const view32 = new DataView(wav32.buffer, wav32.byteOffset, wav32.byteLength);
  assert.equal(view32.getUint16(20, true), 3, '32-bit output uses IEEE float');
  assert.equal(view32.getUint16(34, true), 32);
  assert.equal(view32.getFloat32(44, true), -1);
  assert.equal(view32.getFloat32(48, true), 1);

  const sanitized = encodeWav(createMockAudioBuffer([new Float32Array([Number.NaN, Number.POSITIVE_INFINITY])]), 32);
  const sanitizedView = new DataView(sanitized.buffer, sanitized.byteOffset, sanitized.byteLength);
  assert.equal(sanitizedView.getFloat32(44, true), 0, 'non-finite PCM is encoded as silence');
  assert.equal(sanitizedView.getFloat32(48, true), 0, 'non-finite PCM is encoded as silence');
  assert.throws(() => encodeWav(input, 8 as 16), RangeError, 'unsupported bit depths are rejected');

  // Do not return WAV payloads with compressed-format extensions or headers.
  assert.equal(isAudioExportFormatSupported('WAV'), true);
  const unavailableFormats: AudioExportFormat[] = ['MP3', 'FLAC', 'AAC', 'OGG', 'WEBM'];
  for (const format of unavailableFormats) {
    assert.equal(isAudioExportFormatSupported(format), false, `${format} is marked unavailable`);
    await assert.rejects(
      exportAudioBuffer(input, { format }),
      (error: unknown) =>
        error instanceof AudioExportFormatUnavailableError &&
        error.format === format &&
        /verifizierter Encoder/.test(error.message),
      `${format} export fails clearly until a real encoder is integrated`
    );
  }

  console.log('audio export: WAV PCM/float structure is verified; unsupported codecs fail honestly');
}

void runExportTests();
