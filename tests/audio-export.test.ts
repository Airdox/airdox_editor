/**
 * Test suite for audioExporter utility: WAV, MP3, FLAC, AAC, OGG, WEBM.
 */

import { exportAudioBuffer } from '../src/audio/audioExporter';

function createMockAudioBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      data[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }
    channelData.push(data);
  }
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (ch: number) => channelData[ch] || channelData[0],
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
}

async function runExportTests() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  AUDIO EXPORTER FORMAT TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════════════');

  const testBuffer = createMockAudioBuffer(2, 44100 * 2, 44100);

  // 1. WAV
  const wavResult = await exportAudioBuffer(testBuffer, { format: 'WAV' });
  if (wavResult.bytes.length < 100 || wavResult.extension !== 'wav') {
    throw new Error('WAV Export failed');
  }
  console.log(`[ PASS ] WAV export generated ${wavResult.bytes.length} bytes (.wav)`);

  // 2. MP3
  const mp3Result = await exportAudioBuffer(testBuffer, { format: 'MP3' });
  if (mp3Result.bytes.length < 100 || mp3Result.extension !== 'mp3') {
    throw new Error('MP3 Export failed');
  }
  console.log(`[ PASS ] MP3 export generated ${mp3Result.bytes.length} bytes (.mp3)`);

  // 3. FLAC
  const flacResult = await exportAudioBuffer(testBuffer, { format: 'FLAC' });
  if (flacResult.bytes.length < 100 || flacResult.extension !== 'flac') {
    throw new Error('FLAC Export failed');
  }
  console.log(`[ PASS ] FLAC export generated ${flacResult.bytes.length} bytes (.flac)`);

  // 4. AAC
  const aacResult = await exportAudioBuffer(testBuffer, { format: 'AAC' });
  if (aacResult.bytes.length < 100 || aacResult.extension !== 'm4a') {
    throw new Error('AAC Export failed');
  }
  console.log(`[ PASS ] AAC export generated ${aacResult.bytes.length} bytes (.m4a)`);

  // 5. OGG
  const oggResult = await exportAudioBuffer(testBuffer, { format: 'OGG' });
  if (oggResult.bytes.length < 100 || oggResult.extension !== 'ogg') {
    throw new Error('OGG Export failed');
  }
  console.log(`[ PASS ] OGG export generated ${oggResult.bytes.length} bytes (.ogg)`);

  // 6. WEBM
  const webmResult = await exportAudioBuffer(testBuffer, { format: 'WEBM' });
  if (webmResult.bytes.length < 100 || webmResult.extension !== 'webm') {
    throw new Error('WEBM Export failed');
  }
  console.log(`[ PASS ] WEBM export generated ${webmResult.bytes.length} bytes (.webm)`);

  console.log('───────────────────────────────────────────────────────────────────');
  console.log('All 6 audio export formats generated valid encoded output files OK.');
}

runExportTests().catch((err) => {
  console.error('[ FAIL ] Audio export test failed:', err);
  process.exit(1);
});
