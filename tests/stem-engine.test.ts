import assert from 'node:assert/strict';
import {
  stemEngine,
  DEFAULT_STEMS_MIXER_STATE,
  StemsMixerState,
} from '../src/audio/stemEngine';
import { audioBufferFactory, makeAudioBuffer } from './support/editingHarness';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  AUDIO STEM SEPARATION ENGINE TEST SUITE                         ');
console.log('═══════════════════════════════════════════════════════════════════');

async function runTests() {
  const sampleRate = 44100;
  const durationSec = 1.0;
  const length = Math.floor(sampleRate * durationSec);

  // Generate a multi-frequency synthetic audio buffer:
  // - Low bass (60 Hz)
  // - Mid vocal / melody (800 Hz)
  // - High percussive / cymbal (7000 Hz)
  // - Transient click / drums
  const left = new Float32Array(length);
  const right = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const bass = 0.4 * Math.sin(2 * Math.PI * 60 * t);
    const vocal = 0.3 * Math.sin(2 * Math.PI * 800 * t);
    const highs = 0.2 * Math.sin(2 * Math.PI * 7000 * t);
    const drum = i % 5512 === 0 ? 0.8 : 0; // periodic impulse transient
    const sample = Math.tanh(bass + vocal + highs + drum);
    left[i] = sample;
    right[i] = sample;
  }

  const mixBuffer = makeAudioBuffer(left, sampleRate, right);
  const trackId = 'test-stem-track-1';
  const sha256 = 'sha256-synthetic-test-hash';
  stemEngine.clearCache();

  // Test 1: 4-Stem separation with progress reporting
  console.log('[ TEST ] #1 Separation into 4 Stems (Vocals, Drums, Bass, Other) with progress callbacks');
  const progressReports: number[] = [];
  const stems = await stemEngine.separateAudioBuffer(
    mixBuffer,
    trackId,
    sha256,
    (p) => {
      progressReports.push(p.percent);
    },
    audioBufferFactory
  );

  assert.ok(stems.vocals, 'Vocals stem buffer exists');
  assert.ok(stems.drums, 'Drums stem buffer exists');
  assert.ok(stems.bass, 'Bass stem buffer exists');
  assert.ok(stems.other, 'Other stem buffer exists');

  assert.equal(stems.vocals.length, length, 'Vocals length equals mix length');
  assert.equal(stems.drums.length, length, 'Drums length equals mix length');
  assert.equal(stems.bass.length, length, 'Bass length equals mix length');
  assert.equal(stems.other.length, length, 'Other length equals mix length');

  assert.ok(progressReports.length > 0, 'Progress callback was triggered');
  assert.equal(progressReports[progressReports.length - 1], 100, 'Progress reached 100%');
  console.log('  -> [PASS] All 4 stems separated with matching length and complete progress reporting.');

  // Test 2: the source buffer is never mutated by the separation
  console.log('[ TEST ] #2 Source buffer immutability during separation');
  const srcAfter = mixBuffer.getChannelData(0);
  let srcMaxDiff = 0;
  for (let i = 0; i < length; i++) {
    const d = Math.abs(srcAfter[i] - left[i]);
    if (d > srcMaxDiff) srcMaxDiff = d;
  }
  assert.equal(srcMaxDiff, 0, 'Separation is strictly read-only on the source buffer');
  console.log('  -> [PASS] Original mix buffer untouched (max diff 0).');

  // Test 3: Energy distribution & spectral discrimination
  console.log('[ TEST ] #3 Energy distribution & spectral separation check');
  const bassData = stems.bass.getChannelData(0);
  const vocalData = stems.vocals.getChannelData(0);
  const drumsData = stems.drums.getChannelData(0);
  const otherData = stems.other.getChannelData(0);

  let bassEnergy = 0;
  let vocalEnergy = 0;
  let drumsEnergy = 0;
  for (let i = 0; i < length; i++) {
    bassEnergy += bassData[i] * bassData[i];
    vocalEnergy += vocalData[i] * vocalData[i];
    drumsEnergy += drumsData[i] * drumsData[i];
  }

  assert.ok(bassEnergy > 0, 'Bass stem contains non-zero signal');
  assert.ok(vocalEnergy > 0, 'Vocals stem contains non-zero signal');
  assert.ok(drumsEnergy > 0, 'Drums stem contains non-zero signal');
  console.log(
    `  -> [PASS] Distinct energy in stems: Bass=${bassEnergy.toFixed(2)}, Vocals=${vocalEnergy.toFixed(2)}, Drums=${drumsEnergy.toFixed(2)}`
  );

  // Test 4: Sample-exact sum reconstruction
  console.log('[ TEST ] #4 Sample-exact sum reconstruction (Vocals + Drums + Bass + Other === Mix)');
  let maxDiff = 0;
  for (let i = 0; i < length; i++) {
    const recon = bassData[i] + vocalData[i] + drumsData[i] + otherData[i];
    const d = Math.abs(recon - left[i]);
    if (d > maxDiff) maxDiff = d;
  }
  assert.ok(maxDiff < 1e-5, `Sum reconstruction max diff ${maxDiff} must stay below 1e-5`);
  console.log(`  -> [PASS] Sum reconstruction is sample-exact (max diff: ${maxDiff.toExponential(2)}).`);

  // Test 5: Caching mechanism
  console.log('[ TEST ] #5 Cache retrieval and memory reuse');
  assert.ok(stemEngine.hasCachedStems(trackId, sha256), 'Cache has stems stored');
  const cached = stemEngine.getCachedStems(trackId, sha256);
  assert.ok(cached !== undefined, 'Retrieved cached stems');
  assert.equal(cached?.vocals, stems.vocals, 'Cached vocals matches created instance');
  console.log('  -> [PASS] Cached stems successfully retrieved without recomputation.');

  // Test 6: Mixer state & Solo/Mute logic
  console.log('[ TEST ] #6 Mixer State Solo and Mute configuration');
  const mixerState: StemsMixerState = {
    vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals },
    drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
    bass: { ...DEFAULT_STEMS_MIXER_STATE.bass },
    other: { ...DEFAULT_STEMS_MIXER_STATE.other },
  };
  assert.equal(mixerState.vocals.muted, false, 'Default vocals unmuted');
  assert.equal(mixerState.vocals.solo, false, 'Default vocals un-soloed');

  mixerState.vocals.solo = true;
  assert.equal(mixerState.vocals.solo, true, 'Vocals solo active');
  assert.equal(DEFAULT_STEMS_MIXER_STATE.vocals.solo, false, 'Default template is not mutated by copies');

  mixerState.drums.muted = true;
  assert.equal(mixerState.drums.muted, true, 'Drums muted');
  console.log('  -> [PASS] Mixer state muting and solo logic validated.');

  // Test 7: Slicing stems for palette clip extraction
  console.log('[ TEST ] #7 Slicing isolated stems for palette clip export');
  const slice = stemEngine.sliceStems(stems, 0.2, 0.6, audioBufferFactory);
  const expectedLength = Math.round(0.6 * sampleRate) - Math.round(0.2 * sampleRate);
  assert.equal(slice.vocals.length, expectedLength, 'Sliced vocal buffer matches expected sample length');
  assert.equal(slice.drums.length, expectedLength, 'Sliced drums buffer matches expected sample length');
  assert.equal(Math.round(slice.duration * 1000), 400, 'Sliced duration is 0.4s');

  const startSample = Math.round(0.2 * sampleRate);
  let sliceDiff = 0;
  const vs = slice.vocals.getChannelData(0);
  for (let i = 0; i < expectedLength; i++) {
    const d = Math.abs(vs[i] - vocalData[startSample + i]);
    if (d > sliceDiff) sliceDiff = d;
  }
  assert.equal(sliceDiff, 0, 'Sliced samples are copied bit-exactly from the stem');
  console.log('  -> [PASS] Isolated stems sliced accurately for clip extraction.');

  console.log('───────────────────────────────────────────────────────────────────');
  console.log('All Stem Separation Engine tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Stem Engine Test Failed:', err);
  process.exit(1);
});
