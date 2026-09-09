/**
 * @license
 * Waveform variant & renderer-model tests (Step 3 of the implementation order:
 * Tests T5–T6).
 *
 * T5 – Genuine ANLZ variants by zoom: every decoded PWV variant is kept with
 * its source tag, the merge adopts them onto the track, and the pure zoom
 * selector picks the coarsest variant that resolves the view (finest available
 * on deep zoom — detail is never invented).
 * T6 – No synthesis: empty/partial ANLZ data yields no waveform and no
 * variants, variant-less merges keep the track state, and the visible-beat
 * collector carries tail provenance through to the renderer.
 *
 * Run with: npx tsx tests/waveform-variants.test.ts
 */

import {
  generateRealAnlzDatFixture,
  generateRealAnlzExtFixture,
  SCENARIO_TECHNO_XML,
} from '../src/rekordbox/testDatasets';
import {
  applyAnlzExtractionToTrack,
  extractTrackFromRekordboxXml,
  parseAnlzBinary,
} from '../src/rekordbox/databaseExtractor';
import {
  beatIndexAtOrAfter,
  collectVisibleBeats,
  selectWaveformVariant,
} from '../src/waveform/renderModel';
import { BeatNode, DataOrigin } from '../src/types/rekordbox';

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
console.log('  WAVEFORM VARIANT & RENDERER-MODEL TEST SUITE (T5–T6)         ');
console.log('═══════════════════════════════════════════════════════════════════\n');

/** One real-layout PWV section (PWV3 mono / PWV5 RGB share the 0x18 header). */
function buildPwvSection(tag: string, entryBytes: number, count: number, seed: number): Uint8Array {
  const section = new Uint8Array(0x18 + entryBytes * count);
  const view = new DataView(section.buffer);
  for (let i = 0; i < 4; i++) view.setUint8(i, tag.charCodeAt(i));
  view.setUint32(4, 0x18, false);
  view.setUint32(8, section.length, false);
  view.setUint32(0x0c, entryBytes, false);
  view.setUint32(0x10, count, false);
  view.setUint32(0x14, 0x00960000, false);
  for (let i = 0; i < count; i++) {
    if (entryBytes === 1) {
      view.setUint8(0x18 + i, 8 + ((i * 7 + seed) % 24));
    } else {
      view.setUint16(0x18 + i * 2, ((i * 13 + seed) % 65536), false);
    }
  }
  return section;
}

function concatSections(sections: Uint8Array[]): ArrayBuffer {
  const total = sections.reduce((sum, s) => sum + s.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const section of sections) {
    out.set(section, offset);
    offset += section.length;
  }
  return out.buffer;
}

/** Minimal real-layout PQTZ section (beat entries only, no waveform). */
function buildPqtzOnlyBuffer(): ArrayBuffer {
  const buffer = new ArrayBuffer(24 + 4 * 8);
  const view = new DataView(buffer);
  view.setUint8(0, 80); view.setUint8(1, 81); view.setUint8(2, 84); view.setUint8(3, 90);
  view.setUint32(4, 0x18, false);
  view.setUint32(8, buffer.byteLength, false);
  view.setUint32(12, 0, false);
  view.setUint32(16, 0x80000, false);
  view.setUint32(20, 4, false);
  for (let i = 0; i < 4; i++) {
    const p = 24 + i * 8;
    view.setUint16(p, (i % 4) + 1, false);
    view.setUint16(p + 2, 12800, false);
    view.setUint32(p + 4, i * 469, false);
  }
  return buffer;
}

// ─── T5: genuine variants by zoom ───────────────────────────────────────────
runTest('T5 variants', 'EXT keeps every PWV variant with its source tag', () => {
  const extraction = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  assertEqual(extraction.waveformVariants.length, 2, 'Both variants kept');
  assertEqual(extraction.waveformVariants[0].sourceTag, 'PWV3', 'First variant tag');
  assertEqual(extraction.waveformVariants[1].sourceTag, 'PWV7', 'Second variant tag');
  assertEqual(extraction.waveformVariants[0].length, 900, 'PWV3 buckets');
  assertEqual(extraction.waveformVariants[1].length, 900, 'PWV7 buckets');
  assertEqual(extraction.waveform!.sourceTag, 'PWV7', 'Best variant still wins');
  assert(extraction.waveform === extraction.waveformVariants[1], 'Best is the same object');
  assert(
    extraction.waveformVariants.every((v) => v.origin === DataOrigin.REKORDBOX_ANLZ),
    'All variants carry the ANLZ origin'
  );
});

runTest('T5 variants', 'DAT keeps its single PWV5 variant', () => {
  const extraction = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  assertEqual(extraction.waveformVariants.length, 1, 'Single variant');
  assertEqual(extraction.waveformVariants[0].sourceTag, 'PWV5', 'Variant tag');
  assert(extraction.waveform === extraction.waveformVariants[0], 'Best is the variant');
});

runTest('T5 variants', 'Merge adopts variants onto the track', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extraction = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  assertEqual(merged.analysisVariants!.length, 2, 'Variants adopted');
  assertEqual(merged.analysis!.sourceTag, 'PWV7', 'Best variant as analysis');
  assertEqual(merged.databaseRecord!.waveformBuckets, 900, 'Bucket count from best');
});

runTest('T5 zoom', 'Selector resolves zoom end-to-end on parsed counts', () => {
  const buffer = concatSections([
    buildPwvSection('PWV3', 1, 150, 3),
    buildPwvSection('PWV5', 2, 2400, 11),
  ]);
  const extraction = parseAnlzBinary(buffer);
  assertEqual(extraction.waveformVariants.length, 2, 'Both resolutions decoded');
  const counts = extraction.waveformVariants.map((v) => v.length);
  assertEqual(counts[0], 150, 'Coarse count');
  assertEqual(counts[1], 2400, 'Fine count');

  // Overview-width rendering: the coarse variant already resolves 100 columns.
  assertEqual(selectWaveformVariant(counts, 240, 240, 100), 0, 'Coarse suffices for overview');
  // Detail-width rendering: only the fine variant resolves 900 columns.
  assertEqual(selectWaveformVariant(counts, 240, 240, 900), 1, 'Fine for full-width detail');
  // Deep zoom: nothing resolves the view, finest available wins (no invention).
  assertEqual(selectWaveformVariant(counts, 12, 240, 900), 1, 'Finest on deep zoom');
});

runTest('T5 zoom', 'Selector prefers the coarsest sufficient variant', () => {
  const counts = [1200, 9600];
  assertEqual(selectWaveformVariant(counts, 240, 240, 900), 0, 'Coarse wins zoomed out');
  assertEqual(selectWaveformVariant(counts, 120, 240, 900), 1, 'Fine wins zoomed in');
  assertEqual(selectWaveformVariant(counts, 12, 240, 900), 1, 'Finest when none suffices');
  assertEqual(selectWaveformVariant([9600, 1200], 240, 240, 900), 1, 'Order-independent');
  assertEqual(selectWaveformVariant(counts, 0, 240, 900), 1, 'Degenerate view falls back to finest');
  assertEqual(selectWaveformVariant([], 240, 240, 900), -1, 'No candidates, no choice');
});

// ─── T6: no synthesis, honest render model ──────────────────────────────────
runTest('T6 no-synth', 'Empty ANLZ yields no waveform and no variants', () => {
  const extraction = parseAnlzBinary(new ArrayBuffer(0));
  assertEqual(extraction.waveform, undefined, 'No waveform decoded');
  assertEqual(extraction.waveformVariants.length, 0, 'No variants decoded');

  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  track.analysis = null;
  track.analysisVariants = undefined;
  const merged = applyAnlzExtractionToTrack(track, extraction);
  assertEqual(merged.analysis, null, 'No waveform invented');
  assertEqual(merged.analysisVariants, undefined, 'No variants invented');
});

runTest('T6 no-synth', 'PQTZ-only ANLZ invents no waveform', () => {
  const extraction = parseAnlzBinary(buildPqtzOnlyBuffer());
  assert(extraction.beatGrid !== undefined, 'Grid decoded');
  assertEqual(extraction.waveform, undefined, 'No waveform decoded');
  assertEqual(extraction.waveformVariants.length, 0, 'No variants decoded');

  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  track.analysis = null;
  const merged = applyAnlzExtractionToTrack(track, extraction);
  assertEqual(merged.analysis, null, 'Merge invents no waveform');
  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'Grid still adopted');
});

runTest('T6 no-synth', 'Variant-less merge keeps the track variants', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const preset = parseAnlzBinary(generateRealAnlzDatFixture(128.0)).waveformVariants;
  track.analysisVariants = preset;
  const extraction = parseAnlzBinary(new ArrayBuffer(0));
  const merged = applyAnlzExtractionToTrack(track, extraction);
  assert(merged.analysisVariants === preset, 'Existing variants retained by reference');
});

runTest('T6 render-model', 'Visible-beat collector filters and carries tail flags', () => {
  const beats: BeatNode[] = [
    { index: 0, time: 0.0, isBarStart: true, barNumber: 1, beatInBar: 1 },
    { index: 1, time: 0.5, isBarStart: false, barNumber: 1, beatInBar: 2 },
    { index: 2, time: 1.0, isBarStart: false, barNumber: 1, beatInBar: 3 },
    { index: 3, time: 1.5, isBarStart: false, barNumber: 1, beatInBar: 4 },
    { index: 4, time: 2.0, isBarStart: true, barNumber: 2, beatInBar: 1, tailExtended: true },
  ];
  const visible = collectVisibleBeats(beats, 0.5, 2.0);
  assertEqual(visible.length, 4, 'Window members only');
  assertEqual(visible.map((v) => v.time).join(','), '0.5,1,1.5,2', 'Time order kept');
  assertEqual(visible.map((v) => (v.tail ? 'T' : 'V')).join(''), 'VVVT', 'Tail flag carried');
  assertEqual(visible[0].isBar, false, 'Beat flag');
  assertEqual(visible[3].isBar, true, 'Bar flag');
  assertEqual(visible[3].barNumber, 2, 'Bar number');
  assertEqual(collectVisibleBeats(beats, 5, 6).length, 0, 'Empty outside the grid');
  assertEqual(collectVisibleBeats(beats, 0, 9, 2).length, 2, 'Cap respected');
});

runTest('T6 render-model', 'Beat binary search hits boundaries exactly', () => {
  const beats: BeatNode[] = [
    { index: 0, time: 0.0, isBarStart: true, barNumber: 1, beatInBar: 1 },
    { index: 1, time: 0.5, isBarStart: false, barNumber: 1, beatInBar: 2 },
    { index: 2, time: 1.0, isBarStart: false, barNumber: 1, beatInBar: 3 },
  ];
  assertEqual(beatIndexAtOrAfter(beats, 0.0), 0, 'Exact first hit');
  assertEqual(beatIndexAtOrAfter(beats, 1.0), 2, 'Exact mid hit');
  assertEqual(beatIndexAtOrAfter(beats, 0.25), 1, 'Between beats');
  assertEqual(beatIndexAtOrAfter(beats, 9.0), 3, 'Beyond the end');
  assertEqual(beatIndexAtOrAfter([], 1.0), 0, 'Empty grid');
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
