const { contextBridge, ipcRenderer } = require('electron');

// Deliberately expose individual read-only operations rather than generic IPC
// or Node APIs. Renderer code can never write an original Rekordbox source.
contextBridge.exposeInMainWorld('rekordboxDesktop', {
  inspectLocation: (location) => ipcRenderer.invoke('rekordbox:inspect-location', location),
  readOriginalAudio: (location) => ipcRenderer.invoke('rekordbox:read-original-audio', location),
  chooseAnalysisFile: () => ipcRenderer.invoke('rekordbox:choose-analysis-file'),
  readAnalysisFile: (filePath) => ipcRenderer.invoke('rekordbox:read-analysis-file', filePath),
  /**
   * Deterministically resolves the ANLZ file for a track:
   *   - analysisDataPath: the raw value from the database (master.db column
   *     AnalysisDataPath), typically beginning with `/PIONEER/USBANLZ/...`.
   *   - dbPath: absolute path to master.db (used to derive `<share>/`).
   * No recursive search, no filename reconstruction, no track-name guessing.
   * Returns { path, data, size } on success; { missing: true, reason } on miss.
   */
  resolveAndReadAnlz: (analysisDataPath, dbPath) =>
    ipcRenderer.invoke('rekordbox:resolve-read-anlz', analysisDataPath, dbPath),
  chooseRekordboxDatabase: () => ipcRenderer.invoke('rekordbox:choose-rekordbox-database'),
  locateRekordboxDatabases: () => ipcRenderer.invoke('rekordbox:locate-rekordbox-databases'),
  readRekordboxDatabase: (dbPath) => ipcRenderer.invoke('rekordbox:read-library-db', dbPath),
  // Write path: saves to a user-chosen NEW file only; overwriting an original
  // Rekordbox source is refused in the main process.
  saveExportFile: (payload) => ipcRenderer.invoke('rekordbox:save-export-file', payload),
  openProjectFile: () => ipcRenderer.invoke('rekordbox:open-project-file'),
});
