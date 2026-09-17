import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { BackendCapabilities, StemId } from '../types';
import type { BackendSeparationRequest, BackendSeparationResult, IStemSeparator } from './types';
import { PipelineDoubleSeparator } from './pipelineDoubleSeparator';
import { runProcessTransport, runWithGpuFallback } from './processTransport';
import { readWavFile } from '../wavIo';
import { StemSeparationError } from '../errors';

/**
 * Adapter for BS-RoFormer transports.
 * Priority:
 * 1. native-cli `audiocpp_cli --task sep` (vocals+instrumental fixed) first
 * 2. python-torch adapter `python/bsroformer_inference.py`
 */

export interface RoformerOptions {
  backendId?: string;
  stemOrder?: StemId[];
  fallback?: PipelineDoubleSeparator;
  nativeCliPath?: string;
  pythonPath?: string;
  modelPath?: string;
  checkpointPath?: string;
}

export class BSRoFormerSeparator implements IStemSeparator {
  readonly backendId: string;
  private readonly stemOrder: StemId[];
  private readonly fallback?: PipelineDoubleSeparator;
  private readonly nativeCliPath?: string;
  private readonly pythonPath?: string;
  private readonly modelPath?: string;
  private readonly checkpointPath?: string;

  constructor(options: RoformerOptions = {}) {
    this.backendId = options.backendId ?? 'bsroformer';
    this.stemOrder = options.stemOrder ?? ['vocals', 'bass', 'drums', 'other'];
    this.fallback = options.fallback;
    this.nativeCliPath = options.nativeCliPath ?? process.env.AIRODOX_ROFORMER_CLI ?? 'audiocpp_cli';
    this.pythonPath = options.pythonPath ?? process.env.AIRODOX_PYTHON ?? 'python';
    this.modelPath = options.modelPath ?? process.env.AIRODOX_MSST_DIR;
    this.checkpointPath = options.checkpointPath;
  }

  capabilities(): BackendCapabilities {
    const hasNative = this.checkNativeAvailable();
    const hasPython = !!this.modelPath || !!this.checkpointPath;
    const trained = hasNative || hasPython || !this.fallback;
    return {
      trainedModel: trained && !this.fallback,
      supportsCancellation: true,
      supportsStereo: true,
      stemOrder: this.stemOrder,
      backend: this.backendId,
      hasNativeCli: hasNative,
      hasPython,
    };
  }

  private checkNativeAvailable(): boolean {
    try {
      if (!this.nativeCliPath) return false;
      // Don't actually run, just check if path exists or is in PATH
      if (existsSync(this.nativeCliPath)) return true;
      // If it's a bare command, assume maybe available (will fail later and fallback)
      if (!this.nativeCliPath.includes('/') && !this.nativeCliPath.includes('\\')) return true;
      return false;
    } catch {
      return false;
    }
  }

  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResult> {
    // 1. Try native-cli first if available and model is 2-stem compatible
    if (this.checkNativeAvailable()) {
      try {
        return await this.separateNative(request);
      } catch (e) {
        // If model incompatible (expects 4 stems but native only supports vocals+instrumental), try python
        if (e instanceof StemSeparationError && e.code === 'MODEL_INCOMPATIBLE') {
          // fall through to python
        } else {
          // If native fails for other reason and fallback exists, use fallback
          if (this.fallback) {
            return this.fallback.separate({ ...request, stemOrder: this.stemOrder });
          }
          throw e;
        }
      }
    }

    // 2. Try python-torch adapter
    if (this.modelPath || this.checkpointPath || process.env.AIRODOX_MSST_DIR) {
      try {
        return await this.separatePython(request);
      } catch (e) {
        if (this.fallback) {
          return this.fallback.separate({ ...request, stemOrder: this.stemOrder });
        }
        throw e;
      }
    }

    if (!this.fallback) {
      throw new StemSeparationError('BACKEND_UNAVAILABLE', 'BS-RoFormer-Backend ist ohne installierten Checkpoint nicht verfügbar. Setze AIRODOX_MSST_DIR oder installiere audiocpp_cli');
    }
    return this.fallback.separate({ ...request, stemOrder: this.stemOrder });
  }

  private async separateNative(request: BackendSeparationRequest): Promise<BackendSeparationResult> {
    // native-cli supports vocals+instrumental fixed only per spec
    if (request.stemOrder.length !== 2 || !request.stemOrder.includes('vocals')) {
      // But spec says first try native-cli, which is vocals+instrumental fixed, so 4-stem should be MODEL_INCOMPATIBLE
      if (request.stemOrder.length === 4) {
        throw new StemSeparationError('MODEL_INCOMPATIBLE', 'audiocpp_cli supports only vocals+instrumental, requested 4 stems');
      }
    }

    await mkdir(request.outputRoot, { recursive: true });
    const events: { phase: string; detail?: string }[] = [];

    const args = [
      '--task', 'sep',
      '--input', request.inputPath,
      '--output', request.outputRoot,
      '--model', this.checkpointPath ?? 'bsroformer',
    ];

    const result = await runProcessTransport({
      command: this.nativeCliPath!,
      args,
      token: request.token,
      onEvent: (evt) => {
        events.push({ phase: evt.phase, detail: evt.detail });
        request.onProgress?.(evt);
      },
    });

    // Native cli should output vocals.wav and instrumental.wav – we need to map to requested stemOrder
    // For 4-stem request, this would have already thrown MODEL_INCOMPATIBLE
    const stems = [];
    for (const id of request.stemOrder) {
      const fileName = id === 'vocals' ? 'vocals.wav' : 'instrumental.wav';
      const filePath = path.join(request.outputRoot, fileName);
      const wav = await readWavFile(filePath);
      stems.push({ id, filePath, sampleRate: wav.sampleRate, channels: wav.channels, frames: wav.frames });
    }

    return { stems, events: [...events, ...result.events] };
  }

  private async separatePython(request: BackendSeparationRequest): Promise<BackendSeparationResult> {
    await mkdir(request.outputRoot, { recursive: true });
    const events: { phase: string; detail?: string }[] = [];

    const scriptPath = path.join(process.cwd(), 'python', 'bsroformer_inference.py');
    const args = [
      scriptPath,
      '--input', request.inputPath,
      '--output', request.outputRoot,
      '--stem-order', request.stemOrder.join(','),
    ];
    if (this.checkpointPath) args.push('--checkpoint', this.checkpointPath);
    if (this.modelPath) args.push('--model-dir', this.modelPath);
    if (request.extras?.precision) args.push('--precision', String(request.extras.precision));

    const result = await runWithGpuFallback(
      {
        command: this.pythonPath!,
        args,
        token: request.token,
        onEvent: (evt) => {
          events.push({ phase: evt.phase, detail: evt.detail });
          request.onProgress?.(evt);
        },
      },
      { CUDA_VISIBLE_DEVICES: '' },
      (line) => request.onProgress?.({ phase: 'log', detail: line }),
    );

    // Python adapter writes JSONL with stem events and final done
    const stems = [];
    for (const id of request.stemOrder) {
      const filePath = path.join(request.outputRoot, `${id}.wav`);
      try {
        const wav = await readWavFile(filePath);
        stems.push({ id, filePath, sampleRate: wav.sampleRate, channels: wav.channels, frames: wav.frames });
      } catch {
        // If file missing, try to find any wav
        continue;
      }
    }

    if (stems.length === 0) {
      throw new StemSeparationError('INFERENCE_FAILED', `Python backend produced no stems. stdout: ${result.stdout.slice(0,500)} stderr: ${result.stderr.slice(0,500)}`);
    }

    return { stems, events: [...events, ...result.events] };
  }
}

/** Mel-band transport uses the same engine contract as BS-RoFormer. */
export class MelBandRoFormerSeparator extends BSRoFormerSeparator {
  constructor(options: RoformerOptions = {}) {
    super({ ...options, backendId: options.backendId ?? 'melband-roformer' });
  }
}
