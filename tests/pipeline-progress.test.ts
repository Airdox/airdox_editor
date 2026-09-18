/**
 * @license
 * Tests für src/rekordbox/pipelineProgress.ts – das Live-Popup-Modell der
 * Track-Ladepipeline (Testzwecke: sichtbar machen, welche Code-Abschnitte
 * bereits durchlaufen wurden).
 *
 * Der Status jeder Stufe darf ausschließlich aus echten Ergebnissen stammen
 * (Gate-Flags, Audio-/Analysis-Status) – diese Tests sichern ab, dass das
 * Modell keine Stufen erfindet oder überspringt.
 *
 * Run with: npx tsx tests/pipeline-progress.test.ts
 */

import assert from 'node:assert';
import {
  PIPELINE_STAGE_ORDER,
  GATE_STAGE_IDS,
  createPipelineStages,
  setPipelineStage,
  setPipelineStages,
  applyGateResultToStages,
  pipelinePercent,
  pipelineIsFinished,
  PipelineStageId,
  PipelineStageState,
} from '../src/rekordbox/pipelineProgress';
import type { MasterDbGateResult } from '../src/rekordbox/masterDbPipeline';

function stage(stages: PipelineStageState[], id: PipelineStageId): PipelineStageState {
  const found = stages.find((s) => s.id === id);
  assert.ok(found, `Stufe ${id} muss existieren`);
  return found;
}

const okGate: MasterDbGateResult = {
  ok: true,
  source: 'rekordbox-master-db',
  sqlcipher: true,
  masterDbFound: true,
  sqlcipherAvailable: true,
  databaseOpened: true,
  schemaValidated: true,
  trackQueryExecuted: true,
  trackFound: true,
  dbPath: 'D:\\Pioneer\\rekordbox7\\master.db',
  dbType: 'MASTER_DB',
  matchedBy: 'TRACK_ID',
  trackId: '4711',
  track: {} as never,
};

function failGate(flags: Partial<Record<string, boolean>>, reason: string): MasterDbGateResult {
  return {
    ok: false,
    source: 'rekordbox-master-db',
    errorCode: 'MASTER_DB_OPEN_FAILED',
    reason,
    masterDbFound: flags.masterDbFound ?? false,
    sqlcipherAvailable: flags.sqlcipherAvailable ?? false,
    databaseOpened: flags.databaseOpened ?? false,
    schemaValidated: flags.schemaValidated ?? false,
    trackQueryExecuted: flags.trackQueryExecuted ?? false,
    trackFound: flags.trackFound ?? false,
    dbPath: flags.masterDbFound ? 'D:\\Pioneer\\rekordbox7\\master.db' : undefined,
  };
}

// ─── Grundstruktur ──────────────────────────────────────────────────────────
const initial = createPipelineStages();
assert.deepStrictEqual(
  initial.map((s) => s.id),
  PIPELINE_STAGE_ORDER,
  'Reihenfolge der Stufen ist fest definiert (XML/Quelle → Master DB → Audio → Wellenform)'
);
assert.ok(initial.every((s) => s.status === 'PENDING'), 'alle Stufen starten als PENDING');
assert.ok(initial.every((s) => typeof s.label === 'string' && s.label.length > 0), 'jede Stufe hat ein Label');
assert.strictEqual(pipelinePercent(initial), 0, 'frische Pipeline: 0%');
assert.strictEqual(pipelineIsFinished(initial), false, 'frische Pipeline: nicht fertig');

// ─── Einzelne Stufen setzen ─────────────────────────────────────────────────
const withRunning = setPipelineStage(initial, 'MASTER_DB_LOCATED', 'RUNNING');
assert.strictEqual(stage(withRunning, 'MASTER_DB_LOCATED').status, 'RUNNING');
assert.strictEqual(stage(initial, 'MASTER_DB_LOCATED').status, 'PENDING', 'unveränderliche Basis bleibt erhalten');

const withDetail = setPipelineStage(withRunning, 'MASTER_DB_LOCATED', 'DONE', 'D:\\db\\master.db');
assert.strictEqual(stage(withDetail, 'MASTER_DB_LOCATED').detail, 'D:\\db\\master.db');
const keepDetail = setPipelineStage(withDetail, 'MASTER_DB_LOCATED', 'DONE');
assert.strictEqual(stage(keepDetail, 'MASTER_DB_LOCATED').detail, 'D:\\db\\master.db', 'Detail bleibt ohne neues Detail erhalten');

const bulk = setPipelineStages(initial, GATE_STAGE_IDS, 'SKIPPED', 'Browser-Modus');
for (const id of GATE_STAGE_IDS) {
  assert.strictEqual(stage(bulk, id).status, 'SKIPPED', `Bulk-Update setzt ${id}`);
  assert.strictEqual(stage(bulk, id).detail, 'Browser-Modus');
}
assert.strictEqual(stage(bulk, 'SOURCE_PARSED').status, 'PENDING', 'Bulk-Update trifft nur genannte Stufen');

// ─── Gate-Ergebnis → Stufen (Erfolg) ────────────────────────────────────────
const afterOk = applyGateResultToStages(initial, okGate);
for (const id of GATE_STAGE_IDS) {
  assert.strictEqual(stage(afterOk, id).status, 'DONE', `erfolgreiches Gate: ${id} ist DONE`);
}
assert.ok(stage(afterOk, 'MASTER_DB_LOCATED').detail?.includes('master.db'), 'DB-Pfad wird im Detail sichtbar');
assert.ok(stage(afterOk, 'TRACK_DATA_READ').detail?.includes('TRACK_ID'), 'matchedBy wird im Detail sichtbar');
assert.strictEqual(stage(afterOk, 'DECK_TRACK_BUILT').status, 'PENDING', 'nachgelagerte Stufen bleiben unberührt');

// ─── Gate-Ergebnis → Stufen (Fehler mitten in der Kette) ───────────────────
const openFailed = applyGateResultToStages(
  initial,
  failGate(
    { masterDbFound: true, sqlcipherAvailable: true, databaseOpened: false },
    'Entschlüsselung fehlgeschlagen'
  )
);
assert.strictEqual(stage(openFailed, 'MASTER_DB_LOCATED').status, 'DONE', 'Stufen vor dem Fehler sind durchlaufen');
assert.strictEqual(stage(openFailed, 'SQLCIPHER_READY').status, 'DONE');
assert.strictEqual(stage(openFailed, 'MASTER_DB_OPENED').status, 'FAILED', 'die erste false-Flagge ist FAILED');
assert.strictEqual(stage(openFailed, 'MASTER_DB_OPENED').detail, 'Entschlüsselung fehlgeschlagen', 'Fehlergrund sichtbar');
assert.strictEqual(stage(openFailed, 'SCHEMA_VALIDATED').status, 'PENDING', 'Stufen nach dem Fehler bleiben PENDING');
assert.strictEqual(stage(openFailed, 'TRACK_QUERY').status, 'PENDING');
assert.strictEqual(stage(openFailed, 'TRACK_DATA_READ').status, 'PENDING');
assert.ok(stage(openFailed, 'MASTER_DB_LOCATED').detail?.includes('master.db'), 'geprüfter Pfad bleibt sichtbar');

// Fehler gleich zu Beginn (DB nicht gefunden).
const notFound = applyGateResultToStages(
  initial,
  failGate({}, 'Die Rekordbox Master Database wurde nicht gefunden.')
);
assert.strictEqual(stage(notFound, 'MASTER_DB_LOCATED').status, 'FAILED', 'erste Stufe scheitert');
assert.ok(stage(notFound, 'MASTER_DB_LOCATED').detail?.includes('nicht gefunden'), 'Fehlergrund sichtbar');
for (const id of GATE_STAGE_IDS.slice(1)) {
  assert.strictEqual(stage(notFound, id).status, 'PENDING', `nach DB-Fehler bleibt ${id} PENDING`);
}

// Track in geöffneter DB nicht gefunden.
const trackMissing = applyGateResultToStages(
  initial,
  failGate(
    {
      masterDbFound: true,
      sqlcipherAvailable: true,
      databaseOpened: true,
      schemaValidated: true,
      trackQueryExecuted: true,
      trackFound: false,
    },
    'Der Track konnte in der Master Database nicht gefunden werden.'
  )
);
assert.strictEqual(stage(trackMissing, 'TRACK_QUERY').status, 'DONE', 'Query lief');
assert.strictEqual(stage(trackMissing, 'TRACK_DATA_READ').status, 'FAILED', 'Track-Stufe scheitert');

// ─── Fortschritt & Fertig-Zustand ───────────────────────────────────────────
let progress = setPipelineStage(afterOk, 'SOURCE_PARSED', 'DONE');
progress = setPipelineStage(progress, 'DECK_TRACK_BUILT', 'DONE');
progress = setPipelineStage(progress, 'ORIGINAL_AUDIO_READ', 'DONE');
progress = setPipelineStage(progress, 'WAVEFORM_ANALYSIS', 'DONE');
assert.strictEqual(pipelinePercent(progress), Math.round((10 / 11) * 100), '10 von 11 Stufen durchlaufen');
assert.strictEqual(pipelineIsFinished(progress), false, 'COMPLETE-Stufe steht noch aus → nicht fertig');

const complete = setPipelineStage(progress, 'COMPLETE', 'DONE');
assert.strictEqual(pipelinePercent(complete), 100, 'alle Stufen durchlaufen → 100%');
assert.strictEqual(pipelineIsFinished(complete), true, 'Pipeline fertig');

assert.strictEqual(pipelineIsFinished(openFailed), true, 'FAILED-Stufe stoppt die Pipeline (angehalten)');

console.log('✔ pipeline-progress: Stufenmodell, Gate-Abbildung und Fortschritt verifiziert');
