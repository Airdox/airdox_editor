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
      /**
       * Dateiablage der Desktop-App. Writes are accepted only for paths a human
       * confirmed in a save dialog (or a directory chosen in an open dialog).
       */
      chooseSavePath(options: {
        kind?: 'project' | 'wav' | 'xml' | 'text';
        suggestedName?: string;
        startDir?: string;
        title?: string;
      }): Promise<{ canceled: boolean; filePath?: string }>;
      writeFile(payload: {
        filePath: string;
        data: string;
        encoding?: 'utf8' | 'base64';
      }): Promise<{ filePath: string; bytes: number }>;
      writeMany(payload: {
        directory: string;
        files: Array<{ name: string; data: string; encoding?: 'utf8' | 'base64' }>;
      }): Promise<{ directory: string; written: Array<{ filePath: string; bytes: number }> }>;
      chooseOpenPath(options: {
        kind?: 'project' | 'wav' | 'xml' | 'text';
        startDir?: string;
        title?: string;
      }): Promise<{ canceled: boolean; filePath?: string }>;
      chooseDirectory(options?: {
        startDir?: string;
        title?: string;
      }): Promise<{ canceled: boolean; directory?: string }>;
      readTextFile(payload: { filePath: string }): Promise<{
        filePath: string;
        text: string;
        size: number;
        modifiedAt: number;
      }>;
      /** Which read engines are installed (native SQLCipher binding / pure JS). */
      describeDatabaseEngines(): Promise<RekordboxDatabaseEngines>;
      readRekordboxDatabase(dbPath: string): Promise<RekordboxDatabaseReadResult>;
    };
  }

  interface RekordboxDatabaseReadRow {
    [column: string]: string | number | null;
  }

  interface RekordboxDatabaseEngines {
    native: { available: boolean; note: string; reason: string | null };
    javascript: { available: boolean; note: string };
  }

  interface RekordboxDatabaseReadResult {
    available: boolean;
    reason?: string;
    dbType?: 'MASTER_DB' | 'ONE_LIBRARY';
    filePath?: string;
    fileName?: string;
    /** 'NATIVE_SQLCIPHER' or 'JS_SQLCIPHER' – the reader that produced the rows. */
    engine?: string;
    driver?: string;
    cipher?: string;
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
