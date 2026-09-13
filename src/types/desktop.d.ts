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
      cacheAnalysisMappings(mappings: RekordboxAnalysisPathMapping[]): Promise<{
        accepted: number;
        updated: number;
        rejected: number;
        total: number;
      }>;
      findAnalysisMapping(query: RekordboxAnalysisPathLookup): Promise<RekordboxAnalysisPathMapping | null>;
      getAnalysisMappingStats(): Promise<{ version: number; entries: number; filePath: string }>;
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
      getStemEngineStatus(): Promise<{
        available: boolean;
        python: string | null;
        model: string;
        weightsPresent: number;
        weightsRequired: number;
        weightsReady: boolean;
        reason?: string;
        details?: { version: number[]; executable: string; torch: string; torchaudio: string };
        probes: Array<{ command: string; usable: boolean; reason?: string }>;
      }>;
      separateStems(wavBytes: Uint8Array): Promise<{
        engine: 'demucs';
        model: string;
        stems: Record<'vocals' | 'drums' | 'bass' | 'other', Uint8Array>;
      }>;
      // --- Diagnostics / logging bridge ---
      writeLogEntries(entries: unknown[]): void;
      getLogInfo(): Promise<{
        sessionId: string;
        processName: string;
        logDirectory: string | null;
        currentFile: string | null;
        level: string;
        retentionDays: number;
        entriesWritten: number;
        platform?: string;
        pid?: number;
        userData?: string;
        isPackaged?: boolean;
      }>;
      readLogTail(maxBytes?: number): Promise<{ file: string | null; text: string }>;
      openLogFolder(): Promise<{ opened: boolean; target: string; logDirectory: string }>;
    };
  }

  interface RekordboxAnalysisPathLookup {
    trackId?: string;
    mediaPath?: string;
    sourceMediaPath?: string;
    title?: string;
    artist?: string;
  }

  interface RekordboxAnalysisPathMapping extends RekordboxAnalysisPathLookup {
    analysisPath: string;
    format?: 'DAT' | 'EXT' | '2EX' | 'ANLZ';
    size?: number;
    modifiedAt?: number;
    /** Duration of the unedited media timeline represented by the ANLZ file. */
    sourceDuration?: number;
    source?: string;
    observedAt?: number;
    matchScore?: number;
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
