/**
 * @license
 * airdox_SMART_Editor – Fernpfad-Sichtbarkeit (Google Drive → Colab).
 *
 * Warum diese Suite existiert:
 *   Der Fernpfad hat fünf bestätigte Stationen (Arbeitskopie, Drive-Ablage,
 *   Worker-Claim, Inferenz, geprüfter Import). Der Prozentwert darf
 *   ausschließlich der vom Worker gemeldete Inferenzfortschritt sein – vor dem
 *   Claim zeigt der Monitor „noch nicht gestartet" statt einer erfundenen
 *   0 %-Gesamtanzeige, und der Cloud-Abgleich von Google Drive wird nicht als
 *   messbar vorgetäuscht.
 *
 *   Zusätzlich sichert die Suite die Abbruchkette: ein Abbruch während der
 *   Vorbereitung muss wirken (Abortsignal vor dem Upload), und ein laufender
 *   Fern-Job muss über `cancelActiveEngineJob` abbrechbar sein.
 *
 * Run with: npx tsx tests/remote-flow-visibility.test.ts
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  currentExplanation,
  normalisedPercent,
} from '../src/components/Modals/RemoteFlowModal';
import {
  buildRemoteDataFlow,
  REMOTE_FLOW_STATIONS,
  type RemoteFlowStationId,
} from '../src/stems/remote/dataFlow';
import type { RemoteJobRecord } from '../src/stems/remote/types';
import type { RemoteStemJobView } from '../src/stems/transportTypes';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) =>
  readFile(`${root}${relative}`.replace(/\/+/g, '/'), 'utf8');

const modalSource = await read('src/components/Modals/RemoteFlowModal.tsx');
const appSource = await read('src/App.tsx');
const engineSource = await read('src/audio/stemEngine.ts');

/** Laufzettel eines Jobs aus seinen Belegen – ohne Dienst, ohne Dateisystem. */
function flow(ids: RemoteFlowStationId[], status = 'PENDING', worker: { id: string; device?: string } | null = null) {
  const at = 1_700_000_000_000;
  return buildRemoteDataFlow(
    {
      jobId: 'job-flow',
      status,
      createdAt: at,
      updatedAt: at,
      phase: 'TEST',
      percent: 0,
      flow: { checkpoints: ids.map((id, index) => ({ id, at: at + index * 1000, detail: id, facts: [] })) },
    } as unknown as RemoteJobRecord,
    { now: at + 60_000, worker }
  );
}

const stateOf = (stations: ReturnType<typeof flow>['stations'], id: RemoteFlowStationId) =>
  stations.find((station) => station.id === id)?.state;

/** Vollständiger Fern-Job; einzelne Felder werden je Prüfung überschrieben. */
function job(overrides: Partial<RemoteStemJobView> = {}): RemoteStemJobView {
  return {
    jobId: '9f1c1f2e-0dd0-4a3a-9a51-2f1c1f2e0dd0',
    status: 'PENDING',
    phase: 'WARTET_AUF_WORKER',
    percent: 0,
    profile: 'HIGH_QUALITY',
    modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
    family: 'bs_roformer',
    backend: 'bs_roformer',
    stems: ['vocals', 'bass', 'drums', 'other'],
    trackName: 'track_1',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  FERNPFAD – EHRLICHE SICHTBARKEIT (DRIVE → COLAB)                ');
console.log('═══════════════════════════════════════════════════════════════════');

console.log('\n[ TEST ] 1 – Kein erfundener KI-Prozentwert vor dem Worker-Claim');
{
  assert.equal(normalisedPercent(null, false), null, 'ohne Job gibt es keinen KI-Wert');
  assert.equal(
    normalisedPercent(job({ status: 'RUNNING', percent: 42 }), false),
    null,
    'ohne Worker-Heartbeat ist auch ein Editor-Wert kein KI-Fortschritt'
  );
  assert.equal(
    normalisedPercent(job({ status: 'RUNNING', worker: { id: 'colab-7' }, workerPercent: 12, percent: 42 }), false),
    12,
    'mit Worker gilt der gemeldete Worker-Wert'
  );
  assert.equal(
    normalisedPercent(job({ status: 'RUNNING', worker: { id: 'colab-7' }, workerPercent: 140 }), false),
    100,
    'der Wert wird auf 0…100 begrenzt'
  );
  assert.equal(
    normalisedPercent(job({ status: 'RUNNING', worker: { id: 'colab-7' }, workerPercent: -3 }), false),
    0,
    'negative Meldungen werden auf 0 begrenzt'
  );
  assert.equal(
    normalisedPercent(job({ status: 'COMPLETED' }), true),
    100,
    'ein abgeschlossener Job zeigt 100 %'
  );
  console.log('  ✓ 0 % erscheint nur, wenn ein Worker wirklich 0 % meldet');
}

console.log('\n[ TEST ] 2 – Zehn Stationen werden nur bei Beleg grün');
{
  assert.equal(REMOTE_FLOW_STATIONS.length, 10, 'der Laufzettel kennt zehn Stationen');

  const copy = flow(['working_copy']);
  assert.equal(stateOf(copy.stations, 'working_copy'), 'done', 'die Arbeitskopie ist belegt');
  assert.equal(stateOf(copy.stations, 'published'), 'active', 'die Ablage ist der nächste offene Schritt');
  assert.equal(copy.currentId, 'published', 'der Fluss steht an der Ablage');

  const published = flow(['working_copy', 'published']);
  assert.equal(stateOf(published.stations, 'published'), 'done', 'der Hash-Rücklesebeleg schließt die Ablage');
  assert.equal(stateOf(published.stations, 'cloud_sync'), 'unknown', 'der Cloud-Abgleich bleibt nicht messbar');
  assert.equal(stateOf(published.stations, 'worker_seen'), 'active', 'ohne Lebenszeichen wartet der Worker sichtbar');

  const seen = flow(['working_copy', 'published', 'worker_seen'], 'RUNNING', { id: 'colab-7' });
  assert.equal(stateOf(seen.stations, 'worker_seen'), 'done', 'das Lebenszeichen ist der Beleg für den Worker');
  assert.equal(stateOf(seen.stations, 'claimed'), 'pending', 'Lebenszeichen ist noch kein Job-Claim');
  assert.equal(seen.currentId, 'claimed', 'jetzt fehlt die Annahme des Jobs');

  const computing = flow(['working_copy', 'published', 'worker_seen', 'claimed'], 'RUNNING', { id: 'colab-7' });
  assert.equal(computing.currentId, 'compute', 'nach dem Claim ist die Rechnung der offene Schritt');

  const complete = flow(
    ['working_copy', 'published', 'cloud_sync', 'worker_seen', 'claimed', 'compute', 'results_ready', 'downloaded', 'validated', 'imported'],
    'COMPLETED'
  );
  assert.equal(
    complete.stations.filter((station) => station.state === 'done').length,
    10,
    'erst der geprüfte Import schließt alle zehn Stationen'
  );
  assert.equal(complete.currentId, null, 'ein vollständiger Lauf steht an keiner Station mehr');

  const failed = flow(['working_copy', 'published', 'worker_seen', 'claimed'], 'FAILED');
  assert.equal(stateOf(failed.stations, 'compute'), 'failed', 'ein technischer Fehler bleibt rot');
  assert.equal(failed.currentId, 'compute', 'die Endstation ist benannt');

  const cancelled = flow(['working_copy', 'published'], 'CANCELLED');
  assert.equal(stateOf(cancelled.stations, 'published'), 'done', 'das lokale Schreiben in die Jobablage ist belegt');
  assert.equal(stateOf(cancelled.stations, 'cloud_sync'), 'unknown', 'ein lokaler Abbruch beweist keinen Cloud-Sync');
  assert.equal(stateOf(cancelled.stations, 'worker_seen'), 'cancelled', 'ein Abbruch vor dem Claim wird amber statt als Fehler gezeigt');
  assert.equal(cancelled.currentId, 'worker_seen', 'der Abbruchpunkt bleibt beim fehlenden Worker');
  console.log('  ✓ Stationen folgen Belegen; Abbruch und technischer Fehler bleiben getrennt');
}

console.log('\n[ TEST ] 3 – Der Monitor erklärt, warum 0 % korrekt ist');
{
  const waiting = currentExplanation(job({ status: 'RUNNING' }), undefined, false, false);
  assert.equal(waiting.waitingForWorker, true, 'ohne Worker wird der Wartezustand benannt');
  assert.match(waiting.description, /claim\.json/, 'die Wartebedingung (claim.json) wird erklärt');

  const claimed = currentExplanation(
    job({ status: 'RUNNING', worker: { id: 'colab-7' }, workerPercent: 0, percent: 0 }),
    undefined,
    false,
    false
  );
  assert.equal(claimed.waitingForWorker, true, 'mit Claim, aber ohne Inferenzmeldung wird weiter gewartet');
  assert.match(claimed.title, /erste Fortschrittsmeldung steht aus/, 'der fehlende Worker-Wert wird benannt');

  const running = currentExplanation(job({ status: 'RUNNING', worker: { id: 'colab-7' }, workerPercent: 55 }), undefined, false, false);
  assert.equal(running.title, 'Google Colab rechnet', 'ab dem ersten Worker-Wert läuft die Anzeige');

  const cancelled = currentExplanation(
    job({ status: 'CANCELLED', transport: 'Google Drive (Ordner)' }),
    undefined,
    false,
    false
  );
  assert.match(cancelled.title, /Vor der Übernahme durch Colab abgebrochen/);
  assert.match(cancelled.description, /kein Worker-Claim/, 'lokales Flag-Schreiben wird nicht als Worker-Bestätigung ausgegeben');
  assert.match(cancelled.description, /Cloud-Upload/, 'der lokale Sync-Ordner wird nicht mit der Cloud gleichgesetzt');
  assert.match(cancelled.description, /Notebook-Zelle #5/, 'der Diagnosehinweis nennt die Colab-Zelle');
  assert.match(cancelled.description, /JOB_ORDNER/, 'der Diagnosehinweis nennt den Ordnerabgleich');

  const workerCancelled = currentExplanation(
    job({
      status: 'CANCELLED',
      trace: [{
        id: 'worker-cancelled',
        source: 'worker',
        jobId: '9f1c1f2e-0dd0-4a3a-9a51-2f1c1f2e0dd0',
        at: 1_700_000_000_100,
        step: 'worker.cancelled',
        status: 'CANCELLED',
        level: 'warning',
        message: 'Abbruch bestätigt',
      }],
    }),
    undefined,
    false,
    false
  );
  assert.match(workerCancelled.title, /Worker bestätigt/);
  assert.ok(modalSource.includes("station.state === 'cancelled'"), 'der Laufzettel färbt Abbruch anders als Fehler');

  const waitingInSyncFolder = currentExplanation(
    job({ status: 'RUNNING', transport: 'Google Drive (Ordner)' }),
    undefined,
    false,
    false
  );
  assert.match(waitingInSyncFolder.title, /Sync-Ordner/);
  assert.match(waitingInSyncFolder.description, /Cloud.*nicht messen/);

  assert.ok(
    modalSource.includes('0 % ist in dieser Phase korrekt'),
    'die Oberfläche sagt wörtlich, dass 0 % in dieser Phase korrekt ist'
  );
  assert.ok(
    modalSource.includes('Cloud-Sync separat nicht messbar'),
    'der Cloud-Abgleich wird nicht als messbar dargestellt'
  );
  console.log('  ✓ Wartezustand, 0 %-Begründung und Abbruchtext sind ehrlich formuliert');
}

console.log('\n[ TEST ] 4 – Abbruch wirkt in Vorbereitung und während des Jobs');
{
  assert.match(
    appSource,
    /signal: remoteAbortRef\.current/,
    'App reicht das Abortsignal an die Fern-Separation weiter'
  );
  assert.match(
    appSource,
    /remoteAbortRef\.current\.aborted = true/,
    'App merkt den Abbruch vor, solange noch kein Job sichtbar ist'
  );
  assert.match(
    engineSource,
    /if \(options\.signal\?\.aborted\)[\s\S]{0,200}INFERENCE_CANCELLED/,
    'die Engine prüft das Signal und bricht mit INFERENCE_CANCELLED ab'
  );
  assert.match(
    engineSource,
    /this\.activeRemoteJobId = job\.jobId/,
    'der laufende Fern-Job ist für den Abbruch bekannt'
  );
  assert.match(
    engineSource,
    /const remoteJobId = this\.activeRemoteJobId;[\s\S]{0,200}cancelRemoteJob/,
    'cancelActiveEngineJob bricht den Fern-Job über den echten Dienst ab'
  );
  console.log('  ✓ Vorbereitung und laufender Job sind abbrechbar');
}

console.log('\n✔ FERNPFAD-SICHTBARKEIT: alle Prüfungen bestanden\n');
