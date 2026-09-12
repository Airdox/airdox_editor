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
import { loadAnlzContainerSet } from '../src/rekordbox/analysisContainerLoader';
import {
  applyAnlzExtractionToTrack,
  extractTrackFromRekordboxXml,
  mergeAnlzExtractions,
  parseAnlzBinary,
} from '../src/rekordbox/databaseExtractor';
import {
  generateRealAnlzDatFixture,
  generateRealAnlzExtFixture,
  generateRealAnlz2ExFixture,
  SCENARIO_TECHNO_XML,
} from './fixtures/testDatasets';
import { DataOrigin } from '../src/types/rekordbox';

import { runTest, assert, same, report } from './helpers/microTest.mjs';

const WIN_ANLZ =
  'C:\\Users\\dj\\AppData\\Roaming\\Pioneer\\rekordbox7\\share\\PIONEER\\USBANLZ\\P016\\0000875E\\ANLZ0000.DAT';
const POSIX_ANLZ = '/media/usb/PIONEER/USBANLZ/P016/0000875E/ANLZ0000.DAT';

// ─── SUITE 1: sibling derivation ────────────────────────────────────────────
runTest('sibling', 'Windows DAT path resolves its EXT sibling verbatim', () => {
  same(
    deriveSiblingExtension(WIN_ANLZ, 'EXT'),
    WIN_ANLZ.replace(/\.DAT$/, '.EXT'),
    'Windows EXT sibling'
  );
});

runTest('sibling', 'POSIX DAT path resolves its EXT sibling verbatim', () => {
  same(
    deriveSiblingExtension(POSIX_ANLZ, 'EXT'),
    POSIX_ANLZ.replace(/\.DAT$/, '.EXT'),
    'POSIX EXT sibling'
  );
});

runTest('sibling', 'DAT path resolves its deterministic 2EX sibling', () => {
  same(
    deriveSiblingExtension('D:\\PIONEER\\USBANLZ\\P001\\0001\\ANLZ0000.DAT', '2EX'),
    'D:\\PIONEER\\USBANLZ\\P001\\0001\\ANLZ0000.2EX',
    'Same directory and basename'
  );
});

runTest('sibling', 'Already-target extension yields null (case-insensitive)', () => {
  same(deriveSiblingExtension(WIN_ANLZ.replace(/\.DAT$/, '.EXT'), 'EXT'), null, 'EXT → EXT');
  same(deriveSiblingExtension(WIN_ANLZ.replace(/\.DAT$/, '.ext'), 'EXT'), null, 'ext → EXT');
  same(deriveSiblingExtension(WIN_ANLZ, 'dat'), null, 'DAT → dat');
});

runTest('sibling', 'EXT path derives its DAT sibling (reverse direction)', () => {
  same(
    deriveSiblingExtension(WIN_ANLZ.replace(/\.DAT$/, '.EXT'), 'DAT'),
    WIN_ANLZ,
    'DAT sibling'
  );
});

runTest('sibling', 'Paths without a replaceable extension yield null', () => {
  same(deriveSiblingExtension('/media/usb/ANLZ0000', 'EXT'), null, 'No extension');
  same(deriveSiblingExtension('', 'EXT'), null, 'Empty path');
  same(deriveSiblingExtension(WIN_ANLZ, ''), null, 'Empty target');
});

// ─── SUITE 2: merge rules ───────────────────────────────────────────────────
runTest('merge', 'DAT+EXT merge unions all genuine variants, best wins', () => {
  const dat = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  const ext = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  const merged = mergeAnlzExtractions(dat, ext);

  same(merged.waveformVariants.length, 3, 'PWV5 + PWV3 + PWV7 kept');
  same(merged.waveformVariants[0].sourceTag, 'PWV5', 'DAT variant first');
  same(merged.waveformVariants[1].sourceTag, 'PWV3', 'EXT preview kept');
  same(merged.waveformVariants[2].sourceTag, 'PWV7', 'EXT band variant kept');
  same(merged.waveform!.sourceTag, 'PWV7', 'Highest priority becomes waveform');
  assert(merged.waveform === ext.waveform, 'Best variant adopted by reference');
});

runTest('merge', 'DAT beat grid stays authoritative (PQTZ lives in the DAT)', () => {
  const dat = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  const ext = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  const merged = mergeAnlzExtractions(dat, ext);

  assert(merged.beatGrid === dat.beatGrid, 'Primary grid adopted by reference');
  same(merged.beatGrid!.beats.length, 32, 'DAT grid beats (not EXT beats)');
  same(merged.bpm, dat.bpm, 'bpm follows the winning grid');
  same(merged.firstBeat, dat.firstBeat, 'first beat follows the winning grid');
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
  same(merged.phrases.length, 4, 'Four PSSI phrases');
  same(merged.pssiBank, 3, 'PSSI bank propagates');
});

runTest('merge', 'Tags and warnings union, PPTH path from primary', () => {
  const dat = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  const ext = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  const merged = mergeAnlzExtractions(dat, ext);

  for (const tag of ['PPTH', 'PQTZ', 'PCOB', 'PWV5', 'PCO2', 'PWV3', 'PWV7', 'PSSI']) {
    assert(merged.tagsFound.includes(tag), `Tag ${tag} present`);
  }
  same(
    merged.tagsFound.length,
    new Set(merged.tagsFound).size,
    'Tags unioned without duplicates'
  );
  const datIdx = merged.tagsFound.indexOf('PWV5');
  const extIdx = merged.tagsFound.indexOf('PWV7');
  assert(datIdx < extIdx, 'Primary tags listed before secondary tags');
  same(merged.analysisPath, dat.analysisPath, 'PPTH path from primary');
  same(
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
  same(merged.waveformVariants.length, 1, 'Variant list unchanged');
});

runTest('merge', 'Empty primary fully adopts the secondary', () => {
  const ext = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  const empty = parseAnlzBinary(new ArrayBuffer(0));
  const merged = mergeAnlzExtractions(empty, ext);

  assert(merged.waveform === ext.waveform, 'EXT waveform adopted');
  assert(merged.cues === ext.cues, 'EXT cues adopted');
  assert(merged.phrases === ext.phrases, 'EXT phrases adopted');
  assert(merged.beatGrid === ext.beatGrid, 'EXT grid adopted when primary has none');
  same(merged.waveformVariants.length, 2, 'Both EXT variants adopted');
});

// ─── SUITE 3: track integration ─────────────────────────────────────────────
runTest('track', 'Merged DAT+EXT extraction lands on the XML track intact', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const dat = parseAnlzBinary(generateRealAnlzDatFixture(128.0));
  const ext = parseAnlzBinary(generateRealAnlzExtFixture(128.0));
  const merged = applyAnlzExtractionToTrack(track, mergeAnlzExtractions(dat, ext));

  same(merged.analysisVariants!.length, 3, 'All variants on the track');
  same(merged.analysis!.sourceTag, 'PWV7', 'Best variant as track analysis');
  same(merged.analysis!.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ origin kept');
  same(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ grid adopted');
  same(merged.phrases!.length, 4, 'PSSI phrases on the track');
  same(merged.title, track.title, 'XML metadata untouched');
  assert(
    merged.cues.some((c) => JSON.stringify(c).includes('Drop')),
    'PCO2 cue comment survives onto the track'
  );
});

// ─── SUITE 4: deterministic DAT/EXT/2EX loader integration ─────────────────
runTest('loader', 'DB-addressed DAT loads only exact EXT/2EX siblings and merges all three', async () => {
  const datPath = 'C:\\rekordbox7\\share\\PIONEER\\USBANLZ\\P016\\0000875E\\ANLZ0000.DAT';
  const extPath = datPath.replace(/\.DAT$/, '.EXT');
  const twoExPath = datPath.replace(/\.DAT$/, '.2EX');
  const files = new Map<string, ArrayBuffer>([
    [datPath, generateRealAnlzDatFixture(128.0)],
    [extPath, generateRealAnlzExtFixture(128.0)],
    [twoExPath, generateRealAnlz2ExFixture()],
  ]);
  const reads: string[] = [];

  const loaded = await loadAnlzContainerSet(datPath, async (path) => {
    reads.push(path);
    const data = files.get(path);
    if (!data) throw new Error(`ENOENT: ${path}`);
    return { data, size: data.byteLength };
  });

  same(reads.join('|'), [datPath, extPath, twoExPath].join('|'), 'No guessed or searched paths');
  same(loaded.primary.path, datPath, 'DB-addressed DAT remains primary');
  same(loaded.datExtSibling?.path, extPath, 'Exact same-directory EXT loaded');
  same(loaded.twoExSibling?.path, twoExPath, 'Exact same-directory 2EX loaded');
  same(loaded.extraction.beatGrid?.beats.length, 32, 'DAT PQTZ nodes remain authoritative');
  same(loaded.extraction.phrases.length, 4, 'EXT PSSI reaches merged extraction');
  same(loaded.twoExSibling?.extraction.waveform?.sourceTag, 'PWV7', '2EX PWV7 decoded');
  same(loaded.twoExSibling?.extraction.waveform?.length, 240, '2EX values preserved');
  same(loaded.extraction.waveformVariants.length, 4, 'DAT, EXT, and 2EX variants transported');
});

runTest('loader', 'Missing optional 2EX preserves DAT/EXT data without alternatives', async () => {
  const datPath = '/rekordbox7/share/PIONEER/USBANLZ/P016/0000875E/ANLZ0000.DAT';
  const extPath = datPath.replace(/\.DAT$/, '.EXT');
  const twoExPath = datPath.replace(/\.DAT$/, '.2EX');
  const reads: string[] = [];
  const loaded = await loadAnlzContainerSet(datPath, async (path) => {
    reads.push(path);
    if (path === datPath) return { data: generateRealAnlzDatFixture(128.0) };
    if (path === extPath) return { data: generateRealAnlzExtFixture(128.0) };
    throw new Error('ENOENT');
  });

  same(reads.join('|'), [datPath, extPath, twoExPath].join('|'), 'Only deterministic paths attempted');
  same(loaded.twoExSibling, undefined, 'No invented 2EX extraction');
  assert(loaded.twoExError === 'ENOENT', 'Optional absence is transparent');
  same(loaded.extraction.waveformVariants.length, 3, 'DAT/EXT Rekordbox variants unchanged');
  same(loaded.extraction.beatGrid?.beats.length, 32, 'PQTZ unchanged');
});

report('ANLZ-EXT-MERGE SUITE');
