'use strict';

/**
 * Stem-Runner: die testbaren, reinen Bausteine für die Anbindung des externen
 * Separators (`audio-separator` CLI) an den Electron-Main-Process.
 *
 * Warum das hier ausgelagert ist:
 *  - `execFile` mit Argument-Array statt Shell-String → Pfade mit Leerzeichen,
 *    Umlauten oder Anführungszeichen können den Befehl nicht mehr zerlegen
 *    (und es gibt keine Command-Injection über Dateinamen).
 *  - Ausgabeordner pro Track → keine Stem-Leichen von früheren Läufen.
 *  - Fehlerklassifikation → der Renderer bekommt eine verständliche, deutsche
 *    Meldung inkl. Installationshinweis statt "Command failed: ...".
 *
 * Dieses Modul importiert bewusst kein `electron` und ist damit in Node
 * direkt testbar (tests/stem-runner.test.mjs).
 */

const path = require('node:path');
const crypto = require('node:crypto');

const SEPARATOR_BIN = 'audio-separator';
/** Umgebungsvariable, mit der ein eigener Separator-Pfad erzwungen werden kann. */
const SEPARATOR_ENV_VAR = 'AIRDOX_AUDIO_SEPARATOR';
const INSTALL_HINT =
  'Python-Separator installieren: pip install "audio-separator[cpu]" (mit NVIDIA-GPU: pip install "audio-separator[gpu]"). ' +
  'Danach muss der Befehl "audio-separator" im PATH liegen; alternativ den vollen Pfad in der Umgebungsvariable ' +
  `${SEPARATOR_ENV_VAR} setzen.`;

const ERROR_CODES = {
  NOT_INSTALLED: 'SEPARATOR_NOT_INSTALLED',
  INPUT_MISSING: 'SEPARATOR_INPUT_MISSING',
  NO_OUTPUT: 'SEPARATOR_NO_OUTPUT',
  /** Gewichte fehlen lokal und können auch nicht delegiert geladen werden. */
  MODEL_MISSING: 'SEPARATOR_MODEL_MISSING',
  MODEL_NO_URL: 'SEPARATOR_MODEL_NO_URL',
  MODEL_UNSUPPORTED: 'SEPARATOR_MODEL_UNSUPPORTED',
  MODEL_FAILED: 'SEPARATOR_MODEL_FAILED',
  RUNTIME_FAILED: 'SEPARATOR_RUNTIME_FAILED',
  TIMEOUT: 'SEPARATOR_TIMEOUT',
  CANCELLED: 'SEPARATOR_CANCELLED',
  FAILED: 'SEPARATOR_FAILED',
};

/** Dateiname → sicherer Ordnername (keine Pfadtrenner, keine Steuerzeichen). */
function sanitizeFolderName(value, fallback = 'track') {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const limited = cleaned.slice(0, 60).trim();
  return limited || fallback;
}

/**
 * Eigener Ausgabeordner pro Quelldatei. Der Hash unterscheidet zwei Tracks mit
 * gleichem Dateinamen (z. B. "mix.wav" aus zwei verschiedenen Ordnern).
 */
function trackOutputRoot(rootDir, inputFilePath) {
  const absolute = path.resolve(String(inputFilePath));
  const digest = crypto.createHash('sha1').update(absolute).digest('hex').slice(0, 8);
  const base = sanitizeFolderName(path.basename(absolute, path.extname(absolute)));
  return path.join(rootDir, `${base}-${digest}`);
}

/** Argument-Array für den externen Separator (kein Shell-String!). */
function buildSeparatorArgs(options = {}) {
  const { inputPath, outputDir, modelFilename, modelFileDir, outputFormat = 'WAV', chunkDuration, extraArgs = [] } = options;
  if (!inputPath) throw new Error('inputPath fehlt für den Separator-Aufruf');
  if (!outputDir) throw new Error('outputDir fehlt für den Separator-Aufruf');
  const args = [String(inputPath), '--output_dir', String(outputDir), '--output_format', String(outputFormat)];
  if (modelFilename) args.push('--model_filename', String(modelFilename));
  if (modelFileDir) args.push('--model_file_dir', String(modelFileDir));
  if (chunkDuration) args.push('--chunk_duration', String(chunkDuration));
  for (const extra of extraArgs) {
    const value = String(extra ?? '').trim();
    if (value) args.push(value);
  }
  return args;
}

function isStemOutputFile(name) {
  return path.extname(String(name)).toLowerCase() === '.wav';
}

/** Dateiliste eines Ordners als Map(name → mtimeMs/size) – für die Diff-Bildung. */
function toFileSnapshot(entries) {
  const snapshot = new Map();
  for (const entry of entries || []) {
    if (!entry || typeof entry.name !== 'string') continue;
    snapshot.set(entry.name, { mtimeMs: Number(entry.mtimeMs) || 0, size: Number(entry.size) || 0 });
  }
  return snapshot;
}

/**
 * Nur die WAV-Dateien dieses Laufs: neu erzeugt oder seit dem Start verändert.
 * So landen keine Stems eines früheren Tracks im Ergebnis.
 */
function collectStemOutputs(options = {}) {
  const { outputDir, filesBefore = [], filesAfter = [] } = options;
  if (!outputDir) throw new Error('outputDir fehlt');
  const before = toFileSnapshot(filesBefore);
  const after = toFileSnapshot(filesAfter);
  const produced = [];
  for (const [name, info] of after) {
    if (!isStemOutputFile(name)) continue;
    const previous = before.get(name);
    const isNew = !previous || previous.mtimeMs !== info.mtimeMs || previous.size !== info.size;
    if (isNew) produced.push(path.join(outputDir, name));
  }
  return produced.sort((a, b) => a.localeCompare(b));
}

function lastMeaningfulLine(text, limit = 320) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, '').trim())
    // reine Fortschrittsbalken (tqdm) tragen nichts zur Fehlerursache bei
    .filter((line) => line && !/^\d{1,3}%\|/.test(line) && !/^\[\d{2}:\d{2}(<\d{2}:\d{2})?,\s*\d/.test(line));
  const tail = lines.slice(-3).join(' | ');
  return tail.length > limit ? `${tail.slice(0, limit - 1)}…` : tail;
}

/**
 * Übersetzt einen fehlgeschlagenen Separator-Lauf in einen stabilen Code plus
 * eine Meldung, die ein DJ versteht (inkl. konkretem nächsten Schritt).
 */
function classifySeparatorFailure(input = {}) {
  const { error = null, stderr = '', stdout = '', inputPath = null, timedOut = false, cancelled = false } = input;
  const combined = `${error?.message ?? ''}\n${stderr}\n${stdout}`;
  const detail = lastMeaningfulLine(stderr) || lastMeaningfulLine(error?.message);

  if (cancelled || error?.signal === 'SIGTERM' || error?.killed === true) {
    return { code: ERROR_CODES.CANCELLED, message: 'Stem-Separation wurde abgebrochen.', hint: '' };
  }
  if (timedOut || error?.code === 'ETIMEDOUT') {
    return {
      code: ERROR_CODES.TIMEOUT,
      message: `Der externe Separator hat zu lange nicht geantwortet. ${detail}`.trim(),
      hint: 'Modell wechseln, --chunk_duration setzen oder die interne Heuristik-Separation verwenden.',
    };
  }
  if (error?.code === 'ENOENT' || /(not recognized as an internal or external command|command not found|is not recognized|no such file or directory|cannot find the path|nicht als (interner|externer) Befehl)/i.test(combined)) {
    return {
      code: ERROR_CODES.NOT_INSTALLED,
      message: 'Der externe Separator "audio-separator" ist nicht installiert oder nicht im PATH.',
      hint: INSTALL_HINT,
    };
  }
  if (inputPath && /(no such file|not found|does not exist|cannot open|datei nicht gefunden)/i.test(combined) && new RegExp(String(inputPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(combined)) {
    return {
      code: ERROR_CODES.INPUT_MISSING,
      message: `Die Audiodatei konnte vom Separator nicht gelesen werden: ${inputPath}`,
      hint: 'Datei existiert nicht mehr, liegt auf einem getrennten Laufwerk oder ist kein unterstütztes Audioformat.',
    };
  }
  if (/(cuda|out of memory|oom|cudnn|onnxruntime|directml|torch|no module named|modulenotfound|importerror)/i.test(combined)) {
    return {
      code: ERROR_CODES.RUNTIME_FAILED,
      message: `Die Python-Laufzeit des Separators ist fehlgeschlagen. ${detail}`.trim(),
      hint: 'CPU-Variante installieren (pip install "audio-separator[cpu]") oder ein kleineres Modell wählen.',
    };
  }
  if (/(download|urllib|ssl|certificate|http|404|connection)/i.test(combined) && /model/i.test(combined)) {
    return {
      code: ERROR_CODES.MODEL_FAILED,
      message: `Das Modell konnte nicht geladen/heruntergeladen werden. ${detail}`.trim(),
      hint: 'Internetverbindung prüfen oder das Modell vorab in den Modellordner legen.',
    };
  }
  return {
    code: ERROR_CODES.FAILED,
    message: `Stem-Separation fehlgeschlagen. ${detail}`.trim(),
    hint: '',
  };
}

/** Fortschritt aus den tqdm-/Log-Zeilen des Separators (best effort). */
function parseSeparatorProgress(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  const percent = text.match(/(\d{1,3})\s*%/);
  if (percent) {
    const ratio = Math.max(0, Math.min(100, Number(percent[1]))) / 100;
    return { ratio, message: `Externer Separator: ${percent[1]} %` };
  }
  const stage = text.match(/^(INFO|WARNING|ERROR)?\s*[-:]?\s*(Loading model|Separating|Downloading|Processing|Saving|Starting)/i);
  if (stage) return { ratio: null, message: `Externer Separator: ${stage[2]}` };
  return null;
}

/** Pfad-Join passend zur Zielplattform (auch wenn die Host-Plattform anders ist). */
function joinFor(platform, ...parts) {
  return platform === 'win32' ? path.win32.join(...parts) : path.posix.join(...parts);
}

/** Kandidaten für die Separator-Suche, inkl. Override und pip-Script-Ordner. */
function separatorCandidates(options = {}) {
  const { env = {}, platform = process.platform, scriptDirs = [] } = options;
  const override = env[SEPARATOR_ENV_VAR];
  const candidates = [];
  if (override && String(override).trim()) candidates.push({ command: String(override).trim(), source: 'env' });
  for (const dir of scriptDirs) {
    const binary = platform === 'win32' ? joinFor('win32', dir, `${SEPARATOR_BIN}.exe`) : joinFor(platform, dir, SEPARATOR_BIN);
    candidates.push({ command: binary, source: 'python-scripts' });
  }
  candidates.push({ command: SEPARATOR_BIN, source: 'path' });
  return candidates;
}

/**
 * Erste brauchbare Zeile der `where`/`which`-Ausgabe. Auf Windows wird ein
 * natives `.exe` bevorzugt: `.cmd`-Shims darf Node nur über eine Shell starten,
 * was wieder Quoting-Probleme bei Pfaden mit Leerzeichen einführen würde.
 */
function parseLookupOutput(stdout, options = {}) {
  const preferExtensions = options.preferExtensions ?? ['.exe'];
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter((line) => line && !line.startsWith('INFO:'));
  if (!lines.length) return null;
  for (const extension of preferExtensions) {
    const hit = lines.find((line) => line.toLowerCase().endsWith(extension));
    if (hit) return hit;
  }
  return lines[0];
}

/** Braucht dieser Befehl eine Shell (Windows `.cmd`/`.bat`-Shims)? */
function requiresShell(command) {
  return /\.(cmd|bat)$/i.test(String(command ?? ''));
}

/**
 * Argumente für den Shell-Fall sicher quoten (nur nötig bei `.cmd`-Shims).
 * Doppelte Ausführung wird verhindert, indem der Aufrufer `execFile` mit
 * Argument-Array nutzt, wann immer keine Shell erforderlich ist.
 */
function toShellArgs(args) {
  return (args ?? []).map((arg) => {
    const value = String(arg);
    return /[\s"&|^<>]/.test(value) ? `"${value.replace(/(["\\])(?=[\s"&|^<>]|$)/g, '\\$1')}"` : value;
  });
}

/**
 * Parses the model list of the separator CLI (`-l --list_format=json`).
 * The CLI mixes log lines into stdout, so the JSON block is located first and
 * the field names are read tolerantly (the upstream schema changed before).
 */
function parseRuntimeModelList(stdout) {
  const text = String(stdout ?? '');
  const start = text.search(/[[{]/);
  if (start < 0) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    // Manche Versionen geben pro Zeile ein JSON-Objekt aus (JSONL).
    const lines = text
      .slice(start)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const collected = [];
    for (const line of lines) {
      try {
        collected.push(JSON.parse(line));
      } catch {
        /* keine JSON-Zeile */
      }
    }
    if (!collected.length) return [];
    parsed = collected;
  }
  const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
  const pick = (entry, keys) => {
    for (const key of keys) {
      const value = entry?.[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  };
  const models = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const fileName = pick(entry, ['fileName', 'filename', 'file_name', 'model_filename', 'model_name', 'name']);
    if (!fileName) continue;
    const rawStems = pick(entry, ['stemNames', 'output_stems', 'outputStems', 'stems', 'stem_names']);
    const stemNames = Array.isArray(rawStems) ? rawStems.map((stem) => String(stem)) : typeof rawStems === 'string' ? rawStems.split(',').map((stem) => stem.trim()).filter(Boolean) : undefined;
    models.push({
      fileName: String(fileName),
      stemNames,
      architecture: pick(entry, ['architecture', 'arch_type', 'model_arch', 'archType']),
      modelSize: Number(pick(entry, ['modelSize', 'model_size', 'size_mb', 'sizeMb'])) || undefined,
      trainable: pick(entry, ['trainable', 'is_trainable']),
    });
  }
  return models;
}

/** Argumente für den Modelllisten-Aufruf der CLI. */
function buildListModelsArgs(options = {}) {
  const args = ['-l', '--list_format=json'];
  if (options.modelFileDir) args.push('--model_file_dir', String(options.modelFileDir));
  return args;
}

const MODEL_URL_PROTOCOLS = new Set(['https:']);

/** Dateiname ohne Pfadanteile – Spiegelbild der Store-Prüfung (kein require-Kreis). */
function safeModelFileName(name) {
  const base = String(name ?? '').trim().split(/[\\/]/).pop() ?? '';
  if (!base || base === '.' || base === '..') throw new Error('Ungültiger Modell-Dateiname');
  return base;
}

/**
 * Validiert den Modell-Payload des Renderers. Der Renderer liefert den Katalog-
 * eintrag, der Main-Prozess entscheidet, was davon sicher ist:
 *  - Dateiname ohne Pfadtrenner/Steuerzeichen, nur [A-Za-z0-9._-],
 *  - Direkt-Downloads ausschließlich über HTTPS (Ausnahme: explizite
 *    Dev-Freigabe über AIRDOX_ALLOW_INSECURE_MODEL_DOWNLOAD=1),
 *  - Prüfsumme nur als 64-Hex-Zeichen, Größe nur als positive ganze Zahl.
 */
function normalizeModelRequest(payload, options = {}) {
  const env = options.env ?? process.env;
  if (!payload || typeof payload !== 'object') return null;
  const rawFileName = typeof payload.fileName === 'string' ? payload.fileName.trim() : '';
  if (!rawFileName) return null;
  const fileName = safeModelFileName(rawFileName);
  if (!/^[A-Za-z0-9._-]{2,120}$/.test(fileName)) {
    throw Object.assign(new Error(`Ungültiger Modell-Dateiname: ${fileName}`), { code: ERROR_CODES.MODEL_UNSUPPORTED });
  }
  const model = {
    id: typeof payload.id === 'string' ? payload.id.slice(0, 120) : null,
    fileName,
    label: typeof payload.label === 'string' ? payload.label.slice(0, 160) : fileName,
    sha256: /^[a-f0-9]{64}$/i.test(String(payload.sha256 ?? '')) ? String(payload.sha256).toLowerCase() : null,
    expectedSizeBytes: Number.isFinite(Number(payload.expectedSizeBytes)) && Number(payload.expectedSizeBytes) > 0 ? Math.floor(Number(payload.expectedSizeBytes)) : null,
    downloadUrl: null,
  };
  const rawUrl = typeof payload.downloadUrl === 'string' ? payload.downloadUrl.trim() : '';
  if (rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw Object.assign(new Error(`Ungültige Modell-Download-URL: ${rawUrl}`), { code: ERROR_CODES.MODEL_UNSUPPORTED });
    }
    const allowInsecure = env.AIRDOX_ALLOW_INSECURE_MODEL_DOWNLOAD === '1';
    if (!MODEL_URL_PROTOCOLS.has(parsed.protocol) && !(allowInsecure && parsed.protocol === 'http:')) {
      throw Object.assign(new Error(`Modell-Downloads sind nur über HTTPS erlaubt (erhalten: ${parsed.protocol}).`), {
        code: ERROR_CODES.MODEL_UNSUPPORTED,
      });
    }
    model.downloadUrl = parsed.toString();
  }
  return model;
}

module.exports = {
  SEPARATOR_BIN,
  SEPARATOR_ENV_VAR,
  INSTALL_HINT,
  ERROR_CODES,
  sanitizeFolderName,
  trackOutputRoot,
  buildSeparatorArgs,
  isStemOutputFile,
  toFileSnapshot,
  collectStemOutputs,
  classifySeparatorFailure,
  parseSeparatorProgress,
  separatorCandidates,
  parseLookupOutput,
  requiresShell,
  toShellArgs,
  joinFor,
  parseRuntimeModelList,
  buildListModelsArgs,
  normalizeModelRequest,
  MODEL_URL_PROTOCOLS,
  lastMeaningfulLine,
};
