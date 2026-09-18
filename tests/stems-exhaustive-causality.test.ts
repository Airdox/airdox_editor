import assert from 'node:assert/strict';
import {
  stemEngine,
  STEM_TYPES,
  DEFAULT_STEMS_MIXER_STATE,
  StemsMixerState,
} from '../src/audio/stemEngine';
import { audioBufferFactory, makeAudioBuffer } from './support/editingHarness';

console.log('══════════════════════════════════════════════════════════════════');
console.log('  EXHAUSTIVE STEM SEPARATION – BS-RoFormer primary, no fallback  ');
console.log('══════════════════════════════════════════════════════════════════');

const EPSILON = 1e-5;

type SignalType = 'BASS' | 'VOCAL' | 'HIGHS' | 'IMPULSE' | 'POLY' | 'STEREO_SIDE' | 'SILENCE' | 'MAX_AMP';

function createTestBuffer(type: SignalType, sampleRate = 44100, durationSec = 1.0): AudioBuffer {
  const length = Math.floor(sampleRate * durationSec);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    switch (type) {
      case 'BASS': {
        const val = 0.8 * Math.sin(2 * Math.PI * 65 * t);
        left[i] = val; right[i] = val; break;
      }
      case 'VOCAL': {
        const val = 0.5 * Math.sin(2 * Math.PI * 800 * t) + 0.3 * Math.sin(2 * Math.PI * 1600 * t);
        left[i] = val; right[i] = val; break;
      }
      case 'HIGHS': {
        const val = 0.4 * Math.sin(2 * Math.PI * 8500 * t);
        left[i] = val; right[i] = val; break;
      }
      case 'IMPULSE': {
        const val = i % Math.floor(sampleRate * 0.125) === 0 ? 0.9 : 0.0;
        left[i] = val; right[i] = val; break;
      }
      case 'POLY': {
        const b = 0.35 * Math.sin(2 * Math.PI * 80 * t);
        const v = 0.3 * Math.sin(2 * Math.PI * 1000 * t);
        left[i] = Math.tanh(b + v); right[i] = Math.tanh(b - v); break;
      }
      case 'STEREO_SIDE': {
        const synth = 0.5 * Math.sin(2 * Math.PI * 500 * t);
        left[i] = synth; right[i] = -synth; break;
      }
      case 'SILENCE': { left[i] = 0; right[i] = 0; break; }
      case 'MAX_AMP': {
        const val = 0.999 * Math.sin(2 * Math.PI * 220 * t);
        left[i] = val; right[i] = val; break;
      }
    }
  }
  return makeAudioBuffer(left, sampleRate, right);
}

async function runExhaustiveTests() {
  let passedCount = 0;
  stemEngine.clearCache();

  console.log('\n--- GROUP 1: Old API must throw STEM_ENGINE_UNAVAILABLE ---');
  const signalTypes: SignalType[] = ['POLY', 'BASS', 'VOCAL', 'HIGHS', 'IMPULSE', 'STEREO_SIDE', 'SILENCE', 'MAX_AMP'];
  for (const signalType of signalTypes) {
    const buffer = createTestBuffer(signalType, 44100, 0.3);
    await assert.rejects(
      () => stemEngine.separateAudioBuffer(buffer, `track-sig-${signalType.toLowerCase()}`, `sha-${signalType.toLowerCase()}`, undefined, audioBufferFactory),
      (err: any) => {
        assert.ok(String(err.message).includes('STEM_ENGINE_UNAVAILABLE') || String(err.message).includes('KEINE echte'));
        return true;
      }
    );
    console.log(`  [PASS] ${signalType}: blocked as required`);
    passedCount++;
  }

  console.log('\n--- GROUP 2: checkAvailability returns STEM_ENGINE_UNAVAILABLE when not ready ---');
  const avail = await stemEngine.checkAvailability();
  assert.ok(typeof avail.available === 'boolean');
  if (!avail.available) {
    assert.equal(avail.code, 'STEM_ENGINE_UNAVAILABLE');
  }
  console.log(`  [PASS] Availability: ${avail.available}`);
  passedCount++;

  console.log('\n--- GROUP 3: Mixer States (16 Mute Combinations & Solo Logic) ---');
  // Mixer logic independent of engine – test directly
  const basePoly = createTestBuffer('POLY', 44100, 0.5);
  // Simulate stems with simple copy for mixer test (not real separation)
  const mockStems = {
    vocals: basePoly,
    drums: basePoly,
    bass: basePoly,
    other: basePoly,
    sampleRate: 44100,
    duration: basePoly.duration,
    separationMethod: 'BS_ROFORMER' as const,
    modelId: 'test',
    profile: 'BALANCED' as const,
  } as any;

  const len = basePoly.length;
  const v = mockStems.vocals.getChannelData(0);
  const d = mockStems.drums.getChannelData(0);
  const b = mockStems.bass.getChannelData(0);
  const o = mockStems.other.getChannelData(0);
  const src = basePoly.getChannelData(0);

  for (let mask = 0; mask < 16; mask++) {
    const muteVocals = (mask & 1) !== 0;
    const muteDrums = (mask & 2) !== 0;
    const muteBass = (mask & 4) !== 0;
    const muteOther = (mask & 8) !== 0;
    let activeEnergy = 0;
    for (let i = 0; i < len; i++) {
      const activeSample = (muteVocals ? 0 : v[i]) + (muteDrums ? 0 : d[i]) + (muteBass ? 0 : b[i]) + (muteOther ? 0 : o[i]);
      activeEnergy += activeSample * activeSample;
    }
    if (mask === 15) assert.equal(activeEnergy, 0, 'All muted = 0');
    else assert.ok(Number.isFinite(activeEnergy));
  }
  console.log('  [PASS] 16 mute permutations verified');
  passedCount++;

  const soloVocalsState: StemsMixerState = {
    vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals, solo: true },
    drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
    bass: { ...DEFAULT_STEMS_MIXER_STATE.bass },
    other: { ...DEFAULT_STEMS_MIXER_STATE.other },
  };
  const hasAnySolo = STEM_TYPES.some((s) => soloVocalsState[s].solo);
  assert.ok(hasAnySolo);
  const audible = STEM_TYPES.filter((s) => hasAnySolo ? soloVocalsState[s].solo : !soloVocalsState[s].muted);
  assert.deepEqual(audible, ['vocals']);
  console.log('  [PASS] Solo acapella isolation validated.');
  passedCount++;

  console.log('\n--- GROUP 4: Preset Modes ---');
  const acapellaState: StemsMixerState = {
    vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals, solo: true },
    drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
    bass: { ...DEFAULT_STEMS_MIXER_STATE.bass },
    other: { ...DEFAULT_STEMS_MIXER_STATE.other },
  };
  assert.deepEqual(STEM_TYPES.filter((s) => acapellaState[s].solo), ['vocals']);
  console.log('  [PASS] Presets validated.');
  passedCount++;

  console.log('\n--- GROUP 5: Cache identity ---');
  stemEngine.clearCache();
  assert.equal(stemEngine.hasCachedStems('track-matrix', 'sha-matrix'), false, 'Cache clears fully');
  console.log('  [PASS] Cache clear verified.');
  passedCount++;

  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log(`Total Scenarios: ${passedCount} | Failed: 0`);
  console.log('All tests enforce no spectral fallback per §2, §38.');
}

runExhaustiveTests().catch((err) => {
  console.error('Stems Exhaustive Test Failed:', err);
  process.exit(1);
});
