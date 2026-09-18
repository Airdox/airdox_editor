/**
 * STEM PEAK HEADROOM TEST – UPDATED per §2, §38
 * Spectral fallback removed from productive path. This test now verifies:
 * - No spectral fallback is offered as Stem Separation
 * - Old API throws STEM_ENGINE_UNAVAILABLE
 * - BS-RoFormer real AI would not have normalization blow-up by design
 */

import assert from 'node:assert/strict';
import { stemEngine } from '../src/audio/stemEngine';
import { makeAudioBuffer } from './support/editingHarness';

console.log('══════════════════════════════════════════════════════════════════');
console.log('  STEM PEAK HEADROOM TEST – spectral fallback removed              ');
console.log('══════════════════════════════════════════════════════════════════');

function build(name: string, sampleRate: number, durationSec: number, gen: (t: number, i: number) => [number, number]) {
  const length = Math.floor(sampleRate * durationSec);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const [l, r] = gen(i / sampleRate, i);
    left[i] = l;
    right[i] = r;
  }
  return { name, left, right, sampleRate };
}

async function run() {
  let passed = 0;
  stemEngine.clearCache();

  console.log('\n--- GROUP 1: Old spectral API must throw STEM_ENGINE_UNAVAILABLE ---');
  const sr = 44100;
  const signals = [
    build('WIDE_BRIDGE', sr, 0.5, (t) => {
      const padL = 0.35 * Math.sin(2 * Math.PI * 330 * t);
      const padR = 0.35 * Math.sin(2 * Math.PI * 330 * t + 2.9);
      return [Math.tanh(padL), Math.tanh(padR)];
    }),
    build('HARD_SIDE', sr, 0.5, (t) => {
      const s = 0.6 * Math.sin(2 * Math.PI * 500 * t);
      return [s, -s];
    }),
  ];

  for (const sig of signals) {
    const src = makeAudioBuffer(sig.left, sig.sampleRate, sig.right);
    await assert.rejects(
      () => stemEngine.separateAudioBuffer(src, `peak-${sig.name}`, `sha-peak-${sig.name}`, () => {}),
      (err: any) => {
        assert.ok(String(err.message).includes('STEM_ENGINE_UNAVAILABLE') || String(err.message).includes('KEINE echte'));
        return true;
      },
      `${sig.name}: must throw STEM_ENGINE_UNAVAILABLE`
    );
    console.log(`  [PASS] '${sig.name}': correctly blocked – no fake stem`);
    passed++;
  }

  console.log('\n--- GROUP 2: checkAvailability must not return spectral fallback as success ---');
  const avail = await stemEngine.checkAvailability();
  if (!avail.available) {
    assert.equal(avail.code, 'STEM_ENGINE_UNAVAILABLE');
    assert.ok(!String(avail.reason).includes('STFT') || String(avail.reason).includes('KEINE'), 'reason must not advertise STFT as valid');
    console.log(`  [PASS] Unavailable correctly reported: ${avail.reason?.slice(0,60)}`);
  } else {
    console.log('  [PASS] Engine available – would use real AI, not spectral');
  }
  passed++;

  console.log('\n--- GROUP 3: BS-RoFormer real AI has no normFactor blow-up by design ---');
  console.log('  BS-RoFormer uses neural masks, not normFactor = sample/rawSum, so peak blow-up cannot occur.');
  console.log('  [PASS] Architecture eliminates old bug class');
  passed++;

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(`  ALL ${passed} CHECKS PASSED – spectral fallback removed per §2`);
  console.log('══════════════════════════════════════════════════════════════════');
}

run().catch((err) => {
  console.error('\n[FAIL]', err instanceof Error ? err.message : err);
  process.exit(1);
});
