'use strict';

/**
 * One-click in-app installer for the real Demucs AI stem engine.
 *
 * Runs the same steps as scripts/setup-stem-model.(sh|ps1), but from inside
 * the app with structured progress reporting, so users never need a terminal:
 *   1. Locate a supported Python (3.9–3.13; never a too-new release).
 *   2. Create the project-local .venv.
 *   3. Install torch/torchaudio (CPU wheels preferred, PyPI as fallback).
 *   4. Install demucs 4.0.1.
 *   5. Pre-download the four htdemucs_ft model weights.
 *   6. Verify the complete environment end-to-end.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { inspectDemucsEnvironment } = require('./demucsRunner.cjs');
const { resolveInstallRoot, venvPython, isInsideAsar } = require('./stemPaths.cjs');

const SUPPORTED_WINDOWS_VERSIONS = ['3.12', '3.11', '3.10', '3.9'];

/** Total user-visible steps for percent computation. */
const TOTAL_STEPS = 6;

function runStreaming(command, args, onLine, timeoutMs = 45 * 60 * 1000) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(command, args, { windowsHide: true, env: process.env });
    } catch (error) {
      finish({ ok: false, output, error: error.message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, output, error: `Zeitüberschreitung nach ${Math.round(timeoutMs / 60000)} Minuten` });
    }, timeoutMs);
    const capture = (chunk) => {
      const text = chunk.toString();
      output = (output + text).slice(-16000);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) onLine?.(trimmed);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => finish({ ok: false, output, error: error.message }));
    child.on('close', (code) => finish({ ok: code === 0, code, output }));
  });
}

async function probeVersion(command, args) {
  const result = await runStreaming(
    command,
    [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
    null,
    20000
  );
  if (!result.ok) return null;
  const version = result.output.trim().split(/\s+/).pop();
  const [major, minor] = (version || '').split('.').map(Number);
  if (major === 3 && minor >= 9 && minor <= 13) return { command, args, version };
  return null;
}

/** Weitere übliche Installationsorte, die nicht im PATH stehen müssen. */
function windowsPythonPaths() {
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
    process.env.ProgramFiles,
    'C:\\',
  ].filter(Boolean);
  const files = [];
  for (const version of SUPPORTED_WINDOWS_VERSIONS) {
    const folder = `Python${version.replace('.', '')}`;
    for (const root of roots) files.push(path.join(root, folder, 'python.exe'));
  }
  return files.filter((file) => {
    try { return fs.existsSync(file); } catch { return false; }
  });
}

/** Installierte Interpreter laut Python-Launcher (`py -0p`). */
async function launcherPythonPaths() {
  const listed = await runStreaming('py', ['-0p'], null, 20000);
  if (!listed.ok) return [];
  return listed.output
    .split(/\r?\n/)
    .map((line) => (line.match(/([A-Za-z]:\\[^\s].*?python\.exe)/i) || [])[1])
    .filter(Boolean);
}

/** Find a base Python interpreter that Demucs/PyTorch wheels support. */
async function locateBasePython() {
  if (process.platform === 'win32') {
    for (const version of SUPPORTED_WINDOWS_VERSIONS) {
      const probe = await probeVersion('py', [`-${version}`]);
      if (probe) return probe;
    }
    for (const file of await launcherPythonPaths()) {
      const probe = await probeVersion(file, []);
      if (probe) return probe;
    }
    for (const file of windowsPythonPaths()) {
      const probe = await probeVersion(file, []);
      if (probe) return probe;
    }
    for (const candidate of ['python', 'python3']) {
      const probe = await probeVersion(candidate, []);
      if (probe) return probe;
    }
    return null;
  }
  for (const candidate of ['python3', 'python']) {
    const probe = await probeVersion(candidate, []);
    if (probe) return probe;
  }
  for (const minor of [13, 12, 11, 10, 9]) {
    const probe = await probeVersion(`python3.${minor}`, []);
    if (probe) return probe;
  }
  return null;
}

/**
 * Letzte Rettung unter Windows: Python 3.12 automatisch per winget
 * installieren, damit der Nutzer die App nicht verlassen muss.
 */
async function autoInstallWindowsPython(report) {
  if (process.platform !== 'win32') return null;
  report(1, 'Kein passendes Python gefunden – Python 3.12 wird automatisch installiert…');
  const install = await runStreaming(
    'winget',
    ['install', '--id', 'Python.Python.3.12', '--source', 'winget',
     '--accept-package-agreements', '--accept-source-agreements', '--silent',
     '--scope', 'user', '--disable-interactivity'],
    (line) => report(1, 'Python 3.12 wird automatisch installiert…', line),
    20 * 60 * 1000
  );
  if (!install.ok) return null;
  return locateBasePython();
}

/**
 * Installs the complete Demucs environment with progress callbacks.
 * onProgress receives { step, totalSteps, percent, label, logLine? }.
 */
async function installStemEngine(repoRoot, onProgress) {
  // In der gepackten App liegt repoRoot in resources/app.asar und ist
  // schreibgeschützt (WinError 3 beim venv-Anlegen). Dann installieren wir in
  // einen beschreibbaren Benutzerordner.
  const installRoot = resolveInstallRoot(repoRoot);
  const report = (step, label, logLine) => {
    onProgress?.({
      step,
      totalSteps: TOTAL_STEPS,
      percent: Math.min(99, Math.round(((step - 1) / TOTAL_STEPS) * 100)),
      label,
      logLine,
    });
  };
  const fail = (message) => ({ ok: false, error: message });

  // Step 1: locate Python
  report(1, 'Unterstütztes Python (3.9–3.13) wird gesucht…');
  let base = await locateBasePython();
  if (!base) base = await autoInstallWindowsPython(report);
  if (!base) {
    return fail(
      'Kein unterstütztes Python (3.9–3.13) gefunden. Bitte Python 3.11 oder 3.12 (64-Bit) von python.org installieren — danach hier erneut auf Installieren klicken.'
    );
  }
  report(1, `Python ${base.version} gefunden.`);

  // Step 2: create venv
  report(2, 'Isolierte Python-Umgebung (.venv) wird erstellt…');
  const venvPy = venvPython(installRoot);
  if (isInsideAsar(installRoot)) {
    return fail('Installationsziel liegt im schreibgeschützten Programmarchiv. Bitte AIRDOX_STEM_ENGINE_HOME auf einen beschreibbaren Ordner setzen.');
  }
  report(2, `Zielordner: ${installRoot}`);
  if (!fs.existsSync(venvPy)) {
    const venv = await runStreaming(
      base.command,
      [...base.args, '-m', 'venv', path.join(installRoot, '.venv')],
      (line) => report(2, 'Isolierte Python-Umgebung (.venv) wird erstellt…', line),
      5 * 60 * 1000
    );
    if (!venv.ok) return fail(`venv-Erstellung fehlgeschlagen: ${venv.error || venv.output.slice(-400)}`);
  }

  // Step 3: torch/torchaudio (CPU wheels first — much smaller download)
  report(3, 'PyTorch wird installiert (größter Download, bitte warten)…');
  await runStreaming(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip'], null, 10 * 60 * 1000);
  let torch = await runStreaming(
    venvPy,
    ['-m', 'pip', 'install', '--index-url', 'https://download.pytorch.org/whl/cpu', 'torch', 'torchaudio'],
    (line) => report(3, 'PyTorch (CPU) wird installiert…', line)
  );
  if (!torch.ok) {
    report(3, 'CPU-Wheel-Index nicht erreichbar — Standard-PyPI wird verwendet…');
    torch = await runStreaming(
      venvPy,
      ['-m', 'pip', 'install', 'torch', 'torchaudio'],
      (line) => report(3, 'PyTorch wird installiert (PyPI)…', line)
    );
  }
  if (!torch.ok) return fail(`PyTorch-Installation fehlgeschlagen: ${torch.error || torch.output.slice(-400)}`);

  // Step 4: demucs
  report(4, 'Demucs 4.0.1 wird installiert…');
  const demucs = await runStreaming(
    venvPy,
    ['-m', 'pip', 'install', 'demucs==4.0.1'],
    (line) => report(4, 'Demucs 4.0.1 wird installiert…', line)
  );
  if (!demucs.ok) return fail(`Demucs-Installation fehlgeschlagen: ${demucs.error || demucs.output.slice(-400)}`);

  // Step 5: pre-download the four htdemucs_ft weights so the first real
  // separation does not stall on a surprise download.
  report(5, 'KI-Modellgewichte (htdemucs_ft, ~320 MB) werden geladen…');
  const weights = await runStreaming(
    venvPy,
    ['-c', "from demucs.pretrained import get_model; get_model('htdemucs_ft'); print('WEIGHTS_READY')"],
    (line) => report(5, 'KI-Modellgewichte (htdemucs_ft) werden geladen…', line)
  );
  if (!weights.ok || !weights.output.includes('WEIGHTS_READY')) {
    return fail(
      `Modellgewichte konnten nicht geladen werden: ${weights.error || weights.output.slice(-400)}. ` +
        'Bitte Internetverbindung prüfen und erneut versuchen — die Installation wird an dieser Stelle fortgesetzt.'
    );
  }

  // Step 6: end-to-end verification through the same probe used at runtime.
  report(6, 'Installation wird verifiziert…');
  const status = await inspectDemucsEnvironment(repoRoot, [venvPy]);
  if (!status.available) {
    return fail(`Verifikation fehlgeschlagen: ${status.reason || 'Umgebung unvollständig.'}`);
  }
  onProgress?.({ step: TOTAL_STEPS, totalSteps: TOTAL_STEPS, percent: 100, label: 'KI-Stem-Engine einsatzbereit.' });
  return { ok: true, python: status.python, model: status.model, weightsReady: status.weightsReady, installRoot };
}

module.exports = { installStemEngine, locateBasePython, windowsPythonPaths, TOTAL_STEPS };
