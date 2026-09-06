/**
 * @license
 * Regressionstest für den Rekordbox-Datenbank-Reader (electron/dbReader.cjs).
 *
 * Deckt den Pfad ab, der bisher ungetestet war: eine *erfolgreich*
 * entschlüsselte SQLCipher-Datenbank. openRekordboxDb() lieferte dort ein
 * Objekt ohne `available`, wodurch readRekordboxDatabase() jede korrekt
 * geöffnete Bibliothek als Fehlschlag behandelte und den Dateihandle offen
 * ließ. Der Test schreibt eine echte verschlüsselte master.db, liest sie
 * über den Reader zurück und prüft zusätzlich die Fehlerpfade.
 *
 * Das native SQLCipher-Modul ist eine optionale Abhängigkeit; fehlt es,
 * meldet sich der Test als SKIP (der XML-Pfad bleibt davon unberührt).
 *
 * Run with: node tests/db-reader-open.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dbReader = require('../electron/dbReader.cjs');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`\x1b[32m[ PASS ]\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`\x1b[31m[ FAIL ]\x1b[0m ${name}${detail ? ` – ${detail}` : ''}`);
    failed++;
  }
}

if (!dbReader.isCipherAvailable()) {
  console.log('\x1b[33m[ SKIP ]\x1b[0m better-sqlite3-multiple-ciphers ist nicht installiert – DB-Reader-Test übersprungen.');
  process.exit(0);
}

const Database = require('better-sqlite3-multiple-ciphers');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-dbreader-'));

function writeDb(file, key, { tracks = 2, cues = 3 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('cipher = sqlcipher');
  db.pragma('legacy = 4');
  db.pragma(`key = '${key}'`);
  // Exakt die Spalten, die electron/dbReader.cjs abfragt – sonst liefert die
  // SELECT-Liste einen Fehler und der Reader meldet 0 Tracks.
  db.exec(`
    CREATE TABLE djmdContent (ID INTEGER PRIMARY KEY, FolderPath TEXT, FileNameL TEXT, Title TEXT, ArtistID INTEGER, AlbumID INTEGER, GenreID INTEGER, BPM INTEGER, Length INTEGER, TrackNo INTEGER, BitRate INTEGER, BitDepth INTEGER, Commnt TEXT, FileType TEXT, Rating INTEGER, ReleaseYear INTEGER, RemixerID INTEGER, LabelID INTEGER, KeyID INTEGER, StockDate TEXT, ColorID INTEGER, DJPlayCount TEXT, AnalysisDataPath TEXT, FileSize INTEGER, SampleRate INTEGER, DateCreated TEXT, ReleaseDate TEXT, ISRC TEXT, Subtitle TEXT, ComposerID INTEGER);
    CREATE TABLE djmdCue (ID TEXT PRIMARY KEY, ContentID INTEGER, InMsec INTEGER, InFrame INTEGER, OutMsec INTEGER, OutFrame INTEGER, Kind INTEGER, Color INTEGER, ColorTableIndex INTEGER, ActiveLoop INTEGER, Comment TEXT, BeatLoopSize INTEGER);
    CREATE TABLE djmdArtist (ID INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdAlbum (ID INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdGenre (ID INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdKey (ID INTEGER PRIMARY KEY, ScaleName TEXT, Seq INTEGER);
    CREATE TABLE djmdLabel (ID INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdPlaylist (ID INTEGER PRIMARY KEY, Name TEXT, ParentID INTEGER, Attribute INTEGER);
    CREATE TABLE djmdSongPlaylist (ID INTEGER PRIMARY KEY, PlaylistID INTEGER, ContentID INTEGER, TrackNo INTEGER);
    INSERT INTO djmdArtist (ID, Name) VALUES (1, 'Klangfeld');
    INSERT INTO djmdAlbum (ID, Name) VALUES (1, 'Subterranean Records');
    INSERT INTO djmdGenre (ID, Name) VALUES (1, 'Techno');
    INSERT INTO djmdKey (ID, ScaleName, Seq) VALUES (1, '6A', 1);
    INSERT INTO djmdLabel (ID, Name) VALUES (1, 'Subterranean');
    INSERT INTO djmdPlaylist (ID, Name, ParentID, Attribute) VALUES (1, 'Test', NULL, 0);
  `);
  const content = db.prepare(
    'INSERT INTO djmdContent (ID, FolderPath, FileNameL, Title, ArtistID, AlbumID, GenreID, BPM, Length, TrackNo, BitRate, BitDepth, Commnt, FileType, Rating, ReleaseYear, RemixerID, LabelID, KeyID, StockDate, ColorID, DJPlayCount, AnalysisDataPath, FileSize, SampleRate, DateCreated, ReleaseDate, ISRC, Subtitle, ComposerID) VALUES (?, ?, ?, ?, 1, 1, 1, 12800, 240000, ?, 320, 16, ?, ?, 255, 2026, 0, 1, 1, ?, 0, ?, ?, 2646044, 44100, ?, ?, ?, ?, 0)'
  );
  const cue = db.prepare(
    'INSERT INTO djmdCue (ID, ContentID, InMsec, InFrame, OutMsec, OutFrame, Kind, Color, ColorTableIndex, ActiveLoop, Comment, BeatLoopSize) VALUES (?, ?, ?, 0, ?, 0, ?, 0, 0, 0, ?, 0)'
  );
  const songPlaylist = db.prepare('INSERT INTO djmdSongPlaylist (ID, PlaylistID, ContentID, TrackNo) VALUES (?, 1, ?, ?)');
  for (let i = 1; i <= tracks; i++) {
    content.run(100 + i, tmpDir, `track-${i}.wav`, `Regression Track ${i}`, i, 'Peak hour', 'wav', '2026-09-06', String(i), path.join(tmpDir, `ANLZ${i}.DAT`), '2026-09-06 09:00:00', '2026-01-01', `DEA${100 + i}`, '');
    songPlaylist.run(i, 100 + i, i);
  }
  for (let c = 1; c <= cues; c++) {
    cue.run(`c${c}`, 101, (c - 1) * 15000, -1, c === 1 ? 0 : 1, `Cue ${c}`);
  }
  db.close();
  return file;
}

// 1) Erfolgreich entschlüsselte master.db
const masterPath = writeDb(path.join(tmpDir, 'master.db'), dbReader.getMasterDbKey());
const result = dbReader.readRekordboxDatabase(masterPath);

check('master.db wird als verfügbar gemeldet', result.available === true, `available=${result.available}, reason=${result.reason}`);
check('Datenbanktyp MASTER_DB erkannt', result.dbType === 'MASTER_DB');
check('2 Tracks gelesen', result.stats?.tracks === 2, `tracks=${result.stats?.tracks}`);
check('3 Cues gelesen', result.stats?.cues === 3, `cues=${result.stats?.cues}`);
check('1 Playlist gelesen', result.stats?.playlists === 1);
check('Tracktitel korrekt', result.rows?.content?.[0]?.Title === 'Regression Track 1', result.rows?.content?.[0]?.Title);
check('Cue-Kommentar korrekt', result.rows?.cues?.[2]?.Comment === 'Cue 3');
check('kein offener Dateihandle im Ergebnis (vorheriger Leak)', result.db === undefined);

// 2) Falscher Schlüssel (OneLibrary-Schlüssel auf master.db)
const wrongKeyPath = writeDb(path.join(tmpDir, 'wrongkey', 'master.db'), dbReader.getOneLibraryKey());
const wrongKey = dbReader.readRekordboxDatabase(wrongKeyPath);
check('falscher Schlüssel schlägt fehl', wrongKey.available === false);
check('Fehler wird begründet', typeof wrongKey.reason === 'string' && wrongKey.reason.length > 0, wrongKey.reason);

// 3) Keine Datenbankdatei
const junkPath = path.join(tmpDir, 'junk', 'master.db');
fs.mkdirSync(path.dirname(junkPath), { recursive: true });
fs.writeFileSync(junkPath, 'das ist keine sqlite-datei');
const junk = dbReader.readRekordboxDatabase(junkPath);
check('fremde Datei schlägt fehl', junk.available === false && typeof junk.reason === 'string');

// 4) Unbekannter Dateiname wird abgelehnt
const unknown = dbReader.readRekordboxDatabase(path.join(tmpDir, 'irgendwas.db'));
check('unbekannter Dateiname wird abgelehnt', unknown.available === false);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
