/**
 * @license
 * Vollständigkeits-Tests für den Extraktionspfad.
 *
 * 1) extractTrackFromRekordboxXml() muss die bibliografischen Metadaten des
 *    XML-Eintrags (Genre, Rating, Play Count, Jahr, Kommentar, Remixer,
 *    Read-Only-Referenz, Roh-Attribute) in das TrackModel übernehmen – vorher
 *    gingen sie beim Laden in ein Deck verloren.
 * 2) parseAnlzBinary() muss mehrere Cue-Sektionen derselben Quelle und
 *    Kategorie zusammenführen, statt die erste still zu verwerfen, und PCO2
 *    muss unabhängig von der Sektionsreihenfolge Vorrang vor PCOB haben.
 *
 * Run with: npx tsx tests/extraction-completeness.test.ts
 */

import { extractTrackFromRekordboxXml } from '../src/rekordbox/databaseExtractor';
import { parseAnlzBinary } from '../src/rekordbox/anlzParser';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function runTest(suite: string, name: string, testFn: () => void) {
  try {
    testFn();
    results.push({ suite, name, passed: true });
  } catch (err: any) {
    results.push({ suite, name, passed: false, error: err?.message || String(err) });
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: erwartet ${expected}, erhalten ${actual}`);
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  EXTRAKTIONS-VOLLSTÄNDIGKEIT (Metadaten + ANLZ-Cue-Sektionen)   ');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ─── Suite 1: Metadaten aus dem XML-Eintrag ─────────────────────────────────

const METADATA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.2" Company="AlphaTheta" />
  <COLLECTION Entries="1">
    <TRACK TrackID="777" Name="Metadata Carrier" Artist="Test Artist" Album="Test Album"
           Genre="Tech House" TotalTime="210.0" AverageBpm="125.00" Tonality="8A" BitRate="320"
           Comments="Kommentar mit Umlauten ÄÖÜ" Year="2024" Rating="204" PlayCount="42"
           Label="Subterranean" Remixer="Test Remixer" DateAdded="2026-09-06"
           Location="file://localhost/C%3A/Music/Metadata%20Carrier.wav">
      <TEMPO Inizio="0.240" Bpm="125.00" Metro="4/4" Battito="1" />
      <POSITION_MARK Name="Intro" Type="0" Start="0.240" Num="-1" Red="255" Green="34" Blue="34" />
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;

runTest('Metadaten-Extraktion', 'Rating, Play Count, Jahr und Kommentar bleiben erhalten', () => {
  const { track } = extractTrackFromRekordboxXml(METADATA_XML, 0);
  assertEqual(track.rating, 4, 'Rating 204 -> 4 Sterne');
  assertEqual(track.playCount, 42, 'Play Count');
  assertEqual(track.year, '2024', 'Jahr');
  assertEqual(track.comments, 'Kommentar mit Umlauten ÄÖÜ', 'Kommentar');
  assertEqual(track.remixer, 'Test Remixer', 'Remixer');
  assertEqual(track.dateAdded, '2026-09-06', 'DateAdded');
});

runTest('Metadaten-Extraktion', 'Genre und Roh-Attribute (inkl. Label) gehen nicht verloren', () => {
  const { track } = extractTrackFromRekordboxXml(METADATA_XML, 0);
  assertEqual(track.genre, 'Tech House', 'Genre');
  assertEqual(track.rawXmlAttributes?.Label, 'Subterranean', 'Label aus den Roh-Attributen');
  assertEqual(track.rawXmlAttributes?.BitRate, '320', 'BitRate aus den Roh-Attributen');
  assertEqual(track.rawXmlAttributes?.TrackID, '777', 'TrackID aus den Roh-Attributen');
});

runTest('Metadaten-Extraktion', 'Read-Only-Referenz auf das Original wird übernommen', () => {
  const { track } = extractTrackFromRekordboxXml(METADATA_XML, 0);
  assert(track.originalMedia !== undefined, 'originalMedia vorhanden');
  assertEqual(track.originalMedia!.accessMode, 'READ_ONLY', 'Zugriffsmodus');
  assert(track.originalMedia!.location.includes('Metadata%20Carrier.wav'), 'Location zeigt auf die Originaldatei');
  assertEqual(track.isOriginalUntouched, true, 'Original unverändert');
});

runTest('Metadaten-Extraktion', 'Cues und Beatgrid bleiben trotz Metadaten-Ergänzung korrekt', () => {
  const { track, record } = extractTrackFromRekordboxXml(METADATA_XML, 0);
  assertEqual(track.bpm, 125, 'BPM aus TEMPO');
  assertEqual(track.cues.length, 1, 'Memory Cue');
  assert(track.beatGrid.beats.length > 0, 'Beatgrid gefüllt');
  assertEqual(record.memoryCuesCount, 1, 'Datenbank-Record Memory Cues');
});

// ─── Suite 2: ANLZ-Cue-Sektionen ────────────────────────────────────────────

class W {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 0xff); return this; }
  u16(v: number) { this.bytes.push((v >> 8) & 0xff, v & 0xff); return this; }
  u32(v: number) { this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return this; }
  ascii(t: string) { for (const c of t) this.bytes.push(c.charCodeAt(0)); return this; }
  zeros(n: number) { for (let i = 0; i < n; i++) this.bytes.push(0); return this; }
  utf16(t: string) { for (const c of t) this.u16(c.charCodeAt(0)); this.u16(0); return this; }
  concat(v: number[]) { this.bytes.push(...v); return this; }
}

interface Tag { tag: string; lenHeader: number; body: number[] }

function tag(tagName: string, lenHeader: number, body: number[]): Tag {
  return { tag: tagName, lenHeader, body };
}

function pcpt(timeMs: number, hotCue: number, loopMs?: number): number[] {
  const w = new W();
  w.ascii('PCPT').u32(0x1c).u32(0x38).u32(hotCue).u32(0).u32(0x10000).u16(0xffff).u16(0xffff)
    .u8(loopMs !== undefined ? 2 : 1).u8(0).u8(0x03).u8(0xe8).u32(timeMs).u32(loopMs ?? 0).zeros(16);
  return w.bytes;
}

function pcp2(timeMs: number, hotCue: number, comment: string, loopMs?: number): number[] {
  const w = new W();
  const commentBytes = comment.length * 2 + 2;
  const lenEntry = 0x28 + 4 + commentBytes;
  w.ascii('PCP2').u32(0x0a).u32(lenEntry).u32(hotCue)
    .u8(loopMs !== undefined ? 2 : 1).u8(0).u8(0x03).u8(0xe8)
    .u32(timeMs).u32(loopMs ?? 0).u8(0).u8(0x01).zeros(6).u16(0).u16(0).u32(commentBytes).utf16(comment);
  return w.bytes;
}

function pcob(type: 0 | 1, entries: number[][]): Tag {
  const w = new W();
  w.u32(type).u16(0).u16(entries.length).u32(0);
  entries.forEach((e) => w.concat(e));
  return tag('PCOB', 0x18, w.bytes);
}

function pco2(type: 0 | 1, entries: number[][]): Tag {
  const w = new W();
  w.u32(type).u16(entries.length).u16(0);
  entries.forEach((e) => w.concat(e));
  return tag('PCO2', 0x0e, w.bytes);
}

function pqtz(bpm: number): Tag {
  const w = new W();
  const beats = Array.from({ length: 16 }, (_, i) => ({ bar: (i % 4) + 1, ms: Math.round((60000 / bpm) * i) }));
  w.u32(0).u32(0x80000).u32(beats.length);
  beats.forEach((b) => w.u16(b.bar).u16(Math.round(bpm * 100)).u32(b.ms));
  return tag('PQTZ', 0x18, w.bytes);
}

function assemble(tags: Tag[]): ArrayBuffer {
  const headerLen = 0x1c;
  const sectionsSize = tags.reduce((sum, t) => sum + 12 + t.body.length, 0);
  const w = new W();
  w.ascii('PMAI').u32(headerLen).u32(headerLen + sectionsSize).u32(1).u32(0x10000).u32(0x10000).u32(0);
  for (const t of tags) w.ascii(t.tag).u32(t.lenHeader).u32(12 + t.body.length).concat(t.body);
  return new Uint8Array(w.bytes).buffer;
}

runTest('ANLZ-Cue-Sektionen', 'Zwei PCO2-Memory-Sektionen werden zusammengeführt', () => {
  const parsed = parseAnlzBinary(
    assemble([
      pqtz(128),
      pco2(0, [pcp2(0, 0, 'Intro'), pcp2(8000, 0, 'Breakdown')]),
      pco2(0, [pcp2(16000, 0, 'Drop'), pcp2(24000, 0, 'Outro'), pcp2(32000, 0, 'Loop', 15000)]),
    ])
  );
  assertEqual(parsed.cues.filter((c) => c.type === 'MEMORY').length, 4, 'Memory Cues aus beiden Sektionen');
  assertEqual(parsed.loops.length, 1, 'Loop aus der zweiten Sektion');
  assertEqual(parsed.warnings.length, 0, 'keine Warnungen');
});

runTest('ANLZ-Cue-Sektionen', 'Zwei PCOB-Memory-Sektionen werden zusammengeführt', () => {
  const parsed = parseAnlzBinary(assemble([pqtz(128), pcob(0, [pcpt(0, 0), pcpt(8000, 0)]), pcob(0, [pcpt(16000, 0)])]));
  assertEqual(parsed.cues.filter((c) => c.type === 'MEMORY').length, 3, 'Memory Cues aus beiden Sektionen');
});

runTest('ANLZ-Cue-Sektionen', 'PCO2 gewinnt gegen PCOB – auch wenn PCOB später kommt', () => {
  const parsed = parseAnlzBinary(
    assemble([
      pqtz(128),
      pco2(0, [pcp2(0, 0, 'Erweitert A'), pcp2(8000, 0, 'Erweitert B')]),
      pcob(0, [pcpt(0, 0), pcpt(8000, 0), pcpt(16000, 0), pcpt(24000, 0)]),
    ])
  );
  assertEqual(parsed.cues.filter((c) => c.type === 'MEMORY').length, 2, 'PCO2-Einträge haben Vorrang');
  assert(parsed.cues.some((c) => c.comment === 'Erweitert A'), 'PCO2-Kommentar übernommen');
  assert(!parsed.cues.some((c) => c.inMsec === 16000), 'PCOB-Eintrag wurde nicht gemischt');
});

runTest('ANLZ-Cue-Sektionen', 'Hot Cues und Memory Cues bleiben getrennt', () => {
  const parsed = parseAnlzBinary(
    assemble([
      pqtz(128),
      pco2(0, [pcp2(0, 0, 'Memory')]),
      pco2(1, [pcp2(4000, 1, 'Hot A'), pcp2(8000, 2, 'Hot B')]),
      pcob(1, [pcpt(12000, 3)]),
    ])
  );
  assertEqual(parsed.cues.filter((c) => c.type === 'MEMORY').length, 1, 'Memory Cues');
  assertEqual(parsed.cues.filter((c) => c.type === 'HOT_CUE').length, 2, 'PCO2-Hot-Cues haben Vorrang');
});

// ─── Zusammenfassung ────────────────────────────────────────────────────────

let passedCount = 0;
let failedCount = 0;
results.forEach((r, idx) => {
  if (r.passed) {
    console.log(`\x1b[32m[ PASS ]\x1b[0m #${idx + 1} [${r.suite}] ${r.name}`);
    passedCount++;
  } else {
    console.log(`\x1b[31m[ FAIL ]\x1b[0m #${idx + 1} [${r.suite}] ${r.name}\n       Fehler: ${r.error}`);
    failedCount++;
  }
});

console.log(`\nTotal: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
process.exit(failedCount > 0 ? 1 : 0);
