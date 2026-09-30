#!/usr/bin/env node
/**
 * @license
 * AIRDOX REKORDBOX GATE DOCTOR
 *
 * Echte Diagnose der verbindlichen Ladekette auf dem aktuellen Rechner:
 *
 *   Rekordbox-Datenbanken lokalisieren (master.db hat Vorrang)
 *     → SQLCipher-Verfügbarkeit
 *     → djmdContent-Schema
 *     → TrackID in der Datenbank
 *     → AnalysisDataPath
 *     → ANLZ-Struktur
 *     → dekodierte Rekordbox-Waveform
 *     → ANLZ-PPATH
 *     → Original-Audio
 *     → FINAL
 *
 * Der Doctor ist ausschließlich lesend: er öffnet master.db read-only, liest
 * genau eine djmdContent-Zeile und liest die ANLZ-Datei. Es wird nichts
 * geschrieben, angelegt, umbenannt oder gelöscht – weder in Rekordbox-
 * Datenbanken noch in der Bibliothek.
 *
 * Aufruf:
 *   npm run rekordbox:doctor -- 142225026
 *   node scripts/rekordbox-gate-doctor.mjs --trackid 142225026 --json
 */

import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const dbReader = require('../electron/dbReader.cjs');
const gate = require('../electron/masterDbGate.cjs');
const runtimeCheck = require('../electron/rekordboxRuntimeCheck.cjs');

const DEFAULT_TRACK_ID = '142225026';

function parseArgs(argv) {
  const options = { trackId: DEFAULT_TRACK_ID, json: false, skipRuntime: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--no-runtime') options.skipRuntime = true;
    else if (arg === '--trackid') options.trackId = argv[++i] || DEFAULT_TRACK_ID;
    else if (arg.startsWith('--trackid=')) options.trackId = arg.slice('--trackid='.length);
    else if (/^\d+$/.test(arg)) options.trackId = arg;
  }
  options.trackId = String(options.trackId || DEFAULT_TRACK_ID).trim();
  return options;
}

const INDENT = '  ';

class Report {
  constructor() {
    this.lines = [];
  }

  header(text) {
    this.lines.push(String(text));
    return this;
  }

  blank() {
    this.lines.push('');
    return this;
  }

  add(label, value) {
    this.lines.push(`${label}:`);
    this.lines.push(...indentLines(value === undefined || value === null || value === '' ? '-' : String(value)));
    return this;
  }

  render() {
    return this.lines.join('\n');
  }

  toJSON() {
    return this.lines;
  }
}

function indentLines(text) {
  return String(text)
    .split('\n')
    .map((line) => `${INDENT}${line}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = new Report();
  const summary = { trackId: options.trackId, code: null, dbPath: null, dbType: null };

  report.header('AIRDOX REKORDBOX GATE DOCTOR').blank();

  // ── 0. Runtime-Preflight (Electron-Version, natives Modul, Readonly-DB) ──
  if (!options.skipRuntime) {
    const runtime = runtimeCheck.checkRekordboxRuntime({ trackId: options.trackId });
    report.add('Runtime preflight', runtime.ok ? 'OK' : 'FAILED');
    for (const check of runtime.checks) {
      if (check.status === 'OK' && !options.verbose) continue;
      report.add(`  ${check.label}`, `[${check.status}] ${check.detail}`);
    }
    report.blank();
  }

  report.add('TrackID', options.trackId);
  report.blank();

  // ── 1. Datenbanken lokalisieren (master.db priorisiert) ────────────────
  let databases = [];
  try {
    databases = dbReader.locateRekordboxDatabases() || [];
  } catch (error) {
    databases = [];
    report.add('Database', `Suche fehlgeschlagen: ${error.message || error}`);
  }
  const ordered = databases
    .slice()
    .sort((a, b) => (a && a.kind === 'MASTER_DB' ? 0 : 1) - (b && b.kind === 'MASTER_DB' ? 0 : 1));
  const target = ordered[0] || null;
  summary.dbPath = target ? target.path : null;
  summary.dbType = target ? target.kind || null : null;

  if (!target) {
    report.add('Database', 'NOT FOUND – keine master.db / exportLibrary.db gefunden');
    report.add('Database type', '-');
    report.add('SQLCipher', dbReader.isCipherAvailable() ? 'OK (aber keine Datenbank)' : 'UNAVAILABLE');
    report.add('FINAL', 'FAILED / MASTER_DB_NOT_FOUND');
    return finish(report, summary, options);
  }
  report.add('Database', target.path);
  report.add('Database type', summary.dbType || 'UNKNOWN');
  report.add('', '');

  // ── 2. SQLCipher ───────────────────────────────────────────────────────
  if (!dbReader.isCipherAvailable()) {
    report.add('SQLCipher', 'UNAVAILABLE – better-sqlite3-multiple-ciphers fehlt oder passt nicht zur Electron-ABI');
    report.add('FINAL', 'FAILED / SQLCIPHER_UNAVAILABLE');
    return finish(report, summary, options);
  }
  report.add('SQLCipher', 'OK');
  report.blank();

  // ── 3./4. djmdContent-Schema + Track ───────────────────────────────────
  const row = dbReader.openContentRow(target.path, options.trackId);
  if (!row || row.available !== true) {
    report.add('djmdContent', row && row.schemaInvalid ? 'INVALID' : 'UNREADABLE');
    report.add('djmdContent detail', (row && row.reason) || 'unbekannt');
    report.add('FINAL', `FAILED / ${row && row.schemaInvalid ? 'MASTER_DB_SCHEMA_INVALID' : 'MASTER_DB_OPEN_FAILED'}`);
    return finish(report, summary, options);
  }
  report.add('djmdContent', 'OK');
  report.add('Track', row.row ? 'FOUND' : 'NOT FOUND');
  if (!row.row) {
    report.add('FINAL', 'FAILED / TRACK_NOT_FOUND_IN_MASTER_DB');
    return finish(report, summary, options);
  }
  report.add('  ID', String(row.row.ID ?? options.trackId));
  report.add('  Title', String(row.row.Title ?? '-'));
  report.add('  FolderPath', String(row.row.FolderPath ?? '-'));
  report.add('  FileNameL', String(row.row.FileNameL ?? '-'));
  report.add('  djmdCue rows', String((row.cues || []).length));
  report.blank();

  // ── 5. Vollständige Kette über den echten Gate ─────────────────────────
  const result = await gate.resolveTrackFromMasterDb({ trackId: options.trackId });
  summary.code = result.code;

  report.add('AnalysisDataPath', String(row.row.AnalysisDataPath || '-'));
  if (result.ok) {
    report.add('ANLZ', 'FOUND');
    report.add('ANLZ structure', `OK [${result.analysis.tags.join(', ')}]`);
    report.add('Waveform', `${result.analysis.waveform.tag} (${result.analysis.waveform.buckets} Buckets, peak ${result.analysis.waveform.peakMax})`);
    report.add('PPTH', result.analysis.ppthPath || '-');
    report.add('Original audio', `FOUND (${result.original.source})`);
    report.blank();
    report.add('  Original path', result.original.path);
    report.add('  Audio access', 'READ ONLY');
    report.add('  Cues', `${(result.cues || []).length} aus ${result.cueSource} (ANLZ PCO2/PCOB haben Vorrang)`);
    report.blank();
    report.add('FINAL', 'OK / REKORDBOX_ANLZ');
  } else {
    report.add('ANLZ', result.code === 'ANLZ_NOT_FOUND' ? 'NOT FOUND' : 'FAILED');
    report.add('ANLZ structure', result.code);
    report.add('Waveform', '-');
    report.add('PPTH', result.analysis?.ppthPath || result.ppthPath || '-');
    report.add('Original audio', result.code === 'ORIGINAL_AUDIO_NOT_FOUND' ? 'NOT FOUND' : '-');
    report.blank();
    report.add('Reason', result.reason || '-');
    for (const entry of result.rejected || []) {
      report.add('  rejected', `${entry.path} (${entry.source}): ${entry.reason}`);
    }
    report.blank();
    report.add('FINAL', `FAILED / ${result.code}`);
  }

  return finish(report, summary, options);
}

function finish(report, summary, options) {
  if (options.json) {
    console.log(JSON.stringify({ ...summary, lines: report.toJSON() }, null, 2));
  } else {
    console.log(report.render());
  }
  if (runtimeHintNeeded(summary)) {
    console.error(
      '\nHinweis: Der Build muss das native Modul für die verwendete Electron-Version mitführen.\n' +
      '  npm run rekordbox:native:rebuild   (Entwicklung)\n' +
      '  npm run package:win                (Windows-Paket, Rebuild + Preflight automatisch)'
    );
  }
  process.exitCode = summary.code === 'OK' ? 0 : 1;
}

function runtimeHintNeeded(summary) {
  return summary.code === 'SQLCIPHER_UNAVAILABLE' || summary.code === 'MASTER_DB_NOT_FOUND';
}

main().catch((error) => {
  console.error('AIRDOX REKORDBOX GATE DOCTOR');
  console.error(`  Unerwarteter Fehler: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
