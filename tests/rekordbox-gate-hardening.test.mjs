/**
 * @license
 * Master-DB-Gate Härtung (Phase 5/6) – Zustandsmaschine, Quellenkonsistenz,
 * Paketierung und Leseschutz.
 *
 * Ergänzt tests/master-db-gate.test.mjs (Grundzustände) um alles, was die
 * Runtime-Härtung hinzugefügt hat:
 *
 *   * die beiden neuen Gate-Codes ANLZ_WAVEFORM_UNREADABLE und
 *     ANLZ_SOURCE_MISMATCH,
 *   * `file://localhost//contents_…` (Rekordbox-Gerätepfad) als *verworfener*
 *     Kandidat,
 *   * veraltete XML-Locations, PPTH-Vorrang und Widerspruch zum Original,
 *   * den Nachweis, dass Gate, dbReader, ANLZ-Spiegel, Preflight, Doctor und
 *     Renderer-Parser keine Schreib-API enthalten,
 *   * die Paketierungs-Verträge (Abhängigkeit, npmRebuild, beforePack/afterPack),
 *   * das Verbot von Fallback-Analyse im Renderer-Ladepfad.
 *
 * Run with: node tests/rekordbox-gate-hardening.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFile(`${root}${relative}`.replace(/\/+/g, '/'), 'utf8');

const gate = require('../electron/masterDbGate.cjs');
const dbReader = require('../electron/dbReader.cjs');
const runtimeCheck = require('../electron/rekordboxRuntimeCheck.cjs');
const {
  GATE_CODES,
  resolveTrackFromMasterDb,
  isDeviceInternalLocation,
  normalizeMediaPath,
  isSameMediaPath,
} = gate;

const TRACK_ID = '142225026';
const checks = [];
function ok(label) {
  checks.push(label);
}

// ─── Fixtures ───────────────────────────────────────────────────────────
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

const at = (sectionOffset) => sectionOffset - 12;

function ppthSection(pathValue) {
  const encoded = Buffer.from(
    [...pathValue].flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff]).concat([0, 0])
  );
  const body = Buffer.alloc(4 + encoded.length);
  body.writeUInt32BE(encoded.length, 0);
  encoded.copy(body, 4);
  return section('PPTH', body, 0x10);
}

function pwv5Section(entryCount = 96, fill = 0xff, entryBytes = 2) {
  const body = Buffer.alloc(0x18 + entryBytes * entryCount, fill);
  body.writeUInt32BE(entryBytes, at(0x0c));
  body.writeUInt32BE(entryCount, at(0x10));
  body.writeUInt32BE(0, at(0x14));
  return section('PWV5', body, 0x18);
}

const GOOD_ANLZ = Buffer.concat([pmaiHeader(), pwv5Section()]);
const DEVICE_LOCATION =
  'file://localhost//contents_4136090260/unknownartist/unknownalbum/andreas%20henneberg%20%20skirmish%20original%20mix.mp3';

function makeRow(overrides = {}) {
  return {
    ID: TRACK_ID,
    Title: 'Andreas Henneberg  Skirmish Original Mix',
    FolderPath: 'C:\\Music\\Andreas Henneberg',
    FileNameL: 'Skirmish (Original Mix).mp3',
    AnalysisDataPath: 'C:\\Pioneer\\rekordbox7\\analysis\\PQT000000.DAT',
    ...overrides,
  };
}

function enoent(target) {
  const error = new Error(`ENOENT: ${target}`);
  error.code = 'ENOENT';
  return error;
}

/**
 * `stat` liefert für existierende Pfade eine Datei. `existing` steuert, welche
 * Pfade es gibt; alles andere ist ENOENT.
 */
function fakeStat(existing) {
  const norm = (value) => String(value).replace(/\\/g, '/').toLowerCase();
  const list = existing.map(norm);
  return async (target) => {
    const value = String(target);
    if (list.includes(norm(value))) return { isFile: () => true, size: 10_223_409, mtimeMs: 7 };
    throw enoent(value);
  };
}

function makeDeps(overrides = {}) {
  return {
    locateRekordboxDatabases: async () => [
      { path: 'C:\\Pioneer\\rekordbox7\\master.db', kind: 'MASTER_DB', label: 'master.db' },
    ],
    isCipherAvailable: () => true,
    openContentRow: async () => ({
      available: true,
      dbType: 'MASTER_DB',
      row: makeRow(),
      cues: [{ ID: '1', ContentID: TRACK_ID, Kind: 1, InMsec: 15000, OutMsec: -1 }],
    }),
    stat: fakeStat([
      'C:/Pioneer/rekordbox7/analysis/PQT000000.DAT',
      'C:/Music/Andreas Henneberg/Skirmish (Original Mix).mp3',
    ]),
    readFile: async () => GOOD_ANLZ,
    ...overrides,
  };
}

// ─── 1. Vollständige Zustandsmaschine ───────────────────────────────────
{
  const EXPECTED = [
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
  assert.deepEqual([...GATE_CODES].sort(), [...EXPECTED].sort(), 'alle 13 Gate-Codes sind dokumentiert');
  ok(`Zustandsmaschine: ${GATE_CODES.length} Codes`);
}

// ─── 2. REKORDBOX_WAVEFORM_MISSING: kein Waveform-Abschnitt ─────────────
{
  const noWaveform = Buffer.concat([pmaiHeader(), section('PQTZ', Buffer.alloc(64, 1), 0x18)]);
  const result = await resolveTrackFromMasterDb(
    { trackId: TRACK_ID },
    makeDeps({ readFile: async () => noWaveform })
  );
  assert.equal(result.code, 'REKORDBOX_WAVEFORM_MISSING');
  ok('REKORDBOX_WAVEFORM_MISSING (kein PWV-Abschnitt)');
}

// ─── 3. ANLZ_WAVEFORM_UNREADABLE: Layout nicht lesbar ───────────────────
{
  const broken = Buffer.concat([pmaiHeader(), section('PWV5', Buffer.alloc(48, 0x80), 0x18)]);
  const result = await resolveTrackFromMasterDb(
    { trackId: TRACK_ID },
    makeDeps({ readFile: async () => broken })
  );
  assert.equal(result.code, 'ANLZ_WAVEFORM_UNREADABLE', 'PWV5-Tag mit unlesbarem Layout wird abgelehnt');
  ok('ANLZ_WAVEFORM_UNREADABLE (Layout unlesbar)');
}

// ─── 4. ANLZ_WAVEFORM_UNREADABLE: Waveform ohne Amplituden ─────────────
{
  const silent = Buffer.concat([pmaiHeader(), pwv5Section(64, 0x00)]);
  const result = await resolveTrackFromMasterDb(
    { trackId: TRACK_ID },
    makeDeps({ readFile: async () => silent })
  );
  assert.equal(result.code, 'ANLZ_WAVEFORM_UNREADABLE', 'eine Welleform aus lauter Nullen ist keine Waveform');
  ok('ANLZ_WAVEFORM_UNREADABLE (0 Amplituden-Buckets)');
}

// ─── 5. ANLZ_SOURCE_MISMATCH: PPTH zeigt auf eine andere Datei ──────────
{
  const other = Buffer.concat([
    pmaiHeader(),
    ppthSection('C:\\Music\\Anderer\\Anderer Track.mp3'),
    pwv5Section(),
  ]);
  const result = await resolveTrackFromMasterDb(
    { trackId: TRACK_ID },
    makeDeps({ readFile: async () => other })
  );
  assert.equal(result.code, 'ANLZ_SOURCE_MISMATCH', 'fremde PPTH-Quelle wird nicht stillschweigend ersetzt');
  assert.ok(String(result.reason).includes('Anderer Track.mp3'), 'der Grund nennt die PPTH-Quelle');
  assert.equal(result.ppthPath, 'C:\\Music\\Anderer\\Anderer Track.mp3', 'der PPTH-Pfad wird gemeldet');
  ok('ANLZ_SOURCE_MISMATCH (PPTH ≠ gewähltes Original)');
}

// ─── 6. ANLZ_SOURCE_MISMATCH: PPTH existiert nirgends ───────────────────
{
  const missing = Buffer.concat([pmaiHeader(), ppthSection('C:\\Elsewhere\\gone.mp3'), pwv5Section()]);
  const result = await resolveTrackFromMasterDb(
    { trackId: TRACK_ID },
    makeDeps({
      readFile: async () => missing,
      openContentRow: async () => ({
        available: true,
        dbType: 'MASTER_DB',
        row: makeRow({ FolderPath: '', FileNameL: '' }),
        cues: [],
      }),
    })
  );
  assert.equal(result.code, 'ORIGINAL_AUDIO_NOT_FOUND');
  ok('ORIGINAL_AUDIO_NOT_FOUND (PPTH und master.db ohne Treffer)');
}

// ─── 7. PPTH hat Vorrang, wenn es einen existierenden Kandidaten trifft ─
{
  const moved = Buffer.concat([
    pmaiHeader(),
    ppthSection('C:\\Moved\\Library\\Skirmish (Original Mix).mp3'),
    pwv5Section(),
  ]);
  const result = await resolveTrackFromMasterDb(
    { trackId: TRACK_ID, mediaPath: 'file://localhost/C:/Music/Alt/Skirmish.mp3' },
    makeDeps({
      readFile: async () => moved,
      stat: fakeStat([
        'C:/Pioneer/rekordbox7/analysis/PQT000000.DAT',
        'C:/Music/Andreas Henneberg/Skirmish (Original Mix).mp3',
        'C:/Music/Alt/Skirmish.mp3',
        'C:/Moved/Library/Skirmish (Original Mix).mp3',
      ]),
    })
  );
  assert.equal(result.ok, true, `erwartet OK, bekam ${result.code}: ${result.reason}`);
  assert.equal(result.original.path, 'C:\\Moved\\Library\\Skirmish (Original Mix).mp3', 'PPTH gewinnt');
  assert.ok(isSameMediaPath(result.original.path, result.analysis.ppthPath), 'PPTH-Konsistenz bestätigt');
  ok('PPTH-Vorrang vor XML-Location und master.db');
}

// ─── 8. Geräte-interne XML-Location wird nie geladen ───────────────────
{
  const result = await resolveTrackFromMasterDb(
    { trackId: TRACK_ID, mediaPath: DEVICE_LOCATION },
    makeDeps()
  );
  assert.equal(result.ok, true, `erwartet OK, bekam ${result.code}: ${result.reason}`);
  assert.equal(result.original.path, 'C:\\Music\\Andreas Henneberg\\Skirmish (Original Mix).mp3');
  assert.notEqual(result.original.path, DEVICE_LOCATION, 'der Gerätepfad ist nicht das Original');
  const rejected = result.rejected.find((entry) => entry.source === 'XML_LOCATION');
  assert.ok(rejected, 'der Gerätepfad steht als verworfen in der Diagnose');
  assert.ok(/Gerätepfad/.test(rejected.reason), 'mit verständlichem Grund');
  ok(`file://localhost//contents_… wird verworfen (${rejected.reason.slice(0, 40)}…)`);
}

// ─── 9. Veraltete XML-Location (Datei existiert nicht mehr) ─────────────
{
  const result = await resolveTrackFromMasterDb(
    { trackId: TRACK_ID, mediaPath: 'file://localhost/C:/Alte/Bibliothek/Skirmish.mp3' },
    makeDeps()
  );
  assert.equal(result.ok, true, 'eine veraltete XML-Location verhindert den Import nicht');
  assert.equal(result.original.source, 'MASTER_DB', 'master.db löst die veraltete Location auf');
  assert.equal(result.original.xmlLocation, 'file://localhost/C:/Alte/Bibliothek/Skirmish.mp3', 'bleibt diagnostisch erhalten');
  ok('veraltete XML-Location → master.db-Fallback (mit Diagnoseeintrag)');
}

// ─── 10. Pfad-Helfer ────────────────────────────────────────────────────
{
  assert.equal(isDeviceInternalLocation(DEVICE_LOCATION), true, 'Gerätepfad erkannt');
  assert.equal(isDeviceInternalLocation('file://localhost/C:/Music/x.mp3'), false, 'Laufwerkspfad ist kein Gerätepfad');
  assert.equal(isDeviceInternalLocation('C:/Music/x.mp3'), false);
  assert.equal(isDeviceInternalLocation(undefined), false);
  assert.equal(
    normalizeMediaPath('file://localhost//contents_1/a.mp3'),
    '/contents_1/a.mp3',
    'file://-URL wird normalisiert'
  );
  assert.equal(normalizeMediaPath('C:\\Music\\A\\B.mp3'), 'c:/music/a/b.mp3', 'Windows-Pfad wird kleingeschrieben');
  assert.equal(isSameMediaPath('C:\\Music\\A\\B.mp3', 'c:/music/a/b.mp3'), true, 'Backslash/Case egal');
  assert.equal(isSameMediaPath('C:/Music/A.mp3', 'C:/Music/B.mp3'), false);
  assert.equal(isSameMediaPath(undefined, 'C:/Music/B.mp3'), false, 'fehlender Pfad ist nie gleich');
  ok('Pfad-Helfer (Gerätepfad, Normalisierung, Gleichheit)');
}

// ─── 11. Ergebnis trägt den Nachweis der Welleform ──────────────────────
{
  const result = await resolveTrackFromMasterDb({ trackId: TRACK_ID }, makeDeps());
  assert.equal(result.ok, true, `erwartet OK, bekam ${result.code}: ${result.reason}`);
  assert.equal(result.analysis.waveform.tag, 'PWV5', 'der konkrete Waveform-Abschnitt wird genannt');
  assert.equal(result.analysis.waveform.buckets, 96, 'Bucket-Anzahl wird genannt');
  assert.ok(result.analysis.waveform.peakMax > 0, 'dekodierte Amplitudenhöhe wird genannt');
  assert.equal(result.cueSource, 'DJMD_CUE', 'djmdCue ist als letzte Marker-Quelle markiert');
  assert.equal(result.cues.length, 1, 'djmdCue-Zeilen werden mitgeliefert');
  assert.equal(result.analysis.ppthPath, undefined, 'ohne PPTH wird nichts erfunden');
  ok('Gate-Ergebnis enthält Waveform-Nachweis, PPTH und Cue-Quelle');
}

// ─── 12. Keine Schreib-API in irgendeinem Modul des Ladepfads ──────────
{
  const FORBIDDEN = /\bwriteFileSync\b|\bwriteFile\s*\(|\bappendFile|\bunlinkSync\b|\bunlink\s*\(|\brmSync\b|\brmdirSync\b|\btruncateSync\b|\btruncate\s*\(|\bcreateWriteStream\b|\bopenSync\s*\([^)]*['"][wa]\+?['"]/;
  const files = [
    'electron/masterDbGate.cjs',
    'electron/dbReader.cjs',
    'electron/rekordboxRuntimeCheck.cjs',
    'electron/generated/anlzStructure.cjs',
    'scripts/rekordbox-gate-doctor.mjs',
    'scripts/rekordbox-preflight.mjs',
    'tests/rekordbox-runtime-smoke.mjs',
  ];

  // Einzige erlaubte Schreibung im gesamten Ladepfad: die SQLCipher-
  // Funktionsprobe des Preflights. SQLCipher verweigert `PRAGMA key` bei
  // In-Memory-Datenbanken, deshalb legt die Probe eine eigene temporäre
  // Datei im Systemtemp an und räumt sie wieder auf – Rekordbox-Quellen
  // werden dabei nie berührt. Der Scan schneidet genau diese Funktion
  // heraus; alles andere in derselben Datei bleibt strikt schreibfrei.
  const exciseProbe = (source) => {
    const marker = 'function probeCipherFunctionality';
    const start = source.indexOf(marker);
    if (start === -1) return { rest: source, probe: '' };
    let depth = 0;
    let i = source.indexOf('{', start);
    const open = i;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return { rest: source.slice(0, start) + source.slice(i + 1), probe: source.slice(open, i + 1) };
  };

  for (const file of files) {
    const source = await read(file);
    if (file.endsWith('rekordboxRuntimeCheck.cjs')) {
      const { rest, probe } = exciseProbe(source);
      assert.ok(probe.length > 0, 'die SQLCipher-Funktionsprobe ist auffindbar');
      assert.ok(!FORBIDDEN.test(rest), `${file} darf außerhalb der Funktionsprobe keine Schreib-API enthalten`);
      assert.ok(FORBIDDEN.test(probe), 'die Funktionsprobe legt ihre temporäre Datei selbst an');
      assert.ok(
        probe.includes('os.tmpdir()'),
        'die Probe-Datenbank liegt ausschließlich im Systemtemp, nie in einer Rekordbox-Quelle'
      );
      assert.ok(!probe.includes('Pioneer'), 'die Probe kennt keine Rekordbox-Ordner');
      continue;
    }
    assert.ok(!FORBIDDEN.test(source), `${file} darf keine Schreib-API enthalten`);
  }
  ok(`Schreibschutz geprüft (${files.length} Module des Ladepfads, Funktionsprobe auf Systemtemp begrenzt)`);
}

// Die isolierte SQLCipher-Probestube: nur OS-Temp, keine Nutzerpfade,
// vollständige Aufräumung. Sie darf als einziger Ort auf dem Ladepfad Dateien
// erzeugen – aber ausschließlich in mkdtemp-Verzeichnissen.
{
  const source = await read('electron/rekordboxCipherProbe.cjs');
  assert.ok(source.includes('os.tmpdir()'), 'Probestube arbeitet nur im OS-Temp-Verzeichnis');
  assert.ok(source.includes('mkdtempSync'), 'Probestube erzeugt ein frisches Temp-Verzeichnis');
  assert.ok(source.includes('rmSync'), 'Probestube räumt ihre Scratch-Datei vollständig ab');
  assert.equal(/Pioneer|AppData|rekordboxAgent|Application Support|Library[/\\]/i.test(source), false,
    'Probestube darf keine Rekordbox-Nutzerpfade kennen');
  ok('SQLCipher-Probestube ist auf OS-Temp beschränkt und räumt auf');
}

// dbReader öffnet ausschließlich read-only.
{
  const source = await read('electron/dbReader.cjs');
  assert.ok(source.includes('{ readonly: true, fileMustExist: true }'), 'DB wird read-only und nur bei Existenz geöffnet');
  assert.equal(/readonly\s*:\s*false/.test(source), false, 'kein beschreibbares Öffnen der Datenbank');
  ok('dbReader öffnet master.db read-only (readonly + fileMustExist)');
}

// Der Runtime-Preflight vergleicht Größe/mtime vor und nach dem Zugriff.
{
  const source = await read('electron/rekordboxRuntimeCheck.cjs');
  assert.ok(source.includes('mtimeMs'), 'der Preflight prüft die Unveränderlichkeit der master.db');
  const result = runtimeCheck.checkRekordboxRuntime({});
  const failed = result.checks.filter((check) => check.status === 'FAIL').map((check) => check.id);
  const text = runtimeCheck.formatRekordboxRuntimeReport(result);
  // Der Preflight soll BEIDE Realitäten korrekt beschreiben: fehlendes natives
  // Modul als Fehler UND ein vorhandenes, funktionsfähiges Modul als Nachweis.
  // (Vor der kleinen Datenbankumgebung testete dieser Block nur den ersten
  // Fall und fiel überall dort aus, wo better-sqlite3-multiple-ciphers steht.)
  if (!dbReader.isCipherAvailable()) {
    assert.equal(result.ok, false, 'ohne natives Modul ist der Preflight nicht positiv');
    assert.ok(failed.includes('NATIVE_MODULE_RESOLVED'), `erwartete NATIVE_MODULE_RESOLVED, war ${failed}`);
    assert.ok(failed.includes('SQLCIPHER_FUNCTIONAL'), 'ohne Modul ist die Funktionsprobe nicht bestanden');
    assert.ok(runtimeCheck.hasUnprovenChecks(result), 'der Preflight meldet den Zustand als unvollständig');
    assert.ok(text.includes('FEHLER'), 'der Bericht nennt den Fehlerstatus');
    ok(`Runtime-Preflight erkennt fehlendes natives Modul (${failed.join(', ')})`);
  } else {
    const byId = Object.fromEntries(result.checks.map((check) => [check.id, check.status]));
    assert.equal(byId.NATIVE_MODULE_RESOLVED, 'OK', `NATIVE_MODULE_RESOLVED: FAILs=${failed}`);
    assert.equal(byId.NATIVE_MODULE_LOADABLE, 'OK', `NATIVE_MODULE_LOADABLE: FAILs=${failed}`);
    assert.equal(byId.SQLCIPHER_FUNCTIONAL, 'OK', `SQLCIPHER_FUNCTIONAL: FAILs=${failed}`);
    ok('Runtime-Preflight bestätigt vorhandenes natives SQLCipher-Modul (Scratch-Temp-Probe)');

  // "Modul fehlt"-Route deterministisch: ein isolierter App-Root ohne
  // node_modules. Diese Assertion darf nie von der Maschine abhängen, auf der
  // die Suite läuft – in der CI ist das native Modul nach `npm ci` nämlich
  // korrekt vorhanden, und ein Preflight-Test, der das als Fehler wertet,
  // wäre dort grundlos rot.
  const isolatedRoot = mkdtempSync(path.join(os.tmpdir(), 'airdox-preflight-root-'));
  try {
    writeFileSync(path.join(isolatedRoot, 'package.json'), '{"name":"airdox-preflight-probe","version":"0.0.0"}');
    const result = runtimeCheck.checkRekordboxRuntime({ appRoot: isolatedRoot });
    assert.equal(result.ok, false, 'ohne natives Modul ist der Preflight nicht positiv');
    const failed = result.checks.filter((check) => check.status === 'FAIL').map((check) => check.id);
    assert.ok(failed.includes('NATIVE_MODULE_RESOLVED'), `erwartete NATIVE_MODULE_RESOLVED, war ${failed}`);
    assert.ok(failed.includes('SQLCIPHER_FUNCTIONAL'), 'ohne Modul ist die Funktionsprobe nicht bestanden');
    assert.ok(runtimeCheck.hasUnprovenChecks(result), 'der Preflight meldet den Zustand als unvollständig');
    const text = runtimeCheck.formatRekordboxRuntimeReport(result);
    assert.ok(text.includes('FEHLER'), 'der Bericht nennt den Fehlerstatus');
    ok(`Runtime-Preflight erkennt fehlendes natives Modul (${failed.join(', ')})`);
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }

  // Gegenprobe: IST das natives Modul auf dieser Maschine tatsächlich ladbar
  // (CI-Fall nach `npm ci`), dann muss die SQLCipher-Funktionsprobe bestehen –
  // sonst wäre der Preflight auf jeder gesunden Windows-Installation rot,
  // obwohl das Modul einwandfrei läuft. Eine Probe, die z. B. `PRAGMA key`
  // auf einer In-Memory-Datenbank ausführt (von SQLCipher abgelehnt), würde
  // hier genau gefasst.
  let moduleConstructible = false;
  try {
    const probe = new (require('better-sqlite3-multiple-ciphers'))(':memory:');
    probe.close();
    moduleConstructible = true;
  } catch {
    moduleConstructible = false;
  }
  if (moduleConstructible) {
    const live = runtimeCheck.checkRekordboxRuntime({});
    const functional = live.checks.find((check) => check.id === 'SQLCIPHER_FUNCTIONAL');
    assert.ok(functional, 'SQLCIPHER_FUNCTIONAL ist Teil des Preflights');
    assert.equal(
      functional.status,
      'OK',
      `natives Modul ladbar, aber SQLCipher-Funktionsprobe fehlgeschlagen: ${functional.detail}`
    );
    ok('Runtime-Preflight bestätigt SQLCipher bei vorhandenem Modul (Funktionsprobe OK)');
  } else {
    ok('Runtime-Preflight: natives Modul nicht ladbar – Funktionsprobe zutreffend übersprungen');
  }
}

// ─── 13. Paketierungs-Verträge ─────────────────────────────────────────
{
  const packageJson = JSON.parse(await read('package.json'));
  assert.ok(
    packageJson.dependencies['better-sqlite3-multiple-ciphers'],
    'better-sqlite3-multiple-ciphers ist eine Pflichtabhängigkeit'
  );
  assert.equal(
    packageJson.optionalDependencies['better-sqlite3-multiple-ciphers'],
    undefined,
    'SQLCipher darf nicht optional sein – sonst fehlt es im Build'
  );
  assert.equal(packageJson.build.npmRebuild, true, 'electron-builder baut native Module für Electron neu');
  assert.equal(packageJson.build.beforePack, 'scripts/electron-builder-hooks.cjs', 'beforePack-Hook ist registriert');
  assert.equal(packageJson.build.afterPack, 'scripts/electron-builder-hooks.cjs', 'afterPack-Hook ist registriert');
  assert.ok(
    packageJson.build.files.includes('electron/**/*'),
    'electron/** (inkl. generated/anlzStructure.cjs) wird gepackt'
  );
  assert.ok(
    packageJson.build.asarUnpack.includes('**/*.node'),
    'native .node-Binaries werden entpackt'
  );
  assert.ok(
    /npm run rekordbox:native:ensure/.test(packageJson.scripts.desktop),
    'npm run desktop baut das native Modul automatisch für die Entwicklungs-Electron-Version'
  );
  assert.ok(
    /electron-builder/.test(packageJson.scripts['package:win']),
    'npm run package:win packt über electron-builder – und damit über die Nachweis-Hooks'
  );
  assert.ok(
    !/rebuild:electron/.test(JSON.stringify(packageJson.scripts['package:win'])),
    'kein manueller Rebuild-Schritt im Windows-Build'
  );
  for (const script of ['rekordbox:doctor', 'rekordbox:preflight', 'rekordbox:native:rebuild', 'test:rekordbox:runtime', 'build:anlz-structure']) {
    assert.ok(packageJson.scripts[script], `npm-Skript ${script} existiert`);
  }
  ok('Paketierung: Pflichtabhängigkeit, npmRebuild, beforePack/afterPack, npm-Skripte');

  const hooks = await read('scripts/electron-builder-hooks.cjs');
  assert.ok(hooks.includes('onlyModules: [MODULE_NAME]'), 'der Rebuild trifft gezielt das SQLCipher-Modul');
  assert.ok(
    hooks.includes('ELECTRON_RUN_AS_NODE'),
    'der Nachweis läuft in der echten Electron-Laufzeit, nicht in Node'
  );
  assert.ok(hooks.includes("requireInElectronRuntime(electronPath, moduleDir)"), 'beforePack lädt das Modul in Electron');
  assert.ok(
    hooks.includes("requireInElectronRuntime(electronPath, unpackedRoot)"),
    'afterPack lädt das gepackte Modul in Electron'
  );
  assert.ok(hooks.includes('app.asar.unpacked'), 'afterPack prüft das gepackte native Binary');
  assert.ok(hooks.includes('app.asar'), 'afterPack prüft das erzeugte app.asar');
  ok('beforePack/afterPack verweigern ein Paket ohne nachgewiesenes SQLCipher');
}

// ─── 14. Doctor ist rein lesend und vollständig verdrahtet ──────────────
{
  const doctor = await read('scripts/rekordbox-gate-doctor.mjs');
  for (const marker of [
    'AIRDOX REKORDBOX GATE DOCTOR',
    'locateRekordboxDatabases',
    'isCipherAvailable',
    'openContentRow',
    'resolveTrackFromMasterDb',
    'FINAL',
    'REKORDBOX_ANLZ',
  ]) {
    assert.ok(doctor.includes(marker), `Doctor enthält ${marker}`);
  }
  assert.ok(!/unlink|rename|rmSync|writeFile/.test(doctor), 'Doctor verändert keine Datei');
  ok('Doctor prüft die komplette Kette und bleibt read-only');
}

// ─── 15. Renderer-Ladepfad: keine Ersatzanalyse, echter Nachweis ───────
{
  const appSource = await read('src/App.tsx');
  const select = appSource.slice(
    appSource.indexOf('const handleSelectTrackFromXml'),
    appSource.indexOf('// ---- Phase 4')
  );
  const code = select
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  assert.ok(!/analyzeAudioBuffer/.test(code), 'kein analyzeAudioBuffer im XML-Ladepfad');
  assert.ok(!/generateAnalysisFromMetadata/.test(code), 'keine synthetische Welleform');
  assert.ok(!/LOCAL_ANALYSIS/.test(code), 'kein LOCAL_ANALYSIS im Ladepfad');
  assert.ok(/isNativeRekordboxWaveform/.test(select), 'native Rekordbox-Waveform bleibt erzwungen');
  assert.ok(/DataOrigin\.REKORDBOX_ANLZ/.test(select), 'Herkunft bleibt REKORDBOX_ANLZ');
  assert.ok(
    /resolvedDef\.analysis\.length !== gateWaveform\.buckets/.test(select),
    'Renderer muss exakt die vom Gate dekodierte Bucket-Anzahl liefern'
  );
  const desktopTypes = await read('src/types/desktop.d.ts');
  for (const gateCode of [
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
  ]) {
    assert.ok(desktopTypes.includes(`'${gateCode}'`), `desktop.d.ts kennt den Fehlercode ${gateCode}`);
    assert.ok(
      GATE_CODES.includes(gateCode),
      `${gateCode} ist auch im Gate-Modul ein dokumentierter Code`
    );
  }
  assert.ok(/cueSource/.test(select), 'Cue-Quelle wird am Track vermerkt');
  assert.ok(/gateProvenance/.test(select), 'Gate-Nachweis landet im TrackModel');
  assert.ok(/databaseRecord:/.test(select), 'Gate-Nachweis landet auch im databaseRecord');
  assert.ok(/SOURCE {4}REKORDBOX ANLZ/.test(select), 'Erfolgsstatus nennt die Quelle sichtbar');
  assert.ok(/READ ONLY/.test(select), 'Erfolgsstatus nennt den read-only Zugriff');
  ok('Renderer erzwingt Gate-Waveform, verbietet Fallback und schreibt den Nachweis');
}

// ─── 16. Provenanz-Felder sind in beiden Strukturen vorhanden ────────────
{
  const types = await read('src/types/rekordbox.ts');
  for (const field of [
    'rekordboxTrackId',
    'contentId',
    'databasePath',
    'databaseType',
    'ppthPath',
    'originalPath',
    'waveform',
    'cueSource',
    'gateCode',
  ]) {
    assert.ok(types.includes(`${field}?:`), `AnalysisFileReference kennt ${field}`);
  }
  assert.ok(types.includes('RekordboxCueSource'), 'Cue-Quelle ist typisiert');
  assert.ok(types.includes('RekordboxWaveformProvenance'), 'Waveform-Herkunft ist typisiert');
  ok('analysisSource/databaseRecord tragen die Gate-Herkunft');
}

// ─── 17. IPC-Brücke für den Laufzeitnachweis ──────────────────────────
{
  const preload = await read('electron/preload.cjs');
  const mainSource = await read('electron/main.cjs');
  assert.ok(preload.includes('checkRekordboxRuntime'), 'preload exponiert den Preflight');
  assert.ok(mainSource.includes("'rekordbox:runtime-check'"), 'main registriert den Preflight-Kanal');
  assert.ok(mainSource.includes('checkRekordboxRuntime'), 'main führt den Preflight aus');
  ok('IPC-Brücke für den Laufzeitnachweis ist vollständig');
}

console.log(`rekordbox-gate-hardening: ${checks.length} Gruppen geprüft`);
for (const line of checks) console.log(`  ✓ ${line}`);

}