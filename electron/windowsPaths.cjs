'use strict';

/**
 * Windows-Pfade – Single Source of Truth für das strikte D:-Layout.
 *
 * Auf Windows liegt ALLES unter einer Wurzel auf Laufwerk D::
 *   D:\airdox_SMART_Editor\Setup  – Build-Artefakte (Setup-.exe, Portable-.exe)
 *   D:\airdox_SMART_Editor\App    – Standard-Installationsordner (NSIS)
 *   D:\airdox_SMART_Editor\Data   – Laufzeitdaten (Logs, Stems, Modelle, Runtime)
 *
 * Das Layout ist strikt: Ohne Laufwerk D: brechen Windows-Build
 * (scripts/win-drive-preflight.mjs), Installer (electron/installer.nsh) und
 * App-Start (electron/main.cjs) mit klarer Fehlermeldung ab – es gibt keine
 * stille Ablage auf C:. Einzige Ausnahme sind explizite Overrides:
 *
 *   AIRDOX_WINDOWS_ROOT – andere Wurzel statt D:\airdox_SMART_Editor
 *   AIRDOX_STEMS_ROOT   – anderer Stem-Datenordner (nur Stems; hat Vorrang)
 *
 * Spiegel in TypeScript – bei Änderungen dort mitziehen:
 *   src/stems/runtime/pathResolver.ts (resolveWindowsDataRoot)
 *   server.ts (Dev-Server-Jobdaten)
 */

const fs = require('node:fs');
const path = require('node:path');

const WINDOWS_APP_NAME = 'airdox_SMART_Editor';
const WINDOWS_APP_ROOT_DEFAULT = 'D:\\airdox_SMART_Editor';
const WINDOWS_DRIVE_DEFAULT = 'D:';

function getWindowsAppRoot(env = process.env) {
  const override = env.AIRDOX_WINDOWS_ROOT && String(env.AIRDOX_WINDOWS_ROOT).trim();
  return override || WINDOWS_APP_ROOT_DEFAULT;
}

function getWindowsSetupDir(env = process.env) {
  return path.join(getWindowsAppRoot(env), 'Setup');
}

function getWindowsInstallDir(env = process.env) {
  return path.join(getWindowsAppRoot(env), 'App');
}

function getWindowsDataRoot(env = process.env) {
  return path.join(getWindowsAppRoot(env), 'Data');
}

/** 'D:\' aus 'D:\airdox_SMART_Editor' – für die Laufwerksprüfung. */
function driveRootOf(dir) {
  const parsed = path.win32.parse(String(dir));
  return parsed.root || null;
}

function driveMissingMessage(root) {
  return (
    `airdox SMART Editor benötigt Laufwerk D:. ` +
    `Der Ordner ${root} ist nicht erreichbar – bitte stelle sicher, dass Laufwerk D: verfügbar ist. ` +
    `(Alternative für Rechner ohne D:: Umgebungsvariable AIRDOX_WINDOWS_ROOT auf einen vorhandenen Ordner setzen.)`
  );
}

function driveReadonlyMessage(root, detail) {
  return (
    `airdox SMART Editor kann nicht nach ${root} schreiben` +
    (detail ? `: ${detail}` : '.') +
    ` Bitte stelle sicher, dass Laufwerk D: verfügbar und beschreibbar ist.`
  );
}

/**
 * Strikte Prüfung: Auf win32 muss das Laufwerk der App-Wurzel vorhanden und
 * die Wurzel anlegbar/beschreibbar sein – sonst Throw mit klarer Meldung.
 * Auf anderen Plattformen: No-Op (gibt null zurück).
 * fs-Funktionen sind injizierbar (Tests).
 */
function assertWindowsDriveReady(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    existsSync = fs.existsSync,
    mkdirSync = fs.mkdirSync,
  } = options;
  if (platform !== 'win32') return null;
  const root = getWindowsAppRoot(env);
  const driveRoot = driveRootOf(root) || `${WINDOWS_DRIVE_DEFAULT}\\`;
  let present = false;
  try {
    present = existsSync(driveRoot) === true;
  } catch {
    present = false;
  }
  if (!present) throw new Error(driveMissingMessage(root));
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new Error(driveReadonlyMessage(root, error && error.message));
  }
  return root;
}

/**
 * Datenwurzel der App: auf Windows strikt D:\airdox_SMART_Editor\Data,
 * sonst der übergebene Legacy-Pfad (bisheriges Verhalten, unverändert).
 */
function resolveDataRoot(legacyDataRoot, options = {}) {
  const { platform = process.platform, env = process.env } = options;
  if (platform !== 'win32') return legacyDataRoot;
  assertWindowsDriveReady({
    platform,
    env,
    existsSync: options.existsSync,
    mkdirSync: options.mkdirSync,
  });
  return getWindowsDataRoot(env);
}

module.exports = {
  WINDOWS_APP_NAME,
  WINDOWS_APP_ROOT_DEFAULT,
  WINDOWS_DRIVE_DEFAULT,
  getWindowsAppRoot,
  getWindowsSetupDir,
  getWindowsInstallDir,
  getWindowsDataRoot,
  driveRootOf,
  assertWindowsDriveReady,
  resolveDataRoot,
};
