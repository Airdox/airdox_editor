/**
 * @license
 * Strict-PQTZ contract tests (Step 2 of the implementation order: Tests T3–T4).
 *
 * T3 – PQTZ beats verbatim: decoded beat nodes (including non-uniform times
 * and mid-grid tempo changes) reach the model untouched; uniform tail
 * continuations are flagged and never rewrite original nodes.
 * T4 – Corrupt/legacy/missing PQTZ: no uniform grid is ever rebuilt as a
 * substitute; the XML grid (genuine Rekordbox data) is kept and the gap is
 * reported through warnings instead of failing silently.
 *
 * Run with: npx tsx tests/pqtz-strict.test.ts
 */

import {
  generateRealAnlzDatFixture,
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
console.log('  STRICT-PQTZ CONTRACT TEST SUITE (T3–T4)                      ');
console.log('═══════════════════════════════════════════════════════════════════\n');

interface PqtzEntry {
  beatInBar: number;
  tempo: number;
  timeMs: number;
}

/** Minimal real-layout PQTZ/PQT2 section (tag + envelope + 8-byte entries). */
function buildPqtzBuffer(tag: string, entries: PqtzEntry[]): ArrayBuffer {
  const buffer = new ArrayBuffer(24 + entries.length * 8);
  const view = new DataView(buffer);
  for (let i = 0; i < 4; i++) view.setUint8(i, tag.charCodeAt(i));
  view.setUint32(4, 0x18, false); // len_header
  view.setUint32(8, buffer.byteLength, false); // len_tag
  view.setUint32(12, 0, false);
  view.setUint32(16, 0x80000, false);
  view.setUint32(20, entries.length, false); // len_beats
  entries.forEach((entry, i) => {
    const p = 24 + i * 8;
    view.setUint16(p, entry.beatInBar, false);
    view.setUint16(p + 2, entry.tempo, false);
    view.setUint32(p + 4, entry.timeMs, false);
  });
  return buffer;
}

// Deliberately non-uniform millisecond times with a mid-grid tempo change.
const VARIABLE_ENTRIES: PqtzEntry[] = [
  { beatInBar: 1, tempo: 12800, timeMs: 0 },
  { beatInBar: 2, tempo: 12800, timeMs: 469 },
  { beatInBar: 3, tempo: 12800, timeMs: 937 },
  { beatInBar: 4, tempo: 12800, timeMs: 1406 },
  { beatInBar: 1, tempo: 13050, timeMs: 1875 },
  { beatInBar: 2, tempo: 13050, timeMs: 2334 },
  { beatInBar: 3, tempo: 13050, timeMs: 2794 },
  { beatInBar: 4, tempo: 13050, timeMs: 3253 },
];

// ─── T3: PQTZ beats verbatim ────────────────────────────────────────────────
runTest('T3 verbatim', 'Variable-tempo PQTZ beats reach the model with exact times', () => {
  const extraction = parseAnlzBinary(buildPqtzBuffer('PQTZ', VARIABLE_ENTRIES));
  assert(extraction.beatGrid !== undefined, 'PQTZ beat grid decoded');
  assertEqual(extraction.beatGrid!.beats.length, VARIABLE_ENTRIES.length, 'All entries decoded');
  assertEqual(extraction.bpm, 128.0, 'BPM from first PQTZ tempo');
  assertEqual(extraction.firstBeat, 0, 'First beat from PQTZ');

  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const merged = applyAnlzExtractionToTrack(track, extraction);

  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ grid origin');
  assertEqual(merged.beatGrid.bpm, 128.0, 'ANLZ bpm');
  for (let i = 0; i < VARIABLE_ENTRIES.length; i++) {
    const expected = VARIABLE_ENTRIES[i];
    const node = merged.beatGrid.beats[i];
    assertEqual(node.time, expected.timeMs / 1000, `Beat ${i} time verbatim`);
    assertEqual(node.beatInBar, expected.beatInBar, `Beat ${i} beat-in-bar`);
    assertEqual(node.isBarStart, expected.beatInBar === 1, `Beat ${i} bar start`);
    assertEqual(node.tailExtended, undefined, `Beat ${i} carries no tail flag`);
  }
  assertEqual(merged.beatGrid.beats[0].barNumber, 1, 'First bar');
  assertEqual(merged.beatGrid.beats[4].barNumber, 2, 'Second bar after tempo change');
});

runTest('T3 verbatim', 'Tail continuation is flagged and never rewrites PQTZ nodes', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0); // 240s
  const extraction = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  const sourceBeats = extraction.beatGrid!.beats;
  assert(sourceBeats.length < 100, 'Fixture grid is shorter than the track');

  const merged = applyAnlzExtractionToTrack(track, extraction);
  const beats = merged.beatGrid.beats;
  assert(beats.length > sourceBeats.length, 'Tail extends the grid');

  for (let i = 0; i < sourceBeats.length; i++) {
    assertEqual(beats[i].time, sourceBeats[i].time, `Verbatim beat ${i} untouched`);
    assert(!beats[i].tailExtended, `Verbatim beat ${i} unflagged`);
  }
  for (let i = sourceBeats.length; i < beats.length; i++) {
    assertEqual(beats[i].tailExtended, true, `Tail beat ${i} flagged`);
  }
  const spb = 60.0 / 128.0;
  assertEqual(
    beats[sourceBeats.length].time,
    sourceBeats[sourceBeats.length - 1].time + spb,
    'Tail continues uniformly from the last PQTZ beat'
  );
  assert(beats[beats.length - 1].time >= track.duration, 'Grid spans the duration');
});

runTest('T3 verbatim', 'PQT2 beat entries follow the same verbatim rule', () => {
  const extraction = parseAnlzBinary(buildPqtzBuffer('PQT2', VARIABLE_ENTRIES));
  assert(extraction.beatGrid !== undefined, 'PQT2 beat grid decoded');

  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const merged = applyAnlzExtractionToTrack(track, extraction);
  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ grid origin');
  for (let i = 0; i < VARIABLE_ENTRIES.length; i++) {
    assertEqual(merged.beatGrid.beats[i].time, VARIABLE_ENTRIES[i].timeMs / 1000, `Beat ${i} time`);
  }
});

// ─── T4: corrupt / legacy / missing PQTZ ────────────────────────────────────
runTest('T4 no-rebuild', 'Corrupt PQTZ entry keeps the XML grid and warns', () => {
  const corrupt = VARIABLE_ENTRIES.map((entry, i) =>
    i === 3 ? { ...entry, beatInBar: 0 } : entry
  );
  const extraction = parseAnlzBinary(buildPqtzBuffer('PQTZ', corrupt));
  assertEqual(extraction.beatGrid, undefined, 'Corrupt grid rejected, not repaired');
  assert(extraction.tagsFound.includes('PQTZ'), 'PQTZ tag seen');
  assert(extraction.warnings.length > 0, 'Parser reports the failure');

  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const merged = applyAnlzExtractionToTrack(track, extraction);
  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_XML, 'XML grid retained');
  assertEqual(merged.beatGrid.beats.length, track.beatGrid.beats.length, 'No beats invented');
  assertEqual(merged.bpm, track.bpm, 'XML bpm retained');
  assert(
    (merged.databaseRecord!.anlzWarnings ?? []).some((w) => w.includes('PQTZ')),
    'Merge reports the PQTZ gap'
  );
});

runTest('T4 no-rebuild', 'Legacy bpm-only PQTZ keeps XML grid and ignores scalars', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extraction = parseAnlzBinary(generateSyntheticAnlzBuffer(128.0));
  assertEqual(extraction.beatGrid, undefined, 'Legacy layout carries no beat nodes');
  assertEqual(extraction.bpm, 128.0, 'Legacy scalar still decoded');

  const merged = applyAnlzExtractionToTrack(track, extraction);
  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_XML, 'XML grid retained');
  assertEqual(merged.beatGrid.beats.length, track.beatGrid.beats.length, 'No beats invented');
  assertEqual(merged.bpm, track.bpm, 'ANLZ scalar bpm not adopted without beats');
  assert(
    (merged.databaseRecord!.anlzWarnings ?? []).some((w) => w.includes('PQTZ')),
    'PQTZ gap is reported, not silent'
  );
  // Data the legacy container genuinely carries still takes priority.
  assertEqual(merged.analysis!.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ waveform kept');
});

runTest('T4 no-rebuild', 'Missing PQTZ tag leaves grid and bpm untouched', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extraction = parseAnlzBinary(new ArrayBuffer(0));
  assertEqual(extraction.tagsFound.length, 0, 'No tags decoded');

  const merged = applyAnlzExtractionToTrack(track, extraction);
  assert(merged.beatGrid === track.beatGrid, 'Grid reference untouched');
  assertEqual(merged.bpm, track.bpm, 'BPM untouched');
  assertEqual(
    (merged.databaseRecord!.anlzWarnings ?? []).filter((w) => w.includes('PQTZ')).length,
    0,
    'No spurious PQTZ warning without a PQTZ tag'
  );
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
