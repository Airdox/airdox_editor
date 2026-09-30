#!/usr/bin/env node
/**
 * @license
 * Baut das native SQLCipher-Modul gegen die Electron-Version des Projekts.
 *
 * `better-sqlite3-multiple-ciphers` ist ein normales (NODE_MODULE_VERSION-
 * gebundenes) C++-Add-on: ein für Node gebautes Binary lässt sich in Electron
 * nicht laden – und umgekehrt. Genau daran ist der Master-DB-Pfad in der
 * Praxis gescheitert (`SQLCIPHER_UNAVAILABLE` trotz "erfolgreichem" Build).
 *
 * Dieses Skript stellt den Entwicklungs- und Paketierungszustand
 * deterministisch her:
 *
 *   * es ermittelt die Electron-Version aus `node_modules/electron` (bzw. dem
 *     Manifest),
 *   * es baut ausschließlich das SQLCipher-Modul neu (@electron/rebuild mit
 *     `onlyModules`), damit der sehr große, N-API-basierte ONNX-Laufzeit
 *     unangetastet bleibt,
 *   * es schreibt eine Stempeldatei, sodass `npm run desktop` den Rebuild nur
 *     wiederholt, wenn sich Electron oder die Modulversion geändert hat.
 *
 * Aufruf:
 *   node scripts/rebuild-native-sqlcipher.mjs           # nur bei Bedarf
 *   node scripts/rebuild-native-sqlcipher.mjs --force   # immer neu bauen
 *   node scripts/rebuild-native-sqlcipher.mjs --check   # nichts bauen, nur melden
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_NAME = 'better-sqlite3-multiple-ciphers';
const STAMP_FILE = path.join(ROOT, 'node_modules', '.cache', 'airdox-electron-rebuild.json');
const FORCE = process.argv.includes('--force');
const CHECK = process.argv.includes('--check');

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectElectronVersion() {
  const installed = readJson(path.join(ROOT, 'node_modules', 'electron', 'package.json'));
  if (installed && installed.version) return installed.version;
  const manifest = readJson(path.join(ROOT, 'package.json'));
  const declared = manifest?.devDependencies?.electron || '';
  const match = /(\d+\.\d+\.\d+)/.exec(declared);
  if (match) return match[1];
  throw new Error(
    'Electron-Version nicht ermittelbar. Bitte "npm ci" ausführen, bevor das native Modul neu gebaut wird.'
  );
}

function detectModuleVersion() {
  const manifest = readJson(path.join(ROOT, 'node_modules', MODULE_NAME, 'package.json'));
  return manifest?.version || null;
}

function locatePrebuiltBinary() {
  const base = path.join(ROOT, 'node_modules', MODULE_NAME, 'build', 'Release');
  if (!existsSync(base)) return null;
  const candidates = readdirSync(base).filter((name) => name.endsWith('.node'));
  return candidates.length ? path.join(base, candidates[0]) : null;
}

function readStamp() {
  return readJson(STAMP_FILE);
}

function writeStamp(stamp) {
  mkdirSync(path.dirname(STAMP_FILE), { recursive: true });
  writeFileSync(STAMP_FILE, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
}

async function main() {
  const electronVersion = detectElectronVersion();
  const moduleVersion = detectModuleVersion();
  const binary = locatePrebuiltBinary();
  const stamp = readStamp();
  const upToDate =
    stamp &&
    stamp.electronVersion === electronVersion &&
    stamp.moduleVersion === moduleVersion &&
    binary &&
    existsSync(binary);

  console.log(`[rekordbox:native] Electron ${electronVersion}, ${MODULE_NAME} ${moduleVersion || 'nicht installiert'}`);
  console.log(`[rekordbox:native] Binary: ${binary || 'NICHT GEBRAUT'}`);

  if (CHECK) {
    if (upToDate) {
      console.log('[rekordbox:native] Status: OK (Rebuild nicht nötig)');
      return 0;
    }
    console.error('[rekordbox:native] Status: REBUILD NÖTIG – "npm run rekordbox:native:rebuild" ausführen.');
    return 1;
  }

  if (upToDate && !FORCE) {
    console.log('[rekordbox:native] Status: OK (Rebuild übersprungen, --force erzwingt ihn)');
    return 0;
  }

  const moduleDir = path.join(ROOT, 'node_modules', MODULE_NAME);
  if (!existsSync(moduleDir)) {
    console.error(
      `[rekordbox:native] ${MODULE_NAME} ist nicht installiert. "npm ci" ist Pflicht – die SQLCipher-Unterstützung darf keine optionale Abhängigkeit sein.`
    );
    return 1;
  }

  let rebuild;
  try {
    ({ rebuild } = await import('@electron/rebuild'));
  } catch (error) {
    console.error(
      `[rekordbox:native] @electron/rebuild ist nicht verfügbar (${error.message}). "npm ci" ausführen.`
    );
    return 1;
  }

  console.log(`[rekordbox:native] Baue ${MODULE_NAME} für Electron ${electronVersion} …`);
  const started = Date.now();
  try {
    await rebuild({
      buildPath: ROOT,
      electronVersion,
      arch: process.env.npm_config_arch || process.arch,
      platform: process.env.npm_config_platform || process.platform,
      onlyModules: [MODULE_NAME],
      force: true,
    });
  } catch (error) {
    console.error(`[rekordbox:native] Rebuild fehlgeschlagen: ${error.message || error}`);
    return 1;
  }
  const rebuilt = locatePrebuiltBinary();
  if (!rebuilt) {
    console.error('[rekordbox:native] Rebuild meldet Erfolg, aber es liegt kein .node-Binary vor.');
    return 1;
  }
  writeStamp({
    electronVersion,
    moduleVersion,
    binary: path.relative(ROOT, rebuilt),
    builtAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
  });
  console.log(`[rekordbox:native] OK: ${path.relative(ROOT, rebuilt)} (${Date.now() - started} ms)`);

  // Ein stiller Fehlbau ist der teuerste Fall: deshalb direkt danach laden.
  const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(moduleDir)}); console.log('loadable')`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    console.error(
      '[rekordbox:native] WARNUNG: Das frisch gebaute Binary ist mit dem laufenden Node nicht ladbar – das ist erwartbar, ' +
      'wenn es für Electron gebaut wurde. Der Nachweis erfolgt in der Electron-App (npm run rekordbox:doctor).'
    );
  }
  return 0;
}

process.exitCode = await main();
