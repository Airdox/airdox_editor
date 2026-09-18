/**
 * HTDemucs backend – the PREVIEW engine (§6).
 *
 * Faster hybrid transformer separation used for previews. It is a full trained
 * model, but for HIGH_QUALITY and MAXIMUM_QUALITY the engine selects
 * BS-RoFormer instead.
 *
 * Demucs writes one WAV per stem *named after the stem*. The mapping to output
 * indices still goes through the descriptor's `stemOrder`, so the contract is
 * identical to the RoFormer backends.
 */
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { StemSeparationError } from '../errors';
import { runBackendProcess } from './processTransport';
import { pythonDeviceFor } from './roformerSeparator';
import { probeTorchRuntime } from './runtimeProbe';
import type { BackendAvailability, BackendCapabilities, BackendSeparationRequest, BackendSeparationResponse, IStemSeparator, BackendAvailabilityOptions } from './types';
import type { ComputeDevice, ModelDescriptor, ModelFamily } from '../types';

export interface HTDemucsSeparatorOptions {
  pythonCommand?: string;
  modelStoreDir?: string;
  env?: Record<string, string>;
  /** Persistenter Probe-Cache (siehe runtimeProbe.ts). */
  probeCacheDir?: string;
}

export class HTDemucsSeparator implements IStemSeparator {
  readonly kind = 'python-torch' as const;
  readonly family: ModelFamily = 'htdemucs';
  readonly name = 'htdemucs:python-torch';
  readonly availabilityKey: string;
  private readonly options: HTDemucsSeparatorOptions;

  constructor(options: HTDemucsSeparatorOptions = {}) {
    this.options = options;
    this.availabilityKey = [
      this.kind,
      this.family,
      options.pythonCommand ?? 'python3',
      options.modelStoreDir ?? '',
    ].join('|');
  }

  capabilities(): BackendCapabilities {
    return {
      kind: this.kind,
      family: this.family,
      name: this.name,
      supportedDevices: ['auto', 'cpu', 'cuda'],
      supportedPrecision: ['f32'],
      streamsProgress: false,
      cancellable: true,
      trainedModel: true,
      inMemory: false,
      // Demucs verarbeitet nativ ganze Songs (eigene --overlap-Fensterung):
      // ein Prozessstart + Modell-Laden pro Track, nicht pro Engine-Chip.
      processesWholeFile: true,
    };
  }

  supportsDescriptor(descriptor: ModelDescriptor): boolean {
    return descriptor.family === 'htdemucs';
  }

  async isAvailable(options: BackendAvailabilityOptions = {}): Promise<BackendAvailability> {
    const python = this.options.pythonCommand ?? 'python3';
    // Derselbe gecachte, zweistufige Probe wie beim RoFormer-Pfad: erst
    // `find_spec`, dann ein echter Import – beides höchstens einmal je
    // Interpreter (statt 60 s Interpreter-Start pro Statusabfrage).
    const probe = await probeTorchRuntime({
      command: python,
      env: this.options.env,
      requireImport: true,
      modules: ['demucs', 'torch'],
      cacheDir: this.options.probeCacheDir,
      mode: options.fast ? 'fast' : 'strict',
    });
    return {
      available: probe.available,
      reason: probe.available
        ? undefined
        : `${probe.reason ?? 'Demucs ist nicht importierbar'}${probe.detail ? `: ${probe.detail}` : ''}`,
      probes: [{ name: python, found: probe.available, detail: probe.detail ?? probe.torchVersion }],
      detail: {
        torchVersion: probe.torchVersion,
        interpreterVersion: probe.interpreterVersion,
        verification: probe.verification,
        probeCached: probe.cached,
        probeMs: probe.durationMs,
      },
    };
  }

  private buildArgs(request: BackendSeparationRequest): string[] {
    const model = request.descriptor.version || 'htdemucs_ft';
    const args = [
      '-m', 'demucs',
      '--name', model,
      '--overlap', '0.5',
      '--float32',
      '--clip-mode', 'rescale',
      '--jobs', '1',
      '--out', request.outputDir,
    ];
    // Demucs-argparse kennt nur cpu/cuda/mps – directml & Co. wären Exit 2.
    const device = pythonDeviceFor(request.device);
    if (device !== 'auto') args.push('--device', device);
    args.push(request.workingWavPath);
    return args;
  }

  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResponse> {
    if (!this.supportsDescriptor(request.descriptor)) {
      throw new StemSeparationError('MODEL_INCOMPATIBLE', `HTDemucs-Backend kann ${request.descriptor.id} nicht bedienen`);
    }
    const python = this.options.pythonCommand ?? 'python3';
    const result = await runBackendProcess({
      command: python,
      args: this.buildArgs(request),
      env: this.options.env,
      token: request.token,
      onProgress: (fraction, phase) => request.onProgress?.(fraction, phase),
    });

    const model = request.descriptor.version || 'htdemucs_ft';
    const baseName = path.basename(request.workingWavPath, path.extname(request.workingWavPath));
    const songDir = path.join(request.outputDir, model, baseName);
    let files: string[];
    try {
      files = await readdir(songDir);
    } catch {
      throw new StemSeparationError('INFERENCE_FAILED', `Demucs-Ausgabeordner fehlt: ${songDir}`, { logs: result.logs });
    }
    const stems = files
      .filter((file) => file.toLowerCase().endsWith('.wav'))
      .map((file) => {
        const name = file.replace(/\.wav$/i, '').toLowerCase();
        const outputIndex = request.descriptor.stemOrder.findIndex((stem) => stem.toLowerCase() === name);
        return { name, filePath: path.join(songDir, file), outputIndex: outputIndex >= 0 ? outputIndex : undefined };
      });
    if (stems.length === 0) {
      throw new StemSeparationError('INFERENCE_FAILED', 'Demucs hat keine Stems geschrieben', { logs: result.logs });
    }
    const device = (request.device === 'auto' ? result.device : request.device) as ComputeDevice;
    return {
      engine: this.family,
      backend: this.kind,
      stems,
      device,
      cpuFallback: result.device === 'cpu' && request.device !== 'cpu' && request.device !== 'auto',
      report: { backendName: this.name, processMs: result.durationMs, logs: result.logs.slice(-20) },
    };
  }
}
