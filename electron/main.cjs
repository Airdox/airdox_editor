const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const { access, readFile, stat, writeFile } = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  readRekordboxDatabase,
  locateRekordboxDatabases,
} = require('./dbReader.cjs');
const { OriginalSourceRegistry } = require('./pathGuard.cjs');
const { AnalysisPathRegistry } = require('./analysisRegistry.cjs');
const { resolveTrackFromMasterDb, scanAnlzSections } = require('./masterDbGate.cjs');
const { checkRekordboxRuntime } = require('./rekordboxRuntimeCheck.cjs');
const { inspectDemucsEnvironment, separateWav } = require('./demucsRunner.cjs');
const { inspectStemRuntime } = require('./stemRuntime.cjs');
const { mainLogger: logger, summarizeForLog } = require('./logger.cjs');
const { installStemEngine } = require('./stemInstaller.cjs');
const { registerStemEngineIpc } = require('./stemEngineBridge.cjs');

const APP_NAME = 'airdox_SMART_Editor';
const APP_PROTOCOL = 'airdox';
const IS_DEV = Boolean(process.env.ELECTRON_RENDERER_URL);
if (app.isPackaged && process.env.AIRDOX_PACKAGED_SMOKE_DIR) {
  app.setPath('userData', path.join(process.env.AIRDOX_PACKAGED_SMOKE_DIR, 'userData'));
}

// ---------------------------------------------------------------------------
// Logging-System so früh wie möglich aktivieren – noch vor dem ersten
// Fenster und vor allen IPC-Registrierungen, damit kein Ereignis verloren geht.
// ---------------------------------------------------------------------------
const bootLogDir = path.join(app.getPath('appData'), app.getName(), 'logs');
logger.configure({
  logDirectory: bootLogDir,
  processName: 'main',
  level: process.env.AIRDOX_LOG_LEVEL || (IS_DEV ? 'DEBUG' : 'INFO'),
  appInfo: { appName: APP_NAME, appVersion: app.getVersion() },
});
logger.installProcessHandlers();
logger.installConsoleCapture();
logger.info('SYSTEM', `${APP_NAME} ${app.getVersion()} Main-Prozess startet`, {
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.version,
  dev: IS_DEV,
});

// Sofortiger Nachweis des Master-DB-Pfades. Fehlt das native SQLCipher-Modul
// für genau diese Electron-Version, ist der Track-Import tot – dann soll das
// beim Start stehen und nicht erst beim Klick auf den ersten Track.
(function logRekordboxRuntimeAtBoot() {
  try {
    const result = checkRekordboxRuntime({ requireDatabase: false });
    const failures = result.checks.filter((check) => check.status === 'FAIL');
    if (failures.length > 0) {
      logger.error(
        'DATABASE',
        `Rekordbox-Master-DB nicht verfügbar: ${failures.map((c) => `${c.id} – ${c.detail}`).join(' | ')}`,
        { checks: result.checks.map((c) => `${c.id}=${c.status}`), electron: result.electronVersion, abi: result.modulesAbi }
      );
    } else {
      logger.info('DATABASE', 'Rekordbox-Runtime bereit (SQLCipher ladbar, master.db read-only geprüft)', {
        electron: result.electronVersion,
        abi: result.modulesAbi,
        module: result.module.path,
        database: result.database.path,
        checks: result.checks.map((c) => `${c.id}=${c.status}`),
      });
    }
  } catch (error) {
    logger.warn('DATABASE', `Rekordbox-Runtime-Check nicht ausführbar: ${error.message || error}`);
  }
})();

/**
 * Automatisches Audit-Protokoll für JEDEN ipcMain.handle-Kanal: Aufruf mit
 * kompakter Argument-Zusammenfassung, Dauer, Ergebnisgröße und Fehlern.
 * Große Binärdaten (Audio, ANLZ, WAV) werden nur als Byte-Länge erfasst.
 */
(function installIpcAudit() {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const SLOW_IPC_THRESHOLDS_MS = {
    // These handlers are intentionally long-lived: they represent a foreground
    // install or a running inference job, not a blocked UI bug.
    'stems:install-engine': 60 * 60 * 1000,
    'stems:job-wait': 60 * 60 * 1000,
    'stems:separate': 60 * 60 * 1000,
    // Native OS Dialoge warten auf Interaktion des Nutzers und dürfen keine
    // Performance-Warnung auslösen, wenn der Nutzer im Explorer navigiert:
    'rekordbox:choose-directory': 60 * 60 * 1000,
    'rekordbox:choose-analysis-file': 60 * 60 * 1000,
    'rekordbox:choose-rekordbox-database': 60 * 60 * 1000,
    'rekordbox:save-export-file': 60 * 60 * 1000,
    'rekordbox:open-project-file': 60 * 60 * 1000,
    'logs:open-log-folder': 60 * 60 * 1000,
    // Status/preflight sind reine Abfragen und inzwischen gecacht (Backend-Probes,
    // ONNX-Runtime, Statusantwort). Mehr als drei Sekunden heißt: etwas probt
    // erneut, was längst gemessen ist – das soll im Log auffallen.
    'stems:engine-status': 3 * 1000,
    'stems:get-status': 3 * 1000,
    'stems:diagnostics': 5 * 1000,
    'stems:preflight': 5 * 1000,
  };
  ipcMain.handle = function auditedHandle(channel, listener) {
    return originalHandle(channel, async (event, ...args) => {
      const startedAt = Date.now();
      logger.debug('IPC', `Aufruf ›${channel}‹`, {
        args: summarizeForLog(args),
        sender: event.senderFrame ? { url: event.senderFrame.url } : undefined,
      });
      try {
        const result = await listener(event, ...args);
        const durationMs = Date.now() - startedAt;
        logger.debug('IPC', `Antwort ›${channel}‹`, {
          durationMs,
          result: summarizeForLog(result),
        });
        const slowThresholdMs = SLOW_IPC_THRESHOLDS_MS[channel] ?? 2000;
        if (durationMs >= slowThresholdMs) {
          logger.warn('PERFORMANCE', `Langsamer IPC-Handler ›${channel}‹: ${durationMs} ms`);
        }
        return result;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        logger.error(
          'IPC',
          `IPC ›${channel}‹ nach ${durationMs} ms fehlgeschlagen: ${error.message}`,
          { name: error.name, stack: error.stack, code: error.code, args: summarizeForLog(args) }
        );
        throw error;
      }
    });
  };
})();

// WICHTIG: Das eigene Protokoll muss VOR app.whenReady() als privilegiert
// registriert werden, damit Chromium es als "standard" (http-ähnlich)
// behandelt. Das behebt die CORS-/crossorigin-Probleme, die beim direkten
// Laden aus file:// im Installer zum weissen Bildschirm führen.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
      allowServiceWorkers: false,
    },
  },
]);

let mainWindow;
let analysisPathRegistry;
// Authoritative main-process list; it cannot be weakened by renderer payloads.
const originalSourceRegistry = new OriginalSourceRegistry();

/**
 * The local index is deliberately outside the Rekordbox folders. It contains
 * only our read-only path associations and is never written back to Pioneer
 * files or databases.
 */
function getAnalysisPathRegistry() {
  if (!analysisPathRegistry) {
    analysisPathRegistry = new AnalysisPathRegistry(
      path.join(app.getPath('userData'), 'rekordbox-analysis-path-index.json')
    );
  }
  return analysisPathRegistry;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#0a0b0d',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Das Standard-Electron-Menü ("File Edit View Window") entfernen – die App
  // hat ihre eigene TitleBar/MenuBar-Komponente im React-Renderer.
  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Nur das eigene App-Protokoll und Dev-Tools erlauben.
    if (!url.startsWith(`${APP_PROTOCOL}://`) && !url.startsWith('devtools://')) {
      event.preventDefault();
    }
  });

  // Renderer-Abstürze und fehlgeschlagene Ladungen protokollieren.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.fatal('SYSTEM', `Renderer-Prozess abgestürzt (${details.reason})`, details);
  });
  mainWindow.webContents.on('unresponsive', () => {
    logger.warn('UI', 'Renderer reagiert nicht mehr (unresponsive).');
  });
  mainWindow.webContents.on('responsive', () => {
    logger.info('UI', 'Renderer reagiert wieder.');
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error('SYSTEM', `Laden fehlgeschlagen (${errorCode}) bei ${validatedURL}: ${errorDescription}`);
  });
  // Renderer-Konsolenmeldungen, die nicht über den Logger laufen, trotzdem
  // dauerhaft im Datei-Protokoll sichern (keine stillen Fehler mehr).
  mainWindow.webContents.on('console-message', function onConsoleMessage(event) {
    // Electron >= 30 übergibt ein WebContentsConsoleMessageEventParams-Objekt als erstes Argument (event).
    // Ältere Versionen übergaben positionale Argumente (event, level, message, line, source).
    // Durch Listener-Arität 1 (nur ein deklarierter Parameter) unterdrückt Electron 44+ die
    // 'console-message arguments are deprecated'-Warnung.
    const legacy = arguments;
    const params = event && typeof event === 'object' && ('message' in event || 'level' in event)
      ? event
      : { level: legacy[1], message: legacy[2], lineNumber: legacy[3], sourceId: legacy[4] };
    const level = params.level;
    const message = String(params.message ?? '');
    const line = params.lineNumber ?? params.line;
    const source = params.sourceId ?? params.sourceURL ?? params.url;
    // 0=verbose 1=info 2=warning 3=error (Electron numeric levels). Some
    // builds stringify levels; handle both forms for durable file logs.
    if (level === 3 || level === 'error') {
      logger.error('UI', `[renderer-console] ${message}`, { line, source });
    } else if (level === 2 || level === 'warning' || level === 'warn') {
      logger.warn('UI', `[renderer-console] ${message}`, { line, source });
    }
  });

  require('./packagedSmoke.cjs').attachPackagedSmoke(mainWindow, app);
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) {
    mainWindow.loadURL(developmentUrl);
    if (process.env.SHOW_DEVTOOLS === 'true') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    // Statt loadFile(file://) das eigene privilegierte Protokoll verwenden:
    // airdox://app/index.html → verweist auf dist/index.html im Installations-
    // ordner. Dadurch funktionieren <script type="module" crossorigin> und
    // alle relativen Asset-Pfade ohne CORS-/Origin-Probleme.
    mainWindow.loadURL(`${APP_PROTOCOL}://app/index.html`).catch((err) => {
      logger.fatal('SYSTEM', 'Konnte App-Startseite nicht laden:', err);
    });
    // F12 schaltet DevTools in der ausgelieferten App an/aus (Diagnose).
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        mainWindow.webContents.isDevToolsOpened()
          ? mainWindow.webContents.closeDevTools()
          : mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    });
  }
}

/**
 * Wandelt eine airdox://app/...-URL in einen Dateipfad innerhalb des
 * dist/-Ordners um und verhindert Directory-Traversal.
 */
function resolveAppUrl(url) {
  const distRoot = path.join(__dirname, '..', 'dist');
  const parsed = new URL(url);
  // Alles nach "airdox://app/" als Pfad innerhalb von dist/ behandeln.
  let relPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  if (!relPath) relPath = 'index.html';
  // Verhindern, dass "../" aus dist/ herausführt.
  const absPath = path.normalize(path.join(distRoot, relPath));
  if (!absPath.startsWith(path.normalize(distRoot) + path.sep) && absPath !== path.normalize(distRoot)) {
    return null;
  }
  return absPath;
}

function registerAppProtocol() {
  // Electron 25+ API: protocol.handle mit net.fetch aus Datei-URL.
  protocol.handle(APP_PROTOCOL, async (request) => {
    try {
      const filePath = resolveAppUrl(request.url);
      if (!filePath) {
        return new Response('Forbidden', { status: 403 });
      }
      // Existiert die Datei? Wenn nicht (z.B. Direct-Refresh auf Subroute),
      // auf index.html zurückfallen, damit SPA-Routing funktioniert.
      let target = filePath;
      try {
        const s = await stat(target);
        if (!s.isFile()) target = path.join(__dirname, '..', 'dist', 'index.html');
      } catch {
        target = path.join(__dirname, '..', 'dist', 'index.html');
      }
      return net.fetch(pathToFileURL(target).toString());
    } catch (err) {
      logger.error('SYSTEM', `App-Protocol Fehler bei ${request.url}: ${err.message}`, {
        stack: err.stack,
        url: request.url,
      });
      return new Response('Internal Error', { status: 500 });
    }
  });
}

function toLocalPath(location) {
  if (typeof location !== 'string' || !location.trim()) return null;

  try {
    if (/^[a-z]:[\\/]/i.test(location) || path.isAbsolute(location)) {
      return path.resolve(location);
    }

    if (/^[a-z][a-z\d+.-]*:/i.test(location)) {
      const url = new URL(location);
      return url.protocol === 'file:' ? require('node:url').fileURLToPath(url) : null;
    }

    return path.resolve(location);
  } catch {
    return null;
  }
}

// Probe executable, supported Python version, imports and cached model weights
// without touching audio. This catches Python 3.14 / missing-module installs up front.
// NEW: Primary is BS-RoFormer, Demucs is legacy fallback – per §26, Demucs must not block BS-RoFormer.
ipcMain.handle('stems:get-status', async () => {
  const bsResult = await inspectStemRuntime(
    path.join(__dirname, '..'),
    undefined,
    (level, category, message, details) => logger[level === 'warn' ? 'warn' : level](category, message, details)
  );
  // Keep Demucs check for legacy UI, but BS-RoFormer is primary
  const demucsResult = await inspectDemucsEnvironment(
    path.join(__dirname, '..'),
    undefined,
    undefined,
    (level, category, message, details) => logger[level === 'warn' ? 'warn' : level](category, message, details)
  );

  // If BS-RoFormer READY, report it as available
  if (bsResult.status === 'READY') {
    return {
      available: true,
      engine: 'BS_ROFORMER',
      model: bsResult.model,
      python: bsResult.diagnostics.pythonPath,
      details: bsResult.python?.details,
      diagnostics: bsResult.diagnostics,
      checks: bsResult.checks,
      demucs: demucsResult,
    };
  }

  // Otherwise, report BS-RoFormer UNAVAILABLE with clear reason – no spectral fallback
  return {
    available: false,
    engine: 'BS_ROFORMER',
    model: bsResult.model,
    python: bsResult.diagnostics.pythonPath,
    details: bsResult.python?.details,
    diagnostics: bsResult.diagnostics,
    checks: bsResult.checks,
    reason: bsResult.reason || 'BS-RoFormer Engine nicht verfügbar',
    code: 'STEM_ENGINE_UNAVAILABLE',
    demucs: demucsResult,
  };
});

// New diagnostics endpoint per §13
ipcMain.handle('stems:diagnostics', async () => {
  const result = await inspectStemRuntime(
    path.join(__dirname, '..'),
    undefined,
    (level, category, message, details) => logger[level === 'warn' ? 'warn' : level](category, message, details)
  );
  return result;
});

// New preflight endpoint per §14
ipcMain.handle('stems:preflight', async () => {
  const result = await inspectStemRuntime(
    path.join(__dirname, '..'),
    undefined,
    (level, category, message, details) => logger[level === 'warn' ? 'warn' : level](category, message, details)
  );
  return {
    status: result.status,
    engine: 'bsroformer',
    model: result.model,
    python: result.python,
    torch: result.torch,
    device: result.device,
    checkpointVerified: result.checkpointVerified,
    checks: result.checks,
    reason: result.reason,
    diagnostics: result.diagnostics,
  };
});

// One-click setup in persistent, writable user data. Installs exactly the
// model selected in the settings menu (options.modelId); without a modelId the
// primary BS-RoFormer model is installed (legacy one-click behavior).
let stemInstallRunning = false;
ipcMain.handle('stems:install-engine', async (event, options) => {
  if (stemInstallRunning) {
    return { ok: false, error: 'Die Installation läuft bereits.' };
  }
  stemInstallRunning = true;
  try {
    const modelId = options && typeof options.modelId === 'string' && options.modelId.length > 0 ? options.modelId : undefined;
    const result = await installStemEngine(path.join(__dirname, '..'), (progress) => {
      try {
        event.sender.send('stems:install-progress', progress);
      } catch { /* window may be closing */ }
    }, { stemsRoot: path.join(app.getPath('appData'), app.getName(), 'stems'), ...(modelId ? { modelId } : {}) });
    if (result.ok && stemEngineHost.refreshRuntime && !stemEngineHost.refreshRuntime()) {
      return { ...result, restartRequired: true };
    }
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    stemInstallRunning = false;
  }
});

// High-quality local AI separation. The renderer sends one finished WAV mix;
// Demucs returns newly inferred stems and never receives reference sources.
ipcMain.handle('stems:separate', async (_event, wavBytes) => {
  let lastProgressLine = '';
  const result = await separateWav(Buffer.from(wavBytes), {
    repoRoot: path.join(__dirname, '..'),
    model: process.env.DEMUCS_MODEL || 'htdemucs_ft',
    onProgress: (text) => {
      const line = text.trim();
      if (line && line !== lastProgressLine) {
        lastProgressLine = line;
        logger.debug('STEMS', `[demucs-fortschritt] ${line.slice(0, 300)}`);
      }
    },
    onLog: (level, category, message, details) =>
      logger[level] ? logger[level](category, message, details) : logger.info(category, message, details),
  });
  return {
    engine: 'demucs',
    model: result.model,
    stems: Object.fromEntries(
      Object.entries(result.stems).map(([name, bytes]) => [name, new Uint8Array(bytes)])
    ),
  };
});

// --- Neue Engine (src/stems) ──────────────────────────────────────────────
// Job-basierte Separation mit Profilwahl, Cache, Abbruch/Pause und
// Deskriptor-abhängiger Stem-Liste. Läuft im Main-Prozess, der Renderer
// bekommt Fortschritt über `stems:job-progress` und lädt Stems einzeln.
const stemEngineHost = registerStemEngineIpc({
  repoRoot: path.join(__dirname, '..'),
  // Dieselbe Lage wie der Log-Ordner: %APPDATA%/airdox_SMART_Editor/stems/…
  userDataDir: path.join(app.getPath('appData'), app.getName()),
  logger,
  ipcMain,
  broadcast: (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      } catch {
        /* Fenster schließt gerade */
      }
    }
  },
});
logger.info('SYSTEM', stemEngineHost.available ? 'Stem-Engine (Teil-1-Kern) aktiv' : 'Stem-Engine-Kern nicht verfügbar', {
  bundle: stemEngineHost.bundlePath,
  reason: stemEngineHost.reason,
});

// --- IPC-Handler bleiben unverändert ---

ipcMain.handle('rekordbox:inspect-location', async (_event, location) => {
  const localPath = toLocalPath(location);
  if (!localPath) {
    return { validLocation: false, exists: false, reason: 'Kein lokaler file://-Pfad.' };
  }
  try {
    await access(localPath, constants.R_OK);
    const details = await stat(localPath);
    if (details.isFile()) originalSourceRegistry.register(localPath);
    return {
      validLocation: true,
      exists: details.isFile(),
      path: localPath,
      size: details.isFile() ? details.size : null,
      modifiedAt: details.mtimeMs,
      accessMode: 'READ_ONLY',
    };
  } catch {
    return { validLocation: true, exists: false, path: localPath, accessMode: 'READ_ONLY' };
  }
});

ipcMain.handle('rekordbox:choose-analysis-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Rekordbox-Analysequelle auswählen',
    properties: ['openFile'],
    filters: [
      { name: 'Rekordbox Analysis', extensions: ['DAT', 'EXT', '2EX', 'dat', 'ext', '2ex'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return null;
  originalSourceRegistry.register(result.filePaths[0]);
  return { path: result.filePaths[0], accessMode: 'READ_ONLY' };
});

ipcMain.handle('rekordbox:choose-directory', async (_event, options) => {
  const dialogOptions = {
    title: options?.title || 'Ordner im Explorer auswählen',
    defaultPath: options?.defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('rekordbox:choose-rekordbox-database', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Rekordbox-Datenbank auswählen (nur lesend)',
    properties: ['openFile'],
    filters: [
      { name: 'Rekordbox Datenbank', extensions: ['db'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return null;
  originalSourceRegistry.register(result.filePaths[0]);
  return { path: result.filePaths[0], accessMode: 'READ_ONLY' };
});

ipcMain.handle('rekordbox:locate-rekordbox-databases', async () => {
  return locateRekordboxDatabases();
});

// Laufzeitnachweis des Master-DB-Pfades aus dem echten Electron-Prozess:
// Electron-Version, natives SQLCipher-Modul, Funktionsprobe und read-only
// geöffnete master.db. Rein lesend – die UI nutzt das, um einen fehlenden
// SQLCipher-Build als solchen zu benennen statt als "Track nicht gefunden".
ipcMain.handle('rekordbox:runtime-check', async (_event, options) => {
  const result = checkRekordboxRuntime({
    requireDatabase: options && options.requireDatabase === true,
    trackId: (options && options.trackId) || '',
  });
  logger.info('DATABASE', `[Rekordbox-Runtime] ${result.ok ? 'OK' : 'FEHLER'}`, {
    electron: result.electronVersion,
    modulesAbi: result.modulesAbi,
    modulePath: result.module.path,
    database: result.database.path,
    checks: result.checks.map((check) => `${check.id}=${check.status}`),
  });
  return result;
});

ipcMain.handle('rekordbox:read-library-db', async (_event, dbPath) => {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new Error('Kein gültiger Datenbankpfad übergeben.');
  }
  originalSourceRegistry.register(dbPath);
  return readRekordboxDatabase(dbPath);
});

// Verbindlicher Master-DB-Gate (Phase 5): TrackID → djmdContent →
// AnalysisDataPath → ANLZ → Original-Audio, ausschließlich lesend. Der Gate
// liefert hartes OK oder einen Fehlercode; es gibt keinen Analyse-Fallback.
ipcMain.handle('rekordbox:resolve-track-gate', async (_event, query) => {
  if (!query || typeof query !== 'object') {
    throw new Error('Kein Gate-Query übergeben.');
  }
  const result = await resolveTrackFromMasterDb(query);
  if (result.ok) {
    if (result.dbPath) originalSourceRegistry.register(result.dbPath);
    if (result.analysis?.path) originalSourceRegistry.register(result.analysis.path);
    if (result.original?.path) originalSourceRegistry.register(result.original.path);
    logger.info('DATABASE', `[Master-DB-Gate] OK für TrackID ${result.content?.id}`, {
      trackId: query.trackId,
      dbType: result.dbType,
      dbPath: result.dbPath,
      analysisPath: result.analysis?.path,
      anlzTags: result.analysis?.tags,
      originalPath: result.original?.path,
      cues: result.cues?.length ?? 0,
    });
  } else {
    logger.warn('DATABASE', `[Master-DB-Gate] ${result.code}: ${result.reason}`, {
      trackId: query.trackId,
      dbPath: result.dbPath,
      dbType: result.dbType,
    });
  }
  return result;
});

// Eingebettete rekordbox_export2.xml als App-Ressource (kein Benutzerdatei-
// dialog). Im Paket: resources/rekordbox/rekordbox_export2.xml (extraResources),
// im Entwicklungsmodus: Repo-Root. Die Datei wird nur lesend geöffnet und als
// Originalquelle registriert.
ipcMain.handle('rekordbox:read-bundled-xml', async () => {
  const target = app.isPackaged
    ? path.join(process.resourcesPath, 'rekordbox', 'rekordbox_export2.xml')
    : path.join(app.getAppPath(), 'rekordbox_export2.xml');
  try {
    await access(target, constants.R_OK);
    const details = await stat(target);
    if (!details.isFile()) throw new Error('Die gebündelte XML-Ressource ist keine Datei.');
    const data = await readFile(target, 'utf-8');
    const afterRead = await stat(target);
    if (
      Buffer.byteLength(data, 'utf8') !== details.size ||
      afterRead.size !== details.size ||
      afterRead.mtimeMs !== details.mtimeMs
    ) {
      throw new Error('Die eingebettete rekordbox.xml änderte Größe oder mtime während des Read-only-Lesevorgangs.');
    }
    originalSourceRegistry.register(target);
    return {
      available: true,
      data,
      path: target,
      size: details.size,
      modifiedAt: details.mtimeMs,
      accessMode: 'READ_ONLY',
    };
  } catch (error) {
    return {
      available: false,
      path: target,
      reason: error.message || String(error),
      accessMode: 'READ_ONLY',
    };
  }
});

// Persistent, app-owned association index. It intentionally stores neither
// decrypted master.db rows nor audio/waveform bytes: only read-only paths and
// compact track identifiers required to reopen an already known ANLZ file.
ipcMain.handle('rekordbox:cache-analysis-mappings', async (_event, mappings) => {
  if (!Array.isArray(mappings)) {
    throw new Error('Analyse-Zuordnungen müssen als Liste übergeben werden.');
  }
  return getAnalysisPathRegistry().registerMany(mappings);
});

ipcMain.handle('rekordbox:find-analysis-mapping', async (_event, query) => {
  if (!query || typeof query !== 'object') return null;
  return getAnalysisPathRegistry().find(query);
});

ipcMain.handle('rekordbox:analysis-mapping-stats', async () => {
  return getAnalysisPathRegistry().stats();
});

ipcMain.handle('rekordbox:read-analysis-file', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Kein gültiger Analysepfad übergeben.');
  }
  const allowedExtensions = new Set(['.dat', '.ext', '.2ex']);
  if (!allowedExtensions.has(path.extname(filePath).toLowerCase())) {
    throw new Error('Die ausgewählte Datei ist keine unterstützte Rekordbox-ANLZ-Datei.');
  }
  const localPath = path.resolve(filePath);
  await access(localPath, constants.R_OK);
  const details = await stat(localPath);
  if (!details.isFile()) throw new Error('Die ANLZ-Analysequelle verweist nicht auf eine Datei.');
  if (details.size > 1024 * 1024 * 1024) {
    throw new Error('Die ANLZ-Datei ist größer als 1 GB und wird nicht in den Arbeitsspeicher geladen.');
  }
  const data = await readFile(localPath);
  const afterRead = await stat(localPath);
  if (
    data.byteLength !== details.size ||
    afterRead.size !== details.size ||
    afterRead.mtimeMs !== details.mtimeMs
  ) {
    throw new Error('Die ANLZ-Quelldatei änderte Größe oder mtime während des Read-only-Lesevorgangs.');
  }
  originalSourceRegistry.register(localPath);

  // Wenn eine .DAT-Datei angefordert wird, lese im selben Ordner vorhandene
  // .EXT- und .2EX-Geschwisterdateien (PWV5/PWV7 Detail-Waveform, PCO2, PSSI)
  // mit identischer Read-only-Prüfung wie im Master-DB-Gate hinzu.
  let combinedData = data;
  let totalSize = details.size;
  let latestModifiedAt = details.mtimeMs;
  const primaryExt = path.extname(localPath);
  if (primaryExt.toLowerCase() === '.dat') {
    const isUpper = primaryExt === primaryExt.toUpperCase();
    const stem = localPath.slice(0, -primaryExt.length);
    const siblingExtensions = isUpper ? ['.EXT', '.2EX'] : ['.ext', '.2ex'];
    const buffers = [data];
    for (const sibExt of siblingExtensions) {
      const sibPath = `${stem}${sibExt}`;
      let sibBefore = null;
      try {
        sibBefore = await stat(sibPath);
      } catch {
        sibBefore = null;
      }
      if (!sibBefore || !sibBefore.isFile() || sibBefore.size <= 0 || sibBefore.size > 1024 * 1024 * 1024) {
        continue;
      }
      try {
        const sibData = await readFile(sibPath);
        const sibAfter = await stat(sibPath);
        if (
          sibData.byteLength !== sibBefore.size ||
          sibAfter.size !== sibBefore.size ||
          sibAfter.mtimeMs !== sibBefore.mtimeMs
        ) {
          continue;
        }
        const sibScan = scanAnlzSections(sibData);
        if (!sibScan.valid) continue;
        originalSourceRegistry.register(sibPath);
        buffers.push(sibData);
        totalSize += sibBefore.size;
        if (sibBefore.mtimeMs > latestModifiedAt) {
          latestModifiedAt = sibBefore.mtimeMs;
        }
      } catch {
        continue;
      }
    }
    if (buffers.length > 1) {
      combinedData = Buffer.concat(buffers);
    }
  }

  return {
    data: combinedData.buffer.slice(combinedData.byteOffset, combinedData.byteOffset + combinedData.byteLength),
    path: localPath,
    size: totalSize,
    modifiedAt: latestModifiedAt,
    accessMode: 'READ_ONLY',
  };
});

ipcMain.handle('rekordbox:save-export-file', async (_event, payload) => {
  const { data, defaultName, kind, protectedPaths } = payload || {};
  if (!data || typeof data.byteLength !== 'number' || data.byteLength === 0) {
    throw new Error('Keine Exportdaten übergeben.');
  }
  const kindFilters = {
    WAV: { name: 'WAV Audio', extensions: ['wav'] },
    AUDIO: { name: 'Audioaufnahme (WAV, FLAC, MP3)', extensions: ['wav', 'flac', 'mp3'] },
    XML: { name: 'Rekordbox XML', extensions: ['xml'] },
    JSON: { name: 'JSON', extensions: ['json'] },
    PROJECT: { name: 'airdox_SMART_Editor Projekt', extensions: ['airdox.json', 'json'] },
  }[kind] || { name: 'Datei', extensions: ['*'] };

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export speichern (nur neue Datei)',
    defaultPath: typeof defaultName === 'string' ? defaultName : 'export',
    filters: [kindFilters, { name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) {
    return { saved: false };
  }
  const targetPath = path.resolve(result.filePath);
  if (originalSourceRegistry.isProtected(targetPath, protectedPaths)) {
    throw new Error(
      'Der gewählte Zielpfad ist eine Original-Rekordbox-Quelle. Exporte dürfen Originaldateien niemals überschreiben (Non-destructive).'
    );
  }
  const buffer = Buffer.from(data);
  await writeFile(targetPath, buffer);
  return { saved: true, path: targetPath, bytes: buffer.length, accessMode: 'WRITE_NEW_ONLY' };
});

ipcMain.handle('rekordbox:open-project-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Projekt öffnen (nur lesend)',
    properties: ['openFile'],
    filters: [
      { name: 'airdox_SMART_Editor Projekt', extensions: ['airdox.json', 'json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return null;
  const localPath = path.resolve(result.filePaths[0]);
  await access(localPath, constants.R_OK);
  const details = await stat(localPath);
  if (!details.isFile()) throw new Error('Die Projektdatei ist keine Datei.');
  if (details.size > 64 * 1024 * 1024) {
    throw new Error('Die Projektdatei ist größer als 64 MB und wird nicht geladen.');
  }
  const data = await readFile(localPath, 'utf-8');
  return { data, path: localPath, size: details.size, modifiedAt: details.mtimeMs, accessMode: 'READ_ONLY' };
});

ipcMain.handle('rekordbox:read-original-audio', async (_event, location) => {
  const localPath = toLocalPath(location);
  if (!localPath) throw new Error('Die XML-Location ist kein lokaler Dateipfad.');
  const allowedExtensions = new Set(['.wav', '.mp3', '.flac', '.aiff', '.aif', '.m4a', '.aac', '.ogg']);
  if (!allowedExtensions.has(path.extname(localPath).toLowerCase())) {
    throw new Error('Die referenzierte Originaldatei ist keine unterstützte Audiodatei.');
  }
  await access(localPath, constants.R_OK);
  const details = await stat(localPath);
  if (!details.isFile()) throw new Error('Die XML-Location verweist nicht auf eine Datei.');
  if (details.size > 1024 * 1024 * 1024) {
    throw new Error('Die Originaldatei ist größer als 1 GB und wird nicht in den Arbeitsspeicher geladen.');
  }
  const data = await readFile(localPath);
  const afterRead = await stat(localPath);
  if (
    data.byteLength !== details.size ||
    afterRead.size !== details.size ||
    afterRead.mtimeMs !== details.mtimeMs
  ) {
    throw new Error('Die Original-Audiodatei änderte Größe oder mtime während des Read-only-Lesevorgangs.');
  }
  originalSourceRegistry.register(localPath);
  return {
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    path: localPath,
    size: details.size,
    modifiedAt: details.mtimeMs,
    accessMode: 'READ_ONLY',
  };
});

// --- Diagnose & Logging ------------------------------------------------------

// Gebündelter Log-Strom aus dem Renderer (gleiche Tagesdatei wie der Main-Prozess).
ipcMain.on('logs:write', (event, entries) => {
  try {
    if (!Array.isArray(entries)) return;
    logger.ingestRendererEntries(entries);
  } catch (error) {
    logger.error('LOG', `Renderer-Logs konnten nicht geschrieben werden: ${error.message}`, {
      stack: error.stack,
    });
  }
});

ipcMain.handle('logs:get-info', async () => {
  return {
    ...logger.getInfo(),
    userData: app.getPath('userData'),
    isPackaged: app.isPackaged,
  };
});

ipcMain.handle('logs:read-tail', async (_event, maxBytes) => {
  const cap = Math.min(Number(maxBytes) || 256 * 1024, 2 * 1024 * 1024);
  return logger.readRecent(cap);
});

ipcMain.handle('logs:open-log-folder', async () => {
  const info = logger.readRecent(1);
  const target = info.file || logger.getLogDirectory();
  logger.info('LOG', 'Log-Ordner wird im System-Dateimanager geöffnet.', { target });
  shell.showItemInFolder(target);
  return { opened: true, target, logDirectory: logger.getLogDirectory() };
});

app.whenReady().then(() => {
  // Offizielles userData-Logverzeichnis übernehmen, falls es beim Boot noch
  // nicht zur Verfügung stand (Normalfall: beide Pfade sind identisch).
  const officialDir = path.join(app.getPath('userData'), 'logs');
  if (logger.getLogDirectory() !== officialDir) {
    logger.info('SYSTEM', `Log-Verzeichnis gewechselt: ${logger.getLogDirectory()} → ${officialDir}`);
    logger.configure({ logDirectory: officialDir });
  }

  logger.info('SYSTEM', `Electron app ready – packaged=${app.isPackaged}`, {
    userData: app.getPath('userData'),
    argv: process.argv,
  });

  registerAppProtocol();
  createWindow();

  app.on('activate', () => {
    logger.info('SYSTEM', 'App-Aktivierung (activate) – Fenster werden geprüft.');
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('child-process-gone', (_event, details) => {
  logger.error('SYSTEM', `Kindprozess abgestürzt: ${details.type} (${details.reason})`, details);
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_e, details) => {
    logger.fatal('SYSTEM', `WebContents Renderer abgestürzt (${details.reason})`, details);
  });
});

app.on('before-quit', () => {
  logger.info('SYSTEM', 'Anwendung wird beendet (before-quit) – Log-Puffer wird synchron geschrieben.');
  logger.flushSync();
});

app.on('window-all-closed', () => {
  logger.info('SYSTEM', 'Alle Fenster geschlossen (window-all-closed).');
  if (process.platform !== 'darwin') app.quit();
});

// Only open the packaged, fixed resource directory; no renderer-controlled path.
ipcMain.handle('stems:open-colab-package', async () => {
  const folder = app.isPackaged ? path.join(process.resourcesPath, 'colab') : path.join(__dirname, '..', 'resources', 'colab');
  try {
    await access(path.join(folder, 'airdox-colab-worker.zip'));
    const error = await shell.openPath(folder);
    return error ? { ok: false, message: error } : { ok: true };
  } catch (error) {
    return { ok: false, message: `Colab-Paket fehlt. Bitte die vollständige Windows-Version verwenden. ${error.message}` };
  }
});

const colabResourceFolder = () => app.isPackaged ? path.join(process.resourcesPath, 'colab') : path.join(__dirname, '..', 'resources', 'colab');
ipcMain.handle('stems:colab-evidence', async () => {
  try { return await require('./colabPackage.cjs').verifyColabPackage(colabResourceFolder()); }
  catch (error) { return { ok: false, message: `Nachweisprüfung fehlgeschlagen: ${error.message}` }; }
});
ipcMain.handle('stems:save-colab-notebook', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Geprüftes Colab-Notebook als neue Datei speichern',
      defaultPath: `airdox-colab-${app.getVersion()}.ipynb`,
      filters: [{ name: 'Colab Notebook', extensions: ['ipynb'] }],
    });
    if (result.canceled || !result.filePath) return { ok: true, saved: false };
    await require('./colabPackage.cjs').saveNotebook(colabResourceFolder(), path.resolve(result.filePath), p => originalSourceRegistry.isProtected(p));
    try {
      await shell.openExternal('https://colab.research.google.com/');
      return { ok: true, saved: true, path: result.filePath, message: 'Notebook gespeichert. In Colab „Hochladen“ wählen. Google-Anmeldung und Freigabe erfolgen ausschließlich bei Google.' };
    } catch {
      return { ok: true, saved: true, path: result.filePath, message: 'Notebook gespeichert. Browser konnte nicht geöffnet werden; https://colab.research.google.com/ bitte selbst im Browser öffnen.' };
    }
  } catch (error) {
    return { ok: false, message: `Notebook nicht gespeichert: ${error.message}. Vorhandene Dateien werden nicht überschrieben.` };
  }
});
