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
  // Durable log mirror: renderer log entries land in
  // <userData>/airdox-smart-editor.log (rotation handled in the main process).
  appendLog: (entry) => ipcRenderer.invoke('rekordbox:append-log', entry),
  getLogFilePath: () => ipcRenderer.invoke('rekordbox:get-log-file-path'),
});
