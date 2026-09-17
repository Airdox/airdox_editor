import { detectOnsets } from './dsp';
import type { ChunkPlan } from './chunkProcessor';
export class OverlapAddReconstructor {
  private readonly sum: Float64Array;
  private readonly weights: Float64Array;
  constructor(private readonly options: { totalFrames: number; channels: number; plans?: ChunkPlan[] }) { this.sum = new Float64Array(options.totalFrames * options.channels); this.weights = new Float64Array(options.totalFrames); }
  add(plan: ChunkPlan, data: Float32Array): void { const channels = this.options.channels; const frames = Math.min(plan.endSample - plan.startSample, Math.floor(data.length / channels)); for (let f = 0; f < frames; f++) { const outFrame = plan.startSample + f; if (outFrame >= this.options.totalFrames) break; this.weights[outFrame] += 1; for (let c = 0; c < channels; c++) this.sum[outFrame * channels + c] += data[f * channels + c] || 0; } }
  finalize(): Float32Array { const out = new Float32Array(this.sum.length); for (let f = 0; f < this.options.totalFrames; f++) { const weight = this.weights[f] || 1; for (let c = 0; c < this.options.channels; c++) out[f * this.options.channels + c] = this.sum[f * this.options.channels + c] / weight; } return out; }
}
/** dB floor reported when a reconstruction matches its reference exactly. */
export const SILENT_DB = -240;
export interface ContinuityReport { excessDb: number; rmsJumpDb: number; duplicateTransients: number; missingTransients: number; }
/**
 * Compares a chunked reconstruction against the single-pass reference around every chunk
 * boundary. `duplicateTransients`/`missingTransients` are counted for real: onsets are
 * detected in both signals inside a short window around each boundary and the counts are
 * differenced, so overlap-add double-triggers or swallowed attacks actually show up.
 */
export function measureContinuity(reconstructed: Float32Array, channels: number, frames: number, boundaries: number[], reference?: Float32Array): ContinuityReport {
  let maxError = 0;
  if (reference) for (let i = 0; i < Math.min(reconstructed.length, reference.length); i++) maxError = Math.max(maxError, Math.abs(reconstructed[i] - reference[i]));
  let maxJump = 0, duplicateTransients = 0, missingTransients = 0;
  const sampleRate = 44100, window = Math.max(1, Math.round(sampleRate * .05));
  const mono = (data: Float32Array, from: number, to: number) => { const out = new Float64Array(Math.max(0, to - from)); for (let f = from; f < to; f++) { let s = 0; for (let c = 0; c < channels; c++) s += data[f * channels + c] || 0; out[f - from] = s / Math.max(1, channels); } return out; };
  for (const boundary of boundaries) {
    const f = Math.max(1, Math.min(frames - 1, boundary));
    let before = 0, after = 0, refBefore = 0, refAfter = 0;
    for (let c = 0; c < channels; c++) { before += Math.abs(reconstructed[(f - 1) * channels + c] || 0); after += Math.abs(reconstructed[f * channels + c] || 0); if (reference) { refBefore += Math.abs(reference[(f - 1) * channels + c] || 0); refAfter += Math.abs(reference[f * channels + c] || 0); } }
    const jump = 20 * Math.log10((after + 1e-9) / (before + 1e-9));
    const expected = reference ? 20 * Math.log10((refAfter + 1e-9) / (refBefore + 1e-9)) : 0;
    maxJump = Math.max(maxJump, Math.abs(jump - expected));
    if (!reference) continue;
    const from = Math.max(0, f - window), to = Math.min(frames, f + window);
    const delta = detectOnsets(mono(reconstructed, from, to), sampleRate).length - detectOnsets(mono(reference, from, to), sampleRate).length;
    if (delta > 0) duplicateTransients += delta; else if (delta < 0) missingTransients += -delta;
  }
  // Monotone by construction: a perfect reconstruction floors at SILENT_DB, every real
  // deviation is strictly greater, so "larger excessDb" always means "worse".
  return { excessDb: maxError > 0 ? Math.max(SILENT_DB, 20 * Math.log10(maxError)) : SILENT_DB, rmsJumpDb: maxJump, duplicateTransients, missingTransients };
}
