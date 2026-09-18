'use strict';

/**
 * Regression: In der gepackten Windows-App lag der Code in
 * `resources/app.asar`. Der Installer versuchte dort ein `.venv` anzulegen und
 * scheiterte mit `WinError 3`. Engine-Ort und Python-Suche müssen deshalb
 * asar-sicher sein.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-engine-home-'));
process.env.AIRDOX_STEM_ENGINE_HOME = home;

const {
  defaultEngineHome,
  engineSearchRoots,
  isInsideAsar,
  isWritableDirectory,
  resolveInstallRoot,
  venvPython,
} = require('../electron/stemPaths.cjs');
const { defaultPythonCandidates } = require('../electron/demucsRunner.cjs');

let passed = 0;

// 1. asar-Pfade werden als solche erkannt (inkl. Unterpfad).
assert.equal(isInsideAsar(path.join('C:', 'app', 'resources', 'app.asar')), true);
assert.equal(isInsideAsar(path.join('/opt/app/resources/app.asar/electron')), true);
assert.equal(isInsideAsar('/home/user/projekt'), false); passed++;

// 2. Ein asar-Root ist niemals beschreibbar – auch wenn er existiert.
assert.equal(isWritableDirectory(path.join(home, 'app.asar')), false); passed++;

// 3. Installationsziel weicht bei gepackter App auf den Benutzerordner aus.
const packedRoot = path.join('/opt', 'airdox', 'resources', 'app.asar');
assert.equal(resolveInstallRoot(packedRoot), path.resolve(home)); passed++;

// 4. Im beschreibbaren Entwicklungs-Checkout bleibt alles im Projektordner.
const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-checkout-'));
assert.equal(resolveInstallRoot(checkout), path.resolve(checkout)); passed++;

// 5. Der Benutzerordner wird angelegt, damit `python -m venv` ihn nutzen kann.
assert.equal(fs.existsSync(defaultEngineHome()), true); passed++;

// 6. Suchreihenfolge: Projektordner zuerst, Benutzerordner als Fallback.
const roots = engineSearchRoots(checkout);
assert.equal(roots[0], path.resolve(checkout));
assert.ok(roots.includes(path.resolve(home))); passed++;

// 7. Die Laufzeit-Kandidaten enthalten beide venvs vor jedem System-Python.
const candidates = defaultPythonCandidates(checkout);
assert.equal(candidates[0], venvPython(checkout));
assert.ok(candidates.some((entry) => entry.startsWith(path.resolve(home))));
const systemIndex = candidates.findIndex((entry) => entry === 'python' || entry === 'python3');
const userVenvIndex = candidates.findIndex((entry) => entry.startsWith(path.resolve(home)));
assert.ok(userVenvIndex < systemIndex, 'venv muss vor System-Python geprüft werden'); passed++;

// 8. Kein Kandidat darf jemals in einem asar-Archiv liegen.
assert.equal(defaultPythonCandidates(packedRoot).some(isInsideAsar), false); passed++;

console.log(`Stem-Engine install path: ${passed} scenarios passed`);
