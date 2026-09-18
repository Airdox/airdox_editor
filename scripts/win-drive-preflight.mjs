#!/usr/bin/env node
/**
 * Preflight vor jedem Windows-Package-Build (strikt Laufwerk D:).
 *
 * Der Build bricht mit klarer Fehlermeldung ab, wenn:
 * - nicht auf Windows gebaut wird, oder
 * - Laufwerk D: fehlt bzw. die App-Wurzel nicht beschreibbar ist.
 *
 * Erfolgsfall: listet die drei D:-Ziele (Setup/App/Data) und kehrt mit 0 zurück.
 * Pfad-Quelle: electron/windowsPaths.cjs (Single Source of Truth).
 *
 * Run with: node scripts/win-drive-preflight.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assertWindowsDriveReady,
  getWindowsAppRoot,
  getWindowsSetupDir,
  getWindowsInstallDir,
  getWindowsDataRoot,
} = require('../electron/windowsPaths.cjs');

function fail(message, code = 1) {
  console.error(`[win-drive-preflight] FEHLER: ${message}`);
  process.exit(code);
}

if (process.platform !== 'win32') {
  fail(
    `Windows-Package-Builds sind nur auf Windows möglich (aktuelle Plattform: ${process.platform}). ` +
      `Bitte auf dem Windows-Rechner mit Laufwerk D: bauen – siehe BUILD_WINDOWS.md.`,
    2
  );
}

let root;
try {
  root = assertWindowsDriveReady();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// Setup-Ordner vorab anlegen: schlägt das fehl, scheitert der Build später
// ohnehin – lieber jetzt mit klarer Meldung.
const setupDir = getWindowsSetupDir();
try {
  fs.mkdirSync(setupDir, { recursive: true });
  fs.accessSync(setupDir, fs.constants.W_OK);
} catch (error) {
  fail(
    `Setup-Ordner ${setupDir} ist nicht beschreibbar: ${error instanceof Error ? error.message : String(error)}`
  );
}

console.log('[win-drive-preflight] OK – Windows-Buildziele auf Laufwerk D:');
console.log(`[win-drive-preflight]   Wurzel : ${getWindowsAppRoot()}`);
console.log(`[win-drive-preflight]   Setup  : ${setupDir}  (Build-Artefakte)`);
console.log(`[win-drive-preflight]   App    : ${getWindowsInstallDir()}  (NSIS-Standard)`);
console.log(`[win-drive-preflight]   Data   : ${path.join(getWindowsDataRoot(), '(logs|stems|...)')}  (Laufzeitdaten)`);
