/**
 * @license
 * Windows D:-Pflichtlayout – Paritätssuite für den TypeScript-Spiegel
 * (src/stems/runtime/pathResolver.ts → resolveWindowsDataRoot).
 *
 * Der Spiegel muss sich exakt wie electron/windowsPaths.cjs verhalten:
 * gleiche Wurzel, gleiche Overrides, gleiche strikte Fehler. Der Pfad
 * `D:\airdox_SMART_Editor\Data\stems` ist zugleich der Dev-Server-Default
 * (server.ts) auf Windows.
 *
 * Run with: node scripts/run-tests.mjs --only windows-drive-paths-mirror
 */

import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveWindowsDataRoot } from '../src/stems/runtime/pathResolver';

const require = createRequire(import.meta.url);
const cjs = require('../electron/windowsPaths.cjs') as {
  WINDOWS_APP_ROOT_DEFAULT: string;
  getWindowsDataRoot: (env?: NodeJS.ProcessEnv) => string;
};

// Gleiche Wurzel wie die Single Source of Truth.
assert.strictEqual(
  resolveWindowsDataRoot({ env: {}, existsSync: () => true, mkdirSync: () => undefined }),
  cjs.getWindowsDataRoot({})
);
assert.strictEqual(cjs.WINDOWS_APP_ROOT_DEFAULT, 'D:\\airdox_SMART_Editor');
assert.strictEqual(
  resolveWindowsDataRoot({ env: {}, existsSync: () => true, mkdirSync: () => undefined }),
  path.join('D:\\airdox_SMART_Editor', 'Data')
);

// Override-Pfad wird übernommen und dessen Laufwerk geprüft.
const checked: string[] = [];
assert.strictEqual(
  resolveWindowsDataRoot({
    env: { AIRDOX_WINDOWS_ROOT: 'E:\\Custom' },
    existsSync: (p) => {
      checked.push(p);
      return true;
    },
    mkdirSync: () => undefined,
  }),
  path.join('E:\\Custom', 'Data')
);
assert.deepStrictEqual(checked, ['E:\\']);

// Fehlendes Laufwerk -> klarer Fehler mit Nennung von Laufwerk D:.
assert.throws(
  () => resolveWindowsDataRoot({ env: {}, existsSync: () => false, mkdirSync: () => undefined }),
  /Laufwerk D:/
);

// Schreibgeschützt -> klarer Fehler mit Nennung des Ordners.
assert.throws(
  () =>
    resolveWindowsDataRoot({
      env: {},
      existsSync: () => true,
      mkdirSync: () => {
        throw new Error('EACCES');
      },
    }),
  /kann nicht nach D:\\airdox_SMART_Editor schreiben/
);

console.log('windows-drive-paths-mirror: OK');
