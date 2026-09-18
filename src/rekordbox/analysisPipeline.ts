/**
 * Read-only Rekordbox track-analysis pipeline.
 *
 * This is deliberately independent from React and Electron.  The desktop
 * process resolves the database record and reads the exact sibling ANLZ files;
 * this module then decodes the immutable byte snapshots in deterministic
 * DAT → EXT → 2EX order.  Keeping this step pure makes the complete
 * master.db → AnalysisDataPath → ANLZ → waveform hand-off reproducible.
 */

import { AnlzExtractionResult, mergeAnlzExtractions, parseAnlzBinary } from './databaseExtractor';

export type RekordboxAnalysisFileKind = 'DAT' | 'EXT' | '2EX';
export type RekordboxAnalysisFileStatus = 'FOUND' | 'NOT_FOUND' | 'READ_ERROR' | 'NOT_REQUESTED';

export interface RekordboxAnalysisFileSnapshot {
  kind: RekordboxAnalysisFileKind;
  path?: string;
  status: RekordboxAnalysisFileStatus;
  size?: number;
  modifiedAt?: number;
  /** Immutable ArrayBuffer copied by Electron's read-only IPC handler. */
  data?: ArrayBuffer;
  reason?: string;
}

export interface RekordboxSchemaDiagnostic {
  tables: string[];
  columns: Record<string, string[]>;
  indexes: Record<string, string[]>;
  properties?: Record<string, string | number | null>;
  missingRequired?: string[];
}

/**
 * Contract returned by Electron for a selected `djmdContent.ID`.
 * `available` means the DB reference was resolved and at least one exact ANLZ
 * sibling was read; it does not claim a waveform was decoded.  The renderer
 * makes that latter decision from `decodeRekordboxAnalysisFiles`.
 */
export type RekordboxGateCode =
  | 'MASTER_DB_NOT_FOUND'
  | 'SQLCIPHER_UNAVAILABLE'
  | 'MASTER_DB_OPEN_FAILED'
  | 'MASTER_DB_SCHEMA_INVALID'
  | 'TRACK_NOT_FOUND_IN_MASTER_DB'
  | 'ANALYSIS_DATA_PATH_INVALID'
  | 'ANLZ_FILES_NOT_FOUND';

export interface RekordboxTrackAnalysisReadResult {
  available: boolean;
  /** Machine-readable failure classification. Undefined only when stage is COMPLETE. */
  code?: RekordboxGateCode;
  stage:
    | 'MASTER_DB'
    | 'SCHEMA'
    | 'TRACK'
    | 'ANALYSIS_DATA_PATH'
    | 'ANLZ_FILES'
    | 'COMPLETE';
  reason?: string;
  root: 'D:\\';
  masterDbPath: string;
  contentId: string;
  analysisDataPath?: string;
  resolvedAnalysisFile?: string;
  resolvedAnalysisDirectory?: string;
  audioPath?: string;
  schema?: RekordboxSchemaDiagnostic;
  files: RekordboxAnalysisFileSnapshot[];
  warnings: string[];
}

export interface DecodedRekordboxAnalysis {
  extraction?: AnlzExtractionResult;
  decodedFiles: RekordboxAnalysisFileSnapshot[];
  skippedFiles: RekordboxAnalysisFileSnapshot[];
  warnings: string[];
}

const FILE_ORDER: Record<RekordboxAnalysisFileKind, number> = {
  DAT: 0,
  EXT: 1,
  '2EX': 2,
};

/**
 * Decode only snapshots explicitly found by the native read-only resolver.
 * No path discovery, audio analysis, or metadata-generated waveform happens
 * here.  A valid ANLZ container without PWV/PWAV remains an honest
 * `extraction` without `waveform`.
 */
export function decodeRekordboxAnalysisFiles(
  files: RekordboxAnalysisFileSnapshot[]
): DecodedRekordboxAnalysis {
  const ordered = [...files].sort((a, b) => FILE_ORDER[a.kind] - FILE_ORDER[b.kind]);
  const decodedFiles: RekordboxAnalysisFileSnapshot[] = [];
  const skippedFiles: RekordboxAnalysisFileSnapshot[] = [];
  const warnings: string[] = [];
  let merged: AnlzExtractionResult | undefined;

  for (const file of ordered) {
    if (file.status !== 'FOUND' || !file.data || file.data.byteLength === 0) {
      skippedFiles.push(file);
      if (file.status !== 'NOT_FOUND') {
        warnings.push(`${file.kind}: ${file.reason || 'keine lesbaren ANLZ-Daten'}`);
      }
      continue;
    }

    try {
      const extraction = parseAnlzBinary(file.data);
      decodedFiles.push(file);
      warnings.push(...extraction.warnings.map((warning) => `${file.kind}: ${warning}`));
      merged = merged ? mergeAnlzExtractions(merged, extraction) : extraction;
    } catch (error) {
      // The native source stays untouched and a malformed sibling cannot hide
      // a valid DAT/EXT counterpart.
      skippedFiles.push({
        ...file,
        status: 'READ_ERROR',
        reason: error instanceof Error ? error.message : String(error),
      });
      warnings.push(`${file.kind}: ANLZ-Decoderfehler`);
    }
  }

  return { extraction: merged, decodedFiles, skippedFiles, warnings };
}

/** Pure race guard used by the deck selection path. */
export function isCurrentTrackAnalysisRequest(requestId: number, currentRequestId: number): boolean {
  return requestId === currentRequestId;
}
