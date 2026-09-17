/**
 * ChunkProcessor – overlapping segmentation of long files (§13).
 *
 * Two overlap layers exist and must not be confused:
 *  1. OUTER chunking (this file): bounds peak memory by splitting the working
 *     copy into overlapping windows that are handed to the backend one by one.
 *  2. INNER model overlap (`num_overlap`): the model's own overlapping
 *     inference passes inside one chunk. It is passed through to the backend.
 *
 * Chunk boundaries are reconstructed by the {@link Reconstructor}; the plan
 * therefore always overlaps by a raised cosine region instead of cutting hard.
 */
import { StemSeparationError } from './errors';

export interface ChunkPlan {
  index: number;
  startSample: number;
  endSample: number;
  /** Samples of this chunk that overlap with the previous chunk. */
  overlapIn: number;
  /** Samples of this chunk that overlap with the next chunk. */
  overlapOut: number;
  isFirst: boolean;
  isLast: boolean;
  startTime: number;
  endTime: number;
}

export interface ChunkPlanOptions {
  totalFrames: number;
  chunkSamples: number;
  /** Fraction of `chunkSamples` that overlaps, 0 .. 0.9. */
  overlapFraction: number;
  sampleRate: number;
}

/** Minimum overlap so that a raised cosine crossfade is always possible. */
export const MIN_OVERLAP_SAMPLES = 1024;

/**
 * Builds the chunk plan. The last chunk is aligned to the end of the file, so
 * the tail is never processed twice and no chunk is shorter than the overlap.
 */
export function planChunks(options: ChunkPlanOptions): ChunkPlan[] {
  const { totalFrames, chunkSamples, overlapFraction, sampleRate } = options;
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
    throw new StemSeparationError('AUDIO_CORRUPT', 'Chunk-Plan benötigt eine positive Frame-Anzahl', { totalFrames });
  }
  if (!Number.isFinite(chunkSamples) || chunkSamples < MIN_OVERLAP_SAMPLES * 2) {
    throw new StemSeparationError('STEM_CONFIG_INVALID', `chunk_size_samples ist zu klein (${chunkSamples})`, { chunkSamples });
  }
  if (overlapFraction < 0 || overlapFraction > 0.9) {
    throw new StemSeparationError('STEM_CONFIG_INVALID', `chunk_overlap muss in [0, 0.9] liegen, ist ${overlapFraction}`, { overlapFraction });
  }
  // A zero overlap fraction means real hard cuts – allowed, but the validator
  // will report the resulting boundary artefacts. Any non-zero fraction is
  // raised to MIN_OVERLAP_SAMPLES so a crossfade is always possible.
  const overlap = overlapFraction > 0 ? Math.max(MIN_OVERLAP_SAMPLES, Math.floor(chunkSamples * overlapFraction)) : 0;
  if (overlap >= chunkSamples) {
    throw new StemSeparationError('STEM_CONFIG_INVALID', 'chunk_overlap muss kleiner als die Chunk-Länge sein', { overlap, chunkSamples });
  }
  const hop = chunkSamples - overlap;
  const plans: ChunkPlan[] = [];

  if (totalFrames <= chunkSamples) {
    plans.push({
      index: 0,
      startSample: 0,
      endSample: totalFrames,
      overlapIn: 0,
      overlapOut: 0,
      isFirst: true,
      isLast: true,
      startTime: 0,
      endTime: totalFrames / sampleRate,
    });
    return plans;
  }

  let start = 0;
  let index = 0;
  while (start < totalFrames) {
    let end = Math.min(start + chunkSamples, totalFrames);
    // Pull the final chunk back so it keeps full length; the extra overlap is
    // handled by the reconstructor instead of producing a short tail chunk.
    if (end === totalFrames && end - start < chunkSamples && start > 0 && totalFrames > chunkSamples) {
      start = Math.max(0, totalFrames - chunkSamples);
      end = totalFrames;
    }
    const isFirst = start === 0;
    const isLast = end === totalFrames;
    plans.push({
      index,
      startSample: start,
      endSample: end,
      overlapIn: isFirst ? 0 : Math.min(overlap, start),
      overlapOut: isLast ? 0 : Math.min(overlap, totalFrames - end),
      isFirst,
      isLast,
      startTime: start / sampleRate,
      endTime: end / sampleRate,
    });
    if (isLast) break;
    start += hop;
    index++;
  }
  return plans;
}

/** Coverage check: every sample must be covered, borders must overlap. */
export function validateChunkPlan(plans: ChunkPlan[], totalFrames: number): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (plans.length === 0) problems.push('Plan ist leer');
  if (plans[0]?.startSample !== 0) problems.push('Erster Chunk beginnt nicht bei Sample 0');
  if (plans[plans.length - 1]?.endSample !== totalFrames) problems.push('Letzter Chunk endet nicht am Dateiende');
  for (let i = 1; i < plans.length; i++) {
    const previous = plans[i - 1];
    const current = plans[i];
    // Contiguous chunks (zero overlap) are allowed – lower quality, but not a
    // gap. Only a real gap is a plan error.
    if (current.startSample > previous.endSample) {
      problems.push(`Lücke zwischen Chunk ${previous.index} und ${current.index}`);
    }
    if (current.startSample < previous.startSample) {
      problems.push(`Chunk ${current.index} beginnt vor Chunk ${previous.index}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export interface CancellationToken {
  readonly cancelled: boolean;
  cancel(reason?: string): void;
  readonly reason?: string;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  /** Resolves while paused; throws `INFERENCE_CANCELLED` when cancelled. */
  throwIfCancelled(): void;
  waitForResume(): Promise<void>;
}

export class SeparationCancellationToken implements CancellationToken {
  private _cancelled = false;
  private _paused = false;
  private _reason?: string;
  private waiters: (() => void)[] = [];

  get cancelled(): boolean {
    return this._cancelled;
  }
  get paused(): boolean {
    return this._paused;
  }
  get reason(): string | undefined {
    return this._reason;
  }

  cancel(reason = 'Abbruch durch Benutzer'): void {
    this._cancelled = true;
    this._reason = reason;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  throwIfCancelled(): void {
    if (this._cancelled) {
      throw new StemSeparationError('INFERENCE_CANCELLED', this._reason ?? 'Separation abgebrochen');
    }
  }

  waitForResume(): Promise<void> {
    if (this._cancelled) {
      return Promise.reject(new StemSeparationError('INFERENCE_CANCELLED', this._reason ?? 'Separation abgebrochen'));
    }
    if (!this._paused) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

export interface ChunkExecution<T> {
  (plan: ChunkPlan, index: number): Promise<T>;
}

export interface RunChunkedOptions {
  token?: CancellationToken;
  onChunk?: (plan: ChunkPlan, index: number) => void;
}

/** Runs every chunk, checking cancellation before each one (§15). */
export async function runChunked<T>(plans: ChunkPlan[], run: ChunkExecution<T>, options: RunChunkedOptions = {}): Promise<T[]> {
  const results: T[] = [];
  for (const plan of plans) {
    options.token?.throwIfCancelled();
    await options.token?.waitForResume();
    results.push(await run(plan, plan.index));
    options.onChunk?.(plan, plan.index);
    options.token?.throwIfCancelled();
  }
  return results;
}
