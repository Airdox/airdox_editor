/**
 * RemoteStemJobService – High-Quality-Separation auf einem externen Worker
 * (Google Colab) mit Google Drive als Transport (§15–§22, §30, §32, §33).
 *
 * Was hier passiert (und was ausdrücklich nicht)
 * ----------------------------------------------
 * Der Editor erzeugt **immer** eine Arbeitskopie, lädt genau diese hoch und
 * schreibt ein Manifest in die Jobablage. Ein Worker (Colab-Notebook,
 * `scripts/stem-remote-worker.ts` oder ein Testharness) beansprucht den Job,
 * verifiziert den Input-Hash, rechnet mit dem High-Quality-Modell und schreibt
 * die Stems samt Hashes zurück. Dieses Modul verfolgt den Job (Polling, §20),
 * prüft die Ergebnisse hart (§34) und übergibt sie dem **bestehenden**
 * Stem-Importpfad (`StemJobService.registerCompletedJob`) – der Editor liest
 * die Stems danach über dieselben Kanäle wie bei einem lokalen Lauf.
 *
 * Bewusste Entscheidungen:
 *  - **Keine zweite Statusachse.** Status sind `JobStatus` (§14). Zusatzwissen
 *    (Gerät, CPU-Rückfall, Worker) steht in eigenen Feldern.
 *  - **Idempotenz vor Klicks.** Der Idempotenzschlüssel (Input-SHA256 + Modell +
 *    Profil) verhindert, dass ein zweiter Job für dieselbe Arbeit entsteht –
 *    egal ob der Editor neu gestartet, mehrfach geklickt oder der Poll
 *    wiederholt wurde (§19, §33).
 *  - **Transportaussetzer sind kein Job-Aus.** Nicht erreichbarer Drive-Ordner
 *    ⇒ `transportDegraded`, Job bleibt aktiv (§21 B/C). Nur inhaltliche Fehler
 *    (Manifest kaputt, Output fehlt/leer/falscher Hash) führen zu FAILED.
 *  - **Originale bleiben read-only.** Es wird ausschließlich die Arbeitskopie
 *    hochgeladen; vom Original werden nur Hash/Größe/mtime *gelesen* (§3, §31).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRegistry } from '../modelRegistry';
import type { StemJobService, StemServiceLogger } from '../stemJobService';
import type { ModelDescriptor, OriginalIntegrity, SeparationJobMetadata, StemId } from '../types';
import { JOB_SCHEMA_VERSION } from '../types';
import { analyzeAudio, decodeWav, sha256File, parseWavLayout } from '../wavIo';
import { stemFileName } from './layout';
import {
  buildManifest,
  buildResultDocument,
  createRemoteJobId,
  idempotencyKeyFor,
  isTerminalStatus,
  parseManifest,
  serializeManifest,
  verifyCompletedManifest,
  withStatus,
  RemoteProtocolError,
} from './manifest';
import {
  createTransport,
  RemoteUnreachableError,
  type IRemoteTransport,
} from './transport';
import {
  REMOTE_DEFAULTS,
  loadRemoteSettingsFile,
  mergeRemoteSettings,
  saveRemoteSettingsFile,
  settingsFromEnv,
  transportConfigFrom,
  type RemoteSettingsState,
} from './settings';
import { REMOTE_PHASES, REMOTE_JOB_SCHEMA_VERSION, type RemoteJobManifest, type RemoteJobRecord, type RemoteJobStatus } from './types';
import type {
  RemoteServiceStatus,
  RemoteSettings,
  RemoteStemJobView,
  StartRemoteStemJobPayload,
} from '../transportTypes';

export { REMOTE_PHASES };

export interface StartRemoteStemJobRequest extends Omit<StartRemoteStemJobPayload, 'bytes'> {
  bytes?: Uint8Array | ArrayBuffer;
}

export interface RemoteStemJobServiceOptions {
  /** Engine-Datenordner (`Working/`, `Separation/`, `RemoteJobs/`, `Cache/`). */
  root: string;
  /** Lokaler Job-Service: Modell-Katalog, Status, und der Import der Ergebnisse. */
  localService: StemJobService;
  appVersion?: string;
  env?: Record<string, string | undefined>;
  registry?: ModelRegistry;
  /** Eingespritzter Transport (Tests) – sonst aus den Einstellungen gebaut. */
  transport?: IRemoteTransport;
  /** Einstellungs-Overrides (Tests, App-Start). */
  settings?: RemoteSettingsState;
  logger?: StemServiceLogger;
  /** Testhaken: erlaubt das deterministische Pipeline-Double auch remote. */
  allowPipelineDouble?: boolean;
  /** Testhaken: sofortiger Poll-Takt statt Timer. */
  disableBackgroundPolling?: boolean;
  now?: () => number;
}

export interface RemoteServiceEvent {
  type: 'progress' | 'completed' | 'failed' | 'cancelled' | 'transport';
  job: RemoteStemJobView;
}

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;

function toBuffer(bytes: Uint8Array | ArrayBuffer): Buffer {
  return bytes instanceof ArrayBuffer ? Buffer.from(new Uint8Array(bytes)) : Buffer.from(bytes);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class RemoteStemJobService {
  private readonly options: RemoteStemJobServiceOptions;
  private readonly root: string;
  private readonly registry: ModelRegistry;
  private readonly local: StemJobService;
  private readonly recordsDir: string;
  private readonly separationDir: string;
  private readonly workingDir: string;
  private records = new Map<string, RemoteJobRecord>();
  private listeners = new Set<(event: RemoteServiceEvent) => void>();
  private settings: RemoteSettingsState;
  private injectedTransport?: IRemoteTransport;
  private timer?: NodeJS.Timeout;
  private polling?: Promise<RemoteServiceStatus>;
  private loaded = false;

  constructor(options: RemoteStemJobServiceOptions) {
    this.options = options;
    this.root = path.resolve(options.root);
    this.registry = options.registry ?? options.localService.registry;
    this.local = options.localService;
    this.recordsDir = path.join(this.root, 'RemoteJobs');
    this.separationDir = path.join(this.root, 'Separation');
    this.workingDir = path.join(this.root, 'Working', 'remote');
    this.injectedTransport = options.transport;
    this.settings = mergeRemoteSettings(settingsFromEnv(options.env ?? process.env), options.settings);
  }

  /* --------------------------------------------------------------------- *
   * Einstellungen / Transport
   * --------------------------------------------------------------------- */

  /** Reihenfolge: Umgebung < gespeicherte Datei < explizite Overrides. */
  private async effectiveSettings(): Promise<RemoteSettingsState> {
    const file = await loadRemoteSettingsFile(this.root);
    return mergeRemoteSettings(settingsFromEnv(this.options.env ?? process.env), file, this.options.settings);
  }

  private transportFor(settings: RemoteSettingsState): IRemoteTransport {
    if (this.injectedTransport) return this.injectedTransport;
    return createTransport(transportConfigFrom(settings));
  }

  async configure(settings: RemoteSettings): Promise<RemoteServiceStatus> {
    const current = await this.effectiveSettings();
    const next: RemoteSettingsState = { ...current };
    if (settings.kind) next.kind = settings.kind;
    if (settings.root !== undefined) next.root = settings.root;
    if (settings.pollIntervalMs !== undefined) next.pollIntervalMs = settings.pollIntervalMs;
    if (settings.workerLeaseMs !== undefined) next.workerLeaseMs = settings.workerLeaseMs;
    if (settings.jobTimeoutMs !== undefined) next.jobTimeoutMs = settings.jobTimeoutMs;
    await saveRemoteSettingsFile(this.root, next);
    this.settings = mergeRemoteSettings(settingsFromEnv(this.options.env ?? process.env), next);
    this.options.logger?.info?.('STEM-REMOTE', 'Fernpfad-Einstellungen gespeichert', {
      kind: this.settings.kind,
      root: this.settings.root,
      pollIntervalMs: this.pollIntervalMs(),
    });
    return this.status();
  }

  private pollIntervalMs(): number {
    const value = this.settings.pollIntervalMs ?? REMOTE_DEFAULTS.pollIntervalMs;
    return Math.max(2_000, Math.min(value, 10 * 60_000));
  }

  private workerLeaseMs(): number {
    return this.settings.workerLeaseMs ?? REMOTE_DEFAULTS.workerLeaseMs;
  }

  private jobTimeoutMs(): number {
    return this.settings.jobTimeoutMs ?? REMOTE_DEFAULTS.jobTimeoutMs;
  }

  /* --------------------------------------------------------------------- *
   * Dauerzustand
   * --------------------------------------------------------------------- */

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(this.recordsDir, { recursive: true });
    let entries: string[] = [];
    try {
      entries = await readdir(this.recordsDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'settings.json') continue;
      const jobId = entry.slice(0, -5);
      if (!JOB_ID_RE.test(jobId)) continue;
      try {
        const raw = await readFile(path.join(this.recordsDir, entry), 'utf8');
        const record = JSON.parse(raw) as RemoteJobRecord;
        if (record?.jobId !== jobId) continue;
        this.records.set(jobId, record);
      } catch (error) {
        this.options.logger?.warn?.('STEM-REMOTE', `Fern-Job-Datensatz ${entry} ist unlesbar und wird ignoriert`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const active = [...this.records.values()].filter((record) => !isTerminalStatus(record.status) || !record.localJobId);
    if (active.length > 0) {
      this.options.logger?.info?.('STEM-REMOTE', `${active.length} offene(r) Fern-Job(s) nach Neustart übernommen`, {
        jobs: active.map((record) => ({ jobId: record.jobId, status: record.status })),
      });
    }
  }

  private async persist(record: RemoteJobRecord): Promise<void> {
    record.updatedAt = this.now();
    await mkdir(this.recordsDir, { recursive: true });
    const file = path.join(this.recordsDir, `${record.jobId}.json`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /* --------------------------------------------------------------------- *
   * Start
   * --------------------------------------------------------------------- */

  /**
   * Legt einen Fern-Job an: Arbeitskopie bilden, hochladen, Manifest schreiben.
   * Ein bereits laufender/fertiger identischer Job wird **wiederverwendet**
   * (§19, §33) – es entsteht kein zweiter Lauf.
   */
  async start(request: StartRemoteStemJobRequest): Promise<RemoteStemJobView> {
    await this.ensureLoaded();
    const settings = await this.effectiveSettings();
    const transport = this.transportFor(settings);

    const profile = request.profile ?? 'HIGH_QUALITY';
    const descriptor = this.resolveDescriptor(profile, request.modelId, request.family);
    const stems = [...descriptor.stemOrder];

    if (!request.bytes && !request.inputPath) {
      throw new RemoteProtocolError('AUDIO_MISSING', 'Fern-Job benötigt bytes (Arbeitskopie) oder inputPath als Mix-Quelle.');
    }

    const jobId = createRemoteJobId();
    const trackName = (request.trackName ?? 'mix').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'mix';
    const fileName = `${trackName}.wav`;

    // ---- 1. Arbeitskopie: das Original wird nur GELESEN (§3) ---------------
    const workingPath = path.join(this.workingDir, jobId, fileName);
    await mkdir(path.dirname(workingPath), { recursive: true });
    let originalIntegrity: OriginalIntegrity | undefined;
    if (request.bytes) {
      await writeFile(workingPath, toBuffer(request.bytes));
    } else {
      // Aus einer Datei: Arbeitskopie ziehen, Original vorher/nachher messen.
      const originalPath = path.resolve(request.inputPath!);
      const before = await readFile(originalPath);
      await writeFile(workingPath, before);
      const info = await import('node:fs/promises').then((fs) => fs.stat(originalPath));
      originalIntegrity = {
        path: originalPath,
        sha256Before: sha256Bytes(before),
        sizeBefore: info.size,
        mtimeMsBefore: info.mtimeMs,
        unchanged: true,
        checkedAt: this.now(),
      };
    }
    const workingBytes = await readFile(workingPath);
    const inputSha256 = sha256Bytes(workingBytes);
    const header = this.inspectWav(workingBytes, fileName);

    const idempotencyKey = idempotencyKeyFor({ sha256: inputSha256, modelId: descriptor.id, profile, family: descriptor.family, stems });
    const existing = [...this.records.values()].find(
      (record) => record.idempotencyKey === idempotencyKey && record.status !== 'FAILED' && record.status !== 'CANCELLED'
    );
    if (existing) {
      this.options.logger?.info?.('STEM-REMOTE', `Identischer Fern-Job existiert bereits (${existing.jobId}) – kein zweiter Lauf (§19)`, {
        idempotencyKey,
        status: existing.status,
      });
      return this.toView(existing);
    }

    const now = this.now();
    const record: RemoteJobRecord = {
      schemaVersion: REMOTE_JOB_SCHEMA_VERSION,
      jobId,
      createdAt: now,
      updatedAt: now,
      status: 'PREPARING',
      phase: REMOTE_PHASES.uploading,
      percent: 0,
      trackName,
      profile,
      modelId: descriptor.id,
      family: descriptor.family,
      backend: String(descriptor.checkpoint?.format === 'onnx' ? 'onnx' : 'bs_roformer'),
      stems,
      idempotencyKey,
      workingCopyPath: workingPath,
      workingCopySha256: inputSha256,
      workingCopyBytes: workingBytes.byteLength,
      durationSeconds: header.durationSeconds,
      sampleRate: header.sampleRate,
      channels: header.channels,
      originalPath: originalIntegrity?.path,
      originalSha256: originalIntegrity?.sha256Before,
      originalBytes: originalIntegrity?.sizeBefore,
      originalMtimeMs: originalIntegrity?.mtimeMsBefore,
      transportErrors: 0,
      attempts: 0,
    };
    this.records.set(jobId, record);
    await this.persist(record);

    const manifest = buildManifest({
      jobId,
      trackName,
      appVersion: this.options.appVersion ?? '0.0.0',
      host: os.hostname(),
      idempotencyKey,
      status: 'PREPARING',
      phase: REMOTE_PHASES.uploading,
      input: {
        fileName,
        relativePath: `jobs/${jobId}/input/${fileName}`,
        sha256: inputSha256,
        bytes: workingBytes.byteLength,
        durationSeconds: header.durationSeconds,
        sampleRate: header.sampleRate,
        channels: header.channels,
      },
      engine: {
        backend: 'bs_roformer',
        family: descriptor.family,
        modelId: descriptor.id,
        profile,
        stems,
        device: request.device ?? 'auto',
        checkpoint: {
          file: descriptor.checkpoint.file,
          sha256: descriptor.checkpoint.sha256,
          url: descriptor.checkpoint.url,
        },
        config: descriptor.config
          ? { file: descriptor.config.file, url: descriptor.config.url }
          : undefined,
        numOverlap: this.registry.parametersFor(descriptor, profile).numOverlap,
        chunkSizeSamples: descriptor.chunkSizeSamples,
      },
    });

    // Der Steckbrief wird **vor** dem Upload lokal festgehalten: bricht der
    // Transport ab, kann derselbe Job später genau so wiederholt werden (§21 B).
    record.manifest = manifest;
    await this.persist(record);

    this.emitEvent('progress', record);
    try {
      await transport.probe();
      const relative = manifest.input.relativePath;
      const remoteHash = await transport.sha256(relative);
      if (remoteHash !== inputSha256) {
        await transport.writeBytes(relative, workingBytes);
        await transport.writeText(`jobs/${jobId}/manifest.json`, serializeManifest(manifest));
        record.uploadedAt = this.now();
      } else {
        // Schon da (z. B. nach einem Absturz mitten im Upload) – erneut
        // hochladen wäre bei 100 MB pro Track reine Verschwendung.
        await transport.writeText(`jobs/${jobId}/manifest.json`, serializeManifest(manifest));
        record.uploadedAt = this.now();
      }
    } catch (error) {
      const unreachable = error instanceof RemoteUnreachableError;
      record.status = unreachable ? 'PREPARING' : 'FAILED';
      record.transportErrors += 1;
      record.transportDegraded = unreachable;
      record.error = {
        code: unreachable ? 'REMOTE_UNREACHABLE' : 'REMOTE_UPLOAD_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
      record.phase = unreachable ? 'Google Drive nicht erreichbar – Upload wird wiederholt' : 'Upload fehlgeschlagen';
      await this.persist(record);
      this.emitEvent(unreachable ? 'transport' : 'failed', record);
      if (!unreachable) {
        throw new RemoteProtocolError('REMOTE_UPLOAD_FAILED', record.error.message, { jobId });
      }
      this.schedulePolling();
      return this.toView(record);
    }

    record.status = 'RUNNING';
    record.phase = REMOTE_PHASES.waitingWorker;
    record.transportDegraded = false;
    record.error = undefined;
    await this.persist(record);
    // Die Ablage muss denselben Stand zeigen wie der Editor. Bliebe dort
    // "PREPARING" stehen, obwohl die Arbeitskopie vollständig liegt, würden
    // Worker/Colab-Notebook den Job als unfertig ansehen (§17, §20).
    try {
      await transport.writeText(
        `jobs/${jobId}/manifest.json`,
        serializeManifest(withStatus(manifest, { status: 'RUNNING', phase: REMOTE_PHASES.waitingWorker }))
      );
    } catch (error) {
      if (error instanceof RemoteUnreachableError) {
        record.transportDegraded = true;
        await this.persist(record);
      } else {
        throw error;
      }
    }
    this.options.logger?.info?.('STEM-REMOTE', `jobId=${jobId} status=RUNNING model=${descriptor.id} profile=${profile}`, {
      jobId,
      status: 'RUNNING',
      model: descriptor.id,
      profile,
      modelId: descriptor.id,
      bytes: workingBytes.byteLength,
      sha256: inputSha256,
    });
    this.emitEvent('progress', record);
    if (this.records.size > 0 && !this.options.disableBackgroundPolling) this.schedulePolling();
    return this.toView(record);
  }

  /**
   * Liest Kopfdaten aus der Arbeitskopie. Für die Manifest-Angaben genügt das
   * WAV-Gerüst (Sample Rate, Kanäle, Frames) – es wird kein Audio dekodiert.
   */
  private inspectWav(bytes: Uint8Array, fileName: string): { sampleRate: number; channels: number; frames: number; durationSeconds: number } {
    try {
      // Der volle Puffer wird geparst: `parseWavLayout` deckelt die
      // daten-Chunk-Länge auf die tatsächlich vorhandene Dateigröße. Mit einem
      // abgeschnittenen Kopf (nur die ersten 256 KiB) wäre die Dauer eines
      // 4-Sekunden-Tracks um Faktor 3 zu klein – ein falsches Manifest.
      const layout = parseWavLayout(bytes);
      const bytesPerFrame = Math.max(1, layout.blockAlign);
      // Die im Header deklarierte Länge kann bei abgeschnittenen Dateien
      // lügen; deshalb gegen die echte Dateigröße deckeln.
      const dataBytes = Math.min(layout.dataSize, Math.max(0, bytes.byteLength - layout.dataOffset));
      const frames = Math.floor(dataBytes / bytesPerFrame);
      return {
        sampleRate: layout.sampleRate,
        channels: layout.channels,
        frames,
        durationSeconds: layout.sampleRate > 0 ? frames / layout.sampleRate : 0,
      };
    } catch (error) {
      throw new RemoteProtocolError(
        'AUDIO_CORRUPT',
        `Arbeitskopie ${fileName} ist kein lesbares WAV: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /* --------------------------------------------------------------------- *
   * Polling / Fortschritt / Import
   * --------------------------------------------------------------------- */

  /**
   * Ein Poll-Zyklus. Mehrfachaufrufe parallel (UI-Poll + Timer) werden
   * zusammengelegt – die Statusabfrage darf keine doppelte Arbeit auslösen.
   */
  async poll(): Promise<RemoteServiceStatus> {
    if (this.polling) return this.polling;
    this.polling = this.runPollCycle().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async runPollCycle(): Promise<RemoteServiceStatus> {
    await this.ensureLoaded();
    const settings = await this.effectiveSettings();
    let transport: IRemoteTransport;
    try {
      transport = this.transportFor(settings);
    } catch (error) {
      return this.statusFromSettings(settings, false, error instanceof Error ? error.message : String(error));
    }
    try {
      await transport.probe();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const record of this.records.values()) {
        if (isTerminalStatus(record.status)) continue;
        record.transportDegraded = true;
        record.transportErrors += 1;
        await this.persist(record);
      }
      this.options.logger?.warn?.('STEM-REMOTE', `Transport nicht erreichbar – Jobstände bleiben erhalten (§21 C): ${message}`, {
        transport: transport.label,
      });
      return this.statusFromSettings(settings, false, message, transport);
    }

    for (const record of [...this.records.values()]) {
      if (isTerminalStatus(record.status) && record.localJobId) continue;
      try {
        await this.syncRecord(record, transport);
      } catch (error) {
        if (error instanceof RemoteUnreachableError) {
          record.transportDegraded = true;
          record.transportErrors += 1;
          await this.persist(record);
          continue;
        }
        // Inhaltliche Fehler (Manifest kaputt, Hash falsch, Datei fehlt) sind
        // endgültig – der Nutzer bekommt eine verständliche Ursache.
        const code = error instanceof RemoteProtocolError ? error.code : 'REMOTE_FAILED';
        record.status = 'FAILED';
        record.error = { code, message: error instanceof Error ? error.message : String(error) };
        record.phase = 'Fehlgeschlagen';
        record.finishedAt = this.now();
        await this.persist(record);
        await this.writeRemoteError(transport, record).catch(() => undefined);
        this.options.logger?.error?.('STEM-REMOTE', `jobId=${record.jobId} status=FAILED reason=${code}`, {
          jobId: record.jobId,
          code,
          message: record.error.message,
        });
        this.emitEvent('failed', record);
      }
    }
    this.schedulePolling();
    return this.statusFromSettings(settings, true, undefined, transport);
  }

  private async syncRecord(record: RemoteJobRecord, transport: IRemoteTransport): Promise<void> {
    const manifestPath = `jobs/${record.jobId}/manifest.json`;
    const raw = await transport.readText(manifestPath);
    if (raw === null) {
      /*
       * Manifest weg heißt nicht Job weg: entweder ist der erste Upload
       * abgebrochen (§21 B), die Drive-Synchronisierung hinkt, oder der Ordner
       * war kurz nicht gemountet (§21 C). In allen Fällen wird derselbe Job
       * erneut veröffentlicht – gleiche Job-Id, gleiche Bytes, kein zweiter
       * Lauf. Nur inhaltliche Fehler führen zu FAILED.
       */
      if (!record.cancelRequestedAt && !isTerminalStatus(record.status)) {
        await this.republish(record, transport);
        record.lastPollAt = this.now();
        record.transportErrors = 0;
        record.transportDegraded = false;
        await this.persist(record);
        this.options.logger?.info?.('STEM-REMOTE', `jobId=${record.jobId}: Steckbrief fehlte in der Ablage und wurde erneut veröffentlicht (§21 B)`, {
          jobId: record.jobId,
          status: record.status,
          bytes: record.workingCopyBytes,
        });
      }
      return;
    }
    let manifest: RemoteJobManifest;
    try {
      manifest = parseManifest(raw, record.jobId);
    } catch (error) {
      record.transportErrors += 1;
      if (record.transportErrors >= 3) throw error instanceof RemoteProtocolError ? error : new RemoteProtocolError('REMOTE_MANIFEST_INVALID', String(error));
      await this.persist(record);
      return;
    }

    record.lastPollAt = this.now();
    record.transportDegraded = false;
    record.transportErrors = 0;
    record.attempts = manifest.attempts ?? record.attempts;
    if (manifest.worker) {
      record.worker = manifest.worker;
      record.device = this.deviceFromWorker(manifest.worker);
      record.cpuFallback = manifest.worker.cpuFallback;
      record.fallbackReason = manifest.worker.fallbackReason;
    }
    if (typeof manifest.percent === 'number') record.workerPercent = manifest.percent;

    // Abbruch des Nutzers gewinnt immer: ein danach eintreffendes Ergebnis wird
    // nicht mehr importiert und der Job steht nicht als COMPLETED (§37).
    if (record.cancelRequestedAt && isTerminalStatus(manifest.status)) {
      record.status = 'CANCELLED';
      record.phase = manifest.status === 'COMPLETED' ? 'Abgebrochen – Ergebnis des Workers verworfen' : REMOTE_PHASES.cancelled;
      record.finishedAt = record.finishedAt ?? this.now();
      await this.persist(record);
      this.emitEvent('cancelled', record);
      return;
    }

    if (manifest.status === 'COMPLETED') {
      const check = verifyCompletedManifest(manifest);
      if (check.ok === false) throw new RemoteProtocolError(check.code, check.message);
      await this.importResult(record, manifest, transport);
      return;
    }

    if (manifest.status === 'FAILED' || manifest.status === 'CANCELLED') {
      record.status = manifest.status;
      record.phase = manifest.status === 'CANCELLED' ? REMOTE_PHASES.cancelled : 'Fehlgeschlagen (Worker)';
      record.error = manifest.error
        ? { code: manifest.error.code, message: manifest.error.message }
        : { code: 'REMOTE_WORKER_FAILED', message: manifest.notes?.slice(-1)[0] ?? 'Worker hat den Job abgebrochen' };
      record.finishedAt = this.now();
      await this.persist(record);
      this.emitEvent(manifest.status === 'CANCELLED' ? 'cancelled' : 'failed', record);
      return;
    }

    // Laufend: Phase aus Worker-Sicht übersetzen (§13 – der Nutzer sieht
    // „Verarbeitung läuft – GPU/CPU“ statt einer technischen Zeile).
    const previous = record.status;
    record.status = manifest.status;
    record.phase = this.phaseTextFor(manifest);
    record.percent = Math.max(record.percent, Math.min(99, typeof manifest.percent === 'number' ? manifest.percent : record.percent));
    await this.persist(record);
    this.emitEvent('progress', record);
    if (previous !== record.status) {
      this.options.logger?.info?.('STEM-REMOTE', `jobId=${record.jobId} status=${record.status} model=${record.modelId} worker=${manifest.worker?.id ?? 'unbekannt'}`, {
        jobId: record.jobId,
        status: record.status,
        model: record.modelId,
        worker: manifest.worker?.id,
        device: manifest.worker?.device,
        cpuFallback: manifest.worker?.cpuFallback ?? false,
      });
    }

    // Zeitüberschreitung: kein Worker, kein Ergebnis, zu lange her (§21 E).
    if (this.now() - record.createdAt > this.jobTimeoutMs()) {
      record.status = 'FAILED';
      record.error = {
        code: 'REMOTE_TIMEOUT',
        message: `Fern-Job ${record.jobId} hat nach ${Math.round(this.jobTimeoutMs() / 60_000)} Minuten kein Ergebnis geliefert.`,
      };
      record.phase = 'Zeitüberschreitung – kein Worker-Ergebnis';
      record.finishedAt = this.now();
      await this.persist(record);
      await this.failRemote(transport, record).catch(() => undefined);
      this.emitEvent('failed', record);
      return;
    }

    // Beansprucht, aber kein Lebenszeichen mehr: nicht sofort aufgeben, nur
    // sichtbar machen. Erst der Gesamt-Timeout oben beendet den Job.
    if (record.worker?.claimedAt && !manifest.worker?.heartbeatAt) {
      const age = this.now() - record.worker.claimedAt;
      if (age > this.workerLeaseMs()) {
        record.phase = `Worker ohne Lebenszeichen seit ${Math.round(age / 60_000)} Minuten – neuer Versuch auf einem anderen Worker möglich`;
      }
    }
  }

  private phaseTextFor(manifest: RemoteJobManifest): string {
    if (manifest.phase) {
      // Der Worker darf seine eigene Phase nennen („Segment 3/20“); bei
      // Gerätewechseln ergänzt der Editor die GPU/CPU-Aussage (§13).
      const deviceSuffix = manifest.worker?.cpuFallback ? ' – CPU-Fallback' : manifest.worker?.device?.startsWith('cuda') ? ' – GPU' : manifest.worker?.device ? ` – ${manifest.worker.device}` : '';
      return `${manifest.phase}${deviceSuffix}`;
    }
    if (manifest.worker?.cpuFallback) return REMOTE_PHASES.fallbackCpu;
    if (manifest.worker?.device?.startsWith('cuda')) return REMOTE_PHASES.runningGpu;
    if (manifest.worker?.device) return REMOTE_PHASES.runningCpu;
    return REMOTE_PHASES.waitingWorker;
  }

  private deviceFromWorker(worker: RemoteJobManifest['worker']): RemoteJobRecord['device'] {
    switch (worker?.device) {
      case 'cuda':
      case 'cuda:0':
        return 'cuda';
      case 'cpu':
        return 'cpu';
      case 'dml':
      case 'directml':
        return 'directml';
      case 'mps':
      case 'coreml':
        return 'coreml';
      default:
        return undefined;
    }
  }

  /**
   * Wiederholt einen unvollständigen Upload (§21 B/C): Arbeitskopie prüfen und
   * – falls sie fehlt – erneut hochladen, danach den Steckbrief schreiben.
   * Die Arbeitskopie bleibt dabei die einzige Quelle; das Original wird nur
   * gelesen (§3). Transportaussetzer bleiben Transportaussetzer: sie werden
   * gemeldet, nicht in einen Job-Fehler übersetzt.
   */
  private async republish(record: RemoteJobRecord, transport: IRemoteTransport): Promise<void> {
    const manifest = record.manifest;
    if (!manifest) return;
    const bytes = await readFile(record.workingCopyPath);
    const hash = sha256Bytes(bytes);
    if (hash !== manifest.input.sha256) {
      throw new RemoteProtocolError(
        'INPUT_HASH_MISMATCH',
        `Arbeitskopie ${record.workingCopyPath} stimmt nicht mehr mit dem Steckbrief überein – Job wird nicht wiederholt.`
      );
    }
    const remoteHash = await transport.sha256(manifest.input.relativePath).catch(() => null);
    if (remoteHash !== hash) {
      await transport.writeBytes(manifest.input.relativePath, bytes);
    }
    await transport.writeText(
      `jobs/${record.jobId}/manifest.json`,
      serializeManifest(
        withStatus(manifest, {
          status: record.status === 'PREPARING' || record.status === 'PENDING' ? 'PREPARING' : 'RUNNING',
          phase: record.status === 'PREPARING' || record.status === 'PENDING' ? REMOTE_PHASES.uploading : REMOTE_PHASES.waitingWorker,
        })
      )
    );
    record.uploadedAt = this.now();
  }

  /**
   * Lädt die Ergebnisse, prüft sie hart (§34) und übergibt sie dem bestehenden
   * Importpfad. Erst danach ist der Job COMPLETED – eine bloße Statusmeldung
   * des Workers genügt ausdrücklich nicht (§21 I/J/K).
   */
  private async importResult(record: RemoteJobRecord, manifest: RemoteJobManifest, transport: IRemoteTransport): Promise<void> {
    record.status = 'VALIDATING';
    record.phase = REMOTE_PHASES.downloading;
    record.percent = 99;
    await this.persist(record);
    this.emitEvent('progress', record);

    const targetDir = path.join(this.separationDir, record.trackName, `remote-${record.jobId.slice(0, 8)}`);
    await mkdir(targetDir, { recursive: true });

    const imported: { id: StemId; filePath: string; bytes: number; sha256: string }[] = [];
    const descriptors: { id: StemId; displayName?: string; filePath: string; sha256: string; frames: number; sampleRate: number; channels: number; peak: number }[] = [];

    for (const stem of manifest.output.stems) {
      const bytes = await transport.readBytes(stem.relativePath);
      if (!bytes || bytes.byteLength === 0) {
        throw new RemoteProtocolError('REMOTE_OUTPUT_MISSING', `Ergebnis ${stem.id} fehlt in der Jobablage (${stem.relativePath}).`);
      }
      const actualHash = sha256Bytes(bytes);
      if (stem.sha256 && actualHash !== stem.sha256) {
        throw new RemoteProtocolError(
          'REMOTE_OUTPUT_HASH_MISMATCH',
          `Ergebnis ${stem.id} ist beschädigt: SHA256 ${actualHash.slice(0, 12)}… erwartet ${stem.sha256.slice(0, 12)}…`
        );
      }
      // Header prüfen und Pegel messen – eine leere oder halbe Datei darf
      // niemals als Stem in den Editor gelangen (§34).
      let decoded;
      try {
        decoded = decodeWav(bytes);
      } catch (error) {
        throw new RemoteProtocolError(
          'REMOTE_OUTPUT_INVALID',
          `Ergebnis ${stem.id} ist kein lesbares WAV: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (decoded.sampleRate !== record.sampleRate || decoded.channels !== record.channels) {
        throw new RemoteProtocolError(
          'REMOTE_OUTPUT_INVALID',
          `Ergebnis ${stem.id} hat ${decoded.sampleRate} Hz/${decoded.channels} Kanäle, erwartet ${record.sampleRate} Hz/${record.channels}.`
        );
      }
      /*
       * Längenprüfung: ein abgeschnittener Stem (Sync-Abbruch, halb geladene
       * Datei) hätte einen gültigen Header und einen passenden Hash – aber
       * nicht die erwartete Dauer. Mehr als eine halbe Sekunde zu kurz ist
       * kein Rundungsfehler, sondern ein kaputtes Ergebnis (§34 J).
       */
      const expectedFrames = Math.round(record.durationSeconds * decoded.sampleRate);
      if (expectedFrames > 0 && decoded.frames + decoded.sampleRate * 0.5 < expectedFrames) {
        throw new RemoteProtocolError(
          'REMOTE_OUTPUT_INVALID',
          `Ergebnis ${stem.id} ist unvollständig: ${decoded.frames} von ${expectedFrames} Samples.`
        );
      }
      const stats = analyzeAudio(decoded.data, decoded.channels, decoded.frames);
      if (!stats.finite || stats.peak <= 0) {
        throw new RemoteProtocolError(
          'REMOTE_OUTPUT_INVALID',
          `Ergebnis ${stem.id} ist still oder enthält keine gültigen Samples (Peak ${stats.peak}).`
        );
      }
      const filePath = path.join(targetDir, stemFileName(stem.id));
      await writeFile(filePath, bytes);
      imported.push({ id: stem.id, filePath, bytes: bytes.byteLength, sha256: actualHash });
      descriptors.push({
        id: stem.id,
        displayName: this.registry.get(record.modelId)?.stemDisplayNames?.[stem.id],
        filePath,
        sha256: actualHash,
        frames: decoded.frames,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
        peak: stats.peak,
      });
    }

    // Original-Integrität nachweisen: nur Hash/Größe/mtime lesen, nie schreiben
    // (§31). Ändert der Nutzer die Datei parallel, wird das *vermerkt* und der
    // fertige Lauf nicht weggeworfen – unser Pfad hat sie nie angefasst.
    let originalUnchanged = record.originalUnchanged ?? true;
    if (record.originalPath) {
      try {
        const info = await (await import('node:fs/promises')).stat(record.originalPath);
        const after = await sha256File(record.originalPath);
        originalUnchanged = after === record.originalSha256 && info.size === record.originalBytes && info.mtimeMs === record.originalMtimeMs;
        if (!originalUnchanged) {
          this.options.logger?.warn?.('STEM-REMOTE', `Originaldatei hat sich während des Fern-Jobs geändert: ${record.originalPath}`, {
            jobId: record.jobId,
          });
        }
      } catch {
        originalUnchanged = false;
      }
      record.originalUnchanged = originalUnchanged;
    }

    const metadata: SeparationJobMetadata = {
      jobId: record.jobId,
      schemaVersion: JOB_SCHEMA_VERSION,
      status: 'COMPLETED',
      inputPath: record.workingCopyPath,
      inputAudioHash: record.workingCopySha256,
      inputFormat: 'wav',
      originalIntegrity: {
        path: record.originalPath ?? '',
        sha256Before: record.originalSha256 ?? record.workingCopySha256,
        sha256After: record.originalSha256,
        sizeBefore: record.originalBytes ?? record.workingCopyBytes,
        sizeAfter: record.originalBytes,
        mtimeMsBefore: record.originalMtimeMs ?? 0,
        mtimeMsAfter: record.originalMtimeMs,
        unchanged: originalUnchanged,
        checkedAt: this.now(),
      },
      workingCopyPath: record.workingCopyPath,
      settings: {
        profile: record.profile,
        modelId: record.modelId,
        modelVersion: manifest.engine.modelId,
        modelHash: manifest.engine.checkpoint?.sha256 ?? 'unverified',
        family: record.family,
        backend: 'python-torch',
        precision: 'f32',
        device: 'auto',
        sampleRate: record.sampleRate,
        channels: record.channels,
        chunkSizeSamples: manifest.engine.chunkSizeSamples ?? 0,
        chunkOverlap: 0,
        numOverlap: manifest.engine.numOverlap ?? 0,
        ensemblePasses: 1,
        clipMode: 'none',
        dcRemoval: false,
        stems: record.stems,
        extras: { remote: true, jobId: record.jobId, worker: manifest.worker?.id ?? 'unbekannt' },
      },
      settingsHash: record.idempotencyKey,
      cacheKey: record.idempotencyKey,
      cacheHit: false,
      chunkCount: 0,
      chunkPlan: [],
      stems: descriptors.map((stem, index) => ({
        id: stem.id,
        displayName: stem.displayName,
        outputIndex: index,
        filePath: stem.filePath,
        sha256: stem.sha256,
        frames: stem.frames,
        sampleRate: stem.sampleRate,
        channelCount: stem.channels,
        bytes: imported.find((entry) => entry.id === stem.id)?.bytes ?? 0,
        peak: stem.peak,
        rms: 0,
        complete: true,
      })),
      timing: {
        startedAt: record.createdAt,
        finishedAt: this.now(),
        totalMs: this.now() - record.createdAt,
      },
      events: [
        { at: record.createdAt, phase: 'Fern-Job erstellt' },
        { at: record.uploadedAt ?? record.createdAt, phase: 'Arbeitskopie hochgeladen' },
        ...(manifest.worker?.claimedAt ? [{ at: manifest.worker.claimedAt, phase: `Worker ${manifest.worker.id}` }] : []),
        { at: this.now(), phase: 'Ergebnisse geprüft und importiert' },
      ],
    };
    const metadataPath = path.join(targetDir, 'job.json');
    await writeFile(`${metadataPath}.tmp`, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await rename(`${metadataPath}.tmp`, metadataPath);

    // Der bestehende Importpfad übernimmt: derselbe Job-Id-Raum, dieselben
    // Kanäle wie bei einem lokalen Lauf (§42).
    await this.local.registerCompletedJob({
      jobId: record.jobId,
      trackName: record.trackName,
      profile: record.profile,
      modelId: record.modelId,
      family: record.family,
      stems: descriptors,
      device: record.device,
      cpuFallback: record.cpuFallback,
      fallbackReason: record.fallbackReason,
      metadata,
      logTag: 'STEM-REMOTE',
    });

    record.localJobId = record.jobId;
    record.importedStems = imported;
    record.status = 'COMPLETED';
    record.phase = REMOTE_PHASES.completed;
    record.percent = 100;
    record.finishedAt = this.now();
    record.error = undefined;
    await this.persist(record);
    await transport
      .writeText(`jobs/${record.jobId}/output/${'result.json'}`, buildResultDocument(manifest, { importedAtIso: new Date(this.now()).toISOString() }))
      .catch(() => undefined);
    this.options.logger?.info?.('STEM-REMOTE', `jobId=${record.jobId} status=COMPLETED stems=${imported.map((stem) => stem.id).join(',')}`, {
      jobId: record.jobId,
      status: 'COMPLETED',
      model: record.modelId,
      worker: manifest.worker?.id,
      device: manifest.worker?.device,
      cpuFallback: manifest.worker?.cpuFallback ?? false,
      stems: imported.map((stem) => stem.id),
    });
    this.emitEvent('completed', record);
  }

  /* --------------------------------------------------------------------- *
   * Abbruch / Neustart
   * --------------------------------------------------------------------- */

  /**
   * Abbruch: markiert den Job lokal als CANCELLED und legt `cancel.flag` in der
   * Jobablage ab, damit der Worker aufhört (§37). Ein später eintreffendes
   * Ergebnis wird verworfen.
   */
  async cancel(jobId: string, reason = 'Abbruch durch Benutzer'): Promise<{ accepted: boolean }> {
    await this.ensureLoaded();
    const record = this.records.get(jobId);
    if (!record || isTerminalStatus(record.status)) return { accepted: false };
    record.cancelRequestedAt = this.now();
    record.status = 'CANCELLED';
    record.phase = `${REMOTE_PHASES.cancelled} – ${reason}`;
    record.finishedAt = record.finishedAt ?? this.now();
    await this.persist(record);
    try {
      const settings = await this.effectiveSettings();
      const transport = this.transportFor(settings);
      await transport.writeText(`jobs/${jobId}/cancel.flag`, `${JSON.stringify({ at: this.now(), reason })}\n`);
    } catch (error) {
      this.options.logger?.warn?.('STEM-REMOTE', `Abbruch konnte nicht an den Worker gemeldet werden: ${error instanceof Error ? error.message : String(error)}`, { jobId });
    }
    this.options.logger?.warn?.('STEM-REMOTE', `jobId=${jobId} status=CANCELLED reason=${reason}`, { jobId, status: 'CANCELLED', reason });
    this.emitEvent('cancelled', record);
    return { accepted: true };
  }

  /**
   * Nach einem Editor-Neustart: dauerhaften Zustand laden, offene Jobs
   * weiterverfolgen und fertige Ergebnisse importieren (§21 A, §32). Der
   * Nutzer muss dafür nichts erneut anklicken.
   */
  async resume(): Promise<RemoteServiceStatus> {
    this.loaded = false;
    await this.ensureLoaded();
    const reopened: string[] = [];
    for (const record of this.records.values()) {
      if (record.status === 'COMPLETED' && !record.localJobId) reopened.push(record.jobId);
    }
    if (reopened.length > 0) {
      this.options.logger?.info?.('STEM-REMOTE', `${reopened.length} fertige(r) Fern-Job(s) wird/werden importiert`, { jobs: reopened });
    }
    return this.poll();
  }

  /* --------------------------------------------------------------------- *
   * Views / Status
   * --------------------------------------------------------------------- */

  list(): RemoteStemJobView[] {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => this.toView(record));
  }

  get(jobId: string): RemoteStemJobView | null {
    const record = this.records.get(jobId);
    return record ? this.toView(record) : null;
  }

  async status(): Promise<RemoteServiceStatus> {
    await this.ensureLoaded();
    const settings = await this.effectiveSettings();
    let reachable = false;
    let reason: string | undefined;
    let transport: IRemoteTransport | undefined;
    try {
      transport = this.transportFor(settings);
      await transport.probe();
      reachable = true;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      reachable = false;
    }
    return this.statusFromSettings(settings, reachable, reason, transport);
  }

  private statusFromSettings(
    settings: RemoteSettingsState,
    reachable: boolean,
    reason?: string,
    transport?: IRemoteTransport
  ): RemoteServiceStatus {
    const jobs = this.list();
    return {
      configured: Boolean(this.injectedTransport || (settings.root && (settings.kind ?? 'folder'))),
      kind: this.injectedTransport?.kind ?? settings.kind ?? (settings.root ? 'folder' : undefined),
      label: transport?.label ?? (settings.kind === 'rclone' ? 'Google Drive (rclone)' : settings.root ? 'Google Drive (Ordner)' : undefined),
      root: this.injectedTransport?.target ?? settings.root,
      reason: this.injectedTransport ? undefined : reason,
      reachable,
      jobs,
      active: jobs.filter((job) => !isTerminalStatus(job.status)).length,
      completed: jobs.filter((job) => job.status === 'COMPLETED').length,
      failed: jobs.filter((job) => job.status === 'FAILED').length,
      pollIntervalMs: this.pollIntervalMs(),
    };
  }

  private toView(record: RemoteJobRecord): RemoteStemJobView {
    return {
      jobId: record.jobId,
      status: record.status,
      phase: record.phase,
      percent: record.status === 'COMPLETED' ? 100 : Math.round(record.workerPercent ?? record.percent),
      profile: record.profile,
      modelId: record.modelId,
      family: record.family,
      backend: record.backend,
      stems: [...record.stems],
      trackName: record.trackName,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      finishedAt: record.finishedAt,
      localJobId: record.localJobId,
      device: record.device,
      cpuFallback: record.cpuFallback,
      fallbackReason: record.fallbackReason,
      worker: record.worker
        ? { id: record.worker.id, claimedAt: record.worker.claimedAt, heartbeatAt: record.worker.heartbeatAt, host: record.worker.host }
        : undefined,
      workerPercent: record.workerPercent,
      attempts: record.attempts,
      error: record.error,
      transport: this.injectedTransport?.label ?? (this.settings.kind === 'rclone' ? 'rclone' : 'Google Drive (Ordner)'),
      transportDegraded: record.transportDegraded,
      importedStems: record.importedStems,
    };
  }

  /* --------------------------------------------------------------------- *
   * Hintergrund-Polling (§20)
   * --------------------------------------------------------------------- */

  private schedulePolling(): void {
    if (this.options.disableBackgroundPolling) return;
    const hasActive = [...this.records.values()].some((record) => !isTerminalStatus(record.status));
    if (!hasActive) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll().catch((error) => {
        this.options.logger?.warn?.('STEM-REMOTE', `Hintergrund-Poll fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.pollIntervalMs());
    this.timer.unref?.();
  }

  private emitEvent(type: RemoteServiceEvent['type'], record: RemoteJobRecord): void {
    if (!this.listeners.size) return;
    const view = this.toView(record);
    for (const listener of this.listeners) {
      try {
        listener({ type, job: { ...view } });
      } catch {
        /* Ein defekter Listener darf den Job nicht aufhalten. */
      }
    }
  }

  onEvent(listener: (event: RemoteServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.listeners.clear();
  }

  /* --------------------------------------------------------------------- *
   * Hilfen
   * --------------------------------------------------------------------- */

  private resolveDescriptor(profile: RemoteJobRecord['profile'], modelId?: string, family?: ModelDescriptor['family']): ModelDescriptor {
    if (modelId) {
      const descriptor = this.registry.get(modelId);
      if (!descriptor) {
        throw new RemoteProtocolError('MODEL_MISSING', `Modell ${modelId} steht nicht im Katalog (src/stems/modelCatalog.json).`);
      }
      if (family && descriptor.family !== family) {
        throw new RemoteProtocolError('MODEL_INCOMPATIBLE', `Modell ${modelId} gehört zur Familie ${descriptor.family}, erwartet ${family}.`);
      }
      if (descriptor.family === 'pipeline_double' && !this.options.allowPipelineDouble) {
        throw new RemoteProtocolError('MODEL_INCOMPATIBLE', 'Das Pipeline-Double ist kein trainiertes Modell und darf nicht remote laufen.');
      }
      return descriptor;
    }
    const candidates = this.registry.rankForProfile(profile, family);
    const descriptor = candidates.find((entry) => entry.family !== 'pipeline_double') ?? candidates[0];
    if (!descriptor) {
      throw new RemoteProtocolError('MODEL_MISSING', `Kein Modell im Katalog bedient das Profil ${profile}.`);
    }
    if (descriptor.family === 'pipeline_double' && !this.options.allowPipelineDouble) {
      throw new RemoteProtocolError('MODEL_INCOMPATIBLE', 'Das Pipeline-Double ist kein trainiertes Modell und darf nicht remote laufen.');
    }
    return descriptor;
  }

  private async writeRemoteError(transport: IRemoteTransport, record: RemoteJobRecord): Promise<void> {
    await transport.writeText(
      `jobs/${record.jobId}/error.json`,
      `${JSON.stringify({ jobId: record.jobId, code: record.error?.code, message: record.error?.message, at: this.now() }, null, 2)}\n`
    );
  }

  private async failRemote(transport: IRemoteTransport, record: RemoteJobRecord): Promise<void> {
    const raw = await transport.readText(`jobs/${record.jobId}/manifest.json`);
    if (!raw) {
      await this.writeRemoteError(transport, record);
      return;
    }
    const manifest = parseManifest(raw, record.jobId);
    const failed: RemoteJobManifest = {
      ...manifest,
      status: 'FAILED',
      phase: 'Zeitüberschreitung im Editor',
      error: record.error ? { ...record.error, at: this.now() } : undefined,
      updatedAt: this.now(),
      updatedAtIso: new Date(this.now()).toISOString(),
    };
    await transport.writeText(`jobs/${record.jobId}/manifest.json`, serializeManifest(failed));
    await this.writeRemoteError(transport, record);
  }

  /** Nur für Tests/Diagnose: zufälliger Worker-Name (nie ein Token). */
  static newWorkerId(prefix = 'editor'): string {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }
}
