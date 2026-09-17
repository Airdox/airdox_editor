import { StemSeparationError } from './errors';

export interface ChunkPlan {
  chunkIndex: number;
  startSample: number;
  endSample: number;
  startFrame: number;
  endFrame: number;
  overlapBefore: number;
  overlapAfter: number;
  weightStart: number;
  weightEnd: number;
}

export interface ChunkPlanOptions {
  totalFrames: number;
  chunkSamples: number;
  overlapFraction?: number;
  sampleRate?: number;
  numOverlap?: number;
}

export function planChunks(options: ChunkPlanOptions): ChunkPlan[] {
  const total = Math.max(0, Math.floor(options.totalFrames));
  const size = Math.max(1, Math.floor(options.chunkSamples));
  const overlap = Math.max(0, Math.min(0.9, options.overlapFraction ?? 0.5));
  const step = Math.max(1, Math.floor(size * (1 - overlap)));
  const plans: ChunkPlan[] = [];
  for (let start = 0, index = 0; start < total; start += step, index++) {
    const end = Math.min(total, start + size);
    const overlapBefore = start ? Math.max(0, Math.min(start, Math.floor(size * overlap))) : 0;
    const overlapAfter = end < total ? Math.max(0, Math.min(total - end, Math.floor(size * overlap))) : 0;
    plans.push({
      chunkIndex: index,
      startSample: start,
      endSample: end,
      startFrame: start,
      endFrame: end,
      overlapBefore,
      overlapAfter,
      weightStart: start === 0 ? 0 : overlapBefore,
      weightEnd: end >= total ? 0 : overlapAfter,
    });
    if (end >= total) break;
  }
  return plans;
}

export function validateChunkPlan(plans: ChunkPlan[], totalFrames: number): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!plans.length && totalFrames > 0) errors.push('Chunk plan empty but totalFrames > 0');
  let covered = 0;
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    if (p.startSample < 0 || p.endSample <= p.startSample) errors.push(`Chunk ${i} invalid start/end`);
    if (p.startSample < covered && i !== 0) {
      // overlap allowed, but gap not
    }
    if (p.startSample > covered) errors.push(`Gap between chunk ${i-1} and ${i}: ${covered} -> ${p.startSample}`);
    covered = Math.max(covered, p.endSample);
    if (p.endSample > totalFrames) errors.push(`Chunk ${i} exceeds totalFrames`);
  }
  if (covered < totalFrames) errors.push(`Plan does not cover full range: covered ${covered} < total ${totalFrames}`);
  return { valid: errors.length === 0, errors };
}

export class SeparationCancellationToken {
  private cancelled = false;
  private paused = false;
  private pausePromise: Promise<void> | null = null;
  private resumeResolver: (() => void) | null = null;

  cancel(): void {
    this.cancelled = true;
    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = null;
    }
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.pausePromise = new Promise<void>((resolve) => {
      this.resumeResolver = resolve;
    });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = null;
    }
    this.pausePromise = null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  async waitIfPaused(): Promise<void> {
    if (this.paused && this.pausePromise) {
      await this.pausePromise;
    }
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new StemSeparationError('CANCELLED', 'Separation cancelled');
  }
}

export interface ChunkProcessingContext {
  chunk: ChunkPlan;
  data: Float32Array;
  channels: number;
  sampleRate: number;
}

export function raisedCosineWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  if (size === 1) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return w;
}

export function buildOverlapAddWeights(totalFrames: number, plans: ChunkPlan[]): Float64Array {
  const weights = new Float64Array(totalFrames);
  for (const plan of plans) {
    const chunkSize = plan.endSample - plan.startSample;
    const window = raisedCosineWindow(chunkSize);
    // Apply raised cosine in overlap regions, flat in middle
    for (let i = 0; i < chunkSize; i++) {
      const globalIdx = plan.startSample + i;
      if (globalIdx >= totalFrames) break;
      let w = 1;
      if (i < plan.overlapBefore) {
        // Fade in
        w = window[i] ?? 1;
        if (plan.overlapBefore > 0) w = 0.5 - 0.5 * Math.cos((Math.PI * i) / plan.overlapBefore);
      } else if (i >= chunkSize - plan.overlapAfter) {
        // Fade out
        const j = i - (chunkSize - plan.overlapAfter);
        if (plan.overlapAfter > 0) w = 0.5 + 0.5 * Math.cos((Math.PI * j) / plan.overlapAfter);
      }
      weights[globalIdx] += w;
    }
  }
  return weights;
}
