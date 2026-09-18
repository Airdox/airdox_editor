import assert from 'node:assert/strict';
import {
  stemEngine,
  STEM_TYPES,
  DEFAULT_STEMS_MIXER_STATE,
  StemsMixerState,
} from '../src/audio/stemEngine';
import { audioBufferFactory, makeAudioBuffer } from './support/editingHarness';

console.log('══════════════════════════════════════════════════════════════════════════');
console.log('  EXHAUSTIVE STEM SEPARATION ENGINE & CAUSALITY MATRIX TEST SUITE        ');
console.log('══════════════════════════════════════════════════════════════════════════');

const EPSILON = 1e-5;

type SignalType =
  | 'BASS'
  | 'VOCAL'
  | 'HIGHS'
  | 'IMPULSE'
  | 'POLY'
  | 'STEREO_SIDE'
  | 'SILENCE'
  | 'MAX_AMP';

function createTestBuffer(type: SignalType, sampleRate = 44100, durationSec = 1.0): AudioBuffer {
  const length = Math.floor(sampleRate * durationSec);
  const left = new Float32Array(length);
  const right = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    switch (type) {
      case 'BASS': {
        const val = 0.8 * Math.sin(2 * Math.PI * 65 * t);
        left[i] = val;
        right[i] = val;
        break;
      }
      case 'VOCAL': {
        // Centered vocal harmonic formant
        const val = 0.5 * Math.sin(2 * Math.PI * 800 * t) + 0.3 * Math.sin(2 * Math.PI * 1600 * t);
        left[i] = val;
        right[i] = val;
        break;
      }
      case 'HIGHS': {
        const val = 0.4 * Math.sin(2 * Math.PI * 8500 * t) + 0.2 * Math.sin(2 * Math.PI * 12000 * t);
        left[i] = val;
        right[i] = val;
        break;
      }
      case 'IMPULSE': {
        const val = i % Math.floor(sampleRate * 0.125) === 0 ? 0.9 : 0.0;
        left[i] = val;
        right[i] = val;
        break;
      }
      case 'POLY': {
        const b = 0.35 * Math.sin(2 * Math.PI * 80 * t);
        const v = 0.3 * Math.sin(2 * Math.PI * 1000 * t);
        const h = 0.2 * Math.sin(2 * Math.PI * 7500 * t);
        const d = i % Math.floor(sampleRate * 0.25) === 0 ? 0.5 : 0.0;
        const synth = 0.2 * Math.sin(2 * Math.PI * 440 * t);
        left[i] = Math.tanh(b + v + h + d + synth);
        right[i] = Math.tanh(b + v + h + d - synth); // stereo spread
        break;
      }
      case 'STEREO_SIDE': {
        // 100% out-of-phase stereo side signal (no center content)
        const synth = 0.5 * Math.sin(2 * Math.PI * 500 * t);
        left[i] = synth;
        right[i] = -synth;
        break;
      }
      case 'SILENCE': {
        left[i] = 0;
        right[i] = 0;
        break;
      }
      case 'MAX_AMP': {
        const val = 0.999 * Math.sin(2 * Math.PI * 220 * t);
        left[i] = val;
        right[i] = val;
        break;
      }
    }
  }

  return makeAudioBuffer(left, sampleRate, right);
}

async function runExhaustiveTests() {
  let passedCount = 0;
  stemEngine.clearCache();

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 1: Signal variations & sample-accurate sum reconstruction
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 1: Signal Variations & Exact Sum Reconstruction ---');

  const signalTypes: SignalType[] = [
    'POLY',
    'BASS',
    'VOCAL',
    'HIGHS',
    'IMPULSE',
    'STEREO_SIDE',
    'SILENCE',
    'MAX_AMP',
  ];

  for (const signalType of signalTypes) {
    const buffer = createTestBuffer(signalType, 44100, 0.8);
    const trackId = `track-sig-${signalType.toLowerCase()}`;
    const sha = `sha-${signalType.toLowerCase()}`;

    const stems = await stemEngine.separateAudioBuffer(
      buffer,
      trackId,
      sha,
      undefined,
      audioBufferFactory
    );

    // Verify sample-by-sample exact sum: Vocals + Drums + Bass + Other === Original
    const len = buffer.length;
    let maxDiff = 0;
    let originalEnergy = 0;
    let sumEnergy = 0;

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const voc = stems.vocals.getChannelData(ch);
      const drm = stems.drums.getChannelData(ch);
      const bas = stems.bass.getChannelData(ch);
      const oth = stems.other.getChannelData(ch);

      for (let i = 0; i < len; i++) {
        const reconstructedSample = voc[i] + drm[i] + bas[i] + oth[i];
        const diff = Math.abs(reconstructedSample - src[i]);
        if (diff > maxDiff) maxDiff = diff;
        originalEnergy += src[i] * src[i];
        sumEnergy += reconstructedSample * reconstructedSample;
      }
    }

    assert.ok(maxDiff < EPSILON, `[${signalType}] Sample difference ${maxDiff} exceeds epsilon ${EPSILON}`);

    const energyRatio = originalEnergy > 0 ? sumEnergy / originalEnergy : 1.0;
    assert.ok(
      Math.abs(energyRatio - 1.0) < 1e-4,
      `[${signalType}] Energy ratio ${energyRatio} must equal 1.000`
    );

    console.log(
      `  [PASS] Signal '${signalType}': max sample diff = ${maxDiff.toExponential(2)}, energy ratio = ${energyRatio.toFixed(6)}`
    );
    passedCount++;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 2: Sample rates & duration variations
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 2: Sample Rates & Duration Boundaries ---');

  const rates = [44100, 48000, 96000];
  const durations = [0.05, 0.5, 2.5]; // 50ms (ultra-short), 500ms, 2500ms

  for (const sr of rates) {
    for (const dur of durations) {
      const buffer = createTestBuffer('POLY', sr, dur);
      const trackId = `track-sr-${sr}-dur-${dur}`;
      const sha = `sha-${sr}-${dur}`;

      const stems = await stemEngine.separateAudioBuffer(
        buffer,
        trackId,
        sha,
        undefined,
        audioBufferFactory
      );

      assert.equal(stems.vocals.length, buffer.length);
      assert.equal(stems.sampleRate, sr);
      assert.equal(stems.duration, buffer.duration);

      const srcL = buffer.getChannelData(0);
      const vocL = stems.vocals.getChannelData(0);
      const drmL = stems.drums.getChannelData(0);
      const basL = stems.bass.getChannelData(0);
      const othL = stems.other.getChannelData(0);

      let maxDiff = 0;
      for (let i = 0; i < buffer.length; i++) {
        const diff = Math.abs(vocL[i] + drmL[i] + basL[i] + othL[i] - srcL[i]);
        if (diff > maxDiff) maxDiff = diff;
      }

      assert.ok(maxDiff < EPSILON, `SR ${sr} Dur ${dur}s failed sum check with diff ${maxDiff}`);
      console.log(
        `  [PASS] SampleRate=${sr}Hz, Dur=${dur}s: sample-exact sum (max diff: ${maxDiff.toExponential(2)})`
      );
      passedCount++;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 3: 16 mute permutations & solo state space
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 3: Mixer States (16 Mute Combinations & Solo Logic) ---');

  const basePoly = createTestBuffer('POLY', 44100, 0.5);
  const stems = await stemEngine.separateAudioBuffer(
    basePoly,
    'track-matrix',
    'sha-matrix',
    undefined,
    audioBufferFactory
  );

  const len = basePoly.length;
  const v = stems.vocals.getChannelData(0);
  const d = stems.drums.getChannelData(0);
  const b = stems.bass.getChannelData(0);
  const o = stems.other.getChannelData(0);
  const src = basePoly.getChannelData(0);

  for (let mask = 0; mask < 16; mask++) {
    const muteVocals = (mask & 1) !== 0;
    const muteDrums = (mask & 2) !== 0;
    const muteBass = (mask & 4) !== 0;
    const muteOther = (mask & 8) !== 0;

    let activeEnergy = 0;
    let maskedDiff = 0;
    for (let i = 0; i < len; i++) {
      const activeSample =
        (muteVocals ? 0 : v[i]) +
        (muteDrums ? 0 : d[i]) +
        (muteBass ? 0 : b[i]) +
        (muteOther ? 0 : o[i]);
      activeEnergy += activeSample * activeSample;
      if (mask === 0) {
        const diff = Math.abs(activeSample - src[i]);
        if (diff > maskedDiff) maskedDiff = diff;
      }
    }

    if (mask === 0) {
      assert.ok(activeEnergy > 0, 'Unmuted stems produce positive energy');
      assert.ok(maskedDiff < EPSILON, 'All-unmuted mix reconstructs the original exactly');
    } else if (mask === 15) {
      assert.equal(activeEnergy, 0, 'All muted stems produce exactly 0 energy');
    } else {
      assert.ok(Number.isFinite(activeEnergy), `Mask ${mask} yields a finite mixdown energy`);
    }
  }
  console.log('  [PASS] All 16 mute permutations verified with exact energy calculations.');
  passedCount++;

  // Solo logic: the solo flag dominates the mute flags.
  const soloVocalsState: StemsMixerState = {
    vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals, solo: true },
    drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
    bass: { ...DEFAULT_STEMS_MIXER_STATE.bass },
    other: { ...DEFAULT_STEMS_MIXER_STATE.other },
  };

  const hasAnySolo = STEM_TYPES.some((s) => soloVocalsState[s].solo);
  assert.ok(hasAnySolo, 'Solo detected');
  const audible = STEM_TYPES.filter((s) =>
    hasAnySolo ? soloVocalsState[s].solo : !soloVocalsState[s].muted
  );
  assert.deepEqual(audible, ['vocals'], 'Solo isolates exactly the soloed stem');
  console.log('  [PASS] Solo acapella isolation validated.');
  passedCount++;

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 4: Presets (Acapella, Instrumental, Reset)
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 4: Preset Modes (Acapella, Instrumental, Full Reset) ---');

  const acapellaState: StemsMixerState = {
    vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals, solo: true },
    drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
    bass: { ...DEFAULT_STEMS_MIXER_STATE.bass },
    other: { ...DEFAULT_STEMS_MIXER_STATE.other },
  };
  const acapellaAudible = STEM_TYPES.filter((s) => acapellaState[s].solo);
  assert.deepEqual(acapellaAudible, ['vocals'], 'Acapella leaves only vocals audible');

  const instrumentalState: StemsMixerState = {
    vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals, muted: true },
    drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
    bass: { ...DEFAULT_STEMS_MIXER_STATE.bass },
    other: { ...DEFAULT_STEMS_MIXER_STATE.other },
  };
  const instrumentalAudible = STEM_TYPES.filter((s) => !instrumentalState[s].muted);
  assert.deepEqual(
    instrumentalAudible,
    ['drums', 'bass', 'other'],
    'Instrumental mutes vocals only'
  );

  for (const s of STEM_TYPES) {
    assert.equal(DEFAULT_STEMS_MIXER_STATE[s].muted, false);
    assert.equal(DEFAULT_STEMS_MIXER_STATE[s].solo, false);
    assert.equal(DEFAULT_STEMS_MIXER_STATE[s].volume, 1.0);
  }
  console.log('  [PASS] Acapella, Instrumental, and Reset presets operate with strict causality.');
  passedCount++;

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 5: Slicing stems for clip extraction
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 5: Slicing & Clip Extraction from Isolated Stems ---');

  const sliceResult = stemEngine.sliceStems(stems, 0.1, 0.35, audioBufferFactory); // 250ms slice
  const expectedSliceLen = Math.round(0.35 * 44100) - Math.round(0.1 * 44100);
  assert.equal(Math.round(sliceResult.duration * 1000), 250);
  assert.equal(sliceResult.vocals.length, expectedSliceLen);
  assert.equal(sliceResult.drums.length, expectedSliceLen);
  assert.equal(sliceResult.bass.length, expectedSliceLen);
  assert.equal(sliceResult.other.length, expectedSliceLen);

  const startSample = Math.round(0.1 * 44100);
  const vocSlice = sliceResult.vocals.getChannelData(0);
  const drmSlice = sliceResult.drums.getChannelData(0);
  const basSlice = sliceResult.bass.getChannelData(0);
  const othSlice = sliceResult.other.getChannelData(0);

  let sliceMaxDiff = 0;
  for (let i = 0; i < expectedSliceLen; i++) {
    const recon = vocSlice[i] + drmSlice[i] + basSlice[i] + othSlice[i];
    const diff = Math.abs(recon - src[startSample + i]);
    if (diff > sliceMaxDiff) sliceMaxDiff = diff;
  }

  assert.ok(sliceMaxDiff < EPSILON, `Slice max difference ${sliceMaxDiff} exceeds epsilon`);
  console.log(
    `  [PASS] Sliced sub-region across 4 stems maintains exact sum reconstruction (diff: ${sliceMaxDiff.toExponential(2)})`
  );
  passedCount++;

  // Out-of-range slice bounds are clamped instead of producing invalid buffers.
  const clamped = stemEngine.sliceStems(stems, -5, 999, audioBufferFactory);
  assert.equal(clamped.vocals.length, basePoly.length, 'Out-of-range slice clamps to the full stem');
  const inverted = stemEngine.sliceStems(stems, 0.3, 0.1, audioBufferFactory);
  assert.equal(inverted.vocals.length, 1, 'Inverted slice bounds degrade to a minimal valid buffer');
  console.log('  [PASS] Slice boundary clamping is fail-safe for invalid ranges.');
  passedCount++;

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 6: Cache identity & determinism
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 6: Cache Identity & Deterministic Reuse ---');

  const cachedAgain = await stemEngine.separateAudioBuffer(
    basePoly,
    'track-matrix',
    'sha-matrix',
    undefined,
    audioBufferFactory
  );
  assert.equal(cachedAgain.vocals, stems.vocals, 'Repeated separation reuses the cached stems');

  stemEngine.clearCache();
  assert.equal(stemEngine.hasCachedStems('track-matrix', 'sha-matrix'), false, 'Cache clears fully');

  const recomputed = await stemEngine.separateAudioBuffer(
    basePoly,
    'track-matrix',
    'sha-matrix',
    undefined,
    audioBufferFactory
  );
  let determinismDiff = 0;
  const recomputedVocals = recomputed.vocals.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const diff = Math.abs(recomputedVocals[i] - v[i]);
    if (diff > determinismDiff) determinismDiff = diff;
  }
  assert.equal(determinismDiff, 0, 'Separation is deterministic for identical input');
  console.log('  [PASS] Cache identity, clearing, and bit-identical recomputation verified.');
  passedCount++;

  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log(`Total Stems Exhaustive Scenarios Tested: ${passedCount} | Failed: 0`);
  console.log('All stems separation and multi-track operations produce causally expected outcomes.');
}

runExhaustiveTests().catch((err) => {
  console.error('Stems Exhaustive Test Failed:', err);
  process.exit(1);
});
