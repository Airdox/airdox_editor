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
  chooseDirectory: (options) => ipcRenderer.invoke('rekordbox:choose-directory', options),
  // Preflight and inference are separate so missing/unsupported Python is known
  // before a large audio buffer is handed to the model process.
  // Legacy Demucs path – now optional, BS-RoFormer is primary per §26
  getStemEngineStatus: () => ipcRenderer.invoke('stems:get-status'),
  separateStems: (wavBytes) => ipcRenderer.invoke('stems:separate', wavBytes),
  // New: BS-RoFormer diagnostics per §13, §14
  getStemDiagnostics: () => ipcRenderer.invoke('stems:diagnostics'),
  getStemPreflight: () => ipcRenderer.invoke('stems:preflight'),

  // --- Neue Stem-Engine (src/stems) als Jobs -------------------------------
  // Verschachtelt als `stemEngine`, damit der Vertrag exakt
  // `StemDesktopApi` aus src/stems/transportTypes.ts ist (Typ + Präsenz werden
  // von tests/stem-engine-ipc-contract.test.ts geprüft).
  // status() liefert Profile/Modelle/Stem-Listen aus dem Modell-Katalog,
  // startStemJob() gibt sofort eine jobId zurück, Fortschritt kommt über
  // onStemJobProgress, Stems werden einzeln geladen (kein 4-fach-Buffer-Payload).
  stemEngine: {
    getStemEngineStatus: () => ipcRenderer.invoke('stems:engine-status'),
    startStemJob: (payload) => ipcRenderer.invoke('stems:job-start', payload),
    waitStemJob: (jobId) => ipcRenderer.invoke('stems:job-wait', jobId),
    getStemJob: (jobId) => ipcRenderer.invoke('stems:job-get', jobId),
    listStemJobs: () => ipcRenderer.invoke('stems:job-list'),
    cancelStemJob: (jobId, reason) => ipcRenderer.invoke('stems:job-cancel', jobId, reason),
    pauseStemJob: (jobId) => ipcRenderer.invoke('stems:job-pause', jobId),
    resumeStemJob: (jobId) => ipcRenderer.invoke('stems:job-resume', jobId),
    readStemJobStem: (jobId, stemId) => ipcRenderer.invoke('stems:job-stem', jobId, stemId),
    readStemJobMetadata: (jobId) => ipcRenderer.invoke('stems:job-metadata', jobId),
    onStemJobProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('stems:job-progress', listener);
      return () => ipcRenderer.removeListener('stems:job-progress', listener);
    },

    // --- High Quality extern (Google Drive + Colab-Worker, §15) ------------
    // Der Editor lädt die Arbeitskopie hoch, verfolgt den Job per Polling und
    // importiert das Ergebnis über denselben Stem-Lesepfad wie lokal. Google
    // Drive ist dabei reine Transportablage; die Zugangsdaten liegen im
    // Drive-Client des Nutzers (bzw. in rclone), nie in dieser App.
    remoteStatus: () => ipcRenderer.invoke('stems:remote-status'),
    startRemoteStemJob: (payload) => ipcRenderer.invoke('stems:remote-start', payload),
    listRemoteStemJobs: () => ipcRenderer.invoke('stems:remote-jobs'),
    pollRemoteStemJobs: () => ipcRenderer.invoke('stems:remote-poll'),
    cancelRemoteStemJob: (jobId, reason) => ipcRenderer.invoke('stems:remote-cancel', jobId, reason),
    resumeRemoteStemJobs: () => ipcRenderer.invoke('stems:remote-resume'),
    configureRemoteStemJobs: (settings) => ipcRenderer.invoke('stems:remote-configure', settings),
    onRemoteStemJobProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('stems:remote-progress', listener);
      return () => ipcRenderer.removeListener('stems:remote-progress', listener);
    },
  },

  // --- Diagnostics / logging bridge -----------------------------------------
  // Fire-and-forget batched log stream from the renderer. send() (not invoke)
  // so the message is handed to the main process even during page hide/unload.
  writeLogEntries: (entries) => ipcRenderer.send('logs:write', entries),
  getLogInfo: () => ipcRenderer.invoke('logs:get-info'),
  readLogTail: (maxBytes) => ipcRenderer.invoke('logs:read-tail', maxBytes),
  openLogFolder: () => ipcRenderer.invoke('logs:open-log-folder'),
  // One-click installation of the real AI engine. Installs exactly the model
  // chosen in the settings menu (options.modelId); without a modelId the
  // primary BS-RoFormer model is installed. Progress arrives via
  // onStemInstallProgress.
  installStemEngine: (options) => ipcRenderer.invoke('stems:install-engine', options || undefined),
  onStemInstallProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('stems:install-progress', listener);
    return () => ipcRenderer.removeListener('stems:install-progress', listener);
  },
});
