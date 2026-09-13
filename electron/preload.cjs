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
  readRekordboxDatabase: (dbPath) => ipcRenderer.invoke('rekordbox:read-library-db', dbPath),
  // Small app-owned index of track ↔ ANLZ paths. This never writes to
  // Rekordbox's master.db or source files.
  cacheAnalysisMappings: (mappings) => ipcRenderer.invoke('rekordbox:cache-analysis-mappings', mappings),
  findAnalysisMapping: (query) => ipcRenderer.invoke('rekordbox:find-analysis-mapping', query),
  getAnalysisMappingStats: () => ipcRenderer.invoke('rekordbox:analysis-mapping-stats'),
  // Write path: saves to a user-chosen NEW file only; overwriting an original
  // Rekordbox source is refused in the main process.
  saveExportFile: (payload) => ipcRenderer.invoke('rekordbox:save-export-file', payload),
  openProjectFile: () => ipcRenderer.invoke('rekordbox:open-project-file'),
  // Preflight and inference are separate so missing/unsupported Python is known
  // before a large audio buffer is handed to the model process.
  getStemEngineStatus: () => ipcRenderer.invoke('stems:get-status'),
  separateStems: (wavBytes) => ipcRenderer.invoke('stems:separate', wavBytes),
  // One-click installation of the real AI engine (Python venv + torch +
  // demucs + htdemucs_ft weights). Progress arrives via onStemInstallProgress.
  installStemEngine: () => ipcRenderer.invoke('stems:install-engine'),
  onStemInstallProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('stems:install-progress', listener);
    return () => ipcRenderer.removeListener('stems:install-progress', listener);
  },
});
