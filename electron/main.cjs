const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const { access, readFile, stat, writeFile } = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  readRekordboxDatabase,
  locateRekordboxDatabases,
  scanAnlzForPaths,
} = require('./dbReader.cjs');
const { isProtectedTarget, toLocalPath } = require('./pathGuard.cjs');
const { formatLogLine, createLogWriter } = require('./logWriter.cjs');

// Durable diagnostic logs: two files for maximum transparency (user request:
// "lieber eine Logdatei zuviel als eine zu wenig").
//  - airdox-smart-editor.log      : decisive pipeline params (existing)
//  - airdox-trace.log             : verbose event trace (every IPC, every step)
// Both rotate at 5 MB. Created lazily because app.getPath('userData') is only
// valid once the app is ready; writes never throw back into the app.
let logWriter = null;
let traceWriter = null;
function getLogWriter() {
  if (!logWriter) {
    try {
      logWriter = createLogWriter(
        path.join(app.getPath('userData'), 'airdox-smart-editor.log')
      );
    } catch {
      // Before app ready, getPath fails – fallback to console only
      return { append: () => false, filePath: 'NO_USERDATA_YET' };
    }
  }
  return logWriter;
}
function getTraceWriter() {
  if (!traceWriter) {
    try {
      traceWriter = createLogWriter(
        path.join(app.getPath('userData'), 'airdox-trace.log')
      );
    } catch {
      return { append: () => false, filePath: 'NO_USERDATA_YET' };
    }
  }
  return traceWriter;
}
function logMain(level, category, message, data) {
  try {
    const line = formatLogLine({ ts: Date.now(), level, category, message, data });
    getLogWriter().append(line);
    getTraceWriter().append(line);
  } catch {}
  // Always mirror to console for DevTools
  const consoleFn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  try { consoleFn(`[${category}] ${message}`, data || ''); } catch {}
}
function logTrace(category, message, data) {
  try {
    const line = formatLogLine({ ts: Date.now(), level: 'DEBUG', category, message, data });
    getTraceWriter().append(line);
  } catch {}
}

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
// (toLocalPath lives in pathGuard.cjs so it stays unit-testable.)

ipcMain.handle('rekordbox:inspect-location', async (_event, location) => {
  logTrace('DATABASE', '[IPC] inspect-location called', { location });
  const localPath = toLocalPath(location);
  if (!localPath) {
    logMain('WARN', 'DATABASE', '[IPC] inspect-location: kein lokaler Pfad', { location });
    return { validLocation: false, exists: false, reason: 'Kein lokaler file://-Pfad.' };
  }
  try {
    await access(localPath, constants.R_OK);
    const details = await stat(localPath);
    const res = {
      validLocation: true,
      exists: details.isFile(),
      path: localPath,
      size: details.isFile() ? details.size : null,
      modifiedAt: details.mtimeMs,
      accessMode: 'READ_ONLY',
    };
    logTrace('DATABASE', '[IPC] inspect-location OK', { path: localPath, exists: res.exists });
    return res;
  } catch (e) {
    logMain('INFO', 'DATABASE', '[IPC] inspect-location: nicht vorhanden', { path: localPath, error: e.message });
    return { validLocation: true, exists: false, path: localPath, accessMode: 'READ_ONLY' };
  }
});

ipcMain.handle('rekordbox:choose-analysis-file', async () => {
  logMain('INFO', 'DATABASE', '[IPC] choose-analysis-file: Dialog öffnen');
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Rekordbox-Analysequelle auswählen',
      properties: ['openFile'],
      filters: [
        { name: 'Rekordbox Analysis', extensions: ['DAT', 'EXT', '2EX', 'dat', 'ext', '2ex'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const out = result.canceled ? null : { path: result.filePaths[0], accessMode: 'READ_ONLY' };
    logMain('INFO', 'DATABASE', '[IPC] choose-analysis-file: Ergebnis', { canceled: result.canceled, path: out?.path || null });
    return out;
  } catch (e) {
    logMain('ERROR', 'DATABASE', '[IPC] choose-analysis-file: Fehler', { error: e.message });
    throw e;
  }
});

ipcMain.handle('rekordbox:choose-rekordbox-database', async () => {
  logMain('INFO', 'DATABASE', '[IPC] choose-rekordbox-database: Dialog öffnen');
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Rekordbox-Datenbank auswählen (nur lesend)',
      properties: ['openFile'],
      filters: [
        { name: 'Rekordbox Datenbank', extensions: ['db'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const out = result.canceled ? null : { path: result.filePaths[0], accessMode: 'READ_ONLY' };
    logMain('INFO', 'DATABASE', '[IPC] choose-rekordbox-database: Ergebnis', { canceled: result.canceled, path: out?.path || null });
    return out;
  } catch (e) {
    logMain('ERROR', 'DATABASE', '[IPC] choose-rekordbox-database: Fehler', { error: e.message });
    throw e;
  }
});

ipcMain.handle('rekordbox:locate-rekordbox-databases', async () => {
  logMain('INFO', 'DATABASE', '[IPC] locate-rekordbox-databases: Start');
  try {
    const start = Date.now();
    const res = locateRekordboxDatabases();
    logMain('INFO', 'DATABASE', `[DB Auto] Kandidaten gefunden: ${res.length}`, { candidates: res, elapsedMs: Date.now() - start });
    return res;
  } catch (e) {
    logMain('ERROR', 'DATABASE', '[IPC] locate-rekordbox-databases: Fehler', { error: e.message, stack: e.stack });
    throw e;
  }
});

ipcMain.handle('rekordbox:scan-anlz-paths', async (_event, targetPaths) => {
  const count = Array.isArray(targetPaths) ? targetPaths.length : 0;
  logMain('INFO', 'DATABASE', `[IPC] scan-anlz-paths: Start – ${count} Ziel(e)`, { targets: count, first: Array.isArray(targetPaths) ? targetPaths.slice(0,3) : null });
  try {
    const start = Date.now();
    // Non-blocking async scan with progress logging every 500 files
    const result = await scanAnlzForPaths(targetPaths, undefined, (scanned, indexed) => {
      logMain('INFO', 'DATABASE', `[ANLZ PPTH-Scan] läuft — ${scanned} Dateien gelesen, ${indexed} mit PPTH …`, { scanned, indexed });
    });
    logMain('INFO', 'DATABASE', `[ANLZ PPTH-Scan] fertig: ${result.scanned} Dateien, ${result.matches.length} Treffer`, {
      scanned: result.scanned,
      matches: result.matches.length,
      folders: result.folders,
      elapsedMs: result.elapsedMs,
      ppthSample: result.ppthSample,
      totalElapsedMs: Date.now() - start,
    });
    return result;
  } catch (e) {
    logMain('ERROR', 'DATABASE', '[IPC] scan-anlz-paths: Fehler', { error: e.message, stack: e.stack });
    throw e;
  }
});

ipcMain.handle('rekordbox:read-library-db', async (_event, dbPath) => {
  logMain('INFO', 'DATABASE', '[IPC] read-library-db: Start', { dbPath });
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    logMain('WARN', 'DATABASE', '[IPC] read-library-db: kein Pfad');
    throw new Error('Kein gültiger Datenbankpfad übergeben.');
  }
  try {
    const start = Date.now();
    const res = readRekordboxDatabase(dbPath);
    if (!res.available) {
      logMain('WARN', 'DATABASE', `[DB Auto] ${dbPath}: nicht lesbar`, { reason: res.reason, elapsedMs: Date.now() - start });
    } else {
      logMain('INFO', 'DATABASE', `[DB Auto] ${dbPath}: ${res.stats?.tracks || 0} Tracks, ${res.stats?.cues || 0} Cues`, { dbType: res.dbType, stats: res.stats, elapsedMs: Date.now() - start, warnings: res.warnings });
    }
    return res;
  } catch (e) {
    logMain('ERROR', 'DATABASE', '[IPC] read-library-db: Exception', { dbPath, error: e.message, stack: e.stack });
    throw e;
  }
});

ipcMain.handle('rekordbox:read-analysis-file', async (_event, filePath) => {
  logTrace('DATABASE', '[IPC] read-analysis-file: Start', { filePath });
  if (typeof filePath !== 'string' || !filePath.trim()) {
    logMain('WARN', 'DATABASE', '[IPC] read-analysis-file: kein Pfad');
    throw new Error('Kein gültiger Analysepfad übergeben.');
  }
  const allowedExtensions = new Set(['.dat', '.ext', '.2ex']);
  if (!allowedExtensions.has(path.extname(filePath).toLowerCase())) {
    logMain('WARN', 'DATABASE', '[IPC] read-analysis-file: falsche Extension', { filePath });
    throw new Error('Die ausgewählte Datei ist keine unterstützte Rekordbox-ANLZ-Datei.');
  }
  try {
    const localPath = path.resolve(filePath);
    await access(localPath, constants.R_OK);
    const details = await stat(localPath);
    if (!details.isFile()) throw new Error('Die ANLZ-Analysequelle verweist nicht auf eine Datei.');
    if (details.size > 1024 * 1024 * 1024) {
      throw new Error('Die ANLZ-Datei ist größer als 1 GB und wird nicht in den Arbeitsspeicher geladen.');
    }
    const data = await readFile(localPath);
    logMain('INFO', 'DATABASE', '[ANLZ] Container gelesen (Main)', { path: localPath, bytes: details.size });
    return {
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      path: localPath,
      size: details.size,
      modifiedAt: details.mtimeMs,
      accessMode: 'READ_ONLY',
    };
  } catch (e) {
    logMain('ERROR', 'DATABASE', '[IPC] read-analysis-file: Fehler', { filePath, error: e.message });
    throw e;
  }
});

ipcMain.handle('rekordbox:save-export-file', async (_event, payload) => {
  logTrace('DATABASE', '[IPC] save-export-file: Start', { kind: payload?.kind, defaultName: payload?.defaultName });
  const { data, defaultName, kind, protectedPaths } = payload || {};
  if (!data || typeof data.byteLength !== 'number' || data.byteLength === 0) {
    logMain('WARN', 'DATABASE', '[IPC] save-export-file: keine Daten');
    throw new Error('Keine Exportdaten übergeben.');
  }
  const kindFilters = {
    WAV: { name: 'WAV Audio', extensions: ['wav'] },
    XML: { name: 'Rekordbox XML', extensions: ['xml'] },
    JSON: { name: 'JSON', extensions: ['json'] },
    PROJECT: { name: 'airdox_SMART_Editor Projekt', extensions: ['airdox.json', 'json'] },
  }[kind] || { name: 'Datei', extensions: ['*'] };

  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export speichern (nur neue Datei)',
      defaultPath: typeof defaultName === 'string' ? defaultName : 'export',
      filters: [kindFilters, { name: 'All files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) {
      logMain('INFO', 'SYSTEM', '[IPC] save-export-file: abgebrochen');
      return { saved: false };
    }
    const targetPath = path.resolve(result.filePath);
    if (isProtectedTarget(targetPath, protectedPaths)) {
      logMain('WARN', 'SYSTEM', '[IPC] save-export-file: geschütztes Ziel', { targetPath });
      throw new Error(
        'Der gewählte Zielpfad ist eine Original-Rekordbox-Quelle. Exporte dürfen Originaldateien niemals überschreiben (Non-destructive).'
      );
    }
    const buffer = Buffer.from(data);
    await writeFile(targetPath, buffer);
    logMain('INFO', 'SYSTEM', '[IPC] save-export-file: gespeichert', { path: targetPath, bytes: buffer.length });
    return { saved: true, path: targetPath, bytes: buffer.length, accessMode: 'WRITE_NEW_ONLY' };
  } catch (e) {
    logMain('ERROR', 'SYSTEM', '[IPC] save-export-file: Fehler', { error: e.message });
    throw e;
  }
});

ipcMain.handle('rekordbox:open-project-file', async () => {
  logMain('INFO', 'SYSTEM', '[IPC] open-project-file: Dialog öffnen');
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Projekt öffnen (nur lesend)',
      properties: ['openFile'],
      filters: [
        { name: 'airdox_SMART_Editor Projekt', extensions: ['airdox.json', 'json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled) {
      logMain('INFO', 'SYSTEM', '[IPC] open-project-file: abgebrochen');
      return null;
    }
    const localPath = path.resolve(result.filePaths[0]);
    await access(localPath, constants.R_OK);
    const details = await stat(localPath);
    if (!details.isFile()) throw new Error('Die Projektdatei ist keine Datei.');
    if (details.size > 64 * 1024 * 1024) {
      throw new Error('Die Projektdatei ist größer als 64 MB und wird nicht geladen.');
    }
    const data = await readFile(localPath, 'utf-8');
    logMain('INFO', 'SYSTEM', '[IPC] open-project-file: gelesen', { path: localPath, bytes: details.size });
    return { data, path: localPath, size: details.size, modifiedAt: details.mtimeMs, accessMode: 'READ_ONLY' };
  } catch (e) {
    logMain('ERROR', 'SYSTEM', '[IPC] open-project-file: Fehler', { error: e.message });
    throw e;
  }
});

ipcMain.handle('rekordbox:read-original-audio', async (_event, location) => {
  logTrace('DATABASE', '[IPC] read-original-audio: Start', { location });
  const localPath = toLocalPath(location);
  if (!localPath) {
    logMain('WARN', 'DATABASE', '[IPC] read-original-audio: kein lokaler Pfad', { location });
    throw new Error('Die XML-Location ist kein lokaler Dateipfad.');
  }
  const allowedExtensions = new Set(['.wav', '.mp3', '.flac', '.aiff', '.aif', '.m4a', '.aac', '.ogg']);
  if (!allowedExtensions.has(path.extname(localPath).toLowerCase())) {
    logMain('WARN', 'DATABASE', '[IPC] read-original-audio: falsche Extension', { localPath });
    throw new Error('Die referenzierte Originaldatei ist keine unterstützte Audiodatei.');
  }
  try {
    await access(localPath, constants.R_OK);
    const details = await stat(localPath);
    if (!details.isFile()) throw new Error('Die XML-Location verweist nicht auf eine Datei.');
    if (details.size > 1024 * 1024 * 1024) {
      throw new Error('Die Originaldatei ist größer als 1 GB und wird nicht in den Arbeitsspeicher geladen.');
    }
    const data = await readFile(localPath);
    logMain('INFO', 'DATABASE', '[IPC] read-original-audio: gelesen', { path: localPath, bytes: details.size });
    return {
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      path: localPath,
      size: details.size,
      modifiedAt: details.mtimeMs,
      accessMode: 'READ_ONLY',
    };
  } catch (e) {
    logMain('ERROR', 'DATABASE', '[IPC] read-original-audio: Fehler', { localPath, error: e.message });
    throw e;
  }
});

// --- Log-File bridge: durable diagnostics for all decisive pipeline params ---

ipcMain.handle('airdox:append-log', async (_event, entry) => {
  try {
    if (!entry || typeof entry.message !== 'string') return false;
    const ok = getLogWriter().append(formatLogLine(entry));
    // Also mirror to trace log for full transparency
    try { getTraceWriter().append(formatLogLine(entry)); } catch {}
    return ok;
  } catch (e) {
    try { logMain('ERROR', 'SYSTEM', '[IPC] append-log: Fehler', { error: e.message }); } catch {}
    return false;
  }
});

ipcMain.handle('airdox:get-log-path', async () => {
  try {
    const p = getLogWriter().filePath;
    const tp = getTraceWriter().filePath;
    logTrace('SYSTEM', '[IPC] get-log-path', { main: p, trace: tp });
    return p;
  } catch {
    return null;
  }
});

ipcMain.handle('airdox:get-trace-path', async () => {
  try {
    return getTraceWriter().filePath;
  } catch {
    return null;
  }
});

ipcMain.handle('airdox:reveal-log', async () => {
  try {
    const p = getLogWriter().filePath;
    logMain('INFO', 'SYSTEM', '[IPC] reveal-log', { path: p });
    shell.showItemInFolder(p);
    return true;
  } catch (e) {
    logMain('ERROR', 'SYSTEM', '[IPC] reveal-log: Fehler', { error: e.message });
    return false;
  }
});

app.whenReady().then(() => {
  const writer = getLogWriter();
  writer.append(formatLogLine({
    ts: Date.now(),
    level: 'INFO',
    category: 'SYSTEM',
    message: `Session gestartet — Log-Datei: ${writer.filePath}`,
    data: {
      app: APP_NAME,
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
  }));
  registerAppProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
