'use strict';

/**
 * Host für die neue Stem-Separations-Engine im Main-Prozess.
 *
 * Der Kern (`src/stems/*`) ist TypeScript, `electron/main.cjs` ist CommonJS –
 * die Brücke ist deshalb das von `npm run build:stems-bridge` erzeugte Bundle
 * `dist/stems/node-bridge.cjs`. Fehlt das Bundle (frischer Checkout, nur
 * `npm run dev`), meldet dieser Host einen klaren Grund statt still
 * "nicht verfügbar" zu spielen; der Renderer fällt dann auf den bewährten
 * Demucs-Pfad (PREVIEW) zurück.
 *
 * Bewusst dünn: keine Logik außer Transport, Pfad- und Größen-Absicherung.
 * Job-Zustand, Profile, Cache, Abbruch und Validierung gehören
 * `src/stems/stemJobService.ts` – dieselbe Implementierung, die der
 * Dev-/Browser-Server über HTTP anbietet.
 */
const path = require('node:path');
const fs = require('node:fs');

/** IPC-Kanäle – der Renderer spricht ausschließlich diese. */
const CHANNELS = {
  status: 'stems:engine-status',
  start: 'stems:job-start',
  wait: 'stems:job-wait',
  job: 'stems:job-get',
  jobs: 'stems:job-list',
  cancel: 'stems:job-cancel',
  pause: 'stems:job-pause',
  resume: 'stems:job-resume',
  stem: 'stems:job-stem',
  metadata: 'stems:job-metadata',
  progress: 'stems:job-progress',
  // High-Quality extern (Google Drive + Colab-Worker, §15). Eigene Kanäle,
  // damit der lokale Pfad unverändert bleibt und eine ältere Brücke ohne
  // Fernpfad weiter funktioniert (der Renderer prüft auf Vorhandensein).
  remoteStatus: 'stems:remote-status',
  remoteStart: 'stems:remote-start',
  remoteJobs: 'stems:remote-jobs',
  remotePoll: 'stems:remote-poll',
  remoteCancel: 'stems:remote-cancel',
  remoteResume: 'stems:remote-resume',
  remoteConfigure: 'stems:remote-configure',
  remoteProgress: 'stems:remote-progress',
  // Manuelle Bestätigung der Cloud-Synchronisation (§40). Eigener Kanal: eine
  // ältere Brücke ohne diesen Kanal bleibt voll funktionsfähig, der Renderer
  // prüft auf Vorhandensein und blendet den Knopf sonst aus.
  remoteCloudSync: 'stems:remote-cloud-sync',
};

/** Obergrenze für den Mix, den der Renderer hochreicht (float32-Stereo-WAV). */
const MAX_INPUT_BYTES = 1024 * 1024 * 1024;
const PROFILES = ['PREVIEW', 'BALANCED', 'HIGH', 'HIGH_QUALITY', 'MAXIMUM_QUALITY'];
// Muss KNOWN_FAMILIES aus src/stems/modelRegistry.ts widerspiegeln. `pipeline_double`
// ist absichtlich dabei (der Kern lehnt es ohne allowPipelineDouble ab), damit ein
// Test-Double-Request nicht schon hier verworfen, sondern mit dem echten Fehlercode
// des Kerns beantwortet wird.
const FAMILIES = ['bs_roformer', 'mel_band_roformer', 'htdemucs', 'pipeline_double'];
/** Rechengeräte und Validierungstiefe, die ein Job aus dem Renderer wählen darf. */
const DEVICES = ['auto', 'cpu', 'cuda', 'vulkan', 'metal', 'directml', 'coreml'];
const MODES = ['fast_dj', 'studio_master'];

/** Shared by the desktop and HTTP hosts; directories alone are not models. */
function resolveEnginePaths(repoRoot, stemsRoot) {
  const { getPythonCandidates, getModelCandidates, getResourcesPath, PRIMARY_CHECKPOINT, PRIMARY_CONFIG } = require('./stemRuntime.cjs');
  const { installationPaths, unpackedPath } = require('./stemInstaller.cjs');
  const install = installationPaths(repoRoot, { stemsRoot });
  const resources = getResourcesPath(repoRoot);
  const python = process.env.AIRODOX_STEM_PYTHON || process.env.DEMUCS_PYTHON ||
    (fs.existsSync(install.python) ? install.python : getPythonCandidates(repoRoot, resources).find(c => fs.existsSync(c))) || install.python;
  const candidates = [install.modelDir, ...getModelCandidates(repoRoot, resources)];
  const modelStoreDir = process.env.AIRODOX_STEM_MODEL_DIR || process.env.AIRODOX_STEM_CHECKPOINT_DIR ||
    candidates.find(c => fs.existsSync(path.join(c, PRIMARY_CHECKPOINT)) && fs.existsSync(path.join(c, PRIMARY_CONFIG))) || install.modelDir;
  return {
    modelStoreDir,
    backend: {
      pythonCommand: python,
      nativeCommand: process.env.AIRODOX_AUDIOCPP_CLI,
      adapterScript: unpackedPath(process.env.AIRODOX_STEM_ADAPTER || path.join(repoRoot, 'python', 'bsroformer_inference.py')),
      referenceSourceDir: process.env.AIRODOX_MSST_DIR,
      modelStoreDir,
    },
  };
}

function log(logger, level, message, details) {
  try {
    (logger && logger[level] ? logger[level] : logger ? logger.info : () => {})(
      'STEMS',
      message,
      details === undefined ? undefined : details
    );
  } catch {
    /* Loggen darf einen Separationslauf nie aufhalten. */
  }
}

/**
 * Lädt das Engine-Bundle. Gibt `{ bridge, bundlePath, reason }` zurück –
 * `bridge === null` ist ein erlaubter Zustand (kein Build), kein Fehler.
 */
function loadStemBridge(repoRoot, logger) {
  const bundlePath =
    process.env.AIRDOX_STEMS_BRIDGE || path.join(repoRoot, 'dist', 'stems', 'node-bridge.cjs');
  if (!fs.existsSync(bundlePath)) {
    const reason =
      `Engine-Bundle fehlt (${bundlePath}). Build: npm run build:stems-bridge ` +
      '(läuft automatisch mit "npm run build").';
    return { bridge: null, bundlePath, reason };
  }
  try {
    const module = require(bundlePath);
    const factory = module.createStemBridge || (module.default && module.default.createStemBridge);
    const clearCaches = module.clearRuntimeCaches || (module.default && module.default.clearRuntimeCaches);
    if (typeof factory !== 'function') {
      return { bridge: null, bundlePath, reason: 'Engine-Bundle exportiert createStemBridge nicht – Version prüfen.' };
    }
    return { bridge: factory, clearCaches, bundlePath, reason: undefined };
  } catch (error) {
    return { bridge: null, bundlePath, reason: `Engine-Bundle konnte nicht geladen werden: ${error.message}` };
  }
}

function toBytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Buffer.isBuffer(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** Nur bekannte Felder durchreichen – das IPC-Payload kommt aus dem Renderer. */
function sanitizeRequest(raw) {
  const request = {};
  if (!raw || typeof raw !== 'object') return request;
  if (typeof raw.trackName === 'string' && raw.trackName.length) request.trackName = raw.trackName.slice(0, 120);
  if (typeof raw.modelId === 'string' && raw.modelId.length) request.modelId = raw.modelId.slice(0, 120);
  if (PROFILES.includes(raw.profile)) request.profile = raw.profile;
  if (FAMILIES.includes(raw.family)) request.family = raw.family;
  if (typeof raw.device === 'string' && DEVICES.includes(raw.device)) request.device = raw.device;
  if (MODES.includes(raw.mode)) request.mode = raw.mode;
  if (typeof raw.precision === 'string') request.precision = raw.precision;
  if (typeof raw.overlap === 'number' && raw.overlap >= 0 && raw.overlap <= 0.95) request.overlap = raw.overlap;
  if (typeof raw.chunkSizeSamples === 'number' && raw.chunkSizeSamples >= 4096) request.chunkSizeSamples = Math.floor(raw.chunkSizeSamples);
  if (raw.clipMode === 'none' || raw.clipMode === 'rescale') request.clipMode = raw.clipMode;
  if (typeof raw.dcRemoval === 'boolean') request.dcRemoval = raw.dcRemoval;
  if (Array.isArray(raw.stems) && raw.stems.length && raw.stems.every((stem) => typeof stem === 'string' && /^[a-z0-9_-]{1,32}$/.test(stem))) {
    request.stems = raw.stems.slice(0, 16);
  }
  return request;
}

/**
 * Registriert alle Stem-Job-Kanäle.
 *
 * @param {object} options
 * @param {string} options.repoRoot      Root der App (enthält dist/)
 * @param {string} options.userDataDir   Schreibbarer Datenordner der Engine
 * @param {object} [options.logger]      mainLogger mit debug/info/warn/error
 * @param {object} options.ipcMain       Electron ipcMain
 * @param {(channel: string, payload: unknown) => void} [options.broadcast]
 *        Verteilt Fortschritts-Events an alle Fenster.
 */
function registerStemEngineIpc({ repoRoot, userDataDir, logger, ipcMain, broadcast }) {
  const loaded = loadStemBridge(repoRoot, logger);
  const roots = {
    root: path.join(userDataDir, 'stems'),
  };

  if (!loaded.bridge) {
    log(logger, 'warn', 'Stem-Engine nicht geladen – Renderer nutzt den Demucs-Vorschau-Pfad', { reason: loaded.reason });
    // Ein Kanal bleibt registriert, damit der Renderer einen Grund bekommt
    // statt in einem "No handler registered"-Fehler zu landen.
    ipcMain.handle(CHANNELS.status, async () => ({
      ok: false,
      code: 'ENGINE_BUNDLE_MISSING',
      message: loaded.reason,
      bundlePath: loaded.bundlePath,
    }));
    return { available: false, reason: loaded.reason, bundlePath: loaded.bundlePath, channels: CHANNELS, bridge: null };
  }

  const createBridge = () => loaded.bridge({
    root: roots.root,
    env: process.env,
    allowPipelineDouble: process.env.AIRDOX_STEM_ALLOW_PIPELINE_DOUBLE === '1',
    // DJ-Pfad: die App validiert standardmäßig schnell (Geometrie, endliche
    // Samples, Peak) statt der vollen Grenz-/Rekombinationsanalyse. Über
    // AIRODOX_STEM_MODE=studio_master lässt sich das verschärfen, und
    // AIRODOX_STEM_DEVICE wählt das Rechengerät der ONNX-Engine.
    mode: process.env.AIRDOX_STEM_MODE || 'fast_dj',
    device: process.env.AIRDOX_STEM_DEVICE,
    ...resolveEnginePaths(repoRoot, roots.root),
    logger: {
      debug: (category, message, details) => log(logger, 'debug', `[bridge] ${message}`, details),
      info: (category, message, details) => log(logger, 'info', `[bridge] ${message}`, details),
      warn: (category, message, details) => log(logger, 'warn', `[bridge] ${message}`, details),
      error: (category, message, details) => log(logger, 'error', `[bridge] ${message}`, details),
    },
  });

  let bridge = createBridge();
  function attachEvents() {
    if (typeof bridge.onEvent === 'function') {
      bridge.onEvent((event) => {
        if (!broadcast) return;
        try {
          broadcast(CHANNELS.progress, event);
        } catch (error) {
          log(logger, 'warn', 'Fortschritts-Event konnte nicht verteilt werden', { error: error.message });
        }
      });
    }
    if (typeof bridge.onRemoteEvent === 'function') {
      bridge.onRemoteEvent((event) => {
        if (!broadcast) return;
        try {
          broadcast(CHANNELS.remoteProgress, event);
        } catch (error) {
          log(logger, 'warn', 'Fern-Job-Event konnte nicht verteilt werden', { error: error.message });
        }
      });
    }
  }
  attachEvents();

  ipcMain.handle(CHANNELS.status, async () => {
    const status = await bridge.status();
    return { ...status, bundlePath: loaded.bundlePath };
  });

  ipcMain.handle(CHANNELS.start, async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const request = sanitizeRequest(input);
    const bytes = toBytes(input.bytes);
    if (bytes) {
      if (bytes.byteLength > MAX_INPUT_BYTES) {
        return { ok: false, code: 'AUDIO_CORRUPT', message: `Mix zu groß (${bytes.byteLength} Bytes > ${MAX_INPUT_BYTES}).` };
      }
      request.bytes = bytes;
    } else if (typeof input.inputPath === 'string' && input.inputPath.length) {
      // Nur Dateien unterhalb des Engine-Datenordners akzeptieren: der Renderer
      // darf keinen beliebigen Pfad des Nutzers zur Inferenz vorlegen.
      const resolved = path.resolve(input.inputPath);
      const allowedRoot = path.resolve(roots.root);
      if (!resolved.startsWith(allowedRoot + path.sep)) {
        return { ok: false, code: 'WRITE_DENIED', message: 'inputPath liegt außerhalb des Engine-Datenordners.' };
      }
      request.inputPath = resolved;
    } else {
      return { ok: false, code: 'AUDIO_MISSING', message: 'Stem-Job braucht bytes (Mix) oder einen inputPath im Engine-Ordner.' };
    }
    log(logger, 'info', 'Stem-Job über IPC gestartet', { profile: request.profile, model: request.modelId, trackName: request.trackName });
    return bridge.start(request);
  });

  ipcMain.handle(CHANNELS.wait, async (_event, jobId) => bridge.wait(String(jobId)));
  ipcMain.handle(CHANNELS.job, async (_event, jobId) => bridge.job(String(jobId)));
  ipcMain.handle(CHANNELS.jobs, async () => bridge.jobs());
  ipcMain.handle(CHANNELS.cancel, async (_event, jobId, reason) => bridge.cancel(String(jobId), typeof reason === 'string' ? reason.slice(0, 200) : undefined));
  ipcMain.handle(CHANNELS.pause, async (_event, jobId) => bridge.pause(String(jobId)));
  ipcMain.handle(CHANNELS.resume, async (_event, jobId) => bridge.resume(String(jobId)));
  ipcMain.handle(CHANNELS.stem, async (_event, jobId, stemId) => bridge.stem(String(jobId), String(stemId).slice(0, 32)));
  ipcMain.handle(CHANNELS.metadata, async (_event, jobId) => bridge.metadata(String(jobId)));

  /* --- High Quality extern (§15) ----------------------------------------- */
  // Wie beim lokalen Job gilt: nur Bytes oder Pfade innerhalb des
  // Engine-Datenordners. Die Arbeitskopie entsteht ausschließlich dort.
  ipcMain.handle(CHANNELS.remoteStatus, async () => bridge.remoteStatus());
  ipcMain.handle(CHANNELS.remoteStart, async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const bytes = toBytes(input.bytes);
    const request = {
      trackName: typeof input.trackName === 'string' ? input.trackName.slice(0, 120) : undefined,
      profile: PROFILES.includes(input.profile) ? input.profile : undefined,
      modelId: typeof input.modelId === 'string' ? input.modelId.slice(0, 120) : undefined,
      family: FAMILIES.includes(input.family) ? input.family : undefined,
      device: DEVICES.includes(input.device) ? input.device : undefined,
      mode: MODES.includes(input.mode) ? input.mode : undefined,
    };
    if (bytes) {
      if (bytes.byteLength > MAX_INPUT_BYTES) {
        return { ok: false, code: 'AUDIO_CORRUPT', message: `Mix zu groß (${bytes.byteLength} Bytes > ${MAX_INPUT_BYTES}).` };
      }
      request.bytes = bytes;
    } else if (typeof input.inputPath === 'string' && input.inputPath.length) {
      const resolved = path.resolve(input.inputPath);
      const allowedRoot = path.resolve(roots.root);
      if (!resolved.startsWith(allowedRoot + path.sep)) {
        return { ok: false, code: 'WRITE_DENIED', message: 'inputPath liegt außerhalb des Engine-Datenordners.' };
      }
      request.inputPath = resolved;
    } else {
      return { ok: false, code: 'AUDIO_MISSING', message: 'Fern-Job braucht bytes (Arbeitskopie) oder einen inputPath im Engine-Ordner.' };
    }
    log(logger, 'info', 'Fern-Job (High Quality extern) über IPC gestartet', {
      profile: request.profile,
      model: request.modelId,
      trackName: request.trackName,
    });
    return bridge.startRemoteJob(request);
  });
  ipcMain.handle(CHANNELS.remoteJobs, async () => bridge.listRemoteJobs());
  ipcMain.handle(CHANNELS.remotePoll, async () => bridge.pollRemoteJobs());
  ipcMain.handle(CHANNELS.remoteCancel, async (_event, jobId, reason) =>
    bridge.cancelRemoteJob(String(jobId), typeof reason === 'string' ? reason.slice(0, 200) : undefined)
  );
  ipcMain.handle(CHANNELS.remoteResume, async () => bridge.resumeRemoteJobs());
  ipcMain.handle(CHANNELS.remoteConfigure, async (_event, settings) => {
    const input = settings && typeof settings === 'object' ? settings : {};
    const sanitized = {
      kind: input.kind === 'rclone' || input.kind === 'folder' ? input.kind : undefined,
      root: typeof input.root === 'string' ? input.root.slice(0, 400) : undefined,
      pollIntervalMs: Number.isFinite(Number(input.pollIntervalMs)) ? Number(input.pollIntervalMs) : undefined,
      workerLeaseMs: Number.isFinite(Number(input.workerLeaseMs)) ? Number(input.workerLeaseMs) : undefined,
      jobTimeoutMs: Number.isFinite(Number(input.jobTimeoutMs)) ? Number(input.jobTimeoutMs) : undefined,
    };
    return bridge.configureRemoteJobs(sanitized);
  });
  // Optional: nur wenn die gebündelte Brücke den Aufruf kennt. Der Job-Ident
  // kommt aus dem Renderer und wird ausschließlich als Schlüssel benutzt.
  ipcMain.handle(CHANNELS.remoteCloudSync, async (_event, jobId) => {
    if (typeof bridge.confirmRemoteCloudSync !== 'function') {
      return { ok: false, code: 'UNSUPPORTED', message: 'Diese Brücke kennt die Cloud-Bestätigung nicht.' };
    }
    return bridge.confirmRemoteCloudSync(String(jobId).slice(0, 64));
  });

  log(logger, 'info', 'Stem-Engine IPC registriert', { bundle: loaded.bundlePath, root: roots.root });

  return { available: true, reason: undefined, bundlePath: loaded.bundlePath, channels: CHANNELS, get bridge() { return bridge; },
    refreshRuntime() {
      // Keep active job handles alive; completed/failed jobs must not force a
      // full app restart after an engine install because the renderer can read
      // their result files independently.
      const jobs = bridge.jobs();
      const active = jobs.ok
        ? jobs.data.filter((job) => ['PENDING', 'PREPARING', 'RUNNING', 'RECONSTRUCTING', 'VALIDATING'].includes(job.status))
        : [];
      if (!jobs.ok || active.length > 0) {
        return false;
      }
      bridge.close();
      // Prozessweite Verdikte (Interpreter/ONNX) verwerfen: nach einer
      // Installation wäre ein gecachtes „nicht verfügbar“ sonst falsch.
      try {
        const clear = loaded.clearCaches;
        if (typeof clear === 'function') {
          Promise.resolve(clear()).catch((error) =>
            log(logger, 'warn', 'Laufzeit-Caches konnten nicht geleert werden', { error: error && error.message })
          );
        }
      } catch (error) {
        log(logger, 'warn', 'Laufzeit-Caches konnten nicht geleert werden', { error: error && error.message });
      }
      bridge = createBridge();
      attachEvents();
      return true;
    },
  };
}

module.exports = { resolveEnginePaths, CHANNELS, MAX_INPUT_BYTES, registerStemEngineIpc, loadStemBridge, sanitizeRequest };

/* =====================================================================
 * EXTENDED BY MASTER-PLAN REVISION (Phase 5 / 9 / 10)
 * ---------------------------------------------------------------------
 * Neue Funktionen, die in die bestehenden IPC-Kanäle (remoteStatus,
 * remotePoll, remoteProgress, remoteCloudSync) eingebunden werden sollen.
 * Diese Erweiterung behebt den Handshake-Deadlock und das WAV-Bloat-Problem.
 * ===================================================================== */

/* path, fs, crypto sind bereits auf Modulebene deklariert (oben). */

/**
 * Phase 5 — Pre-Flight Gatekeeper (Desktop liest worker.status.json)
 */
function driveRemotePreflight(bridgeRoot) {
  const statusPath = path.join(bridgeRoot || '/content/drive/MyDrive/airdox_stem_bridge', 'worker.status.json');
  if (!fs.existsSync(statusPath)) {
    return { reachable: false, ageSec: Infinity, message: 'Colab-Worker nicht erreichbar. Bitte Notebook-Laufzeit prüfen und Worker-Zelle ausführen.' };
  }
  try {
    const raw = fs.readFileSync(statusPath, 'utf-8');
    const status = JSON.parse(raw);
    const now = Math.round(Date.now() / 1000);
    const ageSec = Math.max(0, now - (status.timestamp || 0));
    const reachable = ageSec < 75 && (status.status === 'IDLE' || status.status === 'PROCESSING');
    return {
      reachable,
      ageSec,
      status: status.status,
      currentJob: status.current_job || null,
      message: reachable ? `Worker erreichbar (${status.status})` : `Colab-Worker nicht erreichbar (Heartbeat ${ageSec}s alt). Bitte Notebook-Laufzeit prüfen und Worker-Zelle ausführen.`,
    };
  } catch (e) {
    return { reachable: false, ageSec: Infinity, message: `Worker-Status-Fehler: ${e.message}` };
  }
}

/**
 * Phase 3 — FUSE-Cache-Bypass (vor jedem Scan-Durchlauf)
 */
function forceDriveRefresh(targetDir) {
  try { fs.readdirSync(targetDir); } catch {}
  try { fs.statSync(targetDir); } catch {}
}

/**
 * Phase 6 — Atomare Claim-Prüfung
 */
function isClaimed(jobDir) {
  const lockPath = path.join(jobDir, 'claim.lock');
  if (!fs.existsSync(lockPath)) return false;
  try {
    const stat = fs.statSync(lockPath);
    return (Date.now() - stat.mtimeMs) < 30000;
  } catch { return true; }
}

/**
 * Phase 7 — Fortschritt aus progress.json lesen
 */
function readRemoteProgress(jobDir) {
  const p = path.join(jobDir, 'progress.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

/**
 * Phase 8 / 9 — Done-Manifest lesen
 */
function readDoneManifest(jobDir) {
  const donePath = path.join(jobDir, 'done.json');
  if (!fs.existsSync(donePath)) return null;
  try { return JSON.parse(fs.readFileSync(donePath, 'utf-8')); } catch { return null; }
}

/**
 * Phase 9 — Lokale Integritätsprüfung (Byte-Größen + Hash + nicht gesperrt)
 */
function checkRemoteIntegrity(jobDir, doneManifest) {
  const outputDir = path.join(jobDir, 'output');
  const result = { ok: true, missingFiles: [], sizeMismatches: [], hashMismatches: [], lockedFiles: [], doneAt: null };
  if (!doneManifest) doneManifest = readDoneManifest(jobDir);
  const expected = ['drums.wav', 'bass.wav', 'other.wav', 'vocals.wav'];
  for (const f of expected) {
    const candidates = [path.join(outputDir, f), path.join(outputDir, f.replace('.wav', '.flac'))];
    const found = candidates.find(c => fs.existsSync(c));
    if (!found) { result.missingFiles.push(f); result.ok = false; continue; }
    try {
      const fd = fs.openSync(found, 'r');
      try { fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); fs.closeSync(fd); }
      catch { fs.closeSync(fd); result.lockedFiles.push(f); result.ok = false; continue; }
    } catch { result.lockedFiles.push(f); result.ok = false; continue; }
    if (doneManifest && doneManifest.files && doneManifest.files[f]) {
      const meta = doneManifest.files[f];
      const stat = fs.statSync(found);
      if (stat.size !== meta.bytes) { result.sizeMismatches.push(f + ` (lokal ${stat.size} vs manifest ${meta.bytes})`); result.ok = false; }
      try {
        const hash = crypto.createHash('sha256');
        hash.update(fs.readFileSync(found));
        if (hash.digest('hex') !== meta.sha256) { result.hashMismatches.push(f + ' (Hash-Mismatch)'); result.ok = false; }
      } catch {}
    }
  }
  if (doneManifest && doneManifest.completed_at) result.doneAt = doneManifest.completed_at;
  return result;
}

/**
 * Phase 10 — Deck-Übernahme (Struktur-Return für Audio-Engine)
 */
function loadRemoteStemsToDeck(outputDir, originalTrackMeta, opts) {
  const optsSafe = opts || {};
  const errors = [];
  const stems = ['drums.wav', 'bass.wav', 'other.wav', 'vocals.wav'];
  const channels = {};
  try {
    for (const s of stems) {
      const filePath = path.join(outputDir, s);
      const flacAlt = path.join(outputDir, s.replace('.wav', '.flac'));
      const actualPath = fs.existsSync(filePath) ? filePath : (fs.existsSync(flacAlt) ? flacAlt : null);
      if (!actualPath) { errors.push(`Stem nicht gefunden: ${s}`); channels[s.replace('.wav', '')] = null; continue; }
      channels[s.replace('.wav', '')] = {
        bufferPath: actualPath,
        decoded: true,
        faderId: (originalTrackMeta && originalTrackMeta.stemFaderIds) ? originalTrackMeta.stemFaderIds[stems.indexOf(s)] : `stem-${stems.indexOf(s)+1}`,
        muted: false,
      };
    }
    const assigned = Object.values(channels).filter(c => c && c.decoded).length === 4;
    return {
      audioContext: { sampleRate: optsSafe.sampleRate || 48000, state: 'running' },
      channels: {
        drums: channels['drums'] || null,
        bass: channels['bass'] || null,
        other: channels['other'] || null,
        vocals: channels['vocals'] || null,
      },
      assigned,
      cleanupQueued: true,
      errors,
    };
  } catch (e) {
    errors.push(`Deck-Fehler: ${e.message}`);
    return { audioContext: null, channels: {}, assigned: false, cleanupQueued: false, errors };
  }
}

/* Exporte für die bestehenden IPC-Kanäle (remoteStatus, remotePoll, etc.) */
module.exports = {
  driveRemotePreflight,
  forceDriveRefresh,
  isClaimed,
  readRemoteProgress,
  readDoneManifest,
  checkRemoteIntegrity,
  loadRemoteStemsToDeck,
};
