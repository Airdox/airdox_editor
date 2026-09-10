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
  scanAnlzPaths: (targetPaths) => ipcRenderer.invoke('rekordbox:scan-anlz-paths', targetPaths),
  // ANLZ-Scan-Fortschritt (async scan): stabile interne Listener-Referenz,
  // damit on/off sauber koppelbar ist. Liefert die unsubscribe-Funktion.
  onAnlzScanProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    if (!global.__anlzScanProgressListener) {
      const listener = (_event, payload) => global.__anlzScanProgressSet.forEach((cb) => cb(payload));
      global.__anlzScanProgressListener = listener;
      global.__anlzScanProgressSet = new Set();
      ipcRenderer.on('anlz-ppth-scan-progress', listener);
    }
    global.__anlzScanProgressSet.add(callback);
    return () => {
      global.__anlzScanProgressSet.delete(callback);
      if (global.__anlzScanProgressSet.size === 0) {
        ipcRenderer.removeListener('anlz-ppth-scan-progress', global.__anlzScanProgressListener);
        global.__anlzScanProgressListener = null;
        global.__anlzScanProgressSet = null;
      }
    };
  },
  // Write path: saves to a user-chosen NEW file only; overwriting an original
  // Rekordbox source is refused in the main process.
  saveExportFile: (payload) => ipcRenderer.invoke('rekordbox:save-export-file', payload),
  // Original Protection Agent (permanent): registry + verdicts live in the
  // main process; the renderer registers every original it knows about.
  originalGuardRegister: (entries) => ipcRenderer.invoke('original-guard:register', entries),
  originalGuardCheck: (operation, filePath, context) =>
    ipcRenderer.invoke('original-guard:check', { operation, filePath, context }),
  originalGuardList: () => ipcRenderer.invoke('original-guard:list'),
  openProjectFile: () => ipcRenderer.invoke('rekordbox:open-project-file'),
  // Diagnostic log file (durable): mirrors every decisive pipeline parameter
  // into <userData>/airdox-smart-editor.log. Append-only, never throws.
  appendLog: (entry) => ipcRenderer.invoke('airdox:append-log', entry),
  getLogFilePath: () => ipcRenderer.invoke('airdox:get-log-path'),
  revealLogFile: () => ipcRenderer.invoke('airdox:reveal-log'),
});
