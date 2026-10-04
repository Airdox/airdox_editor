/**
 * DATENFLUSS-TRANSPARENZ DES FERNPFADS (§16, §20, §21, §40).
 *
 * Geprüft wird die Zusicherung, mit der das Statusfenster steht und fällt:
 * **Keine Station ist erledigt ohne Beleg.** Der Laufzettel darf insbesondere
 * nicht das tun, was die alte Prozentanzeige tat – Fortschritt vortäuschen,
 * wo keiner ist, und Stillstand verstecken, wo einer herrscht.
 *
 * Der Weg ist derselbe wie im Alltag: Editor → Ablage (Ordnertransport) →
 * Worker (`scripts/stem-remote-worker.ts`, derselbe Code wie auf einem
 * Studio-Rechner) → zurück in den Editor. Nur der Rechenkern ist ein Double,
 * weil in dieser Umgebung keine trainierten Gewichte vorliegen.
 *
 *   1. Nach dem Start: Arbeitskopie und Ablage belegt, Cloud offen
 *   2. Der Beleg der Ablage trägt den wirklich zurückgelesenen Hash
 *   3. Ohne Worker steht der Laufzettel an der Worker-Station – nicht in der Cloud
 *   4. Eine unbestätigte Cloud-Station verdeckt keine späteren Stationen
 *   5. Manuelle Bestätigung: nur ein Vermerk, kein technischer Nachweis
 *   6. Ende-zu-Ende: alle Stationen belegt, Cloud durch den Rückweg bewiesen
 *   7. Belege überleben einen Editor-Neustart (§21 A, §32)
 *   8. Ein geendeter Lauf markiert die Station, an der er geendet ist
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StemJobService } from '../src/stems/stemJobService';
import { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';
import { FolderTransport } from '../src/stems/remote/transport';
import { REMOTE_FLOW_STATIONS } from '../src/stems/remote/dataFlow';
import type { RemoteFlowStation } from '../src/stems/remote/dataFlow';
import type { RemoteStemJobView } from '../src/stems/transportTypes';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';
import { runWorkerCycle } from '../scripts/stem-remote-worker';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  DATENFLUSS – LAUFZETTEL: BELEGT, OFFEN ODER NICHT MESSBAR        ');
console.log('═══════════════════════════════════════════════════════════════════');

const MODEL_ID = 'pipeline-double-v1';
const PROFILE = 'PREVIEW' as const;
const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

interface Harness {
  base: string;
  root: string;
  drive: string;
  originalPath: string;
  local: StemJobService;
  remote: RemoteStemJobService;
  transport: FolderTransport;
  dispose(): Promise<void>;
}

async function makeHarness(options: { now?: () => number; jobTimeoutMs?: number } = {}): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'stem-flow-'));
  const root = path.join(base, 'engine');
  const drive = path.join(base, 'drive');
  await mkdir(root, { recursive: true });
  await mkdir(drive, { recursive: true });
  const track = generateEdmTestTrack({ seconds: 2 });
  const written = await writeTestAudio(path.join(base, 'Original'), 'edm_mix', track);

  const local = new StemJobService({ root, allowPipelineDouble: true, chunkSizeSamples: 44100, logger: quietLogger });
  const transport = new FolderTransport({ root: drive });
  const remote = new RemoteStemJobService({
    root,
    localService: local,
    transport,
    allowPipelineDouble: true,
    disableBackgroundPolling: true,
    env: {},
    settings: { pollIntervalMs: 5_000, workerLeaseMs: 60_000, jobTimeoutMs: options.jobTimeoutMs ?? 5 * 60_000 },
    logger: quietLogger,
    now: options.now,
  });
  return {
    base,
    root,
    drive,
    originalPath: written.mixPath,
    local,
    remote,
    transport,
    async dispose() {
      remote.dispose();
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function startJob(harness: Harness, trackName = 'nightdrive'): Promise<RemoteStemJobView> {
  return harness.remote.start({ inputPath: harness.originalPath, trackName, profile: PROFILE, modelId: MODEL_ID });
}

async function runWorker(harness: Harness): Promise<number> {
  return runWorkerCycle(
    {
      root: harness.drive,
      kind: 'folder',
      workDir: path.join(harness.base, 'worker'),
      workerId: 'test-worker',
      once: true,
      pollMs: 1_000,
      maxJobs: 4,
      allowPipelineDouble: true,
      quiet: true,
    },
    harness.transport
  );
}

function station(job: RemoteStemJobView, id: string): RemoteFlowStation {
  const found = job.flow?.stations.find((entry) => entry.id === id);
  assert.ok(found, `Station ${id} fehlt im Laufzettel`);
  return found;
}

function factValue(job: RemoteStemJobView, id: string, label: string): string {
  const found = station(job, id).facts?.find((entry) => entry.label === label);
  assert.ok(found, `Beleg "${label}" fehlt an Station ${id}`);
  return found.value;
}

async function run() {
  // =========================================================================
  console.log('\n[ TEST ] #1 §40: Nach dem Start ist belegt, was der Editor selbst getan hat');
  const h1 = await makeHarness();
  try {
    const started = await startJob(h1);
    const job = h1.remote.get(started.jobId)!;
    const flow = job.flow!;

    assert.ok(flow, 'Laufzettel fehlt');
    assert.equal(flow.stations.length, REMOTE_FLOW_STATIONS.length, 'alle Stationen sind im Laufzettel');
    assert.equal(station(job, 'working_copy').state, 'done', 'Arbeitskopie ist belegt');
    assert.equal(station(job, 'published').state, 'done', 'Ablage ist belegt');
    assert.match(factValue(job, 'working_copy', 'SHA-256'), /^[0-9a-f]{16}…$/, 'Hash der Arbeitskopie steht im Beleg');
    // Der Beweis ist das Zurücklesen, nicht das Schreiben.
    assert.match(factValue(job, 'published', 'Hash in Ablage'), /\(identisch\)/, 'Hash wurde aus der Ablage zurückgelesen');
    assert.equal(station(job, 'cloud_sync').state, 'unknown', 'Cloud ist nicht messbar – kein erfundenes Häkchen');
    assert.equal(station(job, 'imported').state, 'pending', 'ohne Ergebnis ist nichts importiert');
    console.log('   ✓ Arbeitskopie + Ablage belegt, Cloud offen');
  } finally {
    await h1.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #2 §40: Ohne Worker steht der Laufzettel an der Worker-Station');
  const h2 = await makeHarness();
  try {
    const started = await startJob(h2, 'waiting');
    await h2.remote.poll();
    const job = h2.remote.get(started.jobId)!;
    // Nicht die Cloud blockiert – sie ist nur offen. Der Punkt, an dem es
    // hakt, ist der fehlende Worker, und genau das muss oben stehen.
    assert.equal(job.flow!.currentId, 'worker_seen', 'der Fluss wartet auf den Worker');
    assert.equal(station(job, 'worker_seen').state, 'active');
    assert.match(station(job, 'worker_seen').hint ?? '', /Colab/, 'Hinweis nennt den Colab-Worker');
    assert.equal(job.flow!.awaitingCloudConfirmation, true, 'Cloud-Bestätigung wird weiter erwartet');
    console.log('   ✓ Warten ist sichtbar – und zwar an der richtigen Station');
  } finally {
    await h2.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #3 §40: Eine offene Cloud-Station verdeckt keine späteren Stationen');
  const h3 = await makeHarness();
  try {
    const started = await startJob(h3, 'unmasked');
    const jobId = started.jobId;
    // Worker-Lease von Hand in die Ablage legen: der Editor muss einen
    // rechnenden Worker erkennen, obwohl die Cloud-Station offen bleibt.
    const claim = {
      id: 'manual-worker',
      host: 'colab-host',
      claimedAt: Date.now(),
      heartbeatAt: Date.now(),
      device: 'cuda',
      gpu: 'Tesla T4',
      version: 'node-worker/1',
    };
    await h3.transport.writeText(`jobs/${jobId}/claim.json`, `${JSON.stringify(claim, null, 2)}\n`);
    await h3.remote.poll();
    const running = h3.remote.get(jobId)!;

    assert.equal(station(running, 'cloud_sync').state, 'unknown', 'Cloud bleibt offen');
    assert.equal(station(running, 'claimed').state, 'done', 'Claim ist belegt');
    assert.equal(station(running, 'claimed').state, 'done');
    assert.notEqual(station(running, 'compute').state, 'pending', 'die Rechnung wird nicht von der Cloud-Station verdeckt');
    assert.ok(['active', 'done'].includes(station(running, 'compute').state), 'Rechnung ist sichtbar');
    assert.equal(station(running, 'claimed').facts?.find((fact) => fact.label === 'Gerät')?.value, 'cuda (Tesla T4)');
    console.log('   ✓ Fortschritt bleibt sichtbar, auch ohne Cloud-Bestätigung');
  } finally {
    await h3.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #4 §40: Manuelle Cloud-Bestätigung ist ein Vermerk, kein Beweis');
  const h4 = await makeHarness();
  try {
    const started = await startJob(h4, 'confirm');
    const before = h4.remote.get(started.jobId)!;
    assert.equal(station(before, 'cloud_sync').state, 'unknown');

    const updated = await h4.remote.confirmCloudSync(started.jobId);
    assert.ok(updated, 'Bestätigung liefert den aktualisierten Job');
    const after = h4.remote.get(started.jobId)!;
    assert.equal(station(after, 'cloud_sync').state, 'done', 'Bestätigung hakt die Station ab');
    assert.match(station(after, 'cloud_sync').detail ?? '', /Bestätigung/, 'die Anzeige sagt, dass es eine Bestätigung ist');
    assert.match(
      after.trace?.find((event) => event.step === 'editor.cloud_sync_confirmed')?.message ?? '',
      /manuelle Bestätigung/,
      'das Protokoll hält fest, dass keine technische Prüfung stattfand'
    );
    assert.equal(await h4.remote.confirmCloudSync('gibt-es-nicht'), null, 'unbekannte Job-Id bleibt folgenlos');
    console.log('   ✓ Bestätigt – und im Protokoll als Bestätigung gekennzeichnet');
  } finally {
    await h4.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #5 §40: Ende-zu-Ende – alle Stationen belegt, Cloud durch den Rückweg bewiesen');
  const h5 = await makeHarness();
  try {
    const started = await startJob(h5, 'roundtrip');
    const processed = await runWorker(h5);
    assert.equal(processed, 1, 'der Worker hat den Job gerechnet');
    await h5.remote.poll();
    const job = h5.remote.get(started.jobId)!;

    assert.equal(job.status, 'COMPLETED', 'Ergebnis ist importiert');
    for (const id of REMOTE_FLOW_STATIONS) {
      assert.equal(station(job, id).state, 'done', `Station ${id} ist belegt`);
      assert.equal(typeof station(job, id).at, 'number', `Station ${id} hat einen Zeitpunkt`);
    }
    assert.equal(job.flow!.currentId, null, 'kein offener Punkt mehr');
    assert.equal(job.flow!.openCount, 0);
    assert.match(station(job, 'cloud_sync').detail ?? '', /Rückweg/, 'die Cloud ist durch den Rückweg bewiesen, nicht geschätzt');
    assert.equal(station(job, 'imported').facts?.find((fact) => fact.label === 'Stems')?.value, 'vocals, drums, bass, other');
    assert.equal(station(job, 'imported').facts?.find((fact) => fact.label === 'Original')?.value, 'unverändert');
    console.log('   ✓ Zehn Stationen, zehn Belege – die Cloud inklusive');
  } finally {
    await h5.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #6 §21 A: Belege überleben einen Editor-Neustart');
  const h6 = await makeHarness();
  try {
    const started = await startJob(h6, 'restart');
    await runWorker(h6);
    await h6.remote.poll();
    const before = h6.remote.get(started.jobId)!;
    const beforeIds = before.flow!.stations.map((entry) => entry.id).join(',');

    // Frischer Dienst auf demselben Datenordner: als wäre die App neu gestartet.
    const revived = new RemoteStemJobService({
      root: h6.root,
      localService: h6.local,
      transport: new FolderTransport({ root: h6.drive }),
      allowPipelineDouble: true,
      disableBackgroundPolling: true,
      env: {},
      settings: { pollIntervalMs: 5_000, workerLeaseMs: 60_000, jobTimeoutMs: 5 * 60_000 },
      logger: quietLogger,
    });
    await revived.status(); // lädt die Datensätze aus dem Datenordner
    const after = revived.get(started.jobId)!;
    assert.equal(after.flow!.stations.map((entry) => entry.id).join(','), beforeIds, 'derselbe Laufzettel nach dem Neustart');
    assert.equal(
      after.flow!.stations.filter((entry) => entry.state === 'done').length,
      before.flow!.stations.filter((entry) => entry.state === 'done').length,
      'kein Beleg geht beim Neustart verloren'
    );
    revived.dispose();
    console.log('   ✓ Der Laufzettel ist dauerhaft, nicht nur flüchtig im Speicher');
  } finally {
    await h6.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #7 §21 E: Ein geendeter Lauf markiert die Station, an der er endete');
  const clock = { value: Date.now() };
  const h7 = await makeHarness({ now: () => clock.value, jobTimeoutMs: 60_000 });
  try {
    const started = await startJob(h7, 'timeout');
    clock.value += 61_000;
    await h7.remote.poll();
    const job = h7.remote.get(started.jobId)!;
    assert.equal(job.status, 'FAILED', 'Zeitlimit greift ohne Worker');
    const ended = job.flow!.stations.find((entry) => entry.id === job.flow!.currentId);
    assert.ok(ended, 'es gibt eine Station, an der der Lauf endete');
    assert.equal(ended.state, 'failed', 'diese Station ist als „hier geendet“ markiert');
    assert.equal(ended.id, 'worker_seen', 'geendet wurde am fehlenden Worker – nicht in der Cloud');
    assert.match(ended.facts?.find((fact) => fact.label === 'Grund')?.value ?? '', /REMOTE_TIMEOUT/, 'der Grund steht am Beleg');
    console.log('   ✓ Stillstand zeigt eine Station und einen Grund – nicht „0 %“');
  } finally {
    await h7.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #8 §13: Vor dem bestätigten Upload ist die Cloud-Station noch nicht erreicht');
  const h8 = await makeHarness();
  try {
    const started = await h8.remote.start({
      inputPath: h8.originalPath,
      trackName: 'interrupted',
      profile: PROFILE,
      modelId: MODEL_ID,
    });
    // Der Zustand eines abgebrochenen Uploads: Belege verworfen, Status
    // zurück auf PREPARING, kein `uploadedAt`.
    const recordPath = path.join(h8.root, 'RemoteJobs', `${started.jobId}.json`);
    const fs = await import('node:fs/promises');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    delete record.flow;
    delete record.uploadedAt;
    record.status = 'PREPARING';
    await fs.writeFile(recordPath, JSON.stringify(record));

    const reloaded = new RemoteStemJobService({
      root: h8.root,
      localService: h8.local,
      transport: new FolderTransport({ root: h8.drive }),
      allowPipelineDouble: true,
      disableBackgroundPolling: true,
      env: {},
      settings: { pollIntervalMs: 5_000, workerLeaseMs: 60_000, jobTimeoutMs: 5 * 60_000 },
      logger: quietLogger,
    });
    await reloaded.status(); // Datensatz aus dem Datenordner laden
    const job = reloaded.get(started.jobId)!;

    assert.equal(station(job, 'working_copy').state, 'done', 'die Arbeitskopie existiert');
    assert.equal(station(job, 'published').state, 'active', 'der Upload ist noch nicht bestätigt');
    assert.notEqual(station(job, 'cloud_sync').state, 'done', 'kein Häkchen ohne Beleg');
    assert.equal(
      station(job, 'cloud_sync').state,
      'pending',
      'solange die Ablage nicht bestätigt ist, ist die Cloud „noch nicht erreicht“ – nicht „nicht messbar“'
    );
    assert.equal(job.flow!.awaitingCloudConfirmation, false, 'eine Bestätigung wird erst angeboten, wenn sie Sinn ergibt');
    reloaded.dispose();
    console.log('   ✓ Kein grüner Haken, den sich niemand verdient hat');
  } finally {
    await h8.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #9 §40: Das Lebenszeichen zählt schon vor dem Claim');
  const h9 = await makeHarness();
  try {
    const started = await startJob(h9, 'heartbeat');
    // Der Worker ist da, hat diesen Job aber noch nicht beansprucht: genau die
    // Lage „Notebook läuft, Job wird nicht gesehen“.
    await h9.transport.writeText(
      'worker.status.json',
      `${JSON.stringify(
        { id: 'colab-watch', host: 'colab', device: 'cuda', gpu: 'Tesla T4', heartbeatAt: Date.now(), pollSeconds: 15, phase: 'polling' },
        null,
        2
      )}\n`
    );
    await h9.remote.poll();
    const job = h9.remote.get(started.jobId)!;

    assert.equal(station(job, 'worker_seen').state, 'done', 'der Worker ist belegt – obwohl er den Job nicht hat');
    assert.equal(factValue(job, 'worker_seen', 'Gerät'), 'cuda (Tesla T4)');
    assert.equal(factValue(job, 'worker_seen', 'Quelle'), 'worker.status.json');
    assert.equal(station(job, 'claimed').state, 'pending', 'der Claim fehlt weiterhin');
    assert.equal(job.flow!.currentId, 'claimed', 'offen ist jetzt der Claim, nicht mehr die Suche nach dem Worker');
    console.log('   ✓ „Worker wach“ und „Job angenommen“ sind getrennt sichtbar');
  } finally {
    await h9.dispose();
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  DATENFLUSS: ALLE PRÜFUNGEN BESTANDEN');
  console.log('═══════════════════════════════════════════════════════════════════');
}

run().catch((error) => {
  console.error('\n✗ DATENFLUSS-TEST FEHLGESCHLAGEN');
  console.error(error);
  process.exitCode = 1;
});
