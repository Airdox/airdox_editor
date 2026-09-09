/**
 * @license
 * ANLZ sibling-co-load & extraction-merge tests.
 *
 * Rekordbox splits every analysis across two files in the same folder:
 * ANLZnnnn.DAT (source path, PQTZ beat grid, PCOB cue lists, preview
 * waveforms) and ANLZnnnn.EXT (full-resolution color waveform PWV5, PSSI
 * phrase structure, PCO2 extended cues). Without the EXT the deck can only
 * render the low-res preview — visibly "not Rekordbox". These tests cover:
 *
 *  - deriveSiblingExtension: deterministic DAT↔EXT sibling derivation
 *    (same folder, same basename, extension swap only — never a search).
 *  - mergeAnlzExtractions: variant union with priority, DAT-grid authority,
 *    EXT cue/phrase priority with primary fallback, tag/warning union.
 *  - Track integration: the merged extraction lands on the track with all
 *    genuine variants and the ANLZ origin preserved.
 *
 * Run with: npx tsx tests/anlz-ext-merge.test.ts
 */

import {
  deriveSiblingExtension,
} from '../src/rekordbox/analysisResolver';
import {
  applyAnlzExtractionToTrack,
  extractTrackFromRekordboxXml,
  mergeAnlzExtractions,
  parseAnlzBinary,
} from '../src/rekordbox/databaseExtractor';
import {
  generateRealAnlzDatFixture,
  generateRealAnlzExtFixture,
  SCENARIO_TECHNO_XML,
} from '../src/rekordbox/testDatasets';
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
console.log('  ANLZ SIBLING CO-LOAD & EXTRACTION MERGE TEST SUITE            ');
console.log('═══════════════════════════════════════════════════════════════════\n');

const WIN_ANLZ =
  'C:\\Users\\dj\\AppData\\Roaming\\Pioneer\\rekordbox7\\share\\PIONEER\\USBANLZ\\P016\\0000875E\\ANLZ0000.DAT';
const POSIX_ANLZ = '/media/usb/PIONEER/USBANLZ/P016/0000875E/ANLZ0000.DAT';

// ─── SUITE 1: sibling derivation ────────────────────────────────────────────
runTest('sibling', 'Windows DAT path resolves its EXT sibling verbatim', () => {
  assertEqual(
    deriveSiblingExtension(WIN_ANLZ, 'EXT'),
    WIN_ANLZ.replace(/\.DAT$/, '.EXT'),
    'Windows EXT sibling'
  );
});

runTest('sibling', 'POSIX DAT path resolves its EXT sibling verbatim', () => {
  assertEqual(
    deriveSiblingExtension(POSIX_ANLZ, 'EXT'),
    POSIX_ANLZ.replace(/\.DAT$/, '.EXT'),
    'POSIX EXT sibling'
  );
});

runTest('sibling', 'Already-target extension yields null (case-insensitive)', () => {
  assertEqual(deriveSiblingExtension(WIN_ANLZ.replace(/\.DAT$/, '.EXT'), 'EXT'), null, 'EXT → EXT');
  assertEqual(deriveSiblingExtension(WIN_ANLZ.replace(/\.DAT$/, '.ext'), 'EXT'), null, 'ext → EXT');
  assertEqual(deriveSiblingExtension(WIN_ANLZ, 'dat'), null, 'DAT → dat');
});

runTest('sibling', 'EXT path derives its DAT sibling (reverse direction)', () => {
  assertEqual(
    deriveSiblingExtension(WIN_ANLZ.replace(/\.DAT$/, '.EXT'), 'DAT'),
    WIN_ANLZ,
    'DAT sibling'
  );
});

runTest('sibling', 'Paths without a replaceable extension yield null', () => {
  assertEqual(deriveSiblingExtension('/media/usb/ANLZ0000', 'EXT'), null, 'No extension');
  assertEqual(deriveSiblingExtension('', 'EXT'), null, 'Empty path');
  assertEqual(deriveSiblingExtension(WIN_ANLZ, ''), null, 'Empty target');
});

// ─── SUITE 2: merge rules ───────────────────────────────────────────────────
runTest('merge', 'DAT+EXT merge unions all genuine variants, best wins', () => {
  const dat = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  const ext = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  const merged = mergeAnlzExtractions(dat, ext);

  assertEqual(merged.waveformVariants.length, 3, 'PWV5 + PWV3 + PWV7 kept');
  assertEqual(merged.waveformVariants[0].sourceTag, 'PWV5', 'DAT variant first');
  assertEqual(merged.waveformVariants[1].sourceTag, 'PWV3', 'EXT preview kept');
  assertEqual(merged.waveformVariants[2].sourceTag, 'PWV7', 'EXT band variant kept');
  assertEqual(merged.waveform!.sourceTag, 'PWV7', 'Highest priority becomes waveform');
  assert(merged.waveform === ext.waveform, 'Best variant adopted by reference');
});

runTest('merge', 'DAT beat grid stays authoritative (PQTZ lives in the DAT)', () => {
  const dat = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  const ext = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  const merged = mergeAnlzExtractions(dat, ext);

  assert(merged.beatGrid === dat.beatGrid, 'Primary grid adopted by reference');
  assertEqual(merged.beatGrid!.beats.length, 32, 'DAT grid beats (not EXT beats)');
  assertEqual(merged.bpm, dat.bpm, 'bpm follows the winning grid');
  assertEqual(merged.firstBeat, dat.firstBeat, 'first beat follows the winning grid');
});

runTest('merge', 'EXT cues/phrases take priority, DAT loops survive', () => {
  const dat = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  const ext = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  assert(ext.cues.length > 0, 'EXT fixture carries PCO2 cues');
  assert(ext.loops.length === 0, 'EXT fixture carries no loops');

  const merged = mergeAnlzExtractions(dat, ext);
  assert(merged.cues === ext.cues, 'PCO2 (colored) cue list wins');
  assert(merged.phrases === ext.phrases, 'PSSI phrase list wins');
  assert(merged.loops === dat.loops, 'Empty EXT loop list falls back to DAT loops');
  assertEqual(merged.phrases.length, 4, 'Four PSSI phrases');
  assertEqual(merged.pssiBank, 3, 'PSSI bank propagates');
});

runTest('merge', 'Tags and warnings union, PPTH path from primary', () => {
  const dat = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  const ext = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  const merged = mergeAnlzExtractions(dat, ext);

  for (const tag of ['PPTH', 'PQTZ', 'PCOB', 'PWV5', 'PCO2', 'PWV3', 'PWV7', 'PSSI']) {
    assert(merged.tagsFound.includes(tag), `Tag ${tag} present`);
  }
  assertEqual(
    merged.tagsFound.length,
    new Set(merged.tagsFound).size,
    'Tags unioned without duplicates'
  );
  const datIdx = merged.tagsFound.indexOf('PWV5');
  const extIdx = merged.tagsFound.indexOf('PWV7');
  assert(datIdx < extIdx, 'Primary tags listed before secondary tags');
  assertEqual(merged.analysisPath, dat.analysisPath, 'PPTH path from primary');
  assertEqual(
    merged.warnings.length,
    dat.warnings.length + ext.warnings.length,
    'Warnings concatenated'
  );
});

runTest('merge', 'Empty sibling changes nothing (gracious fallback)', () => {
  const dat = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  const empty = parseAnlzBinary(new ArrayBuffer(0));
  const merged = mergeAnlzExtractions(dat, empty);

  assert(merged.waveform === dat.waveform, 'Waveform kept');
  assert(merged.cues === dat.cues, 'Cues kept');
  assert(merged.loops === dat.loops, 'Loops kept');
  assert(merged.phrases === dat.phrases, 'Phrases kept');
  assert(merged.beatGrid === dat.beatGrid, 'Grid kept');
  assertEqual(merged.waveformVariants.length, 1, 'Variant list unchanged');
});

runTest('merge', 'Empty primary fully adopts the secondary', () => {
  const ext = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  const empty = parseAnlzBinary(new ArrayBuffer(0));
  const merged = mergeAnlzExtractions(empty, ext);

  assert(merged.waveform === ext.waveform, 'EXT waveform adopted');
  assert(merged.cues === ext.cues, 'EXT cues adopted');
  assert(merged.phrases === ext.phrases, 'EXT phrases adopted');
  assert(merged.beatGrid === ext.beatGrid, 'EXT grid adopted when primary has none');
  assertEqual(merged.waveformVariants.length, 2, 'Both EXT variants adopted');
});

// ─── SUITE 3: track integration ─────────────────────────────────────────────
runTest('track', 'Merged DAT+EXT extraction lands on the XML track intact', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const dat = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  const ext = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  const merged = applyAnlzExtractionToTrack(track, mergeAnlzExtractions(dat, ext));

  assertEqual(merged.analysisVariants!.length, 3, 'All variants on the track');
  assertEqual(merged.analysis!.sourceTag, 'PWV7', 'Best variant as track analysis');
  assertEqual(merged.analysis!.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ origin kept');
  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ grid adopted');
  assertEqual(merged.phrases!.length, 4, 'PSSI phrases on the track');
  assertEqual(merged.title, track.title, 'XML metadata untouched');
  assert(
    merged.cues.some((c) => JSON.stringify(c).includes('Drop')),
    'PCO2 cue comment survives onto the track'
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
