/**
 * @license
 * Regression suite for the real Rekordbox ANLZ binary layouts
 * (PMAI/PPTH/PQTZ/PCOB-PCPT/PCO2-PCP2/PWV/PSSI) as documented by the
 * Deep Symmetry analysis of the Rekordbox export format.
 *
 * Run with: npx tsx tests/anlz-real-format.test.ts
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
console.log('  REKORDBOX REAL ANLZ BINARY FORMAT REGRESSION SUITE             ');
console.log('═══════════════════════════════════════════════════════════════════\n');

const DAT_BPM = 128.0;
const DAT_SPB_MS = Math.round(60000 / DAT_BPM);

// ─── SUITE 1: .DAT (real PMAI/PPTH/PQTZ/PCOB-PCPT/PWV5) ─────────────────────
runTest('Real ANLZ .DAT', 'Reads PPTH source path, PQTZ beatgrid and tags', () => {
  const result = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));

  assert(result.tagsFound.includes('PPTH'), 'PPTH tag found');
  assert(result.tagsFound.includes('PQTZ'), 'PQTZ tag found');
  assert(result.tagsFound.includes('PCOB'), 'PCOB tag found');
  assert(result.tagsFound.includes('PWV5'), 'PWV5 tag found');
  assertEqual(result.analysisPath, 'C:\\Music\\Reference.wav', 'PPTH path');
  assertEqual(result.bpm, DAT_BPM, 'BPM from PQTZ');
  assertEqual(result.firstBeat, 0, 'First beat offset');
  assert(result.beatGrid !== undefined, 'Beat grid parsed');
  assert(result.beatGrid!.beats.length >= 32, 'Beat entries decoded');
});

runTest('Real ANLZ .DAT', 'Decodes classic PCPT memory cues and loops', () => {
  const result = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));

  const memories = result.cues.filter((cue) => cue.type === 'MEMORY');
  const loops = result.loops;
  assertEqual(memories.length, 3, 'Memory cue count (4th PCPT entry is a loop)');
  assertEqual(Math.round(memories[0].position * 1000), 0, 'Memory cue 1 position');
  assertEqual(Math.round(memories[1].position * 1000), 8 * DAT_SPB_MS, 'Memory cue 2 position');
  assertEqual(Math.round(memories[2].position * 1000), 16 * DAT_SPB_MS, 'Memory cue 3 position');
  assertEqual(loops.length, 1, 'Loop count');
  assertEqual(Math.round(loops[0].start * 1000), 4 * DAT_SPB_MS, 'Loop start');
  assertEqual(Math.round(loops[0].end * 1000), 12 * DAT_SPB_MS, 'Loop end');
});

runTest('Real ANLZ .DAT', 'Decodes hot cues from the second PCOB (type=1)', () => {
  const result = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));

  const hot = result.cues.filter((cue) => cue.type === 'HOT_CUE');
  assertEqual(hot.length, 1, 'Hot cue count');
  assertEqual(hot[0].letter, 'A', 'Hot cue letter');
  assertEqual(Math.round(hot[0].position * 1000), 16 * DAT_SPB_MS, 'Hot cue position');
  assertEqual(hot[0].origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ origin');
});

runTest('Real ANLZ .DAT', 'Decodes 2-byte RGB + height PWV5 waveform entries', () => {
  const result = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));

  assert(result.waveform !== undefined, 'Waveform present');
  assertEqual(result.waveform!.length, 600, 'Waveform bucket count');
  assertEqual(result.waveform!.origin, DataOrigin.REKORDBOX_ANLZ, 'Waveform origin');
  const peak = result.waveform!.peaks[100];
  assert(peak >= 0 && peak <= 1, `Peak normalized [0..1], got ${peak}`);
});

// ─── SUITE 2: .EXT (PCO2-PCP2, PWV3/PWV7, masked PSSI) ──────────────────────
runTest('Real ANLZ .EXT', 'PCO2 extended hot cues carry comments and colors', () => {
  const result = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM));

  const hot = result.cues.filter((cue) => cue.type === 'HOT_CUE');
  assertEqual(hot.length, 3, 'Hot cue count');
  assertEqual(hot[0].letter, 'A', 'Hot A');
  assertEqual(hot[0].comment, 'Einsatz A', 'Hot A comment');
  assertEqual(hot[1].comment, 'Drop', 'Hot B comment');
  assertEqual(hot[2].comment, undefined, 'Hot C has no comment');
  assertEqual(hot[0].color, 'rgb(0, 162, 255)', 'Hot A color');
});

runTest('Real ANLZ .EXT', 'PCO2 memory cues override the classic PCOB list', () => {
  const result = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM));

  const memories = result.cues.filter((cue) => cue.type === 'MEMORY');
  assertEqual(memories.length, 1, 'Only the PCO2 memory entry remains');
  assertEqual(memories[0].comment, 'Breakdown Memory', 'PCO2 comment used');
});

runTest('Real ANLZ .EXT', 'Decodes masked Rekordbox 6 PSSI song structure', () => {
  const result = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM, { maskPssi: true }));

  assertEqual(result.pssiMasked, true, 'PSSI masked detection');
  assertEqual(result.pssiMood, 1, 'PSSI mood (high)');
  assertEqual(result.pssiEndBeat, 65, 'PSSI end beat');
  assertEqual(result.pssiBank, 3, 'PSSI bank');
  assertEqual(result.phrases.length, 4, 'PSSI phrase count');

  const names = result.phrases.map((p) => p.name);
  assertEqual(names[0], 'INTRO', 'First phrase');
  assertEqual(names[1], 'UP', 'Second phrase');
  assertEqual(names[2], 'CHORUS', 'Third phrase');
  assertEqual(names[3], 'OUTRO', 'Fourth phrase');

  const spb = 60.0 / DAT_BPM;
  const expectedStarts = [0, 16 * spb, 32 * spb, 64 * spb];
  expectedStarts.forEach((start, i) => {
    assert(Math.abs(result.phrases[i].startTime - start) < 0.001, `Phrase ${i + 1} start time`);
  });
  assert(Math.abs(result.phrases[0].endTime - 16 * spb) < 0.001, 'Phrase 1 end time');
});

runTest('Real ANLZ .EXT', 'PWV7 three-band detail wins over PWV3', () => {
  const result = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM));

  assert(result.waveform !== undefined, 'Waveform present');
  assertEqual(result.waveform!.length, 900, 'Highest priority waveform kept');
  // PWV7 entries are stored mid, high, low.
  assert(result.waveform!.midEnergy[10] >= 0 && result.waveform!.midEnergy[10] <= 1, 'Mid band normalized');
});

runTest('Real ANLZ .EXT', 'Unmasked PSSI (pre-Rekordbox 6) parses identically', () => {
  const result = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM, { maskPssi: false }));

  assertEqual(result.pssiMasked, false, 'PSSI not reported as masked');
  assertEqual(result.phrases.length, 4, 'Phrase count');
  assertEqual(result.phrases[0].name, 'INTRO', 'Phrase label');
});

// ─── SUITE 3: Merge priority & source protection ────────────────────────────
runTest('Real ANLZ merge', 'ANLZ data takes priority but XML metadata is retained', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extraction = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  assertEqual(merged.title, track.title, 'XML title retained');
  assertEqual(merged.artist, track.artist, 'XML artist retained');
  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ beatgrid priority');
  assertEqual(merged.analysis!.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ waveform priority');
  assert(merged.cues.some((cue) => cue.comment === 'Einsatz A'), 'ANLZ cue comments merged');
});

runTest('Real ANLZ merge', 'PSSI phrases are clamped to the real track duration', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0); // 240s
  const extraction = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  assert(merged.phrases.every((phrase) => phrase.endTime <= track.duration), 'Phrases never exceed track');
  assertEqual(merged.phrases.length, 4, 'PSSI phrases applied');
  assertEqual(merged.databaseRecord!.filePath, 'C:\\Music\\Reference.wav', 'ANLZ path recorded');
});

runTest('Real ANLZ merge', 'Legacy fixture remains fully supported', () => {
  const legacy = parseAnlzBinary(generateSyntheticAnlzBuffer(DAT_BPM));
  assertEqual(legacy.cues.length, 4, 'Legacy memory cues');
  assertEqual(legacy.bpm, DAT_BPM, 'Legacy BPM');
  assert(legacy.tagsFound.includes('PWV5'), 'Legacy waveform tag');
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
