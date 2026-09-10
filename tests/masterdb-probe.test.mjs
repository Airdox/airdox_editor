/**
 * @license
 * Stufe-0-Test der Pipeline: Master-DB-Zugriff (read-only) end-to-end.
 *
 * Baut eine SQLCipher-verschlüsselte master.db-Fixture mit dem echten
 * Rekordbox-master.db-Schlüssel (aus electron/dbReader.cjs), startet die
 * Diagnose-CLI `scripts/masterdb-probe.mjs` als eigenen Prozess und prüft:
 *
 *   1. Die Probe öffnet die Datenbank und liest das Schema.
 *   2. Die Track-Zählwerte und der AnalysisDataPath-Füllgrad stimmen.
 *   3. Die Quelle ist nach dem Lauf byte-identisch (SHA-256, Größe, mtime)
 *      → die Read-Only-Garantie ist bewiesen.
 *   4. Es wird KEINE unverschlüsselte Kopie in den Quellordner geschrieben.
 *   5. Eine beschädigte / nicht verschlüsselte Datei ergibt FAIL (Exit 1).
 *
 * Run with: node tests/masterdb-probe.test.mjs
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probeScript = path.join(repoRoot, 'scripts', 'masterdb-probe.mjs');

let Database = null;
try {
  Database = require('better-sqlite3-multiple-ciphers');
} catch {
  Database = null;
}

if (!Database) {
  console.log('masterdb-probe: BLOCKED – better-sqlite3-multiple-ciphers nicht installiert.');
  console.log('  npm install better-sqlite3-multiple-ciphers (Desktop-App: npm run rebuild:electron)');
  process.exit(0);
}

const dbReader = require('../electron/dbReader.cjs');
const masterKey = dbReader.getMasterDbKey();

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-masterdb-'));
const dbPath = path.join(workDir, 'master.db');

// ---------------------------------------------------------------------------
// Fixture: verschlüsselte master.db mit djmd*-Schema
// ---------------------------------------------------------------------------

function buildFixture() {
  const db = new Database(dbPath);
  db.pragma('cipher = sqlcipher');
  db.pragma('legacy = 4');
  db.pragma(`key = '${masterKey}'`);
  // Volles master.db-Schema (Spaltenliste exakt wie von readMasterDb erwartet),
  // damit die Fixture wie eine echte Rekordbox-6/7-Datenbank gelesen wird.
  db.exec(`
    CREATE TABLE djmdArtist (ID INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdAlbum (ID INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdGenre (ID INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdKey (ID INTEGER PRIMARY KEY, ScaleName TEXT, Seq INTEGER);
    CREATE TABLE djmdLabel (ID INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdContent (
      ID INTEGER PRIMARY KEY,
      FolderPath TEXT,
      FileNameL TEXT,
      Title TEXT,
      ArtistID INTEGER,
      AlbumID INTEGER,
      GenreID INTEGER,
      BPM INTEGER,
      Length INTEGER,
      TrackNo INTEGER,
      BitRate INTEGER,
      BitDepth INTEGER,
      Commnt TEXT,
      FileType TEXT,
      Rating INTEGER,
      ReleaseYear INTEGER,
      RemixerID INTEGER,
      LabelID INTEGER,
      KeyID INTEGER,
      StockDate TEXT,
      ColorID INTEGER,
      DJPlayCount INTEGER,
      AnalysisDataPath TEXT,
      FileSize INTEGER,
      SampleRate INTEGER,
      DateCreated TEXT,
      ReleaseDate TEXT,
      ISRC TEXT,
      Subtitle TEXT,
      ComposerID INTEGER
    );
    CREATE TABLE djmdCue (
      ID INTEGER PRIMARY KEY,
      ContentID INTEGER,
      InMsec INTEGER,
      InFrame INTEGER,
      OutMsec INTEGER,
      OutFrame INTEGER,
      Kind INTEGER,
      Color INTEGER,
      ColorTableIndex INTEGER,
      ActiveLoop INTEGER,
      Comment TEXT,
      BeatLoopSize INTEGER
    );
    CREATE TABLE djmdPlaylist (ID INTEGER PRIMARY KEY, Name TEXT, ParentID INTEGER, Attribute INTEGER);
    CREATE TABLE djmdSongPlaylist (ID INTEGER PRIMARY KEY, PlaylistID INTEGER, ContentID INTEGER, TrackNo INTEGER);

    INSERT INTO djmdArtist (ID, Name) VALUES (1, 'Alpha Artist'), (2, 'Beta Artist');
    INSERT INTO djmdAlbum (ID, Name) VALUES (1, 'Alpha EP');
    INSERT INTO djmdGenre (ID, Name) VALUES (1, 'Techno');
    INSERT INTO djmdKey (ID, ScaleName, Seq) VALUES (1, '8A', 8);
    INSERT INTO djmdLabel (ID, Name) VALUES (1, 'Dry Run Records');
    INSERT INTO djmdContent (
      ID, FolderPath, FileNameL, Title, ArtistID, AlbumID, GenreID, BPM, Length, TrackNo, BitRate,
      BitDepth, Commnt, FileType, Rating, ReleaseYear, RemixerID, LabelID, KeyID, StockDate, ColorID,
      DJPlayCount, AnalysisDataPath, FileSize, SampleRate, DateCreated, ReleaseDate, ISRC, Subtitle, ComposerID
    ) VALUES
      (1, 'D:\\Music\\Alpha\\', 'alpha.flac', 'Alpha Track', 1, 1, 1, 12400, 342, 1, 1411, 16, '', 'FLAC', 128, 2024, NULL, 1, 1, '2026-01-05', 0, 3,
       '/PIONEER/USBANLZ/0a1/0000-uuid/ANLZ0000.DAT', 30000000, 44100, '2026-01-05', '2024-03-01', '', '', NULL),
      (2, 'D:\\Music\\Beta\\', 'beta.mp3', 'Beta Track', 2, NULL, NULL, 12800, 210, 1, 320, 0, '', 'MP3', 0, 2023, NULL, NULL, NULL, '2026-02-11', NULL, 0,
       '/PIONEER/USBANLZ/0b2/1111-uuid/ANLZ0000.DAT', 9000000, 44100, '2026-02-11', NULL, '', '', NULL),
      (3, 'D:\\Music\\Gamma\\', 'gamma.wav', 'Gamma Track', 1, NULL, NULL, 13200, 180, 1, 2304, 24, '', 'WAV', 0, 2025, NULL, NULL, NULL, '2026-03-02', NULL, 0,
       NULL, 40000000, 48000, '2026-03-02', NULL, '', '', NULL);
    INSERT INTO djmdCue (ID, ContentID, InMsec, InFrame, OutMsec, OutFrame, Kind, Color, ColorTableIndex, ActiveLoop, Comment, BeatLoopSize) VALUES
      (1, 1, 1935, 0, 0, 0, 0, 0, 0, 0, 'Intro', 0),
      (2, 1, 63870, 0, 0, 0, 1, 3, 3, 0, 'Drop', 0),
      (3, 2, 2000, 0, 0, 0, 0, 0, 0, 0, 'Start', 0),
      (4, 3, 1500, 0, 0, 0, 0, 0, 0, 0, 'Start', 0),
      (5, 3, 90000, 0, 97878, 0, 2, 1, 1, 1, 'Loop 8', 8);
    INSERT INTO djmdPlaylist (ID, Name, ParentID, Attribute) VALUES (1, 'Dry Run', 0, 0);
    INSERT INTO djmdSongPlaylist (ID, PlaylistID, ContentID, TrackNo) VALUES (1, 1, 1, 1);
  `);
  db.close();
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runProbe(args) {
  return spawnSync(process.execPath, [probeScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

buildFixture();

const hashBefore = sha256(dbPath);
const sizeBefore = fs.statSync(dbPath).size;
const mtimeBefore = fs.statSync(dbPath).mtimeMs;
const dirBefore = fs.readdirSync(workDir).sort();

// Die Fixture muss tatsächlich verschlüsselt sein (kein "SQLite format 3").
const header = fs.readFileSync(dbPath).subarray(0, 16).toString('latin1');
assert.ok(!header.startsWith('SQLite format 3'), 'Fixture muss SQLCipher-verschlüsselt sein');

const reportPath = path.join(workDir, 'report.json');
const result = runProbe(['--db', dbPath, '--limit', '2', '--json', reportPath]);
const out = `${result.stdout || ''}\n${result.stderr || ''}`;

assert.strictEqual(result.status, 0, `Probe muss mit Exit 0 enden, war ${result.status}\n${out}`);
assert.match(out, /ERGEBNIS: PASS/, 'Probe muss PASS melden');
assert.match(out, /\[1\] SQLCipher-Modul\s+PASS/, 'Schritt 1 (Modul) muss PASS sein');
assert.match(out, /\[4\] Entschluesselung \(in-memory\)\s+PASS/, 'Schritt 4 (Entschlüsselung) muss PASS sein');
assert.match(out, /402fd4/, 'maskierter Schlüsselprefix muss erscheinen');
assert.match(out, /SQLCipher-verschlüsselt/, 'die Quelle muss als verschlüsselt erkannt werden');
assert.ok(!out.includes(masterKey), 'der vollständige SQLCipher-Schlüssel darf niemals ausgegeben werden');

// [5] Schema / [7] Zählwerte
const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
assert.strictEqual(report.result, 'PASS');
assert.ok(report.tables.some((t) => t.name === 'djmdContent'), 'djmdContent muss im Schema-Scan stehen');
assert.strictEqual(report.counts.tracks, 3, '3 Tracks in der Fixture');
assert.strictEqual(report.counts.withAnalysis, 2, '2 von 3 Tracks haben AnalysisDataPath');
assert.strictEqual(report.counts.cues, 5, '5 Cues in der Fixture');
assert.ok(report.columns.includes('AnalysisDataPath'), 'Spalte AnalysisDataPath muss erkannt werden');

// [8] Stichprobe: BPM × 100 muss korrekt zurückgerechnet, Pfade übernommen werden
assert.strictEqual(report.samples.length, 2, '--limit 2');
assert.strictEqual(report.samples[0].id, '1');
assert.strictEqual(report.samples[0].bpm, 124, 'BPM 12400 → 124.00');
assert.strictEqual(report.samples[0].analysisDataPath, '/PIONEER/USBANLZ/0a1/0000-uuid/ANLZ0000.DAT');
assert.strictEqual(report.samples[0].cues, 2, 'Track 1 hat 2 Cues');
assert.strictEqual(report.samples[1].id, '2');

// [3]/[10] Read-Only-Beweis
const hashAfter = sha256(dbPath);
assert.strictEqual(hashAfter, hashBefore, 'SHA-256 der master.db muss unverändert sein');
assert.strictEqual(fs.statSync(dbPath).size, sizeBefore, 'Dateigröße muss unverändert sein');
assert.strictEqual(fs.statSync(dbPath).mtimeMs, mtimeBefore, 'mtime muss unverändert sein');
assert.strictEqual(report.fingerprint.unchanged, true, 'Probe muss den Fingerabdruck als identisch melden');
assert.strictEqual(report.fingerprint.before.sha256, hashBefore);

// Keine unverschlüsselte Kopie im Quellordner
const dirAfter = fs.readdirSync(workDir).sort();
assert.deepStrictEqual(
  dirAfter.filter((name) => name !== 'report.json'),
  dirBefore,
  'es darf keine Kopie (unencrypted.db o. ä.) neben der Quelle entstehen'
);

// ---------------------------------------------------------------------------
// Regression: der App-Pfad readRekordboxDatabase() muss eine erfolgreich
// entschlüsselte Datenbank auch wirklich auswerten. openRekordboxDb() gab
// früher kein `available: true` zurück, wodurch readRekordboxDatabase() sofort
// abbrach und der Renderer die master.db als "nicht verfügbar" meldete.
// ---------------------------------------------------------------------------

const parsed = dbReader.readRekordboxDatabase(dbPath);
assert.strictEqual(parsed.available, true, 'readRekordboxDatabase muss available: true liefern');
assert.strictEqual(parsed.dbType, 'MASTER_DB');
assert.strictEqual(parsed.stats.tracks, 3, 'readRekordboxDatabase: 3 Tracks');
assert.strictEqual(parsed.stats.cues, 5, 'readRekordboxDatabase: 5 Cues');
assert.strictEqual(
  parsed.rows.content[0].AnalysisDataPath,
  '/PIONEER/USBANLZ/0a1/0000-uuid/ANLZ0000.DAT',
  'AnalysisDataPath muss roh aus der DB übernommen werden'
);
assert.strictEqual(parsed.rows.content[0].BPM, 12400, 'BPM bleibt roh (×100) aus der DB');
assert.strictEqual(parsed.rows.cues.length, 5, 'Cues müssen vollständig gelesen werden');
assert.strictEqual(parsed.rows.artists.length, 2, 'Artists müssen gelesen werden');

// ---------------------------------------------------------------------------
// Negativfälle: beschädigte Datei und unverschlüsselte Datei müssen FAIL liefern
// ---------------------------------------------------------------------------

const brokenPath = path.join(workDir, 'broken.db');
fs.writeFileSync(brokenPath, Buffer.concat([Buffer.from('SQLite format 3\0'), crypto.randomBytes(4096)]));
const broken = runProbe(['--db', brokenPath]);
assert.strictEqual(broken.status, 1, 'beschädigte Datenbank → Exit 1');
assert.match(`${broken.stdout}${broken.stderr}`, /ERGEBNIS: FAIL/, 'beschädigte Datenbank → FAIL');

// Falscher Pfad → FAIL mit Hinweis auf die Datenpartition
const missing = runProbe(['--db', path.join(workDir, 'does-not-exist', 'master.db')]);
assert.strictEqual(missing.status, 1, 'fehlende Datei → Exit 1');
assert.match(`${missing.stdout}${missing.stderr}`, /FAIL/);

fs.rmSync(workDir, { recursive: true, force: true });
console.log('masterdb-probe (Stufe 0: Master-DB-Zugriff read-only): OK');
