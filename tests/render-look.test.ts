/**
 * @license
 * Visual-lock tests for the authentic Rekordbox look (reference 01–03).
 *
 * The ANLZ data is used verbatim; these tests pin the pure render-model
 * rules the canvas renderers must apply, so the visualization cannot drift
 * from the stored values:
 *
 *  R1 – RGB/3BAND columns are nested band bars in the authentic band colors
 *       (low = red outer, mid = green, high = blue core), heights exactly
 *       the stored band values; silent bands draw nothing.
 *  R2 – Comb geometry: 1 px black gap between columns once a slot is wider
 *       than 2 px, solid columns below.
 *  R3 – Alternate bars sit on a slightly lighter shaded ground.
 *  R4 – End-to-end pass-through: PWV5 bit-packed band values decoded by
 *       parseAnlzBinary reach bandColumnBars unmodified (red-only,
 *       green-only, blue-only columns stay pure).
 *  R5 – Mono preview constants (authentic Rekordbox preview blue) pinned.
 *
 * Run with: npx tsx tests/render-look.test.ts
 */

import {
  BAND_COLOR_HIGH,
  BAND_COLOR_LOW,
  BAND_COLOR_MID,
  BAR_SHADE_FILL,
  bandColumnBars,
  columnDrawWidth,
  isBarShaded,
  MONO_PREVIEW_BLUE,
  MONO_PREVIEW_CORE,
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
console.log('  RENDER LOOK / VISUAL LOCK TEST SUITE (R1–R5)                    ');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ─── R1: nested band bars, verbatim heights ────────────────────────────────
runTest('R1 band bars', 'Order and authentic band colors (low red, mid green, high blue)', () => {
  const bars = bandColumnBars(1, 1, 1, 100);
  assertEqual(bars.length, 3, 'Three nested bars');
  assertEqual(bars[0].color.r, BAND_COLOR_LOW.r, 'Low color object');
  assertEqual(bars[0].color.r, 255, 'Low red channel');
  assertEqual(bars[0].color.g, 0, 'Low green channel');
  assertEqual(bars[0].color.b, 0, 'Low blue channel');
  assertEqual(bars[1].color.g, BAND_COLOR_MID.g, 'Mid green channel');
  assertEqual(bars[1].color.r, 0, 'Mid red channel');
  assertEqual(bars[2].color.b, BAND_COLOR_HIGH.b, 'High blue channel');
  assertEqual(bars[2].color.g, 90, 'High green channel');
});

runTest('R1 band bars', 'Heights are the stored values verbatim', () => {
  const bars = bandColumnBars(1, 0.5, 0.25, 100);
  assertEqual(bars[0].halfHeight, 100, 'Low = stored 1.0 * maxHalfH');
  assertEqual(bars[1].halfHeight, 50, 'Mid = stored 0.5 * maxHalfH');
  assertEqual(bars[2].halfHeight, 25, 'High = stored 0.25 * maxHalfH');
  const over = bandColumnBars(2, 0, 0, 100);
  assertEqual(over[0].halfHeight, 100, 'Values clamp at 1.0, never exceed');
});

runTest('R1 band bars', 'Silent bands draw nothing, non-silent bands stay visible', () => {
  const silent = bandColumnBars(0, 0, 0, 100);
  assert(silent.every((b) => b.halfHeight === 0), 'All-zero column yields no bars');
  const faint = bandColumnBars(0.001, 0, 0, 100);
  assert(faint[0].halfHeight >= 1, '1 px minimum keeps faint bands visible');
});

// ─── R2: comb geometry ─────────────────────────────────────────────────────
runTest('R2 comb', '1 px gap once columns get wider than 2 px', () => {
  assertEqual(columnDrawWidth(1), 1, 'Subpixel columns stay solid');
  assertEqual(columnDrawWidth(2), 2, '2 px slots stay solid');
  assertEqual(columnDrawWidth(3), 2, '3 px slot leaves a 1 px gap');
  assertEqual(columnDrawWidth(4.5), 3.5, 'Gap scales with the slot');
  assertEqual(columnDrawWidth(0), 1, 'Degenerate slot falls back to 1 px');
  assertEqual(columnDrawWidth(-4), 1, 'Negative slot falls back to 1 px');
});

// ─── R3: alternate bar shading ─────────────────────────────────────────────
runTest('R3 shading', 'Even bars shaded, odd bars plain, tone pinned', () => {
  assertEqual(isBarShaded(1), false, 'Bar 1 plain');
  assertEqual(isBarShaded(2), true, 'Bar 2 shaded');
  assertEqual(isBarShaded(3), false, 'Bar 3 plain');
  assertEqual(isBarShaded(4), true, 'Bar 4 shaded');
  assertEqual(BAR_SHADE_FILL, '#101117', 'Shade tone pinned');
});

// ─── R4: PWV5 bit-packed values reach the bars unmodified ─────────────────
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

runTest('R4 pass-through', 'Red-only, green-only, blue-only PWV5 columns stay pure', () => {
  const extraction = parseAnlzBinary(
    buildPwv5Buffer([
      packRgb5(7, 0, 0, 31), // loud low-only column
      packRgb5(0, 7, 0, 31), // mid-only column
      packRgb5(0, 0, 7, 31), // high-only column
    ])
  );
  assertEqual(extraction.waveformVariants.length, 1, 'PWV5 variant decoded');
  const variant = extraction.waveformVariants[0];
  assertEqual(variant.sourceTag, 'PWV5', 'Source tag kept');

  const maxHalfH = 100;
  const red = bandColumnBars(variant.lowEnergy[0], variant.midEnergy[0], variant.highEnergy[0], maxHalfH);
  assertEqual(red[0].halfHeight, 100, 'Stored low=7 renders at full height');
  assertEqual(red[1].halfHeight, 0, 'No invented mid');
  assertEqual(red[2].halfHeight, 0, 'No invented high (the blue core is data, not a spine)');

  const green = bandColumnBars(variant.lowEnergy[1], variant.midEnergy[1], variant.highEnergy[1], maxHalfH);
  assertEqual(green[0].halfHeight, 0, 'No invented low');
  assertEqual(green[1].halfHeight, 100, 'Stored mid=7 renders at full height');

  const blue = bandColumnBars(variant.lowEnergy[2], variant.midEnergy[2], variant.highEnergy[2], maxHalfH);
  assertEqual(blue[2].halfHeight, 100, 'Stored high=7 renders at full height');
  assertEqual(blue[0].halfHeight, 0, 'No invented low');
});

// ─── R5: mono preview constants ────────────────────────────────────────────
runTest('R5 mono', 'Authentic preview blue pinned', () => {
  assertEqual(MONO_PREVIEW_BLUE, '#00a2ff', 'Preview blue');
  assertEqual(MONO_PREVIEW_CORE, '#b3e5fc', 'Preview core');
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
