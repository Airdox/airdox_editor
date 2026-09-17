const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net } = require('electron');
const { access, readFile, stat, writeFile } = require('node:fs/promises');
const fs = require('node:fs');
const { constants } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Early logger configure in appData logs
const logger = require('./logger.cjs');
try {
  logger.configureLogger({ app, level: process.env.AIRDOX_LOG_LEVEL || 'info' });
} catch (e) {
  console.error('Logger configure failed', e);
}

const {
  readRekordboxDatabase,
  locateRekordboxDatabases,
} = require('./dbReader.cjs');
const { isProtectedTarget, toLocalPath } = require('./pathGuard.cjs');
const { createAnalysisRegistry } = require('./analysisRegistry.cjs');
const { registerStemEngineIpc } = require('./stemEngineBridge.cjs');
const { registerInstallerIpc } = require('./stemInstaller.cjs');

const APP_NAME = 'airdox_SMART_Editor';
const APP_PROTOCOL = 'airdox';

// WICHTIG: Das eigene Protokoll muss VOR app.whenReady() als privilegiert
// registriert werden, damit Chromium es als \"standard\" (http-ähnlich)
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
let analysisRegistry = null;

function getAnalysisRegistry() {
  if (analysisRegistry) return analysisRegistry;
  try {
    analysisRegistry = createAnalysisRegistry(app);
  } catch (e) {
    logger.error('Failed to create analysis registry', { error: e.message });
  }
  return analysisRegistry;
}

// OriginalSourceRegistry authoritative protection
const originalSourceRegistry = new Set();
function registerOriginalSource(p) {
  try {
    const normalized = path.resolve(p).toLowerCase();
    originalSourceRegistry.add(normalized);
    logger.debug('Original source registered', { path: normalized });
  } catch {}
}
function isOriginalSource(p) {
  try {
    const normalized = path.resolve(p).toLowerCase();
    return originalSourceRegistry.has(normalized);
  } catch {
    return false;
  }
}

// IPC audit wrapper
function auditIpc(channel, handler) {
  return async (event, ...args) => {
    const start = Date.now();
    try {
      // Summarize args as binary if needed
      const summary = args.map(a => logger.summarizeForLog(a));
      logger.info(`IPC ${channel} called`, { args: summary });
      const result = await handler(event, ...args);
      logger.info(`IPC ${channel} succeeded`, { duration: Date.now() - start });
      return result;
    } catch (e) {
      logger.error(`IPC ${channel} failed`, { error: e.message, duration: Date.now() - start });
      throw e;
    }
  };
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

  // Das Standard-Electron-Menü (\"File Edit View Window\") entfernen – die App
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
    logger.error('[Electron] Renderer-Prozess abgestürzt', details);
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error(`[Electron] Laden fehlgeschlagen (${errorCode}) bei ${validatedURL}: ${errorDescription}`);
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
    // ordner. Dadurch funktionieren <script type=\"module\" crossorigin> und
    // alle relativen Asset-Pfade ohne CORS-/Origin-Probleme.
    mainWindow.loadURL(`${APP_PROTOCOL}://app/index.html`).catch((err) => {
      logger.error('[Electron] Konnte App-Startseite nicht laden', { error: err.message });
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
  // Alles nach \"airdox://app/\" als Pfad innerhalb von dist/ behandeln.
  let relPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  if (!relPath) relPath = 'index.html';
  // Verhindern, dass \"../\" aus dist/ herausführt.
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
      logger.error('[App-Protocol] Fehler', { url: request.url, error: err.message });
      return new Response('Internal Error', { status: 500 });
    }
  });
}

// --- IPC-Handler with audit wrapper ---

ipcMain.handle('rekordbox:append-log', auditIpc('rekordbox:append-log', async (_event, entry) => {
  logger.ingestRendererEntries([entry], app);
  return true;
}));

ipcMain.handle('rekordbox:get-log-file-path', auditIpc('rekordbox:get-log-file-path', async () => {
  return logger.getCurrentLogPath(app);
}));

ipcMain.handle('logs:write', auditIpc('logs:write', async (_event, entries) => {
  logger.ingestRendererEntries(entries, app);
  return true;
}));

ipcMain.handle('logs:get-path', auditIpc('logs:get-path', async () => {
  return logger.getCurrentLogPath(app);
}));

ipcMain.handle('rekordbox:inspect-location', auditIpc('rekordbox:inspect-location', async (_event, location) => {
  const localPath = toLocalPath(location);
  if (!localPath) {
    return { validLocation: false, exists: false, reason: 'Kein lokaler file://-Pfad.' };
  }
  registerOriginalSource(localPath);
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
}));

ipcMain.handle('rekordbox:choose-analysis-file', auditIpc('rekordbox:choose-analysis-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Rekordbox-Analysequelle auswählen',
    properties: ['openFile'],
    filters: [
      { name: 'Rekordbox Analysis', extensions: ['DAT', 'EXT', '2EX', 'dat', 'ext', '2ex'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return null;
  const filePath = result.filePaths[0];
  registerOriginalSource(filePath);
  return { path: filePath, accessMode: 'READ_ONLY' };
}));

ipcMain.handle('rekordbox:choose-rekordbox-database', auditIpc('rekordbox:choose-rekordbox-database', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Rekordbox-Datenbank auswählen (nur lesend)',
    properties: ['openFile'],
    filters: [
      { name: 'Rekordbox Datenbank', extensions: ['db'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return null;
  const filePath = result.filePaths[0];
  registerOriginalSource(filePath);
  return { path: filePath, accessMode: 'READ_ONLY' };
}));

ipcMain.handle('rekordbox:locate-rekordbox-databases', auditIpc('rekordbox:locate-rekordbox-databases', async () => {
  return locateRekordboxDatabases();
}));

ipcMain.handle('rekordbox:read-library-db', auditIpc('rekordbox:read-library-db', async (_event, dbPath) => {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new Error('Kein gültiger Datenbankpfad übergeben.');
  }
  registerOriginalSource(dbPath);
  return readRekordboxDatabase(dbPath);
}));

ipcMain.handle('rekordbox:read-analysis-file', auditIpc('rekordbox:read-analysis-file', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Kein gültiger Analysepfad übergeben.');
  }
  const allowedExtensions = new Set(['.dat', '.ext', '.2ex']);
  if (!allowedExtensions.has(path.extname(filePath).toLowerCase())) {
    throw new Error('Die ausgewählte Datei ist keine unterstützte Rekordbox-ANLZ-Datei.');
  }
  const localPath = path.resolve(filePath);
  registerOriginalSource(localPath);
  await access(localPath, constants.R_OK);
  const details = await stat(localPath);
  if (!details.isFile()) throw new Error('Die ANLZ-Analysequelle verweist nicht auf eine Datei.');
  if (details.size > 1024 * 1024 * 1024) {
    throw new Error('Die ANLZ-Datei ist größer als 1 GB und wird nicht in den Arbeitsspeicher geladen.');
  }
  const data = await readFile(localPath);
  // Register in analysis registry
  try {
    const registry = getAnalysisRegistry();
    if (registry) {
      // We don't have trackId here, but we can still log
      logger.info('ANLZ file read', { path: localPath, size: details.size });
    }
  } catch {}
  return {
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    path: localPath,
    size: details.size,
    modifiedAt: details.mtimeMs,
    accessMode: 'READ_ONLY',
  };
}));

ipcMain.handle('rekordbox:save-export-file', auditIpc('rekordbox:save-export-file', async (_event, payload) => {
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
  if (isProtectedTarget(targetPath, protectedPaths) || isOriginalSource(targetPath)) {
    throw new Error(
      'Der gewählte Zielpfad ist eine Original-Rekordbox-Quelle. Exporte dürfen Originaldateien niemals überschreiben (Non-destructive).'
    );
  }
  const buffer = Buffer.from(data);
  await writeFile(targetPath, buffer);
  logger.info('Export saved', { path: targetPath, bytes: buffer.length, kind });
  return { saved: true, path: targetPath, bytes: buffer.length, accessMode: 'WRITE_NEW_ONLY' };
}));

ipcMain.handle('rekordbox:open-project-file', auditIpc('rekordbox:open-project-file', async () => {
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
}));

ipcMain.handle('rekordbox:read-original-audio', auditIpc('rekordbox:read-original-audio', async (_event, location) => {
  const localPath = toLocalPath(location);
  if (!localPath) throw new Error('Die XML-Location ist kein lokaler Dateipfad.');
  const allowedExtensions = new Set(['.wav', '.mp3', '.flac', '.aiff', '.aif', '.m4a', '.aac', '.ogg']);
  if (!allowedExtensions.has(path.extname(localPath).toLowerCase())) {
    throw new Error('Die referenzierte Originaldatei ist keine unterstützte Audiodatei.');
  }
  registerOriginalSource(localPath);
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
}));

// Analysis registry IPC
ipcMain.handle('analysis:resolve', auditIpc('analysis:resolve', async (_event, trackId) => {
  const registry = getAnalysisRegistry();
  if (!registry) return null;
  return registry.get(trackId);
}));

ipcMain.handle('analysis:register', auditIpc('analysis:register', async (_event, trackId, anlzPath) => {
  const registry = getAnalysisRegistry();
  if (!registry) return false;
  return registry.set(trackId, anlzPath, 'user');
}));

ipcMain.handle('analysis:list', auditIpc('analysis:list', async () => {
  const registry = getAnalysisRegistry();
  if (!registry) return [];
  return registry.list();
}));

// --- AUDIO STEM SEPARATION ---
const { exec } = require('node:child_process');

ipcMain.handle('audio:separate-stems', auditIpc('audio:separate-stems', async (_event, inputFilePath) => {
  return new Promise((resolve, reject) => {
    // Output directory for the stems
    const outputDir = path.join(app.getPath('userData'), 'separated_stems');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    logger.info(`Starting separation for: ${inputFilePath}`, { outputDir });
    
    // Wir rufen das globale Python CLI Tool 'audio-separator' auf.
    // Voraussetzung: Der Nutzer hat `pip install audio-separator[gpu]` auf seinem Windows PC ausgeführt.
    const command = `audio-separator \"${inputFilePath}\" --output_dir \"${outputDir}\" --output_format WAV`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        logger.error(`Error executing separator`, { error: error.message, stderr });
        reject(error.message);
        return;
      }
      
      logger.info(`Separation finished`, { stdout: stdout.slice(0, 500) });
      
      fs.readdir(outputDir, (err, files) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Find generated .wav files that contain the base name
        const baseName = path.parse(inputFilePath).name;
        const generatedFiles = files.filter(f => (f.includes(baseName) && f.endsWith('.wav')) || f.endsWith('.wav'));
        
        // Return absolute paths to the React frontend
        const stems = generatedFiles.map(file => path.join(outputDir, file));
        
        resolve(stems);
      });
    });
  });
}));

ipcMain.handle('log:append', auditIpc('log:append', async (_event, entry) => {
  try {
    logger.ingestRendererEntries([entry], app);
    return true;
  } catch {
    return false;
  }
}));

ipcMain.handle('log:get-path', auditIpc('log:get-path', async () => {
  try {
    return logger.getCurrentLogPath(app);
  } catch {
    return null;
  }
}));

// Register stem engine and installer IPC
try {
  registerStemEngineIpc(ipcMain, { app, logger });
  registerInstallerIpc(ipcMain, { app, logger });
} catch (e) {
  logger.error('Failed to register stem IPC', { error: e.message });
}

app.whenReady().then(() => {
  registerAppProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  logger.info('App ready', { version: app.getVersion() });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  try {
    await logger.flush();
  } catch {}
});
