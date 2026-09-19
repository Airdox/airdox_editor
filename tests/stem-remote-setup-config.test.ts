/**
 * EXTERNE ZERLEGUNG – EINRICHTUNG & VERKNÜPFUNG (Button → Google Drive → Colab).
 *
 * Der Button „Externe Zerlegung (Google Colab)" startet exakt diesen Weg:
 *   1. Jobablage einrichten (Drive-Ordner) – configure() + Persistenz
 *   2. Arbeitskopie nach Google Drive (Upload) + Job-Steckbrief (Manifest)
 *   3. Übergabe an den Colab-Worker – derselbe Code wie im Notebook
 *      (`runWorkerCycle` = `stem-remote-worker --once`)
 *   4. Ergebnis kommt zurück – Editor prüft, speichert die Stems dauerhaft
 *      und verknüpft den Import mit dem lokalen Job-Pfad
 *
 * Und die Kerngarantie: Das Original bleibt byte-identisch – der Editor
 * schreibt ausschließlich in seinen eigenen Datenordner und in die Ablage
 * (rekordbox.xml / master.db kommen auf diesem Weg gar nicht vor).
 *
 * Bewusst unabhängig von der großen Fern-Job-Suite: hier wird der
 * EINRICHTUNGS-Workflow geprüft (configure → Upload → Worker → Import),
 * die Fehlerfall-Matrix (§21) lebt in stem-remote-job-service.test.ts.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StemJobService } from '../src/stems/stemJobService';
import { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';
import { FolderTransport, REMOTE_TRANSPORT_MISSING } from '../src/stems/remote/transport';
import { RemoteProtocolError } from '../src/stems/remote/manifest';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';
import { runWorkerCycle } from '../scripts/stem-remote-worker';

console.log('═══════════════════════════════════════════════════════════════');
console.log('  EXTERNE ZERLEGUNG – EINRICHTUNG, DRIVE-UPLOAD, VERKNÜPFUNG     ');
console.log('═══════════════════════════════════════════════════════════════');

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

/**
 * Dienst ohne injiziertem Transport beim Konfigurieren: `configure()` muss
 * die Einstellungen wie die App persistieren (Datei + erneuter Read). Der
 * Upload-/Worker-Test nutzt dieselbe Harness über `harness.transport`.
 */
async function makeHarness(): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'stem-remote-setup-'));
  const root = path.join(base, 'engine');
  const drive = path.join(base, 'drive');
  const worker = path.join(base, 'worker');
  await mkdir(root, { recursive: true });
  await mkdir(drive, { recursive: true });
  await mkdir(worker, { recursive: true });
  const track = generateEdmTestTrack({ seconds: 2 });
  const written = await writeTestAudio(path.join(base, 'Original'), 'edm_mix', track);
  const local = new StemJobService({ root, allowPipelineDouble: true, chunkSizeSamples: 44100, logger: quietLogger });
  const transport = new FolderTransport({ root: drive });
  const remote = new RemoteStemJobService({
    root,
    localService: local,
    allowPipelineDouble: true,
    disableBackgroundPolling: true,
    env: {},
    settings: { pollIntervalMs: 5_000, workerLeaseMs: 60_000, jobTimeoutMs: 5 * 60_000 },
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

function sha256Of(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Der echte Worker, ein Durchlauf – derselbe Code wie das Colab-Notebook. */
async function runWorker(harness: Harness): Promise<number> {
  return runWorkerCycle(
    {
      root: harness.drive,
      kind: 'folder',
      workDir: path.join(harness.base, 'worker'),
      workerId: 'test-colab',
      once: true,
      pollMs: 1_000,
      maxJobs: 4,
      allowPipelineDouble: true,
      quiet: true,
    },
    harness.transport
  );
}

const tests: { name: string; run: (h: Harness) => Promise<void> }[] = [];
const test = (name: string, run: (h: Harness) => Promise<void>) => tests.push({ name, run });

test('[1] Ohne Einrichtung: configured=false, klarer Grund, Start lehnt strukturiert ab', async (h) => {
  const status = await h.remote.status();
  assert.equal(status.configured, false, 'Ohne Ablage ist nichts konfiguriert');
  assert.equal(status.reachable, false, 'Nichts konfiguriert ⇒ nichts erreichbar');
  assert.ok(
    /Google-Drive|Ablageordner|konfiguriert/i.test(status.reason ?? ''),
    `Grund muss die fehlende Einrichtung benennen (war: ${status.reason})`
  );

  const mix = await readFile(h.originalPath);
  await assert.rejects(
    () => h.remote.start({ bytes: mix, trackName: 'edm_mix', profile: PROFILE, modelId: MODEL_ID }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteProtocolError, `Erwartet RemoteProtocolError, bekam ${error?.constructor?.name}`);
      assert.equal((error as RemoteProtocolError).code, REMOTE_TRANSPORT_MISSING, 'Stabiler Fehlercode');
      assert.match((error as RemoteProtocolError).message, /konfiguriert|Ablageordner/i);
      return true;
    }
  );
  console.log('  ✓ configured=false mit verständlichem Grund; start() lehnt mit REMOTE_TRANSPORT_MISSING ab');
});

test('[2] Einrichtung Drive-Ordner: configured=true, erreichbar, Label, Datei persistiert', async (h) => {
  const status = await h.remote.configure({ kind: 'folder', root: h.drive });
  assert.equal(status.configured, true, 'Ordner-Ablage ist konfiguriert');
  assert.equal(status.reachable, true, 'Existierender Ordner ist erreichbar');
  assert.equal(status.kind, 'folder');
  assert.equal(status.label, 'Google Drive (Ordner)');
  assert.ok(status.root?.includes('drive'), 'Status zeigt das Ziel');

  // Persistiert unter RemoteJobs/settings.json – die App liest das nach Neustart.
  const settingsFile = path.join(h.root, 'RemoteJobs', 'settings.json');
  const saved = JSON.parse(await readFile(settingsFile, 'utf8')) as { kind?: string; root?: string };
  assert.equal(saved.kind, 'folder');
  assert.ok(saved.root && saved.root.length > 0, 'Root in der Einstellungsdatei');
  console.log('  ✓ configure() → configured=true, reachable=true, settings.json geschrieben');
});

test('[3] Neue Instanz liest die Einrichtung (Editor-Neustart, §32)', async (h) => {
  await h.remote.configure({ kind: 'folder', root: h.drive });
  // Eine frische Instanz ohne Settings-Overrides muss denselben Zustand
  // aus der Datei finden – der Editor-Neustart verliert die Einrichtung nicht.
  const fresh = new RemoteStemJobService({
    root: h.root,
    localService: h.local,
    allowPipelineDouble: true,
    disableBackgroundPolling: true,
    env: {},
    logger: quietLogger,
  });
  try {
    const status = await fresh.status();
    assert.equal(status.configured, true, 'Einrichtung überlebt den Neustart');
    assert.equal(status.reachable, true, 'Ordner ist für die neue Instanz erreichbar');
    assert.equal(status.kind, 'folder');
  } finally {
    fresh.dispose();
  }
  console.log('  ✓ Neue Instanz: configured=true aus der gespeicherten Einstellung');
});

test('[4] Fehlender Ordner: konfiguriert, aber nicht erreichbar – Job wartet, kein Job-Fehler', async (h) => {
  const missing = path.join(h.base, 'existiert-nicht');
  const status = await h.remote.configure({ kind: 'folder', root: missing });
  assert.equal(status.configured, true, 'Die Einstellung selbst ist gültig');
  assert.equal(status.reachable, false, 'Fehlender Ordner ist nicht erreichbar');
  assert.match(status.reason ?? '', /nicht erreichbar|Google-Drive/i);

  // Der Upload wiederholt sich automatisch (§21 B): der Job bleibt PREPARING
  // mit transportDegraded – kein FAILED, kein Datenverlust.
  const mix = await readFile(h.originalPath);
  const job = await h.remote.start({ bytes: mix, trackName: 'edm_mix', profile: PROFILE, modelId: MODEL_ID });
  assert.equal(job.status, 'PREPARING', 'Ohne erreichbare Ablage bleibt der Job aktiv');
  assert.equal(job.transportDegraded, true, 'Transportausfall ist kein Job-Aus');
  assert.equal(job.error?.code, 'REMOTE_UNREACHABLE');
  console.log('  ✓ Fehlender Ordner: Job bleibt aktiv (PREPARING, transportDegraded)');
});

test('[5] rclone-Transport: gültiges Ziel, Meldung benennt rclone', async (h) => {
  const status = await h.remote.configure({ kind: 'rclone', root: 'gdrive:airdox-stem-jobs' });
  assert.equal(status.configured, true, 'rclone-Remote ist als Ziel gültig');
  assert.equal(status.kind, 'rclone');
  if (status.reachable) {
    console.log('  ✓ rclone-Remote konfiguriert und erreichbar');
  } else {
    assert.match(status.reason ?? '', /rclone/i, 'Grund muss rclone benennen');
    console.log('  ✓ rclone-Remote konfiguriert; Binary/Remote nicht da – Grund benennt rclone');
  }
});

test('[6] Der Upload nach Google Drive: Arbeitskopie + Manifest in der Ablage, Original unangetastet', async (h) => {
  await h.remote.configure({ kind: 'folder', root: h.drive });
  const before = sha256Of(await readFile(h.originalPath));
  const mix = await readFile(h.originalPath);

  const job = await h.remote.start({ bytes: mix, trackName: 'edm_mix', profile: PROFILE, modelId: MODEL_ID });
  assert.equal(job.status, 'RUNNING', 'Nach dem Upload wartet der Job auf den Worker');

  // Die Ablage enthält genau den Job mit Arbeitskopie und Steckbrief.
  const jobsDir = path.join(h.drive, 'jobs');
  const entries = await readdir(jobsDir);
  assert.deepEqual(entries, [job.jobId], `Ablage: genau ein Job-Ordner (war: ${entries.join(', ')})`);
  const inputPath = path.join(jobsDir, job.jobId, 'input', 'edm_mix.wav');
  const uploaded = await readFile(inputPath);
  assert.equal(uploaded.byteLength, mix.byteLength, 'Arbeitskopie hat dieselbe Größe wie der Mix');
  assert.equal(sha256Of(uploaded), sha256Of(mix), 'Arbeitskopie ist bit-identisch zum Mix');
  const manifestRaw = await readFile(path.join(jobsDir, job.jobId, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as { jobId?: string; status?: string; input?: { sha256?: string } };
  assert.equal(manifest.jobId, job.jobId, 'Steckbrief trägt dieselbe Job-Id');
  assert.equal(manifest.status, 'RUNNING', 'Ablage zeigt RUNNING – Worker erkennt den fertigen Upload');
  assert.equal(manifest.input?.sha256, sha256Of(mix), 'Manifest vermerkt den Input-Hash');

  // Und das Original: byte-identisch – der Editor hat es nie geöffnet zum Schreiben.
  const after = sha256Of(await readFile(h.originalPath));
  assert.equal(before, after, 'Original bleibt byte-identisch (read-only)');
  console.log('  ✓ Upload: Arbeitskopie + Manifest in jobs/<id>/, Original unverändert');
});

test('[7] Idempotenz: zweiter Klick mit demselben Input ⇒ kein zweiter Job', async (h) => {
  await h.remote.configure({ kind: 'folder', root: h.drive });
  const mix = await readFile(h.originalPath);
  const first = await h.remote.start({ bytes: mix, trackName: 'edm_mix', profile: PROFILE, modelId: MODEL_ID });
  const again = await h.remote.start({ bytes: mix, trackName: 'edm_mix', profile: PROFILE, modelId: MODEL_ID });
  const jobs = h.remote.list();
  assert.equal(jobs.length, 1, 'Nur ein Job für dieselbe Arbeit (§19)');
  assert.equal(again.jobId, first.jobId, 'Zweiter Start liefert denselben Job zurück');
  console.log('  ✓ Zweiter Start ⇒ Wiederverwendung, kein doppeltes Rechnen');
});

test('[8] Der komplette Rückweg: Colab-Worker rechnet, Editor importiert und verknüpft', async (h) => {
  await h.remote.configure({ kind: 'folder', root: h.drive });
  const before = sha256Of(await readFile(h.originalPath));
  const job = await h.remote.start({ bytes: await readFile(h.originalPath), trackName: 'edm_mix', profile: PROFILE, modelId: MODEL_ID });
  assert.equal(job.status, 'RUNNING');

  // Übergabe an Colab: derselbe Worker-Code, den das Notebook aufruft.
  const processed = await runWorker(h);
  assert.ok(processed >= 1, `Worker hat den Job bearbeitet (bearbeitet: ${processed})`);

  // Editor-Seite: Poll erkennt COMPLETED, prüft die Stems und importiert.
  await h.remote.poll();
  const imported = h.remote.list().find((entry) => entry.jobId === job.jobId);
  assert.ok(imported, 'Job bleibt in der Liste');
  assert.equal(imported?.status, 'COMPLETED', 'Editor bestätigt nur nach Prüfung COMPLETED');
  assert.ok(imported?.localJobId, 'Import ist mit einem lokalen Job verknüpft');
  assert.deepEqual(
    (imported?.importedStems ?? []).map((stem) => stem.id).sort(),
    [...STEMS].sort(),
    'Alle 4 Stems importiert'
  );

  // Der lokale Job-Service kennt das Ergebnis über denselben Pfad wie lokal.
  const localJob = h.local.getJob(imported!.localJobId!);
  assert.ok(localJob, 'Lokaler Job existiert');
  assert.equal(localJob.status, 'COMPLETED');
  const result = localJob.result;
  assert.ok(result, 'Lokaler Job trägt ein Ergebnis');
  assert.equal(result?.stems.length, 4, '4 Stems im lokalen Ergebnis');
  for (const stem of result!.stems) {
    const info = await stat(stem.filePath);
    assert.ok(info.size > 44, `Stem-Datei ${stem.id} liegt dauerhaft auf Platte (${info.size} Byte)`);
  }

  // Die Kerngarantie am Ende des ganzen Weges erneut nachgewiesen.
  const after = sha256Of(await readFile(h.originalPath));
  assert.equal(before, after, 'Original bleibt über den gesamten Lauf unverändert');
  console.log('  ✓ Rückweg: Worker → Poll → Prüfung → dauerhafte Stems → lokaler Job-Verknüpfung');
});

/* Lauf: jede Prüfung mit eigener Harness (unabhängig, sauber aufzuräumen). */
let failed = 0;
for (const entry of tests) {
  const harness = await makeHarness();
  try {
    await entry.run(harness);
  } catch (error) {
    failed += 1;
    console.error(`  ✘ FEHLER: ${entry.name}`);
    console.error(`    ${(error as Error).stack?.split('\n').slice(0, 3).join('\n    ') ?? error}`);
  } finally {
    await harness.dispose();
  }
}

if (failed > 0) {
  console.error(`\n${failed} von ${tests.length} Prüfungen fehlgeschlagen`);
  process.exit(1);
}
console.log(`\n✔ Alle ${tests.length} Prüfungen bestanden (Einrichtung → Drive → Worker → Import).`);
