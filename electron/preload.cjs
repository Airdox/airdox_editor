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
  describeDatabaseEngines: () => ipcRenderer.invoke('rekordbox:database-capabilities'),
  readRekordboxDatabase: (dbPath) => ipcRenderer.invoke('rekordbox:read-library-db', dbPath),

  // Projektdateien und Exporte. Der Main-Prozess lässt Schreibzugriffe nur auf
  // Pfade zu, die zuvor in einem Systemdialog bestätigt wurden.
  chooseSavePath: (options) => ipcRenderer.invoke('datei:specify-path', options || {}),
  writeFile: (payload) => ipcRenderer.invoke('datei:write', payload),
  writeMany: (payload) => ipcRenderer.invoke('datei:write-many', payload),
  chooseOpenPath: (options) => ipcRenderer.invoke('datei:pick-open', options || {}),
  chooseDirectory: (options) => ipcRenderer.invoke('datei:pick-directory', options || {}),
  readTextFile: (payload) => ipcRenderer.invoke('datei:read-text', payload),
});
