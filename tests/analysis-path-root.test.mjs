/**
 * @license
 * Analysis-Data-Root-Auflösung (editor_patch/analysisPath.cjs).
 *
 * `djmdContent.AnalysisDataPath` ist relativ zum Rekordbox-Analysis-Data-Root
 * gespeichert (`analysis-data-root-path` aus rekordboxAgent/options.json,
 * z. B. D:\PIONEER\Master\share) – nicht relativ zum PIONEER-Root
 * D:\PIONEER. Geprüft werden:
 *
 *   1. options.json (Array-Form) liefert den Analysis-Root mit Vorrang,
 *   2. options.json (Objekt-Form) wird ebenfalls verstanden,
 *   3. der ENV-Override AIRODOX_REKORDBOX_ANALYSIS_ROOT ist exakt/fail-closed,
 *   4. vollständige Laufwerkspfade bleiben exakt erhalten (kein Umschreiben),
 *   5. die Reihenfolge: ENV → options.json → Datenbank-Root → Share → D:\PIONEER,
 *   6. eine fehlende ANLZ ist ein Fehlercode (ANLZ_NOT_FOUND) – nie ein
 *      Rückfall auf eine andere Datei oder eine eigene Berechnung,
 *   7. ausschließlich lesende Zugriffe (keine Schreib-API im Modul),
 *   8. der Master-DB-Gate benutzt genau dieses Modul.
 *
 * Run with: node tests/analysis-path-root.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const analysisPath = require('../editor_patch/analysisPath.cjs');
const gate = require('../electron/masterDbGate.cjs');

const B = '\\';
const win = (value) => value.replace(/\//g, B);
const ANALYSIS_ROOT = win('D:/PIONEER/Master/share');
const RELATIVE = '/PIONEER/USBANLZ/PQT000055.DAT';
const EXPECTED = win('D:/PIONEER/Master/share/PIONEER/USBANLZ/PQT000055.DAT');
const normalize = (value) => String(value).replace(/\\/g, '/').toLowerCase();

const checks = [];
const ok = (label) => checks.push(label);

const work = mkdtempSync(path.join(os.tmpdir(), 'airdox-analysis-root-'));

async function withAppData(optionsJson, fn) {
  const appDataRoot = path.join(work, `appdata-${checks.length}-${Math.random().toString(36).slice(2)}`);
  const storageDir = path.join(appDataRoot, 'Pioneer', 'rekordboxAgent', 'storage');
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(path.join(storageDir, 'options.json'), JSON.stringify(optionsJson));
  const previous = process.env.APPDATA;
  process.env.APPDATA = appDataRoot;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
  }
}

const previousEnvRoot = process.env.AIRODOX_REKORDBOX_ANALYSIS_ROOT;
delete process.env.AIRODOX_REKORDBOX_ANALYSIS_ROOT;

// ─── 1. options.json (Array-Form) liefert den Analysis-Root ────────────────
{
  const candidates = await withAppData(
    { options: [['db-path', win('D:/PIONEER/Master')], ['analysis-data-root-path', ANALYSIS_ROOT]] },
    () => analysisPath.buildAnalysisPathCandidates(RELATIVE, { databasePath: win('D:/PIONEER/Master/master.db') })
  );
  assert.equal(normalize(candidates[0]), normalize(EXPECTED), `expected ${EXPECTED}, got ${candidates[0]}`);
  ok('analysis-data-root-path aus options.json löst /PIONEER/… auf');
}

// ─── 2. options.json (Objekt-Form) ─────────────────────────────────────────
{
  const options = await withAppData(
    { 'analysis-data-root-path': ANALYSIS_ROOT },
    () => analysisPath.readRekordboxOptions({ databasePath: win('D:/PIONEER/Master/master.db') })
  );
  assert.equal(options.analysisDataRootPath, ANALYSIS_ROOT, 'Objekt-Form wird gelesen');
  ok('options.json in Objekt-Form wird verstanden');
}

// ─── 3. ENV-Override ist exakt und hat Vorrang ─────────────────────────────
{
  const override = win('E:/OtherLibrary/share');
  process.env.AIRODOX_REKORDBOX_ANALYSIS_ROOT = override;
  try {
    const candidates = await withAppData(
      { options: [['analysis-data-root-path', ANALYSIS_ROOT]] },
      () => analysisPath.buildAnalysisPathCandidates(RELATIVE, { databasePath: win('D:/PIONEER/Master/master.db') })
    );
    assert.equal(normalize(candidates[0]), normalize(win('E:/OtherLibrary/share/PIONEER/USBANLZ/PQT000055.DAT')));
    ok('AIRODOX_REKORDBOX_ANALYSIS_ROOT hat Vorrang (Diagnose/Override)');
  } finally {
    delete process.env.AIRODOX_REKORDBOX_ANALYSIS_ROOT;
  }
}

// ─── 4. Vollständige Laufwerkspfade bleiben exakt erhalten ─────────────────
{
  const absolute = win('C:/Pioneer/rekordbox7/analysis/PQT000000.DAT');
  const candidates = await withAppData(
    { options: [['analysis-data-root-path', ANALYSIS_ROOT]] },
    () => analysisPath.buildAnalysisPathCandidates(absolute, { databasePath: win('D:/PIONEER/Master/master.db') })
  );
  assert.deepEqual(candidates.map(normalize), [normalize(absolute)], 'ein aufgeschriebener Pfad wird nicht umgeschrieben');
  ok('Absoluter AnalysisDataPath bleibt unverändert (kein Umschreiben)');
}

// ─── 5. Reihenfolge der Wurzeln ────────────────────────────────────────────
{
  // a) Bibliothek unter D:\PIONEER: Datenbank-Root == D:\PIONEER (doppelfrei).
  const roots = await withAppData(
    { options: [['analysis-data-root-path', ANALYSIS_ROOT]] },
    () => analysisPath.analysisRootCandidates({ databasePath: win('D:/PIONEER/Master/master.db') })
  );
  const sources = roots.map((root) => root.source);
  assert.equal(sources[0], 'OPTIONS_ANALYSIS_ROOT', `options.json zuerst, got ${sources.join(', ')}`);
  assert.ok(sources.includes('DATABASE_ROOT'), `Datenbank-Root bleibt Rückfall, got ${sources.join(', ')}`);
  assert.ok(
    sources.indexOf('OPTIONS_ANALYSIS_ROOT') < sources.indexOf('DATABASE_ROOT'),
    'D:\\PIONEER (Datenbank-Root) steht hinter dem Analysis-Root'
  );
  assert.ok(
    normalize(roots[0].path) === normalize(win('D:/PIONEER/Master/share/PIONEER')),
    `erste Wurzel ist <analysis-root>/PIONEER, got ${roots[0].path}`
  );

  // b) Bibliothek ohne PIONEER im Pfad: D:\PIONEER ist der letzte Rückfall.
  const foreignRoots = await withAppData(
    { options: [['analysis-data-root-path', ANALYSIS_ROOT]] },
    () => analysisPath.analysisRootCandidates({ databasePath: win('C:/Rekordbox/master.db') })
  );
  const foreignSources = foreignRoots.map((root) => root.source);
  assert.equal(foreignSources[0], 'OPTIONS_ANALYSIS_ROOT', 'Analysis-Root hat auch hier Vorrang');
  assert.ok(!foreignSources.includes('DATABASE_ROOT'), 'ohne PIONEER im Datenbankpfad gibt es keinen DB-Root');
  assert.equal(foreignSources[foreignSources.length - 1], 'LEGACY_EXPORT_ROOT', 'D:\\PIONEER ist nur der letzte Rückfall');
  ok('Reihenfolge: options.json → Datenbank-Root → Share → D:\\PIONEER (zuletzt)');
}

// ─── 6. Fehlende ANLZ ist ein Fehlercode, kein Rückfall ────────────────────
{
  const rowAnalysisPath = '/PIONEER/USBANLZ/PQT000999.DAT';
  const result = await withAppData(
    { options: [['analysis-data-root-path', ANALYSIS_ROOT]] },
    () => gate.resolveTrackFromMasterDb(
    { trackId: '142225026' },
    {
      locateRekordboxDatabases: async () => [
        { path: win('D:/PIONEER/Master/master.db'), kind: 'MASTER_DB', label: 'master.db' },
      ],
      isCipherAvailable: () => true,
      openContentRow: async (dbPath, trackId) => ({
        available: true,
        dbType: 'MASTER_DB',
        row: {
          ID: trackId,
          Title: 'Skirmish (Original Mix)',
          FolderPath: win('C:/Music/Andreas Henneberg'),
          FileNameL: 'Skirmish (Original Mix).mp3',
          AnalysisDataPath: rowAnalysisPath,
        },
        cues: [],
      }),
      // Nichts existiert: die ANLZ ist an keinem Kandidaten erreichbar.
      stat: async (target) => {
        const error = new Error(`ENOENT: ${target}`);
        error.code = 'ENOENT';
        throw error;
      },
      readFile: async (target) => {
        throw new Error(`must not read: ${target}`);
      },
    })
  );
  assert.equal(result.ok, false, 'fehlende ANLZ ist kein Erfolg');
  assert.equal(result.code, 'ANLZ_NOT_FOUND', 'harter Fehlercode statt Ersatz');
  assert.match(
    result.reason,
    /Master\\share\\PIONEER|Master\/share\/PIONEER/,
    'der geprüfte Pfad liegt unter analysis-data-root-path'
  );
  assert.match(result.reason, /geprüft|prüft|USBANLZ/, 'die Begründung nennt die geprüften Kandidaten');
  ok('Fehlende ANLZ → ANLZ_NOT_FOUND, keine Ersatzdatei und keine Berechnung');
}

// ─── 7. Ausschließlich lesend ──────────────────────────────────────────────
{
  const source = readFileSync(new URL('../editor_patch/analysisPath.cjs', import.meta.url), 'utf8');
  for (const forbidden of [
    'writeFileSync',
    'appendFileSync',
    'mkdirSync',
    'rmSync',
    'unlinkSync',
    'createWriteStream',
    'openSync',
  ]) {
    assert.ok(!source.includes(`${forbidden}(`), `${forbidden} darf im Resolver nicht vorkommen`);
  }
  ok('Resolver enthält keine Schreib-API (rein lesend)');
}

// ─── 8. Der Gate benutzt dieses Modul ──────────────────────────────────────
{
  const gateSource = readFileSync(new URL('../electron/masterDbGate.cjs', import.meta.url), 'utf8');
  assert.ok(
    gateSource.includes("require('../editor_patch/analysisPath.cjs')"),
    'masterDbGate bindet editor_patch/analysisPath.cjs ein'
  );
  assert.ok(
    gateSource.includes('analysisPath.analysisRootCandidates'),
    'masterDbGate löst die Wurzeln über das Modul auf'
  );
  ok('Master-DB-Gate ist an editor_patch/analysisPath.cjs angebunden');
}

rmSync(work, { recursive: true, force: true });
if (previousEnvRoot !== undefined) process.env.AIRODOX_REKORDBOX_ANALYSIS_ROOT = previousEnvRoot;

console.log(`analysis-path-root: ${checks.length} Wege der Analysis-Pfad-Auflösung geprüft`);
for (const line of checks) console.log(`  ✓ ${line}`);
