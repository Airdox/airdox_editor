export {};

declare global {
  interface Window {
    rekordboxDesktop?: {
      inspectLocation(location: string): Promise<{
        validLocation: boolean;
        exists: boolean;
        path?: string;
        size?: number | null;
        modifiedAt?: number;
        reason?: string;
        accessMode: 'READ_ONLY';
      }>;
      readOriginalAudio(location: string): Promise<{
        data: ArrayBuffer;
        path: string;
        size: number;
        modifiedAt: number;
        accessMode: 'READ_ONLY';
      }>;
      chooseAnalysisFile(): Promise<{ path: string; accessMode: 'READ_ONLY' } | null>;
      readAnalysisFile(filePath: string): Promise<{
        data: ArrayBuffer;
        path: string;
        size: number;
        modifiedAt: number;
        accessMode: 'READ_ONLY';
      }>;
      chooseRekordboxDatabase(): Promise<{ path: string; accessMode: 'READ_ONLY' } | null>;
      locateRekordboxDatabases(): Promise<
        Array<{ path: string; kind: 'MASTER_DB' | 'ONE_LIBRARY'; label: string }>
      >;
      readRekordboxDatabase(dbPath: string): Promise<RekordboxDatabaseReadResult>;
      /** Verbindliches Master-DB-/SQLCipher-Gate für einen einzelnen Track. */
      resolveTrackFromMasterDb(request: {
        dbPath?: string;
        trackId?: string | number;
        audioPath?: string;
        location?: string;
      }): Promise<unknown>;
      saveExportFile(payload: {
        kind: 'WAV' | 'XML' | 'JSON' | 'PROJECT';
        data: Uint8Array;
        defaultName: string;
        protectedPaths?: string[];
      }): Promise<{ saved: boolean; path?: string; bytes?: number; accessMode?: 'WRITE_NEW_ONLY' }>;
      openProjectFile(): Promise<{
        data: string;
        path: string;
        size: number;
        modifiedAt: number;
        accessMode: 'READ_ONLY';
      } | null>;
      /**
       * Externe, trainierte Stem-Separation (audio-separator CLI).
       * Liefert die absoluten Pfade der in diesem Lauf erzeugten WAV-Dateien.
       */
      separateStems(
        inputFilePath: string,
        options?: { modelFilename?: string; chunkDuration?: number; extraArgs?: string[] }
      ): Promise<string[]>;
      /** Verfügbarkeit des externen Separators – entscheidet, ob die interne Heuristik einspringt. */
      separatorStatus?(options?: { force?: boolean }): Promise<DesktopSeparatorStatus | null>;
      /** Bricht laufende externe Separationen ab (ohne jobId: alle). */
      cancelStemSeparation?(jobId?: string): Promise<{ cancelled: number }>;
      /** Progress-Stream der externen Separation; gibt eine Abmeldefunktion zurück. */
      onStemSeparationProgress?(listener: (payload: DesktopStemProgress) => void): () => void;
      /** Modell-Gewichte: Ist-Zustand des Modell-Ordners zum übergebenen Katalog. */
      listStemModels?(catalog: readonly unknown[]): Promise<DesktopStemModelListResult | null>;
      /** Von der Separator-CLI gemeldete Modell-Liste (inkl. Stem-Namen). */
      fetchStemModelCatalog?(options?: { force?: boolean }): Promise<DesktopRuntimeCatalogResult | null>;
      /** Direkt-Download von Gewichten (nur HTTPS, mit Prüfsummen-Check). */
      downloadStemModel?(model: DesktopStemModelRequest): Promise<{ ok: boolean; fileName: string; filePath: string; sizeBytes: number; sha256?: string }>;
      cancelStemModelDownload?(fileName?: string): Promise<{ cancelled: number }>;
      removeStemModel?(fileName: string): Promise<{ removed: string }>;
      /** Eigene Checkpoints (z. B. aus Colab) in den Modell-Ordner kopieren. */
      importStemModels?(): Promise<{ imported: { fileName: string; filePath: string; sizeBytes: number }[]; failures: { filePath: string; message: string }[] }>;
      openStemModelFolder?(): Promise<{ path: string }>;
      onStemModelProgress?(listener: (payload: DesktopModelProgress) => void): () => void;
      appendLog(entry: { ts?: number; timestamp?: string | number; level: string; category?: string; scope?: string; message: string; data?: unknown }): Promise<boolean>;
      getLogFilePath(): Promise<string | null>;
    };
  }

  /** Modell-Auswahl, wie sie der Renderer aus dem Katalog übergibt. */
  interface DesktopStemModelRequest {
    id?: string | null;
    fileName: string;
    label?: string;
    downloadUrl?: string | null;
    sha256?: string | null;
    expectedSizeBytes?: number | null;
  }

  interface DesktopStemModelEntry {
    id: string;
    label: string;
    fileName: string | null;
    architecture: string;
    stemOrder: string[] | null;
    trainedModel: boolean;
    requiresExternalRuntime: boolean;
    recommended: boolean;
    qualityHint: string;
    license: string | null;
    downloadUrl: string | null;
    approximateSizeMb: number | null;
    profile: 'PREVIEW' | 'HIGH_QUALITY';
    installed: boolean;
    downloading: boolean;
    localPath: string | null;
    sizeBytes: number | null;
    sha256: string | null;
    source: string | null;
    delegateToRuntime: boolean;
  }

  interface DesktopStemModelListResult {
    modelDir: string;
    models: DesktopStemModelEntry[];
    installedCount: number;
  }

  interface DesktopRuntimeModelInfo {
    fileName: string;
    stemNames?: string[];
    architecture?: string;
    modelSize?: number;
    trainable?: boolean;
  }

  interface DesktopRuntimeCatalogResult {
    available: boolean;
    command?: string | null;
    reason?: string;
    hint?: string;
    models: DesktopRuntimeModelInfo[];
    fetchedAt: number;
  }

  interface DesktopModelProgress {
    fileName: string;
    phase: 'connect' | 'download' | 'verify' | 'done' | 'failed';
    transferredBytes: number;
    totalBytes: number;
    ratio: number | null;
    message: string;
    code?: string;
  }

  interface DesktopSeparatorStatus {
    available: boolean;
    command?: string | null;
    source?: 'env' | 'python-scripts' | 'path' | null;
    reason?: string;
    hint?: string;
  }

  interface DesktopStemProgress {
    jobId: string;
    phase: 'start' | 'running' | 'done' | 'failed';
    ratio: number | null;
    message: string;
    code?: string;
    stems?: string[];
    outputDir?: string;
    durationMs?: number;
  }

  interface RekordboxDatabaseReadRow {
    [column: string]: string | number | null;
  }

  interface RekordboxDatabaseReadResult {
    available: boolean;
    reason?: string;
    dbType?: 'MASTER_DB' | 'ONE_LIBRARY';
    filePath?: string;
    fileName?: string;
    stats?: { tracks: number; cues: number; playlists: number };
    warnings?: string[];
    rows?: {
      content: RekordboxDatabaseReadRow[];
      cues: RekordboxDatabaseReadRow[];
      artists: RekordboxDatabaseReadRow[];
      albums: RekordboxDatabaseReadRow[];
      genres: RekordboxDatabaseReadRow[];
      keys: RekordboxDatabaseReadRow[];
      labels: RekordboxDatabaseReadRow[];
      playlists: RekordboxDatabaseReadRow[];
      songPlaylists: RekordboxDatabaseReadRow[];
    };
  }
}
