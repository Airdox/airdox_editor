/**
 * Statusfenster des Fernpfads – Rendernachweis (§40).
 *
 * Der Laufzettel ist die Antwort auf „ich sehe nur 0 %“. Ein Fenster, das
 * beim Rendern umfällt, ist schlimmer als gar keins – deshalb wird die
 * Komponente hier serverseitig gerendert (`react-dom/server`), genau wie der
 * Rauchtest der Gesamtoberfläche.
 *
 * Geprüft wird die Zusicherung, die der Nutzer im Fenster lesen können muss:
 *  - **alle** Stationen stehen drin, mit Ort und Zustand,
 *  - die nicht messbare Station sagt, dass sie nicht messbar ist,
 *  - die Bestätigung ist als Bestätigung erkennbar, nicht als Messung.
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { RemoteFlowModal } from '../src/components/Modals/RemoteFlowModal';
import { REMOTE_FLOW_STATIONS, REMOTE_FLOW_TITLES, buildRemoteDataFlow } from '../src/stems/remote/dataFlow';
import type { RemoteJobRecord } from '../src/stems/remote/types';
import type { RemoteServiceStatus, RemoteStemJobView } from '../src/stems/transportTypes';
import { PREVIEW_SCENARIOS, type FlowPreviewScenarioId } from '../src/flowPreviewScenarios';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  STATUSFENSTER: LAUFZETTEL RENDERT VOLLSTÄNDIG                     ');
console.log('═══════════════════════════════════════════════════════════════════');

const JOB_ID = '915db325-a297-40a8-94e8-fa7137f14f94';

function record(overrides: Partial<RemoteJobRecord> = {}): RemoteJobRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    createdAt: now - 9 * 60_000,
    updatedAt: now - 5_000,
    phaseUpdatedAt: now - 8 * 60_000,
    status: 'RUNNING',
    phase: 'Wartet auf den externen Rechner (Google Drive)',
    percent: 0,
    trackName: 'nightdrive_extended_mix',
    profile: 'HIGH_QUALITY',
    modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
    family: 'bs_roformer',
    backend: 'bs_roformer',
    stems: ['vocals', 'drums', 'bass', 'other'],
    idempotencyKey: 'render-key',
    workingCopyPath: '/engine/Working/nightdrive.wav',
    workingCopySha256: 'a'.repeat(64),
    workingCopyBytes: 104_857_600,
    durationSeconds: 352,
    sampleRate: 44100,
    channels: 2,
    transportErrors: 0,
    transportLabel: 'Google Drive (Ordner)',
    uploadedAt: now - 8 * 60_000,
    ...overrides,
  };
}

function view(record: RemoteJobRecord): RemoteStemJobView {
  return {
    jobId: record.jobId,
    status: record.status,
    phase: record.phase,
    percent: record.percent,
    profile: record.profile,
    modelId: record.modelId,
    family: record.family,
    backend: record.backend,
    stems: record.stems,
    trackName: record.trackName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    phaseUpdatedAt: record.phaseUpdatedAt,
    transportLabel: record.transportLabel,
    flow: buildRemoteDataFlow(record, { now: Date.now(), worker: null, transportLabel: record.transportLabel }),
  };
}

const status: RemoteServiceStatus = {
  configured: true,
  label: 'Google Drive (Ordner)',
  root: 'C:/Users/dj/Google Drive/airdox-stem-jobs',
  reachable: true,
  jobs: [],
  active: 1,
  completed: 0,
  failed: 0,
  pollIntervalMs: 15_000,
  worker: null,
};

function render(job: RemoteStemJobView): string {
  return renderToString(
    React.createElement(RemoteFlowModal, {
      open: true,
      onClose: () => undefined,
      onCancel: () => undefined,
      onRefresh: () => undefined,
      onConfirmCloudSync: () => undefined,
      status,
      job,
      trackName: 'Nightdrive (Extended Mix)',
      running: true,
      error: null,
    })
  );
}

// 1. Der wartende Lauf: alle Stationen, der Ort und der offene Punkt.
const waiting = render(view(record()));
for (const id of REMOTE_FLOW_STATIONS) {
  assert.ok(waiting.includes(REMOTE_FLOW_TITLES[id]), `Station "${REMOTE_FLOW_TITLES[id]}" fehlt im Fenster`);
}
assert.ok(waiting.includes('nicht messbar'), 'die Cloud-Station muss als nicht messbar erkennbar sein');
assert.ok(waiting.includes('In Drive gesehen'), 'die manuelle Bestätigung muss angeboten werden');
assert.ok(waiting.includes('Google-Cloud'), 'der Ort der Station muss genannt sein');
assert.ok(waiting.includes('Colab'), 'der Hinweis muss den Colab-Worker nennen');
// Der gemeldete Fortschritt bleibt stehen – er ist nur nicht die ganze Wahrheit.
assert.ok(waiting.includes('Fortschritt') && waiting.includes('gemeldet'), 'der gemeldete Fortschritt bleibt sichtbar');
assert.ok(/\d+\/\d+ belegt/.test(waiting), 'die Zahl der belegten Stationen steht im Fenster');
assert.ok(!waiting.includes('undefined'), 'kein „undefined“ im Fenster');
console.log('  ✓ wartender Lauf: alle Stationen, offener Punkt benannt');

// 2. Bestätigte Cloud: aus „nicht messbar“ wird eine Bestätigung.
const confirmedRecord = record();
confirmedRecord.flow = { checkpoints: [], cloudSyncConfirmedAt: Date.now() - 30_000 };
const confirmed = render(view(confirmedRecord));
assert.ok(confirmed.includes('Bestätigung'), 'die Bestätigung ist als solche ausgewiesen');
assert.ok(!confirmed.includes('In Drive gesehen'), 'nach der Bestätigung wird der Knopf nicht erneut angeboten');
console.log('  ✓ bestätigte Cloud: aus „nicht messbar“ wird „Bestätigung“');

// 3. Rechnender Worker: Prozent und Gerät stehen an der Rechnungs-Station.
const computing = render(
  view(
    record({
      status: 'RUNNING',
      phase: 'pass 1/1 chunk 7/20 – GPU',
      percent: 37,
      workerPercent: 37,
      device: 'cuda',
      worker: { id: 'colab-2b7f', claimedAt: Date.now() - 4 * 60_000, heartbeatAt: Date.now() - 9_000, host: 'colab', device: 'cuda', gpu: 'Tesla T4' },
    })
  )
);
assert.ok(computing.includes('37 %'), 'der Fortschritt des Workers steht im Fenster');
assert.ok(computing.includes('chunk 7/20'), 'die Phase des Workers steht im Fenster');
assert.ok(computing.includes('Tesla T4'), 'das Gerät des Workers steht im Fenster');
assert.ok(computing.includes('Colab-Worker ist wach') || computing.includes('Colab-Worker'), 'das Lebenszeichen ist sichtbar');
console.log('  ✓ rechnender Worker: Prozent, Phase und Gerät sichtbar');

// 4. Geendeter Lauf: Station und Grund, statt einer nackten Statuszeile.
const failed = render(
  view(
    record({
      status: 'FAILED',
      phase: 'Zeitüberschreitung – kein Worker-Ergebnis',
      finishedAt: Date.now() - 10_000,
      error: { code: 'REMOTE_TIMEOUT', message: 'Kein Worker-Ergebnis innerhalb von 6 Stunden.' },
    })
  )
);
assert.ok(failed.includes('hier geendet'), 'der Laufzettel markiert die Station, an der der Lauf endete');
assert.ok(failed.includes('REMOTE_TIMEOUT'), 'der Grund steht an dieser Station');
console.log('  ✓ geendeter Lauf: Station und Grund benannt');

// 5. Ohne Job darf das Fenster nicht umfallen (Frischstart, nichts gewählt).
const empty = renderToString(
  React.createElement(RemoteFlowModal, {
    open: true,
    onClose: () => undefined,
    onCancel: () => undefined,
    onRefresh: () => undefined,
    status,
    job: null,
    trackName: '',
    running: false,
    error: null,
  })
);
assert.ok(empty.includes('Noch kein Job'), 'ohne Job erklärt das Fenster, dass noch nichts läuft');
assert.ok(!empty.includes('undefined'), 'auch ohne Job kein „undefined“');
console.log('  ✓ ohne Job: verständliche Leermeldung statt Absturz');

// 6. Die Lagen der Vorschau-Seite rendern ebenfalls – sonst ist der Harness
//    genau dann kaputt, wenn man ihn braucht (wartender Job, kein Colab-Lauf
//    in Sicht). Die Datensätze derselben Seite, nicht nachgebaute Kopien.
for (const id of Object.keys(PREVIEW_SCENARIOS) as FlowPreviewScenarioId[]) {
  const scenario = PREVIEW_SCENARIOS[id];
  const built = scenario.build();
  const html = render(built.job);
  for (const stationId of REMOTE_FLOW_STATIONS) {
    assert.ok(html.includes(REMOTE_FLOW_TITLES[stationId]), `Vorschau „${scenario.label}“: Station ${stationId} fehlt`);
  }
  assert.ok(!html.includes('undefined'), `Vorschau „${scenario.label}“ zeigt „undefined“`);
  assert.ok(html.length > 5000, `Vorschau „${scenario.label}“ ist verdächtig klein (${html.length} Zeichen)`);
}
console.log(`  ✓ Vorschau-Lagen rendern (${Object.keys(PREVIEW_SCENARIOS).length} Szenen)`);

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  STATUSFENSTER: ALLE PRÜFUNGEN BESTANDEN');
console.log('═══════════════════════════════════════════════════════════════════');
