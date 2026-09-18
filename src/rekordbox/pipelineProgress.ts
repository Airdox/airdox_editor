/**
 * @license
 * Live-Fortschritt der Track-Ladepipeline (Renderer).
 *
 * Zu Testzwecken wird beim Laden eines Tracks in einem Popup sichtbar
 * gemacht, welche Code-Abschnitte bereits durchlaufen wurden:
 *
 *   XML/DB-Quelle ausgelesen → Master DB gefunden → SQLCipher verfügbar →
 *   Master DB geöffnet (read-only) → Schema validiert → Track-Query →
 *   Trackdaten gelesen → Deck-Track gebaut → Originalaudio geöffnet →
 *   Wellenform-/Analysis-Daten gelesen → Deck bereit
 *
 * Die Stufen werden NICHT animiert oder erfunden: Der Status jeder Stufe
 * stammt ausschließlich aus echten Ergebnissen (Flags des Master-DB-Gates,
 * Audio-/Analysis-Ergebnisse). Diese Datei ist rein und ohne React testbar.
 */

import type { MasterDbGateResult } from './masterDbPipeline';

export type PipelineStageId =
  | 'SOURCE_PARSED'
  | 'MASTER_DB_LOCATED'
  | 'SQLCIPHER_READY'
  | 'MASTER_DB_OPENED'
  | 'SCHEMA_VALIDATED'
  | 'TRACK_QUERY'
  | 'TRACK_DATA_READ'
  | 'DECK_TRACK_BUILT'
  | 'ORIGINAL_AUDIO_READ'
  | 'WAVEFORM_ANALYSIS'
  | 'COMPLETE';

export type PipelineStageStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';

export interface PipelineStageState {
  id: PipelineStageId;
  label: string;
  status: PipelineStageStatus;
  detail?: string;
}

/** Feste Reihenfolge der Code-Abschnitte während des Ladens. */
export const PIPELINE_STAGE_ORDER: PipelineStageId[] = [
  'SOURCE_PARSED',
  'MASTER_DB_LOCATED',
  'SQLCIPHER_READY',
  'MASTER_DB_OPENED',
  'SCHEMA_VALIDATED',
  'TRACK_QUERY',
  'TRACK_DATA_READ',
  'DECK_TRACK_BUILT',
  'ORIGINAL_AUDIO_READ',
  'WAVEFORM_ANALYSIS',
  'COMPLETE',
];

const STAGE_LABELS: Record<PipelineStageId, string> = {
  SOURCE_PARSED: 'Quelle ausgelesen (XML / Datenbank-Eintrag)',
  MASTER_DB_LOCATED: 'Master DB ermitteln (master.db / exportLibrary.db)',
  SQLCIPHER_READY: 'SQLCipher initialisieren',
  MASTER_DB_OPENED: 'Master DB öffnen (nur lesend)',
  SCHEMA_VALIDATED: 'Datenbankschema validieren',
  TRACK_QUERY: 'Track in der Master DB suchen',
  TRACK_DATA_READ: 'Trackdaten lesen (Metadaten & Cues)',
  DECK_TRACK_BUILT: 'Deck-Track aus Master-DB-Daten bauen',
  ORIGINAL_AUDIO_READ: 'Originalaudio öffnen (nur lesend)',
  WAVEFORM_ANALYSIS: 'Wellenform-/Analysis-Daten lesen (ANLZ)',
  COMPLETE: 'Deck bereit',
};

export function createPipelineStages(): PipelineStageState[] {
  return PIPELINE_STAGE_ORDER.map((id) => ({
    id,
    label: STAGE_LABELS[id],
    status: 'PENDING' as PipelineStageStatus,
  }));
}

/** Setzt den Status (und optional das Detail) einer einzelnen Stufe. */
export function setPipelineStage(
  stages: PipelineStageState[],
  id: PipelineStageId,
  status: PipelineStageStatus,
  detail?: string
): PipelineStageState[] {
  return stages.map((stage) =>
    stage.id === id ? { ...stage, status, detail: detail !== undefined ? detail : stage.detail } : stage
  );
}

/** Mehrere Stufen in einem Zug auf denselben Status setzen. */
export function setPipelineStages(
  stages: PipelineStageState[],
  ids: PipelineStageId[],
  status: PipelineStageStatus,
  detail?: string
): PipelineStageState[] {
  return ids.reduce((acc, id) => setPipelineStage(acc, id, status, detail), stages);
}

/** Die sechs Gate-Stufen in ihrer Reihenfolge. */
export const GATE_STAGE_IDS: PipelineStageId[] = [
  'MASTER_DB_LOCATED',
  'SQLCIPHER_READY',
  'MASTER_DB_OPENED',
  'SCHEMA_VALIDATED',
  'TRACK_QUERY',
  'TRACK_DATA_READ',
];

/**
 * Bildet ein Master-DB-Gate-Ergebnis auf die Stufen ab – faktenbasiert aus
 * den zurückgelieferten Flags. Alle Stufen bis zur ersten fehlgeschlagenen
 * Flagge gelten als durchlaufen (DONE), die erste false-Flagge als FAILED,
 * alle danach bleiben PENDING.
 */
export function applyGateResultToStages(
  stages: PipelineStageState[],
  gate: MasterDbGateResult
): PipelineStageState[] {
  const flags = [
    gate.masterDbFound,
    gate.sqlcipherAvailable,
    gate.databaseOpened,
    gate.schemaValidated,
    gate.trackQueryExecuted,
    gate.trackFound,
  ];
  const failedIndex = flags.findIndex((flag) => flag !== true);
  // Hinweis: `gate.ok === false` verwenden – die bloße Negation (`!gate.ok`)
  // narrowt diese Diskriminant-Union im aktuellen TS-Setup nicht.
  const failReason = gate.ok === false ? gate.reason : '';

  let next = stages;
  for (let i = 0; i < GATE_STAGE_IDS.length; i += 1) {
    const id = GATE_STAGE_IDS[i];
    if (failedIndex === -1 || i < failedIndex) {
      next = setPipelineStage(next, id, 'DONE');
    } else if (i === failedIndex) {
      next = setPipelineStage(next, id, 'FAILED', failReason);
    } else {
      next = setPipelineStage(next, id, 'PENDING');
    }
  }

  if (gate.ok) {
    if (gate.dbPath) {
      next = setPipelineStage(next, 'MASTER_DB_LOCATED', 'DONE', `${gate.dbPath} (${gate.dbType})`);
    }
    next = setPipelineStage(next, 'TRACK_DATA_READ', 'DONE', `Track gefunden (matchedBy=${gate.matchedBy})`);
  } else if (gate.dbPath) {
    // Zeige den geprüften Pfad bei der Suchstufe an (erfolgreich oder nicht).
    next = setPipelineStage(
      next,
      'MASTER_DB_LOCATED',
      gate.masterDbFound ? 'DONE' : 'FAILED',
      gate.dbPath
    );
  }

  return next;
}

/** Fortschritt in Prozent (DONE/SKIPPED/FAILED gelten als durchlaufen). */
export function pipelinePercent(stages: PipelineStageState[]): number {
  if (stages.length === 0) return 0;
  const passed = stages.filter((s) => s.status !== 'PENDING' && s.status !== 'RUNNING').length;
  return Math.round((passed / stages.length) * 100);
}

/**
 * True, sobald keine weitere Stufe mehr kommen kann: entweder ist alles
 * durchlaufen (DONE/SKIPPED) oder eine Stufe ist fehlgeschlagen (Stopp).
 */
export function pipelineIsFinished(stages: PipelineStageState[]): boolean {
  if (stages.length === 0) return false;
  if (stages.some((s) => s.status === 'FAILED')) return true;
  return stages.every((s) => s.status === 'DONE' || s.status === 'SKIPPED');
}
