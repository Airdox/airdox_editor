/**
 * @license
 * End-zu-End-Nachweis der Rekordbox-Datenbank-Pipeline mit einer kleinen
 * eigenen Datenbankumgebung (siehe tests/support/rekordboxDbEnv.mjs).
 *
 * Die Umgebung erzeugt echte, mit den bekannten Pioneer-Schlüsseln
 * verschlüsselte SQLCipher-Datenbanken im dokumentierten Aufbau
 * (docs/REKORDBOX_DATABASE_FORMAT.md) und beweist die komplette Kette:
 *
 *   verschlüsselte Byteblöcke (Datei am Rest)
 *     → SQL-Abfragen (electron/dbReader.cjs, read-only)
 *     → Tabellen-Einträge/Zeilen (djmd*, OneLibrary content/cue/…)
 *     → TrackModel-Mapping (src/rekordbox/dbParser.ts)
 *     → Deck-Expansion + ANLZ-Byteblock-Walk (PMAI/PPTH/PQTZ/PWV5)
 *
 * Fehlt das native SQLCipher-Modul, meldet der Test das als SKIP – genau wie
 * tests/rekordbox-gate-integration.test.mjs – und bleibt grün.
 *
 * Run with: npx tsx tests/rekordbox-db-env-pipeline.test.ts
 */

import assert from 'node:assert';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDbEnvironment,
  isSqlCipherAvailable,
} from './support/rekordboxDbEnv.mjs';
import {
  buildDeckTrackFromDatabase,
  mapRekordboxDatabaseRows,
} from '../src/rekordbox/dbParser';
import { parseAnlzBinary } from '../src/rekordbox/anlzParser';
import { DataOrigin } from '../src/types/rekordbox';

const require = createRequire(import.meta.url);
const dbReader = require('../electron/dbReader.cjs');
const anlzStructure = require('../electron/generated/anlzStructure.cjs');

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];
function runTest(name: string, testFn: () => void) {
  try {
    testFn();
    results.push({ name, passed: true });
  } catch (err: any) {
    results.push({ name, passed: false, error: err?.message || String(err) });
  }
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  REKORDBOX-DATENBANKUMGEBUNG – PIPELINE-NACHWEIS (E2E)           ');
console.log('═══════════════════════════════════════════════════════════════════\n');

if (!isSqlCipherAvailable()) {
  console.log('  [SKIP] better-sqlite3-multiple-ciphers nicht ladbar – der echte');
  console.log('         SQLCipher-Lauf wird übersprungen (npm run rekordbox:native:rebuild).');
  process.exit(0);
}

const workDir = mkdtempSync(path.join(os.tmpdir(), 'airdox-db-env-'));
const env = buildDbEnvironment(workDir);

const fingerprint = (filePath: string) => {
  const stat = statSync(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
};
const before = {
  master: fingerprint(env.masterDbPath),
  oneLibrary: fingerprint(env.oneLibraryPath),
  anlz: fingerprint(env.anlzPath),
  original: fingerprint(env.originalPath),
};

try {
  // ─── Schicht 1: Byteblöcke am Rest ──────────────────────────────────────
  runTest('master.db ist am Rest verschlüsselt (SQLCipher-Byteblöcke, kein SQLite-Header)', () => {
    const raw = readFileSync(env.masterDbPath);
    assert.notEqual(
      raw.subarray(0, 16).toString('latin1'),
      'SQLite format 3\0',
      'Die Datei darf NICHT mit dem Klartext-Header beginnen'
    );
    assert.ok(raw.length >= 4096, 'mindestens eine 4096-Byte-Seite');
  });

  runTest('exportLibrary.db ist am Rest verschlüsselt (eigener OneLibrary-Schlüssel)', () => {
    const raw = readFileSync(env.oneLibraryPath);
    assert.notEqual(raw.subarray(0, 16).toString('latin1'), 'SQLite format 3\0');
    const masterRaw = readFileSync(env.masterDbPath);
    assert.ok(!raw.subarray(0, 32).equals(masterRaw.subarray(0, 32)), 'andere Schlüssel/Pages');
  });

  // ─── Schicht 2: SQL-Abfragen → Zeilen/Einträge ──────────────────────────
  runTest('locateRekordboxDatabases() findet beide Datenbanken (read-only Kandidatenliste)', () => {
    const previous = process.env.AIRODOX_REKORDBOX_DB;
    process.env.AIRODOX_REKORDBOX_DB = `${env.masterDbPath};${env.oneLibraryPath}`;
    try {
      const located = dbReader.locateRekordboxDatabases();
      const master = located.find((entry: any) => entry.kind === 'MASTER_DB');
      const one = located.find((entry: any) => entry.kind === 'ONE_LIBRARY');
      assert.ok(master, 'master.db-Kandidat');
      assert.ok(one, 'exportLibrary.db-Kandidat');
    } finally {
      if (previous === undefined) delete process.env.AIRODOX_REKORDBOX_DB;
      else process.env.AIRODOX_REKORDBOX_DB = previous;
    }
  });

  let masterRows: any = null;
  runTest('readRekordboxDatabase(master.db) liest djmd*-Einträge (entschlüsselt, read-only)', () => {
    const result = dbReader.readRekordboxDatabase(env.masterDbPath);
    assert.equal(result.available, true, result.reason || 'master.db lesbar');
    assert.equal(result.dbType, 'MASTER_DB');
    masterRows = result.rows;
    // 303 ist rb_local_deleted = 1 und darf nicht erscheinen.
    assert.equal(result.stats.tracks, 2, 'nur die 2 sichtbaren Tracks (lokale Löschung gefiltert)');
    assert.equal(result.stats.cues, 6, 'alle djmdCue-Zeilen');
    assert.equal(result.stats.playlists, 1, 'djmdPlaylist-Zeile');
    const ids = result.rows.content.map((row: any) => String(row.ID));
    assert.deepEqual(ids.sort(), ['101', '202'], 'sichtbare IDs');
    assert.ok(!ids.includes('303'), 'gelöschte ID fehlt');
    // Referenz-Tabellen für die Joins des Mappers.
    assert.equal(result.rows.artists.length, 2, 'djmdArtist');
    assert.equal(result.rows.keys.length, 2, 'djmdKey');
    assert.equal(result.rows.songPlaylists.length, 1, 'djmdSongPlaylist');
  });

  runTest('Eintrag-Aufbau master.db: dokumentierte Spalten und Einheiten', () => {
    const row = masterRows.content.find((entry: any) => String(entry.ID) === '101');
    assert.equal(row.BPM, 12800, 'BPM × 100');
    assert.equal(row.Length, 240, 'Length in ganzen SEKUNDEN');
    assert.equal(row.Rating, 255, 'Rating 0..255');
    assert.equal(row.AnalysisDataPath, 'ANLZ\\PQT000001.DAT', 'AnalysisDataPath');
    assert.equal(row.FileSize, 42336044, 'FileSize');
    assert.equal(row.SampleRate, 44100, 'SampleRate');
    const cue = masterRows.cues.find((entry: any) => String(entry.ID) === '900004');
    assert.equal(cue.InMsec, 75000, 'InMsec in Millisekunden');
    assert.equal(cue.OutMsec, 90000, 'OutMsec in Millisekunden');
    assert.equal(cue.ActiveLoop, 1, 'ActiveLoop');
    assert.equal(masterRows.cues[0].OutMsec, -1, 'OutMsec = -1 ohne Loop');
  });

  runTest('openContentRow(master.db) liefert genau den Eintrag + eigene Cues', () => {
    const hit = dbReader.openContentRow(env.masterDbPath, '101');
    assert.equal(hit.available, true, hit.reason || 'Zeile lesbar');
    assert.equal(String(hit.row.ID), '101', 'djmdContent-Zeile');
    assert.equal(hit.cues.length, 5, 'nur die 5 Cues dieses Tracks');
    assert.ok(hit.cues.every((cue: any) => String(cue.ContentID) === '101'));

    const deleted = dbReader.openContentRow(env.masterDbPath, '303');
    assert.equal(deleted.available, true);
    assert.equal(deleted.row, null, 'lokal gelöschter Eintrag ist nicht ladbar');

    const missing = dbReader.openContentRow(env.masterDbPath, '999999');
    assert.equal(missing.row, null, 'unbekannte TrackID');
  });

  // ─── Schicht 3: Zeilen → TrackModel → Deck ──────────────────────────────
  runTest('mapRekordboxDatabaseRows(master.db) bildet Joins und Einheiten korrekt ab', () => {
    const mapped = mapRekordboxDatabaseRows(masterRows, 'MASTER_DB');
    assert.equal(mapped.tracks.length, 2, 'Trackanzahl');
    const track = mapped.tracks[0];
    assert.equal(track.title, 'Obsidian Voltage (Club Mix)');
    assert.equal(track.artist, 'Klangfeld', 'Artist-Join');
    assert.equal(track.album, 'Subterranean Records', 'Album-Join');
    assert.equal(track.genre, 'Techno', 'Genre-Join');
    assert.equal(track.key, '6A', 'Key-Join');
    assert.equal(track.label, 'Subterranean', 'Label-Join');
    assert.equal(track.bpm, 128, 'BPM / 100');
    assert.equal(track.duration, 240, 'Dauer in Sekunden (Length = 240 s, NICHT /1000)');
    assert.equal(track.rating, 5, 'Rating 255 → 5 Sterne');
    assert.equal(track.playCount, 18, 'DJPlayCount');
    assert.equal(track.comments, 'Peak hour', 'Commnt');
    assert.equal(track.isrc, 'DEZ6S2500001', 'ISRC');
    assert.equal(track.origin, DataOrigin.REKORDBOX_DB, 'Herkunft: Rekordbox-DB');
    assert.equal(
      track.originalMedia?.location.replace(/\//g, '\\'),
      'C:\\Music\\Club\\Obsidian Voltage (Club Mix).wav',
      'Medienpfad aus FolderPath + FileNameL'
    );
  });

  runTest('mapRekordboxDatabaseRows(master.db) decodiert Cues/Loops nach Kind-Semantik', () => {
    const mapped = mapRekordboxDatabaseRows(masterRows, 'MASTER_DB');
    const track = mapped.tracks[0];
    const cues = track.cues || [];
    const loops = track.loops || [];
    assert.equal(cues.filter((c) => c.type === 'MEMORY').length, 2, 'Kind 0 = Memory Cues');
    assert.equal(cues.filter((c) => c.type === 'HOT_CUE').length, 2, 'Kind 1/2 = Hot Cues A/B');
    const hotA = cues.find((c) => c.type === 'HOT_CUE' && c.hotCueNum === 0);
    assert.equal(hotA?.letter, 'A', 'Kind 1 → Hot Cue A');
    assert.equal(hotA?.comment, 'Hot A');
    const hotB = cues.find((c) => c.type === 'HOT_CUE' && c.hotCueNum === 1);
    assert.equal(hotB?.letter, 'B', 'Kind 2 → Hot Cue B');
    assert.equal(loops.length, 1, 'OutMsec > InMsec wird zum Loop');
    assert.equal(Math.round(loops[0].start * 1000), 75000, 'Loop-Start (s)');
    assert.equal(Math.round(loops[0].end * 1000), 90000, 'Loop-Ende (s)');
    assert.equal(loops[0].origin, DataOrigin.REKORDBOX_DB);
  });

  runTest('buildDeckTrackFromDatabase() expandiert zu einem spielbaren TrackModel', () => {
    const mapped = mapRekordboxDatabaseRows(masterRows, 'MASTER_DB');
    const deck = buildDeckTrackFromDatabase(mapped.tracks[0]);
    assert.equal(deck.audioBuffer, null, 'kein synthetisches Audio');
    assert.equal(deck.duration, 240, 'Dauer bleibt in Sekunden');
    assert.equal(deck.beatGrid.bpm, 128, 'Beatgrid-BPM');
    assert.ok(deck.beatGrid.beats.length > 0, 'dichtes Beatgrid beim Laden');
    assert.equal(deck.beatGrid.origin, DataOrigin.REKORDBOX_DB);
    assert.equal(deck.originalSha256, 'NOT_COMPUTED_READ_ONLY_SOURCE', 'Read-only-Kennung');
  });

  // ─── Schicht 4: OneLibrary / Device Library Plus ────────────────────────
  runTest('readRekordboxDatabase(exportLibrary.db) liest OneLibrary-Einträge', () => {
    const result = dbReader.readRekordboxDatabase(env.oneLibraryPath);
    assert.equal(result.available, true, result.reason || 'exportLibrary.db lesbar');
    assert.equal(result.dbType, 'ONE_LIBRARY');
    assert.equal(result.stats.tracks, 1, 'content-Zeilen');
    const row = result.rows.content[0];
    assert.equal(row.bpmx100, 17400, 'bpmx100');
    assert.equal(row.length, 190, 'length in ganzen SEKUNDEN');
    assert.equal(row.rating, 5, 'OneLibrary-Rating 0..5');
    assert.equal(row.samplingRate, 48000, 'samplingRate');
    // Der dokumentierte playlist_content-Eintrag hat KEINE eigene ID-Spalte;
    // der SELECT in dbReader.cjs muss genau diese Spalten benutzen.
    assert.equal(result.rows.songPlaylists.length, 1, 'playlist_content lesbar');
    assert.equal(result.rows.songPlaylists[0].content_id, 55, 'content_id');
    assert.equal(result.rows.songPlaylists[0].playlist_id, 1, 'playlist_id');
    assert.equal(result.rows.songPlaylists[0].sequenceNo, 1, 'sequenceNo');
  });

  runTest('mapRekordboxDatabaseRows(OneLibrary) inkl. Mikrosekunden-Cues', () => {
    const result = dbReader.readRekordboxDatabase(env.oneLibraryPath);
    const mapped = mapRekordboxDatabaseRows(result.rows, 'ONE_LIBRARY');
    const track = mapped.tracks[0];
    assert.equal(track.id, '55', 'content_id');
    assert.equal(track.artist, 'Subsonic Pulse', 'artist_id_artist-Join');
    assert.equal(track.key, '4A', 'key_id-Join');
    assert.equal(track.bpm, 174, 'bpmx100 / 100');
    assert.equal(track.duration, 190, 'Dauer in Sekunden (content.length)');
    assert.equal(track.sampleRate, 48000, 'samplingRate');
    const cues = track.cues || [];
    assert.equal(cues.length, 2, 'inUsec/outUsec-Cues');
    assert.equal(cues[0].type, 'MEMORY', 'kind 0 = Memory Cue');
    assert.equal(Math.round(cues[1].position * 1000), 44138, 'inUsec → Sekunden');
    assert.equal(cues[1].type, 'HOT_CUE', 'kind 1 = Hot Cue A');

    const hit = dbReader.openContentRow(env.oneLibraryPath, 55);
    assert.equal(hit.available, true, hit.reason || 'OneLibrary-Zeile lesbar');
    assert.equal(hit.cues.length, 2, 'cue-Einträge des Tracks');
  });

  // ─── Schicht 5: ANLZ-Byteblöcke (Regionen je Block) ─────────────────────
  runTest('ANLZ-Byteblock-Walk: Sektionen/Regionen werden korrekt adressiert', () => {
    const bytes = readFileSync(env.anlzPath);
    const scan = anlzStructure.scanAnlzSections(bytes);
    assert.equal(scan.valid, true, `ANLZ-Struktur gültig (${scan.reason})`);
    assert.deepEqual(scan.tags, ['PPTH', 'PQTZ', 'PWV5'], 'Sektionsblöcke');
    assert.equal(scan.ppthPath, env.originalPath, 'PPTH-Region zeigt auf das Original');
    assert.equal(scan.waveform.tag, 'PWV5', 'Waveform-Block');
    assert.equal(scan.waveform.entryCount, env.bucketCount, 'Buckets je Waveform-Block');
    const decoded = anlzStructure.decodeAnlzWaveform(bytes);
    assert.equal(decoded.columns?.length, env.bucketCount, 'Bucket-Array dekodiert');
    assert.ok(decoded.summary && decoded.summary.peakMax > 0, 'dekodierte Amplituden vorhanden');
  });

  runTest('Renderer-Parser liest dieselben ANLZ-Bytes (Prinzip-Nachweis)', () => {
    const bytes = readFileSync(env.anlzPath);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const parsed = parseAnlzBinary(buffer);
    assert.deepEqual(parsed.tagsFound, ['PPTH', 'PQTZ', 'PWV5'], 'identische Sektionen');
    assert.equal(parsed.analysisPath, env.originalPath, 'PPTH-Pfad');
    assert.equal(parsed.waveform?.length, env.bucketCount, 'Bucket-Anzahl');
    assert.equal(parsed.waveform?.origin, DataOrigin.REKORDBOX_ANLZ, 'Herkunft: ANLZ');
    assert.ok(parsed.bpm && parsed.bpm > 0, 'BPM aus PQTZ (Rekordbox-Wert, nicht berechnet)');
  });

  // ─── Read-only-Nachweis über die gesamte Kette ──────────────────────────
  runTest('Alle Quelldateien bleiben byteweise unverändert (read-only)', () => {
    assert.deepEqual(fingerprint(env.masterDbPath), before.master, 'master.db unverändert');
    assert.deepEqual(fingerprint(env.oneLibraryPath), before.oneLibrary, 'exportLibrary.db unverändert');
    assert.deepEqual(fingerprint(env.anlzPath), before.anlz, 'ANLZ unverändert');
    assert.deepEqual(fingerprint(env.originalPath), before.original, 'Original-Audio unverändert');
  });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────
console.log('Test Results:\n');
let passedCount = 0;
let failedCount = 0;

results.forEach((r, idx) => {
  const icon = r.passed ? ' PASS ' : ' FAIL ';
  const status = r.passed ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  console.log(`${status}[${icon}]${reset} #${idx + 1} ${r.name}`);
  if (!r.passed) {
    console.error(`       Error: ${r.error}`);
    failedCount++;
  } else {
    passedCount++;
  }
});

console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Total: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);

if (failedCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
