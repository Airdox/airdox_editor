/**
 * @license
 * D-partition database search contract (D1–D8).
 *
 * Ständige Nutzer-Vorgabe: Die Rekordbox-Datenbank liegt auf Partition D: —
 * auf Windows sucht die App NUR auf D: (kein AppData-Verzeichnis-Scan,
 * keine anderen Laufwerke). Der reale Layout-Fall dieses Nutzers:
 *   DB:    D:\PIONEER\Master\master.db
 *   ANLZ:  D:\PIONEER\Master\share\PIONEER\USBANLZ\…
 * d. h. Rekordbox-7-Datenordner „Master“ (freier Name!) muss gefunden
 * werden. Rekordboxs eigener options.json-Pointer (eine einzige
 * Config-Datei in AppData — kein Verzeichnis-Scan) ist erlaubt, aber nur
 * mit D:-Ziel.
 *
 * Run with: node tests/db-search-d-drive.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  getDatabaseSearchRoots,
  isOnDriveD,
  findDatabaseFilesOnWindowsVolume,
  findAnlzFolders,
} = require('../electron/dbReader.cjs');

let passed = 0;
let failed = 0;
function check(id, label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${id} ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${id} ${label}`);
    console.error(`    ${err.message}`);
  }
}

/** Strip comments for source-contract checks — only CODE is inspected. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  REKORDBOX DATABASE SEARCH — PARTITION D: ONLY (D1–D8)       ');
console.log('═══════════════════════════════════════════════════════════════\n');

check('D1', 'Windows: alle Datenbank-Such-Roots liegen auf D:', () => {
  const roots = getDatabaseSearchRoots('win32', {});
  assert.ok(roots.length >= 5, `erwartet mindestens 5 D:-Roots, gefunden: ${roots.length}`);
  for (const r of roots) {
    assert.ok(/^D:[\\/]/i.test(r), `Root ${r} liegt nicht auf D:`);
    assert.ok(!/appdata/i.test(r), `Root ${r} greift in AppData`);
  }
});

check('D2', 'Windows: D:-Locator macht KEINEN AppData-Verzeichnis-Scan (source contract)', () => {
  const src = stripComments(
    fs.readFileSync(path.join(root, 'electron', 'dbReader.cjs'), 'utf8'),
  );
  const start = src.indexOf('function locateRekordboxDatabasesOnD');
  const end = src.indexOf('function locateRekordboxDatabases()');
  assert.ok(start >= 0 && end > start, 'locateRekordboxDatabasesOnD-Sektion gefunden');
  const section = src.slice(start, end);
  assert.ok(
    !/findDatabaseFiles\(/.test(section),
    'locateRekordboxDatabasesOnD darf findDatabaseFiles() (AppData-Scan) nicht aufrufen — nur options.json-Pointer mit D:-Ziel + findDatabaseFilesOnWindowsVolume',
  );
});

check('D3', 'Pointer-Ziel nur auf D: akzeptiert (isOnDriveD)', () => {
  assert.strictEqual(isOnDriveD('D:\\PIONEER\\Master\\master.db'), true);
  assert.strictEqual(isOnDriveD('d:/mucke/db/master.db'), true);
  assert.strictEqual(isOnDriveD('C:\\Users\\x\\AppData\\Pioneer\\master.db'), false);
  assert.strictEqual(isOnDriveD('G:\\mp3 traktor\\master.db'), false);
  assert.strictEqual(isOnDriveD('/mnt/d/Pioneer/master.db'), false);
  assert.strictEqual(isOnDriveD(''), false);
  assert.strictEqual(isOnDriveD(null), false);
});

check('D4', 'Ausnahme: AIRDOX_REKORDBOX_ROOT steht vor den D:-Standardroots', () => {
  const roots = getDatabaseSearchRoots('win32', { AIRDOX_REKORDBOX_ROOT: 'D:\\MeineRekordbox' });
  assert.strictEqual(roots[0], 'D:\\MeineRekordbox', 'Override zuerst');
  assert.ok(roots.slice(1).every((r) => /^D:[\\/]/i.test(r)), 'Rest bleibt auf D:');
});

check('D5', 'macOS: Roots unter Application Support/Pioneer (kein Laufwerk)', () => {
  const roots = getDatabaseSearchRoots('darwin', { HOME: '/Users/test' });
  assert.strictEqual(roots.length, 3, 'rekordbox7/6/');
  for (const name of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
    const expected = path.join('/Users/test', 'Library', 'Application Support', 'Pioneer', name);
    assert.ok(roots.includes(expected), `fehlt: ${expected}`);
  }
  for (const r of roots) {
    assert.ok(!/^[A-Za-z]:[\\/]/.test(r), 'Kein Laufwerksbuchstabe auf macOS');
  }
});

check('D6', 'Andere Plattformen: keine automatischen Such-Roots', () => {
  assert.deepStrictEqual(getDatabaseSearchRoots('linux', {}), []);
});

check('D7', 'Windows: ANLZ-Fallback durchsucht nur D: (source contract)', () => {
  const src = stripComments(
    fs.readFileSync(path.join(root, 'electron', 'dbReader.cjs'), 'utf8'),
  );
  const start = src.indexOf('function findAnlzFolders');
  const end = src.indexOf('function decodePpthPath');
  assert.ok(start >= 0 && end > start, 'findAnlzFolders-Sektion gefunden');
  const section = src.slice(start, end);
  assert.ok(
    !/APPDATA|USERPROFILE/i.test(section),
    'findAnlzFolders darf AppData/USERPROFILE nicht referenzieren',
  );
  assert.ok(
    section.includes("'D:\\\\Pioneer'"),
    'findAnlzFolders muss D:-Roots enthalten',
  );
});

check('D8', 'Layout D:\\PIONEER\\Master\\… wird gefunden (DB + ANLZ, „Master“-Datenordner)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'db-search-d-drive-'));
  try {
    // DB-Struktur: <root>/Pioneer/Master/master.db
    const masterDbDir = path.join(tmp, 'Pioneer', 'Master');
    fs.mkdirSync(masterDbDir, { recursive: true });
    fs.writeFileSync(path.join(masterDbDir, 'master.db'), 'dummy');
    const found = findDatabaseFilesOnWindowsVolume(path.join(tmp, 'Pioneer'));
    assert.ok(
      found.some((f) => f.kind === 'MASTER_DB' && /master\.db$/i.test(f.path)),
      `master.db im Rekordbox-7-Datenordner „Master“ gefunden (gefunden: ${JSON.stringify(found)})`,
    );

    // ANLZ-Struktur: <base>/master/share/PIONEER/USBANLZ (+ rekursive ANLZ-Ordner)
    const usbanlz = path.join(tmp, 'base', 'master', 'share', 'PIONEER', 'USBANLZ');
    fs.mkdirSync(path.join(usbanlz, 'abc'), { recursive: true });
    const folders = findAnlzFolders(path.join(tmp, 'base'));
    assert.ok(
      folders.includes(path.join(usbanlz)),
      `USBANLZ unter „master/share/PIONEER“ gefunden (gefunden: ${JSON.stringify(folders)})`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) process.exit(1);
