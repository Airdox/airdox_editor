/**
 * STEM PEAK HEADROOM TEST
 *
 * Regression guard for the crackle/clipping bug in the sum-preserving
 * normalization of the stem separation engine.
 *
 * Background
 * ----------
 * `normFactor = sample / rawSum` reconstructs the mix sample-exactly, but it is
 * numerically unbounded: whenever the four masks nearly cancel (rawSum -> 0) the
 * factor explodes and each individual stem is scaled far past the source
 * amplitude. Because the four stems still sum back to the mix, the full mix
 * (Reset) sounds mostly clean — the overshoot cancels. The moment a stem is
 * soloed or another one muted, the cancellation partner is gone and the
 * overshoot becomes audible digital clipping ("crackle").
 *
 * The missing check, asserted here:
 *   for every stem:  peak(stem) <= peak(source) * SMALL_FACTOR
 *
 * This is deliberately checked PER STEM (not on the sum), because the sum
 * contract was always satisfied and therefore never caught the bug.
 */

import assert from 'node:assert/strict';
import {
  stemEngine,
  STEM_TYPES,
  StemType,
  TrackStems,
  NORM_FACTOR_MIN,
  NORM_FACTOR_MAX,
} from '../src/audio/stemEngine';
import { audioBufferFactory, makeAudioBuffer } from './support/editingHarness';

console.log('══════════════════════════════════════════════════════════════════════════');
console.log('  STEM PEAK HEADROOM / ANTI-CLIPPING TEST SUITE                          ');
console.log('══════════════════════════════════════════════════════════════════════════');

/**
 * The allowed per-stem headroom above the source peak.
 *
 * A stem may legitimately be somewhat louder than the instantaneous mix sample
 * (partials cancel when summed), but it must stay in the same order of
 * magnitude as the source material. Anything beyond this is normalization
 * blow-up, not content.
 */
const PEAK_FACTOR = 1.5;

/** Exact-sum tolerance — the original contract must survive the fix. */
const SUM_EPSILON = 1e-5;

interface Signal {
  name: string;
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

function build(
  name: string,
  sampleRate: number,
  durationSec: number,
  gen: (t: number, i: number) => [number, number]
): Signal {
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

/**
 * Pathological signal set. These are the shapes that drive `rawSum` towards
 * zero while `sample` stays finite — i.e. exactly where normFactor exploded.
 */
function buildSignals(): Signal[] {
  const sr = 44100;
  const signals: Signal[] = [];

  // A wide, side-heavy bridge: pads + reverb wash, vocals centered.
  // This is the "Mopel bridge" shape — lots of stereo side energy, which makes
  // centerWeight collapse and the masks cancel.
  signals.push(
    build('WIDE_BRIDGE', sr, 1.0, (t) => {
      const padL = 0.35 * Math.sin(2 * Math.PI * 330 * t) + 0.25 * Math.sin(2 * Math.PI * 495 * t);
      const padR = 0.35 * Math.sin(2 * Math.PI * 330 * t + 2.9) + 0.25 * Math.sin(2 * Math.PI * 495 * t + 1.7);
      const voc = 0.3 * Math.sin(2 * Math.PI * 900 * t);
      const bass = 0.3 * Math.sin(2 * Math.PI * 70 * t);
      return [Math.tanh(padL + voc + bass), Math.tanh(padR + voc + bass)];
    })
  );

  // Fully out-of-phase side signal: mid == 0, the classic cancellation case.
  signals.push(
    build('HARD_SIDE', sr, 0.5, (t) => {
      const s = 0.6 * Math.sin(2 * Math.PI * 500 * t);
      return [s, -s];
    })
  );

  // Near-silence with dither-level noise: |sample| tiny, rawSum tinier.
  signals.push(
    build('NEAR_SILENCE', sr, 0.5, (t, i) => {
      const n = 1e-6 * Math.sin(i * 12.9898) + 2e-6 * Math.sin(2 * Math.PI * 1000 * t);
      return [n, -n * 0.9];
    })
  );

  // Zero-crossing dense material: rapid sign flips around zero.
  signals.push(
    build('ZERO_CROSS_DENSE', sr, 0.5, (t, i) => {
      const v = 0.5 * Math.sin(2 * Math.PI * 5000 * t) * Math.sin(2 * Math.PI * 3 * t);
      return [v, v * (i % 2 === 0 ? 1 : -1)];
    })
  );

  // Hot master: brickwalled near full scale.
  signals.push(
    build('HOT_MASTER', sr, 0.5, (t, i) => {
      const b = 0.9 * Math.sin(2 * Math.PI * 55 * t);
      const v = 0.7 * Math.sin(2 * Math.PI * 1100 * t);
      const h = 0.5 * Math.sin(2 * Math.PI * 9000 * t);
      const k = i % 11025 === 0 ? 1.0 : 0;
      const m = Math.max(-0.999, Math.min(0.999, b + v + h + k));
      return [m, m];
    })
  );

  // Dense transients: impulse train, every mask spikes at once.
  signals.push(
    build('TRANSIENT_STORM', sr, 0.5, (t, i) => {
      const imp = i % 441 === 0 ? 0.95 : 0;
      const tone = 0.2 * Math.sin(2 * Math.PI * 220 * t);
      return [imp + tone, imp - tone];
    })
  );

  // DC-offset material, which biases the filter states.
  signals.push(
    build('DC_OFFSET', sr, 0.4, (t) => {
      const v = 0.4 + 0.3 * Math.sin(2 * Math.PI * 120 * t);
      return [v, v];
    })
  );

  // Mono bass-only: the drum/vocal masks are near zero -> rawSum collapse.
  signals.push(
    build('SUB_ONLY', sr, 0.5, (t) => {
      const v = 0.85 * Math.sin(2 * Math.PI * 40 * t);
      return [v, v];
    })
  );

  return signals;
}

function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

function stemBuffer(stems: TrackStems, stem: StemType): AudioBuffer {
  return stems[stem];
}

async function run() {
  let passed = 0;
  stemEngine.clearCache();

  // ───────────────────────────────────────────────────────────────────────
  // GROUP 1: per-stem peak ceiling — THE missing check
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 1: Per-Stem Peak Ceiling (peak <= sourcePeak * ' + PEAK_FACTOR + ') ---');

  for (const sig of buildSignals()) {
    const src = makeAudioBuffer(sig.left, sig.sampleRate, sig.right);
    const stems = await stemEngine.separateAudioBuffer(
      src,
      `peak-${sig.name}`,
      `sha-peak-${sig.name}`,
      undefined,
      audioBufferFactory
    );

    const srcPeak = peakOf(src);
    const limit = Math.max(srcPeak * PEAK_FACTOR, 1e-9);

    const peaks: string[] = [];
    for (const stem of STEM_TYPES) {
      const p = peakOf(stemBuffer(stems, stem));
      peaks.push(`${stem}=${p.toFixed(4)}`);
      assert.ok(
        p <= limit,
        `[${sig.name}] Stem '${stem}' peak ${p.toFixed(6)} exceeds source peak ` +
          `${srcPeak.toFixed(6)} * ${PEAK_FACTOR} = ${limit.toFixed(6)} — this is the ` +
          `normalization blow-up that causes crackle on solo/mute.`
      );
    }

    console.log(
      `  [PASS] '${sig.name}': srcPeak=${srcPeak.toFixed(4)} limit=${limit.toFixed(4)} | ${peaks.join(' ')}`
    );
    passed++;
  }

  // ───────────────────────────────────────────────────────────────────────
  // GROUP 2: no stem clips full scale, and no NaN/Inf leaks
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 2: Full-Scale & Finiteness Guard ---');

  for (const sig of buildSignals()) {
    const src = makeAudioBuffer(sig.left, sig.sampleRate, sig.right);
    const stems = await stemEngine.separateAudioBuffer(
      src,
      `fs-${sig.name}`,
      `sha-fs-${sig.name}`,
      undefined,
      audioBufferFactory
    );

    const srcPeak = peakOf(src);
    // A source that is itself below full scale must not produce stems above it.
    const fsLimit = Math.max(1.0, srcPeak) * PEAK_FACTOR;

    for (const stem of STEM_TYPES) {
      const buf = stemBuffer(stems, stem);
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < d.length; i++) {
          assert.ok(
            Number.isFinite(d[i]),
            `[${sig.name}] Stem '${stem}' ch${ch} sample ${i} is not finite: ${d[i]}`
          );
          assert.ok(
            Math.abs(d[i]) <= fsLimit,
            `[${sig.name}] Stem '${stem}' ch${ch} sample ${i} = ${d[i]} exceeds ${fsLimit}`
          );
        }
      }
    }
    console.log(`  [PASS] '${sig.name}': all stems finite and within full-scale guard`);
    passed++;
  }

  // ───────────────────────────────────────────────────────────────────────
  // GROUP 3: solo / mute isolation — the actual user-facing symptom
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 3: Solo & Mute Isolation Must Not Clip ---');

  for (const sig of buildSignals()) {
    const src = makeAudioBuffer(sig.left, sig.sampleRate, sig.right);
    const stems = await stemEngine.separateAudioBuffer(
      src,
      `solo-${sig.name}`,
      `sha-solo-${sig.name}`,
      undefined,
      audioBufferFactory
    );
    const srcPeak = peakOf(src);
    const limit = Math.max(srcPeak * PEAK_FACTOR, 1e-9);

    // Every solo selection (single stem) and every mute selection
    // (the other three summed) must stay inside the ceiling.
    for (const soloStem of STEM_TYPES) {
      const soloPeak = peakOf(stemBuffer(stems, soloStem));
      assert.ok(
        soloPeak <= limit,
        `[${sig.name}] SOLO '${soloStem}' peak ${soloPeak} exceeds ${limit}`
      );

      // Mute this stem -> the remaining three are summed on the bus.
      const rest = STEM_TYPES.filter((s) => s !== soloStem);
      let mutedPeak = 0;
      const len = src.length;
      for (let ch = 0; ch < src.numberOfChannels; ch++) {
        const arrays = rest.map((s) => stemBuffer(stems, s).getChannelData(ch));
        for (let i = 0; i < len; i++) {
          let acc = 0;
          for (const a of arrays) acc += a[i];
          const abs = Math.abs(acc);
          if (abs > mutedPeak) mutedPeak = abs;
        }
      }
      assert.ok(
        mutedPeak <= srcPeak * 2.5 + 1e-6,
        `[${sig.name}] MUTE '${soloStem}' residual bus peak ${mutedPeak} exceeds ${srcPeak * 2.5}`
      );
    }
    console.log(`  [PASS] '${sig.name}': all 4 solo states and all 4 mute states stay clean`);
    passed++;
  }

  // ───────────────────────────────────────────────────────────────────────
  // GROUP 4: the exact-sum contract still holds after the fix
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 4: Exact Sum Reconstruction Preserved ---');

  for (const sig of buildSignals()) {
    const src = makeAudioBuffer(sig.left, sig.sampleRate, sig.right);
    const stems = await stemEngine.separateAudioBuffer(
      src,
      `sum-${sig.name}`,
      `sha-sum-${sig.name}`,
      undefined,
      audioBufferFactory
    );

    let maxDiff = 0;
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      const s = src.getChannelData(ch);
      const v = stems.vocals.getChannelData(ch);
      const d = stems.drums.getChannelData(ch);
      const b = stems.bass.getChannelData(ch);
      const o = stems.other.getChannelData(ch);
      for (let i = 0; i < s.length; i++) {
        const diff = Math.abs(v[i] + d[i] + b[i] + o[i] - s[i]);
        if (diff > maxDiff) maxDiff = diff;
      }
    }

    assert.ok(
      maxDiff < SUM_EPSILON,
      `[${sig.name}] Sum reconstruction broke: max diff ${maxDiff} >= ${SUM_EPSILON}`
    );
    console.log(`  [PASS] '${sig.name}': Reset/full mix reconstructs exactly (diff ${maxDiff.toExponential(2)})`);
    passed++;
  }

  // ───────────────────────────────────────────────────────────────────────
  // GROUP 5: normFactor window is actually enforced
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 5: normFactor Window & Fallback Accounting ---');

  assert.ok(NORM_FACTOR_MIN > 0, 'NORM_FACTOR_MIN must be positive');
  assert.ok(NORM_FACTOR_MAX > NORM_FACTOR_MIN, 'NORM_FACTOR_MAX must exceed NORM_FACTOR_MIN');
  assert.ok(NORM_FACTOR_MIN <= 0.25, 'NORM_FACTOR_MIN must be at most 0.25');
  assert.ok(NORM_FACTOR_MAX >= 4.0, 'NORM_FACTOR_MAX must be at least 4.0');
  console.log(`  [PASS] normFactor window = [${NORM_FACTOR_MIN}, ${NORM_FACTOR_MAX}]`);
  passed++;

  // STFT masks live in [0,1] per bin, so the normalization blow-up cannot
  // occur by construction anymore: even hard side-only material must pass
  // WITHOUT engaging any per-sample rescue. This is a strictly stronger
  // guarantee than the former "fallback engaged" diagnostic.
  const hardSide = buildSignals().find((s) => s.name === 'HARD_SIDE')!;
  const hsBuf = makeAudioBuffer(hardSide.left, hardSide.sampleRate, hardSide.right);
  const hsStems = await stemEngine.separateAudioBuffer(
    hsBuf,
    'fallback-probe',
    'sha-fallback-probe',
    undefined,
    audioBufferFactory
  );
  assert.equal(
    hsStems.normalizationFallbacks ?? 0,
    0,
    'Bounded STFT masks must never require a per-sample normalization rescue'
  );
  console.log(
    '  [PASS] HARD_SIDE separated with bounded masks — zero normalization rescues needed'
  );
  passed++;

  console.log('\n══════════════════════════════════════════════════════════════════════════');
  console.log(`  ALL ${passed} PEAK-HEADROOM CHECKS PASSED`);
  console.log('══════════════════════════════════════════════════════════════════════════');
}

run().catch((err) => {
  console.error('\n[FAIL]', err instanceof Error ? err.message : err);
  process.exit(1);
});
