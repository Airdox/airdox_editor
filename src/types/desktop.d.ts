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
      separateStems(payload: string | { inputFilePath: string; jobId?: string; usePipelineDouble?: boolean }): Promise<DesktopSeparationResponse>;
      stemsPreflight(): Promise<{ available: boolean; version?: string; reason?: string; command: string; defaultModel: string }>;
      cancelStems(jobId: string): Promise<boolean>;
      onStemsProgress(handler: (payload: { jobId: string; phase: string; detail?: string; percent?: number }) => void): () => void;
      appendLog(entry: { ts?: number; timestamp?: string | number; level: string; category?: string; scope?: string; message: string; data?: unknown }): Promise<boolean>;
      getLogFilePath(): Promise<string | null>;
    };
  }

  interface DesktopStemResult {
    id: string;
    filePath: string;
    sampleRate: number;
    channels: number;
    frames: number;
  }

  interface DesktopSeparationResponse {
    status: 'COMPLETED' | 'CANCELLED' | 'FAILED';
    stems: DesktopStemResult[];
    jobId: string;
    modelId?: string;
    fromTrainedModel?: boolean;
    originalUnchanged?: boolean;
    durationMs?: number;
    error?: { code: string; message: string };
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
