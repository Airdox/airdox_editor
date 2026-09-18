/**
 * RoFormer family backends (§5, §18).
 *
 * One implementation covers both RoFormer families – BS-RoFormer (the primary
 * high quality engine) and Mel-Band RoFormer – because they share the wire
 * protocol and differ only in family name, session options and default
 * parameters. The family is data (descriptor + registry), the code is shared.
 *
 * Two transports:
 *  - `native-cli`: a native C++ binary. `audio.cpp` style
 *    (`audiocpp_cli --task sep --family bs_roformer …`) is the default contract
 *    for the shipped application: no Python, no PyTorch, GGUF weights.
 *  - `python-torch`: the bundled adapter `python/bsroformer_inference.py`
 *    driving the upstream reference implementation. Development, model
 *    conversion and offline tests (§7).
 */
import path from 'node:path';
import { StemSeparationError, classifyFailure } from '../errors';
import { runBackendProcess, probeExecutable, EXIT_MODEL } from './processTransport';
import type { BackendAvailability, BackendSeparationRequest, BackendSeparationResponse, IStemSeparator } from './types';
import type { BackendCapabilities } from './types';
import type { BackendKind, ComputeDevice, ModelDescriptor, ModelFamily, ModelPrecision } from '../types';

/**
 * Native runtimes name their output files themselves (`vocals.wav`,
 * `instrumental.wav`). The mapping below converts those names into *output
 * indices*; the stem identity is then resolved through the descriptor's
 * `stemOrder`. Names are never mapped straight to stem ids.
 */
const NATIVE_NAME_TO_INDEX: Record<string, number> = {
  vocals: 0,
  vocal: 0,
  instrumental: 1,
  accompaniment: 1,
  other: 1,
  drums: 2,
  bass: 3,
  guitar: 4,
  piano: 5,
};

export interface RoFormerTransportConfig {
  transport: 'native-cli' | 'python-torch';
  /** Native binary (`audiocpp_cli`, `bs_roformer-cli`, …). */
  nativeCommand?: string;
  /** Native CLI dialect. */
  nativeDialect?: 'audio.cpp' | 'bsroformer.cpp';
  /** Python interpreter for the torch transport. */
  pythonCommand?: string;
  /** Absolute path of `python/bsroformer_inference.py`. */
  adapterScript?: string;
  /** Root of the upstream reference implementation (development only). */
  referenceSourceDir?: string;
  /** Directory holding checkpoint/config files. */
  modelStoreDir?: string;
  env?: Record<string, string>;
  /**
   * Strictness of the availability probe. Default `true` (production): the
   * runtime counts as available only when the interpreter can import `torch`,
   * so a job is never started against a runtime that dies on the first import.
   * Contract tests drive a protocol stub that needs no torch and set this to
   * `false` – they still exercise the real transport code.
   */
  requireTorch?: boolean;
}

export interface RoFormerSeparatorOptions extends RoFormerTransportConfig {
  family: ModelFamily;
  /** Session option prefix, e.g. `bs_roformer` or `mel_band_roformer`. */
  sessionPrefix: string;
}

export class RoFormerSeparator implements IStemSeparator {
  readonly kind: BackendKind;
  readonly family: ModelFamily;
  readonly name: string;
  private readonly sessionPrefix: string;
  private readonly config: RoFormerSeparatorOptions;

  constructor(options: RoFormerSeparatorOptions) {
    this.family = options.family;
    this.sessionPrefix = options.sessionPrefix;
    this.config = options;
    this.kind = options.transport === 'native-cli' ? 'native-cli' : 'python-torch';
    this.name =
      options.transport === 'native-cli'
        ? `${options.family}:${options.nativeDialect ?? 'audio.cpp'}`
        : `${options.family}:python-torch`;
  }

  capabilities(): BackendCapabilities {
    return {
      kind: this.kind,
      family: this.family,
      name: this.name,
      supportedDevices: this.kind === 'native-cli' ? ['auto', 'cpu', 'cuda', 'vulkan', 'metal'] : ['auto', 'cpu', 'cuda'],
      supportedPrecision: ['native', 'f32', 'f16', 'bf16', 'q8_0'],
      streamsProgress: true,
      cancellable: true,
      trainedModel: true,
      inMemory: false,
    };
  }

  /**
   * Native builds expose a fixed output set (BS-RoFormer: vocals +
   * instrumental). A descriptor asking for more stems is rejected here instead
   * of silently returning a partial result.
   */
  supportsDescriptor(descriptor: ModelDescriptor): boolean {
    if (descriptor.family !== this.family) return false;
    if (this.kind !== 'native-cli') return true;
    const supported = new Set([0, 1]);
    return descriptor.stemOrder.every((_stem, index) => supported.has(index)) && descriptor.stemOrder.length <= 2;
  }

  async isAvailable(): Promise<BackendAvailability> {
    if (this.kind === 'native-cli') {
      const command = this.config.nativeCommand ?? 'audiocpp_cli';
      const probe = await probeExecutable(command, ['--help']);
      return {
        available: probe.found,
        reason: probe.found ? undefined : `Natives Separations-Binary nicht gefunden: ${command}`,
        probes: [{ name: command, found: probe.found, detail: probe.detail }],
      };
    }
    const python = this.config.pythonCommand ?? 'python3';
    const requiresTorch = this.config.requireTorch !== false;
    const probe = await probeExecutable(
      python,
      requiresTorch ? ['-c', 'import torch; print(torch.__version__)'] : ['-c', 'print(1)']
    );
    const adapter = this.config.adapterScript;
    return {
      available: probe.found && Boolean(adapter),
      reason: !probe.found
        ? requiresTorch
          ? `Python/PyTorch-Laufzeit nicht verfügbar (${python})`
          : `Python-Laufzeit nicht verfügbar (${python})`
        : !adapter
          ? 'Adapter-Skript python/bsroformer_inference.py ist nicht konfiguriert'
          : undefined,
      probes: [{ name: python, found: probe.found, detail: probe.detail }],
      detail: { adapterScript: adapter, referenceSourceDir: this.config.referenceSourceDir },
    };
  }

  private resolveCheckpoint(descriptor: ModelDescriptor): string {
    const store = this.config.modelStoreDir;
    if (!store) throw new StemSeparationError('MODEL_MISSING', 'modelStoreDir ist nicht konfiguriert');
    return path.join(store, descriptor.checkpoint.file);
  }

  private buildNativeArgs(request: BackendSeparationRequest): string[] {
    const descriptor = request.descriptor;
    const dialect = this.config.nativeDialect ?? 'audio.cpp';
    const checkpoint = this.resolveCheckpoint(descriptor);
    if (dialect === 'bsroformer.cpp') {
      const args = [checkpoint, request.workingWavPath, path.join(request.outputDir, 'stem_0_vocals.wav')];
      args.push('--chunk-size', String(descriptor.chunkSizeSamples), '--overlap', String(request.numOverlap));
      return args;
    }
    const args = [
      '--task',
      'sep',
      '--family',
      this.sessionPrefix,
      '--model',
      checkpoint,
      '--audio',
      request.workingWavPath,
      '--out-dir',
      request.outputDir,
      '--backend',
      request.device === 'auto' ? 'best' : request.device,
      // Quality first: the packaged (model recommended) overlap stays the
      // default; lower values are an explicit opt-in speed tradeoff.
      '--session-option',
      `${this.sessionPrefix}.num_overlap=${request.numOverlap}`,
    ];
    if (request.precision !== 'native') {
      args.push('--session-option', `${this.sessionPrefix}.weight_type=${request.precision}`);
    }
    return args;
  }

  private buildPythonArgs(request: BackendSeparationRequest): string[] {
    const descriptor = request.descriptor;
    const adapter = this.config.adapterScript;
    if (!adapter) throw new StemSeparationError('BACKEND_UNAVAILABLE', 'Adapter-Skript ist nicht konfiguriert');
    const store = this.config.modelStoreDir;
    const args = [
      adapter,
      '--family',
      this.family,
      '--checkpoint',
      this.resolveCheckpoint(descriptor),
      '--input',
      request.workingWavPath,
      '--output-dir',
      request.outputDir,
      '--stem-order',
      descriptor.stemOrder.join(','),
      '--chunk-size',
      String(descriptor.chunkSizeSamples),
      '--num-overlap',
      String(request.numOverlap),
      '--ensemble-passes',
      String(request.ensemblePasses),
      '--precision',
      request.precision,
      '--device',
      request.device,
    ];
    if (descriptor.config?.file && store) {
      args.push('--config', path.join(store, descriptor.config.file));
    }
    if (this.config.referenceSourceDir) {
      args.push('--reference-source-dir', this.config.referenceSourceDir);
    }
    // Development/offline only: architecture without trained weights. The job
    // metadata records `weights: "random"` so the result cannot be mistaken
    // for a real separation.
    if (request.extras?.allowRandomWeights === true) {
      args.push('--allow-random-weights');
    }
    args.push('--stems', request.stems.join(','));
    return args;
  }

  private async runOnce(request: BackendSeparationRequest, device: ComputeDevice): Promise<BackendSeparationResponse> {
    const isNative = this.kind === 'native-cli';
    const command = isNative ? (this.config.nativeCommand ?? 'audiocpp_cli') : (this.config.pythonCommand ?? 'python3');
    const args = isNative ? this.buildNativeArgs({ ...request, device }) : this.buildPythonArgs({ ...request, device });

    const result = await runBackendProcess({
      command,
      args,
      env: this.config.env,
      token: request.token,
      onProgress: request.onProgress,
      timeoutMs: Number(request.extras?.timeoutMs ?? 0) > 0 ? Number(request.extras?.timeoutMs) : undefined,
    });

    const stems = result.stems
      .filter((stem) => stem.name && stem.path)
      .map((stem) => {
        const key = stem.name.toLowerCase().replace(/\.(wav|flac)$/i, '');
        const nativeIndex = NATIVE_NAME_TO_INDEX[key];
        const outputIndex = typeof stem.index === 'number' ? stem.index : nativeIndex;
        return { name: key, filePath: stem.path, outputIndex };
      });

    if (stems.length === 0) {
      throw new StemSeparationError('INFERENCE_FAILED', 'Backend hat keine Stem-Dateien gemeldet', {
        logs: result.logs.slice(-5),
        stderr: result.stderr.slice(-800),
      });
    }

    // The checkpoint config is authoritative for the stem order: a mismatch
    // must fail loudly instead of delivering mislabelled stems.
    const configOrder = Array.isArray(result.report?.configStemOrder) ? (result.report.configStemOrder as string[]) : [];
    if (configOrder.length > 0) {
      const declared = request.descriptor.stemOrder.slice(0, configOrder.length);
      if (declared.join(',') !== configOrder.join(',')) {
        throw new StemSeparationError(
          'MODEL_INCOMPATIBLE',
          `stem_order des Modells ${request.descriptor.id} (${declared.join(',')}) widerspricht dem Checkpoint-Config (${configOrder.join(',')})`,
          { descriptorOrder: request.descriptor.stemOrder, configOrder }
        );
      }
    }

    return {
      engine: this.family,
      backend: this.kind,
      stems,
      device: result.device,
      cpuFallback: device !== request.device,
      report: { ...result.report, backendName: this.name, processMs: result.durationMs, logs: result.logs.slice(-20) },
    };
  }

  /**
   * Runs the separation and falls back to CPU when the requested accelerator is
   * missing or runs out of memory (§16: GPU-Fallback darf nie zum Abbruch der
   * ganzen Separation führen).
   */
  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResponse> {
    if (!this.supportsDescriptor(request.descriptor)) {
      throw new StemSeparationError(
        'MODEL_INCOMPATIBLE',
        `Backend ${this.name} kann Modell ${request.descriptor.id} nicht bedienen (Stem-Umfang: ${request.descriptor.stemOrder.join(', ')})`
      );
    }
    try {
      return await this.runOnce(request, request.device);
    } catch (error) {
      const message = error instanceof Error ? `${error.message} ${(error as StemSeparationError).details ? JSON.stringify((error as StemSeparationError).details) : ''}` : String(error);
      const gpuIssue =
        request.device !== 'cpu' &&
        /gpu|cuda|vulkan|metal|out of memory|cudnn|device-side/i.test(message);
      if (gpuIssue) {
        const fallback = await this.runOnce(request, 'cpu').catch((cpuError) => {
          throw classifyFailure('GPU_UNAVAILABLE', `GPU-Inferenz fehlgeschlagen und CPU-Fallback ebenfalls: ${message}`, cpuError);
        });
        return { ...fallback, cpuFallback: true };
      }
      if (error instanceof StemSeparationError) throw error;
      throw classifyFailure('INFERENCE_FAILED', 'RoFormer-Inferenz fehlgeschlagen', error);
    }
  }
}

/** BS-RoFormer – primary high quality engine. */
export class BSRoFormerSeparator extends RoFormerSeparator {
  constructor(options: RoFormerTransportConfig) {
    super({ ...options, family: 'bs_roformer', sessionPrefix: 'bs_roformer' });
  }
}

/** Mel-Band RoFormer – comparison family for later model A/B runs. */
export class MelBandRoFormerSeparator extends RoFormerSeparator {
  constructor(options: RoFormerTransportConfig) {
    super({ ...options, family: 'mel_band_roformer', sessionPrefix: 'mel_band_roformer' });
  }
}

export { EXIT_MODEL };
