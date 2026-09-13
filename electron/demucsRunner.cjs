'use strict';

/**
 * High-quality local stem separation through Meta's Demucs model.
 * The complete mix is the only model input. No reference stems are accepted.
 */
const { spawn } = require('node:child_process');
const { access, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];
const FT_WEIGHT_FILES = [
  'f7e0c4bc-ba3fe64a.th',
  'd12395a8-e57c48e6.th',
  '92cfc3b6-ef3bcb9c.th',
  '04573f0d-f3cf25b2.th',
];

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function defaultPythonCandidates(repoRoot) {
  return process.platform === 'win32'
    ? [
        path.join(repoRoot, '.venv', 'Scripts', 'python.exe'),
        'python',
        'python3',
      ]
    : [
        path.join(repoRoot, '.venv', 'bin', 'python3'),
        path.join(repoRoot, '.venv', 'bin', 'python'),
        'python3',
        'python',
      ];
}

function captureProcess(command, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false, timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, env: process.env });
    } catch (error) {
      finish({ ok: false, code: null, stdout, stderr, error: error.message });
      return;
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, code: null, stdout, stderr, error: 'Zeitüberschreitung bei Python-Prüfung' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish({ ok: false, code: null, stdout, stderr, error: error.message }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

/** Validate the executable, Python version and imports before processing audio. */
async function probePython(command, execute = captureProcess) {
  if (path.isAbsolute(command) && !await exists(command)) {
    return { command, usable: false, reason: 'Datei nicht gefunden' };
  }
  const script = [
    'import json, sys',
    'result={"version":list(sys.version_info[:3]),"executable":sys.executable}',
    'try:',
    ' import demucs, torch, torchaudio',
    ' result.update({"demucs":True,"torch":torch.__version__,"torchaudio":torchaudio.__version__})',
    'except Exception as e:',
    ' result.update({"demucs":False,"importError":str(e)})',
    'print(json.dumps(result))',
  ].join('\n');
  const processResult = await execute(command, ['-c', script]);
  if (!processResult.ok) {
    return {
      command, usable: false,
      reason: processResult.error || processResult.stderr.trim() || `Exit-Code ${processResult.code}`,
    };
  }
  try {
    const details = JSON.parse(processResult.stdout.trim().split(/\r?\n/).at(-1));
    const [major, minor] = details.version || [];
    if (major !== 3 || minor < 9 || minor > 13) {
      return { command, usable: false, details, reason: `Python ${major}.${minor} wird nicht unterstützt (benötigt 3.9–3.13)` };
    }
    if (!details.demucs) {
      return { command, usable: false, details, reason: `Demucs-Import fehlgeschlagen: ${details.importError}` };
    }
    return { command, usable: true, details };
  } catch (error) {
    return { command, usable: false, reason: `Ungültige Python-Prüfantwort: ${error.message}` };
  }
}

async function inspectDemucsEnvironment(repoRoot, candidateOverride, probe = probePython) {
  const explicit = process.env.DEMUCS_PYTHON;
  const candidates = candidateOverride || (explicit ? [explicit] : defaultPythonCandidates(repoRoot));
  const probes = [];
  for (const candidate of [...new Set(candidates)]) {
    const probeResult = await probe(candidate);
    probes.push(probeResult);
    if (probeResult.usable) {
      const checkpointDir = process.env.TORCH_HOME
        ? path.join(process.env.TORCH_HOME, 'hub', 'checkpoints')
        : path.join(os.homedir(), '.cache', 'torch', 'hub', 'checkpoints');
      const weightsPresent = (await Promise.all(
        FT_WEIGHT_FILES.map((file) => exists(path.join(checkpointDir, file)))
      )).filter(Boolean).length;
      return {
        available: true,
        python: candidate,
        details: probeResult.details,
        model: process.env.DEMUCS_MODEL || 'htdemucs_ft',
        weightsPresent,
        weightsRequired: FT_WEIGHT_FILES.length,
        weightsReady: weightsPresent === FT_WEIGHT_FILES.length,
        probes,
      };
    }
  }
  return {
    available: false,
    python: null,
    model: process.env.DEMUCS_MODEL || 'htdemucs_ft',
    weightsPresent: 0,
    weightsRequired: FT_WEIGHT_FILES.length,
    weightsReady: false,
    probes,
    reason: probes.map((p) => `${p.command}: ${p.reason}`).join(' | ') || 'Kein Python-Kandidat gefunden',
  };
}

async function resolvePython(repoRoot, candidateOverride) {
  const status = await inspectDemucsEnvironment(repoRoot, candidateOverride);
  if (!status.available) {
    throw new Error(
      `Keine verwendbare Demucs-Installation gefunden. ${status.reason}. ` +
      'Unter Windows Python 3.11 oder 3.12 installieren und "npm run stems:setup:win" ausführen.'
    );
  }
  return status.python;
}

function run(command, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: process.env });
    let output = '';
    const capture = (chunk) => {
      const text = chunk.toString();
      output = (output + text).slice(-16000);
      onProgress?.(text);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => reject(new Error(
      `Demucs konnte nicht gestartet werden (${command}): ${error.message}. ` +
      'Bitte zuerst "npm run stems:setup" ausführen.'
    )));
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`Demucs ist mit Code ${code} fehlgeschlagen.\n${output}`)));
  });
}

function buildDemucsArgs(inputPath, outputRoot, model) {
  const shifts = process.env.DEMUCS_SHIFTS || '10';
  const overlap = process.env.DEMUCS_OVERLAP || '0.5';
  const args = [
    '-m', 'demucs', '--name', model, '--shifts', shifts, '--overlap', overlap,
    '--float32', '--clip-mode', 'rescale', '--jobs', process.env.DEMUCS_JOBS || '1',
    '--out', outputRoot,
  ];
  if (process.env.DEMUCS_DEVICE) args.push('--device', process.env.DEMUCS_DEVICE);
  args.push(inputPath);
  return args;
}

async function separateWav(wavBytes, options = {}) {
  if (!wavBytes || wavBytes.byteLength < 44) throw new Error('Keine gültige WAV-Mixdatei empfangen.');
  const repoRoot = options.repoRoot || path.join(__dirname, '..');
  const model = options.model || process.env.DEMUCS_MODEL || 'htdemucs_ft';
  // Preflight occurs before allocating/writing a potentially huge song file.
  const python = await resolvePython(repoRoot, options.pythonCandidates);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'airdox-demucs-'));
  const inputPath = path.join(workDir, 'input-mix.wav');
  const outputRoot = path.join(workDir, 'output');

  try {
    await writeFile(inputPath, Buffer.from(wavBytes));
    await run(python, buildDemucsArgs(inputPath, outputRoot, model), options.onProgress);
    const songDir = path.join(outputRoot, model, 'input-mix');
    const result = { model, stems: {} };
    for (const stem of STEM_NAMES) {
      const stemPath = path.join(songDir, `${stem}.wav`);
      if (!await exists(stemPath)) throw new Error(`Demucs-Ausgabe fehlt: ${stem}.wav`);
      const bytes = await readFile(stemPath);
      if (bytes.length < 44) throw new Error(`Demucs-Ausgabe ist ungültig oder leer: ${stem}.wav`);
      result.stems[stem] = bytes;
    }
    return result;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

module.exports = {
  STEM_NAMES, FT_WEIGHT_FILES, buildDemucsArgs, defaultPythonCandidates,
  probePython, inspectDemucsEnvironment, resolvePython, separateWav,
};
