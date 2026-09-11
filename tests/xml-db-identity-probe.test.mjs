/**
 * @license
 * Tests für die XML↔master.db-Identitätsprobe (scripts/xml-db-identity-probe.mjs):
 * das Verfahren aus REKORDBOX_PIPELINE_ARCHITECTURE.md §5.1, das auf der
 * echten Installation den Rekordbox-eigenen Export-Zusammenhang
 * XML-TrackID == djmdContent.ID empirisch bestätigt oder widerlegt.
 *
 * Run with: node tests/xml-db-identity-probe.test.mjs
 */

import assert from 'node:assert';
import {
  extractXmlTracks,
  classifyIdentity,
  summarize,
  normalizeAudioKey,
} from '../scripts/xml-db-identity-probe.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[ PASS ] ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`[ FAIL ] ${name}: ${e.message}`);
  }
}

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.16" Company="AlphaTheta" />
  <COLLECTION Entries="3">
    <TRACK TrackID="101" Name="Exact" Location="file://localhost/D:/Music/Exact%20Track.wav" AverageBpm="128.00" />
    <TRACK TrackID="202" Name="Moved" Location="file://localhost/D:/Music/Old%20Place.wav" AverageBpm="125.00" />
    <TRACK TrackID="303" Name="Foreign" Location="file://localhost/D:/Music/Foreign.wav" AverageBpm="174.00" />
    <TRACK TrackID="404" Name="NoLoc" AverageBpm="120.00" />
  </COLLECTION>
</DJ_PLAYLISTS>`;

test('extractXmlTracks liest TrackID + Location aus der COLLECTION', () => {
  const tracks = extractXmlTracks(XML);
  assert.equal(tracks.length, 4);
  assert.equal(tracks[0].trackId, '101');
  assert.equal(tracks[0].location, 'file://localhost/D:/Music/Exact%20Track.wav');
  assert.equal(tracks[3].location, '');
});

const DB_DIR = 'D:\\PIONEER\\Master';
const ROWS = [
  { ID: 101, FolderPath: 'D:\\Music\\Exact Track.wav', FileNameL: 'Exact Track.wav', AnalysisDataPath: '/PIONEER/USBANLZ/a/u1/ANLZ0000.DAT' },
  { ID: 202, FolderPath: 'D:\\Music\\New Place.wav', FileNameL: 'New Place.wav', AnalysisDataPath: '/PIONEER/USBANLZ/b/u2/ANLZ0000.DAT' },
  // 303 fehlt bewusst.
];

test('ID_MATCH: gleiche ID + exakter kanonischer Pfad → Rekordbox-Zuordnung bestätigt', () => {
  const res = classifyIdentity(extractXmlTracks(XML), ROWS, DB_DIR);
  const r = res.find((x) => x.trackId === '101');
  assert.equal(r.verdict, 'ID_MATCH');
  assert.equal(r.analysisDataPath, '/PIONEER/USBANLZ/a/u1/ANLZ0000.DAT');
});

test('ID_PATH_CONFLICT: ID existiert, aber der Dateipfad weicht ab', () => {
  const res = classifyIdentity(extractXmlTracks(XML), ROWS, DB_DIR);
  const r = res.find((x) => x.trackId === '202');
  assert.equal(r.verdict, 'ID_PATH_CONFLICT');
});

test('ID_MISSING: TrackID ohne djmdContent-Zeile', () => {
  const res = classifyIdentity(extractXmlTracks(XML), ROWS, DB_DIR);
  const r = res.find((x) => x.trackId === '303');
  assert.equal(r.verdict, 'ID_MISSING');
});

test('NO_LOCATION wird nicht bewertet', () => {
  const res = classifyIdentity(extractXmlTracks(XML), ROWS, DB_DIR);
  const r = res.find((x) => x.trackId === '404');
  assert.equal(r.verdict, 'NO_LOCATION');
});

test('ID_DUPLICATE: mehrfache djmdContent.ID ist ein Schemafehler, kein Kandidat', () => {
  const dup = [
    ...ROWS,
    { ID: 101, FolderPath: 'D:\\Music\\Other.wav', FileNameL: 'Other.wav', AnalysisDataPath: '/PIONEER/USBANLZ/c/u3/ANLZ0000.DAT' },
  ];
  const res = classifyIdentity(extractXmlTracks(XML), dup, DB_DIR);
  const r = res.find((x) => x.trackId === '101');
  assert.equal(r.verdict, 'ID_DUPLICATE');
});

test('contents_-Relativform (§5.2) zählt als exakt dieselbe Adresse', () => {
  const xml = `<COLLECTION Entries="1">
    <TRACK TrackID="7" Name="Rel" Location="file://localhost//contents_413/artist/track.mp3" />
  </COLLECTION>`;
  const rows = [{ ID: 7, FolderPath: 'D:\\PIONEER\\Master\\contents_413\\artist\\track.mp3', FileNameL: 'track.mp3', AnalysisDataPath: '/PIONEER/USBANLZ/d/u4/ANLZ0000.DAT' }];
  const res = classifyIdentity(extractXmlTracks(xml), rows, DB_DIR);
  assert.equal(res[0].verdict, 'ID_MATCH');
});

test('summarize: PASS nur bei 100 % ID_MATCH der bewertbaren Spuren', () => {
  const all = classifyIdentity(extractXmlTracks(XML), ROWS, DB_DIR);
  const s = summarize(all);
  assert.equal(s.pass, false);
  const onlyGood = classifyIdentity(
    extractXmlTracks(`<COLLECTION><TRACK TrackID="101" Name="Exact" Location="file://localhost/D:/Music/Exact%20Track.wav" /></COLLECTION>`),
    ROWS,
    DB_DIR
  );
  assert.equal(summarize(onlyGood).pass, true);
});

test('normalizeAudioKey identisch zur App-Kanonisierung (file://, %20, \\\\?\\, Case)', () => {
  assert.equal(
    normalizeAudioKey('file://localhost/D:/Music/Exact%20Track.wav'),
    normalizeAudioKey('\\\\?\\D:\\MUSIC\\Exact Track.WAV')
  );
});

console.log(`\nXML↔DB-Identitätsprobe: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('XML<->DB identity probe: OK');
