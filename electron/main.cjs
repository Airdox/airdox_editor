const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const { access, readFile, stat, writeFile } = require('node:fs/promises');
const fs = require('node:fs');
const { constants } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  readRekordboxDatabase,
  locateRekordboxDatabases,
} = require('./dbReader.cjs');
const { isProtectedTarget, toLocalPath } = require('./pathGuard.cjs');
const { MODEL_EXTENSIONS, createStemModelStore, isModelFileName, safeModelFileName } = require('./stemModelStore.cjs');
const { createLogWriter, formatLogLine } = require('./logWriter.cjs');

const APP_NAME = 'airdox_SMART_Editor';
const APP_PROTOCOL = 'airdox';

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
let logWriter = null;

function getLogWriter() {
  if (logWriter) return logWriter;
  try {
    const logPath = path.join(app.getPath('userData'), 'airdox-smart-editor.log');
    logWriter = createLogWriter(logPath);
  } catch {
    logWriter = null;
  }
  return logWriter;
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
    console.error('[Electron] Renderer-Prozess abgestürzt:', details);
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Electron] Laden fehlgeschlagen (${errorCode}) bei ${validatedURL}: ${errorDescription}`);
  });

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
      console.error('[Electron] Konnte App-Startseite nicht laden:', err);
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
      console.error('[App-Protocol] Fehler bei', request.url, err);
      return new Response('Internal Error', { status: 500 });
    }
  });
}

// --- IPC-Handler bleiben unverändert ---

// Durable log mirror: every renderer log entry is appended to
// <userData>/airdox-smart-editor.log (rotated at 5 MB by logWriter.cjs).
// Writes never throw — logging must not break the app it observes.
const desktopLogWriter = createLogWriter(
  path.join(app.getPath('userData'), 'airdox-smart-editor.log')
);

ipcMain.handle('rekordbox:append-log', (_event, entry) => {
  return desktopLogWriter.append(formatLogLine(entry));
});

ipcMain.handle('rekordbox:get-log-file-path', () => desktopLogWriter.filePath);

ipcMain.handle('rekordbox:inspect-location', async (_event, location) => {
  const localPath = toLocalPath(location);
  if (!localPath) {
    return { validLocation: false, exists: false, reason: 'Kein lokaler file://-Pfad.' };
  }
  try {
    await access(localPath, constants.R_OK);
    const details = await stat(localPath);
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
  return result.canceled ? null : { path: result.filePaths[0], accessMode: 'READ_ONLY' };
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
  return result.canceled ? null : { path: result.filePaths[0], accessMode: 'READ_ONLY' };
});

ipcMain.handle('rekordbox:locate-rekordbox-databases', async () => {
  return locateRekordboxDatabases();
});

ipcMain.handle('rekordbox:read-library-db', async (_event, dbPath) => {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new Error('Kein gültiger Datenbankpfad übergeben.');
  }
  return readRekordboxDatabase(dbPath);
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
  return {
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    path: localPath,
    size: details.size,
    modifiedAt: details.mtimeMs,
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
  if (isProtectedTarget(targetPath, protectedPaths)) {
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
  return {
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    path: localPath,
    size: details.size,
    modifiedAt: details.mtimeMs,
    accessMode: 'READ_ONLY',
  };
});

// --- AUDIO STEM SEPARATION (externe Python-CLI: Status, Progress, Cancel) ---
//
// Wichtige Regeln hier:
//  1. `execFile` mit Argument-Array statt Shell-String: Dateinamen mit
//     Leerzeichen/Umlauten/Anführungszeichen können den Aufruf nicht mehr
//     zerlegen und es gibt keine Command-Injection über Tracknamen.
//  2. Pro Quelldatei ein eigener Ausgabeordner und ein Vorher/Nachher-Diff:
//     es werden nur die Stems dieses Laufs zurückgegeben, keine Leichen.
//  3. Fehler werden klassifiziert (SEPARATOR_NOT_INSTALLED, …) und als
//     verständliche deutsche Meldung inkl. nächstem Schritt geworfen, damit der
//     Renderer sauber auf die interne Heuristik-Separation zurückfallen kann.
const { execFile } = require('node:child_process');
const os = require('node:os');
const {
  ERROR_CODES: STEM_ERROR_CODES,
  INSTALL_HINT: STEM_INSTALL_HINT,
  buildListModelsArgs,
  buildSeparatorArgs,
  normalizeModelRequest,
  classifySeparatorFailure,
  collectStemOutputs,
  parseRuntimeModelList,
  parseSeparatorProgress,
  requiresShell,
  separatorCandidates,
  toShellArgs,
  trackOutputRoot,
} = require('./stemRunner.cjs');

const SEPARATOR_LOOKUP_TIMEOUT_MS = 8000;
const SEPARATOR_RUN_TIMEOUT_MS = 45 * 60 * 1000;
const SEPARATOR_MAX_BUFFER = 32 * 1024 * 1024;
const SEPARATOR_LOG_TAIL_CHARS = 4000;
const MODEL_LIST_TIMEOUT_MS = 90 * 1000;
// normalizeModelRequest validiert den Renderer-Payload (HTTPS-Pflicht, Dateiname).
const MODEL_EXTENSION_LIST = MODEL_EXTENSIONS.join(', ');

let cachedSeparatorStatus = null;
const activeSeparations = new Map();
const cancelledSeparations = new Set();

function stemRoots() {
  const userData = app.getPath('userData');
  return { output: path.join(userData, 'separated_stems'), models: path.join(userData, 'audio-separator-models') };
}

/** execFile als Promise (für kurze Hilfsaufrufe wie die Modell-Liste). */
function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: SEPARATOR_MAX_BUFFER, ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

let stemModelStore = null;
function getStemModelStore() {
  if (!stemModelStore) stemModelStore = createStemModelStore({ rootDir: stemRoots().models });
  return stemModelStore;
}

function stemLog(level, message, data) {
  try {
    const writer = getLogWriter();
    if (writer) writer.append(formatLogLine({ level, category: 'STEMS', message, data }));
  } catch {
    // Logging darf die Separation niemals abbrechen.
  }
}

function sendStemProgress(event, payload) {
  try {
    if (event && event.sender && !event.sender.isDestroyed()) {
      event.sender.send('audio:separate-stems:progress', payload);
    }
  } catch {
    // Ein geschlossener Renderer ist kein Fehler der Separation.
  }
}

function withStemCode(error, code) {
  if (error instanceof Error && code) error.code = code;
  return error;
}

function runLookup(command, args) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: SEPARATOR_LOOKUP_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (error) resolve(null);
        else resolve(parseLookupOutput(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

/** pip legt die CLI neben (oder in Scripts/ von) der Python-Installation ab. */
async function pythonScriptDirs() {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const names = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  const dirs = new Set();
  for (const name of names) {
    const found = await runLookup(lookupCommand, [name]);
    if (!found) continue;
    const binDir = path.dirname(found);
    dirs.add(binDir);
    dirs.add(path.join(binDir, 'Scripts'));
    dirs.add(path.resolve(binDir, '..', 'Scripts'));
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    const roaming = path.join(process.env.APPDATA, 'Python');
    try {
      for (const entry of fs.readdirSync(roaming)) dirs.add(path.join(roaming, entry, 'Scripts'));
    } catch {
      // kein User-Site-Python vorhanden
    }
  } else {
    dirs.add(path.join(os.homedir(), '.local', 'bin'));
  }
  return [...dirs];
}

/**
 * Prüft einmal (und auf Wunsch erneut), ob der externe Separator verfügbar ist.
 * Das Ergebnis entscheidet, ob der Renderer die trainierte CLI oder die
 * eingebaute Heuristik benutzt.
 */
async function resolveSeparatorStatus(options = {}) {
  if (cachedSeparatorStatus && !options.force) return cachedSeparatorStatus;
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const candidates = separatorCandidates({
    env: process.env,
    platform: process.platform,
    scriptDirs: await pythonScriptDirs(),
  });
  for (const candidate of candidates) {
    let command = candidate.command;
    if (candidate.source === 'path') {
      const found = await runLookup(lookupCommand, [command]);
      if (!found) continue;
      command = found;
    } else if (!fs.existsSync(command)) {
      continue;
    }
    cachedSeparatorStatus = { available: true, command, source: candidate.source, reason: '', hint: '' };
    stemLog('INFO', `Externer Separator gefunden: ${command} (${candidate.source})`);
    return cachedSeparatorStatus;
  }
  cachedSeparatorStatus = {
    available: false,
    command: null,
    source: null,
    reason: 'Der externe Separator "audio-separator" wurde weder im PATH noch in den Python-Script-Ordnern gefunden.',
    hint: STEM_INSTALL_HINT,
  };
  stemLog('WARN', cachedSeparatorStatus.reason);
  return cachedSeparatorStatus;
}

function listDirectoryEntries(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        try {
          const info = fs.statSync(path.join(dir, entry.name));
          return { name: entry.name, mtimeMs: info.mtimeMs, size: info.size };
        } catch {
          return { name: entry.name, mtimeMs: 0, size: 0 };
        }
      });
  } catch {
    return [];
  }
}

// --- STEM-MODELL-GEWICHTE (Model-Store, Katalog, Download, Import) ---
//
// Die Gewichte trainierter Modelle (.ckpt/.onnx/.pth) liegen im Modell-Ordner
// der Desktop-App. Der Renderer liefert den Modell-Eintrag (aus
// src/stems/modelCatalog.ts) als Payload; der Main-Prozess validiert ihn streng:
//  - Dateiname ohne Pfadtrenner und mit erlaubten Zeichen,
//  - Direkt-Downloads nur über HTTPS (Ausnahme: explizite Dev-Variable),
//  - Prüfsumme nur im 64-Hex-Format.
// Damit kann ein manipuliertes Renderer-Payload weder beliebige Dateien
// schreiben noch unsichere Quellen laden.
function sendModelProgress(event, payload) {
  try {
    if (event && event.sender && !event.sender.isDestroyed()) {
      event.sender.send('stems:models:progress', payload);
    }
  } catch {
    // Renderer kann bereits geschlossen sein – kein Fehler des Downloads.
  }
}

/** Modell-Liste der installierten CLI (inkl. der Stem-Namen pro Modell). */
async function fetchRuntimeModelCatalog(options = {}) {
  if (cachedRuntimeCatalog && !options.force) return cachedRuntimeCatalog;
  const status = await resolveSeparatorStatus({ force: Boolean(options.force) });
  if (!status.available) {
    return { available: false, reason: status.reason, hint: status.hint, models: [], fetchedAt: Date.now() };
  }
  try {
    const { stdout } = await execFilePromise(status.command, buildListModelsArgs({ modelFileDir: stemRoots().models }), {
      timeout: MODEL_LIST_TIMEOUT_MS,
      shell: requiresShell(status.command),
    });
    const models = parseRuntimeModelList(stdout);
    cachedRuntimeCatalog = { available: true, command: status.command, models, fetchedAt: Date.now() };
    stemLog('INFO', `Modellliste der Separator-CLI gelesen: ${models.length} Einträge`, { command: status.command });
    return cachedRuntimeCatalog;
  } catch (error) {
    return { available: false, reason: `Modellliste konnte nicht gelesen werden: ${error.message}`, models: [], fetchedAt: Date.now() };
  }
}

ipcMain.handle('stems:models:list', async (_event, catalog) => {
  const entries = Array.isArray(catalog) ? catalog.filter((entry) => entry && typeof entry === 'object') : [];
  return getStemModelStore().status(entries);
});

ipcMain.handle('stems:models:runtime-catalog', async (_event, options) => {
  try {
    return await fetchRuntimeModelCatalog({ force: Boolean(options && options.force) });
  } catch (error) {
    return { available: false, reason: error.message, models: [], fetchedAt: Date.now() };
  }
});

ipcMain.handle('stems:models:download', async (event, payload) => {
  const model = normalizeModelRequest(payload);
  if (!model) throw new Error('Für den Modell-Download werden Dateiname und HTTPS-URL benötigt.');
  if (!isModelFileName(model.fileName)) {
    throw Object.assign(new Error(`Nur Gewichte mit Endung (${MODEL_EXTENSION_LIST}) können direkt geladen werden. CLI-Modelle ohne Dateiendung lädt die Separator-CLI beim ersten Lauf selbst.`), {
      code: STEM_ERROR_CODES.MODEL_UNSUPPORTED,
    });
  }
  if (!model.downloadUrl) {
    throw Object.assign(new Error(`Für "${model.fileName}" ist keine Direkt-URL hinterlegt. Die Separator-CLI lädt diese Gewichte beim ersten Trennvorgang automatisch in den Modell-Ordner.`), {
      code: STEM_ERROR_CODES.MODEL_NO_URL,
    });
  }
  const store = getStemModelStore();
  const controller = new AbortController();
  activeModelDownloads.set(model.fileName, controller);
  stemLog('INFO', `Modell-Download gestartet: ${model.fileName}`, { url: model.downloadUrl, sha256: model.sha256 });
  try {
    const result = await store.download({
      fileName: model.fileName,
      url: model.downloadUrl,
      sha256: model.sha256,
      expectedSizeBytes: model.expectedSizeBytes,
      signal: controller.signal,
      onProgress: (progress) => sendModelProgress(event, progress),
    });
    stemLog('INFO', `Modell-Gewichte installiert: ${result.fileName}`, { sizeBytes: result.sizeBytes, sha256: result.sha256 });
    return { ok: true, ...result };
  } catch (error) {
    stemLog('ERROR', `Modell-Download fehlgeschlagen: ${error.message}`, { fileName: model.fileName, code: error.code });
    sendModelProgress(event, { fileName: model.fileName, phase: 'failed', ratio: null, message: error.message, code: error.code });
    throw error;
  } finally {
    activeModelDownloads.delete(model.fileName);
  }
});

ipcMain.handle('stems:models:cancel', async (_event, fileName) => {
  const store = getStemModelStore();
  const name = typeof fileName === 'string' && fileName.trim() ? safeModelFileName(fileName) : null;
  if (name) {
    activeModelDownloads.get(name)?.abort();
    return { cancelled: store.cancelDownload(name) ? 1 : 0 };
  }
  for (const controller of activeModelDownloads.values()) controller.abort();
  return { cancelled: store.cancelDownload() ? activeModelDownloads.size : 0 };
});

ipcMain.handle('stems:models:remove', async (_event, fileName) => {
  if (typeof fileName !== 'string' || !fileName.trim()) throw new Error('Es wurde kein Modell zum Entfernen angegeben.');
  const store = getStemModelStore();
  const name = safeModelFileName(fileName);
  if (isProtectedTarget(store.modelPath(name))) throw new Error('Geschützte Originaldateien dürfen nicht entfernt werden.');
  stemLog('WARN', `Modell-Gewichte entfernt: ${name}`);
  return store.remove(name);
});

ipcMain.handle('stems:models:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Modell-Gewichte importieren (nur lesend kopiert)',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Modell-Gewichte', extensions: ['ckpt', 'onnx', 'pth', 'th', 'pt', 'bin'] },
      { name: 'Alle Dateien', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { imported: [] };
  const store = getStemModelStore();
  const imported = [];
  const failures = [];
  for (const filePath of result.filePaths) {
    try {
      imported.push(await store.importFile(filePath));
    } catch (error) {
      failures.push({ filePath, message: error.message });
    }
  }
  stemLog('INFO', `Modelle importiert: ${imported.length}`, { imported: imported.map((entry) => entry.fileName), failures });
  return { imported, failures };
});

ipcMain.handle('stems:models:open-folder', async () => {
  const store = getStemModelStore();
  await store.ensureRoot();
  const errorMessage = await shell.openPath(store.rootDir);
  if (errorMessage) throw new Error(errorMessage);
  return { path: store.rootDir };
});

ipcMain.handle('audio:separator-status', async (_event, options) => {
  try {
    return await resolveSeparatorStatus({ force: Boolean(options && options.force) });
  } catch (error) {
    return { available: false, command: null, reason: error.message, hint: STEM_INSTALL_HINT };
  }
});

ipcMain.handle('audio:separate-stems', async (event, inputFilePath, options = {}) => {
  const requested = typeof inputFilePath === 'string' ? inputFilePath.trim() : '';
  const localPath = toLocalPath(requested) || (path.isAbsolute(requested) ? path.resolve(requested) : null);
  if (!localPath) {
    throw withStemCode(new Error('Für die Stem-Separation wird ein echter lokaler Dateipfad benötigt.'), STEM_ERROR_CODES.FAILED);
  }
  try {
    await access(localPath, constants.R_OK);
  } catch {
    throw withStemCode(new Error(`Audiodatei ist nicht lesbar: ${localPath}`), STEM_ERROR_CODES.INPUT_MISSING);
  }
  const details = await stat(localPath);
  if (!details.isFile()) {
    throw withStemCode(new Error('Der Pfad für die Stem-Separation verweist nicht auf eine Datei.'), STEM_ERROR_CODES.INPUT_MISSING);
  }

  const status = await resolveSeparatorStatus();
  if (!status.available) {
    const failure = classifySeparatorFailure({ error: { code: 'ENOENT', message: status.reason } });
    stemLog('WARN', `${failure.message} ${failure.hint}`.trim(), { inputPath: localPath });
    throw withStemCode(new Error(`${failure.message} ${failure.hint}`.trim()), failure.code);
  }

  const roots = stemRoots();
  const outputDir = trackOutputRoot(roots.output, localPath);
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.mkdir(roots.models, { recursive: true });
  const filesBefore = listDirectoryEntries(outputDir);

  // Gewählte Modell-Gewichte: lokal verfügbar? Sonst lädt die CLI sie selbst
  // in denselben Modell-Ordner (delegateToRuntime). Ohne beides => harter,
  // klassifizierter Fehler statt stiller Ausweich-Inferenz.
  let modelFilename = typeof options.modelFilename === 'string' && options.modelFilename.trim() ? options.modelFilename.trim() : null;
  const modelNotes = [];
  if (options.model) {
    const model = normalizeModelRequest(options.model);
    if (!model) throw withStemCode(new Error('Die Modell-Auswahl ist ungültig (Dateiname fehlt).'), STEM_ERROR_CODES.MODEL_MISSING);
    const store = getStemModelStore();
    const ensured = await store.ensureModel(
      { fileName: model.fileName, downloadUrl: model.downloadUrl, sha256: model.sha256, expectedSizeBytes: model.expectedSizeBytes },
      {
        onProgress: (progress) =>
          sendStemProgress(event, { jobId: 'model', phase: 'running', ratio: progress.ratio, message: progress.message }),
      }
    );
    if (!ensured.available && !ensured.delegateToRuntime) {
      throw withStemCode(new Error(ensured.reason || `Modell-Gewichte nicht verfügbar: ${model.fileName}`), STEM_ERROR_CODES.MODEL_MISSING);
    }
    modelFilename = model.fileName;
    modelNotes.push(ensured.available ? `Gewichte lokal vorhanden: ${ensured.filePath}` : ensured.reason);
    stemLog('INFO', `Modell für Separation: ${model.fileName}`, { ensured: ensured.available, delegated: ensured.delegateToRuntime });
  }

  const args = buildSeparatorArgs({
    inputPath: localPath,
    outputDir,
    modelFilename,
    modelFileDir: roots.models,
    outputFormat: 'WAV',
    chunkDuration: options.chunkDuration,
    extraArgs: Array.isArray(options.extraArgs) ? options.extraArgs : [],
  });

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const useShell = requiresShell(status.command);
  stemLog('INFO', `Stem-Separation startet`, { jobId, command: status.command, args, outputDir, modelNotes });
  sendStemProgress(event, { jobId, phase: 'start', ratio: 0, message: `Separator gestartet: ${path.basename(localPath)}`, outputDir });

  const child = execFile(status.command, useShell ? toShellArgs(args) : args, {
    cwd: outputDir,
    timeout: SEPARATOR_RUN_TIMEOUT_MS,
    maxBuffer: SEPARATOR_MAX_BUFFER,
    windowsHide: true,
    shell: useShell,
    env: process.env,
  });
  activeSeparations.set(jobId, child);

  let stdoutTail = '';
  let stderrTail = '';
  const rememberTail = (target, chunk) => {
    const next = target + chunk;
    return next.length > SEPARATOR_LOG_TAIL_CHARS ? next.slice(next.length - SEPARATOR_LOG_TAIL_CHARS) : next;
  };
  const handleChunk = (chunk, isError) => {
    const text = chunk.toString();
    if (isError) stderrTail = rememberTail(stderrTail, text);
    else stdoutTail = rememberTail(stdoutTail, text);
    for (const line of text.split(/\r?\n/)) {
      const progress = parseSeparatorProgress(line);
      if (progress) {
        sendStemProgress(event, { jobId, phase: 'running', ratio: progress.ratio, message: progress.message });
      } else if (isError && line.trim()) {
        stemLog('DEBUG', line.trim(), { jobId });
      }
    }
  };
  if (child.stdout) child.stdout.on('data', (chunk) => handleChunk(chunk, false));
  if (child.stderr) child.stderr.on('data', (chunk) => handleChunk(chunk, true));

  return new Promise((resolve, reject) => {
    const fail = (failure) => {
      activeSeparations.delete(jobId);
      stemLog('ERROR', `${failure.code}: ${failure.message}`, { jobId, hint: failure.hint, stderr: stderrTail.slice(-800) });
      sendStemProgress(event, { jobId, phase: 'failed', ratio: null, message: failure.message, code: failure.code });
      reject(withStemCode(new Error([failure.message, failure.hint].filter(Boolean).join(' ')), failure.code));
    };

    child.once('error', (error) => {
      fail(classifySeparatorFailure({ error, stderr: stderrTail, stdout: stdoutTail, inputPath: localPath }));
    });

    child.once('close', async (code, signal) => {
      const elapsed = Date.now() - startedAt;
      const cancelled = cancelledSeparations.has(jobId);
      const timedOut = !cancelled && child.killed === true && elapsed >= SEPARATOR_RUN_TIMEOUT_MS - 5000;
      cancelledSeparations.delete(jobId);

      if (cancelled || timedOut || code !== 0) {
        fail(
          classifySeparatorFailure({
            error: { message: `Separator beendet mit Code ${code}${signal ? ` (Signal ${signal})` : ''}`, signal, killed: child.killed },
            stderr: stderrTail,
            stdout: stdoutTail,
            inputPath: localPath,
            timedOut,
            cancelled,
          })
        );
        return;
      }

      const stems = collectStemOutputs({ outputDir, filesBefore, filesAfter: listDirectoryEntries(outputDir) });
      if (!stems.length) {
        fail({
          code: STEM_ERROR_CODES.NO_OUTPUT,
          message: `Der Separator lief durch, hat aber keine WAV-Datei in ${outputDir} erzeugt.`,
          hint: 'Anderes Modell wählen (--model_filename) oder die interne Heuristik-Separation verwenden.',
        });
        return;
      }

      activeSeparations.delete(jobId);
      stemLog('INFO', `Stem-Separation fertig: ${stems.length} Stems`, { jobId, stems, durationMs: elapsed });
      sendStemProgress(event, {
        jobId,
        phase: 'done',
        ratio: 1,
        message: `${stems.length} Stems erzeugt`,
        stems,
        durationMs: elapsed,
      });
      resolve(stems);
    });
  });
});

ipcMain.handle('audio:separate-stems:cancel', async (_event, jobId) => {
  const targets = jobId ? [[jobId, activeSeparations.get(jobId)]] : [...activeSeparations.entries()];
  let cancelled = 0;
  for (const [id, child] of targets) {
    if (!child) continue;
    cancelledSeparations.add(id);
    try {
      child.kill('SIGTERM');
      cancelled += 1;
    } catch {
      // Prozess ist bereits weg
    }
  }
  stemLog('INFO', `Stem-Separation abgebrochen (${cancelled} Prozess(e))`, { jobId: jobId ?? '*' });
  return { cancelled };
});

ipcMain.handle('log:append', async (_event, entry) => {
  try {
    const writer = getLogWriter();
    if (!writer) return false;
    const line = formatLogLine(entry);
    return writer.append(line);
  } catch {
    return false;
  }
});

ipcMain.handle('log:get-path', async () => {
  try {
    const writer = getLogWriter();
    return writer ? writer.filePath : null;
  } catch {
    return null;
  }
});

app.whenReady().then(() => {
  registerAppProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
