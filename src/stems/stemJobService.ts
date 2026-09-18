/**
 * StemJobService – the editor-facing job layer on top of `StemSeparationEngine`.
 *
 * The engine is a headless library: one `separate()` call per job, a caller
 * owned cancellation token, progress through a callback. That is the right
 * shape for tests but not for an app: the renderer needs a job id
 * *immediately* (to draw progress, to offer cancel/pause), needs the stem list
 * before the first sample is written, and needs one stem at a time instead of
 * four multi-megabyte buffers in a single IPC payload.
 *
 * This service is that adapter – and it stays GUI free (no Electron, no React),
 * so `server.ts` (browser/dev) and `electron/main.cjs` (desktop) host the very
 * same implementation. Both transports only forward events and bytes, which is
 * what keeps the two code paths from drifting apart again.
 *
 * Invariants carried over from the engine:
 *  - the stem list comes from the model descriptor (`stemOrder`), never from a
 *    constant in the editor layer;
 *  - originals are read-only: bytes handed over by the renderer are staged
 *    under `Staging/`, the source file on disk is never written to.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isStemError, StemSeparationError } from './errors';
import { KNOWN_FAMILIES, ModelRegistry } from './modelRegistry';
import { SeparationCancellationToken } from './chunkProcessor';
import { OnnxSeparator, type OnnxRuntimeLike } from './backends/onnxSeparator';
import { availabilityCacheKey, BackendAvailabilityCache } from './backends/availabilityCache';
import type { BackendAvailability, IStemSeparator } from './backends/types';
import {
  createDefaultBackendFactory,
  StemSeparationEngine,
  type BackendFactory,
  type BackendFactoryOptions,
} from './stemSeparationEngine';
import type { ExternalDecoder } from './wavIo';
import type {
  ComputeDevice,
  ModelDescriptor,
  ModelFamily,
  ProcessingMode,
  QualityProfile,
  SeparationJobSummary,
  SeparationProgress,
  StemDescriptor,
  StemId,
} from './types';
import { QUALITY_PROFILES } from './types';
import type {
  StartStemJobPayload,
  StemFamilyInfo,
  StemJobView,
  StemServiceEvent,
  StemServiceEventType,
  StemServiceStatus,
} from './transportTypes';

export type {
  StemFamilyInfo,
  StemJobStemView,
  StemJobView,
  StemProfileInfo,
  StemServiceEvent,
  StemServiceEventType,
  StemServiceStatus,
} from './transportTypes';

/** Everything that may cross the transport, described once in `transportTypes`. */
export interface StartStemJobRequest extends Omit<StartStemJobPayload, 'bytes'> {
  /** The service also accepts a detached `ArrayBuffer` (structured clone). */
  bytes?: Uint8Array | ArrayBuffer;
  /** Engine-side escape hatch for backend specific switches (session options). */
  extras?: Record<string, string | number | boolean>;
}

export interface StemJobServiceOptions {
  /** Base directory. `Working/`, `Separation/`, `Cache/`, `Models/`, `Staging/` live inside. */
  root: string;
  env?: Record<string, string | undefined>;
  /** Own registry (tests inject extra models); defaults to the bundled catalog. */
  registry?: ModelRegistry;
  /** Own backend factory; otherwise built from `backend` options. */
  backendFactory?: BackendFactory;
  /** Runtime locations for the real backends (native CLI / python adapter). */
  backend?: BackendFactoryOptions;
  /** Test hook: allows the deterministic pipeline double. Never set in production. */
  allowPipelineDouble?: boolean;
  /** Explicit checkpoint store, otherwise `<root>/Models` (env still wins). */
  modelStoreDir?: string;
  /** Test hook: smaller chunks so the whole pipeline stays fast in CI. */
  chunkSizeSamples?: number;
  /**
   * Validation depth. The app hosts pass `fast_dj` (live path), tests and the
   * quality gates keep the strict default.
   */
  mode?: ProcessingMode;
  /** Requested compute device for in-process backends (ONNX). */
  device?: ComputeDevice;
  /** Inject a loaded onnxruntime-node build (tests / embedded builds). */
  onnxRuntime?: OnnxRuntimeLike;
  /** Loader override for onnxruntime-node. */
  loadOnnxRuntime?: () => Promise<OnnxRuntimeLike>;
  /** Persistenter Cache für Interpreter-Probes (Default: `<root>/Cache`). */
  probeCacheDir?: string;
  /** Geteilter Verfügbarkeits-Cache (Tests; Default: eigener Cache des Kerns). */
  availabilityCache?: BackendAvailabilityCache;
  /** TTL des Gesamt-Status (Default 2000 ms, `AIRODOX_STEM_STATUS_TTL_MS`). */
  statusTtlMs?: number;
  /** Keep `Working/` + chunk slices after a run (debugging). */
  keepTemporaries?: boolean;
  logger?: StemServiceLogger;
  externalDecoder?: ExternalDecoder;
}

export interface StemServiceLogger {
  debug?: (category: string, message: string, details?: unknown) => void;
  info?: (category: string, message: string, details?: unknown) => void;
  warn?: (category: string, message: string, details?: unknown) => void;
  error?: (category: string, message: string, details?: unknown) => void;
}

interface JobRecord {
  view: StemJobView;
  summary?: SeparationJobSummary;
  promise?: Promise<StemJobView>;
}

const FAMILY_LABEL: Record<ModelFamily, string> = {
  bs_roformer: 'BS-RoFormer',
  mel_band_roformer: 'Mel-Band-RoFormer',
  htdemucs: 'HTDemucs',
  pipeline_double: 'Pipeline-Double (Test)',
};

const FAMILY_DESCRIPTION: Record<ModelFamily, string> = {
  bs_roformer: 'Primäre Engine – Band-Split-RoFormer, beste Trennqualität für Vocals/Drums/Bass/Other.',
  mel_band_roformer: 'Alternative RoFormer-Architektur (Mel-Band-Split) – A/B-Vergleich, v. a. für Vocals/Other.',
  htdemucs: 'Legacy-Engine (Hybrid-Transformer-Demucs) – schnellere, ältere Architektur, nur für die Vorschau gedacht.',
  pipeline_double: 'Deterministisches Test-Double – kein trainiertes Modell, nicht für echte Trennung gedacht.',
};

const PROFILE_DESCRIPTION: Record<QualityProfile, string> = {
  PREVIEW: 'Schneller Vorschau-Pfad – gut, um die Verteilung zu prüfen; nicht als Master-Qualität gemeint.',
  BALANCED: 'BS-RoFormer mit ausgewogenen Qualitätseinstellungen.',
  HIGH: 'BS-RoFormer mit hohem Overlap für hochwertige Stems.',
  HIGH_QUALITY: 'BS-RoFormer mit Modell-Empfehlung – Standard für produktionsreife Stems.',
  MAXIMUM_QUALITY: 'BS-RoFormer mit maximalem Overlap und Ensemble-Pässen – langsamste, beste Variante.',
};

function toBuffer(bytes: Uint8Array | ArrayBuffer): Buffer {
  if (bytes instanceof ArrayBuffer) return Buffer.from(new Uint8Array(bytes));
  return Buffer.from(bytes);
}

/**
 * Copy for the transport. Listeners must not be able to mutate live job state,
 * and a slow consumer still sees the view as it was at emit time.
 */
function snapshot(view: StemJobView): StemJobView {
  return {
    ...view,
    stems: [...view.stems],
    error: view.error ? { ...view.error } : undefined,
    result: view.result ? { ...view.result, stems: view.result.stems.map((stem) => ({ ...stem })) } : undefined,
  };
}

export class StemJobService {
  readonly engine: StemSeparationEngine;
  readonly registry: ModelRegistry;
  readonly roots: StemServiceStatus['roots'];
  private readonly options: StemJobServiceOptions;
  private readonly backendFactory: BackendFactory;
  /**
   * Kurzlebiger Cache der Gesamtantwort. Der Editor fragt den Status beim
   * Öffnen der Einstellungen, im Preflight und nach jedem Installationsschritt
   * ab – teils dreimal in zehn Sekunden. Ohne diesen Cache lief die komplette
   * Matrix (inkl. Hashing und Laufzeit-Probes) dreimal.
   */
  private statusCache?: { at: number; value: StemServiceStatus };
  private statusInflight?: Promise<StemServiceStatus>;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly tokens = new Map<string, SeparationCancellationToken>();
  private readonly listeners = new Set<(event: StemServiceEvent) => void>();

  constructor(options: StemJobServiceOptions) {
    this.options = options;
    const root = path.resolve(options.root);
    this.roots = {
      working: path.join(root, 'Working'),
      output: path.join(root, 'Separation'),
      cache: path.join(root, 'Cache'),
      models: options.modelStoreDir ?? path.join(root, 'Models'),
      staging: path.join(root, 'Staging'),
    };
    this.registry = options.registry ?? ModelRegistry.fromBundledCatalog();
    this.backendFactory =
      options.backendFactory ??
      createDefaultBackendFactory({
        ...(options.backend ?? {}),
        modelStoreDir: this.roots.models,
        env: options.env as Record<string, string> | undefined,
        device: options.device,
        onnxRuntime: options.onnxRuntime,
        loadOnnxRuntime: options.loadOnnxRuntime,
        probeCacheDir: options.probeCacheDir ?? this.roots.cache,
      });
    this.engine = new StemSeparationEngine({
      registry: this.registry,
      workingRoot: this.roots.working,
      outputRoot: this.roots.output,
      cacheRoot: this.roots.cache,
      modelStoreDir: this.roots.models,
      mode: options.mode,
      device: options.device,
      onnxRuntime: options.onnxRuntime,
      loadOnnxRuntime: options.loadOnnxRuntime,
      allowPipelineDouble: options.allowPipelineDouble,
      keepTemporaries: options.keepTemporaries,
      externalDecoder: options.externalDecoder,
      env: options.env as NodeJS.ProcessEnv | undefined,
      backendFactory: this.backendFactory,
      probeCacheDir: options.probeCacheDir ?? this.roots.cache,
      availabilityCache: options.availabilityCache,
    });
  }

  /** Subscribes to job events; returns the unsubscribe function. */
  onEvent(listener: (event: StemServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(type: StemServiceEventType, record: JobRecord): void {
    if (!this.listeners.size) return;
    const job = snapshot(record.view);
    for (const listener of this.listeners) {
      try {
        listener({ type, job });
      } catch (error) {
        this.options.logger?.warn?.('STEMS', 'Job-Listener fehlgeschlagen', { error: String(error) });
      }
    }
  }

  private candidatesForDescriptor(descriptor: ModelDescriptor): IStemSeparator[] {
    return this.backendFactory.candidates(descriptor).filter((candidate) => {
      const supports = (candidate as unknown as { supportsDescriptor?: (d: ModelDescriptor) => boolean }).supportsDescriptor;
      return typeof supports === 'function' ? supports.call(candidate, descriptor) : true;
    });
  }

  /**
   * Laufzeit-Verfügbarkeit kommt aus dem *geteilten* Cache des Kerns. Damit
   * gilt dieselbe Antwort für Statusmatrix, Job-Start und Fehlermeldung – und
   * ein Statusaufruf startet nicht mehrfach denselben Interpreter.
   */
  private runtimeAvailabilityForDescriptor(descriptor: ModelDescriptor): Promise<BackendAvailability> {
    // `fast`: der Statusaufruf darf nie an einem echten `import torch` hängen
    // (im Produktionslog bis zu 21 s pro Abfrage). Beim Jobstart gilt weiterhin
    // das strenge Verdikt – derselbe Cache, single-flight.
    return this.engine.backendAvailability(descriptor, { fast: true });
  }

  /**
   * Profile/model/stem matrix plus runtime availability – everything the
   * editor shows. Stems always come from the descriptor, so a two-stem model
   * produces two entries and a future six-stem model produces six.
   */
  async status(): Promise<StemServiceStatus> {
    const ttl = this.options.statusTtlMs ?? Number(this.options.env?.AIRODOX_STEM_STATUS_TTL_MS ?? 5000);
    if (this.statusCache && Date.now() - this.statusCache.at < ttl) return this.statusCache.value;
    if (this.statusInflight) return this.statusInflight;
    const promise = this.computeStatus()
      .then((value) => {
        this.statusCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        if (this.statusInflight === promise) this.statusInflight = undefined;
      });
    this.statusInflight = promise;
    return promise;
  }

  /** Verwirft den Status-Cache (nach Installation/Diagnose). */
  invalidateStatus(): void {
    this.statusCache = undefined;
  }

  private async computeStatus(): Promise<StemServiceStatus> {
    const engineStatus = await this.engine.status({ fast: true });
    const availability = new Map(engineStatus.models.map((model) => [model.modelId, model]));
    const runtimeAvailability = new Map<string, BackendAvailability>();
    const installedDescriptors = this.registry.list().filter((descriptor) => availability.get(descriptor.id)?.available);
    // Parallel statt sequenziell: die Probes sind gecacht/single-flight, aber
    // ein kalter Lauf soll nicht die Summe aller Interpreter-Starts warten.
    const probed = await Promise.all(
      installedDescriptors.map(async (descriptor) => [descriptor.id, await this.runtimeAvailabilityForDescriptor(descriptor)] as const)
    );
    for (const [id, report] of probed) runtimeAvailability.set(id, report);
    const profiles: StemServiceStatus['profiles'] = [];

    for (const profile of QUALITY_PROFILES) {
      let descriptor: ModelDescriptor | null = null;
      let selectionReason: string | undefined;
      let selectionRunnable = false;
      try {
        /*
         * Dieselbe Regel wie im Job: die Matrix bewirbt genau das Modell, das
         * ein Lauf nimmt – und zwar inklusive Laufzeit. Vorher entschied hier
         * nur die Datei-Präsenz: mit installiertem BS-RoFormer-Checkpoint, aber
         * ohne Python/PyTorch wurde BALANCED/HIGH weiter auf BS-RoFormer
         * gemappt (und rot), obwohl der installierte ONNX-Graph dasselbe Profil
         * hätte bedienen können.
         */
        const selection = await this.engine.selectRunnableModel(profile, undefined, { fast: true });
        descriptor = selection.descriptor;
        selectionRunnable = selection.runnable;
        selectionReason = selection.reason;
      } catch {
        descriptor = null;
      }
      if (!descriptor) {
        profiles.push({
          profile,
          modelId: '—',
          family: 'bs_roformer',
          stems: [],
          available: false,
          reason: `Kein Modell im Katalog für Profil ${profile}.`,
          description: PROFILE_DESCRIPTION[profile],
          parameters: { numOverlap: 0, ensemblePasses: 0 },
        });
        continue;
      }
      const model = availability.get(descriptor.id);
      const runtime = runtimeAvailability.get(descriptor.id);
      const parameters = this.registry.parametersFor(descriptor, profile);
      const runnable = selectionRunnable && Boolean(model?.available && runtime?.available);
      profiles.push({
        profile,
        modelId: descriptor.id,
        family: descriptor.family,
        stems: [...descriptor.stemOrder].map((id) => ({ id, displayName: descriptor!.stemDisplayNames[id] ?? id })),
        available: runnable,
        reason: runnable
          ? undefined
          : selectionReason ??
            (model?.available
              ? runtime?.reason ?? 'Kein Backend für dieses Modell verfügbar'
              : model?.reason ?? engineStatus.profiles[profile] ?? 'Modell nicht installiert'),
        description: PROFILE_DESCRIPTION[profile],
        parameters,
      });
    }

    const usable = profiles.some((profile) => profile.available);

    // Architecture switcher (settings menu): one entry per model family, so the
    // UI never has to know which profiles a family serves or hard code labels.
    // The pipeline double is a test fixture, not a selectable architecture.
    const families: StemFamilyInfo[] = KNOWN_FAMILIES.filter((family) => family !== 'pipeline_double').map(
      (family) => {
        const models = this.registry.byFamily(family);
        const serves = [...new Set(models.flatMap((model) => model.qualityProfile.serves))].sort(
          (a, b) => QUALITY_PROFILES.indexOf(a) - QUALITY_PROFILES.indexOf(b)
        );
        const available = models.some((model) => availability.get(model.id)?.available && runtimeAvailability.get(model.id)?.available);
        const reason = available
          ? undefined
          : models.length === 0
            ? `Kein Modell im Katalog für Familie ${family}.`
            : models
                .map((model) => {
                  const files = availability.get(model.id);
                  if (!files?.available) return files?.reason;
                  return runtimeAvailability.get(model.id)?.reason;
                })
                .find(Boolean) ?? 'Modell nicht installiert';
        return {
          family,
          label: FAMILY_LABEL[family],
          description: FAMILY_DESCRIPTION[family],
          available,
          reason,
          serves,
          modelIds: models.map((model) => model.id),
        };
      }
    );

    // Qualität zuerst, aber nur unter dem, was läuft: der Standard muss ein
    // Profil sein, das ein Job auch wirklich fahren kann (§3) – sonst zeigt
    // die UI „bereit“ und der Lauf scheitert an einer fehlenden Laufzeit.
    const defaultProfile: QualityProfile = usable
      ? (['HIGH_QUALITY', 'HIGH', 'BALANCED', 'PREVIEW', 'MAXIMUM_QUALITY'] as QualityProfile[]).find(
          (profile) => profiles.find((entry) => entry.profile === profile)?.available
        ) ?? 'PREVIEW'
      : 'PREVIEW';

    return {
      ok: true,
      usable,
      profiles,
      families,
      defaultProfile,
      models: engineStatus.models.map((model) => {
        const descriptor = this.registry.list().find((entry) => entry.id === model.modelId);
        const runtime = runtimeAvailability.get(model.modelId);
        const runnable = Boolean(model.available && runtime?.available);
        return {
          id: model.modelId,
          family: model.family,
          version: model.version,
          // Format entscheidet in der UI zwischen Subprozess (.th/.ckpt) und
          // in-process ONNX-Graph.
          format: descriptor?.checkpoint?.format,
          installed: runnable,
          hashVerified: Boolean(model.hashVerified),
          reason: runnable ? undefined : model.reason ?? runtime?.reason,
          stems: descriptor ? [...descriptor.stemOrder] : [],
          serves: descriptor ? [...descriptor.qualityProfile.serves] : [],
        };
      }),
      backends: await this.probeBackends(this.registry.list().filter((descriptor) => availability.get(descriptor.id)?.available)),
      onnx: await this.probeOnnx(),
      cacheEntries: engineStatus.cacheEntries.map((entry) => ({ key: entry.key, stems: entry.stems })),
      roots: this.roots,
      registryIssues: engineStatus.registryIssues,
      accessMode: 'ORIGINALS_READ_ONLY',
    };
  }

  /**
   * Which runtimes are reachable. The engine probes per job anyway; this list
   * only exists so the UI can name the reason instead of showing a dead button.
   */
  private async probeBackends(descriptors: ModelDescriptor[] = this.registry.list()): Promise<StemServiceStatus['backends']> {
    const notes: StemServiceStatus['backends'] = [];
    const seen = new Map<string, IStemSeparator>();
    for (const descriptor of descriptors) {
      for (const candidate of this.candidatesForDescriptor(descriptor)) {
        const key = `${candidate.kind}:${candidate.name}`;
        if (!seen.has(key)) seen.set(key, candidate);
      }
    }
    const resolvedAvailability = (candidate: IStemSeparator) =>
      this.engine.availability.resolve(
        availabilityCacheKey(candidate, candidate.name, this.options.device, { fast: true }),
        () => candidate.isAvailable({ fast: true })
      );
    const results = await Promise.all(
      [...seen.values()].map(async (candidate) => {
        const availability = await resolvedAvailability(candidate);
        return {
          kind: candidate.kind,
          name: candidate.name,
          available: availability.available,
          reason: availability.reason,
        };
      })
    );
    notes.push(...results);
    if (!notes.some((entry) => entry.kind === 'native-cli')) {
      notes.push({
        kind: 'native-cli',
        name: this.options.backend?.nativeCommand ?? 'audiocpp_cli',
        available: false,
        reason: 'Natives Separations-Binary fehlt (AIRODOX_AUDIOCPP_CLI)',
      });
    }
    if (!notes.some((entry) => entry.kind === 'python-torch')) {
      notes.push({
        kind: 'python-torch',
        name: this.options.backend?.pythonCommand ?? 'python3',
        available: false,
        reason: 'Kein Python/PyTorch-Backend im Katalog konfiguriert.',
      });
    }
    return notes;
  }

  /**
   * In-process ONNX runtime for the settings menu: loadable? which execution
   * providers? which DJ model would serve it? Runs no inference and needs no
   * weights – a missing model is reported as `modelInstalled: false`, so the
   * user sees *why* the fast path is not available yet.
   */
  private async probeOnnx(): Promise<NonNullable<StemServiceStatus['onnx']>> {
    const env = { ...(process.env as Record<string, string | undefined>), ...(this.options.env ?? {}) };
    const descriptor = this.registry.list().find((model) => model.checkpoint?.format === 'onnx');
    const separator = new OnnxSeparator({
      modelStoreDir: this.roots.models,
      env,
      device: this.options.device,
      family: descriptor?.family ?? 'htdemucs',
      runtime: this.options.onnxRuntime,
      loadRuntime: this.options.loadOnnxRuntime,
    });
    const info = await separator.runtimeInfo();
    return {
      runtimeAvailable: info.available,
      providers: info.providers,
      supported: info.supported,
      modelId: descriptor?.id,
      modelInstalled: descriptor ? await this.engine.isSelectable(descriptor) : false,
      reason: info.reason,
    };
  }

  /** Descriptor a request would resolve to – lets the UI label the run early. */
  describeProfile(profile: QualityProfile, modelId?: string): ModelDescriptor {
    return this.engine.resolveModel(profile, modelId);
  }

  listJobs(): StemJobView[] {
    return [...this.jobs.values()].map((record) => snapshot(record.view));
  }

  getJob(jobId: string): StemJobView | null {
    const record = this.jobs.get(jobId);
    return record ? snapshot(record.view) : null;
  }

  /** Starts a job and returns its view right away; progress arrives via events. */
  async start(request: StartStemJobRequest): Promise<StemJobView> {
    const profile = request.profile ?? 'HIGH_QUALITY';
    let descriptor: ModelDescriptor;
    let selectionReason: string | undefined;
    let selectionRunnable = true;
    try {
      if (request.modelId || request.family) {
        // Fest gewählte Architektur: genau dieses Modell, kein Ausweichen.
        descriptor = this.engine.resolveModel(profile, request.modelId, request.family);
      } else {
        // Freie Profilwahl: das erste Modell, das das Profil bedienen *kann*
        // (Gewichte vorhanden UND Backend startklar) – nicht nur das erste
        // Modell, dessen Dateien zufällig auf der Platte liegen.
        const selection = await this.engine.selectRunnableModel(profile, undefined, { fast: true });
        descriptor = selection.descriptor;
        selectionRunnable = selection.runnable;
        selectionReason = selection.reason;
      }
    } catch (error) {
      throw this.asServiceError(error, 'MODEL_INCOMPATIBLE');
    }
    if (descriptor.family === 'pipeline_double' && !this.options.allowPipelineDouble) {
      throw new StemSeparationError('MODEL_INCOMPATIBLE', 'Das Pipeline-Double ist nur in Tests erlaubt.');
    }
    const stems = request.stems ?? [...descriptor.stemOrder];

    let inputPath = request.inputPath;
    if (!inputPath && !request.bytes) {
      throw new StemSeparationError('AUDIO_MISSING', 'Stem-Job benötigt inputPath oder bytes als Mix-Quelle.');
    }

    /*
     * Fail-fast VOR dem Job (§14): fehlende Gewichte oder eine fehlende
     * Laufzeit sind vor dem ersten Sample bekannt. Ohne diese Prüfung nahm
     * `start()` den Job an, das Backend wurde erst im Lauf geprobt, und der
     * Renderer wartete im `stems:job-wait` 263 s auf ein BACKEND_UNAVAILABLE,
     * das von Anfang an feststand.
     */
    const autoSelected = !request.modelId && !request.family;
    if (autoSelected) {
      /*
       * Der freie Auto-Pfad lehnt hier ab, wenn *kein* Modell des Profils
       * rechenbar ist – sonst wäre der Job von Anfang an zwecklos, und der
       * Grund ist in Millisekunden verfügbar (gecachter Backend-Probe).
       *
       * Eine fest gewählte Architektur (modelId/family) wird weiterhin
       * angenommen: sie gehört dem Nutzer. Der Kern prüft sie jetzt aber
       * *vor* dem Decodieren (selectBackend in `separate()`), sodass auch
       * dieser Weg in Sekunden statt nach Minuten scheitert.
       */
      if (selectionRunnable) {
        // Die Auswahl war lauffähig – die Begründung wird nur für die Ablehnung
        // gebraucht, also nichts nachproben („no duplicate probes“).
        selectionReason = undefined;
      } else {
        selectionReason ??= 'Kein Backend-Kandidat konfiguriert.';
      }
      if (selectionReason) {
        const message = `Kein Backend für ${descriptor.id} verfügbar. ${selectionReason}`;
        this.options.logger?.warn?.('STEMS', 'Stem-Job abgelehnt – kein lauffähiges Backend', {
          profile,
          modelId: descriptor.id,
          reason: selectionReason,
        });
        throw new StemSeparationError('BACKEND_UNAVAILABLE', message, {
          modelId: descriptor.id,
          profile,
        });
      }
    }

    if (!inputPath) {
      inputPath = await this.stageBytes(request.bytes!, request.trackName ?? 'renderer-mix');
    }
    const trackName = request.trackName ?? path.basename(inputPath, path.extname(inputPath));
    const jobId = `stem_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

    const record: JobRecord = {
      view: {
        jobId,
        status: 'PENDING',
        percent: 0,
        phase: 'Job übernommen',
        processedSeconds: 0,
        totalSeconds: 0,
        profile,
        modelId: descriptor.id,
        family: descriptor.family,
        stems,
        chunkCount: 0,
        cacheHit: false,
        trackName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
    this.jobs.set(jobId, record);

    const token = new SeparationCancellationToken();
    this.tokens.set(jobId, token);

    const onProgress = (progress: SeparationProgress) => {
      const view = record.view;
      view.engineJobId = progress.jobId;
      view.status = progress.status;
      view.percent = progress.percent;
      view.phase = progress.phase;
      view.processedSeconds = progress.processedSeconds;
      view.totalSeconds = progress.totalSeconds;
      view.chunkCount = progress.chunkCount ?? view.chunkCount;
      view.updatedAt = Date.now();
      this.emit('progress', record);
    };

    /*
     * Strukturierte Laufzeile (§36). Technische Details (Backend, Gerät,
     * Rückfallgrund) gehören ins Log – die UI zeigt daraus nur „läuft – GPU“
     * bzw. „läuft – CPU“.
     */
    this.options.logger?.info?.('STEM', `backend=${descriptor.checkpoint?.format === 'onnx' ? 'local-mdx' : descriptor.family} status=running`, {
      jobId,
      backend: descriptor.checkpoint?.format === 'onnx' ? 'local-mdx' : descriptor.family,
      model: descriptor.id,
      profile,
      device: request.device ?? this.options.device ?? 'auto',
      status: 'running',
    });

    this.options.logger?.info?.('STEMS', `Stem-Job ${jobId} gestartet`, {
      profile,
      model: descriptor.id,
      stems: descriptor.stemOrder,
      inputPath,
    });

    record.promise = this.engine
      .separate({
        inputPath,
        profile,
        // Pro Job: was der Nutzer im Einstellungsmenü gewählt hat, schlägt den
        // Dienst-Default (der aus der Umgebung kommt).
        mode: request.mode ?? this.options.mode,
        // Re-resolved above (honours `family` when only that was given); pass the
        // concrete id down so the engine does not have to repeat the resolution
        // without the family hint.
        modelId: descriptor.id,
        stems,
        device: request.device ?? this.options.device,
        precision: request.precision,
        overlap: request.overlap,
        chunkSizeSamples: request.chunkSizeSamples ?? this.options.chunkSizeSamples,
        clipMode: request.clipMode,
        dcRemoval: request.dcRemoval,
        extras: request.extras,
        trackName,
        token,
        onProgress,
      })
      .then((summary) => this.finish(jobId, record, summary))
      .catch((error) => {
        const mapped = this.asServiceError(error, 'INFERENCE_FAILED');
        const view = record.view;
        view.status = mapped.code === 'INFERENCE_CANCELLED' ? 'CANCELLED' : 'FAILED';
        view.error = { code: mapped.code, message: mapped.message };
        view.phase = mapped.code === 'INFERENCE_CANCELLED' ? 'Abgebrochen' : `Fehler: ${mapped.code}`;
        view.percent = Math.min(view.percent, 99);
        view.finishedAt = Date.now();
        view.updatedAt = Date.now();
        this.emit(view.status === 'CANCELLED' ? 'cancelled' : 'failed', record);
        this.options.logger?.error?.('STEMS', `Stem-Job ${jobId} ${view.status}`, mapped.toJSON());
        throw mapped;
      })
      .finally(() => {
        this.tokens.delete(jobId);
      });
    // Jobs are fire-and-forget for the transport; `waitFor()` awaits on demand.
    void record.promise.catch(() => undefined);
    return snapshot(record.view);
  }

  private finish(jobId: string, record: JobRecord, summary: SeparationJobSummary): StemJobView {
    record.summary = summary;
    const view = record.view;
    const metadata = summary.metadata;
    view.engineJobId = summary.jobId;
    view.status = summary.status;
    view.cacheHit = summary.cacheHit;
    view.chunkCount = metadata.chunkCount;
    view.percent = summary.status === 'COMPLETED' ? 100 : Math.min(view.percent, 99);
    view.phase =
      summary.status === 'CANCELLED'
        ? 'Abgebrochen – keine Stem-Datei als fertig markiert'
        : summary.status === 'FAILED'
          ? `Fehlgeschlagen: ${metadata.error?.code ?? 'INFERENCE_FAILED'}`
          : summary.cacheHit
            ? 'Aus Cache geladen und validiert'
            : `Fertig: ${summary.stems.length} Stems (${view.modelId})`;
    view.error = metadata.error;
    // Gerät + Rückfall gehören in die Job-Sicht: die UI zeigt „läuft – GPU“
    // bzw. „CPU-Fallback“ und muss das nicht aus dem Backend-Report raten.
    view.device = summary.device;
    view.cpuFallback = summary.cpuFallback;
    view.fallbackReason = summary.fallbackReason;
    // Backend-Kennung wie im Log: der ONNX-Graph im Editor-Prozess ist der
    // lokale Fast-Pfad (`local-mdx`), alles andere nennt seine Familie.
    view.backend = this.registry.get(view.modelId)?.checkpoint?.format === 'onnx' ? 'local-mdx' : view.family;
    view.finishedAt = Date.now();
    view.updatedAt = Date.now();
    /*
     * Abschlusszeile mit Gerät und Rückfallzustand. Genau diese Zeile fehlte,
     * wenn ein DirectML-Lauf still auf CPU gegangen ist – im Log stand nur
     * „Stem-Job … COMPLETED“, nicht womit gerechnet wurde.
     */
    const backendLabel = view.backend ?? view.family;
    if (summary.status === 'COMPLETED' || summary.status === 'FAILED' || summary.status === 'CANCELLED') {
      const statusLabel = summary.cpuFallback ? 'fallback_cpu' : summary.status.toLowerCase();
      this.options.logger?.[summary.status === 'FAILED' ? 'warn' : 'info']?.(
        'STEM',
        `backend=${backendLabel} device=${summary.device ?? 'unbekannt'} status=${statusLabel}`,
        {
          jobId,
          backend: backendLabel,
          device: summary.device,
          status: statusLabel,
          cpuFallback: summary.cpuFallback ?? false,
          ...(summary.fallbackReason ? { reason: summary.fallbackReason } : {}),
          model: view.modelId,
          durationMs: summary.metadata?.timing?.totalMs,
        }
      );
    }
    // Only a completed job hands out stems: after a cancel or a failure the
    // engine has already discarded its partial files, and an unfinished stem
    // must never look finished on the transport layer (§10).
    if (summary.status === 'COMPLETED') {
      const displayNames = this.descriptorStemDisplayNames(view.modelId);
      view.result = {
        outputDir: path.dirname(summary.metadataPath),
        metadataPath: summary.metadataPath,
        stems: summary.stems.map((stem) => ({
          id: stem.id,
          displayName: displayNames[stem.id] ?? stem.id,
          filePath: stem.filePath,
          sha256: stem.sha256,
          frames: stem.frames,
          sampleRate: stem.sampleRate,
          channels: stem.channelCount,
          peak: stem.peak,
        })),
        validationPass: summary.validation?.pass ?? false,
        recombinationErrorDb: summary.validation?.recombinationErrorDb,
        originalUnchanged: summary.originalIntegrity?.unchanged !== false,
        trainedModel: summary.validation?.fromTrainedModel ?? false,
      };
    }
    this.emit(summary.status === 'COMPLETED' ? 'completed' : summary.status === 'CANCELLED' ? 'cancelled' : 'failed', record);
    this.options.logger?.info?.('STEMS', `Stem-Job ${jobId} ${summary.status}`, {
      model: view.modelId,
      cacheHit: summary.cacheHit,
      stems: summary.stems.map((stem: StemDescriptor) => stem.id),
      validation: view.result?.validationPass,
    });
    return view;
  }

  private descriptorStemDisplayNames(modelId: string): Record<string, string> {
    const descriptor = this.registry.get(modelId);
    return descriptor ? { ...descriptor.stemDisplayNames } : {};
  }

  /** Awaits a running job – used by the HTTP transport to answer synchronously. */
  async waitFor(jobId: string): Promise<StemJobView> {
    const record = this.jobs.get(jobId);
    if (!record) throw new StemSeparationError('INFERENCE_FAILED', `Unbekannter Stem-Job ${jobId}`);
    if (!record.promise) return snapshot(record.view);
    return record.promise;
  }

  cancel(jobId: string, reason = 'Abbruch durch Benutzer'): boolean {
    const token = this.tokens.get(jobId);
    if (!token) return false;
    token.cancel(reason);
    this.touch(jobId, `Abbruch angefordert: ${reason}`);
    return true;
  }

  /**
   * Cooperative pause: the chunk that is currently being inferred still
   * finishes (a model cannot be interrupted mid-tensor), the next chunk waits.
   * Results are identical to an uninterrupted run – verified in the suite.
   */
  pause(jobId: string): boolean {
    const token = this.tokens.get(jobId);
    if (!token) return false;
    token.pause();
    this.touch(jobId, 'Pausiert – der nächste Chunk wartet');
    return true;
  }

  resume(jobId: string): boolean {
    const token = this.tokens.get(jobId);
    if (!token) return false;
    token.resume();
    this.touch(jobId, 'Fortgesetzt');
    return true;
  }

  private touch(jobId: string, phase: string): void {
    const record = this.jobs.get(jobId);
    if (!record) return;
    record.view.phase = phase;
    record.view.updatedAt = Date.now();
    this.emit('progress', record);
  }

  /**
   * Trägt ein **außerhalb dieses Prozesses** entstandenes Ergebnis als fertigen
   * Job ein (§15, §42).
   *
   * Der High-Quality-Fernpfad rechnet auf einem Colab-Worker; die Stems liegen
   * nach dem Import lokal als Arbeitskopien. Statt dafür eine zweite
   * Stem-Leseebene (IPC-Kanäle, HTTP-Routen, Renderer-Code) zu bauen, wird das
   * Ergebnis hier registriert: `readStemJobStem`, `readStemJobMetadata`,
   * `listStemJobs` und der bestehende Import im Renderer arbeiten unverändert
   * weiter – ein fertiger Job ist ein fertiger Job, egal welcher Rechner
   * gerechnet hat.
   *
   * Der Aufrufer (Remote-Service) hat Existenz, Größe, Header und Hash der
   * Dateien bereits geprüft; hier wird zusätzlich hart geprüft, dass jede
   * gemeldete Datei existiert und lesbar ist – ein unvollständiger Import darf
   * niemals als COMPLETED erscheinen (§34 I/J/K).
   */
  async registerCompletedJob(input: {
    jobId: string;
    trackName: string;
    profile: QualityProfile;
    modelId: string;
    family: ModelFamily;
    stems: { id: StemId; filePath: string; sha256: string; frames: number; sampleRate: number; channels: number; peak: number; displayName?: string }[];
    device?: ComputeDevice;
    cpuFallback?: boolean;
    fallbackReason?: string;
    metadata?: unknown;
    logTag?: string;
  }): Promise<StemJobView> {
    if (this.jobs.has(input.jobId)) {
      const existing = this.jobs.get(input.jobId)!;
      if (existing.view.status === 'COMPLETED') return snapshot(existing.view);
    }
    if (!input.stems.length) {
      throw new StemSeparationError('VALIDATION_FAILED', `Job ${input.jobId} meldet keine Stems – Import abgelehnt.`);
    }
    const expected = this.registry.get(input.modelId)?.stemOrder ?? [];
    const delivered: StemId[] = [];
    const stemViews = [];
    for (const stem of input.stems) {
      if (expected.length > 0 && !expected.includes(stem.id)) {
        throw new StemSeparationError('VALIDATION_FAILED', `Stem "${stem.id}" gehört nicht zu Modell ${input.modelId} (erwartet: ${expected.join(', ')})`);
      }
      let info;
      try {
        info = await stat(stem.filePath);
      } catch {
        throw new StemSeparationError('VALIDATION_FAILED', `Stem-Datei fehlt: ${stem.filePath}`);
      }
      if (!info.isFile() || info.size <= 44) {
        throw new StemSeparationError('VALIDATION_FAILED', `Stem-Datei ist leer oder kein WAV: ${stem.filePath} (${info.size} Bytes)`);
      }
      delivered.push(stem.id);
      stemViews.push({
        ...stem,
        fileSize: info.size,
        displayName: stem.displayName ?? this.descriptorStemDisplayNames(input.modelId)[stem.id] ?? stem.id,
      });
    }
    /*
     * Vollständigkeit statt „einige Stems reichen“ (§21 K): fehlt einer der
     * vom Deskriptor verlangten Stems, ist der Job nicht fertig.
     */
    const missing = expected.filter((stem) => !delivered.includes(stem));
    if (expected.length > 0 && missing.length > 0) {
      throw new StemSeparationError('VALIDATION_FAILED', `Unvollständiges Ergebnis für ${input.jobId}: es fehlen ${missing.join(', ')}`);
    }

    const now = Date.now();
    const record: JobRecord = {
      view: {
        jobId: input.jobId,
        status: 'COMPLETED',
        percent: 100,
        phase: `Fertig: ${stemViews.length} Stems (${input.modelId}, extern)`,
        processedSeconds: 0,
        totalSeconds: 0,
        profile: input.profile,
        modelId: input.modelId,
        family: input.family,
        stems: delivered,
        chunkCount: 0,
        cacheHit: false,
        trackName: input.trackName,
        createdAt: now,
        updatedAt: now,
        finishedAt: now,
        device: input.device,
        cpuFallback: input.cpuFallback,
        fallbackReason: input.fallbackReason,
        backend: input.family,
        result: {
          outputDir: path.dirname(stemViews[0].filePath),
          metadataPath: '',
          stems: stemViews.map((stem) => ({
            id: stem.id,
            displayName: stem.displayName,
            filePath: stem.filePath,
            sha256: stem.sha256,
            frames: stem.frames,
            sampleRate: stem.sampleRate,
            channels: stem.channels,
            peak: stem.peak,
          })),
          validationPass: true,
          originalUnchanged: true,
          trainedModel: true,
        },
      },
      summary: input.metadata
        ? {
            jobId: input.jobId,
            status: 'COMPLETED',
            metadataPath: '',
            /*
             * Die Stem-Beschreibungen müssen auch im Summary stehen: genau dort
             * liest `stemBytes()` die Dateipfade (derselbe Pfad wie bei einem
             * lokalen Lauf). Vorher blieb das Summary leer und importierte
             * Fern-Ergebnisse waren in der UI nicht abrufbar.
             */
            stems: stemViews.map((stem, index) => ({
              id: stem.id,
              displayName: stem.displayName,
              outputIndex: expected.length > 0 ? Math.max(0, expected.indexOf(stem.id)) : index,
              channelCount: stem.channels,
              sampleRate: stem.sampleRate,
              frames: stem.frames,
              filePath: stem.filePath,
              sha256: stem.sha256,
              bytes: stem.fileSize,
              peak: stem.peak,
              rms: 0,
              complete: true,
            })),
            cacheHit: false,
            originalIntegrity: { path: '', sha256Before: '', sizeBefore: 0, mtimeMsBefore: 0, unchanged: true, checkedAt: now },
            metadata: input.metadata as SeparationJobSummary['metadata'],
            device: input.device,
            cpuFallback: input.cpuFallback,
            fallbackReason: input.fallbackReason,
          }
        : undefined,
    };
    this.jobs.set(input.jobId, record);
    this.options.logger?.info?.(input.logTag ?? 'STEM', `Fremdergebnis übernommen: ${input.jobId} (${input.modelId}, ${delivered.join(', ')})`, {
      device: input.device,
      cpuFallback: input.cpuFallback ?? false,
      stems: delivered,
    });
    this.emit('completed', record);
    return snapshot(record.view);
  }

  /** Reads one separated stem back as WAV bytes for the renderer to decode. */
  async stemBytes(jobId: string, stemId: StemId): Promise<Buffer> {
    const record = this.jobs.get(jobId);
    if (record && record.view.status !== 'COMPLETED') {
      throw new StemSeparationError('STEM_CONFIG_INVALID', `Job ${jobId} ist ${record.view.status}; fertige Stems gibt es nur nach COMPLETED`, {
        status: record.view.status,
      });
    }
    const descriptor = record?.summary?.stems.find((stem) => stem.id === stemId);
    if (!descriptor) {
      throw new StemSeparationError('STEM_CONFIG_INVALID', `Stem "${stemId}" von Job ${jobId} ist nicht verfügbar`, {
        geliefert: record?.summary?.stems.map((stem) => stem.id) ?? [],
      });
    }
    return readFile(descriptor.filePath);
  }

  /** `job.json` – the reproducible record of one run. */
  async jobMetadata(jobId: string): Promise<unknown> {
    const record = this.jobs.get(jobId);
    if (!record) throw new StemSeparationError('INFERENCE_FAILED', `Unbekannter Stem-Job ${jobId}`);
    if (record.summary) return record.summary.metadata;
    throw new StemSeparationError('INFERENCE_FAILED', `Job ${jobId} hat noch keine Metadaten`, { status: record.view.status });
  }

  /** Renderer-side bytes go to `Staging/` – the original file is never touched. */
  private async stageBytes(bytes: Uint8Array | ArrayBuffer, nameHint: string): Promise<string> {
    await mkdir(this.roots.staging, { recursive: true });
    const safe = nameHint.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'input';
    const file = path.join(this.roots.staging, `${safe}_${randomUUID().slice(0, 8)}.wav`);
    await writeFile(file, toBuffer(bytes));
    this.options.logger?.debug?.('STEMS', 'Mix für Separation abgelegt', { file, bytes: toBuffer(bytes).byteLength });
    return file;
  }

  private asServiceError(
    error: unknown,
    fallback: 'INFERENCE_FAILED' | 'MODEL_INCOMPATIBLE' | 'AUDIO_MISSING'
  ): StemSeparationError {
    if (isStemError(error)) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new StemSeparationError(fallback, message, {}, error);
  }
}
