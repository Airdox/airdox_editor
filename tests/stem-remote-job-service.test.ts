/**
 * FERN-JOB-SERVICE – High Quality extern über eine Jobablage (§15–§22, §30–§37).
 *
 * Hier läuft der **echte** Weg: der Editor legt einen Fern-Job an (Arbeitskopie,
 * Upload, Manifest), der **echte Worker** (`scripts/stem-remote-worker.ts`, also
 * derselbe Code wie auf einem Studio-Rechner) beansprucht ihn, rechnet mit der
 * vorhandenen Engine, lädt die Stems zurück – und der Editor importiert sie über
 * den **vorhandenen** lokalen Job-Pfad. Es wird nichts nachgebaut und nichts
 * gemockt außer dem Rechenkern selbst (Pipeline-Double statt trainiertem Modell,
 * weil in dieser Umgebung keine Gewichte verfügbar sind).
 *
 * Geprüft wird, was im Alltag schiefgeht:
 *   1. Start: Original read-only, Arbeitskopie im Engine-Ordner, Manifest in der Ablage
 *   2. §19/§33: zweiter Start mit demselben Input ⇒ kein zweiter Job, kein zweiter Upload
 *   3. Ende-zu-Ende: Worker rechnet, Editor prüft und importiert (lesbare Stems)
 *   4. §21 A/§32: Editor-Neustart holt ein fertiges Ergebnis nach – ohne neuen Job
 *   5. §34 I/J/K: fehlende, beschädigte oder unbrauchbare Stems ⇒ FAILED, nie COMPLETED
 *   6. §21 C: nicht erreichbare Ablage ⇒ Job bleibt aktiv (transportDegraded)
 *   7. §21 E: kein Worker ⇒ Zeitüberschreitung mit Grund, inkl. `error.json`
 *   8. §37: Abbruch gewinnt – ein später eintreffendes Worker-Ergebnis wird verworfen
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StemJobService } from '../src/stems/stemJobService';
import { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';
import { FolderTransport } from '../src/stems/remote/transport';
import { parseManifest, serializeManifest } from '../src/stems/remote/manifest';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';
import { decodeWav } from '../src/stems/wavIo';
import { runWorkerCycle } from '../scripts/stem-remote-worker';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  FERN-JOB-SERVICE – EDITOR ⇄ ABLAGE ⇄ WORKER ⇄ IMPORT            ');
console.log('═══════════════════════════════════════════════════════════════════');

const MODEL_ID = 'pipeline-double-v1';
const PROFILE = 'PREVIEW' as const;
const STEMS = ['vocals', 'drums', 'bass', 'other'];
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

async function makeHarness(options: { jobTimeoutMs?: number; workerLeaseMs?: number; env?: Record<string, string> } = {}): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'stem-remote-'));
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
    env: options.env ?? {},
    settings: {
      pollIntervalMs: 5_000,
      workerLeaseMs: options.workerLeaseMs ?? 60_000,
      jobTimeoutMs: options.jobTimeoutMs ?? 5 * 60_000,
    },
    logger: quietLogger,
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

/** Der echte Worker, ein Durchlauf – derselbe Code wie `--once` auf der Kommandozeile. */
async function runWorker(harness: Harness, extra: { corruptOutput?: string; maxJobs?: number } = {}): Promise<number> {
  return runWorkerCycle(
    {
      root: harness.drive,
      kind: 'folder',
      workDir: path.join(harness.base, 'worker'),
      workerId: 'test-worker',
      once: true,
      pollMs: 1_000,
      maxJobs: extra.maxJobs ?? 4,
      allowPipelineDouble: true,
      quiet: true,
      ...(extra.corruptOutput ? { corruptOutput: extra.corruptOutput } : {}),
    },
    harness.transport
  );
}

async function startJob(harness: Harness, trackName = 'nightdrive') {
  return harness.remote.start({ inputPath: harness.originalPath, trackName, profile: PROFILE, modelId: MODEL_ID });
}

async function fingerprint(file: string): Promise<string> {
  const info = await stat(file);
  const bytes = await readFile(file);
  return `${createHash('sha256').update(bytes).digest('hex')}:${info.size}:${info.mtimeMs}`;
}

async function run() {
  // =========================================================================
  console.log('\n[ TEST ] #1 Start: Original read-only, Arbeitskopie im Engine-Ordner, Manifest in der Ablage');
  const h1 = await makeHarness();
  try {
    const before = await fingerprint(h1.originalPath);
    const job = await startJob(h1);
    assert.equal(job.status, 'RUNNING', 'nach erfolgreichem Upload läuft der Job');
    assert.equal(job.modelId, MODEL_ID);
    assert.deepEqual(job.stems, STEMS, 'Stems kommen aus dem Katalog-Deskriptor, nicht aus einer Konstanten');
    assert.equal(job.worker, undefined, 'noch kein Worker');

    const manifest = parseManifest(await readFile(path.join(h1.drive, 'jobs', job.jobId, 'manifest.json'), 'utf8'), job.jobId);
    assert.equal(manifest.status, 'RUNNING');
    assert.equal(manifest.input.sha256.length, 64);
    assert.equal(manifest.input.sampleRate, 44100);
    assert.equal(manifest.input.channels, 2);
    assert.ok(manifest.input.durationSeconds > 1.5 && manifest.input.durationSeconds < 2.5, 'Dauer aus dem WAV-Header');
    const uploaded = await readFile(path.join(h1.drive, manifest.input.relativePath));
    assert.equal(uploaded.byteLength, manifest.input.bytes, 'die Arbeitskopie liegt vollständig in der Ablage');

    const record = JSON.parse(await readFile(path.join(h1.root, 'RemoteJobs', `${job.jobId}.json`), 'utf8')) as {
      workingCopyPath: string;
      workingCopySha256: string;
      originalPath: string;
      originalSha256: string;
    };
    assert.ok(record.workingCopyPath.startsWith(path.join(h1.root, 'Working', 'remote')), 'Arbeitskopie liegt im Engine-Datenordner');
    assert.equal(record.workingCopySha256, manifest.input.sha256);
    assert.equal(record.originalPath, h1.originalPath);
    assert.equal(await fingerprint(h1.originalPath), before, 'Original bitgleich: sha256, Größe und mtime (§31)');
    console.log(`  ✓ Job ${job.jobId.slice(0, 8)}… veröffentlicht, Original-Hash unverändert`);

    // =====================================================================
    console.log('\n[ TEST ] #2 §19/§33: identischer Input erzeugt keinen zweiten Job');
    const duplicate = await startJob(h1);
    assert.equal(duplicate.jobId, job.jobId, 'derselbe Job statt eines zweiten Laufs');
    assert.equal((await readdir(path.join(h1.drive, 'jobs'))).length, 1, 'in der Ablage liegt genau ein Job');
    assert.equal((await readdir(path.join(h1.root, 'RemoteJobs'))).filter((entry) => entry.endsWith('.json')).length, 1);
    console.log('  ✓ zweiter Klick/Neustart trifft den vorhandenen Job (ein Upload, ein Lauf)');

    // =====================================================================
    console.log('\n[ TEST ] #3 Ende-zu-Ende: Worker rechnet, Editor prüft und importiert');
    const processed = await runWorker(h1);
    assert.equal(processed, 1, 'der Worker hat genau einen Job abgeschlossen');
    const workerManifest = parseManifest(await readFile(path.join(h1.drive, 'jobs', job.jobId, 'manifest.json'), 'utf8'), job.jobId);
    assert.equal(workerManifest.status, 'COMPLETED');
    assert.deepEqual(workerManifest.output.stems.map((stem) => stem.id), STEMS);
    assert.equal(workerManifest.worker?.id, 'test-worker');

    const status = await h1.remote.poll();
    const done = status.jobs.find((entry) => entry.jobId === job.jobId)!;
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.localJobId, job.jobId, 'die Stems liegen unter derselben Job-Id im Editor');
    assert.deepEqual(done.stems, STEMS);

    const localView = h1.local.getJob(job.jobId);
    assert.ok(localView, 'der Fern-Job ist im lokalen Job-Register sichtbar');
    assert.equal(localView?.status, 'COMPLETED');
    for (const stemId of STEMS) {
      const bytes = await h1.local.stemBytes(job.jobId, stemId as never);
      const decoded = decodeWav(new Uint8Array(bytes));
      assert.equal(decoded.sampleRate, 44100);
      assert.equal(decoded.channels, 2);
      assert.ok(decoded.frames > 0, `Stem ${stemId} enthält Audio`);
    }
    assert.equal(await fingerprint(h1.originalPath), before, 'auch nach Import und Rechenlauf ist das Original unverändert');
    console.log('  ✓ 4 Stems importiert und dekodierbar, Original-Hash stabil, Job-Id bleibt die Fern-Id');

    // =====================================================================
    console.log('\n[ TEST ] #4 Worker ist idempotent: COMPLETED wird nicht neu gerechnet');
    const second = await runWorker(h1);
    assert.equal(second, 0, 'ein fertiger Job wird beim zweiten Durchlauf übersprungen (§19)');
    console.log('  ✓ zweiter Worker-Durchlauf verarbeitet nichts erneut');
  } finally {
    await h1.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #5 §21 A/§32: Editor-Neustart holt das fertige Ergebnis nach');
  const h2 = await makeHarness();
  try {
    const job = await startJob(h2, 'restart');
    await runWorker(h2);
    // Editor „stürzt ab“, bevor er gepollt hat: neuer Dienst auf demselben Ordner.
    h2.remote.dispose();
    const restarted = new RemoteStemJobService({
      root: h2.root,
      localService: h2.local,
      transport: h2.transport,
      allowPipelineDouble: true,
      disableBackgroundPolling: true,
      env: {},
      logger: quietLogger,
    });
    const resumed = await restarted.resume();
    const view = resumed.jobs.find((entry) => entry.jobId === job.jobId)!;
    assert.equal(view.status, 'COMPLETED');
    assert.equal(view.localJobId, job.jobId, 'das fertige Ergebnis wird beim Neustart importiert');
    assert.ok(h2.local.getJob(job.jobId), 'Stems sind nach dem Neustart im Editor lesbar');
    restarted.dispose();
    console.log('  ✓ Neustart importiert ohne Zutun des Nutzers, ohne zweiten Job');
  } finally {
    await h2.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #6 §34 I/J/K: fehlende und beschädigte Stems ⇒ FAILED, nie COMPLETED');
  const h3 = await makeHarness();
  try {
    const missing = await startJob(h3, 'missing');
    await runWorker(h3);
    const missingPath = path.join(h3.drive, 'jobs', missing.jobId, 'manifest.json');
    const rawManifest = parseManifest(await readFile(missingPath, 'utf8'), missing.jobId);
    await writeFile(
      missingPath,
      serializeManifest({ ...rawManifest, output: { stems: rawManifest.output.stems.filter((stem) => stem.id !== 'bass') } })
    );
    await h3.remote.poll();
    const missingView = h3.remote.get(missing.jobId)!;
    assert.equal(missingView.status, 'FAILED', 'unvollständiges Ergebnis darf nicht COMPLETED werden');
    assert.equal(missingView.error?.code, 'REMOTE_OUTPUT_INCOMPLETE');
    assert.match(missingView.error?.message ?? '', /bass/);
    assert.equal(h3.local.getJob(missing.jobId), null, 'kein Stem-Eintrag für einen abgelehnten Job');
    console.log(`  ✓ fehlender Stem ⇒ ${missingView.error?.code}: ${missingView.error?.message}`);

    // Beschädigter Output: der Worker baut den Defekt selbst ein (--corrupt-output).
    const corrupt = await startJob(h3, 'corrupt');
    await runWorker(h3, { corruptOutput: 'vocals' });
    await h3.remote.poll();
    const corruptView = h3.remote.get(corrupt.jobId)!;
    assert.equal(corruptView.status, 'FAILED', 'beschädigter Stem wird nicht importiert');
    assert.ok(
      ['REMOTE_OUTPUT_INVALID', 'REMOTE_OUTPUT_HASH_MISMATCH', 'REMOTE_OUTPUT_EMPTY', 'REMOTE_OUTPUT_MISSING'].includes(
        corruptView.error?.code ?? ''
      ),
      `unerwarteter Code: ${corruptView.error?.code}`
    );
    assert.equal(h3.local.getJob(corrupt.jobId), null);
    console.log(`  ✓ beschädigter Stem ⇒ ${corruptView.error?.code}: ${corruptView.error?.message}`);
  } finally {
    await h3.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #7 §21 C: Ablage nicht erreichbar ⇒ Job bleibt aktiv');
  const h4 = await makeHarness();
  try {
    const job = await startJob(h4, 'offline');
    await rm(h4.drive, { recursive: true, force: true });
    const offline = await h4.remote.poll();
    assert.equal(offline.reachable, false, 'der Transport meldet sich als nicht erreichbar');
    const view = offline.jobs.find((entry) => entry.jobId === job.jobId)!;
    assert.equal(view.status, 'RUNNING', 'ein Transportausfall ist kein Job-Fehler');
    assert.equal(view.transportDegraded, true, 'aber sichtbar für die UI');
    // Ablage kommt zurück: der Editor veröffentlicht denselben Job erneut
    // (gleiche Job-Id, gleiche Bytes) und der Worker rechnet ihn fertig.
    await mkdir(h4.drive, { recursive: true });
    const recovered = await h4.remote.poll();
    assert.equal(recovered.reachable, true, 'die Ablage ist wieder erreichbar');
    assert.equal(recovered.jobs.find((entry) => entry.jobId === job.jobId)?.transportDegraded ?? false, false);
    assert.equal((await readdir(path.join(h4.drive, 'jobs'))).length, 1, 'es bleibt bei einem Job');
    await runWorker(h4);
    const online = await h4.remote.poll();
    assert.equal(online.jobs.find((entry) => entry.jobId === job.jobId)?.status, 'COMPLETED');
    console.log('  ✓ Ausfall ⇒ transportDegraded, danach wird derselbe Job erneut veröffentlicht und fertig gerechnet');
  } finally {
    await h4.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #8 §21 E: kein Worker ⇒ Zeitüberschreitung mit Grund in der Ablage');
  const h5 = await makeHarness({ jobTimeoutMs: 1 });
  try {
    const job = await startJob(h5, 'timeout');
    await h5.remote.poll();
    const view = h5.remote.get(job.jobId)!;
    assert.equal(view.status, 'FAILED');
    assert.equal(view.error?.code, 'REMOTE_TIMEOUT');
    const errorFile = JSON.parse(await readFile(path.join(h5.drive, 'jobs', job.jobId, 'error.json'), 'utf8')) as { code: string; message: string };
    assert.equal(errorFile.code, 'REMOTE_TIMEOUT');
    assert.match(errorFile.message, /kein Ergebnis|Zeit/);
    const manifest = parseManifest(await readFile(path.join(h5.drive, 'jobs', job.jobId, 'manifest.json'), 'utf8'), job.jobId);
    assert.equal(manifest.status, 'FAILED', 'die Ablage erfährt vom Scheitern');
    console.log(`  ✓ Timeout ⇒ ${view.error?.code} in Editor und Ablage`);
  } finally {
    await h5.dispose();
  }

  // =========================================================================
  console.log('\n[ TEST ] #9 §37: Abbruch gewinnt – spätes Worker-Ergebnis wird verworfen');
  const h6 = await makeHarness();
  try {
    const job = await startJob(h6, 'cancelled');
    const accepted = await h6.remote.cancel(job.jobId, 'Testabbruch');
    assert.equal(accepted.accepted, true);
    assert.equal(h6.remote.get(job.jobId)?.status, 'CANCELLED');
    assert.equal(await h6.remote.cancel(job.jobId).then((result) => result.accepted), false, 'zweiter Abbruch ist wirkungslos');
    const flag = await readFile(path.join(h6.drive, 'jobs', job.jobId, 'cancel.flag'), 'utf8');
    assert.match(flag, /Testabbruch/, 'der Worker erfährt vom Abbruch');

    // Der Worker sieht die Fahne und setzt CANCELLED, statt zu rechnen.
    await runWorker(h6);
    const manifest = parseManifest(await readFile(path.join(h6.drive, 'jobs', job.jobId, 'manifest.json'), 'utf8'), job.jobId);
    assert.equal(manifest.status, 'CANCELLED');
    await h6.remote.poll();
    const view = h6.remote.get(job.jobId)!;
    assert.equal(view.status, 'CANCELLED', 'ein abgebrochener Job wird nie COMPLETED');
    assert.equal(h6.local.getJob(job.jobId), null, 'und es wird nichts importiert');
    console.log('  ✓ Abbruch bleibt Abbruch, Worker respektiert die Fahne');
  } finally {
    await h6.dispose();
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  ALLE FERN-JOB-PRÜFUNGEN BESTANDEN');
  console.log('═══════════════════════════════════════════════════════════════════');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
