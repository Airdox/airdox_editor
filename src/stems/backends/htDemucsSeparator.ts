import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { BackendCapabilities, StemId } from '../types';
import type { BackendSeparationRequest, BackendSeparationResult, IStemSeparator } from './types';
import { PipelineDoubleSeparator } from './pipelineDoubleSeparator';
import { runProcessTransport, runWithGpuFallback } from './processTransport';
import { readWavFile } from '../wavIo';
import { StemSeparationError } from '../errors';
import { getModelCatalog } from '../modelRegistry';

export class HTDemucsSeparator implements IStemSeparator {
  readonly backendId = 'htdemucs';
  private readonly fallback?: PipelineDoubleSeparator;
  private readonly stemOrder: StemId[];
  private readonly pythonPath?: string;
  private readonly modelName?: string;

  constructor(options: { fallback?: PipelineDoubleSeparator; stemOrder?: StemId[]; pythonPath?: string; modelName?: string } = {}) {
    this.fallback = options.fallback;
    const catalog = (() => {
      try { return getModelCatalog(); } catch { return null; }
    })();
    const catalogOrder = catalog?.models.find(m => m.id === 'htdemucs-ft-4stem')?.stemOrder;
    this.stemOrder = options.stemOrder ?? catalogOrder ?? ['drums', 'bass', 'other', 'vocals'];
    this.pythonPath = options.pythonPath ?? process.env.AIRODOX_PYTHON ?? 'python';
    this.modelName = options.modelName ?? 'htdemucs_ft';
  }

  capabilities(): BackendCapabilities {
    return {
      trainedModel: !this.fallback,
      supportsCancellation: true,
      supportsStereo: true,
      stemOrder: this.stemOrder,
      backend: 'htdemucs',
    };
  }

  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResult> {
    if (this.fallback) {
      // In CI without checkpoint, use double but preserve Demucs stem order
      return this.fallback.separate({ ...request, stemOrder: this.stemOrder });
    }

    // Try python demucs
    try {
      return await this.separateDemucs(request);
    } catch (e) {
      if (this.fallback) return this.fallback.separate({ ...request, stemOrder: this.stemOrder });
      throw e;
    }
  }

  private async separateDemucs(request: BackendSeparationRequest): Promise<BackendSeparationResult> {
    await mkdir(request.outputRoot, { recursive: true });
    const events: { phase: string; detail?: string }[] = [];

    // Demucs quality profile: shifts 10, overlap 0.5, float32, clip-mode rescale per memory
    const args = [
      '-m', 'demucs.separate',
      '--two-stems', // actually we want 4 stems, so no two-stems
      '-n', this.modelName!,
      '--shifts', '10',
      '--overlap', '0.5',
      '--float32',
      '--clip-mode', 'rescale',
      '-o', request.outputRoot,
      request.inputPath,
    ].filter(Boolean);

    // Remove --two-stems if 4 stems requested (default is 4)
    const filteredArgs = args.filter(a => a !== '--two-stems');

    const result = await runWithGpuFallback(
      {
        command: this.pythonPath!,
        args: filteredArgs,
        token: request.token,
        onEvent: (evt) => {
          events.push({ phase: evt.phase, detail: evt.detail });
          request.onProgress?.(evt);
        },
      },
      { CUDA_VISIBLE_DEVICES: '' },
      (line) => request.onProgress?.({ phase: 'log', detail: line }),
    );

    // Demucs outputs to outputRoot/<model>/<track>/stems
    // Find wav files
    const { readdir } = await import('node:fs/promises');
    const stems: BackendSeparationResult['stems'] = [];
    const search = async (dir: string): Promise<void> => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) await search(full);
          else if (ent.isFile() && ent.name.endsWith('.wav')) {
            const id = path.basename(ent.name, '.wav') as StemId;
            if (request.stemOrder.includes(id) || this.stemOrder.includes(id)) {
              try {
                const wav = await readWavFile(full);
                stems.push({ id, filePath: full, sampleRate: wav.sampleRate, channels: wav.channels, frames: wav.frames });
              } catch {}
            }
          }
        }
      } catch {}
    };
    await search(request.outputRoot);

    if (stems.length === 0) {
      throw new StemSeparationError('INFERENCE_FAILED', `HT-Demucs produced no stems. stderr: ${result.stderr.slice(0,1000)}`);
    }

    // Ensure order matches requested
    const ordered = request.stemOrder.map(id => stems.find(s => s.id === id)).filter(Boolean) as BackendSeparationResult['stems'];
    return { stems: ordered.length ? ordered : stems, events: [...events, ...result.events] };
  }
}

export function stemNamesForModel(modelId: string, fallback: StemId[] = ['drums', 'bass', 'other', 'vocals']): StemId[] {
  try {
    const catalog = getModelCatalog();
    const entry = catalog.models.find(m => m.id === modelId);
    if (entry) return entry.stemOrder;
  } catch {}
  return fallback;
}

export function buildDemucsArgs(options: { model: string; shifts: number; overlap: number; float32: boolean; clipMode: string; output: string; input: string }): string[] {
  return [
    '-m', 'demucs.separate',
    '-n', options.model,
    '--shifts', String(options.shifts),
    '--overlap', String(options.overlap),
    ...(options.float32 ? ['--float32'] : []),
    '--clip-mode', options.clipMode,
    '-o', options.output,
    options.input,
  ];
}
