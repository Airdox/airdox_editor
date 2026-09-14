/**
 * StemIsolationGate – the QUALITY gate of part 2.
 *
 * While the Technical Gate (qualityGate.ts, part 1) proves that the pipeline
 * works, this gate proves that a separation is actually GOOD: ground truth
 * stems are compared against the model's estimates with SI-SDR, and every
 * stem must beat both an absolute floor and the mixture baseline (isolation
 * gain). A gate run is only meaningful with trained weights (`checkpoint`);
 * with `random` weights the gate exists to FAIL – that is its discrimination
 * proof, not a defect.
 *
 * SI-SDR (scale-invariant signal-to-distortion ratio) is computed on the
 * mono downmix after removing the mean, per ITU convention:
 *
 *   s_target = <est, ref> / ||ref||² · ref
 *   SI-SDR   = 10 · log10( ||s_target||² / ||est − s_target||² )
 *
 * Everything is deterministic and dependency free so the gate can run in CI.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { StemId } from './types';

/** Downsampling to mono is part of the metric definition (see file header). */
export function toMono(interleaved: Float32Array, channels = 2): Float32Array {
  const frames = interleaved.length / channels;
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) sum += interleaved[frame * channels + channel];
    mono[frame] = sum / channels;
  }
  return mono;
}

/**
 * SI-SDR in dB between estimate and reference (same length expected; longer
 * inputs are truncated to the common length). Returns ±Infinity for degenerate
 * inputs (silent reference / perfect reconstruction) instead of NaN so the
 * gate can reason about the verdict.
 */
export function siSdrDb(estimate: Float32Array, reference: Float32Array): number {
  const length = Math.min(estimate.length, reference.length);
  if (length === 0) return Number.NEGATIVE_INFINITY;

  let estimateMean = 0;
  let referenceMean = 0;
  for (let i = 0; i < length; i++) {
    estimateMean += estimate[i];
    referenceMean += reference[i];
  }
  estimateMean /= length;
  referenceMean /= length;

  let projection = 0;
  let referenceEnergy = 0;
  for (let i = 0; i < length; i++) {
    const e = estimate[i] - estimateMean;
    const r = reference[i] - referenceMean;
    projection += e * r;
    referenceEnergy += r * r;
  }
  if (referenceEnergy < 1e-12) return Number.NEGATIVE_INFINITY;

  const scale = projection / referenceEnergy;
  let targetEnergy = 0;
  let distortionEnergy = 0;
  for (let i = 0; i < length; i++) {
    const e = estimate[i] - estimateMean;
    const r = reference[i] - referenceMean;
    const target = scale * r;
    const distortion = e - target;
    targetEnergy += target * target;
    distortionEnergy += distortion * distortion;
  }
  if (distortionEnergy < 1e-12) return Number.POSITIVE_INFINITY;
  return 10 * Math.log10(targetEnergy / distortionEnergy);
}

export interface StemIsolationThresholds {
  /** Absolute floor every stem's SI-SDR must reach (dB). */
  minSiSdrDb: number;
  /** Required gain of SI-SDR over "use the mixture as the estimate" (dB). */
  minIsolationGainDb: number;
  /**
   * Alternative route for overlap-dominated stems: a stem whose source plays
   * simultaneously with others at comparable level can be physically capped
   * in absolute SI-SDR, no matter how good the separator is. Beating the
   * mixture baseline by THIS much still proves real isolation.
   */
  strongIsolationGainDb: number;
}

/**
 * Defaults follow the Teil-2 spec: a stem that cannot beat the raw mixture by
 * at least 6 dB is not "isolated", and below 6 dB absolute SI-SDR the output
 * is dominated by other stems' content. Overlap-dominated stems can instead
 * qualify by beating the baseline by 10 dB or more (see threshold docs).
 */
export const DEFAULT_THRESHOLDS: StemIsolationThresholds = {
  minSiSdrDb: 6,
  minIsolationGainDb: 6,
  strongIsolationGainDb: 10,
};

export interface StemIsolationEntry {
  stem: StemId;
  siSdrDb: number;
  mixtureBaselineDb: number;
  isolationGainDb: number;
  pass: boolean;
  detail: string;
}

export interface StemIsolationReport {
  gate: 'STEM_ISOLATION';
  part: 2;
  pass: boolean;
  generatedAt: number;
  durationMs: number;
  modelId: string;
  /** Only a trained checkpoint can PASS; random runs exist to FAIL. */
  weights: 'checkpoint' | 'random';
  trackSeconds: number;
  thresholds: StemIsolationThresholds;
  stems: StemIsolationEntry[];
  summary: { total: number; passed: number; failed: number };
  notes: string[];
}

export interface IsolationGateInput {
  estimates: Map<StemId, Float32Array>;
  groundTruth: Map<StemId, Float32Array>;
  /** The mixture the estimates were derived from (baseline reference). */
  mixture: Float32Array;
  channels?: number;
  modelId: string;
  weights: 'checkpoint' | 'random';
  trackSeconds: number;
  thresholds?: StemIsolationThresholds;
  notes?: string[];
  generatedAt?: number;
  durationMs?: number;
}

export function evaluateStemIsolation(input: IsolationGateInput): StemIsolationReport {
  const started = Date.now();
  const channels = input.channels ?? 2;
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const mixtureMono = toMono(input.mixture, channels);
  const entries: StemIsolationEntry[] = [];
  const notes = [...(input.notes ?? [])];

  for (const [stem, estimate] of input.estimates) {
    const truth = input.groundTruth.get(stem);
    if (!truth) {
      entries.push({
        stem,
        siSdrDb: Number.NEGATIVE_INFINITY,
        mixtureBaselineDb: Number.NEGATIVE_INFINITY,
        isolationGainDb: Number.NEGATIVE_INFINITY,
        pass: false,
        detail: 'keine Ground Truth vorhanden – Gate kann nicht bewerten',
      });
      continue;
    }
    const siSdr = siSdrDb(toMono(estimate, channels), toMono(truth, channels));
    const baseline = siSdrDb(mixtureMono, toMono(truth, channels));
    const gain = siSdr - baseline;
    // Standard route: absolute floor AND meaningful gain over the mixture.
    // Alternative route for overlap-dominated sources: beating the baseline by
    // a large margin proves isolation even when absolute SI-SDR stays low.
    const pass =
      input.weights === 'checkpoint' &&
      gain >= thresholds.minIsolationGainDb &&
      (siSdr >= thresholds.minSiSdrDb || gain >= thresholds.strongIsolationGainDb);
    entries.push({
      stem,
      siSdrDb: siSdr,
      mixtureBaselineDb: baseline,
      isolationGainDb: gain,
      pass,
      detail:
        `SI-SDR ${formatDb(siSdr)} (Floor ${thresholds.minSiSdrDb} dB), ` +
        `Baseline ${formatDb(baseline)}, Isolationsgewinn ${formatDb(gain)} ` +
        `(Mind. ${thresholds.minIsolationGainDb} dB, alternativ stark ≥ ${thresholds.strongIsolationGainDb} dB)`,
    });
  }

  // Stems with ground truth but WITHOUT an estimate fail loudly – a model that
  // silently drops a stem must not pass.
  for (const stem of input.groundTruth.keys()) {
    if (!input.estimates.has(stem)) {
      entries.push({
        stem,
        siSdrDb: Number.NEGATIVE_INFINITY,
        mixtureBaselineDb: Number.NEGATIVE_INFINITY,
        isolationGainDb: Number.NEGATIVE_INFINITY,
        pass: false,
        detail: 'Stem fehlt in den Estimates – Modell hat ihn nicht geliefert',
      });
    }
  }

  const passed = entries.filter((entry) => entry.pass).length;
  const report: StemIsolationReport = {
    gate: 'STEM_ISOLATION',
    part: 2,
    pass: input.weights === 'checkpoint' && passed === entries.length && entries.length > 0,
    generatedAt: input.generatedAt ?? Date.now(),
    durationMs: input.durationMs ?? Math.max(1, Date.now() - started),
    modelId: input.modelId,
    weights: input.weights,
    trackSeconds: input.trackSeconds,
    thresholds,
    stems: entries,
    summary: { total: entries.length, passed, failed: entries.length - passed },
    notes,
  };
  return report;
}

export async function writeIsolationReport(report: StemIsolationReport, directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${name}.json`);
  await writeFile(target, JSON.stringify(report, null, 2), 'utf8');
  return target;
}

function formatDb(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? '+Inf dB' : '-Inf dB';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} dB`;
}
