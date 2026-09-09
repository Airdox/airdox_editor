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
        /** Binary payload: Uint8Array over IPC (Buffer), ArrayBuffer in mocks. Normalize with ensureArrayBuffer. */
        data: ArrayBuffer | Uint8Array;
        path: string;
        size: number;
        modifiedAt: number;
        accessMode: 'READ_ONLY';
      }>;
      chooseAnalysisFile(): Promise<{ path: string; accessMode: 'READ_ONLY' } | null>;
      readAnalysisFile(filePath: string): Promise<{
        /** Binary payload: Uint8Array over IPC (Buffer), ArrayBuffer in mocks. Normalize with ensureArrayBuffer. */
        data: ArrayBuffer | Uint8Array;
        path: string;
        size: number;
        modifiedAt: number;
        accessMode: 'READ_ONLY';
      }>;
      /** Durable diagnostic log: appends one structured entry to the desktop log file (append-only, never throws). */
      appendLog(entry: {
        ts?: number;
        level?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
        category?: string;
        message: string;
        data?: unknown;
      }): Promise<boolean>;
      /** Absolute path of the durable desktop log file (null when unavailable). */
      getLogFilePath(): Promise<string | null>;
      /** Reveals the durable desktop log file in the OS file manager. */
      revealLogFile(): Promise<boolean>;
      chooseRekordboxDatabase(): Promise<{ path: string; accessMode: 'READ_ONLY' } | null>;
      locateRekordboxDatabases(): Promise<
        Array<{ path: string; kind: 'MASTER_DB' | 'ONE_LIBRARY'; label: string; appVer?: string | null }>
      >;
      readRekordboxDatabase(dbPath: string): Promise<RekordboxDatabaseReadResult>;
      /**
       * Deterministic ANLZ lookup without SQLCipher: reads the PPTH header of
       * every ANLZ container in the standard Rekordbox analysis folders and
       * returns exact audio-path matches (DAT + EXT pair). Read-only.
       */
      scanAnlzPaths(targetPaths: string[]): Promise<{
        /**
         * matchTier 1 = exact PPTH path match; matchTier 2 = unique basename
         * match (file moved after analysis – must be verified by the user).
         */
        matches: Array<{ path: string; datPath: string | null; extPath: string | null; matchTier: 1 | 2; note?: string }>;
        scanned: number;
        folders: string[];
        elapsedMs: number;
        ppthSample?: string[];
        /** True when the recursive scan hit a safety bound (depth/file count). */
        truncated?: boolean;
      }>;
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
    };
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
