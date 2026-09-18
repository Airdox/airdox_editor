'use strict';

/**
 * Wo darf die KI-Stem-Engine (Python-venv + Modellgewichte) liegen?
 *
 * Im Entwicklungs-Checkout ist das der Projektordner (`<repo>/.venv`).
 * In der gepackten Windows-/macOS-App liegt der Code aber in
 * `resources/app.asar` – ein schreibgeschütztes Archiv. Ein `python -m venv`
 * dort schlägt zwangsläufig mit `WinError 3` fehl (genau der Fehler aus dem
 * Bug-Report). Deshalb wandert die Umgebung dann in einen beschreibbaren
 * Benutzerordner, der Updates der App überlebt:
 *
 *   Windows  %LOCALAPPDATA%\airdox_SMART_Editor\stem-engine
 *   macOS    ~/Library/Application Support/airdox_SMART_Editor/stem-engine
 *   Linux    ~/.local/share/airdox_SMART_Editor/stem-engine
 *
 * Überschreibbar über AIRDOX_STEM_ENGINE_HOME (Tests, portable Installation).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR_NAME = 'airdox_SMART_Editor';

/** Liegt der Pfad in einem asar-Archiv (oder dessen „unpacked“-Zwilling)? */
function isInsideAsar(target) {
  return /\.asar([\\/]|$)/i.test(String(target || ''));
}

/** Standard-Heimat der Engine außerhalb des Programmordners. */
function defaultEngineHome() {
  if (process.env.AIRDOX_STEM_ENGINE_HOME) return path.resolve(process.env.AIRDOX_STEM_ENGINE_HOME);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, APP_DIR_NAME, 'stem-engine');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME, 'stem-engine');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, APP_DIR_NAME, 'stem-engine');
}

/** Kann in diesem Verzeichnis wirklich geschrieben werden? */
function isWritableDirectory(target) {
  if (!target || isInsideAsar(target)) return false;
  try {
    fs.accessSync(target, fs.constants.W_OK);
    const probe = path.join(target, `.airdox-write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Pfad des venv-Interpreters unterhalb eines Engine-Roots. */
function venvPython(root) {
  return process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python3');
}

/** Zusätzlicher POSIX-Alias (`bin/python`). */
function venvPythonAlias(root) {
  return process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
}

/**
 * Root, in dem die Engine INSTALLIERT wird.
 * Entwicklungs-Checkout → Projektordner, gepackte App → Benutzerordner.
 */
function resolveInstallRoot(repoRoot) {
  if (repoRoot && !isInsideAsar(repoRoot) && isWritableDirectory(repoRoot)) return path.resolve(repoRoot);
  const home = defaultEngineHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Alle Roots, in denen eine bereits installierte Engine liegen KANN –
 * in Suchreihenfolge. Der Projektordner zuerst (Entwicklung), danach der
 * Benutzerordner (gepackte App).
 */
function engineSearchRoots(repoRoot) {
  const roots = [];
  // Ein Root im asar-Archiv kann per Definition keine venv enthalten.
  if (repoRoot && !isInsideAsar(repoRoot)) roots.push(path.resolve(repoRoot));
  roots.push(defaultEngineHome());
  return [...new Set(roots)];
}

module.exports = {
  APP_DIR_NAME,
  defaultEngineHome,
  engineSearchRoots,
  isInsideAsar,
  isWritableDirectory,
  resolveInstallRoot,
  venvPython,
  venvPythonAlias,
};
