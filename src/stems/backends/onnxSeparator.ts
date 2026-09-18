/**
 * OnnxSeparator – native in-process inference for the DJ path (§ new).
 *
 * Why this exists
 * ---------------
 * The Python/PyTorch path spawns a process, writes a WAV per chunk and reads
 * the stem WAVs back. On a 6 minute track that is hundreds of files and a
 * double-digit number of minutes. ONNX Runtime runs inside this process:
 *
 *   mix (RAM) -> segment tensors (RAM/VRAM) -> session.run -> stems (RAM)
 *
 * No Python, no subprocess, no chunk files. The model is exported from the
 * very same HT-Demucs family, just executed natively.
 *
 * Execution providers
 * -------------------
 * The provider list is decided at runtime, not guessed from the platform:
 * `ort.listSupportedBackends()` reports what the installed runtime carries
 * (the npm package bundles DirectML for win32, CPU everywhere, and CUDA/TensorRT
 * after the cu12 postinstall). Preferred order per device:
 *
 *   auto      : dml (Windows) / coreml (macOS) / cuda, tensorrt (Linux) / cpu
 *   directml  : dml -> cpu
 *   coreml    : coreml -> cpu
 *   cuda      : cuda -> tensorrt -> cpu
 *   cpu       : cpu
 *
 * A session is created once and kept warm (per model + provider list), because
 * loading a 166 MB graph dominates short jobs.
 *
 * Model contract (§4 – models are data)
 * -------------------------------------
 * Everything model specific comes from the descriptor: file name, stem order,
 * precision. The segment length is read from the ONNX graph itself
 * (`inputMetadata[0].shape[2]`) and cross-checked against
 * `descriptor.chunkSizeSamples`; a mismatch is reported, never silently
 * resampled. Stems are mapped through `descriptor.stemOrder`, so a model whose
 * graph emits `[drums, bass, other, vocals]` is labelled correctly even if the
 * descriptor orders them differently.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { StemSeparationError } from '../errors';
import { planChunks, MIN_OVERLAP_SAMPLES, type CancellationToken } from '../chunkProcessor';
import { OverlapAddReconstructor } from '../reconstructor';
import type { BackendAvailability, BackendCapabilities, BackendSeparationRequest, BackendSeparationResponse, IStemSeparator, InlineStem } from './types';
import type { ComputeDevice, ModelDescriptor, ModelFamily, StemId } from '../types';

/* ------------------------------------------------------------------------- *
 * Runtime glue (injectable so the pipeline is testable without the binary)
 * ------------------------------------------------------------------------- */

export interface OnnxTensorLike {
  readonly data: Float32Array;
  readonly dims: readonly number[];
  readonly type?: string;
}

export interface OnnxSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly inputMetadata?: readonly { name: string; type?: string; shape?: readonly (number | string)[] }[];
  readonly outputMetadata?: readonly { name: string; type?: string; shape?: readonly (number | string)[] }[];
  run(feeds: Record<string, OnnxTensorLike>): Promise<Record<string, OnnxTensorLike>>;
}

export interface OnnxRuntimeLike {
  /** Creates (and caches internally) a session for the given model file. */
  InferenceSession: { create(modelPath: string, options?: Record<string, unknown>): Promise<OnnxSessionLike> };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OnnxTensorLike;
  /** Present in onnxruntime-node >= 1.20: what the installed runtime carries. */
  listSupportedBackends?: () => { name: string; bundled?: boolean }[];
}

export interface OnnxSeparatorOptions {
  /** Directory holding the `.onnx` file (models store). */
  modelStoreDir: string;
  env?: Record<string, string | undefined>;
  /** Pre-loaded runtime (tests) – otherwise loaded lazily via `import()`. */
  runtime?: OnnxRuntimeLike;
  /** Loader override for tests: must not throw at import time in CI. */
  loadRuntime?: () => Promise<OnnxRuntimeLike>;
  /** Descriptor family this instance serves (htdemucs, …). */
  family?: ModelFamily;
  /** Provider preference; `descriptor` requests still win per call. */
  device?: ComputeDevice;
  /** Outer segment overlap (fraction of the segment). Default 0.25. */
  segmentOverlapFraction?: number;
  /**
   * Hash verification is intentionally *not* part of `isAvailable()`: hashing a
   * 166 MB graph on every status refresh would be absurd. `stems:bundle:check`
   * and `stems:onnx:doctor` verify it once, the manifest records it.
   */
  verifyHash?: boolean;
}

/* ------------------------------------------------------------------------- *
 * Pure helpers – unit tested without ONNX Runtime
 * ------------------------------------------------------------------------- */

const EP_ALIASES: Record<string, string> = {
  cpu: 'cpu',
  cpuexecutionprovider: 'cpu',
  dml: 'dml',
  directml: 'dml',
  dmlexecutionprovider: 'dml',
  cuda: 'cuda',
  cudaexecutionprovider: 'cuda',
  tensorrt: 'tensorrt',
  tensorrtexecutionprovider: 'tensorrt',
  coreml: 'coreml',
  coremlexecutionprovider: 'coreml',
  webgpu: 'webgpu',
  wasm: 'wasm',
  azure: 'azure',
};

export function normaliseExecutionProvider(name: string): string {
  return EP_ALIASES[name.trim().toLowerCase()] ?? name.trim().toLowerCase();
}

/**
 * Decides the provider order. `supported`/`bundled` come from the runtime
 * (empty when it cannot report them – then the platform order is used as is and
 * a failed session creation falls back to CPU).
 */
export function selectExecutionProviders(input: {
  requested?: ComputeDevice;
  platform?: NodeJS.Platform;
  supported?: string[];
  bundled?: Record<string, boolean>;
}): string[] {
  const requested = input.requested ?? 'auto';
  const platform = input.platform ?? process.platform;
  const supported = (input.supported ?? []).map(normaliseExecutionProvider);
  const bundled = input.bundled ?? {};

  const autoOrder = (): string[] => {
    if (platform === 'win32') return ['dml', 'cuda', 'tensorrt'];
    if (platform === 'darwin') return ['coreml'];
    return ['cuda', 'tensorrt'];
  };

  let candidates: string[];
  switch (requested) {
    case 'cpu':
      candidates = [];
      break;
    case 'directml':
      candidates = ['dml'];
      break;
    case 'coreml':
    case 'metal':
      candidates = ['coreml'];
      break;
    case 'cuda':
      candidates = ['cuda', 'tensorrt'];
      break;
    case 'vulkan':
      // No Vulkan EP in onnxruntime-node; DirectML is the DX12 equivalent.
      candidates = ['dml'];
      break;
    case 'auto':
    default:
      candidates = autoOrder();
      break;
  }

  const order: string[] = [];
  for (const candidate of candidates) {
    // An explicitly requested provider is attempted even when the runtime
    // reports it as not bundled (the CUDA binaries live outside the tarball).
    const explicit = requested !== 'auto';
    const known = supported.length === 0 || supported.includes(candidate);
    const usable = explicit || bundled[candidate] !== false;
    if (known && usable && !order.includes(candidate)) order.push(candidate);
  }
  order.push('cpu');
  return order;
}

/** Model file inside the store (absolute paths are a configuration error). */
export function resolveOnnxModelPath(descriptor: ModelDescriptor, modelStoreDir: string): string {
  const file = descriptor.checkpoint.file;
  if (path.isAbsolute(file)) {
    throw new StemSeparationError('MODEL_MISSING', 'Checkpoint-Pfade müssen relativ zum Model-Store sein', { file });
  }
  return path.join(modelStoreDir, file);
}

/** Static segment length of the graph, or `undefined` for dynamic shapes. */
export function segmentSamplesFromMetadata(
  metadata: readonly { name?: string; shape?: readonly (number | string)[] }[] | undefined
): number | undefined {
  const first = metadata?.[0];
  const shape = first?.shape;
  if (!shape || shape.length < 3) return undefined;
  const length = Number(shape[shape.length - 1]);
  return Number.isFinite(length) && length >= MIN_OVERLAP_SAMPLES * 2 ? length : undefined;
}

/**
 * Cuts one segment out of the interleaved slice and returns the model tensor
 * data. The tail segment is zero padded to the model's fixed input length –
 * padding (not shortening) is what keeps the graph happy and the tail aligned.
 */
export function packSegment(input: {
  samples: Float32Array;
  startFrame: number;
  frames: number;
  channels: number;
  segmentSamples: number;
  /** Destination; reused across segments to avoid per-segment allocation. */
  target?: Float32Array;
}): Float32Array {
  const { samples, startFrame, frames, channels, segmentSamples } = input;
  const target = input.target ?? new Float32Array(channels * segmentSamples);
  target.fill(0);
  const usable = Math.min(frames, segmentSamples);
  const sourceStart = startFrame * channels;
  const available = Math.max(0, Math.min(samples.length - sourceStart, usable * channels));
  if (available > 0) target.set(samples.subarray(sourceStart, sourceStart + available), 0);
  // A tail shorter than the segment stays zero padded; the caller trims the
  // output back to `frames` when adding it to the reconstruction.
  return target;
}

/**
 * Which model output row belongs to which stem. The model emits rows in graph
 * order; the descriptor says what that order means.
 */
export function stemRowsFor(descriptor: ModelDescriptor, requested: StemId[]): { stem: StemId; outputIndex: number }[] {
  return requested.map((stem) => {
    const index = descriptor.stemOrder.indexOf(stem);
    if (index < 0) {
      throw new StemSeparationError('STEM_CONFIG_INVALID', `Stem "${stem}" wird von Modell ${descriptor.id} nicht geliefert`, {
        stemOrder: descriptor.stemOrder,
      });
    }
    return { stem, outputIndex: index };
  });
}

/* ------------------------------------------------------------------------- *
 * Session cache – warm sessions across jobs
 * ------------------------------------------------------------------------- */

interface WarmSession {
  session: OnnxSessionLike;
  providers: string[];
  segmentSamples?: number;
}

const warmSessions = new Map<string, Promise<WarmSession>>();
const warmSessionStates = new Map<string, WarmSession>();

export function warmSessionCount(): number {
  return warmSessionStates.size;
}

/** Drops warm sessions (tests, model updates, memory pressure). */
export async function disposeWarmSessions(): Promise<void> {
  await Promise.all([...warmSessions.values()].map((entry) => entry.catch(() => undefined)));
  warmSessions.clear();
  warmSessionStates.clear();
}

/* ------------------------------------------------------------------------- *
 * Backend
 * ------------------------------------------------------------------------- */

export class OnnxSeparator implements IStemSeparator {
  readonly kind = 'onnx' as const;
  readonly family: ModelFamily;
  readonly name: string;
  private readonly options: OnnxSeparatorOptions;
  private runtimePromise?: Promise<OnnxRuntimeLike>;

  constructor(options: OnnxSeparatorOptions) {
    this.options = options;
    this.family = options.family ?? 'htdemucs';
    this.name = `${this.family}:onnx`;
  }

  capabilities(): BackendCapabilities {
    return {
      kind: this.kind,
      family: this.family,
      name: this.name,
      supportedDevices: ['auto', 'cpu', 'cuda', 'directml', 'coreml'],
      // The graph consumes and emits float32 tensors; the shipped file only
      // *stores* fp16 weights. Announcing 'f16' would promise a precision the
      // engine then has to negotiate for nothing.
      supportedPrecision: ['f32'],
      streamsProgress: true,
      cancellable: true,
      trainedModel: true,
      inMemory: true,
    };
  }

  supportsDescriptor(descriptor: ModelDescriptor): boolean {
    return descriptor.family === this.family && descriptor.checkpoint?.format === 'onnx';
  }

  private async loadRuntime(): Promise<OnnxRuntimeLike> {
    if (!this.runtimePromise) {
      const loader = this.options.loadRuntime ?? (async () => {
        // Optional dependency: a checkout without it must not fail at import.
        const moduleName = 'onnxruntime-node';
        const loaded = (await import(/* @vite-ignore */ moduleName)) as unknown as OnnxRuntimeLike & { default?: OnnxRuntimeLike };
        return loaded?.InferenceSession ? loaded : (loaded.default as OnnxRuntimeLike);
      });
      this.runtimePromise = Promise.resolve()
        .then(loader)
        .then((runtime) => {
          if (!runtime?.InferenceSession || typeof runtime.Tensor !== 'function') {
            throw new StemSeparationError('BACKEND_UNAVAILABLE', 'onnxruntime-node liefert keine InferenceSession (falsche Version?)');
          }
          return runtime;
        })
        .catch((error) => {
          this.runtimePromise = undefined;
          throw new StemSeparationError(
            'BACKEND_UNAVAILABLE',
            'onnxruntime-node ist nicht verfügbar. Installation: npm install (die Binaries kommen aus dem npm-Tarball; ' +
              'in Firmennetzen ggf. `npm install onnxruntime-node --onnxruntime-node-install=skip` und Binaries manuell ablegen). ' +
              `Ursache: ${error instanceof Error ? error.message : String(error)}`
          );
        });
    }
    return this.runtimePromise;
  }

  /** Diagnostics for the doctor script and the UI: which EPs can this host use? */
  async executionProviders(descriptor?: ModelDescriptor): Promise<{ providers: string[]; supported: { name: string; bundled?: boolean }[] }> {
    const runtime = await this.loadRuntime();
    const supported = runtime.listSupportedBackends?.() ?? [];
    const bundled = Object.fromEntries(supported.map((entry) => [normaliseExecutionProvider(entry.name), entry.bundled !== false]));
    return {
      providers: selectExecutionProviders({
        requested: this.options.device,
        supported: supported.map((entry) => entry.name),
        bundled,
      }),
      supported,
    };
  }

  async isAvailable(descriptor?: ModelDescriptor): Promise<BackendAvailability> {
    const probes: { name: string; found: boolean; detail?: string }[] = [];
    try {
      await this.loadRuntime();
      probes.push({ name: 'onnxruntime-node', found: true });
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        probes: [{ name: 'onnxruntime-node', found: false, detail: String(error) }],
      };
    }
    if (descriptor) {
      const modelPath = resolveOnnxModelPath(descriptor, this.options.modelStoreDir);
      const exists = existsSync(modelPath);
      probes.push({ name: descriptor.checkpoint.file, found: exists, detail: modelPath });
      if (!exists) {
        return {
          available: false,
          reason: `ONNX-Modell fehlt: ${descriptor.checkpoint.file} in ${this.options.modelStoreDir}. Laden mit \`npm run stems:bundle -- --models ${descriptor.id}\`.`,
          probes,
        };
      }
      if (this.options.verifyHash && descriptor.checkpoint.sha256) {
        // Opt-in: only the doctor/bundle scripts pay for the full hash.
        const { computeSha256 } = await import('../runtime/checkpointIntegrity');
        const actual = await computeSha256(modelPath);
        if (actual !== descriptor.checkpoint.sha256) {
          return {
            available: false,
            reason: `ONNX-Modell beschädigt: sha256 ${actual} != ${descriptor.checkpoint.sha256}`,
            probes,
          };
        }
        probes.push({ name: 'sha256', found: true, detail: actual });
      }
    }
    return { available: true, probes };
  }

  private async createSession(
    descriptor: ModelDescriptor,
    device: ComputeDevice | undefined,
    runtime: OnnxRuntimeLike
  ): Promise<WarmSession> {
    const modelPath = resolveOnnxModelPath(descriptor, this.options.modelStoreDir);
    const supported = (runtime.listSupportedBackends?.() ?? []).map((entry) => entry.name);
    const bundled = Object.fromEntries(
      (runtime.listSupportedBackends?.() ?? []).map((entry) => [normaliseExecutionProvider(entry.name), entry.bundled !== false])
    );
    const providers = selectExecutionProviders({ requested: device, supported, bundled });
    const key = `${modelPath}|${providers.join(',')}`;
    const cached = warmSessions.get(key);
    if (cached) return cached;

    const created = (async () => {
      const sessionOptions: Record<string, unknown> = {
        executionProviders: providers,
        graphOptimizationLevel: 'all',
        // Let ORT size the thread pool; a fixed 1 would waste the DJ machine.
        intraOpNumThreads: Number(this.options.env?.AIRODOX_ONNX_THREADS ?? 0),
        logSeverityLevel: 3,
      };
      try {
        const session = await runtime.InferenceSession.create(modelPath, sessionOptions);
        const warm: WarmSession = {
          session,
          providers,
          segmentSamples: segmentSamplesFromMetadata(session.inputMetadata as never),
        };
        warmSessionStates.set(key, warm);
        return warm;
      } catch (error) {
        // A provider that exists in the list but not on the machine (missing
        // CUDA DLLs, old driver) must not kill the job – CPU always remains.
        if (providers.length > 1) {
          const session = await runtime.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
            logSeverityLevel: 3,
          });
          const warm: WarmSession = {
            session,
            providers: ['cpu'],
            segmentSamples: segmentSamplesFromMetadata(session.inputMetadata as never),
          };
          warmSessionStates.set(key, warm);
          return warm;
        }
        throw new StemSeparationError(
          'BACKEND_UNAVAILABLE',
          `ONNX-Session konnte nicht erstellt werden (${providers.join(', ')}): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
    warmSessions.set(key, created);
    try {
      return await created;
    } catch (error) {
      warmSessions.delete(key);
      throw error;
    }
  }

  /** Loads the graph and runs nothing – used by the preflight/doctor. */
  async warmUp(descriptor: ModelDescriptor, device?: ComputeDevice): Promise<{ providers: string[]; segmentSamples?: number }> {
    const runtime = await this.loadRuntime();
    const warm = await this.createSession(descriptor, device ?? this.options.device, runtime);
    return { providers: warm.providers, segmentSamples: warm.segmentSamples };
  }

  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResponse> {
    if (!this.supportsDescriptor(request.descriptor)) {
      throw new StemSeparationError('MODEL_INCOMPATIBLE', `ONNX-Backend kann ${request.descriptor.id} nicht bedienen`);
    }
    const started = Date.now();
    const runtime = await this.loadRuntime();
    const warm = await this.createSession(request.descriptor, request.device ?? this.options.device, runtime);

    const channels = request.channels ?? request.descriptor.inputChannels ?? 2;
    const sampleRate = request.sampleRate ?? request.descriptor.sampleRate;
    const frames = request.frames;
    const samples = request.workingSamples;
    if (!samples) {
      throw new StemSeparationError(
        'STEM_CONFIG_INVALID',
        'ONNX-Backend arbeitet in-memory und benötigt workingSamples (kein WAV-Zwischenschritt).'
      );
    }
    if (samples.length < frames * channels) {
      throw new StemSeparationError('STEM_CONFIG_INVALID', `workingSamples zu kurz: ${samples.length} < ${frames * channels}`);
    }

    const segmentSamples = warm.segmentSamples ?? request.descriptor.chunkSizeSamples;
    if (warm.segmentSamples && warm.segmentSamples !== request.descriptor.chunkSizeSamples) {
      request.onProgress?.(0, `Segmentlänge aus dem Graph: ${warm.segmentSamples} (Katalog: ${request.descriptor.chunkSizeSamples})`);
    }

    const overlapFraction = Number(request.extras?.overlapFraction ?? this.options.segmentOverlapFraction ?? 0.25);
    const plans = planChunks({ totalFrames: frames, chunkSamples: segmentSamples, overlapFraction, sampleRate });
    const rows = stemRowsFor(request.descriptor, request.stems);

    const inputName = warm.session.inputNames[0] ?? 'mix';
    const outputName = warm.session.outputNames[0] ?? 'stems';
    const reconstructors = new Map<StemId, OverlapAddReconstructor>();
    for (const { stem } of rows) {
      reconstructors.set(stem, new OverlapAddReconstructor({ totalFrames: frames, channels, plans }));
    }

    const segmentBuffer = new Float32Array(channels * segmentSamples);
    for (const plan of plans) {
      checkCancelled(request.token);
      const planFrames = plan.endSample - plan.startSample;
      const tensorData = packSegment({
        samples,
        startFrame: plan.startSample,
        frames: planFrames,
        channels,
        segmentSamples,
        target: segmentBuffer,
      });
      const tensor = new runtime.Tensor('float32', tensorData, [1, channels, segmentSamples]);
      let output: OnnxTensorLike | undefined;
      try {
        const result = await warm.session.run({ [inputName]: tensor });
        output = result[outputName];
      } catch (error) {
        throw new StemSeparationError(
          'INFERENCE_FAILED',
          `ONNX-Inferenz fehlgeschlagen (Segment ${plan.index + 1}/${plans.length}, Provider ${warm.providers.join('+')}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (!output?.data) {
        throw new StemSeparationError('INFERENCE_FAILED', `ONNX-Ausgabe "${outputName}" fehlt`);
      }
      const expected = rows.length * channels * segmentSamples;
      if (output.data.length < expected) {
        throw new StemSeparationError(
          'STEM_CONFIG_INVALID',
          `ONNX-Ausgabe zu kurz: ${output.data.length} < ${expected} (erwartet ${request.descriptor.stemOrder.length} Stems × ${channels} × ${segmentSamples})`
        );
      }

      // Model output layout: [1, stems, channels, segmentSamples] interleaved
      // per stem. Only the frames of this plan are handed to the reconstructor;
      // the zero padding of the tail segment is trimmed here.
      const perStem = channels * segmentSamples;
      for (const { stem, outputIndex } of rows) {
        const base = outputIndex * perStem;
        const chunk = new Float32Array(planFrames * channels);
        chunk.set(output.data.subarray(base, base + planFrames * channels));
        reconstructors.get(stem)!.add(plan, chunk);
      }
      request.onProgress?.((plan.index + 1) / plans.length, `Segment ${plan.index + 1}/${plans.length} (${warm.providers[0]})`);
      checkCancelled(request.token);
    }

    const inlineStems: InlineStem[] = rows.map(({ stem, outputIndex }) => ({
      name: stem,
      samples: reconstructors.get(stem)!.finalize(),
      frames,
      channels,
      outputIndex,
    }));

    const device: ComputeDevice = warm.providers[0] === 'dml' ? 'directml' : warm.providers[0] === 'coreml' ? 'coreml' : warm.providers[0] === 'cpu' ? 'cpu' : 'cuda';
    const requestedDevice = request.device ?? this.options.device ?? 'auto';
    return {
      engine: this.family,
      backend: this.kind,
      stems: [],
      inlineStems,
      device,
      // Nur melden, wenn wirklich auf CPU zurückgefallen wurde – 'auto' ohne
      // GPU ist kein Rückfall, sondern das erwartete Ergebnis.
      cpuFallback: device === 'cpu' && requestedDevice !== 'cpu' && requestedDevice !== 'auto',
      report: {
        backendName: this.name,
        totalMs: Date.now() - started,
        providers: warm.providers,
        segmentSamples,
        segmentCount: plans.length,
        overlapFraction,
        sampleRate,
        precision: request.precision,
        warmSessions: warmSessionStates.size,
        zeroDiskChunks: true,
      },
    };
  }
}

function checkCancelled(token?: CancellationToken): void {
  token?.throwIfCancelled();
}

/** Provider order for the UI/doctor without a model (platform based). */
export function describeProviderPlan(requested?: ComputeDevice): string[] {
  return selectExecutionProviders({ requested });
}
