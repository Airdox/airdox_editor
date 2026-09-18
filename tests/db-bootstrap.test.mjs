/**
 * Tests für electron/dbBootstrap.cjs – die Startabfrage nach dem Ort der
 * Rekordbox-Datenbank (Testzwecke): persistenter Speicher und Aufbau der
 * Dialogparameter.
 *
 * Run with: node tests/db-bootstrap.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DB_LOCATION_FILE_NAME,
  loadStoredDbLocation,
  saveStoredDbLocation,
  clearStoredDbLocation,
  buildStartupPrompt,
} = require('../electron/dbBootstrap.cjs');

// ─── Persistenter Speicher (db-location.json) ───────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-db-bootstrap-'));

// Lesen ohne gespeicherten Ort → null, kein Wurf.
const empty = loadStoredDbLocation(tmpRoot);
assert.strictEqual(empty.dbPath, null, 'ohne Datei gibt es keinen gespeicherten Ort');
assert.strictEqual(empty.exists, false, 'ohne Datei existiert auch keine DB');

// Speichern + Lesen einer existierenden DB-Datei.
const fakeDb = path.join(tmpRoot, 'master.db');
fs.writeFileSync(fakeDb, 'not-a-real-db');
const saved = saveStoredDbLocation(tmpRoot, fakeDb);
assert.strictEqual(saved.dbPath, fakeDb, 'gespeicherter Pfad entspricht der Auswahl');
assert.ok(fs.existsSync(path.join(tmpRoot, DB_LOCATION_FILE_NAME)), 'Speicherdatei wurde angelegt');

const loaded = loadStoredDbLocation(tmpRoot);
assert.strictEqual(loaded.dbPath, fakeDb, 'Rundtrip: Pfad wieder lesbar');
assert.strictEqual(loaded.exists, true, 'Rundtrip: Datei existiert');

// Verschwindet die DB, bleibt der Pfad gespeichert, exists wird false.
fs.unlinkSync(fakeDb);
const stale = loadStoredDbLocation(tmpRoot);
assert.strictEqual(stale.dbPath, fakeDb, 'Pfad bleibt auch ohne Datei gespeichert');
assert.strictEqual(stale.exists, false, 'exists=false wenn Datei fehlt');

// Leere/ungültige Eingaben werden abgelehnt bzw. ignoriert.
assert.throws(() => saveStoredDbLocation(tmpRoot, '   '), /gültiger Datenbankpfad/, 'leerer Pfad wird abgelehnt');
fs.writeFileSync(path.join(tmpRoot, DB_LOCATION_FILE_NAME), '{kaputt');
const corrupt = loadStoredDbLocation(tmpRoot);
assert.strictEqual(corrupt.dbPath, null, 'korrupte JSON liefert null statt Wurf');

// Löschen entfernt den gespeicherten Ort.
saveStoredDbLocation(tmpRoot, fakeDb);
assert.strictEqual(clearStoredDbLocation(tmpRoot), true, 'Löschen meldet Erfolg');
assert.strictEqual(loadStoredDbLocation(tmpRoot).dbPath, null, 'nach Löschen kein Ort mehr');
assert.strictEqual(clearStoredDbLocation(tmpRoot), false, 'erneutes Löschen meldet false');

// ─── Aufbau der Start-Dialogparameter ───────────────────────────────────────

// Fall 1: Nichts gespeichert, nichts erkannt → Auswählen + Überspringen.
const bare = buildStartupPrompt({});
assert.deepStrictEqual(
  bare.buttons.map((b) => b.id),
  ['CHOOSE', 'SKIP'],
  'ohne Vorwissen nur Auswahl und Überspringen'
);
assert.strictEqual(bare.defaultId, 0, 'Default ist die Dateiauswahl');
assert.strictEqual(bare.cancelId, 1, 'Überspringen ist Abbruch');
assert.ok(bare.detail.includes('Automatisch erkannt: keine'), 'Detailtext nennt fehlende Erkennung');

// Fall 2: Gültiger gespeicherter Pfad + erkannte Kandidaten.
const candidates = [
  { path: 'D:\\Pioneer\\rekordbox7\\master.db', kind: 'MASTER_DB', label: 'master.db (D:\\Pioneer\\rekordbox7)' },
  { path: 'E:\\share\\exportLibrary.db', kind: 'ONE_LIBRARY', label: 'exportLibrary.db' },
];
const full = buildStartupPrompt({
  storedDbPath: fakeDb,
  storedExists: true,
  candidates,
});
assert.deepStrictEqual(
  full.buttons.map((b) => b.id),
  ['CHOOSE', 'USE_STORED', 'USE_DETECTED', 'SKIP'],
  'alle Optionen vorhanden'
);
assert.strictEqual(full.buttons[full.defaultId].id, 'USE_STORED', 'Default ist der gespeicherte Pfad');
assert.strictEqual(full.cancelId, full.buttons.length - 1, 'Überspringen bleibt Abbruch');
assert.ok(full.detail.includes(fakeDb), 'zuletzt verwendeter Pfad im Detailtext');
assert.ok(full.detail.includes('Automatisch erkannt (2)'), 'Anzahl erkannter Datenbanken im Detailtext');

// Fall 3: Gespeicherter Pfad ohne Datei → kein USE_STORED, Default ist Erkennung.
const stalePrompt = buildStartupPrompt({ storedDbPath: fakeDb, storedExists: false, candidates });
assert.deepStrictEqual(
  stalePrompt.buttons.map((b) => b.id),
  ['CHOOSE', 'USE_DETECTED', 'SKIP'],
  'verschwundene Datei erzeugt keine Übernehmen-Option'
);
assert.strictEqual(stalePrompt.buttons[stalePrompt.defaultId].id, 'USE_DETECTED', 'Default springt zur Erkennung');
assert.ok(stalePrompt.detail.includes('nicht mehr vorhanden'), 'Warnung vor verwaistem Pfad');

// Fall 4: Keine Erkennung, aber gespeicherter Pfad existiert noch.
const storedOnly = buildStartupPrompt({ storedDbPath: '/db/master.db', storedExists: true, candidates: [] });
assert.deepStrictEqual(
  storedOnly.buttons.map((b) => b.id),
  ['CHOOSE', 'USE_STORED', 'SKIP'],
  'ohne Erkennung entfällt USE_DETECTED'
);
assert.strictEqual(storedOnly.buttons[storedOnly.defaultId].id, 'USE_STORED', 'Default bleibt gespeichert');

// ─── Aufräumen ──────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('✔ db-bootstrap: Speicher, Rundtrip und Dialogaufbau verifiziert');
