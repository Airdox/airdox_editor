const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net } = require('electron');
const { access, readFile, stat, writeFile } = require('node:fs/promises');
const fs = require('node:fs');
const { constants } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  readRekordboxDatabase,
  locateRekordboxDatabases,
  findAllAnlzFolders,
  scanAnlzForPaths,
} = require('./dbReader.cjs');
const { isProtectedTarget, toLocalPath } = require('./pathGuard.cjs');
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

/**
 * SQLCipher-unabhängige ANLZ-Zuordnung: liest nur die PPTH-Header der
 * ANLZ-Container (read-only) und liefert exakte Treffer für die übergebenen
 * Audio-Pfade. Das ist der Weg, der auch ohne natives SQLCipher-Modul und
 * ohne lesbare master.db funktioniert — ohne ihn bleibt ein aus XML
 * importierter Track ohne Waveform.
 */
ipcMain.handle('rekordbox:scan-anlz-paths', async (_event, targetPaths) => {
  const targets = Array.isArray(targetPaths)
    ? targetPaths.filter((t) => typeof t === 'string' && t.trim() !== '')
    : [];
  desktopLogWriter.append(
    formatLogLine({
      level: 'INFO',
      category: 'DATABASE',
      message: `[IPC] scan-anlz-paths: Start – ${targets.length} Ziel(e)`,
      data: { targets: targets.length, first: targets.slice(0, 3) },
    })
  );
  const folders = findAllAnlzFolders(targets);
  const result = await scanAnlzForPaths(targets, folders);
  desktopLogWriter.append(
    formatLogLine({
      level: 'INFO',
      category: 'DATABASE',
      message:
        `[ANLZ PPTH-Scan] ${result.scanned} Dateien in ${result.folders.length} Ordnern ` +
        `(${result.elapsedMs} ms) → ${result.matches.length} Treffer`,
      data: {
        scanned: result.scanned,
        folders: result.folders,
        matches: result.matches.length,
        elapsedMs: result.elapsedMs,
      },
    })
  );
  return result;
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

// --- AUDIO STEM SEPARATION ---
// Treibt die getestete Engine aus src/stems (gebundelt nach stemsEngine.cjs).
// Frueher wurde hier `exec` mit interpoliertem Pfad aufgerufen und die
// Stem-Identitaet aus der Verzeichnisreihenfolge geraten - beides ist weg.
const stemsEngine = require('./stemsEngine.cjs');

function stemRoots() {
  const base = path.join(app.getPath('userData'), 'stems');
  return {
    workingRoot: path.join(base, 'working'),
    outputRoot: path.join(base, 'separated'),
    cacheRoot: path.join(base, 'cache'),
    modelStoreDir: path.join(base, 'models'),
  };
}

ipcMain.handle('audio:stems-preflight', async () => {
  try {
    return await stemsEngine.preflight();
  } catch (error) {
    return { available: false, reason: error && error.message ? error.message : String(error), command: 'audio-separator', defaultModel: '' };
  }
});

ipcMain.handle('audio:cancel-stems', async (_event, jobId) => {
  try {
    return stemsEngine.cancelSeparation(String(jobId || ''));
  } catch {
    return false;
  }
});

ipcMain.handle('audio:separate-stems', async (event, payload) => {
  // Accepts a bare path (legacy renderer) or { inputFilePath, jobId, usePipelineDouble }.
  const request = typeof payload === 'string' ? { inputFilePath: payload } : (payload || {});
  const inputFilePath = request.inputFilePath;
  const jobId = String(request.jobId || `job-${Date.now()}`);

  if (!inputFilePath || typeof inputFilePath !== 'string') {
    return { status: 'FAILED', stems: [], jobId, error: { code: 'INVALID_REQUEST', message: 'Kein Eingabepfad angegeben.' } };
  }

  // Read-only guard: the source must never be a protected Rekordbox original
  // that we then write next to. Output always goes to userData.
  const localPath = toLocalPath(inputFilePath);
  if (!localPath) {
    return { status: 'FAILED', stems: [], jobId, error: { code: 'INVALID_REQUEST', message: `Pfad konnte nicht aufgeloest werden: ${inputFilePath}` } };
  }

  const roots = stemRoots();
  const sender = event.sender;
  try {
    const result = await stemsEngine.separateForDesktop({
      ...roots,
      inputPath: localPath,
      jobId,
      usePipelineDouble: request.usePipelineDouble === true,
      onProgress: (entry) => {
        if (sender.isDestroyed()) return;
        sender.send('audio:stems-progress', { jobId, phase: entry.phase, detail: entry.detail, percent: entry.percent });
      },
    });
    if (!result.originalUnchanged) {
      // Should be impossible; if it ever happens it is a hard bug, not a warning.
      return { ...result, jobId, status: 'FAILED', stems: [], error: { code: 'ORIGINAL_MODIFIED', message: 'Die Originaldatei wurde veraendert - Abbruch.' } };
    }
    return { ...result, jobId };
  } catch (error) {
    const described = stemsEngine.describeError(error);
    return { status: 'FAILED', stems: [], jobId, error: described };
  }
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
