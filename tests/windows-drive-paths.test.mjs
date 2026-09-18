/**
 * @license
 * Windows D:-Pflichtlayout – Regressionssuite für electron/windowsPaths.cjs.
 *
 * Auf Windows liegt ALLES unter D:\airdox_SMART_Editor (Setup/App/Data),
 * strikt: Ohne D: brechen Build, Installer und App-Start mit klarer Meldung
 * ab. Diese Suite prüft die Pfadableitung, die Drive-Prüfung (mit injiziertem
 * Dateisystem, damit sie auch ohne Windows lauffähig ist) und das unveränderte
 * Legacy-Verhalten auf anderen Plattformen.
 *
 * Run with: node tests/windows-drive-paths.test.mjs
 */

import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  WINDOWS_APP_NAME,
  WINDOWS_APP_ROOT_DEFAULT,
  getWindowsAppRoot,
  getWindowsSetupDir,
  getWindowsInstallDir,
  getWindowsDataRoot,
  driveRootOf,
  assertWindowsDriveReady,
  resolveDataRoot,
} = require('../electron/windowsPaths.cjs');

// Konstanten: Single Source of Truth.
assert.strictEqual(WINDOWS_APP_NAME, 'airdox_SMART_Editor');
assert.strictEqual(WINDOWS_APP_ROOT_DEFAULT, 'D:\\airdox_SMART_Editor');

// Wurzel: Default + expliziter Override (leere Overrides zählen nicht).
assert.strictEqual(getWindowsAppRoot({}), 'D:\\airdox_SMART_Editor');
assert.strictEqual(getWindowsAppRoot({ AIRDOX_WINDOWS_ROOT: 'E:\\Custom\\airdox' }), 'E:\\Custom\\airdox');
assert.strictEqual(getWindowsAppRoot({ AIRDOX_WINDOWS_ROOT: '   ' }), 'D:\\airdox_SMART_Editor');

// Abgeleitete Ordner: Setup (Build), App (NSIS-Standard), Data (Laufzeit).
// (path.join hängt vom Host-Seperator ab – deshalb relativ prüfen.)
const root = getWindowsAppRoot({});
assert.strictEqual(getWindowsSetupDir({}), path.join(root, 'Setup'));
assert.strictEqual(getWindowsInstallDir({}), path.join(root, 'App'));
assert.strictEqual(getWindowsDataRoot({}), path.join(root, 'Data'));
assert.strictEqual(
  getWindowsDataRoot({ AIRDOX_WINDOWS_ROOT: 'E:\\Custom' }),
  path.join('E:\\Custom', 'Data')
);

// Laufwerkserkennung (plattformunabhängig via win32-Parser).
assert.strictEqual(driveRootOf('D:\\airdox_SMART_Editor'), 'D:\\');
assert.strictEqual(driveRootOf('E:\\Custom\\airdox'), 'E:\\');

// --- Strikte Prüfung -------------------------------------------------------
const win32 = { platform: 'win32', env: {} };

// Fehlendes D: -> klarer Fehler mit Nennung von Laufwerk D:.
assert.throws(
  () =>
    assertWindowsDriveReady({
      ...win32,
      existsSync: () => false,
      mkdirSync: () => {
        throw new Error('darf nicht aufgerufen werden');
      },
    }),
  /Laufwerk D:/
);

// Vorhandenes D: + beschreibbar -> gibt die Wurzel zurück.
const calls = [];
const okRoot = assertWindowsDriveReady({
  ...win32,
  existsSync: (p) => {
    calls.push(['exists', p]);
    return true;
  },
  mkdirSync: (p, opts) => {
    calls.push(['mkdir', p, opts]);
  },
});
assert.strictEqual(okRoot, 'D:\\airdox_SMART_Editor');
assert.deepStrictEqual(calls[0], ['exists', 'D:\\']);
assert.deepStrictEqual(calls[1], ['mkdir', 'D:\\airdox_SMART_Editor', { recursive: true }]);

// Schreibgeschützt -> klarer Fehler mit Nennung des Ordners.
assert.throws(
  () =>
    assertWindowsDriveReady({
      ...win32,
      existsSync: () => true,
      mkdirSync: () => {
        throw new Error('EACCES');
      },
    }),
  /kann nicht nach D:\\airdox_SMART_Editor schreiben/
);

// Override-Wurzel -> DIESES Laufwerk wird geprüft, nicht D:.
const overrideCalls = [];
assert.strictEqual(
  assertWindowsDriveReady({
    platform: 'win32',
    env: { AIRDOX_WINDOWS_ROOT: 'E:\\Custom' },
    existsSync: (p) => {
      overrideCalls.push(p);
      return true;
    },
    mkdirSync: () => {},
  }),
  'E:\\Custom'
);
assert.deepStrictEqual(overrideCalls, ['E:\\']);

// Andere Plattformen: No-Op, kein fs-Zugriff.
let fsTouched = false;
const touchGuard = () => {
  fsTouched = true;
  throw new Error('darf nicht aufgerufen werden');
};
assert.strictEqual(
  assertWindowsDriveReady({ platform: 'linux', env: {}, existsSync: touchGuard, mkdirSync: touchGuard }),
  null
);
assert.strictEqual(
  assertWindowsDriveReady({ platform: 'darwin', env: {}, existsSync: touchGuard, mkdirSync: touchGuard }),
  null
);
assert.strictEqual(fsTouched, false);

// --- Datenwurzel ------------------------------------------------------------
// Windows -> strikt Data-Ordner; sonst unverändertes Legacy.
assert.strictEqual(
  resolveDataRoot('/legacy/appdata', { ...win32, existsSync: () => true, mkdirSync: () => {} }),
  path.join('D:\\airdox_SMART_Editor', 'Data')
);
assert.strictEqual(resolveDataRoot('/legacy/appdata', { platform: 'linux', env: {} }), '/legacy/appdata');
assert.strictEqual(resolveDataRoot('/legacy/appdata', { platform: 'darwin', env: {} }), '/legacy/appdata');
// Windows ohne D: -> Throw statt stiller Legacy-Ablage.
assert.throws(
  () => resolveDataRoot('/legacy/appdata', { ...win32, existsSync: () => false, mkdirSync: () => {} }),
  /Laufwerk D:/
);

console.log('windows-drive-paths: OK');
