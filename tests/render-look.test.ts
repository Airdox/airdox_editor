/**
 * @license
 * Visual-lock tests: the renderers must apply ONLY the documented ANLZ
 * visualizations (Deep Symmetry / crate-digger) to the stored values —
 * nothing recombined, nothing invented.
 *
 *  R1 – PWV5: stored 3-bit red/green/blue ARE the column color, stored
 *       5-bit value the height (rgbColumnColor pass-through).
 *  R2 – Blue waveform: stored whiteness maps darkest blue → near white.
 *  R3 – PWV4: two-tone columns, back = rgb·luminance, front = boosted.
 *  R4 – 3-band: lows dark blue, mids amber (translucent), highs white,
 *       drawn low → mid → high on the same axis.
 *  R5 – Comb geometry + alternate bar shading (reference 01/02).
 *  R6 – End-to-end PWV5 pass-through via parseAnlzBinary.
 *  R7 – Honest no-ANLZ preview: heights from bar/beat structure only.
 *  R8 – Overview downsampling: peak-hold, never averaging.
 *
 * Run with: npx tsx tests/render-look.test.ts
 */

import {
  MONO_BLUE_DARK,
  MONO_BLUE_WHITE,
  monoBlueColor,
  BAR_SHADE_FILL,
  columnDrawWidth,
  isBarShaded,
  peakHoldColumn,
  PREVIEW_ALPHA,
  PREVIEW_BAR_FRACTION,
  PREVIEW_BEAT_FRACTION,
  previewBeatHalfHeight,
  pwv4BackColor,
  pwv4FrontColor,
  PWV4_FRONT_BOOST,
  rgbColumnColor,
  THREE_BAND_HIGH,
  THREE_BAND_LOW,
  THREE_BAND_MID,
  THREE_BAND_MID_ALPHA,
  threeBandLayers,
} from '../src/waveform/renderModel';
import { parseAnlzBinary } from '../src/rekordbox/databaseExtractor';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

function runTest(suite: string, name: string, testFn: () => void) {
  const t0 = performance.now();
  try {
    testFn();
    results.push({ suite, name, passed: true, durationMs: Math.round((performance.now() - t0) * 100) / 100 });
  } catch (err: any) {
    results.push({
      suite,
      name,
      passed: false,
      error: err?.message || String(err),
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
    });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`Assertion Failed [${message}]: expected ${expected}, got ${actual}`);
  }
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  RENDER LOOK / DOCUMENTED VISUALIZATION TEST SUITE (R1–R8)       ');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ─── R1: PWV5 stored RGB is the column color ────────────────────────────────
runTest('R1 PWV5 color', 'Components pass through verbatim', () => {
  const red = rgbColumnColor(1, 0, 0);
  assertEqual(red.r, 255, 'red full');
  assertEqual(red.g, 0, 'no invented green');
  assertEqual(red.b, 0, 'no invented blue');
  const half = rgbColumnColor(0.5, 0.25, 1);
  assertEqual(half.r, 128, '0.5 → 128');
  assertEqual(half.g, 64, '0.25 → 64');
  assertEqual(half.b, 255, '1 → 255');
  const clamped = rgbColumnColor(2, -1, 0.5);
  assertEqual(clamped.r, 255, 'clamp high');
  assertEqual(clamped.g, 0, 'clamp low');
});

// ─── R2: blue waveform whiteness ramp ────────────────────────────────────────
runTest('R2 blue ramp', '0 = darkest blue, 1 = near white, monotonic', () => {
  const dark = monoBlueColor(0);
  assertEqual(dark.r, MONO_BLUE_DARK.r, 'dark red');
  assertEqual(dark.b, MONO_BLUE_DARK.b, 'dark blue');
  const white = monoBlueColor(1);
  assertEqual(white.r, MONO_BLUE_WHITE.r, 'white red');
  assertEqual(white.b, MONO_BLUE_WHITE.b, 'white blue');
  const mid = monoBlueColor(0.5);
  assert(mid.b > dark.b && white.b >= mid.b, 'blue monotonic');
  assert(mid.r > dark.r, 'whiter with whiteness');
  assertEqual(monoBlueColor(-0.2).r, MONO_BLUE_DARK.r, 'clamped below');
  assertEqual(monoBlueColor(1.4).r, MONO_BLUE_WHITE.r, 'clamped above');
});

// ─── R3: PWV4 two-tone formulas ──────────────────────────────────────────────
runTest('R3 PWV4', 'back = rgb·luminance, front = rgb·luminance + boost', () => {
  const back = pwv4BackColor(1, 0.5, 0, 0.5);
  assertEqual(back.r, 128, 'red scaled by luminance');
  assertEqual(back.g, 64, 'green scaled by luminance');
  assertEqual(back.b, 0, 'blue stays 0');
  const front = pwv4FrontColor(1, 0.5, 0, 0.5);
  const boostPx = Math.round(PWV4_FRONT_BOOST * 255);
  assertEqual(front.r, Math.min(255, 128 + boostPx), 'front boosted, clipped at 1');
  assertEqual(front.b, boostPx, 'front blue from boost alone');
  assert(front.r > back.r, 'front brighter than back');
});

// ─── R4: documented 3-band look ──────────────────────────────────────────────
runTest('R4 3-band', 'dark blue / amber / white on the same axis, high last', () => {
  const layers = threeBandLayers(1, 0.5, 0.25, 100);
  assertEqual(layers.length, 3, 'three layers');
  assertEqual(layers[0].color.b, THREE_BAND_LOW.b, 'low dark blue');
  assertEqual(layers[0].color.r, 0, 'low no red');
  assertEqual(layers[1].color.r, THREE_BAND_MID.r, 'mid amber red');
  assertEqual(layers[1].color.g, THREE_BAND_MID.g, 'mid amber green');
  assertEqual(layers[2].color.r, THREE_BAND_HIGH.r, 'high white');
  assertEqual(layers[0].alpha, 1, 'low opaque');
  assertEqual(layers[1].alpha, THREE_BAND_MID_ALPHA, 'mid translucent (brown overlap)');
  assertEqual(layers[2].alpha, 1, 'high opaque, drawn last');
  assertEqual(layers[0].halfHeight, 100, 'low verbatim');
  assertEqual(layers[1].halfHeight, 50, 'mid verbatim');
  assertEqual(layers[2].halfHeight, 25, 'high verbatim');
  const silent = threeBandLayers(0, 0, 0, 100);
  assert(silent.every((l) => l.halfHeight === 0), 'silent bands draw nothing');
});

// ─── R5: comb + shading ──────────────────────────────────────────────────────
runTest('R5 comb/shading', '1 px gap above 2 px slots, even bars shaded', () => {
  assertEqual(columnDrawWidth(2), 2, 'solid below 2 px');
  assertEqual(columnDrawWidth(3), 2, 'gap at 3 px');
  assertEqual(columnDrawWidth(0), 1, 'degenerate fallback');
  assertEqual(isBarShaded(2), true, 'even shaded');
  assertEqual(isBarShaded(3), false, 'odd plain');
  assertEqual(BAR_SHADE_FILL, '#101117', 'shade tone pinned');
});

// ─── R6: PWV5 end-to-end pass-through ────────────────────────────────────────
function packRgb5(low: number, mid: number, high: number, peak: number): number {
  return ((low & 0x07) << 13) | ((mid & 0x07) << 10) | ((high & 0x07) << 7) | ((peak & 0x1f) << 2);
}

function buildPwv5Buffer(entries: number[]): ArrayBuffer {
  const section = new Uint8Array(0x18 + entries.length * 2);
  const view = new DataView(section.buffer);
  for (let i = 0; i < 4; i++) view.setUint8(i, 'PWV5'.charCodeAt(i));
  view.setUint32(4, 0x18, false);
  view.setUint32(8, section.length, false);
  view.setUint32(0x0c, 2, false);
  view.setUint32(0x10, entries.length, false);
  view.setUint32(0x14, 0x00960000, false);
  entries.forEach((v, i) => view.setUint16(0x18 + i * 2, v, false));
  return section.buffer;
}

runTest('R6 pass-through', 'Decoded PWV5 columns stay pure red/green/blue', () => {
  const extraction = parseAnlzBinary(
    buildPwv5Buffer([
      packRgb5(7, 0, 0, 31),
      packRgb5(0, 7, 0, 31),
      packRgb5(0, 0, 7, 31),
    ])
  );
  assertEqual(extraction.waveformVariants.length, 1, 'PWV5 variant decoded');
  const v = extraction.waveformVariants[0];
  assertEqual(v.sourceTag, 'PWV5', 'tag kept');
  const red = rgbColumnColor(v.lowEnergy[0], v.midEnergy[0], v.highEnergy[0]);
  assertEqual(red.r, 255, 'red column pure');
  assertEqual(red.g + red.b, 0, 'no invented components');
  const green = rgbColumnColor(v.lowEnergy[1], v.midEnergy[1], v.highEnergy[1]);
  assertEqual(green.g, 255, 'green column pure');
  const blue = rgbColumnColor(v.lowEnergy[2], v.midEnergy[2], v.highEnergy[2]);
  assertEqual(blue.b, 255, 'blue column pure');
  assertEqual(v.peaks[0], 1, 'stored height decoded');
  assertEqual(v.whiteness, undefined, 'no whiteness invented for PWV5');
});

// ─── R7: honest preview ──────────────────────────────────────────────────────
runTest('R7 preview', 'Heights only from bar/beat structure', () => {
  const barH = previewBeatHalfHeight(true, 100);
  const beatH = previewBeatHalfHeight(false, 100);
  assertEqual(barH, PREVIEW_BAR_FRACTION * 100, 'bar fixed fraction');
  assertEqual(beatH, PREVIEW_BEAT_FRACTION * 100, 'beat fixed fraction');
  assert(barH > beatH, 'bar emphasized');
  assertEqual(PREVIEW_ALPHA, 0.55, 'alpha pinned');
});

// ─── R8: peak-hold overview ──────────────────────────────────────────────────
runTest('R8 peak-hold', 'Stored maxima, never averages; PWV4 channels held', () => {
  const peaks = Float32Array.from([0.25, 0.75, 0.5]);
  const low = Float32Array.from([0.125, 0.5, 0.25]);
  const mid = Float32Array.from([0.25, 0.125, 0.5]);
  const high = Float32Array.from([0.0625, 0.25, 0.875]);
  const lum = Float32Array.from([0.5, 1, 0.25]);
  const back = Float32Array.from([0.5, 0.625, 0.75]);
  const front = Float32Array.from([0.0625, 0.25, 0.875]);
  const held = peakHoldColumn(peaks, low, mid, high, 0, 3, lum, back, front);
  assertEqual(held.peak, 0.75, 'peak max');
  assertEqual(held.low, 0.5, 'low max (average would be ~0.29)');
  assertEqual(held.mid, 0.5, 'mid max');
  assertEqual(held.high, 0.875, 'high max');
  assertEqual(held.lum, 1, 'luminance max');
  assertEqual(held.back, 0.75, 'back max');
  assertEqual(held.front, 0.875, 'front max');
  const empty = peakHoldColumn(peaks, low, mid, high, 1, 1);
  assertEqual(empty.peak, 0, 'empty range silent');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────
console.log('Test Results:\n');
let passedCount = 0;
let failedCount = 0;

results.forEach((r, idx) => {
  const icon = r.passed ? ' PASS ' : ' FAIL ';
  const status = r.passed ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  console.log(`${status}[${icon}]${reset} #${idx + 1} [${r.suite}] ${r.name} (${r.durationMs}ms)`);
  if (!r.passed) {
    console.error(`       Error: ${r.error}`);
    failedCount++;
  } else {
    passedCount++;
  }
});

console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Total: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

if (failedCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
