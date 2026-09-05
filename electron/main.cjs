const { app, BrowserWindow, dialog, ipcMain } = require('electron');

// Der Produktname steuert Fenstertitel, userData-Pfad und AppUserModelId.
const PRODUCT_NAME = 'Airdox_intelligents_Editor';
app.setName(PRODUCT_NAME);
const { access, mkdir, readFile, stat, writeFile } = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const {
  readRekordboxDatabase,
  locateRekordboxDatabases,
  describeEngines,
} = require('./dbReader.cjs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) {
    mainWindow.loadURL(developmentUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function toLocalPath(location) {
  if (typeof location !== 'string' || !location.trim()) return null;

  try {
    // Windows drive paths must be handled before generic URL detection because
    // "C:\\Music" otherwise looks like a URL with the scheme "c:".
    if (/^[a-z]:[\\/]/i.test(location) || path.isAbsolute(location)) {
      return path.resolve(location);
    }

    // Rekordbox exports file:// URLs. Reject all non-file URL schemes.
    if (/^[a-z][a-z\d+.-]*:/i.test(location)) {
      const url = new URL(location);
      return url.protocol === 'file:' ? fileURLToPath(url) : null;
    }

    return path.resolve(location);
  } catch {
    return null;
  }
}

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
      // This bridge never exposes a write operation; source files remain read-only.
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

  // File selection returns a path only; the selected file is opened read
  // only through rekordbox:read-analysis-file.
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
  // Read-only directory scan of the standard Pioneer app-data folders.
  return locateRekordboxDatabases();
});

ipcMain.handle('rekordbox:database-capabilities', async () => {
  // Lets the UI explain which reader is active: the optional native SQLCipher
  // binding or the compiler-free JavaScript reader. Nothing is written here.
  return describeEngines();
});

ipcMain.handle('rekordbox:read-library-db', async (_event, dbPath) => {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new Error('Kein gültiger Datenbankpfad übergeben.');
  }
  // The database is opened exclusively with SQLite readonly mode (or, when the
  // native module is missing, decrypted in memory without any file writes).
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

  // ANLZ files are a few hundred KB to a few MB; the boundary keeps the
  // renderer process safe while still accepting every real-world file.
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

  // The source is opened only for reading. A bounded transfer avoids attempting
  // to clone impractically large files into the renderer process.
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

// ─────────────────────────────────────────────────────────────────────────────
// Projektdateien und Exporte: der einzige Weg, auf der Platte zu schreiben.
//
// Grundsatz des Programms: Rekordbox-Originale (Audiodateien, master.db,
// exportLibrary.db, ANLZ) werden ausschließlich gelesen. Geschrieben wird nur
// dorthin, wo der Mensch es in einem Systemdialog bestätigt hat. Dieser Prozess
// merkt sich deshalb die Pfade, die ein Dialog gerade freigegeben hat, und jede
// Schreiboperation muss darin liegen – das begrenzt auch ein fehlerhaftes oder
// manipuliertes Renderer-Skript.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_WRITE_BYTES = 512 * 1024 * 1024; // 512 MB je Datei
const confirmedSavePaths = new Set();
const confirmedSaveDirs = new Set();

const SAVE_FILTERS = {
  project: { name: 'Airdox-Projekt (JSON)', extensions: ['json'] },
  wav: { name: 'WAV-Audio (16-Bit PCM)', extensions: ['wav'] },
  xml: { name: 'Rekordbox XML', extensions: ['xml'] },
  text: { name: 'Textdatei', extensions: ['txt', 'log'] },
};

function filterFor(kind) {
  const single = SAVE_FILTERS[kind] || SAVE_FILTERS.text;
  return [single, { name: 'Alle Dateien', extensions: ['*'] }];
}

// Windows ergänzt die Filterendung nicht immer; ohne Endung wäre die Datei nutzlos.
function withExtension(target, kind) {
  if (path.extname(target)) return target;
  const ext = kind === 'project' ? '.airdoxproj.json' : '.' + (SAVE_FILTERS[kind] || SAVE_FILTERS.text).extensions[0];
  return target + ext;
}

function rememberWriteTarget(filePath) {
  const resolved = path.resolve(filePath);
  confirmedSavePaths.add(resolved);
  confirmedSaveDirs.add(path.dirname(resolved));
  return resolved;
}

function assertWritableTarget(target) {
  const resolved = path.resolve(String(target || ''));
  if (confirmedSavePaths.has(resolved)) return resolved;
  for (const dir of confirmedSaveDirs) {
    if (resolved.startsWith(dir + path.sep)) return resolved;
  }
  throw new Error('Schreiben verweigert: dieser Pfad wurde nicht in einem Speicherdialog bestätigt.');
}

ipcMain.handle('datei:specify-path', async (_event, options) => {
  const kind = options && typeof options.kind === 'string' ? options.kind : 'project';
  const suggested = options && typeof options.suggestedName === 'string' && options.suggestedName.trim()
    ? path.basename(options.suggestedName.trim())
    : 'projekt.json';
  const startDir = options && typeof options.startDir === 'string' && options.startDir.trim()
    ? options.startDir
    : app.getPath('documents');

  const result = await dialog.showSaveDialog(mainWindow, {
    title: options && options.title ? options.title : 'Ziel für die Datei wählen',
    defaultPath: path.join(startDir, suggested),
    filters: filterFor(kind),
    properties: ['createDirectories', 'showHiddenFiles'],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  return { canceled: false, filePath: rememberWriteTarget(withExtension(result.filePath, kind)) };
});

ipcMain.handle('datei:write', async (_event, payload) => {
  const target = assertWritableTarget(payload && payload.filePath);
  const encoding = payload && payload.encoding === 'utf8' ? 'utf8' : 'base64';
  if (!payload || typeof payload.data !== 'string' || payload.data.length === 0) {
    throw new Error('Keine Daten zum Schreiben erhalten.');
  }
  const buffer = encoding === 'utf8' ? Buffer.from(payload.data, 'utf8') : Buffer.from(payload.data, 'base64');
  if (buffer.length > MAX_WRITE_BYTES) {
    throw new Error('Datei größer als ' + MAX_WRITE_BYTES / 1024 / 1024 + ' MB – Abbruch.');
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return { filePath: target, bytes: buffer.length };
});

ipcMain.handle('datei:write-many', async (_event, payload) => {
  const dir = path.resolve(String((payload && payload.directory) || ''));
  if (!confirmedSaveDirs.has(dir)) {
    throw new Error('Zielordner wurde nicht in einem Ordnerdialog bestätigt.');
  }
  const files = payload && Array.isArray(payload.files) ? payload.files : [];
  if (files.length === 0) throw new Error('Keine Dateien zum Schreiben erhalten.');
  await mkdir(dir, { recursive: true });
  const written = [];
  for (const entry of files) {
    const rawName = String((entry && entry.name) || '');
    const name = path.basename(rawName.replace(/[\\/:*?"<>|]+/g, '_'));
    if (!name) throw new Error('Dateiname fehlt.');
    const target = assertWritableTarget(path.join(dir, name));
    const buffer = entry && entry.encoding === 'utf8'
      ? Buffer.from(String((entry && entry.data) || ''), 'utf8')
      : Buffer.from(String((entry && entry.data) || ''), 'base64');
    if (buffer.length > MAX_WRITE_BYTES) {
      throw new Error(name + ' ist größer als ' + MAX_WRITE_BYTES / 1024 / 1024 + ' MB – Abbruch.');
    }
    await writeFile(target, buffer);
    written.push({ filePath: target, bytes: buffer.length });
  }
  return { directory: dir, written };
});

ipcMain.handle('datei:pick-open', async (_event, options) => {
  const kind = options && typeof options.kind === 'string' ? options.kind : 'project';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options && options.title ? options.title : 'Datei öffnen',
    defaultPath: (options && options.startDir) || app.getPath('documents'),
    filters: filterFor(kind),
    properties: ['openFile', 'showHiddenFiles'],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, filePath: path.resolve(result.filePaths[0]) };
});

ipcMain.handle('datei:pick-directory', async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options && options.title ? options.title : 'Ordner wählen',
    defaultPath: (options && options.startDir) || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const dir = path.resolve(result.filePaths[0]);
  confirmedSaveDirs.add(dir);
  return { canceled: false, directory: dir };
});

ipcMain.handle('datei:read-text', async (_event, payload) => {
  const target = path.resolve(String((payload && payload.filePath) || ''));
  const details = await stat(target);
  if (!details.isFile()) throw new Error('Keine Datei.');
  const limit = 512 * 1024 * 1024;
  if (details.size > limit) {
    throw new Error('Datei ist größer als ' + limit / 1024 / 1024 + ' MB und wird nicht gelesen.');
  }
  // Gelesen wird über diesen Kanal nur, was per Dialog gewählt wurde oder eine
  // Projektdatei ist – Audiodaten und Bibliotheken haben ihre eigenen Lesekanäle.
  const allowed =
    confirmedSavePaths.has(target) ||
    confirmedSavePaths.has(path.dirname(target)) ||
    /\.(airdoxproj\.)?json$/i.test(target);
  if (!allowed) {
    throw new Error('Nur Projektdateien (.airdoxproj.json/.json) können über diesen Kanal gelesen werden.');
  }
  const text = await readFile(target, 'utf8');
  return { filePath: target, text, size: details.size, modifiedAt: details.mtimeMs };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
