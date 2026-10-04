#!/usr/bin/env tsx
/**
 * airdox_SMART_Editor – High-Quality-Fernworker (Node).
 *
 * Derselbe Job, dieselbe Ablage, dasselbe Protokoll wie der Colab-Worker
 * (`colab/remote_worker.py`): Job in der Ablage finden → beanspruchen (Lease)
 * → Input-Hash prüfen → mit der High-Quality-Engine rechnen → Stems + Hashes
 * zurückschreiben → Status setzen.
 *
 * Wozu ein zweiter Worker?
 *  - Auf einem Studio-/Büro-Rechner (oder im CI) lässt sich der komplette
 *    Fernpfad damit **ohne Colab** durchspielen: echter Transport, echte
 *    Dateien, echtes Manifest, echte Idempotenz, echter Import in den Editor.
 *  - Der Python-Worker in Colab nutzt den vorhandenen Adapter
 *    (`python/bsroformer_inference.py`) und ist der GPU-Pfad für unterwegs.
 *  Beide sind nur Rechenknechte – die Editorlogik bleibt im Editor (§24, §42).
 *
 * Aufruf:
 *   npx tsx scripts/stem-remote-worker.ts --root "/Pfad/zum/Drive-Ordner" --once
 *   npx tsx scripts/stem-remote-worker.ts --root "gdrive:airdox-stem-jobs" --poll 15000
 *
 * Ohne `--once` läuft der Worker als Schleife und ist damit die zweite Hälfte
 * eines echten End-to-End-Tests (Editor schreibt, Worker rechnet, Editor lädt).
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { createTransport, type IRemoteTransport } from '../src/stems/remote/transport';
import { jobCancelPath, jobClaimPath, jobOutputPath, jobResultPath, jobWorkerLogPath, jobWorkerTracePath, stemFileName } from '../src/stems/remote/layout';
import {
  buildResultDocument,
  isTerminalStatus,
  parseManifest,
  serializeManifest,
  withStatus,
} from '../src/stems/remote/manifest';
import type { RemoteJobManifest, RemoteJobTraceEvent } from '../src/stems/remote/types';
import { StemJobService } from '../src/stems/stemJobService';
import { analyzeAudio, decodeWav, parseWavLayout } from '../src/stems/wavIo';
import { QUALITY_PROFILES, type ComputeDevice, type QualityProfile } from '../src/stems/types';

/** Standard: alle 5 s in die Ablage schauen – schnell genug für einen Klick. */
const DEFAULT_CANCEL_POLL_MS = 5_000;

/** Kopfdaten + Pegel einer Stem-Datei – für Manifest und Selbstkontrolle. */
function inspectStemWav(bytes: Uint8Array): { frames: number; sampleRate: number; channels: number; peak: number } {
  const layout = parseWavLayout(bytes);
  const decoded = decodeWav(bytes);
  const stats = analyzeAudio(decoded.data, decoded.channels, decoded.frames);
  return { frames: decoded.frames, sampleRate: layout.sampleRate, channels: layout.channels, peak: stats.peak };
}

interface WorkerOptions {
  root: string;
  kind: 'folder' | 'rclone';
  workDir: string;
  workerId: string;
  once: boolean;
  pollMs: number;
  modelId?: string;
  profile?: string;
  device?: string;
  modelDir?: string;
  maxJobs: number;
  allowPipelineDouble: boolean;
  quiet: boolean;
  /** Millisekunden zwischen Abbruch-Prüfungen während der Rechnung (§37). */
  cancelPollMs?: number;
  /** Testhaken: nach der Separation absichtlich einen Defekt einbauen. */
  corruptOutput?: string;
}

function parseArgs(argv: string[]): WorkerOptions {
  const options: WorkerOptions = {
    root: process.env.AIRODOX_STEM_REMOTE_DIR ?? '',
    kind: process.env.AIRODOX_STEM_REMOTE_KIND === 'rclone' ? 'rclone' : 'folder',
    workDir: path.join(os.tmpdir(), 'airdox-remote-worker'),
    workerId: `node-${os.hostname()}-${process.pid}`,
    once: false,
    pollMs: 15_000,
    maxJobs: Number.POSITIVE_INFINITY,
    allowPipelineDouble: false,
    quiet: false,
    cancelPollMs: Number(process.env.AIRODOX_STEM_CANCEL_POLL_MS ?? 5000),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--root':
        options.root = next();
        break;
      case '--kind':
        options.kind = next() === 'rclone' ? 'rclone' : 'folder';
        break;
      case '--workdir':
        options.workDir = next();
        break;
      case '--worker':
        options.workerId = next();
        break;
      case '--once':
        options.once = true;
        break;
      case '--poll':
        options.pollMs = Number(next());
        break;
      case '--model':
        options.modelId = next();
        break;
      case '--profile':
        options.profile = next();
        break;
      case '--device':
        options.device = next();
        break;
      case '--model-dir':
        options.modelDir = next();
        break;
      case '--max-jobs':
        options.maxJobs = Number(next());
        break;
      case '--allow-pipeline-double':
        options.allowPipelineDouble = true;
        break;
      case '--corrupt-output':
        options.corruptOutput = next();
        break;
      case '--cancel-poll':
        options.cancelPollMs = Math.max(500, Number(next()));
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        console.log('airdox Fernworker – Optionen: --root --kind --workdir --worker --once --poll --model --profile --device --model-dir --max-jobs --allow-pipeline-double --corrupt-output --cancel-poll --quiet');
        process.exit(0);
        break;
      default:
        break;
    }
  }
  if (!options.root) {
    console.error('[STEM-REMOTE-WORKER] Kein Ziel angegeben. --root "<Drive-Ordner>" oder AIRODOX_STEM_REMOTE_DIR setzen.');
    process.exit(2);
  }
  return options;
}

function log(options: WorkerOptions, message: string): void {
  if (!options.quiet) console.log(`[STEM-REMOTE-WORKER] ${message}`);
}

/** Wie viele Zeilen eine Protokolldatei höchstens behält (ältere fallen weg). */
const MAX_TRACE_FILE_LINES = 200;

/**
 * Anhänge an dieselbe Datei müssen **hintereinander** laufen.
 *
 * Der Anhang ist ein Lesen-Anhängen-Schreiben: erst der ganze Inhalt, dann
 * eine Zeile mehr zurück. Laufen zwei solcher Vorgänge gleichzeitig – etwa
 * eine Fortschrittsmeldung parallel zu „Inferenz gestartet“ –, liest der
 * zweite den Stand **vor** der ersten Zeile und schreibt ihn zurück: die
 * erste Zeile ist weg.
 *
 * Genau solche Lücken machen einen hängenden Lauf später unerklärlich, und
 * unter Last traf es in der CI `worker.inference_started`. Deshalb hängt
 * jede Datei an ihrer eigenen Kette; der Aufrufer darf weiterhin parallel
 * melden, die Reihenfolge bleibt dabei erhalten.
 */
const appendChains = new WeakMap<IRemoteTransport, Map<string, Promise<unknown>>>();

export async function appendCappedLine(transport: IRemoteTransport, relative: string, line: string): Promise<void> {
  let chains = appendChains.get(transport);
  if (!chains) {
    chains = new Map<string, Promise<unknown>>();
    appendChains.set(transport, chains);
  }
  const previous = chains.get(relative) ?? Promise.resolve();
  // Auch nach einem fehlgeschlagenen Vorgang muss die Kette weiterlaufen,
  // sonst bliebe die Datei dauerhaft blockiert.
  const next = previous.then(
    () => writeCappedLine(transport, relative, line),
    () => writeCappedLine(transport, relative, line)
  );
  chains.set(relative, next.catch(() => undefined));
  return next;
}

async function writeCappedLine(transport: IRemoteTransport, relative: string, line: string): Promise<void> {
  const current = (await transport.readText(relative)) ?? '';
  const lines = current.split(/\r?\n/).filter(Boolean);
  lines.push(line);
  await transport.writeText(relative, `${lines.slice(-MAX_TRACE_FILE_LINES).join('\n')}\n`);
}

async function logJobEvent(
  options: WorkerOptions,
  transport: IRemoteTransport,
  jobId: string,
  step: string,
  message: string,
  fields: Partial<Pick<RemoteJobTraceEvent, 'status' | 'phase' | 'code' | 'percent' | 'device'>> = {},
  level: RemoteJobTraceEvent['level'] = 'info'
): Promise<void> {
  const at = Date.now();
  const event: RemoteJobTraceEvent = {
    id: randomUUID(),
    source: 'worker',
    jobId,
    at,
    step,
    level,
    message: message.slice(0, 400),
    workerId: options.workerId,
    ...fields,
  };
  try {
    await appendCappedLine(transport, jobWorkerTracePath(jobId), JSON.stringify(event));
    await appendCappedLine(transport, jobWorkerLogPath(jobId), `${new Date(at).toISOString()} step=${step} ${event.message}`);
  } catch {
    // Diagnose-Dateien dürfen den Rechenjob nicht stoppen.
    log(options, `jobId=${jobId} step=worker.trace_write_failed`);
  }
  log(options, `jobId=${jobId} step=${step} ${event.message}`);
}

async function sha256Of(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

/**
 * Prüft, ob ein Job schon von einem **aktiven** anderen Worker beansprucht ist.
 * Ohne diese Prüfung würden zwei Colab-Instanzen denselben Track parallel
 * rechnen (§19, §33) – doppelte GPU-Stunden, zwei Ergebnisse.
 */
async function claimIsFresh(transport: IRemoteTransport, jobId: string, leaseMs: number): Promise<boolean> {
  const raw = await transport.readText(jobClaimPath(jobId));
  if (!raw) return false;
  try {
    const claim = JSON.parse(raw) as { id?: string; heartbeatAt?: number; claimedAt?: number };
    const stamp = claim.heartbeatAt ?? claim.claimedAt ?? 0;
    return Date.now() - stamp < leaseMs;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hält Ausschau nach `cancel.flag`, **während** der Worker rechnet.
 *
 * Vorher wurde die Fahne nur vor dem Start eines Jobs gesehen. Ein Abbruch
 * mitten in der (Stunden langen) High-Quality-Rechnung lief因此 weiter: der
 * Nutzer sah nach dem Klick keine Veränderung – „drücken, was man will, es
 * passiert nichts“. Jetzt beendet der Watchdog die lokale Rechnung und der
 * Job wird als CANCELLED abgeschlossen.
 */
class CancelWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  private hit = false;

  constructor(
    private readonly transport: IRemoteTransport,
    private readonly jobId: string,
    private readonly intervalMs: number
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.check().catch(() => undefined);
    }, Math.max(500, this.intervalMs));
    this.timer.unref?.();
  }

  get triggered(): boolean {
    return this.hit;
  }

  /** Ein Blick in die Ablage. Transportstörung ist kein Abbruch. */
  async check(): Promise<boolean> {
    try {
      if (await this.transport.exists(jobCancelPath(this.jobId))) this.hit = true;
    } catch {
      /* kurze Drive-Sperre – beim nächsten Takt erneut prüfen */
    }
    return this.hit;
  }

  /** Nahm der Editor die Abbruchbitte ab, darf die Fahne den nächsten Lauf nicht ersticken. */
  async consume(): Promise<void> {
    await this.transport.remove(jobCancelPath(this.jobId)).catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Wartet auf die Separation und gibt sie nur zurück, wenn kein Abbruch
 * dazwischenkam. Bei Abbruch wird der lokale Abbruch-Token ausgelöst, damit
 * die Engine sofort aufhört und nicht bis zum Ende rechnet.
 */
async function waitForSeparation(
  service: StemJobService,
  localJobId: string,
  watch: CancelWatch,
  pollMs: number
): Promise<Awaited<ReturnType<StemJobService['waitFor']>>> {
  const pending = service.waitFor(localJobId);
  for (;;) {
    const winner = await Promise.race([
      pending.then((view) => ({ kind: 'done' as const, view })),
      sleep(Math.max(500, pollMs)).then(() => ({ kind: 'tick' as const })),
    ]);
    if (winner.kind === 'done') return winner.view;
    if (await watch.check()) {
      service.cancel(localJobId, 'Vom Editor abgebrochen (cancel.flag)');
      throw Object.assign(new Error('Der Editor hat den Abbruch verlangt (cancel.flag) – Rechnung beendet.'), {
        code: 'REMOTE_CANCELLED_BY_EDITOR',
      });
    }
  }
}

async function runOneJob(
  options: WorkerOptions,
  transport: IRemoteTransport,
  jobId: string,
  manifest: RemoteJobManifest
): Promise<'completed' | 'skipped' | 'failed' | 'cancelled'> {
  const manifestRel = `jobs/${jobId}/manifest.json`;
  const cancelPollMs = options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS;
  const watch = new CancelWatch(transport, jobId, cancelPollMs);
  if (isTerminalStatus(manifest.status)) {
    log(options, `Job ${jobId} ist ${manifest.status} – wird nicht erneut gerechnet (§19).`);
    return 'skipped';
  }
  await watch.check();
  if (watch.triggered) {
    log(options, `Job ${jobId} wurde abgebrochen – Status wird gesetzt.`);
    await transport.writeText(
      manifestRel,
      serializeManifest(withStatus(manifest, { status: 'CANCELLED', phase: 'Vom Editor abgebrochen', cancelRequested: true }))
    );
    // Fahne verbrauchen: ein später erneut ausgeschriebener Job mit derselben
    // Id dürfte sonst nie wieder rechnen (§21 B, §37).
    await watch.consume();
    return 'cancelled';
  }

  const claim = {
    id: options.workerId,
    host: os.hostname(),
    claimedAt: Date.now(),
    heartbeatAt: Date.now(),
    device: options.device ?? 'auto',
    version: 'node-worker/1',
  };
  await transport.writeText(jobClaimPath(jobId), `${JSON.stringify(claim, null, 2)}\n`);
  await transport.writeText(
    `jobs/${jobId}/manifest.json`,
    serializeManifest(
      withStatus(manifest, {
        status: 'RUNNING',
        phase: 'Arbeitskopie wird geladen',
        percent: 1,
        attempts: (manifest.attempts ?? 0) + 1,
        worker: claim,
      })
    )
  );
  await logJobEvent(options, transport, jobId, 'worker.job_seen', 'Job in der Ablage gefunden, Worker übernimmt.', {
    status: 'RUNNING',
    phase: 'Job gefunden – Worker übernimmt',
    device: claim.device,
  });
  await logJobEvent(options, transport, jobId, 'worker.claimed', 'Worker hat den Job beansprucht.', {
    status: 'RUNNING',
    phase: 'Arbeitskopie wird geladen',
    percent: 1,
    device: claim.device,
  });

  watch.start();
  const heartbeat = setInterval(() => {
    claim.heartbeatAt = Date.now();
    void transport.writeText(jobClaimPath(jobId), `${JSON.stringify(claim, null, 2)}\n`).catch(() => undefined);
  }, 60_000);
  heartbeat.unref?.();

  const jobWorkDir = path.join(options.workDir, jobId);
  try {
    // ---- Input: Arbeitskopie der Arbeitskopie, Hash verifizieren (§22) -----
    await mkdir(jobWorkDir, { recursive: true });
    const bytes = await transport.readBytes(manifest.input.relativePath);
    if (!bytes) throw Object.assign(new Error(`Eingabedatei fehlt in der Jobablage: ${manifest.input.relativePath}`), { code: 'REMOTE_INPUT_MISSING' });
    const localInput = path.join(jobWorkDir, manifest.input.fileName);
    await writeFile(localInput, bytes);
    const hash = await sha256Of(localInput);
    if (hash !== manifest.input.sha256) {
      throw Object.assign(new Error(`SHA256 der Arbeitskopie stimmt nicht (${hash.slice(0, 12)}… statt ${manifest.input.sha256.slice(0, 12)}…)`), {
        code: 'REMOTE_INPUT_HASH_MISMATCH',
      });
    }
    await logJobEvent(options, transport, jobId, 'worker.input_verified', 'Arbeitskopie wurde per SHA-256 verifiziert.', {
      status: 'RUNNING',
      phase: 'Eingabe verifiziert',
      percent: 2,
    });

    // ---- Separation über die vorhandene Engine (§42) ----------------------
    const requestedProfile = options.profile && (QUALITY_PROFILES as string[]).includes(options.profile)
      ? (options.profile as QualityProfile)
      : manifest.engine.profile;
    const requestedDevice: ComputeDevice = (options.device as ComputeDevice | undefined) ?? 'auto';
    const service = new StemJobService({
      root: path.join(jobWorkDir, 'engine'),
      modelStoreDir: options.modelDir,
      allowPipelineDouble: options.allowPipelineDouble,
      device: requestedDevice,
      mode: 'studio_master',
      keepTemporaries: false,
      logger: {
        info: (category, message) => log(options, `${category}: ${message}`),
        warn: (category, message) => log(options, `WARN ${category}: ${message}`),
        error: (category, message) => log(options, `FEHLER ${category}: ${message}`),
        debug: () => undefined,
      },
    });
    const started = await service.start({
      inputPath: localInput,
      trackName: manifest.engine.modelId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40),
      profile: requestedProfile,
      modelId: options.modelId ?? manifest.engine.modelId,
      device: requestedDevice,
    });
    log(options, `Job ${jobId}: Separation mit ${started.modelId} (${started.profile}) gestartet`);
    let progressQueue = Promise.resolve();
    let lastProgressKey = '';
    const stopProgressTrace = service.onEvent((event) => {
      if (event.job.jobId !== started.jobId || event.type !== 'progress') return;
      const percent = Math.max(0, Math.min(100, event.job.percent ?? 0));
      const phase = event.job.phase || 'Inferenz läuft';
      const key = `${phase}:${Math.floor(percent / 10)}`;
      if (key === lastProgressKey) return;
      lastProgressKey = key;
      progressQueue = progressQueue
        .then(() => logJobEvent(options, transport, jobId, 'worker.inference_progress', `${phase} (${Math.round(percent)} %).`, {
          status: 'RUNNING',
          phase,
          percent,
          device: event.job.device,
        }))
        .catch(() => undefined);
    });
    await logJobEvent(options, transport, jobId, 'worker.inference_started', `Inferenz mit ${started.modelId} (${started.profile}) gestartet.`, {
      status: 'RUNNING',
      phase: 'Inferenz läuft',
      percent: 3,
      device: requestedDevice,
    });
    let finished: Awaited<ReturnType<StemJobService['waitFor']>>;
    try {
      finished = await waitForSeparation(service, started.jobId, watch, cancelPollMs);
    } finally {
      stopProgressTrace();
      await progressQueue;
    }
    if (finished.status !== 'COMPLETED') {
      throw Object.assign(new Error(finished.error?.message ?? `Separation endete mit ${finished.status}`), {
        code: finished.error?.code ?? 'INFERENCE_FAILED',
      });
    }
    await logJobEvent(options, transport, jobId, 'worker.inference_completed', 'Inferenz wurde ohne Fehler abgeschlossen.', {
      status: 'RUNNING',
      phase: 'Ergebnisse werden geschrieben',
      percent: 95,
      device: finished.device ?? requestedDevice,
    });

    // ---- Ergebnisse hochladen, Hashes schreiben ---------------------------
    // Vor der Abgabe noch einmal nachsehen: wer während der Rechnung abbricht,
    // bekommt keine Stems mehr in die Ablage (§37).
    if (await watch.check()) {
      throw Object.assign(new Error('Der Editor hat den Abbruch verlangt (cancel.flag) – Ergebnis verworfen.'), {
        code: 'REMOTE_CANCELLED_BY_EDITOR',
      });
    }
    const stems = [];
    for (const stem of finished.result?.stems ?? []) {
      let payload = await readFile(stem.filePath);
      if (options.corruptOutput === stem.id) {
        // Nur für den Negativtest (§21 J): absichtlich beschädigter Output.
        payload = Buffer.concat([payload.subarray(0, 64), Buffer.alloc(1024, 0x7f)]);
      }
      const relativePath = jobOutputPath(jobId, stemFileName(stem.id));
      await transport.writeBytes(relativePath, new Uint8Array(payload));
      const stats = inspectStemWav(payload);
      stems.push({
        id: stem.id,
        fileName: stemFileName(stem.id),
        relativePath,
        sha256: createHash('sha256').update(payload).digest('hex'),
        bytes: payload.byteLength,
        frames: stats.frames,
        sampleRate: stats.sampleRate,
        channels: stats.channels,
        peak: stats.peak,
      });
      await logJobEvent(options, transport, jobId, 'worker.output_written', `Stem ${stem.id} geschrieben und geprüft.`, {
        status: 'RUNNING',
        phase: `Ergebnis ${stem.id} geschrieben`,
        percent: 96,
      });
    }
    if (stems.length === 0) {
      throw Object.assign(new Error('Die Separation hat keine Stems geliefert'), { code: 'REMOTE_OUTPUT_INCOMPLETE' });
    }

    const completed = withStatus(manifest, {
      status: 'COMPLETED',
      phase: 'Fertig',
      percent: 100,
      output: { stems, resultFile: jobResultPath(jobId) },
      worker: {
        ...claim,
        heartbeatAt: Date.now(),
        device: (finished.device ?? options.device ?? 'cpu') as string,
        cpuFallback: finished.cpuFallback,
        fallbackReason: finished.fallbackReason,
      },
    });
    await transport.writeText(jobResultPath(jobId), buildResultDocument(completed, { workerId: options.workerId }));
    await logJobEvent(options, transport, jobId, 'worker.completed', `Job abgeschlossen; ${stems.length} geprüfte Stems liegen bereit.`, {
      status: 'COMPLETED',
      phase: 'Fertig',
      percent: 100,
      device: finished.device ?? options.device ?? 'cpu',
    });
    // Erst nach Ergebnissen und Ablaufprotokoll wird COMPLETED als Commit-Marker
    // geschrieben. Der Editor findet so beim ersten erfolgreichen Poll die ganze Spur.
    await transport.writeText(`jobs/${jobId}/manifest.json`, serializeManifest(completed));
    log(options, `Job ${jobId}: COMPLETED (${stems.map((stem) => stem.id).join(', ')})`);
    return 'completed';
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'INFERENCE_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'REMOTE_CANCELLED_BY_EDITOR' || code === 'INFERENCE_CANCELLED') {
      // Der Abbruch kommt vom Nutzer – kein Fehler, sondern CANCELLED, damit
      // der Editor die Antwort zuordnen kann und die Abbruchbitte verbraucht ist (§37).
      await logJobEvent(options, transport, jobId, 'worker.cancelled', 'Abbruchanforderung erkannt; laufende Arbeit wird verworfen.', {
        status: 'CANCELLED',
        phase: 'Vom Editor abgebrochen',
        code,
      }, 'warning');
      await transport
        .writeText(
          manifestRel,
          serializeManifest(
            withStatus(manifest, {
              status: 'CANCELLED',
              phase: 'Vom Editor abgebrochen',
              cancelRequested: true,
              worker: { ...claim, heartbeatAt: Date.now() },
            })
          )
        )
        .catch(() => undefined);
      await watch.consume();
      log(options, `Job ${jobId}: CANCELLED – ${message}`);
      return 'cancelled';
    }
    log(options, `Job ${jobId}: FAILED – ${code}: ${message}`);
    await logJobEvent(options, transport, jobId, 'worker.failed', `Worker hat den Job mit Fehlercode ${code} beendet.`, {
      status: 'FAILED',
      phase: 'Fehlgeschlagen',
      code,
    }, 'error');
    const failed = withStatus(manifest, {
      status: 'FAILED',
      phase: 'Fehlgeschlagen',
      error: { code, message, at: Date.now() },
      worker: { ...claim, heartbeatAt: Date.now() },
    });
    await transport.writeText(`jobs/${jobId}/manifest.json`, serializeManifest(failed)).catch(() => undefined);
    await transport
      .writeText(`jobs/${jobId}/error.json`, `${JSON.stringify({ jobId, code, message, at: Date.now(), worker: options.workerId }, null, 2)}\n`)
      .catch(() => undefined);
    return 'failed';
  } finally {
    clearInterval(heartbeat);
    watch.stop();
  }
}

/** Ein Durchlauf: alle Jobs in der Ablage prüfen. */
export async function runWorkerCycle(options: WorkerOptions, transport: IRemoteTransport): Promise<number> {
  const jobIds = (await transport.list('jobs')).filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/.test(entry));
  let processed = 0;
  for (const jobId of jobIds) {
    if (processed >= options.maxJobs) break;
    const raw = await transport.readText(`jobs/${jobId}/manifest.json`);
    if (!raw) continue;
    let manifest: RemoteJobManifest;
    try {
      manifest = parseManifest(raw, jobId);
    } catch (error) {
      log(options, `Job ${jobId}: Manifest unlesbar – übersprungen (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (isTerminalStatus(manifest.status)) continue;
    if (options.modelId && manifest.engine.modelId !== options.modelId) continue;
    if (await claimIsFresh(transport, jobId, 30 * 60_000)) {
      if (manifest.worker?.id !== options.workerId) {
        log(options, `Job ${jobId} wird bereits von ${manifest.worker?.id ?? 'einem anderen Worker'} gerechnet – übersprungen.`);
        continue;
      }
    }
    const result = await runOneJob(options, transport, jobId, manifest);
    if (result === 'completed' || result === 'failed' || result === 'cancelled') processed += 1;
  }
  return processed;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const transport = createTransport({ kind: options.kind, root: options.root });
  log(options, `Start: worker=${options.workerId} transport=${transport.label} ziel=${transport.target}`);
  await mkdir(options.workDir, { recursive: true });
  for (;;) {
    const processed = await runWorkerCycle(options, transport);
    if (options.once) {
      log(options, `${processed} Job(s) abgeschlossen – Ende (--once).`);
      return;
    }
    if (processed === 0) log(options, 'Keine offenen Jobs – warte …');
    await new Promise((resolve) => setTimeout(resolve, Math.max(2000, options.pollMs)));
  }
}

const invokedDirectly = process.argv[1] && /stem-remote-worker\.(ts|mjs|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[STEM-REMOTE-WORKER] Abbruch: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
