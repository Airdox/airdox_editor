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
  // Write path: saves to a user-chosen NEW file only; overwriting an original
  // Rekordbox source is refused in the main process.
  saveExportFile: (payload) => ipcRenderer.invoke('rekordbox:save-export-file', payload),
  openProjectFile: () => ipcRenderer.invoke('rekordbox:open-project-file'),
  separateStems: (inputFilePath) => ipcRenderer.invoke('audio:separate-stems', inputFilePath),
  appendLog: (entry) => ipcRenderer.invoke('log:append', entry),
  getLogFilePath: () => ipcRenderer.invoke('log:get-path'),
  // Analysis registry
  resolveAnalysis: (trackId) => ipcRenderer.invoke('analysis:resolve', trackId),
  registerAnalysis: (trackId, anlzPath) => ipcRenderer.invoke('analysis:register', trackId, anlzPath),
  listAnalysis: () => ipcRenderer.invoke('analysis:list'),
  // New logging bridge
  writeLogs: (entries) => ipcRenderer.invoke('logs:write', entries),
  getLogsPath: () => ipcRenderer.invoke('logs:get-path'),
});

// Stem engine API matching StemDesktopApi
contextBridge.exposeInMainWorld('stemEngine', {
  getStatus: () => ipcRenderer.invoke('stems:engine-status'),
  separate: (request) => ipcRenderer.invoke('stems:separate', request),
  getJobStatus: (jobId) => ipcRenderer.invoke('stems:job-status', jobId),
  cancelJob: (jobId) => ipcRenderer.invoke('stems:job-cancel', jobId),
  getJobProgress: () => ipcRenderer.invoke('stems:job-progress'),
  // Installer
  install: (opts) => ipcRenderer.invoke('stems:install', opts),
  checkInstall: () => ipcRenderer.invoke('stems:install:check'),
  onInstallProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('stems:install-progress', handler);
    return () => ipcRenderer.removeListener('stems:install-progress', handler);
  },
  onJobProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('stems:job-progress', handler);
    return () => ipcRenderer.removeListener('stems:job-progress', handler);
  },
});

// Logging bridge for renderer -> main
contextBridge.exposeInMainWorld('airdoxLogger', {
  write: (entries) => ipcRenderer.invoke('logs:write', entries),
  getPath: () => ipcRenderer.invoke('logs:get-path'),
});
