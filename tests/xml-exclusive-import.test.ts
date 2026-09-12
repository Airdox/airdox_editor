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

import { runTest, assert, same, report } from './helpers/microTest.mjs';

const DAT_BPM = 128.0;

// ─── SUITE 1: PQTZ beat nodes survive the merge ─────────────────────────────
runTest('PQTZ preservation', 'DAT beat nodes are adopted verbatim (time/bar/beat)', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extraction = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));
  assert(extraction.beatGrid !== undefined, 'Fixture carries a PQTZ beat grid');

  const merged = applyAnlzExtractionToTrack(track, extraction);
  const sourceBeats = extraction.beatGrid!.beats;
  const mergedBeats = merged.beatGrid.beats;

  same(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ grid origin');
  assert(mergedBeats.length >= sourceBeats.length, 'All ANLZ beats adopted');
  for (let i = 0; i < sourceBeats.length; i++) {
    same(mergedBeats[i].time, sourceBeats[i].time, `Beat ${i} time`);
    same(mergedBeats[i].barNumber, sourceBeats[i].barNumber, `Beat ${i} bar`);
    same(mergedBeats[i].beatInBar, sourceBeats[i].beatInBar, `Beat ${i} beat-in-bar`);
    same(mergedBeats[i].isBarStart, sourceBeats[i].isBarStart, `Beat ${i} bar start`);
  }
});

runTest('PQTZ preservation', 'A short source grid remains short and unmodified', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0); // 240s
  const extraction = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  const sourceBeats = extraction.beatGrid!.beats;
  const beats = merged.beatGrid.beats;
  same(beats.length, sourceBeats.length, 'No uniform tail appended');
  assert(beats[beats.length - 1].time < track.duration, 'Source coverage is reported honestly');
  for (let i = 0; i < beats.length; i++) {
    same(beats[i].time, sourceBeats[i].time, `Beat ${i} time`);
    same(beats[i].bpm, sourceBeats[i].bpm, `Beat ${i} tempo`);
  }
});

runTest('PQTZ preservation', 'EXT PQTZ (128 beats) adopted verbatim', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extraction = parseAnlzBinary(generateRealAnlzExtFixture(DAT_BPM));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  const sourceBeats = extraction.beatGrid!.beats;
  same(sourceBeats.length, 128, 'Fixture beat count');
  for (let i = 0; i < sourceBeats.length; i++) {
    same(merged.beatGrid.beats[i].time, sourceBeats[i].time, `Beat ${i} time`);
  }
  same(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ grid origin');
});

// ─── SUITE 2: Legacy / partial extractions ──────────────────────────────────
runTest('Partial ANLZ', 'Legacy bpm-only extraction keeps the XML grid (no rebuild)', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extraction = parseAnlzBinary(generateSyntheticAnlzBuffer(DAT_BPM));
  same(extraction.beatGrid, undefined, 'Legacy layout carries no beat nodes');

  const merged = applyAnlzExtractionToTrack(track, extraction);
  same(merged.beatGrid.origin, DataOrigin.REKORDBOX_XML, 'XML grid retained');
  same(merged.beatGrid.bpm, track.bpm, 'XML bpm retained');
  same(merged.beatGrid.beats.length, 0, 'No beats invented from legacy scalars');
  same(track.beatGrid.beats.length, 0, 'XML TEMPO remains scalar metadata');
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

  same(merged.analysis, null, 'No waveform invented');
  same(merged.beatGrid.origin, DataOrigin.REKORDBOX_XML, 'XML grid untouched');
  same(merged.beatGrid.firstBeat, track.beatGrid.firstBeat, 'First beat untouched');
  same(merged.cues.length, xmlCueCount, 'XML cues untouched');
  same(merged.title, track.title, 'XML title retained');
  same(merged.artist, track.artist, 'XML artist retained');
});

runTest('No synthesis', 'ANLZ waveform + cues take priority without touching metadata', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  track.analysis = null;
  const extraction = parseAnlzBinary(generateRealAnlzDatFixture(DAT_BPM));
  const merged = applyAnlzExtractionToTrack(track, extraction);

  assert(merged.analysis !== null, 'ANLZ waveform adopted');
  same(merged.analysis!.origin, DataOrigin.REKORDBOX_ANLZ, 'Waveform origin');
  assert(merged.cues.every((cue) => cue.origin === DataOrigin.REKORDBOX_ANLZ), 'ANLZ cues adopted');
  same(merged.title, track.title, 'XML title retained');
  same(merged.originalMedia, track.originalMedia, 'Original-media reference retained');
});

// ─── Cue-parser guard (robust parser must not over-detect) ─────────────────
const FOREIGN_EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.2" Company="AlphaTheta" />
  <COLLECTION Entries="1">
    <TRACK TrackID="901" Name="Foreign Export" Artist="X" Album="Y" TotalTime="120.0"
           AverageBpm="120.00" Tonality="1A" BitRate="320" Year="2024" Rating="100" PlayCount="1">
      <TEMPO Inizio="0.000" Bpm="120.00" Metro="4/4" Battito="1" />
      <POSITION_MARK Name="Real Memory Cue" Type="0" Start="10.000" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Junk Without Position" Type="0" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Junk Loop Without Start" Type="4" Num="-1" />
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;

runTest('Cue guard', 'POSITION_MARK without a position attribute is ignored', () => {
  const { track } = extractTrackFromRekordboxXml(FOREIGN_EXPORT_XML, 0);
  same(track.cues.length, 1, 'only the mark with Start becomes a cue');
  same(track.loops.length, 0, 'loop mark without Start ignored');
  same(track.cues[0]?.name, 'Real Memory Cue', 'surviving cue is the genuine one');
  same(track.cues[0]?.position, 10.0, 'position taken verbatim');
});

const FOREIGN_EXPORT_ALT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.2" Company="AlphaTheta" />
  <COLLECTION Entries="1">
    <TRACK TrackID="902" Name="Alt Tag Export" Artist="X" Album="Y" TotalTime="120.0"
           AverageBpm="120.00" Tonality="1A" BitRate="320" Year="2024" Rating="100" PlayCount="1">
      <TEMPO Inizio="0.000" Bpm="120.00" Metro="4/4" Battito="1" />
      <CUE Name="Alt Position Cue" Position="20.500" Number="0" />
      <CUE Name="Alt Junk" Comment="no position at all" />
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;

runTest('Cue guard', 'Alt-tag exporters: Position attribute counts, junk is skipped', () => {
  const { track } = extractTrackFromRekordboxXml(FOREIGN_EXPORT_ALT_XML, 0);
  same(track.cues.length, 1, 'only the alt-tag mark with Position becomes a cue');
  same(track.cues[0]?.name, 'Alt Position Cue', 'surviving cue is the genuine one');
  same(track.cues[0]?.position, 20.5, 'Position attribute adopted');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────

report('XML-EXCLUSIVE WORKFLOW GUARANTEE TEST SUITE');
