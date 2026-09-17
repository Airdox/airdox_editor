'use strict';

/**
 * High-quality local stem separation through Meta's Demucs model.
 * The complete mix is the only model input. No reference stems are accepted.
 */
const { spawn } = require('node:child_process');
const { access, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * Stem-Namen des Vorschau-Pfads – NICHT mehr als Konstante hartgeschrieben.
 *
 * Die Liste kommt aus dem Model-Katalog (`src/stems/modelCatalog.json`,
 * Eintrag der Familie `htdemucs`): `stemOrder` ist der einzige Ort, an dem
 * festgelegt wird, welches Modell welche Stems liefert. Der Fallback unten ist
 * nur die Notfall-Leine, wenn der Katalog nicht gelesen werden kann (z. B.
 * unvollständiges Paket) – und er wird von
 * `tests/stem-engine-ipc-contract.test.ts` gegen den Katalog geprüft, damit er
 * nicht schleichend von dem abweicht, was das Modell tatsächlich schreibt.
 */
const FALLBACK_STEM_NAMES = ['drums', 'bass', 'other', 'vocals'];

function readCatalog(repoRoot) {
  const candidates = [
    path.join(repoRoot || path.join(__dirname, '..'), 'src', 'stems', 'modelCatalog.json'),
    path.join(__dirname, '..', 'src', 'stems', 'modelCatalog.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
      if (Array.isArray(parsed?.models) && parsed.models.length) return parsed.models;
    } catch {
      /* nächster Kandidat */
    }
  }
  return null;
}

/** `stemOrder` des Deskriptors, der ein Demucs-Modell bedient (nach `--name`). */
function stemNamesForModel(model, repoRoot) {
  const models = readCatalog(repoRoot);
  if (!models) return [...FALLBACK_STEM_NAMES];
  const byVersion = models.find((entry) => entry.family === 'htdemucs' && entry.version === model);
  const byId = models.find((entry) => entry.family === 'htdemucs' && entry.id === model);
  const entry = byVersion || byId || models.find((candidate) => candidate.family === 'htdemucs');
  const order = Array.isArray(entry?.stemOrder) ? entry.stemOrder : null;
  return order && order.length ? [...order] : [...FALLBACK_STEM_NAMES];
}

const STEM_NAMES = stemNamesForModel('htdemucs_ft', undefined);
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
async function probePython(command, execute = captureProcess, onLog) {
  if (path.isAbsolute(command) && !await exists(command)) {
    onLog?.('debug', 'STEMS', `Python-Kandidat nicht gefunden: ${command}`);
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
    onLog?.('debug', 'STEMS', `Python-Kandidat unbrauchbar: ${command}`, {
      reason: processResult.error || processResult.stderr.trim() || `Exit-Code ${processResult.code}`,
      code: processResult.code,
    });
    return {
      command, usable: false,
      reason: processResult.error || processResult.stderr.trim() || `Exit-Code ${processResult.code}`,
    };
  }
  try {
    const details = JSON.parse(processResult.stdout.trim().split(/\r?\n/).at(-1));
    const [major, minor] = details.version || [];
    if (major !== 3 || minor < 9 || minor > 13) {
      onLog?.('debug', 'STEMS', `Python ${major}.${minor} unzulässig (${command})`);
      return { command, usable: false, details, reason: `Python ${major}.${minor} wird nicht unterstützt (benötigt 3.9–3.13)` };
    }
    if (!details.demucs) {
      onLog?.('debug', 'STEMS', `Demucs-Import fehlgeschlagen für ${command}`, { importError: details.importError });
      return { command, usable: false, details, reason: `Demucs-Import fehlgeschlagen: ${details.importError}` };
    }
    onLog?.('info', 'STEMS', `Verwendbare Demucs-Umgebung: ${command}`, {
      python: details.version,
      torch: details.torch,
      torchaudio: details.torchaudio,
      executable: details.executable,
    });
    return { command, usable: true, details };
  } catch (error) {
    onLog?.('debug', 'STEMS', `Ungültige Python-Prüfantwort von ${command}: ${error.message}`);
    return { command, usable: false, reason: `Ungültige Python-Prüfantwort: ${error.message}` };
  }
}

async function inspectDemucsEnvironment(repoRoot, candidateOverride, probe = probePython, onLog) {
  const explicit = process.env.DEMUCS_PYTHON;
  const candidates = candidateOverride || (explicit ? [explicit] : defaultPythonCandidates(repoRoot));
  const probes = [];
  for (const candidate of [...new Set(candidates)]) {
    const probeResult = await probe(candidate, captureProcess, onLog);
    probes.push(probeResult);
    if (probeResult.usable) {
      const checkpointDir = process.env.TORCH_HOME
        ? path.join(process.env.TORCH_HOME, 'hub', 'checkpoints')
        : path.join(os.homedir(), '.cache', 'torch', 'hub', 'checkpoints');
      const weightsPresent = (await Promise.all(
        FT_WEIGHT_FILES.map((file) => exists(path.join(checkpointDir, file)))
      )).filter(Boolean).length;
      onLog?.('info', 'STEMS', `Demucs-Modell-Checkpoints: ${weightsPresent}/${FT_WEIGHT_FILES.length} vorhanden`, {
        checkpointDir,
        weightsPresent,
        weightsRequired: FT_WEIGHT_FILES.length,
      });
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
  const reason = probes.map((p) => `${p.command}: ${p.reason}`).join(' | ') || 'Kein Python-Kandidat gefunden';
  onLog?.('warn', 'STEMS', `Keine verwendbare Demucs-Umgebung: ${reason}`, { probes });
  return {
    available: false,
    python: null,
    model: process.env.DEMUCS_MODEL || 'htdemucs_ft',
    weightsPresent: 0,
    weightsRequired: FT_WEIGHT_FILES.length,
    weightsReady: false,
    probes,
    reason,
  };
}

async function resolvePython(repoRoot, candidateOverride, onLog) {
  const status = await inspectDemucsEnvironment(repoRoot, candidateOverride, probePython, onLog);
  if (!status.available) {
    throw new Error(
      `Keine verwendbare Demucs-Installation gefunden. ${status.reason}. ` +
      'Unter Windows Python 3.11 oder 3.12 installieren und "npm run stems:setup:win" ausführen.'
    );
  }
  return status.python;
}

function run(command, args, onProgress, onLog) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    onLog?.('info', 'STEMS', `Demucs-Prozess gestartet: ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { windowsHide: true, env: process.env });
    let output = '';
    let lastLoggedLine = '';
    const capture = (chunk) => {
      const text = chunk.toString();
      output = (output + text).slice(-16000);
      onProgress?.(text);
      // tqdm/Progress-Bars nutzen \r; nur inhaltliche Zeilen ins Log schreiben.
      for (const rawLine of text.split(/[\r\n]+/)) {
        const line = rawLine.trim();
        if (line && line !== lastLoggedLine) {
          lastLoggedLine = line;
          onLog?.('debug', 'STEMS', `[demucs] ${line.slice(0, 500)}`);
        }
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => {
      onLog?.('error', 'STEMS', `Demucs konnte nicht gestartet werden (${command}): ${error.message}`, {
        stack: error.stack,
      });
      reject(new Error(
        `Demucs konnte nicht gestartet werden (${command}): ${error.message}. ` +
        'Bitte zuerst "npm run stems:setup" ausführen.'
      ));
    });
    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        onLog?.('info', 'STEMS', `Demucs-Prozess erfolgreich beendet (${durationMs} ms)`);
        resolve();
      } else {
        onLog?.('error', 'STEMS', `Demucs-Prozess mit Code ${code} fehlgeschlagen (${durationMs} ms)`, {
          outputTail: output.slice(-2000),
        });
        reject(new Error(`Demucs ist mit Code ${code} fehlgeschlagen.\n${output}`));
      }
    });
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
  const onLog = options.onLog;
  onLog?.('info', 'STEMS', `Stem-Separation gestartet (Modell: ${model})`, {
    inputBytes: wavBytes.byteLength,
  });
  const python = await resolvePython(repoRoot, options.pythonCandidates, onLog);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'airdox-demucs-'));
  const inputPath = path.join(workDir, 'input-mix.wav');
  const outputRoot = path.join(workDir, 'output');
  onLog?.('debug', 'STEMS', `Temporäres Arbeitsverzeichnis: ${workDir}`);

  try {
    await writeFile(inputPath, Buffer.from(wavBytes));
    await run(python, buildDemucsArgs(inputPath, outputRoot, model), options.onProgress, onLog);
    const songDir = path.join(outputRoot, model, 'input-mix');
    const result = { model, stems: {} };
    const stemNames = stemNamesForModel(model, repoRoot);
    for (const stem of stemNames) {
      const stemPath = path.join(songDir, `${stem}.wav`);
      if (!await exists(stemPath)) {
        onLog?.('error', 'STEMS', `Demucs-Ausgabe fehlt: ${stem}.wav`, { songDir });
        throw new Error(`Demucs-Ausgabe fehlt: ${stem}.wav`);
      }
      const bytes = await readFile(stemPath);
      if (bytes.length < 44) {
        onLog?.('error', 'STEMS', `Demucs-Ausgabe ist ungültig oder leer: ${stem}.wav (${bytes.length} B)`);
        throw new Error(`Demucs-Ausgabe ist ungültig oder leer: ${stem}.wav`);
      }
      result.stems[stem] = bytes;
      onLog?.('debug', 'STEMS', `Stem erzeugt: ${stem}.wav`, { bytes: bytes.length });
    }
    onLog?.('info', 'STEMS', 'Stem-Separation erfolgreich abgeschlossen', {
      model,
      stemBytes: Object.fromEntries(Object.entries(result.stems).map(([k, v]) => [k, v.length])),
    });
    return result;
  } catch (error) {
    onLog?.('error', 'STEMS', `Stem-Separation fehlgeschlagen: ${error.message}`, { stack: error.stack });
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
    onLog?.('debug', 'STEMS', `Temporäres Arbeitsverzeichnis bereinigt: ${workDir}`);
  }
}

module.exports = {
  STEM_NAMES, FALLBACK_STEM_NAMES, stemNamesForModel, readCatalog, FT_WEIGHT_FILES, buildDemucsArgs, defaultPythonCandidates,
  probePython, inspectDemucsEnvironment, resolvePython, separateWav,
};
