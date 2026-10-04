/**
 * Testdatensätze für die Laufzettel-Vorschau (§40).
 *
 * Bewusst ein eigenes Modul ohne React und ohne CSS-Import: so können die
 * Lagen auch serverseitig gerendert und geprüft werden
 * (`tests/stem-remote-flow-modal.test.tsx`), statt nur im Browser zu
 * existieren. Die Datensätze laufen durch dieselbe `buildRemoteDataFlow()`,
 * die auch der Editor benutzt – die Vorschau zeigt also keine gemalten
 * Zustände, sondern berechnete.
 *
 * Nur für den Dev-Server (`/flow-preview.html`). Nicht Teil des Builds.
 */
import { buildRemoteDataFlow } from './stems/remote/dataFlow';
import type { RemoteJobRecord } from './stems/remote/types';
import type { RemoteServiceStatus, RemoteStemJobView } from './stems/transportTypes';
import type { StemId } from './stems/types';

export const JOB_ID = '915db325-a297-40a8-94e8-fa7137f14f94';
const MINUTE = 60_000;

function baseRecord(overrides: Partial<RemoteJobRecord> = {}): RemoteJobRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    createdAt: now - 14 * MINUTE,
    updatedAt: now - 5_000,
    phaseUpdatedAt: now - 13 * MINUTE,
    status: 'RUNNING',
    phase: 'Wartet auf den externen Rechner (Google Drive)',
    percent: 0,
    trackName: 'nightdrive_extended_mix',
    profile: 'HIGH_QUALITY',
    modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
    family: 'bs_roformer',
    backend: 'bs_roformer',
    stems: ['vocals', 'drums', 'bass', 'other'],
    idempotencyKey: 'preview-key',
    workingCopyPath: 'C:/Users/dj/AppData/Roaming/airdox_SMART_Editor/stems/Working/nightdrive_extended_mix.wav',
    workingCopySha256: '9f2c1a7b3e5d4f6081a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708',
    workingCopyBytes: 104_857_600,
    durationSeconds: 352,
    sampleRate: 44100,
    channels: 2,
    transportErrors: 0,
    transportLabel: 'Google Drive (Ordner)',
    transportRoot: 'C:/Users/dj/Google Drive/airdox-stem-jobs',
    attempts: 1,
    ...overrides,
  };
}

function toView(record: RemoteJobRecord, worker?: RemoteServiceStatus['worker']): RemoteStemJobView {
  return {
    jobId: record.jobId,
    status: record.status,
    phase: record.phase,
    percent: record.status === 'COMPLETED' ? 100 : Math.round(record.workerPercent ?? record.percent),
    profile: record.profile,
    modelId: record.modelId,
    family: record.family,
    backend: record.backend,
    stems: record.stems,
    trackName: record.trackName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    phaseUpdatedAt: record.phaseUpdatedAt,
    transport: record.transportLabel,
    transportLabel: record.transportLabel,
    transportRoot: record.transportRoot,
    device: record.device,
    cpuFallback: record.cpuFallback,
    worker: record.worker
      ? { id: record.worker.id, claimedAt: record.worker.claimedAt, heartbeatAt: record.worker.heartbeatAt, host: record.worker.host }
      : undefined,
    workerPercent: record.workerPercent,
    flow: buildRemoteDataFlow(record, { now: Date.now(), worker, transportLabel: record.transportLabel, transportRoot: record.transportRoot }),
  };
}

/** Belege, wie der Editor sie im Betrieb schreibt (vereinfacht, gleiche Form). */
const publishedCheckpoints = (record: RemoteJobRecord): RemoteJobRecord => ({
  ...record,
  uploadedAt: record.createdAt + 8_000,
  flow: {
    checkpoints: [
      {
        id: 'working_copy',
        at: record.createdAt,
        detail: 'Arbeitskopie im Engine-Datenordner; das Original wurde nur gelesen.',
        facts: [
          { label: 'Datei', value: 'nightdrive_extended_mix.wav' },
          { label: 'Größe', value: '100.0 MB' },
          { label: 'SHA-256', value: `${record.workingCopySha256.slice(0, 16)}…` },
          { label: 'Audio', value: '5:52 · 44100 Hz · 2 Kan.' },
          { label: 'Modell', value: `${record.modelId} · ${record.profile}` },
        ],
      },
      {
        id: 'published',
        at: record.createdAt + 8_000,
        detail: 'Arbeitskopie liegt in der Ablage und wurde dort zurückgelesen – Hash stimmt.',
        facts: [
          { label: 'Ablage', value: 'Google Drive (Ordner)' },
          { label: 'Eingabe', value: `jobs/${JOB_ID}/input/nightdrive_extended_mix.wav` },
          { label: 'Steckbrief', value: `jobs/${JOB_ID}/manifest.json` },
          { label: 'Größe', value: '100.0 MB' },
          { label: 'Hash in Ablage', value: `${record.workingCopySha256.slice(0, 16)}… (identisch)` },
        ],
      },
    ],
  },
});

const SCENARIOS = {
  waiting: {
    label: 'Wartet auf den Worker',
    hint: 'Der Klassiker: Datei liegt in Drive, aber niemand rechnet.',
    build(): { job: RemoteStemJobView; status: RemoteServiceStatus } {
      const record = publishedCheckpoints(baseRecord());
      const status: RemoteServiceStatus = {
        configured: true,
        label: 'Google Drive (Ordner)',
        root: record.transportRoot,
        reachable: true,
        jobs: [],
        active: 1,
        completed: 0,
        failed: 0,
        pollIntervalMs: 15_000,
        worker: null,
      };
      return { job: toView(record, null), status };
    },
  },
  computing: {
    label: 'Worker rechnet (37 %)',
    hint: 'Mitten in der Rechnung – Cloud weiterhin unbestätigt.',
    build(): { job: RemoteStemJobView; status: RemoteServiceStatus } {
      const now = Date.now();
      const worker = {
        id: 'colab-2b7f-4412',
        host: 'colab',
        device: 'cuda',
        gpu: 'Tesla T4',
        version: 'colab-worker/2',
        heartbeatAt: now - 9_000,
        pollSeconds: 15,
      };
      const record = publishedCheckpoints(
        baseRecord({
          phase: 'pass 1/1 chunk 7/20 – GPU',
          percent: 37,
          workerPercent: 37,
          phaseUpdatedAt: now - 20_000,
          device: 'cuda',
          worker: { id: worker.id, claimedAt: now - 4 * MINUTE, heartbeatAt: now - 9_000, host: 'colab', device: 'cuda', gpu: 'Tesla T4', version: 'colab-worker/2' },
        })
      );
      record.flow = {
        ...record.flow!,
        checkpoints: [
          ...record.flow!.checkpoints,
          {
            id: 'worker_seen',
            at: now - 4 * MINUTE,
            updatedAt: now - 9_000,
            detail: 'Der Worker schreibt ein Lebenszeichen in die Ablage.',
            facts: [
              { label: 'Worker', value: worker.id },
              { label: 'Host', value: 'colab' },
              { label: 'Gerät', value: 'cuda (Tesla T4)' },
              { label: 'Quelle', value: 'worker.status.json / claim.json' },
              { label: 'Zyklus', value: '15 s' },
            ],
          },
          {
            id: 'claimed',
            at: now - 4 * MINUTE,
            detail: 'Der Worker hat den Job für sich reserviert.',
            facts: [
              { label: 'Worker', value: worker.id },
              { label: 'Host', value: 'colab' },
              { label: 'Gerät', value: 'cuda (Tesla T4)' },
              { label: 'Versuche', value: '1' },
            ],
          },
          {
            id: 'compute',
            at: now - 3.5 * MINUTE,
            updatedAt: now - 20_000,
            detail: 'Der Worker rechnet und schreibt seinen Fortschritt in den Steckbrief.',
            facts: [
              { label: 'Fortschritt', value: '37 %' },
              { label: 'Phase', value: 'pass 1/1 chunk 7/20 – GPU' },
              { label: 'Gerät', value: 'cuda (Tesla T4)' },
              { label: 'Modell', value: record.modelId },
            ],
          },
        ],
      };
      const status: RemoteServiceStatus = {
        configured: true,
        label: 'Google Drive (Ordner)',
        root: record.transportRoot,
        reachable: true,
        jobs: [],
        active: 1,
        completed: 0,
        failed: 0,
        pollIntervalMs: 15_000,
        worker,
      };
      return { job: toView(record, worker), status };
    },
  },
  completed: {
    label: 'Fertig – Rückweg beweisbar',
    hint: 'Alle Stationen belegt, die Cloud durch das zurückgekommene Ergebnis.',
    build(): { job: RemoteStemJobView; status: RemoteServiceStatus } {
      const now = Date.now();
      const stems = ['vocals', 'drums', 'bass', 'other'];
      const record = publishedCheckpoints(
        baseRecord({
          status: 'COMPLETED',
          phase: 'Stem-Separation abgeschlossen',
          percent: 100,
          workerPercent: 100,
          finishedAt: now - 40_000,
          localJobId: JOB_ID,
          device: 'cuda',
          worker: { id: 'colab-2b7f-4412', claimedAt: now - 11 * MINUTE, heartbeatAt: now - 60_000, host: 'colab', device: 'cuda', gpu: 'Tesla T4' },
          importedStems: stems.map((id, index) => ({
            id: id as StemId,
            filePath: `remote-${JOB_ID.slice(0, 8)}/${id}.wav`,
            bytes: 26_214_400 + index * 12_345,
            sha256: `${(index + 1).toString(16).repeat(8)}a1b2c3d4e5f60718293a4b5c6d7e8f90`,
          })),
        })
      );
      record.flow = {
        ...record.flow!,
        checkpoints: [
          ...record.flow!.checkpoints,
          { id: 'worker_seen', at: now - 11 * MINUTE, detail: 'Der Worker schreibt ein Lebenszeichen in die Ablage.' },
          { id: 'claimed', at: now - 11 * MINUTE, detail: 'Der Worker hat den Job für sich reserviert.' },
          { id: 'compute', at: now - 10.5 * MINUTE, updatedAt: now - 3 * MINUTE, detail: 'Der Worker hat die Trennung abgeschlossen.' },
          {
            id: 'results_ready',
            at: now - 2 * MINUTE,
            detail: 'Der Worker hat die Stems in die Ablage zurückgeschrieben.',
            facts: stems.map((id, index) => ({
              label: id,
              value: `${id}.wav · 25.0 MB · ${((index + 1).toString(16).repeat(2)).slice(0, 12)}`,
            })),
          },
          { id: 'downloaded', at: now - 60_000, detail: '4 Ergebnisdatei(en) aus der Ablage gelesen.' },
          { id: 'validated', at: now - 55_000, detail: 'SHA-256, Abtastrate, Kanäle, Länge und Pegel geprüft.' },
          {
            id: 'imported',
            at: now - 40_000,
            detail: 'Die Stems sind im Editor verfügbar und mit dem Original-Track verknüpft.',
            facts: [
              { label: 'Job', value: JOB_ID },
              { label: 'Stems', value: stems.join(', ') },
              { label: 'Laufzeit', value: '812 s' },
              { label: 'Original', value: 'unverändert' },
            ],
          },
        ],
      };
      const status: RemoteServiceStatus = {
        configured: true,
        label: 'Google Drive (Ordner)',
        root: record.transportRoot,
        reachable: true,
        jobs: [],
        active: 0,
        completed: 1,
        failed: 0,
        pollIntervalMs: 15_000,
        worker: null,
      };
      return { job: toView(record, null), status };
    },
  },
  timedOut: {
    label: 'Geendet – Zeitlimit',
    hint: 'Der Lauf endete an einer benannten Station, mit Grund.',
    build(): { job: RemoteStemJobView; status: RemoteServiceStatus } {
      const now = Date.now();
      const record = publishedCheckpoints(
        baseRecord({
          status: 'FAILED',
          phase: 'Zeitüberschreitung – kein Worker-Ergebnis',
          finishedAt: now - 30_000,
          error: { code: 'REMOTE_TIMEOUT', message: 'Fern-Job 915db325… hat nach 6 Stunden kein Ergebnis geliefert.' },
        })
      );
      const status: RemoteServiceStatus = {
        configured: true,
        label: 'Google Drive (Ordner)',
        root: record.transportRoot,
        reachable: true,
        jobs: [],
        active: 0,
        completed: 0,
        failed: 1,
        pollIntervalMs: 15_000,
        worker: null,
      };
      return { job: toView(record, null), status };
    },
  },
};

export type FlowPreviewScenarioId = keyof typeof SCENARIOS;

/** Für Tests und Dokumentation: alle Lagen mit Bezeichnung und Erklärung. */
export const PREVIEW_SCENARIOS = SCENARIOS;

