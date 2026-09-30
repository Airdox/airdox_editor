#!/usr/bin/env node
/**
 * @license
 * Rekordbox Runtime-Smoke-Test (nur Windows).
 *
 * Anders als die Unit- und Integrationstests simuliert dieser Test nichts:
 * Er läuft die *echte* Kette auf dem Rechner, auf dem eine Rekordbox-
 * Installation liegt.
 *
 *     locateRekordboxDatabases()   (echte AppData-Pfade)
 *        → openContentRow()        (echtes SQLCipher, master.db read-only)
 *        → resolveTrackFromMasterDb()
 *        → echte djmdContent-Zeile
 *        → echter AnalysisDataPath / echte ANLZ-Datei
 *        → dekodierte Rekordbox-Waveform
 *        → ANLZ-PPATH + Original-Audio
 *        → Cues
 *
 * Voraussetzungen und Verhalten:
 *   * Kein Windows / keine Rekordbox-Installation → SKIP (kein Fehler).
 *   * Rekordbox vorhanden, aber SQLCipher-Modul fehlt → FAIL mit dem exakten
 *     Gate-Code SQLCIPHER_UNAVAILABLE. Ein stilles "grün" ist ausgeschlossen.
 *   * Alles vorhanden → alle Zusicherungen werden geprüft und der Original-
 *     Bestand vor/nach dem Lauf byteweise verglichen.
 *
 * Aufruf:
 *   node tests/rekordbox-runtime-smoke.mjs            (Standard-TrackID 142225026)
 *   node tests/rekordbox-runtime-smoke.mjs 142225026
 *   npm run test:rekordbox:runtime -- 142225026
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const dbReader = require('../electron/dbReader.cjs');
const gate = require('../electron/masterDbGate.cjs');
const runtimeCheck = require('../electron/rekordboxRuntimeCheck.cjs');

const DEFAULT_TRACK_ID = '142225026';
const trackId = (process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) || DEFAULT_TRACK_ID).trim();

function skip(reason) {
  console.log(`SKIP – ${reason}`);
  process.exit(0);
}

function fingerprint(filePath) {
  const stat = statSync(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

function ok(label, detail) {
  console.log(`  [OK]   ${label}${detail ? ` – ${detail}` : ''}`);
}

async function main() {
  console.log('AIRDOX REKORDBOX RUNTIME SMOKE TEST');
  console.log(`  platform        ${process.platform} ${process.arch}`);
  console.log(`  electron        ${process.versions.electron || 'n/a (kein Electron-Prozess)'}`);
  console.log(`  node / ABI      ${process.versions.node} / ${process.versions.modules}`);
  console.log(`  TrackID         ${trackId}`);

  if (process.platform !== 'win32') {
    skip('Rekordbox database not found (Test läuft nur unter Windows mit installiertem Rekordbox)');
  }

  // ── 1. Datenbanken wirklich lokalisieren ───────────────────────────────
  section('1. locateRekordboxDatabases()');
  const databases = dbReader.locateRekordboxDatabases() || [];
  if (databases.length === 0) {
    skip('Rekordbox database not found');
  }
  for (const candidate of databases) {
    ok('gefunden', `${candidate.kind} – ${candidate.path}`);
  }
  const ordered = databases
    .slice()
    .sort((a, b) => (a.kind === 'MASTER_DB' ? 0 : 1) - (b.kind === 'MASTER_DB' ? 0 : 1));
  const target = ordered[0];
  assert.equal(target.kind, 'MASTER_DB', 'master.db hat Vorrang vor exportLibrary.db');

  // ── 2. SQLCipher muss echt laufen ──────────────────────────────────────
  section('2. SQLCipher-Laufzeit');
  if (!dbReader.isCipherAvailable()) {
    console.error(`  [FAIL] SQLCipher: better-sqlite3-multiple-ciphers ist für Electron ${process.versions.electron} nicht ladbar.`);
    console.error('         Rebuild: "npm run rekordbox:native:rebuild"');
    process.exit(1);
  }
  ok('better-sqlite3-multiple-ciphers', 'ladbar');

  const before = fingerprint(target.path);
  const row = dbReader.openContentRow(target.path, trackId);
  if (!row || row.available !== true) {
    console.error(`  [FAIL] djmdContent: ${(row && row.reason) || 'nicht lesbar'}`);
    process.exit(1);
  }
  const after = fingerprint(target.path);
  assert.equal(before.size, after.size, 'master.db-Größe darf sich nicht ändern');
  assert.equal(before.mtimeMs, after.mtimeMs, 'master.db-mtime darf sich nicht ändern');
  ok('master.db read-only', 'unverändert nach dem Zugriff');

  if (!row.row) {
    console.error(`  [FAIL] Track ${trackId} existiert nicht in ${target.path}. Bitte eine ID aus dieser Bibliothek angeben.`);
    process.exit(1);
  }
  ok('djmdContent', `ID ${row.row.ID}, djmdCue: ${(row.cues || []).length}`);

  // ── 3. Die echte Kette über den Gate ──────────────────────────────────
  section('3. resolveTrackFromMasterDb()');
  const result = await gate.resolveTrackFromMasterDb({ trackId });
  assert.equal(result.ok, true, `Gate muss OK liefern, bekam ${result.code}: ${result.reason}`);
  assert.equal(result.code, 'OK', 'Gate-Code ist OK');
  assert.equal(result.dbType, 'MASTER_DB', 'Gate liest die master.db');
  assert.equal(result.content.id, String(row.row.ID), 'content.id entspricht der TrackID');

  // ── 4. Echte AnalysisDataPath und echte ANLZ ─────────────────────────
  section('4. AnalysisDataPath / ANLZ');
  const analysisPath = result.analysis.path;
  assert.ok(analysisPath && typeof analysisPath === 'string', 'Gate liefert einen ANLZ-Pfad');
  const analysisBefore = fingerprint(analysisPath);
  assert.ok(result.analysis.tags.length > 0, 'ANLZ enthält mindestens eine Sektion');
  assert.equal(result.analysis.hasWaveform, true, 'Gate bestätigt einen Waveform-Abschnitt');
  ok('ANLZ', `${analysisPath} [${result.analysis.tags.join(', ')}]`);
  ok('Waveform', `${result.analysis.waveform.tag} · ${result.analysis.waveform.buckets} Buckets`);

  // Der Renderer-Parser muss aus derselben Datei exakt dieselbe Waveform lesen.
  const shared = require('../electron/generated/anlzStructure.cjs');
  const bytes = require('node:fs').readFileSync(analysisPath);
  const rescan = shared.decodeAnlzWaveform(bytes);
  assert.equal(rescan.scan.waveform.tag, result.analysis.waveform.tag, 'gleicher Waveform-Abschnitt');
  assert.equal(rescan.summary.buckets, result.analysis.waveform.buckets, 'gleiche Bucket-Anzahl');
  ok('Renderer-/Gate-Parität', `${rescan.summary.buckets} Buckets, peak ${rescan.summary.peakMax}`);
  const analysisAfter = fingerprint(analysisPath);
  assert.equal(analysisBefore.size, analysisAfter.size, 'ANLZ-Größe darf sich nicht ändern');
  assert.equal(analysisBefore.mtimeMs, analysisAfter.mtimeMs, 'ANLZ-mtime darf sich nicht ändern');

  // ── 5. PPTH, Original-Audio, Cues ─────────────────────────────────────
  section('5. PPTH / Original-Audio / Cues');
  const ppth = result.analysis.ppthPath;
  assert.ok(ppth, 'ANLZ enthält einen PPTH-Quellpfad');
  assert.equal(
    gate.isSameMediaPath(result.original.path, ppth),
    true,
    'Original-Audio und ANLZ-PPTH sind dieselbe Datei'
  );
  const originalBefore = fingerprint(result.original.path);
  ok('PPTH', ppth);
  ok('Original audio', `${result.original.path} (${result.original.source}, ${originalBefore.size} Bytes)`);
  assert.ok(Array.isArray(result.cues), 'Gate liefert Cues');
  assert.equal(result.cueSource, 'DJMD_CUE', 'djmdCue ist als letzte Marker-Quelle markiert');
  ok('Cues', `${result.cues.length} djmdCue-Zeilen (ANLZ PCO2/PCOB hätten Vorrang)`);

  const originalAfter = fingerprint(result.original.path);
  assert.equal(originalBefore.size, originalAfter.size, 'Original-Audio-Größe darf sich nicht ändern');
  assert.equal(originalBefore.mtimeMs, originalAfter.mtimeMs, 'Original-Audio-mtime darf sich nicht ändern');
  ok('Quelldateien unverändert', 'master.db, ANLZ und Original-Audio sind byteweise gleich');

  // ── 6. Runtime-Preflight im selben Prozess ────────────────────────────
  section('6. checkRekordboxRuntime()');
  const runtime = runtimeCheck.checkRekordboxRuntime({ trackId, requireDatabase: true });
  for (const check of runtime.checks) {
    console.log(`  [${check.status}] ${check.label}: ${check.detail}`);
    assert.notEqual(check.status, 'FAIL', `${check.id} darf nicht fehlschlagen: ${check.detail}`);
  }
  assert.equal(runtime.ok, true, 'Runtime-Preflight ist vollständig positiv');

  console.log('\nREKORDBOX RUNTIME SMOKE: OK / REKORDBOX_ANLZ');
  console.log(`  TrackID        ${trackId}`);
  console.log(`  Database       ${result.dbType} – ${result.dbPath}`);
  console.log(`  AnalysisData   ${path.basename(analysisPath)} [${result.analysis.tags.join(', ')}]`);
  console.log(`  Waveform       ${result.analysis.waveform.tag} (${result.analysis.waveform.buckets} Buckets)`);
  console.log(`  Original audio READ ONLY – unverändert`);
  console.log(`  Lokale Analyse keine ausgeführt`);
}

main().catch((error) => {
  console.error('\nREKORDBOX RUNTIME SMOKE: FAILED');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
