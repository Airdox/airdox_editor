const { contextBridge, ipcRenderer } = require('electron');

// Deliberately expose individual read-only operations rather than generic IPC
// or Node APIs. Renderer code can never write an original Rekordbox source.
contextBridge.exposeInMainWorld('rekordboxDesktop', {
  inspectLocation: (location) => ipcRenderer.invoke('rekordbox:inspect-location', location),
  readOriginalAudio: (location) => ipcRenderer.invoke('rekordbox:read-original-audio', location),
  chooseAnalysisFile: () => ipcRenderer.invoke('rekordbox:choose-analysis-file'),
  readAnalysisFile: (filePath) => ipcRenderer.invoke('rekordbox:read-analysis-file', filePath),
  chooseRekordboxDatabase: () => ipcRenderer.invoke('rekordbox:choose-rekordbox-database'),
  locateRekordboxDatabases: () => ipcRenderer.invoke('rekordbox:locate-rekordbox-databases'),
  // Master-DB-Gate: gibt ein strukturiertes Gate-Ergebnis zurück (ok/errorCode).
  resolveTrackFromMasterDb: (request) => ipcRenderer.invoke('rekordbox:resolve-track-master-db', request),
  readRekordboxDatabase: (dbPath) => ipcRenderer.invoke('rekordbox:read-library-db', dbPath),
  // Write path: saves to a user-chosen NEW file only; overwriting an original
  // Rekordbox source is refused in the main process.
  saveExportFile: (payload) => ipcRenderer.invoke('rekordbox:save-export-file', payload),
  openProjectFile: () => ipcRenderer.invoke('rekordbox:open-project-file'),
  // Stems: externe, trainierte CLI (audio-separator) inkl. Status, Progress und Abbruch.
  separateStems: (inputFilePath, options) => ipcRenderer.invoke('audio:separate-stems', inputFilePath, options),
  separatorStatus: (options) => ipcRenderer.invoke('audio:separator-status', options),
  cancelStemSeparation: (jobId) => ipcRenderer.invoke('audio:separate-stems:cancel', jobId),
  // Stem-Modell-Gewichte: Katalog, Download, Import, Entfernen, Ordner öffnen.
  listStemModels: (catalog) => ipcRenderer.invoke('stems:models:list', catalog),
  fetchStemModelCatalog: (options) => ipcRenderer.invoke('stems:models:runtime-catalog', options),
  downloadStemModel: (model) => ipcRenderer.invoke('stems:models:download', model),
  cancelStemModelDownload: (fileName) => ipcRenderer.invoke('stems:models:cancel', fileName),
  removeStemModel: (fileName) => ipcRenderer.invoke('stems:models:remove', fileName),
  importStemModels: () => ipcRenderer.invoke('stems:models:import'),
  openStemModelFolder: () => ipcRenderer.invoke('stems:models:open-folder'),
  onStemModelProgress: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('stems:models:progress', handler);
    return () => ipcRenderer.removeListener('stems:models:progress', handler);
  },
  onStemSeparationProgress: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('audio:separate-stems:progress', handler);
    // Gibt eine Abmeldefunktion zurück, damit der Renderer keine Listener stapelt.
    return () => ipcRenderer.removeListener('audio:separate-stems:progress', handler);
  },
  appendLog: (entry) => ipcRenderer.invoke('log:append', entry),
  getLogFilePath: () => ipcRenderer.invoke('log:get-path'),
});
