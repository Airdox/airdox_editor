'use strict';

// Catalog-driven stem-model installer. Installs EXACTLY the model the caller
// selected (options.modelId) – the settings menu chooses, this executes.
// Without options.modelId the primary BS-RoFormer model is installed, which
// keeps the legacy one-click behavior.
//
// Models are installed into persistent user data, never into app.asar or the
// portable executable's temporary extraction directory. No shell/git/npm needed.
//
// Per checkpoint format:
//   pytorch-ckpt / demucs-th  -> Python venv + PyTorch + family packages +
//                                weights (+ config) + verification (6 steps).
//   onnx                      -> pure file download into the model store,
//                                SHA256-verified when the catalog carries a
//                                verifiable hash (3 steps, no Python).
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { getAppDataStemsRoot, getPythonCandidates, getResourcesPath, PRIMARY_MODEL_ID } = require('./stemRuntime.cjs');
const TOTAL_STEPS = 6;
const ONNX_TOTAL_STEPS = 3;
const SUPPORTED_WINDOWS_VERSIONS = ['3.11', '3.12', '3.10'];
const SHA256_RE = /^[a-f0-9]{64}$/i;
const INSTALLABLE_FORMATS = ['pytorch-ckpt', 'demucs-th', 'onnx'];

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

/**
 * Loads the catalog entry for the requested model and refuses everything the
 * installer cannot honestly install (unknown id, test doubles, formats without
 * a download URL).
 */
function loadSelectedModel(paths, modelId) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(paths.catalog, 'utf8'));
  } catch (error) {
    throw new Error(`Modell-Katalog nicht lesbar: ${error.message}`);
  }
  const model = (catalog.models || []).find((entry) => entry.id === modelId);
  if (!model) {
    throw new Error(`Modell "${modelId}" fehlt im Modell-Katalog. Bitte im Einstellungsmenü ein bekanntes Modell wählen.`);
  }
  const format = model.checkpoint?.format;
  if (format === 'synthetic') {
    throw new Error(`Modell "${modelId}" ist ein Test-Double und kann nicht installiert werden.`);
  }
  if (!INSTALLABLE_FORMATS.includes(format)) {
    throw new Error(`Modell "${modelId}" hat ein nicht installierbares Checkpoint-Format: ${String(format)}`);
  }
  if (!model.checkpoint?.url || !/^https:\/\//.test(model.checkpoint.url)) {
    throw new Error(`Modell "${modelId}" hat keine HTTPS-Download-URL im Katalog.`);
  }
  return model;
}

/** Marker the Python verification step must print for this model. */
function verifiedMarker(model) {
  return model.family === 'htdemucs' ? 'DEMUXC_VERIFIED' : 'BSROFORMER_VERIFIED';
}

async function streamDownload(fetchImpl, ref, target, onPercent) {
  const response = await fetchImpl(ref.url, { headers: { 'user-agent': 'airdox-stem-installer' } });
  if (!response.ok || !response.body) {
    throw new Error(`Download fehlgeschlagen (HTTP ${response.status}): ${ref.url}`);
  }
  const contentLength = Number(response.headers.get?.('content-length')) || 0;
  const partial = `${target}.part`;
  const hash = crypto.createHash('sha256');
  let received = 0;
  let lastPercent = -1;
  try {
    const reader = response.body.getReader();
    const writer = fs.createWriteStream(partial);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!writer.write(Buffer.from(value))) await new Promise((resolve) => writer.once('drain', resolve));
      if (contentLength > 0) {
        const percent = Math.min(99, Math.floor((received / contentLength) * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          onPercent(percent);
        }
      }
    }
    await new Promise((resolve) => writer.end(resolve));
    if (received === 0) throw new Error(`Leerer Download: ${ref.file}`);
    if (SHA256_RE.test(ref.sha256 || '') && hash.digest('hex').toLowerCase() !== String(ref.sha256).toLowerCase()) {
      throw new Error(`SHA256 stimmt nicht: ${ref.file}. Datei wird nicht aktiviert.`);
    }
    fs.renameSync(partial, target);
  } catch (error) {
    try { fs.rmSync(partial, { force: true }); } catch { /* already renamed or absent */ }
    throw error;
  }
  return received;
}

/** ONNX path: no Python, no venv – just a verified file in the model store. */
async function installOnnxModel(paths, model, onProgress, options) {
  const report = (step, label, logLine) => onProgress?.({
    step, totalSteps: ONNX_TOTAL_STEPS, percent: Math.min(99, Math.round((step - 1) / ONNX_TOTAL_STEPS * 100)), label, logLine,
  });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  try {
    fs.mkdirSync(paths.root, { recursive: true });
    fs.mkdirSync(paths.modelDir, { recursive: true });
    const target = path.join(paths.modelDir, model.checkpoint.file);
    const verifiable = SHA256_RE.test(model.checkpoint.sha256 || '');
    report(1, `ONNX-Modell ${model.id} wird vorbereitet (kein Python erforderlich)…`);
    const exists = fs.existsSync(target) && fs.statSync(target).isFile();
    let hashOk = true;
    if (exists && verifiable) {
      const digest = crypto.createHash('sha256');
      for (const chunk of fs.createReadStream(target)) digest.update(chunk);
      hashOk = digest.digest('hex').toLowerCase() === String(model.checkpoint.sha256).toLowerCase();
    }
    if (exists && (!verifiable || hashOk)) {
      report(2, `${model.checkpoint.file} ist bereits installiert${verifiable ? ' (SHA256 geprüft)' : ''}.`);
    } else {
      report(2, `${model.checkpoint.file} wird heruntergeladen…`);
      if (exists) fs.rmSync(target);
      await streamDownload(fetchImpl, model.checkpoint, target, (percent) => report(2, `${model.checkpoint.file} wird heruntergeladen… ${percent} %`));
    }
    report(3, 'Datei wird final geprüft…');
    const finalStat = fs.statSync(target);
    if (!finalStat.isFile() || finalStat.size === 0) throw new Error(`ONNX-Datei fehlt oder ist leer: ${target}`);
    if (verifiable) {
      const digest = crypto.createHash('sha256');
      for (const chunk of fs.createReadStream(target)) digest.update(chunk);
      if (digest.digest('hex').toLowerCase() !== String(model.checkpoint.sha256).toLowerCase()) {
        throw new Error(`SHA256 stimmt nicht: ${model.checkpoint.file}. Datei wird nicht aktiviert.`);
      }
    }
    onProgress?.({
      step: ONNX_TOTAL_STEPS, totalSteps: ONNX_TOTAL_STEPS, percent: 100,
      label: `ONNX-Modell ${model.id} installiert${verifiable ? ' und SHA256-geprüft' : ''} (${Math.round(finalStat.size / 1048576)} MiB).`,
    });
    return { ok: true, model: model.id, modelDir: paths.modelDir, weightsReady: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

/** PyTorch path (BS-RoFormer, Mel-Band RoFormer, HT-Demucs): venv + deps + weights + verification. */
async function installTorchModel(repoRoot, paths, model, onProgress, options) {
  const run = options.run || runStreaming;
  const report = (step, label, logLine) => onProgress?.({
    step, totalSteps: TOTAL_STEPS, percent: Math.min(99, Math.round((step - 1) / TOTAL_STEPS * 100)), label, logLine,
  });
  try {
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
    const architecture = model.architecture || model.family;
    const labels = {
      3: 'PyTorch und Audio-Pakete werden installiert…',
      4: model.family === 'htdemucs' ? 'Demucs wird installiert…' : `${architecture}-Abhängigkeiten werden installiert…`,
      5: model.config ? 'Checkpoint und Config werden geladen und geprüft…' : 'Checkpoint wird geladen und geprüft…',
      6: model.family === 'htdemucs' ? 'Modell wird geladen und mit der Architektur abgeglichen…' : 'Modell wird geladen und mit Test-Inferenz geprüft…',
    };
    const marker = verifiedMarker(model);
    for (const step of [3, 4, 5, 6]) {
      report(step, labels[step]);
      const result = await run(paths.python, [paths.script, '--step', String(step), '--descriptor', descriptor, '--model-dir', paths.modelDir, '--adapter', paths.adapter], line => report(step, labels[step], line));
      if (!result.ok || (step === 6 && !result.output.includes(marker))) {
        throw new Error(`${labels[step]} Fehlgeschlagen: ${result.error || result.output.slice(-1600)}`);
      }
    }
    onProgress?.({ step: TOTAL_STEPS, totalSteps: TOTAL_STEPS, percent: 100, label: `${architecture} installiert und verifiziert (${model.id}).` });
    return { ok: true, python: paths.python, model: model.id, modelDir: paths.modelDir, weightsReady: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function installStemEngine(repoRoot, onProgress, options = {}) {
  const paths = installationPaths(repoRoot, options);
  const modelId = typeof options.modelId === 'string' && options.modelId.length > 0 ? options.modelId : PRIMARY_MODEL_ID;
  let model;
  try {
    model = loadSelectedModel(paths, modelId);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
  if (model.checkpoint.format === 'onnx') {
    return installOnnxModel(paths, model, onProgress, options);
  }
  return installTorchModel(repoRoot, paths, model, onProgress, options);
}

module.exports = { installStemEngine, locateBasePython, installationPaths, unpackedPath, probeVersion, runStreaming, loadSelectedModel, verifiedMarker, streamDownload, TOTAL_STEPS, ONNX_TOTAL_STEPS };
