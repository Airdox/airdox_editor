export {};

import type { StemDesktopApi } from '../stems/transportTypes';

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
      /**
       * Phase 5 – verbindlicher Master-DB-Gate für den Track-Lade-Pfad:
       * TrackID → djmdContent → AnalysisDataPath → ANLZ → Original-Audio,
       * ausschließlich lesend. `ok: false` bedeutet harter Verzicht – der
       * Renderer darf in diesem Fall keine Ersatz-Waveform erzeugen.
       */
      resolveTrackFromMasterDb(query: RekordboxTrackGateQuery): Promise<RekordboxTrackGateResult>;
      /**
       * Liefert die app-eigene `rekordbox_export2.xml` (kein Benutzerdatei-
       * dialog): im Paket als Ressource, im Entwicklungsmodus aus dem Repo.
       */
      readBundledRekordboxXml(): Promise<RekordboxBundledXmlResult>;
      cacheAnalysisMappings(mappings: RekordboxAnalysisPathMapping[]): Promise<{
        accepted: number;
        updated: number;
        rejected: number;
        total: number;
      }>;
      findAnalysisMapping(query: RekordboxAnalysisPathLookup): Promise<RekordboxAnalysisPathMapping | null>;
      getAnalysisMappingStats(): Promise<{ version: number; entries: number; filePath: string }>;
      saveExportFile(payload: {
        kind: 'WAV' | 'AUDIO' | 'XML' | 'JSON' | 'PROJECT';
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
      chooseDirectory(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
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
      /**
       * Job-basierte Stem-Engine (`src/stems`) – Profilwahl, Cache,
       * Job-Metadaten, Abbruch/Pause. Optional: im Browser gibt es diesen
       * Zweig nicht, dort übernimmt der HTTP-Transport (server.ts) mit
       * demselben Vertrag.
       */
      stemEngine?: StemDesktopApi;
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
      getStemDiagnostics(): Promise<Record<string, unknown>>;
      getStemPreflight(): Promise<Record<string, unknown>>;
      /**
       * Installs the AI model selected in the settings menu
       * (`options.modelId`). Without `modelId` the primary BS-RoFormer
       * model is installed (legacy one-click behavior).
       */
      installStemEngine(options?: { modelId?: string }): Promise<{
        ok: boolean;
        error?: string;
        python?: string;
        model?: string;
        modelDir?: string;
        weightsReady?: boolean;
        restartRequired?: boolean;
      }>;
      onStemInstallProgress(
        callback: (progress: StemInstallProgress) => void
      ): () => void;
    };
  }

  interface StemInstallProgress {
    step: number;
    totalSteps: number;
    percent: number;
    label: string;
    logLine?: string;
  }

  interface RekordboxAnalysisPathLookup {
    trackId?: string;
    mediaPath?: string;
    sourceMediaPath?: string;
    title?: string;
    artist?: string;
    /** Refuse ID/title/artist fallback; require normalized original-media-path equality. */
    requireExactMediaPath?: boolean;
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

  /** Zustandsmaschine des Master-DB-Gates (electron/masterDbGate.cjs). */
  type RekordboxTrackGateCode =
    | 'OK'
    | 'MASTER_DB_NOT_FOUND'
    | 'SQLCIPHER_UNAVAILABLE'
    | 'MASTER_DB_OPEN_FAILED'
    | 'MASTER_DB_SCHEMA_INVALID'
    | 'TRACK_NOT_FOUND_IN_MASTER_DB'
    | 'ANLZ_NOT_FOUND'
    | 'ANLZ_READ_FAILED'
    | 'ANLZ_INVALID'
    | 'REKORDBOX_WAVEFORM_MISSING'
    | 'ORIGINAL_AUDIO_NOT_FOUND';

  interface RekordboxTrackGateQuery {
    /** TrackID aus der eingebetteten rekordbox_export2.xml (= djmdContent.ID). */
    trackId: string;
    /** XML `Location` des Original-Audios (file://-URL oder lokaler Pfad). */
    mediaPath?: string;
    title?: string;
    artist?: string;
  }

  interface RekordboxTrackGateResult {
    ok: boolean;
    code: RekordboxTrackGateCode;
    reason?: string;
    dbPath?: string;
    dbType?: 'MASTER_DB' | 'ONE_LIBRARY';
    content?: {
      id: string;
      title?: string;
      folderPath?: string;
      fileName?: string;
      analysisDataPath?: string;
      originalPath?: string;
    };
    analysis?: {
      path: string;
      size: number;
      modifiedAt: number;
      /** Gelesene ANLZ-Sektionstags (PMAI/PPTH/PQTZ/.../PWV*). */
      tags: string[];
      hasWaveform: boolean;
      truncated?: boolean;
    };
    original?: {
      path: string;
      /** Woher der Pfad stammt: XML-Location, master.db oder ANLZ-PPTH. */
      source: 'XML_LOCATION' | 'MASTER_DB' | 'ANLZ_PPTH';
      xmlLocation?: string;
      databasePath?: string;
      size: number;
      modifiedAt: number;
    };
    /** djmdCue-/cue-Rows des Datensatzes (best effort, max. 512). */
    cues?: RekordboxDatabaseReadRow[];
  }

  interface RekordboxBundledXmlResult {
    available: boolean;
    data?: string;
    path?: string;
    size?: number;
    modifiedAt?: number;
    reason?: string;
    accessMode: 'READ_ONLY';
  }
}
