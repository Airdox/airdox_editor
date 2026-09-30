#!/usr/bin/env node
/**
 * @license
 * CLI-Wrapper um den Rekordbox-Runtime-Preflight
 * (electron/rekordboxRuntimeCheck.cjs).
 *
 * Wird von `npm run desktop`, vom Windows-Paketierungs-Hook und von der CI
 * benutzt, bevor irgendetwas als "funktionierend" gemeldet wird. Der Aufruf
 * endet mit Exit-Code 1, sobald ein Nachweis fehlschlägt – ein Build darf
 * nicht erfolgreich durchlaufen, obwohl SQLCipher anschließend fehlt.
 *
 * Aufruf:
 *   node scripts/rekordbox-preflight.mjs                  # Modul + (falls vorhanden) master.db
 *   node scripts/rekordbox-preflight.mjs --require-module # nur natives Modul erzwingen
 *   node scripts/rekordbox-preflight.mjs --require-db     # auch eine master.db erzwingen
 *   node scripts/rekordbox-preflight.mjs --json
 */

import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const runtimeCheck = require('../electron/rekordboxRuntimeCheck.cjs');

const args = process.argv.slice(2);
const json = args.includes('--json');
const requireModule = args.includes('--require-module');
const requireDb = args.includes('--require-database') || args.includes('--require-db');

const result = runtimeCheck.checkRekordboxRuntime({ requireDatabase: requireDb });

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('AIRDOX REKORDBOX RUNTIME PREFLIGHT');
  console.log(runtimeCheck.formatRekordboxRuntimeReport(result));
}

const MODULE_CHECKS = [
  'NATIVE_MODULE_RESOLVED',
  'NATIVE_MODULE_LOADABLE',
  'SQLCIPHER_FUNCTIONAL',
];
const moduleFailed = result.checks
  .filter((check) => MODULE_CHECKS.includes(check.id))
  .some((check) => check.status === 'FAIL');

if (moduleFailed) {
  console.error('\nSQLCipher ist nicht lauffähig. Der Track-Import kann ohne dieses Modul nicht funktionieren.');
  console.error('  npm run rekordbox:native:rebuild   → für diese Electron-Version neu bauen');
  console.error('  npm run package:win                → Windows-Paket inkl. automatischem Rebuild');
  process.exit(1);
}

// "Läuft der Preflight außerhalb von Electron" ist eine Warnung, kein Fehler:
// ein für Electron gebautes Binary lässt sich in Node grundsätzlich nicht
// laden. Der belastbare Nachweis läuft über scripts/electron-builder-hooks.cjs
// in der echten Electron-Laufzeit.
if (requireModule && result.checks.some((check) => check.id === 'ELECTRON_VERSION' && check.status === 'WARN')) {
  console.error('\nHinweis: Dieser Lauf ist kein Electron-Prozess.');
  console.error('  Für den endgültigen Nachweis: "npm run rekordbox:doctor" in der Desktop-App');
  console.error('  oder "npm run package:win" (beforePack/afterPack prüfen in Electron).');
  process.exit(1);
}

if (requireDb) {
  const dbCheck = result.checks.find((check) => check.id === 'MASTER_DB_READONLY');
  if (!dbCheck || dbCheck.status !== 'OK') {
    console.error(`\nmaster.db read-only nicht nachgewiesen: ${dbCheck ? dbCheck.detail : 'Prüfung fehlt'}`);
    process.exit(1);
  }
}

if (json) process.exit(result.ok ? 0 : 1);
process.exit(result.ok ? 0 : 1);
