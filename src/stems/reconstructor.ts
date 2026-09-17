import type { ChunkPlan } from './chunkProcessor';
import { StemSeparationError } from './errors';

export class OverlapAddReconstructor {
  private readonly sum: Float64Array;
  private readonly weights: Float64Array;
  private readonly totalFrames: number;
  private readonly channels: number;

  constructor(private readonly options: { totalFrames: number; channels: number; plans?: ChunkPlan[] }) {
    this.totalFrames = Math.max(0, Math.floor(options.totalFrames));
    this.channels = Math.max(1, Math.floor(options.channels));
    this.sum = new Float64Array(this.totalFrames * this.channels);
    this.weights = new Float64Array(this.totalFrames);
  }

  add(plan: ChunkPlan, data: Float32Array): void {
    const channels = this.channels;
    const chunkFrames = Math.min(plan.endSample - plan.startSample, Math.floor(data.length / channels));
    if (chunkFrames <= 0) return;

    // Build raised cosine window for this chunk
    const window = new Float64Array(chunkFrames);
    for (let i = 0; i < chunkFrames; i++) {
      let w = 1;
      if (plan.overlapBefore > 0 && i < plan.overlapBefore) {
        // Raised cosine fade in
        w = 0.5 - 0.5 * Math.cos((Math.PI * i) / plan.overlapBefore);
      } else if (plan.overlapAfter > 0 && i >= chunkFrames - plan.overlapAfter) {
        const j = i - (chunkFrames - plan.overlapAfter);
        w = 0.5 + 0.5 * Math.cos((Math.PI * j) / plan.overlapAfter);
      }
      window[i] = w;
    }

    for (let f = 0; f < chunkFrames; f++) {
      const outFrame = plan.startSample + f;
      if (outFrame < 0 || outFrame >= this.totalFrames) continue;
      const weight = window[f];
      this.weights[outFrame] += weight;
      for (let c = 0; c < channels; c++) {
        const sample = data[f * channels + c] || 0;
        this.sum[outFrame * channels + c] += sample * weight;
      }
    }
  }

  finalize(): Float32Array {
    const out = new Float32Array(this.sum.length);
    for (let f = 0; f < this.totalFrames; f++) {
      const weight = this.weights[f];
      const divisor = weight > 1e-9 ? weight : 1;
      for (let c = 0; c < this.channels; c++) {
        out[f * this.channels + c] = this.sum[f * this.channels + c] / divisor;
      }
    }
    return out;
  }

  getWeights(): Float64Array {
    return this.weights;
  }
}

export interface ContinuityReport {
  excessDb: number;
  rmsJumpDb: number;
  duplicateTransients: number;
  missingTransients: number;
  maxBoundaryClick: number;
  levelDeltaDb: number;
  stereoDelta: number;
}

export function measureContinuity(reconstructed: Float32Array, channels: number, plans: ChunkPlan[]): ContinuityReport {
  const frames = Math.floor(reconstructed.length / channels);
  let maxClick = 0;
  let maxJumpDb = -Infinity;
  let totalExcess = -Infinity;

  for (let i = 1; i < plans.length; i++) {
    const prev = plans[i - 1];
    const curr = plans[i];
    const boundary = curr.startSample;
    if (boundary <= 0 || boundary >= frames) continue;

    // Check for discontinuity at boundary
    for (let c = 0; c < channels; c++) {
      const before = reconstructed[(boundary - 1) * channels + c] || 0;
      const after = reconstructed[boundary * channels + c] || 0;
      const click = Math.abs(after - before);
      maxClick = Math.max(maxClick, click);
    }

    // RMS jump
    const window = Math.min(1024, prev.endSample - prev.startSample, curr.endSample - curr.startSample);
    if (window > 10) {
      let rmsBefore = 0;
      let rmsAfter = 0;
      for (let f = 0; f < window; f++) {
        for (let c = 0; c < channels; c++) {
          const b = reconstructed[(boundary - 1 - f) * channels + c] || 0;
          const a = reconstructed[(boundary + f) * channels + c] || 0;
          rmsBefore += b * b;
          rmsAfter += a * a;
        }
      }
      rmsBefore = Math.sqrt(rmsBefore / (window * channels));
      rmsAfter = Math.sqrt(rmsAfter / (window * channels));
      const jumpDb = 20 * Math.log10((Math.max(rmsBefore, rmsAfter) + 1e-9) / (Math.min(rmsBefore, rmsAfter) + 1e-9));
      if (Number.isFinite(jumpDb)) {
        maxJumpDb = Math.max(maxJumpDb, jumpDb);
        totalExcess = Math.max(totalExcess, jumpDb);
      }
    }
  }

  return {
    excessDb: Number.isFinite(totalExcess) ? totalExcess : 0,
    rmsJumpDb: Number.isFinite(maxJumpDb) ? maxJumpDb : 0,
    duplicateTransients: 0,
    missingTransients: 0,
    maxBoundaryClick: maxClick,
    levelDeltaDb: maxJumpDb,
    stereoDelta: 0,
  };
}

export function detectBoundaryErrors(reconstructed: Float32Array, channels: number, plans: ChunkPlan[], thresholdDb = 3): { hasError: boolean; report: ContinuityReport } {
  const report = measureContinuity(reconstructed, channels, plans);
  const hasClick = report.maxBoundaryClick > 0.1; // 10% full scale click
  const hasLevelJump = report.rmsJumpDb > thresholdDb;
  return {
    hasError: hasClick || hasLevelJump,
    report,
  };
}

export function validateOverlapAddIdentity(totalFrames: number, channels: number, plans: ChunkPlan[]): { error: number; maxWeightDeviation: number } {
  // Test that overlap-add with unity input reconstructs unity
  const recon = new OverlapAddReconstructor({ totalFrames, channels, plans });
  for (const plan of plans) {
    const chunkFrames = plan.endSample - plan.startSample;
    const data = new Float32Array(chunkFrames * channels);
    data.fill(1);
    recon.add(plan, data);
  }
  const result = recon.finalize();
  let maxError = 0;
  let maxWeightDev = 0;
  const weights = recon.getWeights();
  for (let f = 0; f < totalFrames; f++) {
    const w = weights[f];
    maxWeightDev = Math.max(maxWeightDev, Math.abs(w - 1));
    for (let c = 0; c < channels; c++) {
      const v = result[f * channels + c];
      maxError = Math.max(maxError, Math.abs(v - 1));
    }
  }
  return { error: maxError, maxWeightDeviation: maxWeightDev };
}
