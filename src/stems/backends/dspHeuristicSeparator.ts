import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeWavFloat32, readWavFile } from '../wavIo';
import { DSP_SEPARATOR_ENGINE, DSP_STEM_LABELS, DSP_STEM_ORDER, separateStemsDspChunked } from '../dspSeparator';
import type { BackendCapabilities, StemId } from '../types';
import type { BackendSeparationRequest, BackendSeparationResult, IStemSeparator } from './types';

export interface DspHeuristicSeparatorOptions {
  stemOrder?: StemId[];
  /** Frame block size used for progress reporting / cooperative yields. */
  blockFrames?: number;
}

/**
 * File-system adapter around the built-in heuristic separator.
 *
 * It is the backend that actually runs on an end-user machine without Python,
 * without a GPU and without a downloaded checkpoint. It is deterministic, it
 * never touches the input file and it always reports `trainedModel: false` so
 * the Stem Isolation Gate can never mistake it for a trained model.
 */
export class DspHeuristicSeparator implements IStemSeparator {
  readonly backendId = DSP_SEPARATOR_ENGINE;
  private readonly options: DspHeuristicSeparatorOptions;

  constructor(options: DspHeuristicSeparatorOptions = {}) {
    this.options = options;
  }

  capabilities(): BackendCapabilities {
    return {
      trainedModel: false,
      supportsCancellation: true,
      supportsStereo: true,
      qualityTier: 'HEURISTIC',
      requiresExternalRuntime: false,
      stemOrder: this.options.stemOrder ?? [...DSP_STEM_ORDER],
    };
  }

  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResult> {
    const input = await readWavFile(request.inputPath);
    const order = request.stemOrder.length ? request.stemOrder : this.capabilities().stemOrder;
    await mkdir(request.outputRoot, { recursive: true });
    request.token?.throwIfCancelled();

    const report = await separateStemsDspChunked(
      { data: input.data, sampleRate: input.sampleRate, channels: input.channels, frames: input.frames },
      {
        stemOrder: order,
        blockFrames: this.options.blockFrames,
        isCancelled: () => Boolean(request.token?.isCancelled),
        onProgress: (progress) => {
          request.token?.throwIfCancelled();
          request.onProgress?.({
            chunkIndex: Math.floor(progress.ratio * 100),
            phase: 'dsp-separating',
            detail: JSON.stringify({ ratio: Number(progress.ratio.toFixed(4)), processedFrames: progress.processedFrames, totalFrames: progress.totalFrames }),
          });
        },
      }
    );

    const events: BackendSeparationResult['events'] = [];
    const stems = [];
    for (const stem of report.stems) {
      request.token?.throwIfCancelled();
      const filePath = path.join(request.outputRoot, `${stem.id}.wav`);
      await writeFile(filePath, encodeWavFloat32(stem.sampleRate, stem.channels, stem.data, stem.frames));
      stems.push({ id: stem.id, filePath, sampleRate: stem.sampleRate, channels: stem.channels, frames: stem.frames });
    }

    const detail = JSON.stringify({
      backend: this.backendId,
      weights: 'dsp-heuristic',
      trainedModel: false,
      qualityTier: report.qualityTier,
      stem_order: report.stemOrder,
      stem_labels: report.stemOrder.map((id) => DSP_STEM_LABELS[id] ?? id),
      recombinationMaxError: report.recombinationMaxError,
      durationMs: report.durationMs,
      notes: report.notes,
    });
    events.push({ phase: 'backend-report', detail });
    request.onProgress?.({ phase: 'backend-report', detail });
    return { stems, events };
  }
}
