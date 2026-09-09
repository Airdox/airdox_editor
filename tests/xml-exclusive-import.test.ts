/**
 * @license
 * XML-exclusive workflow guarantee tests.
 *
 * Verifies that Rekordbox data is adopted verbatim and nothing is synthesized
 * by the merge layer: PQTZ beat nodes survive the ANLZ merge, legacy/partial
 * extractions without beat nodes keep the XML grid (no uniform rebuild as a
 * substitute), and a merge never invents waveform data or erases XML metadata.
 *
 * Run with: npx tsx tests/xml-exclusive-import.test.ts
 */

import {
  generateRealAnlzDatFixture,
  generateRealAnlzExtFixture,
  generateSyntheticAnlzBuffer,
  SCENARIO_TECHNO_XML,
} from './fixtures/testDatasets';
import {
  applyAnlzExtractionToTrack,
  extractTrackFromRekordboxXml,
  parseAnlzBinary,
} from '../src/rekordbox/databaseExtractor';
import { DataOrigin } from '../src/types/rekordbox';

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
console.log('  XML-EXCLUSIVE WORKFLOW GUARANTEE TEST SUITE                   ');
console.log('═══════════════════════════════════════════════════════════════════\n');

const DAT_BPM = 128.0;

// ─── SUITE 1: PQTZ beat nodes survive the merge ─────────────────────────────
runTest('PQTZ preservation', 'DAT beat nodes are adopted verbatim (time/bar/beat)', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extraction = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));
  assert(extraction.beatGrid !== undefined, 'Fixture carries a PQTZ beat grid');

  const merged = applyAnlzExtractionToTrack(track, extraction);
  const sourceBeats = extraction.beatGrid!.beats;
  const mergedBeats = merged.beatGrid.beats;

  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ grid origin');
  assert(mergedBeats.length >= sourceBeats.length, 'All ANLZ beats adopted');
  for (let i = 0; i < sourceBeats.length; i++) {
    assertEqual(mergedBeats[i].time, sourceBeats[i].time, `Beat ${i} time`);
    assertEqual(mergedBeats[i].barNumber, sourceBeats[i].barNumber, `Beat ${i} bar`);
    assertEqual(mergedBeats[i].beatInBar, sourceBeats[i].beatInBar, `Beat ${i} beat-in-bar`);
    assertEqual(mergedBeats[i].isBarStart, sourceBeats[i].isBarStart, `Beat ${i} bar start`);
  }
});

runTest('PQTZ preservation', 'Uniform tail extension spans the full duration', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0); // 240s
  const extraction = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  const beats = merged.beatGrid.beats;
  const spb = 60.0 / DAT_BPM;
  const last = beats[beats.length - 1];
  assert(last.time >= track.duration, `Grid spans duration (last=${last.time})`);
  assert(last.time <= track.duration + spb + 1e-6, `No overshoot (last=${last.time})`);
  for (let i = 1; i < beats.length; i++) {
    assert(beats[i].time > beats[i - 1].time, `Beats strictly increasing at ${i}`);
    assertEqual(beats[i].index, i, `Beat ${i} index`);
  }
});

runTest('PQTZ preservation', 'EXT PQTZ (128 beats) adopted verbatim', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extraction = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  const sourceBeats = extraction.beatGrid!.beats;
  assertEqual(sourceBeats.length, 128, 'Fixture beat count');
  for (let i = 0; i < sourceBeats.length; i++) {
    assertEqual(merged.beatGrid.beats[i].time, sourceBeats[i].time, `Beat ${i} time`);
  }
  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ grid origin');
});

// ─── SUITE 2: Legacy / partial extractions ──────────────────────────────────
runTest('Partial ANLZ', 'Legacy bpm-only extraction keeps the XML grid (no rebuild)', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extraction = parseAnlzBinary(generateSyntheticAnlzBuffer(DAT_BPM));
  assertEqual(extraction.beatGrid, undefined, 'Legacy layout carries no beat nodes');

  const merged = applyAnlzExtractionToTrack(track, extraction);
  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_XML, 'XML grid retained');
  assertEqual(merged.beatGrid.bpm, track.bpm, 'XML bpm retained');
  assertEqual(merged.beatGrid.beats.length, track.beatGrid.beats.length, 'No beats invented');
  assertEqual(merged.beatGrid.beats[0].time, track.beatGrid.beats[0].time, 'First beat untouched');
  assert(
    (merged.databaseRecord!.anlzWarnings ?? []).some((w) => w.includes('PQTZ')),
    'PQTZ gap is reported, not silent'
  );
});

// ─── SUITE 3: Merge never synthesizes, never erases ─────────────────────────
runTest('No synthesis', 'Empty ANLZ invents no waveform and keeps the XML grid', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  track.analysis = null; // collection entries carry no analysis
  const xmlCueCount = track.cues.length;

  const extraction = parseAnlzBinary(new ArrayBuffer(0));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  assertEqual(merged.analysis, null, 'No waveform invented');
  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_XML, 'XML grid untouched');
  assertEqual(merged.beatGrid.firstBeat, track.beatGrid.firstBeat, 'First beat untouched');
  assertEqual(merged.cues.length, xmlCueCount, 'XML cues untouched');
  assertEqual(merged.title, track.title, 'XML title retained');
  assertEqual(merged.artist, track.artist, 'XML artist retained');
});

runTest('No synthesis', 'ANLZ waveform + cues take priority without touching metadata', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  track.analysis = null;
  const extraction = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  assert(merged.analysis !== null, 'ANLZ waveform adopted');
  assertEqual(merged.analysis!.origin, DataOrigin.REKORDBOX_ANLZ, 'Waveform origin');
  assert(merged.cues.every((cue) => cue.origin === DataOrigin.REKORDBOX_ANLZ), 'ANLZ cues adopted');
  assertEqual(merged.title, track.title, 'XML title retained');
  assertEqual(merged.originalMedia, track.originalMedia, 'Original-media reference retained');
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
