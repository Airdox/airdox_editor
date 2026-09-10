/**
 * @license
 * D-partition database search contract (D1–D6).
 *
 * Ständige Nutzer-Vorgabe: Die Rekordbox-Datenbank liegt auf Partition D: —
 * die Desktop-Suche darf auf Windows NUR D: durchsuchen (kein AppData/C:,
 * keine anderen Laufwerke). Der Vertrag wird hier auf zwei Ebenen fixiert:
 *   D1–D5  Verhalten der exportierten getDatabaseSearchRoots() (plattform-
 *          unabhängig prüfbar, läuft auch in der CI auf Windows)
 *   D2,D6  Source-Contract: die Such-Sektionen in electron/dbReader.cjs
 *          dürfen AppData/USERPROFILE nicht mehr referenzieren.
 *
 * Run with: node tests/db-search-d-drive.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getDatabaseSearchRoots } = require('../electron/dbReader.cjs');

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

console.log('═══════════════════════════════════════════════════════════════');
console.log('  REKORDBOX DATABASE SEARCH — PARTITION D: ONLY (D1–D6)       ');
console.log('═══════════════════════════════════════════════════════════════\n');

check('D1', 'Windows: alle Datenbank-Such-Roots liegen auf D:', () => {
  const roots = getDatabaseSearchRoots('win32', {});
  assert.ok(roots.length >= 5, `erwartet mindestens 5 D:-Roots, gefunden: ${roots.length}`);
  for (const r of roots) {
    assert.ok(/^D:[\\/]/i.test(r), `Root ${r} liegt nicht auf D:`);
    assert.ok(!/appdata/i.test(r), `Root ${r} greift in AppData`);
  }
});

/**
 * Strip comments for source-contract checks — only CODE may reference
 * AppData/USERPROFILE, not documentation text.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

check('D2', 'Windows: DB-Suche ohne AppData/USERPROFILE (source contract)', () => {
  const src = stripComments(
    fs.readFileSync(path.join(root, 'electron', 'dbReader.cjs'), 'utf8'),
  );
  const start = src.indexOf('function getDatabaseSearchRoots');
  const end = src.indexOf('function normalizeAnlzPathKey');
  assert.ok(start >= 0 && end > start, 'Such-Sektion in dbReader.cjs gefunden');
  const section = src.slice(start, end);
  assert.ok(
    !/APPDATA|USERPROFILE/i.test(section),
    'Die Windows-Datenbanksuche darf AppData/USERPROFILE nicht referenzieren',
  );
});

check('D3', 'Ausnahme: AIRDOX_REKORDBOX_ROOT steht vor den D:-Standardroots', () => {
  const roots = getDatabaseSearchRoots('win32', { AIRDOX_REKORDBOX_ROOT: 'D:\\MeineRekordbox' });
  assert.strictEqual(roots[0], 'D:\\MeineRekordbox', 'Override zuerst');
  assert.ok(roots.slice(1).every((r) => /^D:[\\/]/i.test(r)), 'Rest bleibt auf D:');
});

check('D4', 'macOS: Roots unter Application Support/Pioneer (kein Laufwerk)', () => {
  const roots = getDatabaseSearchRoots('darwin', { HOME: '/Users/test' });
  assert.strictEqual(roots.length, 3, 'rekordbox7/6/');
  // Plattformunabhängig prüfen: beide Seiten (Funktion und Erwartung)
  // nutzen denselben path.join des Host-Systems.
  for (const name of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
    const expected = path.join('/Users/test', 'Library', 'Application Support', 'Pioneer', name);
    assert.ok(roots.includes(expected), `fehlt: ${expected}`);
  }
  for (const r of roots) {
    assert.ok(!/^[A-Za-z]:[\\/]/.test(r), 'Kein Laufwerksbuchstabe auf macOS');
  }
});

check('D5', 'Andere Plattformen: keine automatischen Such-Roots', () => {
  assert.deepStrictEqual(getDatabaseSearchRoots('linux', {}), []);
});

check('D6', 'Windows: ANLZ-Fallback durchsucht nur D: (source contract)', () => {
  const src = fs.readFileSync(path.join(root, 'electron', 'dbReader.cjs'), 'utf8');
  const code = stripComments(src);
  const start = code.indexOf('function findAnlzFolders');
  const end = code.indexOf('function decodePpthPath');
  assert.ok(start >= 0 && end > start, 'findAnlzFolders-Sektion gefunden');
  const section = code.slice(start, end);
  assert.ok(
    !/APPDATA|USERPROFILE/i.test(section),
    'findAnlzFolders darf AppData/USERPROFILE nicht referenzieren',
  );
  assert.ok(
    section.includes("'D:\\\\Pioneer'"),
    'findAnlzFallback muss D:-Roots enthalten',
  );
});

console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) process.exit(1);
