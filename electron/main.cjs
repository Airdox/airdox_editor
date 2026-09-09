const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net } = require('electron');
const { access, readFile, stat, writeFile } = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  readRekordboxDatabase,
  locateRekordboxDatabases,
} = require('./dbReader.cjs');
const { isProtectedTarget } = require('./pathGuard.cjs');

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

// --- IPC-Handler bleiben unverändert ---

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

/**
 * Deterministic PathResolver for Rekordbox AnalysisDataPath.
 *
 * The `AnalysisDataPath` column in djmdContent (master.db) stores a path
 * relative to the `share/` directory that sits next to master.db, e.g.:
 *   `/PIONEER/USBANLZ/Q001/ANLZ0000.DAT`
 * It may also appear as:
 *   `PIONEER/USBANLZ/Q001/ANLZ0000.DAT`   (no leading slash)
 *   `C:/Users/.../Pioneer/rekordbox/share/PIONEER/USBANLZ/.../ANLZ0000.DAT` (absolute)
 *
 * We NEVER search by track name, NEVER walk the tree recursively, and NEVER
 * guess filename variants – we only normalize and join.
 */
function resolveAnalysisDataPath(analysisDataPath, dbPath) {
  if (typeof analysisDataPath !== 'string' || !analysisDataPath.trim()) {
    return { missing: true, reason: 'Kein AnalysisDataPath in der Track-Zeile vorhanden.' };
  }
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    return { missing: true, reason: 'Kein master.db-Pfad bekannt; Share-Verzeichnis kann nicht bestimmt werden.' };
  }

  // dbPath is .../share/master.db → shareDir is .../share
  const dbDir = path.dirname(path.resolve(dbPath));
  let shareDir = dbDir;
  // If master.db was opened directly from its containing folder (master.db
  // lives inside share/ in every Rekordbox 6/7 layout), we are already there.
  // Defensive: ensure `shareDir` ends with `share` and contains `PIONEER`.
  if (!/[\\/]share$/i.test(shareDir)) {
    // Sometimes the opener passes the parent (Pioneer/rekordbox) – try share/.
    const candidate = path.join(shareDir, 'share');
    const masterCandidate = path.join(candidate, 'master.db');
    try { require('node:fs').accessSync(masterCandidate, constants.R_OK); shareDir = candidate; }
    catch { /* keep dbDir */ }
  }

  const raw = analysisDataPath.trim();

  // Absolute Windows path (starts with drive letter or UNC): use as-is.
  if (/^[a-z]:[\\/]/i.test(raw) || raw.startsWith('\\\\')) {
    const abs = path.resolve(raw);
    return { resolvedPath: abs };
  }

  // file:// URL in AnalysisDataPath
  if (/^file:/i.test(raw)) {
    try { return { resolvedPath: require('node:url').fileURLToPath(raw) }; }
    catch { /* fall through */ }
  }

  // Relative path (with or without leading slash/backslash) → strip and join
  // against share/.
  let rel = raw.replace(/^[\\/]+/, '').replace(/\//g, path.sep);
  const resolved = path.join(shareDir, rel);

  // Security: sandbox to shareDir (no ../ escape).
  const normShare = path.normalize(shareDir) + path.sep;
  const normResolved = path.normalize(resolved);
  if (!normResolved.startsWith(normShare) && normResolved !== path.normalize(shareDir)) {
    return { missing: true, reason: `AnalysisDataPath verweist ausserhalb des share/-Verzeichnisses: ${raw}` };
  }
  return { resolvedPath: normResolved };
}

ipcMain.handle('rekordbox:resolve-read-anlz', async (_event, analysisDataPath, dbPath) => {
  const resolution = resolveAnalysisDataPath(analysisDataPath, dbPath);
  if (resolution.missing) {
    return { available: false, reason: resolution.reason, analysisDataPath, dbPath };
  }
  const target = resolution.resolvedPath;
  try {
    await access(target, constants.R_OK);
    const details = await stat(target);
    if (!details.isFile()) {
      return { available: false, reason: `AnalysisDataPath verweist nicht auf eine Datei: ${target}`, resolvedPath: target };
    }
    if (details.size > 256 * 1024 * 1024) {
      return { available: false, reason: `ANLZ-Datei ist grösser als 256 MB und wird nicht geladen: ${target}`, resolvedPath: target };
    }
    const data = await readFile(target);
    return {
      available: true,
      path: target,
      size: details.size,
      modifiedAt: details.mtimeMs,
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      accessMode: 'READ_ONLY',
    };
  } catch (err) {
    return {
      available: false,
      reason: `ANLZ-Datei nicht gefunden oder nicht lesbar: ${target} (${err && err.message ? err.message : err})`,
      resolvedPath: target,
      analysisDataPath,
    };
  }
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
