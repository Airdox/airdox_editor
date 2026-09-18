 'use strict';

// Installs BS-RoFormer into persistent user data, never into app.asar or the
// portable executable's temporary extraction directory. No shell/git/npm needed.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { getAppDataStemsRoot, getPythonCandidates, getResourcesPath, PRIMARY_MODEL_ID } = require('./stemRuntime.cjs');
const TOTAL_STEPS = 6;
const SUPPORTED_WINDOWS_VERSIONS = ['3.11', '3.12', '3.10'];

function unpackedPath(file) {
  return file.replace(/app\.asar([\\/]|$)/g, 'app.asar.unpacked$1');
}

function installationPaths(repoRoot, options = {}) {
  const root = options.stemsRoot || getAppDataStemsRoot();
  if (/(^|[\\/])[^\\/]+\.asar([\\/]|$)/i.test(root)) {
    throw new Error('Installationsziel darf nicht innerhalb eines ASAR-Archivs liegen.');
  }
  const runtimeDir = path.join(root, 'stem-runtime');
  return {
    root, runtimeDir,
    python: path.join(runtimeDir, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3'])),
    modelDir: path.join(root, 'Models'),
    script: unpackedPath(path.join(repoRoot, 'python', 'install_bsroformer.py')),
    adapter: unpackedPath(path.join(repoRoot, 'python', 'bsroformer_inference.py')),
    catalog: path.join(repoRoot, 'src', 'stems', 'modelCatalog.json'),
  };
}

function runStreaming(command, args, onLine, timeoutMs = 45 * 60 * 1000) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timer;
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
    timer = setTimeout(() => {
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

async function probeVersion(command, args, run = runStreaming) {
  const result = await run(command, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2] if sys.maxsize > 2**32 else "unsupported-32-bit")'], null, 20000);
  if (!result.ok) return null;
  const version = result.output.trim().split(/\s+/).pop();
  const [major, minor] = (version || '').split('.').map(Number);
  // Pinned torch 2.5.1 wheels: Python 3.10–3.12 on every supported platform.
  if (major === 3 && minor >= 10 && minor <= 12) return { command, args, version };
  return null;
}

async function locateBasePython(run = runStreaming, repoRoot = path.join(__dirname, '..')) {
  for (const candidate of getPythonCandidates(repoRoot, getResourcesPath(repoRoot))) {
    if (!path.isAbsolute(candidate)) continue;
    const probe = await probeVersion(candidate, [], run);
    if (probe) return probe;
  }
  if (process.platform === 'win32') {
    for (const version of SUPPORTED_WINDOWS_VERSIONS) {
      const probe = await probeVersion('py', [`-${version}`], run);
      if (probe) return probe;
    }
  }
  for (const command of ['python3.11', 'python3.12', 'python3.10', 'python3', 'python']) {
    const probe = await probeVersion(command, [], run);
    if (probe) return probe;
  }
  return null;
}

async function installStemEngine(repoRoot, onProgress, options = {}) {
  const run = options.run || runStreaming;
  const report = (step, label, logLine) => onProgress?.({
    step, totalSteps: TOTAL_STEPS, percent: Math.min(99, Math.round((step - 1) / TOTAL_STEPS * 100)), label, logLine,
  });
  try {
    const paths = installationPaths(repoRoot, options);
    // Read via Electron's fs, then materialize outside ASAR for Python.
    const catalog = JSON.parse(fs.readFileSync(paths.catalog, 'utf8'));
    const model = catalog.models.find((entry) => entry.id === PRIMARY_MODEL_ID);
    if (!model || !/^[a-f0-9]{64}$/i.test(model.checkpoint.sha256)) throw new Error('Verifizierbarer BS-RoFormer-Katalog fehlt.');
    fs.mkdirSync(paths.root, { recursive: true });
    fs.mkdirSync(paths.modelDir, { recursive: true });
    report(1, 'Python 3.10–3.12 wird gesucht (empfohlen: 3.11, 64-Bit)…');
    let base = await probeVersion(paths.python, [], run);
    if (!base) base = await locateBasePython(run, repoRoot);
    if (!base) throw new Error('Kein passendes Python gefunden. Bitte Python 3.11 (64-Bit) von python.org installieren und erneut versuchen. Für diese PyTorch-Version wird Python 3.10–3.12 benötigt.');
    report(2, `Python-Umgebung wird eingerichtet: ${paths.runtimeDir}`);
    if (!fs.existsSync(paths.python)) {
      const result = await run(base.command, [...base.args, '-m', 'venv', paths.runtimeDir], line => report(2, 'Python-Umgebung wird erstellt…', line), 5 * 60 * 1000);
      if (!result.ok) throw new Error(`venv-Erstellung fehlgeschlagen: ${result.error || result.output.slice(-800)}`);
    } else if (!await probeVersion(paths.python, [], run)) {
      throw new Error(`Vorhandene Runtime ist inkompatibel: ${paths.runtimeDir}. Diesen Runtime-Ordner entfernen und erneut installieren.`);
    }
    const descriptor = path.join(paths.root, 'install-model.json');
    fs.writeFileSync(descriptor, JSON.stringify(model));
    const labels = { 3: 'PyTorch und Audio-Pakete werden installiert…', 4: 'BS-RoFormer-Architektur wird installiert…', 5: 'Checkpoint und Config werden geladen und geprüft…', 6: 'Modell wird geladen und mit Test-Audio geprüft…' };
    for (const step of [3, 4, 5, 6]) {
      report(step, labels[step]);
      const result = await run(paths.python, [paths.script, '--step', String(step), '--descriptor', descriptor, '--model-dir', paths.modelDir, '--adapter', paths.adapter], line => report(step, labels[step], line));
      if (!result.ok || (step === 6 && !result.output.includes('BSROFORMER_VERIFIED'))) {
        throw new Error(`${labels[step]} Fehlgeschlagen: ${result.error || result.output.slice(-1600)}`);
      }
    }
    onProgress?.({ step: TOTAL_STEPS, totalSteps: TOTAL_STEPS, percent: 100, label: 'BS-RoFormer installiert und Test-Inferenz erfolgreich.' });
    return { ok: true, python: paths.python, model: model.id, modelDir: paths.modelDir, weightsReady: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

module.exports = { installStemEngine, locateBasePython, installationPaths, unpackedPath, probeVersion, runStreaming, TOTAL_STEPS };
