/**
 * @license
 * Master-DB-Gate (Phase 5) – Zustandsmaschine des verbindlichen Track-Lade-Pfads.
 *
 * Der Gate ist Electron-frei und vollständig über injectbare Abhängigkeiten
 * testbar; hier wird jede Fehlerklasse der dokumentierten Kette
 *
 *   TrackID → master.db → djmdContent → AnalysisDataPath → ANLZ → Original-Audio
 *
 * einzeln erzwungen:
 *
 *   MASTER_DB_NOT_FOUND, SQLCIPHER_UNAVAILABLE, MASTER_DB_OPEN_FAILED,
 *   MASTER_DB_SCHEMA_INVALID, TRACK_NOT_FOUND_IN_MASTER_DB,
 *   ANLZ_NOT_FOUND, ANLZ_READ_FAILED, ANLZ_INVALID,
 *   REKORDBOX_WAVEFORM_MISSING, ORIGINAL_AUDIO_NOT_FOUND
 *
 * Zusätzlich wird geprüft, dass der Gate selbst ausschließlich lesend arbeitet
 * (keine Schreib-API im Modul) und dass die ANLZ-Sektionswalk exakt der
 * Parser-Logik aus src/rekordbox/anlzParser.ts entspricht.
 *
 * Run with: node tests/master-db-gate.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gateModule = require('../electron/masterDbGate.cjs');
const dbReaderModule = require('../electron/dbReader.cjs');
const {
  GATE_CODES,
  resolveTrackFromMasterDb,
  scanAnlzSections,
  toLocalPath,
} = gateModule;

// ─── Zustandsmaschine selbst prüfen ─────────────────────────────────────────
// Erweitert um ANLZ_WAVEFORM_UNREADABLE (Waveform-Sektion vorhanden, aber nicht
// dekodierbar) und ANLZ_SOURCE_MISMATCH (PPTH und gewählter Originalpfad sind
// nicht dieselbe Datei).
const EXPECTED_CODES = [
  'OK',
  'MASTER_DB_NOT_FOUND',
  'SQLCIPHER_UNAVAILABLE',
  'MASTER_DB_OPEN_FAILED',
  'MASTER_DB_SCHEMA_INVALID',
  'TRACK_NOT_FOUND_IN_MASTER_DB',
  'ANLZ_NOT_FOUND',
  'ANLZ_READ_FAILED',
  'ANLZ_INVALID',
  'REKORDBOX_WAVEFORM_MISSING',
  'ANLZ_WAVEFORM_UNREADABLE',
  'ANLZ_SOURCE_MISMATCH',
  'ORIGINAL_AUDIO_NOT_FOUND',
];
assert.deepEqual([...GATE_CODES].sort(), [...EXPECTED_CODES].sort(), 'GATE_CODES must match the documented state machine');
assert.equal(typeof resolveTrackFromMasterDb, 'function', 'resolveTrackFromMasterDb is exported');
assert.equal(typeof dbReaderModule.openContentRow, 'function', 'dbReader exposes the targeted row reader');

// ─── ANLZ-Fixtures im echten Sektions-Envelope ──────────────────────────────
// Envelope wie in src/rekordbox/testDatasets.ts (encodeTag):
//   ascii(tag) + u32-BE headerLänge + u32-BE Gesamtlänge(12 + body) + body
function section(tag, body = Buffer.alloc(0), headerValue = 0x18) {
  const total = 12 + body.length;
  const buffer = Buffer.alloc(total);
  buffer.write(tag, 0, 'ascii');
  buffer.writeUInt32BE(headerValue, 4);
  buffer.writeUInt32BE(total, 8);
  body.copy(buffer, 12);
  return buffer;
}

function pmaiHeader(headerLen = 32) {
  const buffer = Buffer.alloc(headerLen);
  buffer.write('PMAI', 0, 'ascii');
  buffer.writeUInt32BE(headerLen, 4);
  buffer.writeUInt32BE(0, 8);
  return buffer;
}

/** PPTH-Section wie encodePpth: u32 byteLength + UTF-16BE + NUL. */
function ppthSection(pathValue) {
  const encoded = Buffer.from(
    [...pathValue].flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff]).concat([0, 0])
  );
  const body = Buffer.alloc(4 + encoded.length);
  body.writeUInt32BE(encoded.length, 0);
  encoded.copy(body, 4);
  return section('PPTH', body, 0x10);
}

function anlzWithPpth(pathValue) {
  return Buffer.concat([
    pmaiHeader(32),
    ppthSection(pathValue),
    section('PQTZ', Buffer.alloc(64, 0x01), 0x18),
    section('PWV5', WAVEFORM_BODY, 0x18),
  ]);
}

/**
 * Real PWV5 payload: len_header 0x18, u4 len_entry_bytes @+0x0c, u4
 * len_entries @+0x10, u4 unknown @+0x14, data @+0x18. The body starts at
 * section offset +12, so the fields sit at body[0], body[4] and body[8].
 * Der Gate dekodiert daraus eine echte Waveform – deshalb muss das Fixture
 * das reale Layout haben und nicht nur ein PWV5-Tag mit Füllbytes.
 */
const WAVEFORM_ENTRY_COUNT = 12;
const WAVEFORM_BODY = Buffer.alloc(48, 0xff);
WAVEFORM_BODY.writeUInt32BE(2, 0); // len_entry_bytes
WAVEFORM_BODY.writeUInt32BE(WAVEFORM_ENTRY_COUNT, 4); // len_entries
WAVEFORM_BODY.writeUInt32BE(0, 8); // unknown
const validAnlz = Buffer.concat([
  pmaiHeader(32),
  section('PPTH', Buffer.alloc(40, 0x00), 0x10),
  section('PQTZ', Buffer.alloc(64, 0x01), 0x18),
  section('PWV5', WAVEFORM_BODY, 0x18),
]);
const noWaveformAnlz = Buffer.concat([
  pmaiHeader(32),
  section('PQTZ', Buffer.alloc(64, 0x01), 0x18),
]);

// ─── Dependency-Injection-Helfer ────────────────────────────────────────────
const DEVICE_LOCATION =
  'file://localhost//contents_4136090260/unknownartist/unknownalbum/andreas%20henneberg%20%20skirmish%20original%20mix.mp3';
const DRIVE_LOCATION = 'file://localhost/C:/Music/Andreas%20Henneberg/Skirmish.mp3';

function enoent(target) {
  const error = new Error(`ENOENT: ${target}`);
  error.code = 'ENOENT';
  return error;
}

function makeRow(overrides = {}) {
  return {
    ID: '142225026',
    Title: 'Andreas Henneberg  Skirmish Original Mix',
    FolderPath: 'C:\\Music\\Andreas Henneberg',
    FileNameL: 'Skirmish (Original Mix).mp3',
    AnalysisDataPath: 'C:\\Pioneer\\rekordbox7\\analysis\\PQT000000.DAT',
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const stats = [];
  const reads = [];
  const opens = [];
  const deps = {
    locateRekordboxDatabases: async () => [
      { path: 'C:\\Pioneer\\rekordbox7\\master.db', kind: 'MASTER_DB', label: 'master.db' },
    ],
    isCipherAvailable: () => true,
    openContentRow: async (dbPath, trackId) => {
      opens.push({ dbPath, trackId });
      return {
        available: true,
        dbType: 'MASTER_DB',
        row: makeRow(),
        cues: [{ ID: '9', ContentID: '142225026', Kind: 1, InMsec: 15000, OutMsec: -1 }],
      };
    },
    stat: async (target) => {
      const value = String(target);
      stats.push(value);
      if (value.startsWith('//') || value.includes('/contents_')) throw enoent(value);
      if (/\.dat$/i.test(value)) return { isFile: () => true, size: validAnlz.length, mtimeMs: 111 };
      if (/skirmish/i.test(value)) return { isFile: () => true, size: 10_223_409, mtimeMs: 222 };
      throw enoent(value);
    },
    readFile: async (target) => {
      reads.push(String(target));
      return validAnlz;
    },
    ...overrides,
  };
  return { deps, stats, reads, opens };
}

const DEVICE_QUERY = { trackId: '142225026', mediaPath: DEVICE_LOCATION, title: 'Skirmish' };

// ─── Erfolgspfad: XML-Location ist geräteintern → master.db-Pfad gewinnt ───
{
  const { deps } = makeDeps();
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.ok, true, `expected OK, got ${result.code}: ${result.reason}`);
  assert.equal(result.code, 'OK');
  assert.equal(result.dbType, 'MASTER_DB');
  assert.equal(result.content.id, '142225026');
  assert.equal(result.analysis.hasWaveform, true, 'waveform section found');
  assert.ok(result.analysis.tags.includes('PWV5'), 'PWV5 tag reported');
  assert.ok(result.analysis.tags.includes('PQTZ'), 'PQTZ tag reported');
  assert.equal(result.original.source, 'MASTER_DB', 'device location falls back to the master.db original path');
  assert.ok(result.original.path.includes('Skirmish'), 'db original path returned');
  assert.equal(result.original.xmlLocation, DEVICE_LOCATION, 'XML location kept for diagnostics');
  assert.equal(result.cues.length, 1, 'djmdCue rows for the content row are returned');
}

// ─── Erfolgspfad: reguläre XML-Location gewinnt ─────────────────────────────
{
  const { deps } = makeDeps();
  const result = await resolveTrackFromMasterDb(
    { trackId: '142225026', mediaPath: DRIVE_LOCATION },
    deps
  );
  assert.equal(result.ok, true, `expected OK, got ${result.code}: ${result.reason}`);
  assert.equal(result.original.source, 'XML_LOCATION', 'existing XML location stays authoritative');
  assert.ok(result.original.path.includes('C:/Music') || result.original.path.includes('C:\\Music'));
}

// ─── MASTER_DB_NOT_FOUND ────────────────────────────────────────────────────
{
  const { deps } = makeDeps({ locateRekordboxDatabases: async () => [] });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MASTER_DB_NOT_FOUND');
}
{
  const { deps } = makeDeps({
    locateRekordboxDatabases: async () => { throw new Error('scan failed'); },
  });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'MASTER_DB_NOT_FOUND', 'a failing scan is reported honestly');
}

// ─── SQLCIPHER_UNAVAILABLE ──────────────────────────────────────────────────
{
  let opened = false;
  const { deps } = makeDeps({
    isCipherAvailable: () => false,
    openContentRow: async () => { opened = true; return { available: true, row: makeRow() }; },
  });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'SQLCIPHER_UNAVAILABLE');
  assert.equal(opened, false, 'no DB is touched when SQLCipher is missing');
}

// ─── MASTER_DB_OPEN_FAILED ──────────────────────────────────────────────────
{
  const { deps } = makeDeps({
    openContentRow: async () => ({ available: false, reason: 'Datei nicht entschlüsselbar' }),
  });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'MASTER_DB_OPEN_FAILED');
}

// ─── MASTER_DB_SCHEMA_INVALID ───────────────────────────────────────────────
{
  const { deps } = makeDeps({
    openContentRow: async () => ({ available: false, schemaInvalid: true, reason: 'Tabelle djmdContent fehlt.' }),
  });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'MASTER_DB_SCHEMA_INVALID');
}

// ─── TRACK_NOT_FOUND_IN_MASTER_DB ───────────────────────────────────────────
{
  const { deps } = makeDeps({ openContentRow: async () => ({ available: true, dbType: 'MASTER_DB', row: null, cues: [] }) });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'TRACK_NOT_FOUND_IN_MASTER_DB');
}
{
  const { deps } = makeDeps();
  const result = await resolveTrackFromMasterDb({ trackId: '  ' }, deps);
  assert.equal(result.code, 'TRACK_NOT_FOUND_IN_MASTER_DB', 'missing TrackID fails closed');
}

// ─── MASTER_DB-Kandidat vor ONE_LIBRARY ─────────────────────────────────────
{
  const { deps, opens } = makeDeps({
    locateRekordboxDatabases: async () => [
      { path: 'E:\\share\\exportLibrary.db', kind: 'ONE_LIBRARY', label: 'exportLibrary.db' },
      { path: 'C:\\Pioneer\\rekordbox7\\master.db', kind: 'MASTER_DB', label: 'master.db' },
    ],
  });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.ok, true);
  assert.equal(opens[0].dbPath, 'C:\\Pioneer\\rekordbox7\\master.db', 'master.db is tried first');
}

// ─── ANLZ_NOT_FOUND (kein AnalysisDataPath) ─────────────────────────────────
{
  const { deps } = makeDeps({
    openContentRow: async () => ({ available: true, dbType: 'MASTER_DB', row: makeRow({ AnalysisDataPath: '' }), cues: [] }),
  });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'ANLZ_NOT_FOUND');
}

// ─── ANLZ_NOT_FOUND (Datei fehlt) ───────────────────────────────────────────
{
  const { deps } = makeDeps({
    stat: async (target) => {
      const value = String(target);
      if (/\.dat$/i.test(value)) throw enoent(value);
      if (/skirmish/i.test(value)) return { isFile: () => true, size: 100, mtimeMs: 1 };
      throw enoent(value);
    },
  });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'ANLZ_NOT_FOUND');
}

// ─── ANLZ_READ_FAILED ───────────────────────────────────────────────────────
{
  const { deps } = makeDeps({
    readFile: async () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
  });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'ANLZ_READ_FAILED');
}

// ─── ANLZ_INVALID (Rückgabewert zu klein / unlesbare Bytes) ─────────────────
{
  const { deps } = makeDeps({ readFile: async () => Buffer.alloc(4) });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'ANLZ_INVALID');
}
{
  const { deps } = makeDeps({ readFile: async () => Buffer.alloc(32) });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'ANLZ_INVALID', 'zero bytes are not a printable section tag');
}

// ─── ANLZ_INVALID (falsche Dateiendung) ─────────────────────────────────────
{
  const { deps } = makeDeps({
    openContentRow: async () => ({
      available: true,
      dbType: 'MASTER_DB',
      row: makeRow({ AnalysisDataPath: 'C:\\Pioneer\\rekordbox7\\analysis\\blob.bin' }),
      cues: [],
    }),
    stat: async (target) => {
      const value = String(target);
      if (/\.bin$/i.test(value) || /\.dat$/i.test(value)) {
        return { isFile: () => true, size: 64, mtimeMs: 1 };
      }
      if (/skirmish/i.test(value)) return { isFile: () => true, size: 100, mtimeMs: 1 };
      throw enoent(value);
    },
  });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'ANLZ_INVALID');
}

// ─── REKORDBOX_WAVEFORM_MISSING ─────────────────────────────────────────────
{
  const { deps } = makeDeps({ readFile: async () => noWaveformAnlz });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'REKORDBOX_WAVEFORM_MISSING');
  assert.ok(result.reason.includes('PQTZ'), 'reason lists the sections that were present');
}

// ─── ORIGINAL_AUDIO_NOT_FOUND (XML- und DB-Pfad fehlen) ─────────────────────
{
  const { deps } = makeDeps({
    stat: async (target) => {
      const value = String(target);
      if (/\.dat$/i.test(value)) return { isFile: () => true, size: validAnlz.length, mtimeMs: 1 };
      throw enoent(value);
    },
  });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.code, 'ORIGINAL_AUDIO_NOT_FOUND');
}

// ─── ORIGINAL_AUDIO_NOT_FOUND (keine Pfade vorhanden) ───────────────────────
{
  const { deps } = makeDeps({
    openContentRow: async () => ({
      available: true,
      dbType: 'MASTER_DB',
      row: makeRow({ FolderPath: '', FileNameL: '' }),
      cues: [],
    }),
  });
  const result = await resolveTrackFromMasterDb({ trackId: '142225026' }, deps);
  assert.equal(result.code, 'ORIGINAL_AUDIO_NOT_FOUND');
}

// ─── Reihenfolge: ANLZ-Fehler haben Vorrang vor Original-Audio ──────────────
{
  const { deps } = makeDeps({ readFile: async () => noWaveformAnlz });
  const result = await resolveTrackFromMasterDb({ trackId: '142225026' }, deps);
  assert.equal(result.code, 'REKORDBOX_WAVEFORM_MISSING', 'the documented pipeline order is deterministic');
}

// ─── PPTH-Präferenz: veraltete XML-Location → master.db-Pfad gewinnt ────────
{
  const dbPath = 'C:\\Music\\Andreas Henneberg\\Skirmish (Original Mix).mp3';
  const { deps } = makeDeps({ readFile: async () => anlzWithPpth(dbPath) });
  const result = await resolveTrackFromMasterDb(
    { trackId: '142225026', mediaPath: DRIVE_LOCATION },
    deps
  );
  assert.equal(result.ok, true, `expected OK, got ${result.code}: ${result.reason}`);
  assert.equal(
    result.original.source,
    'MASTER_DB',
    'the candidate matching the ANLZ PPTH source wins over a differing existing XML location'
  );
  assert.equal(result.original.path, dbPath);
}

// ─── PPTH als einziger realistischer Originalpfad ───────────────────────────
{
  const ppthPath = 'C:\\Moved\\Library\\Skirmish (Original Mix).mp3';
  const { deps } = makeDeps({
    openContentRow: async () => ({
      available: true,
      dbType: 'MASTER_DB',
      row: makeRow({ FolderPath: '', FileNameL: '' }),
      cues: [],
    }),
    readFile: async () => anlzWithPpth(ppthPath),
    stat: async (target) => {
      const value = String(target);
      if (/\.dat$/i.test(value)) return { isFile: () => true, size: validAnlz.length, mtimeMs: 1 };
      if (/moved/i.test(value)) return { isFile: () => true, size: 100, mtimeMs: 1 };
      throw enoent(value);
    },
  });
  const result = await resolveTrackFromMasterDb(DEVICE_QUERY, deps);
  assert.equal(result.ok, true, `expected OK, got ${result.code}: ${result.reason}`);
  assert.equal(result.original.source, 'ANLZ_PPTH');
  assert.equal(result.original.path, ppthPath);
}

// ─── scanAnlzSections: gespiegelt an anlzParser.ts ──────────────────────────
{
  const ppthScan = scanAnlzSections(anlzWithPpth('C:\\Music\\Reference.wav'));
  assert.equal(ppthScan.ppthPath, 'C:\\Music\\Reference.wav', 'PPTH source path decoded like anlzParser');
  const scan = scanAnlzSections(validAnlz);
  assert.equal(scan.valid, true);
  assert.equal(scan.hasWaveform, true);
  assert.ok(scan.tags.includes('PMAI') === false, 'PMAI is a file header, not a walked section');
  assert.ok(scan.tags.includes('PPTH') && scan.tags.includes('PQTZ') && scan.tags.includes('PWV5'));
  assert.equal(scan.truncated, false);
}
{
  const scan = scanAnlzSections(noWaveformAnlz);
  assert.equal(scan.valid, true);
  assert.equal(scan.hasWaveform, false);
}
{
  // Legacy-Envelope: Gesamtlänge nur in @4, @8 ungültig (Fallback der Parser-Logik).
  const body = Buffer.alloc(24, 0x02);
  const legacy = Buffer.alloc(12 + body.length);
  legacy.write('PQTZ', 0, 'ascii');
  legacy.writeUInt32BE(12 + body.length, 4);
  legacy.writeUInt32BE(0, 8);
  body.copy(legacy, 12);
  const scan = scanAnlzSections(Buffer.concat([legacy, section('PWV2', Buffer.alloc(16, 0x80))]));
  assert.equal(scan.valid, true, 'sections with @4 length are walked like anlzParser');
  assert.equal(scan.hasWaveform, true);
}
{
  const tiny = scanAnlzSections(Buffer.alloc(8));
  assert.equal(tiny.valid, false);
  const garbage = scanAnlzSections(Buffer.alloc(64));
  assert.equal(garbage.valid, false, 'zero-filled bytes are not a printable tag');
}

// ─── Read-only: der Gate enthält keine Schreib-API ──────────────────────────
{
  const source = await readFile(fileURLToPath(new URL('../electron/masterDbGate.cjs', import.meta.url)), 'utf8');
  assert.ok(!/\bwriteFileSync\b|\bwriteFile\s*\(|\bappendFile|\bunlinkSync|\brmSync|\btruncateSync\b/.test(source),
    'masterDbGate.cjs must not contain any write API');
  assert.ok(!/\bopenSync\s*\([^)]*['"]w/.test(source), 'no writable file handles');
}

// ─── toLocalPath: XML-Location → lokaler Pfad ───────────────────────────────
{
  assert.equal(toLocalPath(''), null);
  assert.equal(toLocalPath('http://example.com/x.wav'), null);
  const drive = toLocalPath('file://localhost/C:/Music/Track.wav');
  assert.ok(drive && /C:/.test(drive), `drive location resolved: ${drive}`);
  const device = toLocalPath(DEVICE_LOCATION);
  assert.ok(device && device.includes('contents_4136090260'), `device location resolved: ${device}`);
}

console.log('master-db-gate: all 13 gate codes, ANLZ section walk and read-only contract verified');
