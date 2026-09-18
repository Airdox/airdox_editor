/**
 * StemSeparationEngine – orchestrator (§1, §2, §20).
 *
 *   ORIGINAL MIX (read only)
 *     -> fingerprint (sha256 before)
 *     -> WORKING COPY 44.1 kHz stereo float32
 *     -> AI STEM SEPARATION (BS-RoFormer by default, via IStemSeparator)
 *     -> chunked inference with overlap
 *     -> overlap-add reconstruction
 *     -> post processing
 *     -> stem files (only after validation)
 *     -> job metadata + cache
 *     -> fingerprint (sha256 after)  ->  FAIL if the original changed
 *
 * The engine is GUI free. It only depends on the file system and on backends
 * that implement `IStemSeparator`.
 */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { StemSeparationError, classifyFailure, describeError } from './errors';
import { ModelRegistry } from './modelRegistry';
import { ModelManager, type ModelAvailabilityReport } from './modelManager';
import { StemRegistry } from './stemRegistry';
import { SeparationCache, buildCacheKey, hashSettings } from './separationCache';
import { SeparationJob } from './separationJob';
import { SeparationCancellationToken, planChunks, validateChunkPlan, type ChunkPlan } from './chunkProcessor';
import { OverlapAddReconstructor } from './reconstructor';
import { validateSeparation } from './qualityValidator';
import { prepareWorkingCopy, verifyOriginalIntegrity, type WorkingCopy } from './preprocessor';
import { encodeWavFloat32, readWavFile, sha256File, analyzeAudio, type ExternalDecoder } from './wavIo';
import type { BackendKind, ComputeDevice, ModelDescriptor, ModelPrecision, OriginalIntegrity, ProgressCallback, QualityProfile, SeparationJobSummary, SeparationSettings, StemDescriptor, StemId } from './types';
import type { IStemSeparator, BackendSeparationResponse } from './backends/types';
import { BSRoFormerSeparator, MelBandRoFormerSeparator } from './backends/roformerSeparator';
import { HTDemucsSeparator } from './backends/htDemucsSeparator';
import { PipelineDoubleSeparator } from './backends/pipelineDoubleSeparator';

export const DEFAULT_CHUNK_OVERLAP: Record<QualityProfile, number> = {
  PREVIEW: 0.25,
  HIGH_QUALITY: 0.5,
  MAXIMUM_QUALITY: 0.6,
};

/** Preferred precision per profile: quality first, speed only for previews. */
export const PREFERRED_PRECISION: Record<QualityProfile, ModelPrecision[]> = {
  PREVIEW: ['q8_0', 'f16', 'bf16', 'f32', 'native'],
  HIGH_QUALITY: ['f32', 'native', 'bf16', 'f16', 'q8_0'],
  MAXIMUM_QUALITY: ['f32', 'native', 'bf16', 'f16', 'q8_0'],
};

export interface BackendFactoryOptions {
  nativeCommand?: string;
  /**
   * `false` relaxes the python availability probe to "interpreter exists".
   * Only meaningful for the protocol stub of the contract tests; production
   * leaves it unset so a torch-less interpreter stays unavailable.
   */
  requireTorch?: boolean;
  nativeDialect?: 'audio.cpp' | 'bsroformer.cpp';
  pythonCommand?: string;
  adapterScript?: string;
  referenceSourceDir?: string;
  modelStoreDir?: string;
  env?: Record<string, string>;
  pipelineDouble?: PipelineDoubleSeparator;
}

export interface BackendFactory {
  /** All backends that can serve this descriptor, best first. */
  candidates(descriptor: ModelDescriptor): IStemSeparator[];
}

export function createDefaultBackendFactory(options: BackendFactoryOptions = {}): BackendFactory {
  return {
    candidates(descriptor: ModelDescriptor): IStemSeparator[] {
      const out: IStemSeparator[] = [];
      if (descriptor.family === 'pipeline_double') {
        out.push(options.pipelineDouble ?? new PipelineDoubleSeparator());
        return out;
      }
      const transport = {
        transport: 'native-cli' as const,
        nativeCommand: options.nativeCommand ?? process.env.AIRODOX_AUDIOCPP_CLI,
        nativeDialect: options.nativeDialect ?? 'audio.cpp',
        modelStoreDir: options.modelStoreDir,
        env: options.env,
      };
      const python = {
        transport: 'python-torch' as const,
        pythonCommand: options.pythonCommand ?? process.env.AIRODOX_STEM_PYTHON,
        adapterScript: options.adapterScript,
        referenceSourceDir: options.referenceSourceDir,
        modelStoreDir: options.modelStoreDir,
        env: options.env,
        requireTorch: options.requireTorch,
      };
      if (descriptor.family === 'bs_roformer') {
        // Native first: the shipped app must not require Python (§7).
        if (transport.nativeCommand) out.push(new BSRoFormerSeparator(transport));
        out.push(new BSRoFormerSeparator(python));
      }
      if (descriptor.family === 'mel_band_roformer') {
        if (transport.nativeCommand) out.push(new MelBandRoFormerSeparator(transport));
        out.push(new MelBandRoFormerSeparator(python));
      }
      if (descriptor.family === 'htdemucs') {
        out.push(new HTDemucsSeparator({ pythonCommand: python.pythonCommand, modelStoreDir: options.modelStoreDir, env: options.env }));
      }
      return out;
    },
  };
}

export interface SeparationEngineOptions {
  registry?: ModelRegistry;
  /** Root for working copies. */
  workingRoot: string;
  /** Root for separation results (`Separation/`). */
  outputRoot: string;
  /** Root for the separation cache. */
  cacheRoot: string;
  /** Root of the model store (checkpoints/configs). */
  modelStoreDir: string;
  backendFactory?: BackendFactory;
  allowDownload?: boolean;
  /** Required to use the in-process pipeline double. */
  allowPipelineDouble?: boolean;
  externalDecoder?: ExternalDecoder;
  env?: NodeJS.ProcessEnv;
  /** Keep chunk slices and partial files (debugging). */
  keepTemporaries?: boolean;
  /** Override of the recombination tolerance in dB (validator). */
  recombinationLimitDb?: number;
  /** Override of the border specific error tolerance in dB (validator). */
  boundaryErrorExcessDb?: number;
  clock?: () => number;
}

export interface SeparationRequest {
  inputPath: string;
  profile?: QualityProfile;
  modelId?: string;
  family?: ModelDescriptor['family'];
  stems?: StemId[];
  backend?: BackendKind;
  precision?: ModelPrecision;
  device?: ComputeDevice;
  overlap?: number;
  chunkSizeSamples?: number;
  numOverlap?: number;
  clipMode?: 'none' | 'rescale';
  dcRemoval?: boolean;
  extras?: Record<string, string | number | boolean>;
  onProgress?: ProgressCallback;
  token?: SeparationCancellationToken;
  /** Base name of the result directory, defaults to the input base name. */
  trackName?: string;
}

export interface SeparationEngineStatus {
  models: ModelAvailabilityReport[];
  registryIssues: unknown[];
  profiles: Record<QualityProfile, string>;
  cacheEntries: { key: string; dir: string; stems: number }[];
}

/**
 * Post processing of one reconstructed stem.
 *
 * DC removal is opt-in: subtracting a per-stem DC changes the sum of all stems
 * and therefore the relation to the mix. It is only switched on when the caller
 * explicitly asks for it – the validator reports a DC offset instead of
 * silently changing the signal.
 */
function postprocess(
  data: Float32Array,
  clipMode: 'none' | 'rescale',
  removeDc = false,
  ceiling = 0.999
): { data: Float32Array; rescaled: boolean; peak: number } {
  const stats = analyzeAudio(data, 1, data.length);
  let out = data;
  if (removeDc && Math.abs(stats.dc) > 1e-5) {
    out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] - stats.dc;
  }
  const peak = analyzeAudio(out, 1, out.length).peak;
  if (clipMode === 'rescale' && peak > ceiling) {
    const gain = ceiling / peak;
    const scaled = new Float32Array(out.length);
    for (let i = 0; i < out.length; i++) scaled[i] = out[i] * gain;
    return { data: scaled, rescaled: true, peak: ceiling };
  }
  return { data: out, rescaled: false, peak };
}

export class StemSeparationEngine {
  readonly registry: ModelRegistry;
  readonly modelManager: ModelManager;
  readonly cache: SeparationCache;
  private readonly options: SeparationEngineOptions;
  private readonly backendFactory: BackendFactory;

  constructor(options: SeparationEngineOptions) {
    this.options = options;
    this.registry = options.registry ?? ModelRegistry.fromBundledCatalog();
    this.modelManager = new ModelManager(this.registry, {
      storeDir: options.modelStoreDir,
      allowDownload: options.allowDownload,
      env: options.env,
    });
    this.cache = new SeparationCache(options.cacheRoot);
    this.backendFactory = options.backendFactory ?? createDefaultBackendFactory({ modelStoreDir: options.modelStoreDir });
  }

  /** Resolves the model that serves a profile (or the explicitly requested one). */
  resolveModel(profile: QualityProfile, modelId?: string, family?: ModelDescriptor['family']): ModelDescriptor {
    if (modelId) {
      const descriptor = this.registry.require(modelId);
      if (family && descriptor.family !== family) {
        throw new StemSeparationError('MODEL_INCOMPATIBLE', `Modell ${modelId} gehört zur Familie ${descriptor.family}, erwartet ${family}`);
      }
      return descriptor;
    }
    return this.registry.selectForProfile(profile, family);
  }

  /** Builds the settings object; everything reproducible lives here. */
  buildSettings(descriptor: ModelDescriptor, profile: QualityProfile, request: SeparationRequest, backend: IStemSeparator): SeparationSettings {
    const parameters = this.registry.parametersFor(descriptor, profile);
    const precisionList = PREFERRED_PRECISION[profile].filter((precision) => descriptor.precision.includes(precision));
    const precision = request.precision ?? precisionList[0] ?? descriptor.precision[0] ?? 'f32';
    if (!backend.capabilities().supportedPrecision.includes(precision)) {
      throw new StemSeparationError('MODEL_INCOMPATIBLE', `Backend ${backend.name} unterstützt Präzision ${precision} nicht`, {
        supported: backend.capabilities().supportedPrecision,
      });
    }
    const stems = request.stems ?? [...descriptor.stemOrder];
    new StemRegistry(descriptor).assertRequestedStemsSupported(stems);
    return {
      profile,
      modelId: descriptor.id,
      modelVersion: descriptor.version,
      modelHash: descriptor.modelHash,
      family: descriptor.family,
      backend: backend.kind,
      precision,
      device: request.device ?? 'auto',
      sampleRate: descriptor.sampleRate,
      channels: descriptor.inputChannels === 2 ? 2 : 1,
      chunkSizeSamples: request.chunkSizeSamples ?? descriptor.chunkSizeSamples,
      chunkOverlap: request.overlap ?? DEFAULT_CHUNK_OVERLAP[profile],
      numOverlap: request.numOverlap ?? parameters.numOverlap,
      ensemblePasses: parameters.ensemblePasses,
      clipMode: request.clipMode ?? 'rescale',
      dcRemoval: request.dcRemoval ?? false,
      stems,
      extras: request.extras ?? {},
    };
  }

  /** Environment status: models, registry issues, cache contents. */
  async status(): Promise<SeparationEngineStatus> {
    const profiles = {} as Record<QualityProfile, string>;
    for (const profile of ['PREVIEW', 'HIGH_QUALITY', 'MAXIMUM_QUALITY'] as QualityProfile[]) {
      try {
        profiles[profile] = this.registry.selectForProfile(profile).id;
      } catch (error) {
        profiles[profile] = `unavailable: ${describeError(error).message}`;
      }
    }
    return {
      models: await this.modelManager.listStatus(),
      registryIssues: this.registry.issues,
      profiles,
      cacheEntries: await this.cache.entries(),
    };
  }

  /** Main entry point. Returns a summary; throws typed errors otherwise. */
  async separate(request: SeparationRequest): Promise<SeparationJobSummary> {
    const profile = request.profile ?? 'HIGH_QUALITY';
    const descriptor = this.resolveModel(profile, request.modelId, request.family);
    if (descriptor.family === 'pipeline_double' && !this.options.allowPipelineDouble) {
      throw new StemSeparationError(
        'MODEL_INCOMPATIBLE',
        'Das Pipeline-Double ist kein trainiertes Modell. Es darf nur mit allowPipelineDouble=true verwendet werden.'
      );
    }

    // ---- 1. read-only fingerprint + cache lookup -------------------------
    const working = await prepareWorkingCopy(request.inputPath, {
      workingRoot: this.options.workingRoot,
      externalDecoder: this.options.externalDecoder,
      baseName: request.trackName,
    });
    const integrity: OriginalIntegrity = working.integrity;

    // A missing or corrupt checkpoint is the more fundamental failure, so the
    // model is resolved before any backend is probed (§16).
    await this.modelManager.ensureDescriptorAvailable(descriptor);

    // Backend choice happens before the settings hash: the backend is part of
    // the reproducible job identity.
    const backend = await this.selectBackend(descriptor, request.backend);
    const stemRegistry = new StemRegistry(descriptor);

    const job = new SeparationJob({
      inputPath: request.inputPath,
      inputFormat: working.sourceFormat,
      workingRoot: this.options.workingRoot,
      outputRoot: path.join(this.options.outputRoot, request.trackName ?? path.basename(request.inputPath, path.extname(request.inputPath))),
      settings: this.buildSettings(descriptor, profile, request, backend),
      onProgress: request.onProgress,
      token: request.token,
    });
    if (request.token) {
      // Forward cancellation from a caller supplied token into the job token.
      const watcher = setInterval(() => {
        if (request.token!.cancelled) job.cancel(request.token!.reason);
      }, 100);
      watcher.unref?.();
      job.token.waitForResume().catch(() => undefined);
      void watcher;
    }
    job.inputAudioHash = working.inputAudioHash;
    job.originalIntegrity = integrity;
    job.workingCopyPath = working.workingPath;
    job.cacheKey = buildCacheKey(working.inputAudioHash, descriptor.modelHash, job.settingsHash);
    job.report(2, 'Original geprüft (read-only) und Arbeitskopie erzeugt', { totalSeconds: working.seconds });

    try {
      await this.archivePreviousRun(job);
      await job.persist({ inputFormat: working.sourceFormat });

      // ---- 2. cache -------------------------------------------------------
      const cached = await this.cache.lookup(job.cacheKey);
      if (cached.hit && cached.metadata) {
        job.cacheHit = true;
        job.report(60, 'Separation aus Cache wiederverwendet', { totalSeconds: working.seconds });
        const materialised = await this.cache.materialise(job.cacheKey, job.outputDir);
        job.stems = materialised;
        const validation = await this.runValidation(job, materialised, working, descriptor, backend, []);
        job.validation = validation;
        job.setStatus('COMPLETED', 'Aus Cache geladen und validiert');
        await job.persist({ validation, cacheHit: true });
        await this.finishIntegrity(job, integrity);
        return this.summarise(job, validation);
      }
      if (cached.reason?.startsWith('CACHE_CORRUPT')) {
        job.log('cache-corrupt', cached.reason);
      }

      // ---- 4. chunk plan --------------------------------------------------
      const plans = planChunks({
        totalFrames: working.frames,
        chunkSamples: job.settings.chunkSizeSamples,
        overlapFraction: job.settings.chunkOverlap,
        sampleRate: working.sampleRate,
      });
      const coverage = validateChunkPlan(plans, working.frames);
      if (!coverage.ok) {
        throw new StemSeparationError('STEM_CONFIG_INVALID', `Chunk-Plan ist ungültig: ${coverage.problems.join('; ')}`);
      }
      job.chunkCount = plans.length;
      job.chunkPlan = plans.map((plan) => ({ index: plan.index, startSample: plan.startSample, endSample: plan.endSample }));

      // ---- 5. chunked inference + overlap-add ------------------------------
      job.setStatus('RUNNING', 'Chunk-basierte Inferenz läuft');
      const inferenceStart = Date.now();
      const workingAudio = await readWavFile(working.workingPath);
      await mkdir(job.chunkDir, { recursive: true });
      await mkdir(job.partialDir, { recursive: true });

      const reconstructors = new Map<StemId, OverlapAddReconstructor>();
      for (const stem of job.settings.stems) {
        reconstructors.set(stem, new OverlapAddReconstructor({ totalFrames: working.frames, channels: working.channels, plans }));
      }
      let deviceUsed: ComputeDevice = job.settings.device;
      let cpuFallback = false;
      const backendReports: Record<string, unknown>[] = [];

      for (const plan of plans) {
        job.token.throwIfCancelled();
        await job.token.waitForResume();
        const slice = this.sliceAudio(workingAudio, plan, working.channels);
        const slicePath = path.join(job.chunkDir, `chunk_${String(plan.index).padStart(4, '0')}.wav`);
        await writeFile(slicePath, encodeWavFloat32(working.sampleRate, working.channels, slice, plan.endSample - plan.startSample));

        const chunkDir = path.join(job.chunkDir, `out_${String(plan.index).padStart(4, '0')}`);
        await mkdir(chunkDir, { recursive: true });
        const response: BackendSeparationResponse = await backend.separate({
          descriptor,
          workingWavPath: slicePath,
          outputDir: chunkDir,
          stems: job.settings.stems,
          startSample: plan.startSample,
          frames: plan.endSample - plan.startSample,
          chunkIndex: plan.index,
          chunkCount: plans.length,
          numOverlap: job.settings.numOverlap,
          ensemblePasses: job.settings.ensemblePasses,
          precision: job.settings.precision,
          device: job.settings.device,
          profile: job.settings.profile,
          token: job.token,
          extras: job.settings.extras,
          onProgress: (fraction, phase) => {
            const base = 8 + (plan.index / plans.length) * 74;
            const span = (1 / plans.length) * 74;
            job.report(base + fraction * span, `Chunk ${plan.index + 1}/${plans.length}: ${phase}`, {
              totalSeconds: working.seconds,
              chunkIndex: plan.index,
              chunkCount: plans.length,
              processedSeconds: plan.endTime,
            });
          },
        });

        const mapped = stemRegistry.mapOutputs(
          response.stems.map((stem) => ({ name: stem.name, filePath: stem.filePath, outputIndex: stem.outputIndex })),
          job.settings.stems
        );
        for (const [stemId, file] of mapped) {
          const stemAudio = await readWavFile(file.filePath);
          if (stemAudio.channels !== working.channels) {
            throw new StemSeparationError('STEM_CONFIG_INVALID', `Backend lieferte ${stemAudio.channels} Kanäle für ${stemId}, erwartet ${working.channels}`);
          }
          if (Math.abs(stemAudio.frames - (plan.endSample - plan.startSample)) > 1) {
            throw new StemSeparationError('STEM_CONFIG_INVALID', `Backend lieferte ${stemAudio.frames} Frames für ${stemId}, erwartet ${plan.endSample - plan.startSample}`);
          }
          reconstructors.get(stemId)!.add(plan, stemAudio.data);
          await rm(file.filePath, { force: true });
        }
        deviceUsed = response.device;
        cpuFallback = cpuFallback || Boolean(response.cpuFallback);
        backendReports.push(response.report ?? {});
        job.log('chunk-done', `chunk ${plan.index} über ${response.backend}/${response.device}`);
        await rm(chunkDir, { recursive: true, force: true });
        if (!this.options.keepTemporaries) await rm(slicePath, { force: true });
      }
      job.timings.inferenceMs = Date.now() - inferenceStart;

      // ---- 6. reconstruction + post processing -----------------------------
      job.setStatus('RECONSTRUCTING', 'Overlap-Add-Rekonstruktion');
      job.report(86, 'Overlap-Add über alle Chunks', { totalSeconds: working.seconds });
      const reconstructStart = Date.now();
      const stemFiles = new Map<StemId, string>();
      const stemPeaks: Record<string, number> = {};
      for (const stemId of job.settings.stems) {
        const reconstructed = reconstructors.get(stemId)!.finalize();
        const processed = postprocess(reconstructed, job.settings.clipMode, job.settings.dcRemoval);
        stemPeaks[stemId] = processed.peak;
        const target = path.join(job.partialDir, `${stemId}.wav`);
        await writeFile(target, encodeWavFloat32(working.sampleRate, working.channels, processed.data, working.frames));
        stemFiles.set(stemId, target);
      }
      job.timings.reconstructMs = Date.now() - reconstructStart;

      // ---- 7. validation before promotion (§17) ----------------------------
      const boundaryOffsets = plans.filter((plan) => plan.index > 0).map((plan) => plan.startSample);
      const { report: validation, stems: descriptors } = await validateSeparation(stemFiles, {
        expectedSampleRate: working.sampleRate,
        expectedChannels: working.channels,
        expectedFrames: working.frames,
        boundaryOffsets,
        workingCopyPath: working.workingPath,
        fromTrainedModel: backend.capabilities().trainedModel,
        recombinationLimitDb: this.options.recombinationLimitDb,
        boundaryErrorExcessDb: this.options.boundaryErrorExcessDb,
      });
      job.stems = descriptors.map((stem) => ({ ...stem, displayName: stemRegistry.displayName(stem.id) }));
      job.validation = validation;

      if (!validation.pass) {
        job.error = { code: 'VALIDATION_FAILED', message: validation.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message).join(' | ') };
        job.setStatus('FAILED', 'Technische Validierung fehlgeschlagen');
        await job.persist({ validation });
        if (!this.options.keepTemporaries) await job.discardPartial();
        await this.finishIntegrity(job, integrity);
        throw new StemSeparationError('VALIDATION_FAILED', job.error.message, { validation });
      }

      // Promotion: only now do the files become "finished stems".
      for (const [stemId, partialPath] of stemFiles) {
        const finalPath = path.join(job.outputDir, `${stemId}.wav`);
        await rename(partialPath, finalPath);
        const stem = job.stems.find((entry) => entry.id === stemId);
        if (stem) stem.filePath = finalPath;
      }

      job.setStatus('COMPLETED', `Separation mit ${descriptor.id} abgeschlossen`);
      job.report(100, `Fertig: ${job.stems.length} Stems (${descriptor.id})`, { totalSeconds: working.seconds, processedSeconds: working.seconds });
      await job.persist({ validation, chunkPlan: job.chunkPlan });

      // ---- 8. cache ---------------------------------------------------------
      await this.cache.ensureRoot();
      await this.cache.store(job.cacheKey, job.toMetadata(), job.stems.map((stem) => ({ stem, filePath: stem.filePath })));

      await this.finishIntegrity(job, integrity);
      if (!this.options.keepTemporaries) {
        await rm(job.chunkDir, { recursive: true, force: true });
        await rm(job.partialDir, { recursive: true, force: true });
      }
      return this.summarise(job, validation, { deviceUsed, cpuFallback, backendReports });
    } catch (error) {
      if (error instanceof StemSeparationError && error.code === 'INFERENCE_CANCELLED') {
        job.setStatus('CANCELLED', error.message);
        job.error = { code: error.code, message: error.message };
        await job.discardPartial();
        await job.persist();
        await this.finishIntegrity(job, integrity).catch(() => undefined);
        return this.summarise(job);
      }
      const described = describeError(error);
      job.error = described;
      job.setStatus('FAILED', described.message);
      if (!this.options.keepTemporaries) await job.discardPartial().catch(() => undefined);
      await job.persist().catch(() => undefined);
      await this.finishIntegrity(job, integrity).catch(() => undefined);
      throw error instanceof StemSeparationError ? error : classifyFailure('INFERENCE_FAILED', 'Separation fehlgeschlagen', error);
    }
  }

  private async runValidation(
    job: SeparationJob,
    stems: StemDescriptor[],
    working: WorkingCopy,
    descriptor: ModelDescriptor,
    backend: IStemSeparator,
    boundaryOffsets: number[]
  ) {
    const stemFiles = new Map<StemId, string>(stems.map((stem) => [stem.id, stem.filePath]));
    const { report } = await validateSeparation(stemFiles, {
      expectedSampleRate: working.sampleRate,
      expectedChannels: working.channels,
      expectedFrames: working.frames,
      boundaryOffsets,
      workingCopyPath: working.workingPath,
      fromTrainedModel: backend.capabilities().trainedModel,
      recombinationLimitDb: this.options.recombinationLimitDb,
      boundaryErrorExcessDb: this.options.boundaryErrorExcessDb,
    });
    job.log('validated', `pass=${report.pass}`);
    return report;
  }

  private async finishIntegrity(job: SeparationJob, integrity: OriginalIntegrity): Promise<void> {
    const after = await verifyOriginalIntegrity(integrity);
    job.originalIntegrity = after;
    await job.persist();
  }

  private summarise(
    job: SeparationJob,
    validation?: SeparationJobSummary['validation'],
    extra?: { deviceUsed: ComputeDevice; cpuFallback: boolean; backendReports: Record<string, unknown>[] }
  ): SeparationJobSummary {
    const metadata = job.toMetadata();
    if (extra) {
      metadata.events.push({
        at: Date.now(),
        phase: 'backend-report',
        detail: JSON.stringify({ device: extra.deviceUsed, cpuFallback: extra.cpuFallback, reports: extra.backendReports }),
      });
    }
    return {
      jobId: job.jobId,
      status: job.status,
      metadataPath: job.metadataPath,
      stems: job.stems,
      cacheHit: job.cacheHit,
      validation,
      originalIntegrity: job.originalIntegrity ?? metadata.originalIntegrity,
      metadata,
    };
  }

  /** Extracts one chunk as interleaved float32 samples. */
  private sliceAudio(audio: { data: Float32Array; channels: number }, plan: ChunkPlan, channels: number): Float32Array {
    const length = plan.endSample - plan.startSample;
    const out = new Float32Array(length * channels);
    out.set(audio.data.subarray(plan.startSample * channels, plan.endSample * channels));
    return out;
  }

  /**
   * Keeps an earlier result of the same track directory when the new run uses
   * different settings: old stems and metadata move to `.history/<jobId>`
   * instead of being overwritten or mixed with the new run.
   */
  private async archivePreviousRun(job: SeparationJob): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(job.metadataPath, 'utf8');
    } catch {
      return;
    }
    let previous: { jobId?: string; cacheKey?: string; stems?: { id: string }[] };
    try {
      previous = JSON.parse(raw);
    } catch {
      return;
    }
    if (!previous.cacheKey || previous.cacheKey === job.cacheKey) return;
    const historyDir = path.join(job.outputDir, '.history', previous.jobId ?? 'unknown-job');
    await mkdir(historyDir, { recursive: true });
    for (const stem of previous.stems ?? []) {
      await rename(path.join(job.outputDir, `${stem.id}.wav`), path.join(historyDir, `${stem.id}.wav`)).catch(() => undefined);
    }
    await rename(job.metadataPath, path.join(historyDir, 'job.json')).catch(() => undefined);
    job.log('archived-previous-run', `${previous.jobId} -> ${historyDir}`);
  }

  private async selectBackend(descriptor: ModelDescriptor, preferred?: BackendKind): Promise<IStemSeparator> {
    const candidates = this.backendFactory.candidates(descriptor).filter((candidate) => {
      const supports = (candidate as unknown as { supportsDescriptor?: (d: ModelDescriptor) => boolean }).supportsDescriptor;
      return typeof supports === 'function' ? supports.call(candidate, descriptor) : true;
    });
    const ordered = preferred ? [...candidates.filter((c) => c.kind === preferred), ...candidates.filter((c) => c.kind !== preferred)] : candidates;
    const failures: string[] = [];
    for (const candidate of ordered) {
      const availability = await candidate.isAvailable();
      if (availability.available) return candidate;
      failures.push(`${candidate.name}: ${availability.reason ?? 'nicht verfügbar'}`);
    }
    throw new StemSeparationError(
      'BACKEND_UNAVAILABLE',
      `Kein Backend für ${descriptor.id} verfügbar. ${failures.join(' | ') || 'Keine Kandidaten konfiguriert.'}`,
      { modelId: descriptor.id, preferred }
    );
  }
}

/** Convenience wrapper used by tests and the CLI. */
export async function hashFile(filePath: string): Promise<string> {
  return sha256File(filePath);
}

export async function readStemWav(filePath: string) {
  return readWavFile(filePath);
}

export { readFile };
