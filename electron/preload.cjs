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
  readRekordboxTrackAnalysis: (payload) => ipcRenderer.invoke('rekordbox:read-track-analysis', payload),
  // Write path: saves to a user-chosen NEW file only; overwriting an original
  // Rekordbox source is refused in the main process.
  saveExportFile: (payload) => ipcRenderer.invoke('rekordbox:save-export-file', payload),
  openProjectFile: () => ipcRenderer.invoke('rekordbox:open-project-file'),
  separateStems: (payload) => ipcRenderer.invoke('audio:separate-stems', payload),
  stemsPreflight: () => ipcRenderer.invoke('audio:stems-preflight'),
  cancelStems: (jobId) => ipcRenderer.invoke('audio:cancel-stems', jobId),
  // Progress is push-based; returns an unsubscribe function so the renderer
  // cannot leak listeners across re-renders.
  onStemsProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('audio:stems-progress', listener);
    return () => ipcRenderer.removeListener('audio:stems-progress', listener);
  },
  appendLog: (entry) => ipcRenderer.invoke('log:append', entry),
  getLogFilePath: () => ipcRenderer.invoke('log:get-path'),
});
