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
  deriveStepStates,
  normalisedPercent,
} from '../src/components/Modals/RemoteFlowModal';
import type { RemoteStemJobView } from '../src/stems/transportTypes';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) =>
  readFile(`${root}${relative}`.replace(/\/+/g, '/'), 'utf8');

const modalSource = await read('src/components/Modals/RemoteFlowModal.tsx');
const appSource = await read('src/App.tsx');
const engineSource = await read('src/audio/stemEngine.ts');

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

console.log('\n[ TEST ] 2 – Fünf Stationen werden nur bei Bestätigung grün');
{
  assert.deepEqual(
    deriveStepStates(job({ status: 'PENDING' }), true, false),
    ['complete', 'active', 'waiting', 'waiting', 'waiting'],
    'während des Uploads ist die Drive-Ablage die aktive Station'
  );
  assert.deepEqual(
    deriveStepStates(job({ status: 'RUNNING' }), true, false),
    ['complete', 'complete', 'active', 'waiting', 'waiting'],
    'in Drive, aber ohne Worker-Claim: die dritte Station wartet sichtbar'
  );
  assert.deepEqual(
    deriveStepStates(job({ status: 'RUNNING', worker: { id: 'colab-7', heartbeatAt: 1 } }), true, false),
    ['complete', 'complete', 'complete', 'active', 'waiting'],
    'mit Worker-Claim ist die Inferenz die aktive Station'
  );
  assert.deepEqual(
    deriveStepStates(job({ status: 'COMPLETED', importedStems: [] }), false, false),
    ['complete', 'complete', 'complete', 'complete', 'complete'],
    'erst der geprüfte Import schließt alle fünf Stationen'
  );
  assert.deepEqual(
    deriveStepStates(job({ status: 'FAILED' }), false, true),
    ['complete', 'complete', 'error', 'waiting', 'waiting'],
    'ein Fehlschlag markiert die offene Station als Problem'
  );
  assert.deepEqual(
    deriveStepStates(null, true, false),
    ['active', 'waiting', 'waiting', 'waiting', 'waiting'],
    'vor dem ersten Job-Poll ist die Arbeitskopie die aktive Station'
  );
  console.log('  ✓ Stationen folgen bestätigten Ereignissen, nicht dem Statuswort allein');
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

  const cancelled = currentExplanation(job({ status: 'CANCELLED' }), undefined, false, true);
  assert.match(cancelled.description, /keine unvollständigen Stems/, 'ein Abbruch verspricht keine halben Stems');
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
