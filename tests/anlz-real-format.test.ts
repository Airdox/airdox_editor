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

import { runTest, assert, same, report } from './helpers/microTest.mjs';

const DAT_BPM = 128.0;
const DAT_SPB_MS = Math.round(60000 / DAT_BPM);

// ─── SUITE 1: .DAT (real PMAI/PPTH/PQTZ/PCOB-PCPT/PWV5) ─────────────────────
runTest('Real ANLZ .DAT', 'Reads PPTH source path, PQTZ beatgrid and tags', () => {
  const result = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));

  assert(result.tagsFound.includes('PPTH'), 'PPTH tag found');
  assert(result.tagsFound.includes('PQTZ'), 'PQTZ tag found');
  assert(result.tagsFound.includes('PCOB'), 'PCOB tag found');
  assert(result.tagsFound.includes('PWV5'), 'PWV5 tag found');
  same(result.analysisPath, 'C:\\Music\\Reference.wav', 'PPTH path');
  same(result.bpm, DAT_BPM, 'BPM from PQTZ');
  same(result.firstBeat, 0, 'First beat offset');
  assert(result.beatGrid !== undefined, 'Beat grid parsed');
  assert(result.beatGrid!.beats.length >= 32, 'Beat entries decoded');
});

runTest('Real ANLZ .DAT', 'Decodes classic PCPT memory cues and loops', () => {
  const result = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));

  const memories = result.cues.filter((cue) => cue.type === 'MEMORY');
  const loops = result.loops;
  same(memories.length, 3, 'Memory cue count (4th PCPT entry is a loop)');
  same(Math.round(memories[0].position * 1000), 0, 'Memory cue 1 position');
  same(Math.round(memories[1].position * 1000), 8 * DAT_SPB_MS, 'Memory cue 2 position');
  same(Math.round(memories[2].position * 1000), 16 * DAT_SPB_MS, 'Memory cue 3 position');
  same(loops.length, 1, 'Loop count');
  same(Math.round(loops[0].start * 1000), 4 * DAT_SPB_MS, 'Loop start');
  same(Math.round(loops[0].end * 1000), 12 * DAT_SPB_MS, 'Loop end');
});

runTest('Real ANLZ .DAT', 'Decodes hot cues from the second PCOB (type=1)', () => {
  const result = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));

  const hot = result.cues.filter((cue) => cue.type === 'HOT_CUE');
  same(hot.length, 1, 'Hot cue count');
  same(hot[0].letter, 'A', 'Hot cue letter');
  same(Math.round(hot[0].position * 1000), 16 * DAT_SPB_MS, 'Hot cue position');
  same(hot[0].origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ origin');
});

runTest('Real ANLZ .DAT', 'Decodes 2-byte RGB + height PWV5 waveform entries', () => {
  const result = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));

  assert(result.waveform !== undefined, 'Waveform present');
  same(result.waveform!.length, 600, 'Waveform bucket count');
  same(result.waveform!.origin, DataOrigin.REKORDBOX_ANLZ, 'Waveform origin');
  const peak = result.waveform!.peaks[100];
  assert(peak >= 0 && peak <= 1, `Peak normalized [0..1], got ${peak}`);
});

// ─── SUITE 2: .EXT (PCO2-PCP2, PWV3/PWV7, masked PSSI) ──────────────────────
runTest('Real ANLZ .EXT', 'PCO2 extended hot cues carry comments and colors', () => {
  const result = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM));

  const hot = result.cues.filter((cue) => cue.type === 'HOT_CUE');
  same(hot.length, 3, 'Hot cue count');
  same(hot[0].letter, 'A', 'Hot A');
  same(hot[0].comment, 'Einsatz A', 'Hot A comment');
  same(hot[1].comment, 'Drop', 'Hot B comment');
  same(hot[2].comment, undefined, 'Hot C has no comment');
  same(hot[0].color, 'rgb(0, 162, 255)', 'Hot A color');
});

runTest('Real ANLZ .EXT', 'PCO2 memory cues override the classic PCOB list', () => {
  const result = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM));

  const memories = result.cues.filter((cue) => cue.type === 'MEMORY');
  same(memories.length, 1, 'Only the PCO2 memory entry remains');
  same(memories[0].comment, 'Breakdown Memory', 'PCO2 comment used');
});

runTest('Real ANLZ .EXT', 'Decodes masked Rekordbox 6 PSSI song structure', () => {
  const result = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM, { maskPssi: true }));

  same(result.pssiMasked, true, 'PSSI masked detection');
  same(result.pssiMood, 1, 'PSSI mood (high)');
  same(result.pssiEndBeat, 65, 'PSSI end beat');
  same(result.pssiBank, 3, 'PSSI bank');
  same(result.phrases.length, 4, 'PSSI phrase count');

  const names = result.phrases.map((p) => p.name);
  same(names[0], 'INTRO', 'First phrase');
  same(names[1], 'UP', 'Second phrase');
  same(names[2], 'CHORUS', 'Third phrase');
  same(names[3], 'OUTRO', 'Fourth phrase');

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
  same(result.waveform!.length, 900, 'Highest priority waveform kept');
  // PWV7 entries are stored mid, high, low.
  assert(result.waveform!.midEnergy[10] >= 0 && result.waveform!.midEnergy[10] <= 1, 'Mid band normalized');
});

runTest('Real ANLZ .EXT', 'Unmasked PSSI (pre-Rekordbox 6) parses identically', () => {
  const result = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM, { maskPssi: false }));

  same(result.pssiMasked, false, 'PSSI not reported as masked');
  same(result.phrases.length, 4, 'Phrase count');
  same(result.phrases[0].name, 'INTRO', 'Phrase label');
});

// ─── SUITE 3: Merge priority & source protection ────────────────────────────
runTest('Real ANLZ merge', 'ANLZ data takes priority but XML metadata is retained', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extraction = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  same(merged.title, track.title, 'XML title retained');
  same(merged.artist, track.artist, 'XML artist retained');
  same(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ beatgrid priority');
  same(merged.analysis!.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ waveform priority');
  assert(merged.cues.some((cue) => cue.comment === 'Einsatz A'), 'ANLZ cue comments merged');
});

runTest('Real ANLZ merge', 'PSSI phrases are clamped to the real track duration', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0); // 240s
  const extraction = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  assert(merged.phrases.every((phrase) => phrase.endTime <= track.duration), 'Phrases never exceed track');
  same(merged.phrases.length, 4, 'PSSI phrases applied');
  same(merged.databaseRecord!.filePath, 'C:\\Music\\Reference.wav', 'ANLZ path recorded');
});

runTest('Real ANLZ merge', 'Legacy fixture remains fully supported', () => {
  const legacy = parseAnlzBinary(generateSyntheticAnlzBuffer(DAT_BPM));
  same(legacy.cues.length, 4, 'Legacy memory cues');
  same(legacy.bpm, DAT_BPM, 'Legacy BPM');
  assert(legacy.tagsFound.includes('PWV5'), 'Legacy waveform tag');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────

report('REKORDBOX REAL ANLZ BINARY FORMAT REGRESSION SUITE');
