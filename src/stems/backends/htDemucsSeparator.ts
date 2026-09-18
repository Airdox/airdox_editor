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
import { runBackendProcess, probeExecutable } from './processTransport';
import type { BackendAvailability, BackendCapabilities, BackendSeparationRequest, BackendSeparationResponse, IStemSeparator } from './types';
import type { ComputeDevice, ModelDescriptor, ModelFamily } from '../types';

export interface HTDemucsSeparatorOptions {
  pythonCommand?: string;
  modelStoreDir?: string;
  env?: Record<string, string>;
}

export class HTDemucsSeparator implements IStemSeparator {
  readonly kind = 'python-torch' as const;
  readonly family: ModelFamily = 'htdemucs';
  readonly name = 'htdemucs:python-torch';
  private readonly options: HTDemucsSeparatorOptions;

  constructor(options: HTDemucsSeparatorOptions = {}) {
    this.options = options;
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
    };
  }

  supportsDescriptor(descriptor: ModelDescriptor): boolean {
    return descriptor.family === 'htdemucs';
  }

  async isAvailable(): Promise<BackendAvailability> {
    const python = this.options.pythonCommand ?? 'python3';
    const probe = await probeExecutable(python, ['-c', 'import demucs, torch; print("ok")'], 60000, this.options.env);
    return {
      available: probe.found,
      reason: probe.found ? undefined : `Demucs ist in ${python} nicht importierbar${probe.detail ? `: ${probe.detail}` : ''}`,
      probes: [{ name: python, found: probe.found, detail: probe.detail }],
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
    if (request.device !== 'auto') args.push('--device', request.device as string);
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
      cpuFallback: result.device === 'cpu' && request.device !== 'cpu',
      report: { backendName: this.name, processMs: result.durationMs, logs: result.logs.slice(-20) },
    };
  }
}
