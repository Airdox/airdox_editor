import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeWavFloat32, readWavFile } from '../wavIo';
import { planChunks } from '../chunkProcessor';
import type { StemId } from '../types';
import type { BackendSeparationRequest, BackendSeparationResult, IStemSeparator } from './types';
export interface PipelineDoubleOptions { mode?: 'coherent' | 'split'; simulatedMsPerFrame?: number; stemOrder?: StemId[]; }
/** Deterministic transport double. It proves file/chunk/orchestration behaviour, never separation quality. */
export class PipelineDoubleSeparator implements IStemSeparator {
  readonly backendId = 'pipeline-double';
  private readonly options: PipelineDoubleOptions;
  constructor(options: PipelineDoubleOptions = {}) { this.options = options; }
  capabilities() { return { trainedModel: false, supportsCancellation: true, supportsStereo: true, stemOrder: this.options.stemOrder ?? ['vocals', 'drums', 'bass', 'other'] as StemId[] }; }
  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResult> {
    const input = await readWavFile(request.inputPath); const order = request.stemOrder.length ? request.stemOrder : this.capabilities().stemOrder; await mkdir(request.outputRoot, { recursive: true });
    const outputs = new Map<StemId, Float32Array>(); for (const id of order) outputs.set(id, new Float32Array(input.data.length));
    const other = outputs.get('other') ?? outputs.get(order[order.length - 1]);
    if (this.options.mode === 'split' && order.length) { const gain = 1 / order.length; for (const id of order) { const dest = outputs.get(id)!; for (let i = 0; i < dest.length; i++) dest[i] = input.data[i] * gain; } }
    else if (other) other.set(input.data); // exact recombination fixture
    // Chunked transport simulation: the double walks the same chunk plan a real backend would (5 s chunks, 50 % overlap), reports per-chunk progress and honours cancellation between chunks — the crash-recovery tests of the isolation gate rely on both.
    const plans = planChunks({ totalFrames: input.frames, chunkSamples: Math.max(1, Math.round(input.sampleRate * 5)), overlapFraction: 0.5 });
    const simulated = this.options.simulatedMsPerFrame ?? 0;
    for (const plan of plans) {
      request.token?.throwIfCancelled();
      if (simulated > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(300, simulated * (plan.endSample - plan.startSample) / 1000)));
      request.onProgress?.({ chunkIndex: plan.chunkIndex, phase: 'chunk', detail: `chunk ${plan.chunkIndex + 1}/${plans.length}` });
    }
    request.token?.throwIfCancelled(); request.onProgress?.({ chunkIndex: 0, phase: 'backend-report', detail: JSON.stringify({ backend: this.backendId, weights: 'double', stem_order: order }) });
    const stems = []; for (const id of order) { request.token?.throwIfCancelled(); const filePath = path.join(request.outputRoot, `${id}.wav`); await writeFile(filePath, encodeWavFloat32(input.sampleRate, input.channels, outputs.get(id)!, input.frames)); stems.push({ id, filePath, sampleRate: input.sampleRate, channels: input.channels, frames: input.frames }); }
    return { stems, events: [{ phase: 'backend-report', detail: JSON.stringify({ backend: this.backendId, weights: 'double', stem_order: order }) }] };
  }
}
