/**
 * @license
 * Deck-loader and edit-guard tests (Step 4 of the implementation order:
 * Tests T7–T8).
 *
 * T7 – Deck loader: Rekordbox origins are guarded (ANLZ-only waveform rule),
 * ANLZ/track plausibility (PPTH) is checked, and persisted grids round-trip
 * verbatim (nodes, flags, grid origin — even when it differs from the track
 * origin).
 * T8 – Guards: older projects without persisted beats still load (uniform
 * legacy fallback), rigid grid shifts preserve original intervals, and every
 * manual grid edit produces a traceable USER_EDIT change notice.
 *
 * Run with: npx tsx tests/track-guards.test.ts
 */

import {
  adoptSerializedGrid,
  describeGridEdit,
  ensureArrayBuffer,
  isRekordboxOrigin,
  ppthMismatchNote,
  selectDeckWaveformSource,
  shiftBeatNodes,
} from '../src/rekordbox/trackGuards';
import { generateRealAnlzDatFixture } from '../src/rekordbox/testDatasets';
import { parseAnlzBinary } from '../src/rekordbox/databaseExtractor';
import { deserializeProject, serializeProject } from '../src/rekordbox/projectFile';
import { BeatGrid, BeatNode, DataOrigin, TrackModel } from '../src/types/rekordbox';

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
console.log('  DECK-LOADER & EDIT-GUARD TEST SUITE (T7–T8)                 ');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ─── T7: deck loader ────────────────────────────────────────────────────────
runTest('T7 origins', 'Rekordbox origins are guarded, others are open', () => {
  assertEqual(isRekordboxOrigin(DataOrigin.REKORDBOX_XML), true, 'XML guarded');
  assertEqual(isRekordboxOrigin(DataOrigin.REKORDBOX_DB), true, 'DB guarded');
  assertEqual(isRekordboxOrigin(DataOrigin.REKORDBOX_ANLZ), true, 'ANLZ guarded');
  assertEqual(isRekordboxOrigin(DataOrigin.PROJECT), false, 'Project open');
  assertEqual(isRekordboxOrigin(DataOrigin.LOCAL_ANALYSIS), false, 'Local import open');
  assertEqual(isRekordboxOrigin(DataOrigin.USER_EDIT), false, 'User edit open');
  assertEqual(isRekordboxOrigin(DataOrigin.GENERATED_FALLBACK), false, 'Demo open');
  assertEqual(isRekordboxOrigin(undefined), false, 'Undefined open');
});

runTest('T7 origins', 'Waveform source rule: RB tracks are ANLZ-only', () => {
  assertEqual(selectDeckWaveformSource(DataOrigin.REKORDBOX_XML), 'ANLZ_ONLY', 'XML');
  assertEqual(selectDeckWaveformSource(DataOrigin.REKORDBOX_DB), 'ANLZ_ONLY', 'DB');
  assertEqual(selectDeckWaveformSource(DataOrigin.REKORDBOX_ANLZ), 'ANLZ_ONLY', 'ANLZ');
  assertEqual(selectDeckWaveformSource(DataOrigin.LOCAL_ANALYSIS), 'LOCAL_ALLOWED', 'Local import');
  assertEqual(selectDeckWaveformSource(DataOrigin.PROJECT), 'LOCAL_ALLOWED', 'Project');
  assertEqual(selectDeckWaveformSource(undefined), 'LOCAL_ALLOWED', 'Undefined');
});

runTest('T7 ppth', 'PPTH plausibility tolerates encoding, flags mismatch', () => {
  assertEqual(
    ppthMismatchNote('D:\\Music\\Ref Mix.wav', 'file://localhost/C:/Music/Ref%20Mix.wav'),
    null,
    'Same file across encodings'
  );
  assertEqual(
    ppthMismatchNote('/PIONEER/Music/Track.wav?x=1', 'C:\\Music\\Track.wav'),
    null,
    'Query strings ignored'
  );
  const note = ppthMismatchNote('/PIONEER/Music/Other.wav', 'C:\\Music\\Track.wav');
  assert(note !== null && note.includes('PPTH'), 'Mismatch produces a PPTH note');
  assertEqual(ppthMismatchNote(undefined, 'C:\\Music\\Track.wav'), null, 'Missing PPTH never warns');
  assertEqual(ppthMismatchNote('/PIONEER/Music/Track.wav', ''), null, 'Missing track path never warns');
});

runTest('T7 round-trip', 'Project save/load preserves verbatim nodes and grid origin', () => {
  const nodes: BeatNode[] = [
    { index: 0, time: 0.469, isBarStart: true, barNumber: 1, beatInBar: 1 },
    { index: 1, time: 0.937, isBarStart: false, barNumber: 1, beatInBar: 2 },
    { index: 2, time: 1.406, isBarStart: false, barNumber: 1, beatInBar: 3 },
    { index: 3, time: 1.875, isBarStart: false, barNumber: 1, beatInBar: 4, tailExtended: true },
  ];
  const grid: BeatGrid = { firstBeat: 0.469, bpm: 128.02, meter: 4, beats: nodes, origin: DataOrigin.REKORDBOX_ANLZ };
  const track = {
    id: 'rb-xml-1',
    title: 'Ref',
    artist: 'Ref',
    album: 'Ref',
    bpm: 128.02,
    key: '2A',
    duration: 240,
    sampleRate: 44100,
    channels: 2,
    originalSha256: 'sha256-test',
    isOriginalUntouched: true,
    audioBuffer: null,
    beatGrid: grid,
    cues: [],
    loops: [],
    analysis: null,
    // Mixed provenance: XML track carrying an ANLZ grid.
    origin: DataOrigin.REKORDBOX_XML,
    originalMedia: { location: 'C:\\Music\\Ref.wav', accessMode: 'READ_ONLY', status: 'MISSING' },
    workingSegments: [],
  } as unknown as TrackModel;

  const doc = deserializeProject(serializeProject({
    projectName: 'Guard Test',
    activeTrackId: track.id,
    selection: null,
    tracks: [track],
    paletteClips: [],
  }));
  const persisted = doc.tracks[0].beatGrid;
  assertEqual(persisted.beats!.length, 4, 'Nodes persisted');
  assertEqual(persisted.origin, DataOrigin.REKORDBOX_ANLZ, 'Grid origin persisted');

  const rebuilt = adoptSerializedGrid(persisted, 240, DataOrigin.REKORDBOX_XML);
  assertEqual(rebuilt.origin, DataOrigin.REKORDBOX_ANLZ, 'Grid origin survives (not the track origin)');
  assertEqual(rebuilt.beats.length, 4, 'Node count survives');
  for (let i = 0; i < nodes.length; i++) {
    assertEqual(rebuilt.beats[i].time, nodes[i].time, `Node ${i} time verbatim`);
    assertEqual(rebuilt.beats[i].barNumber, nodes[i].barNumber, `Node ${i} bar`);
    assertEqual(rebuilt.beats[i].beatInBar, nodes[i].beatInBar, `Node ${i} beat-in-bar`);
    assertEqual(rebuilt.beats[i].index, i, `Node ${i} re-indexed`);
  }
  assertEqual(rebuilt.beats[3].tailExtended, true, 'Tail flag survives');
  assertEqual(rebuilt.beats[0].tailExtended, undefined, 'Verbatim node stays unflagged');
});

// ─── T8: guards ─────────────────────────────────────────────────────────────
runTest('T8 legacy', 'Projects without persisted beats fall back to a uniform rebuild', () => {
  const rebuilt = adoptSerializedGrid(
    { firstBeat: 0.5, bpm: 128, meter: 4 },
    240,
    DataOrigin.REKORDBOX_XML
  );
  assertEqual(rebuilt.origin, DataOrigin.REKORDBOX_XML, 'Track origin as documented fallback');
  assertEqual(rebuilt.firstBeat, 0.5, 'Scalar anchor kept');
  assert(rebuilt.beats.length > 100, 'Uniform grid expanded');
  assertEqual(rebuilt.beats[0].time, 0.5, 'Starts at first beat');
  assertEqual(rebuilt.beats[1].time - rebuilt.beats[0].time, 60.0 / 128, 'Uniform spacing');
});

runTest('T8 shift', 'Rigid shift preserves intervals and provenance', () => {
  const nodes: BeatNode[] = [
    { index: 0, time: 0.469, isBarStart: true, barNumber: 1, beatInBar: 1 },
    { index: 1, time: 0.937, isBarStart: false, barNumber: 1, beatInBar: 2 },
    { index: 2, time: 1.406, isBarStart: false, barNumber: 1, beatInBar: 3, tailExtended: true },
  ];
  const shifted = shiftBeatNodes(nodes, 0.1);
  assertEqual(shifted.length, 3, 'All nodes kept');
  assertEqual(shifted[0].time, 0.469 + 0.1, 'Shift applied');
  assert(Math.abs((shifted[1].time - shifted[0].time) - (0.937 - 0.469)) < 1e-12, 'Interval preserved');
  assert(Math.abs((shifted[2].time - shifted[1].time) - (1.406 - 0.937)) < 1e-12, 'Interval preserved');
  assertEqual(shifted[2].tailExtended, true, 'Tail flag kept');
  assertEqual(shifted[1].barNumber, 1, 'Bar number kept');
  assertEqual(nodes[0].time, 0.469, 'Input untouched');
});

runTest('T8 shift', 'Negative shifts drop pre-zero nodes and re-index', () => {
  const nodes: BeatNode[] = [
    { index: 0, time: 0.0005, isBarStart: true, barNumber: 1, beatInBar: 1 },
    { index: 1, time: 0.469, isBarStart: false, barNumber: 1, beatInBar: 2 },
  ];
  const shifted = shiftBeatNodes(nodes, -0.001);
  assertEqual(shifted.length, 1, 'Pre-zero node dropped');
  assertEqual(shifted[0].index, 0, 'Re-indexed');
  assertEqual(shifted[0].time, 0.469 - 0.001, 'Survivor shifted');
  assertEqual(shifted[0].beatInBar, 2, 'Musical position kept');

  const identity = shiftBeatNodes(nodes, 0);
  assertEqual(identity.length, 2, 'Zero delta keeps all');
  assert(identity[0] !== nodes[0], 'Zero delta still copies');
});

runTest('T8 notice', 'Grid edits produce a traceable USER_EDIT notice', () => {
  const notice = describeGridEdit('AUTO_ALIGN', 0.469, 0.4814, 512);
  assert(notice.includes('Auto-Align'), 'Source named');
  assert(notice.includes('+12.4 ms'), 'Delta in ms');
  assert(notice.includes('0.469s → 0.481s'), 'Old and new first beat');
  assert(notice.includes('512 Beats'), 'Node count');
  assert(notice.includes('USER_EDIT'), 'USER_EDIT labeled');
  assert(notice.includes('Undo'), 'Recovery path named');

  const shift = describeGridEdit('SHIFT', 1.0, 0.999, 5000);
  assert(shift.includes('Grid-Shift'), 'Shift source named');
  assert(shift.includes('-1.0 ms'), 'Negative delta signed');
});

// ─── Bridge payload guard (desktop IPC regression) ──────────────────────────
runTest('Bridge payload', 'ArrayBuffer passes through by reference', () => {
  const buffer = new ArrayBuffer(16);
  assert(ensureArrayBuffer(buffer) === buffer, 'Same reference, no copy');
});

runTest('Bridge payload', 'Offset Uint8Array views copy byte-exactly', () => {
  // Simulates a pooled Node Buffer: the payload is a window into a larger store.
  const pool = new Uint8Array(128);
  for (let i = 0; i < pool.length; i++) pool[i] = i % 256;
  const view = new Uint8Array(pool.buffer, 37, 40);
  const normalized = ensureArrayBuffer(view);
  assertEqual(normalized.byteLength, 40, 'Exact length');
  const bytes = new Uint8Array(normalized);
  for (let i = 0; i < 40; i++) {
    assertEqual(bytes[i], (37 + i) % 256, `Byte ${i} preserved`);
  }
});

runTest('Bridge payload', 'IPC-shaped ANLZ payload decodes after normalization', () => {
  const fixture = generateRealAnlzDatFixture(128.0);
  const pool = new Uint8Array(fixture.byteLength + 64);
  pool.set(new Uint8Array(fixture), 37);
  const ipcView = new Uint8Array(pool.buffer, 37, fixture.byteLength);

  // Documents the desktop bug: a raw IPC view throws inside the parser.
  let threw = false;
  try {
    parseAnlzBinary(ipcView as unknown as ArrayBuffer);
  } catch {
    threw = true;
  }
  assert(threw, 'Raw IPC view throws (the reported desktop failure)');

  const extraction = parseAnlzBinary(ensureArrayBuffer(ipcView));
  assert(extraction.tagsFound.includes('PQTZ'), 'PQTZ decoded');
  assert(extraction.waveform !== undefined, 'Waveform decoded');
  assertEqual(extraction.waveform!.length, 600, 'DAT buckets intact');
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
