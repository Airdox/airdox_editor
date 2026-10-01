/**
 * @license
 * Datenbank-Suche (Phase 3/5): Die kanonische options.json des rekordboxAgent
 * liegt als GESCHWISTER der Version-Ordner
 * (`Pioneer\rekordboxAgent\storage\options.json`), nicht innerhalb von
 * `rekordbox7\`. Wurde dieser Ort übersehen, fand die Suche einen
 * benutzerdefinierten db-path nie – der Master-DB-Gate meldete
 * TRACK_NOT_FOUND_IN_MASTER_DB, obwohl die Bibliothek existierte.
 *
 * Geprüft (jeweils nur fs-Lesezugriffe, kein natives Modul nötig):
 *   1. Standard-master.db im Version-Ordner wird weiterhin gefunden,
 *   2. db-path über die Geschwister-options.json wird gefunden (MASTER_DB),
 *   3. db-path als ORDNERANGABE löst sich zu master.db/exportLibrary.db auf,
 *   4. exportLibrary.db-Ordner ergibt ONE_LIBRARY,
 *   5. die alte Ablage innerhalb des Version-Ordners bleibt unterstützt,
 *   6. der bereitgestellte D:\\PIONEER-Root wird nur nach bekannten DB-Namen geprüft.
 *
 * Run with: node tests/rekordbox-locate-options.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dbReader = require('../electron/dbReader.cjs');

assert.equal(typeof dbReader.collectPioneerRootCandidates, 'function', 'Test-Export existiert');

const work = mkdtempSync(path.join(os.tmpdir(), 'airdox-locate-options-'));
const checks = [];

function writeOptions(pioneerRoot, dbPathValue, { insideVersionDir = false } = {}) {
  const storage = insideVersionDir
    ? path.join(pioneerRoot, 'rekordbox7', 'rekordboxAgent', 'storage')
    : path.join(pioneerRoot, 'rekordboxAgent', 'storage');
  mkdirSync(storage, { recursive: true });
  writeFileSync(path.join(storage, 'options.json'), JSON.stringify({ options: [['db-path', dbPathValue]] }));
}

try {
  const pioneer = path.join(work, 'Pioneer');
  const versionDir = path.join(pioneer, 'rekordbox7');
  mkdirSync(versionDir, { recursive: true });

  // 1. Standard-Ablage im Version-Ordner bleibt erhalten.
  const defaultDb = path.join(versionDir, 'master.db');
  writeFileSync(defaultDb, 'x');
  const foundDefaults = dbReader.collectPioneerRootCandidates(pioneer);
  assert.ok(
    foundDefaults.some((entry) => path.resolve(entry.path) === path.resolve(defaultDb)),
    'master.db im Version-Ordner wird gefunden'
  );
  checks.push('Standard-master.db im Version-Ordner');

  // 2. Benutzerdefinierter db-path über die GESCHWISTER-options.json.
  const customDir = path.join(work, 'custom-library');
  mkdirSync(customDir, { recursive: true });
  const customDb = path.join(customDir, 'master.db');
  writeFileSync(customDb, 'x');
  writeOptions(pioneer, customDb);
  const found = dbReader.collectPioneerRootCandidates(pioneer);
  const custom = found.find((entry) => path.resolve(entry.path) === path.resolve(customDb));
  assert.ok(
    custom,
    `Geschwister-options.json wird gelesen (gefunden: ${found.map((entry) => entry.path).join(', ')})`
  );
  assert.equal(custom.kind, 'MASTER_DB');
  assert.match(custom.label, /options\.json/, 'Fund wird als options.json-Kandidat markiert');
  checks.push('Geschwister rekordboxAgent/storage/options.json (kanonischer Ort)');

  // 3. db-path als Ordnerangabe → master.db darin.
  const folderDbDir = path.join(work, 'folder-db');
  mkdirSync(folderDbDir, { recursive: true });
  const folderMaster = path.join(folderDbDir, 'master.db');
  writeFileSync(folderMaster, 'x');
  writeOptions(pioneer, folderDbDir);
  const folderFound = dbReader.collectPioneerRootCandidates(pioneer);
  assert.ok(
    folderFound.some((entry) => path.resolve(entry.path) === path.resolve(folderMaster)),
    'db-path darf eine Ordnerangabe sein'
  );
  checks.push('db-path als Ordner → master.db');

  // 4. Ordner mit ausschließlich exportLibrary.db → ONE_LIBRARY.
  const oneDir = path.join(work, 'onelibrary');
  mkdirSync(oneDir, { recursive: true });
  const oneDb = path.join(oneDir, 'exportLibrary.db');
  writeFileSync(oneDb, 'x');
  writeOptions(pioneer, oneDir);
  const oneFound = dbReader.collectPioneerRootCandidates(pioneer);
  const one = oneFound.find((entry) => path.resolve(entry.path) === path.resolve(oneDb));
  assert.ok(one, 'exportLibrary.db im db-path-Ordner wird gefunden');
  assert.equal(one.kind, 'ONE_LIBRARY');
  checks.push('db-path-Ordner → exportLibrary.db (ONE_LIBRARY)');

  // 5. Alte Ablage innerhalb des Version-Ordners bleibt unterstützt.
  const legacyRoot = path.join(work, 'PioneerLegacy');
  const legacyDir = path.join(legacyRoot, 'rekordbox7');
  mkdirSync(legacyDir, { recursive: true });
  const legacyCustom = path.join(work, 'legacy-library', 'master.db');
  mkdirSync(path.dirname(legacyCustom), { recursive: true });
  writeFileSync(legacyCustom, 'x');
  writeOptions(legacyRoot, legacyCustom, { insideVersionDir: true });
  const legacyFound = dbReader.collectPioneerRootCandidates(legacyRoot);
  assert.ok(
    legacyFound.some((entry) => path.resolve(entry.path) === path.resolve(legacyCustom)),
    'options.json innerhalb des Version-Ordners wird weiterhin gelesen'
  );
  checks.push('Legacy-Ablage rekordbox7/rekordboxAgent/storage');

  // 6. The explicitly supplied D:\\PIONEER-style media root may contain a
  // database directly or in its Rekordbox subfolder; only those known names
  // are inspected (the production Windows locator uses D:\\PIONEER).
  const externalRoot = path.join(work, 'External', 'PIONEER');
  mkdirSync(externalRoot, { recursive: true });
  const rootMaster = path.join(externalRoot, 'master.db');
  writeFileSync(rootMaster, 'x');
  const externalRekordbox = path.join(externalRoot, 'rekordbox');
  mkdirSync(externalRekordbox, { recursive: true });
  const externalOneLibrary = path.join(externalRekordbox, 'exportLibrary.db');
  writeFileSync(externalOneLibrary, 'x');
  const externalFound = dbReader.collectPioneerRootCandidates(externalRoot);
  assert.ok(
    externalFound.some((entry) => path.resolve(entry.path) === path.resolve(rootMaster)),
    'master.db im PIONEER-Wurzelordner wird gefunden'
  );
  assert.ok(
    externalFound.some((entry) => path.resolve(entry.path) === path.resolve(externalOneLibrary)),
    'exportLibrary.db im PIONEER/rekordbox-Unterordner wird gefunden'
  );
  checks.push('PIONEER-Medienroot (master.db und rekordbox/exportLibrary.db)');

  // 6b. Extern geführte Rekordbox-Bibliothek: Rekordbox legt sie als
  // PIONEER\Master\master.db ab. Fehlte dieser Unterordner in der Suche, wurde
  // die externe Bibliothek nie gefunden und der Gate fiel auf eine fremde
  // (meist veraltete/leere) AppData-master.db zurück – sichtbar als
  // MASTER_DB_NOT_FOUND oder TRACK_NOT_FOUND_IN_MASTER_DB.
  const externalMasterRoot = path.join(work, 'ExternalMaster', 'PIONEER');
  const externalMasterDir = path.join(externalMasterRoot, 'Master');
  mkdirSync(externalMasterDir, { recursive: true });
  const externalMasterDb = path.join(externalMasterDir, 'master.db');
  writeFileSync(externalMasterDb, 'x');
  const externalMasterFound = dbReader.collectPioneerRootCandidates(externalMasterRoot);
  const externalMasterEntry = externalMasterFound.find(
    (entry) => path.resolve(entry.path) === path.resolve(externalMasterDb)
  );
  assert.ok(
    externalMasterEntry,
    `PIONEER\\Master\\master.db wird gefunden (gefunden: ${externalMasterFound.map((entry) => entry.path).join(', ')})`
  );
  assert.equal(externalMasterEntry.kind, 'MASTER_DB');
  checks.push('Externe Bibliothek PIONEER\\Master\\master.db');

  // 6c. Die Schreibweise des Unterordners ist auf Windows-/FAT-Medien nicht
  // garantiert ('master' statt 'Master') – case-insensitive Auflösung.
  const lowerMasterRoot = path.join(work, 'ExternalMasterLower', 'PIONEER');
  const lowerMasterDir = path.join(lowerMasterRoot, 'master');
  mkdirSync(lowerMasterDir, { recursive: true });
  const lowerMasterDb = path.join(lowerMasterDir, 'master.db');
  writeFileSync(lowerMasterDb, 'x');
  const lowerFound = dbReader.collectPioneerRootCandidates(lowerMasterRoot);
  assert.ok(
    lowerFound.some((entry) => path.resolve(entry.path) === path.resolve(lowerMasterDb)),
    `Unterordner wird unabhängig von der Groß-/Kleinschreibung gefunden (gefunden: ${lowerFound.map((entry) => entry.path).join(', ')})`
  );
  checks.push('Unterordner-Suche case-insensitive (PIONEER\\master)');

  // 7. An explicit path list is an exact override and must not silently add
  // an unrelated D:\\PIONEER or AppData database on Windows.
  const previousOverride = process.env.AIRODOX_REKORDBOX_DB;
  try {
    process.env.AIRODOX_REKORDBOX_DB = `${customDb};${oneDb}`;
    const explicit = dbReader.locateRekordboxDatabases();
    assert.deepEqual(
      explicit.map((entry) => path.resolve(entry.path)),
      [path.resolve(customDb), path.resolve(oneDb)],
      'explicit paths alone are returned in the requested order'
    );

    process.env.AIRODOX_REKORDBOX_DB = path.join(work, 'missing', 'master.db');
    assert.deepEqual(dbReader.locateRekordboxDatabases(), [], 'a missing explicit path fails closed instead of falling back');
  } finally {
    if (previousOverride === undefined) delete process.env.AIRODOX_REKORDBOX_DB;
    else process.env.AIRODOX_REKORDBOX_DB = previousOverride;
  }
  checks.push('AIRODOX_REKORDBOX_DB ist ein exakter, fail-closed Override');
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`rekordbox-locate-options: ${checks.length} Wege der Datenbank-Suche geprüft`);
for (const line of checks) console.log(`  ✓ ${line}`);
