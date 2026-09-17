/**
 * Metrics – objective separation quality measurements for the Stem Isolation
 * Gate (part 2, §12–§15).
 *
 * Every function here compares an ESTIMATE (a separated stem, or a
 * recombined mix) against a REFERENCE (the ground truth stem, or the
 * original mix) that only exists because the gold standard test track
 * (`testAudioGenerator.ts`) was built from known, isolated sources.
 *
 * This module never judges "musical usefulness" by itself – §24/§25 are
 * explicit that a single number (SDR or otherwise) must not be the sole
 * criterion. `qualityScore()` combines several of these metrics into the
 * 1..10 scale, but the final subjective judgement (§30, Perceptual Gate)
 * still requires a human listening to the exported comparison clips.
 */
import { analyzeAudio, toPlanar } from './wavIo';
import { downmixMono, logSpectralDistanceDb, detectOnsets, findBestLag, rms, peakAbs, toDb, type Onset } from './dsp';

export interface StereoSignal {
  data: Float32Array;
  channels: number;
  frames: number;
  sampleRate: number;
}

function alignedLength(a: StereoSignal, b: StereoSignal): number {
  return Math.min(a.frames, b.frames);
}

/** Upper reporting bound in dB: a finite ceiling keeps "identical" from becoming Infinity in reports/JSON. */
export const MAX_SDR_DB = 180;
/** A pure separation never claims a perfect 10 (§24). */
export const MAX_QUALITY_SCORE = 9.5;
/** Energy below which a buffer counts as silence; anything quieter cannot be scored meaningfully. */
const SILENCE_ENERGY = 1e-18;

function energyOf(data: Float64Array, n: number): number {
  let e = 0;
  for (let i = 0; i < n; i++) e += data[i] * data[i];
  return e;
}

/**
 * Classic (BSS-Eval style) SDR: 10*log10(||reference||^2 / ||reference - estimate||^2).
 *
 * Deliberately NOT scale invariant: a stem at the wrong level must be
 * penalised, because that is exactly what the recombination and level checks
 * are there to catch. Use `siSdr()` when a pure gain offset should be ignored.
 *
 * A silent estimate yields -MAX_SDR_DB, never a perfect score — a backend that
 * outputs nothing must not be able to pass the gate.
 */
export function sdr(reference: Float64Array, estimate: Float64Array): number {
  const n = Math.min(reference.length, estimate.length);
  if (n === 0) return Number.NaN;
  const refEnergy = energyOf(reference, n);
  if (refEnergy < SILENCE_ENERGY) return Number.NaN;
  if (energyOf(estimate, n) < SILENCE_ENERGY) return -MAX_SDR_DB;
  let error = 0;
  for (let i = 0; i < n; i++) error += (estimate[i] - reference[i]) ** 2;
  if (error < SILENCE_ENERGY) return MAX_SDR_DB;
  return Math.max(-MAX_SDR_DB, Math.min(MAX_SDR_DB, 10 * Math.log10(refEnergy / error)));
}

/**
 * Scale-invariant SDR (SI-SDR, Le Roux et al. 2019). Unlike `sdr()` it
 * projects the estimate onto the reference *without* the classic BSS-Eval
 * energy normalisation quirks — the metric of choice in modern source
 * separation papers.
 */
export function siSdr(reference: Float64Array, estimate: Float64Array): number {
  const n = Math.min(reference.length, estimate.length);
  if (n === 0) return Number.NaN;
  let dot = 0;
  let refEnergy = 0;
  for (let i = 0; i < n; i++) {
    dot += reference[i] * estimate[i];
    refEnergy += reference[i] * reference[i];
  }
  if (refEnergy < SILENCE_ENERGY) return Number.NaN;
  if (energyOf(estimate, n) < SILENCE_ENERGY) return -MAX_SDR_DB;
  const alpha = dot / refEnergy;
  let targetEnergy = 0;
  let errorEnergy = 0;
  for (let i = 0; i < n; i++) {
    const target = alpha * reference[i];
    const error = estimate[i] - target;
    targetEnergy += target * target;
    errorEnergy += error * error;
  }
  if (errorEnergy < SILENCE_ENERGY) return MAX_SDR_DB;
  return Math.max(-MAX_SDR_DB, Math.min(MAX_SDR_DB, 10 * Math.log10(targetEnergy / errorEnergy)));
}

/**
 * Interference ratio (SIR-like): how much energy of OTHER sources leaked
 * into this stem's estimate, in dB relative to the target energy. Computed
 * by projecting the residual (estimate - scaled target) onto each
 * interferer and summing the explained energy (Vincent et al. decomposition,
 * simplified to a closed form good enough for a synthetic, fully known
 * ground truth).
 */
export function interferenceDb(target: Float64Array, estimate: Float64Array, interferers: Float64Array[]): number {
  const n = Math.min(target.length, estimate.length);
  if (n === 0 || interferers.length === 0) return Number.POSITIVE_INFINITY;
  // Least squares projection of `estimate` onto the space spanned by
  // [target, interferer_1, interferer_2, ...] using a simple Gram-Schmidt so
  // we do not need a general purpose linear algebra dependency.
  const basis: Float64Array[] = [target, ...interferers].map((v) => v.slice(0, n));
  const ortho: Float64Array[] = [];
  for (const vector of basis) {
    const v = Float64Array.from(vector);
    for (const u of ortho) {
      let dot = 0;
      let norm = 0;
      for (let i = 0; i < n; i++) {
        dot += v[i] * u[i];
        norm += u[i] * u[i];
      }
      const coeff = norm > 1e-18 ? dot / norm : 0;
      for (let i = 0; i < n; i++) v[i] -= coeff * u[i];
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += v[i] * v[i];
    if (norm > 1e-18) ortho.push(v);
  }
  const projections: number[] = ortho.map((u) => {
    let dot = 0;
    let norm = 0;
    for (let i = 0; i < n; i++) {
      dot += estimate[i] * u[i];
      norm += u[i] * u[i];
    }
    return norm > 1e-18 ? dot / Math.sqrt(norm) : 0;
  });
  // Target's own contribution is the projection onto the first orthogonal
  // basis vector (which spans the same 1-D line as `target` since it is the
  // first vector fed into Gram-Schmidt).
  let targetContribution = 0;
  {
    let dot = 0;
    let norm = 0;
    for (let i = 0; i < n; i++) {
      dot += target[i] * ortho[0][i];
      norm += ortho[0][i] * ortho[0][i];
    }
    const scale = norm > 1e-18 ? dot / Math.sqrt(norm) : 0;
    targetContribution = (scale * projections[0]) ** 2;
  }
  let interferenceEnergy = 0;
  for (let k = 1; k < projections.length; k++) interferenceEnergy += projections[k] ** 2;
  if (targetContribution < 1e-18) return Number.NEGATIVE_INFINITY;
  return toDb(Math.sqrt(interferenceEnergy) || 1e-12, Math.sqrt(targetContribution) || 1e-12);
}

/** Simplified bleed measurement: correlation-weighted energy of each interferer inside the estimate residual. */
export interface BleedEntry {
  sourceId: string;
  /** Energy of this interferer explained in the estimate, relative to the target's own energy, in dB. Lower (more negative) is better. */
  bleedDb: number;
}

export function measureBleed(targetId: string, targetRef: Float64Array, estimate: Float64Array, others: { id: string; data: Float64Array }[]): BleedEntry[] {
  const n = Math.min(targetRef.length, estimate.length);
  let targetEnergy = 0;
  for (let i = 0; i < n; i++) targetEnergy += targetRef[i] * targetRef[i];
  const entries: BleedEntry[] = [];
  for (const other of others) {
    if (other.id === targetId) continue;
    const m = Math.min(n, other.data.length);
    let dot = 0;
    let otherEnergy = 0;
    for (let i = 0; i < m; i++) {
      dot += estimate[i] * other.data[i];
      otherEnergy += other.data[i] * other.data[i];
    }
    // Explained energy of the interferer inside the estimate (projection).
    const alpha = otherEnergy > 1e-18 ? dot / otherEnergy : 0;
    const explained = (alpha * alpha) * otherEnergy;
    const bleedDb = targetEnergy > 1e-18 ? toDb(Math.sqrt(explained) || 1e-12, Math.sqrt(targetEnergy) || 1e-12) : Number.NEGATIVE_INFINITY;
    entries.push({ sourceId: other.id, bleedDb });
  }
  return entries;
}

export interface StereoMetrics {
  correlation: number;
  sideToMidRatio: number;
  midEnergyDb: number;
  sideEnergyDb: number;
  channelBalanceDb: number;
}

export function stereoMetricsOf(data: Float32Array, channels: number, frames: number): StereoMetrics {
  const stats = analyzeAudio(data, channels, frames);
  const planar = toPlanar(data, channels, frames);
  let leftEnergy = 0;
  let rightEnergy = 0;
  if (channels === 2) {
    for (let f = 0; f < frames; f++) {
      leftEnergy += planar[0][f] ** 2;
      rightEnergy += planar[1][f] ** 2;
    }
  }
  return {
    correlation: stats.stereoCorrelation,
    sideToMidRatio: stats.sideToMidRatio,
    midEnergyDb: toDb(Math.sqrt((leftEnergy + rightEnergy) / 2) || 1e-12),
    sideEnergyDb: toDb(stats.sideToMidRatio * Math.sqrt((leftEnergy + rightEnergy) / 2) || 1e-12),
    channelBalanceDb: toDb(Math.sqrt(leftEnergy) || 1e-12, Math.sqrt(rightEnergy) || 1e-12),
  };
}

export interface StereoComparison extends StereoMetrics {
  correlationDelta: number;
  widthDeltaDb: number;
  becameMono: boolean;
}

export function compareStereo(reference: StereoSignal, estimate: StereoSignal): StereoComparison {
  const n = alignedLength(reference, estimate);
  const ref = stereoMetricsOf(reference.data, reference.channels, n);
  const est = stereoMetricsOf(estimate.data, estimate.channels, n);
  return {
    ...est,
    correlationDelta: est.correlation - ref.correlation,
    widthDeltaDb: est.sideEnergyDb - ref.sideEnergyDb,
    becameMono: ref.sideToMidRatio > 0.05 && est.sideToMidRatio < 0.01,
  };
}

export interface TransientComparison {
  referenceCount: number;
  matchedCount: number;
  missingCount: number;
  extraCount: number;
  /** Mean |onset time error| in ms for matched transients. */
  meanTimingErrorMs: number;
  /** Mean attack-energy ratio (estimate/reference) for matched transients, in dB. Ideal is 0. */
  meanAttackLevelErrorDb: number;
  preserved: boolean;
}

/**
 * Matches onsets between a reference and an estimate signal and reports
 * missing/extra/mistimed transients (§14, kick/snare/clap/hat/pluck attack).
 */
export function compareTransients(
  reference: Float64Array,
  estimate: Float64Array,
  sampleRate: number,
  toleranceMs = 25
): TransientComparison {
  const refOnsets = detectOnsets(reference, sampleRate);
  const estOnsets = detectOnsets(estimate, sampleRate);
  const tolerance = Math.round((toleranceMs / 1000) * sampleRate);
  const used = new Array<boolean>(estOnsets.length).fill(false);
  let matched = 0;
  let timingErrorSum = 0;
  let levelErrorSum = 0;
  const attackWindow = Math.round(0.008 * sampleRate);
  const attackEnergy = (signal: Float64Array, frame: number): number => {
    let sum = 0;
    for (let i = frame; i < Math.min(signal.length, frame + attackWindow); i++) sum += signal[i] * signal[i];
    return Math.sqrt(sum / attackWindow);
  };
  for (const ref of refOnsets) {
    let bestIndex = -1;
    let bestDistance = tolerance + 1;
    for (let i = 0; i < estOnsets.length; i++) {
      if (used[i]) continue;
      const distance = Math.abs(estOnsets[i].frame - ref.frame);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      used[bestIndex] = true;
      matched++;
      timingErrorSum += (bestDistance / sampleRate) * 1000;
      const refLevel = attackEnergy(reference, ref.frame);
      const estLevel = attackEnergy(estimate, estOnsets[bestIndex].frame);
      levelErrorSum += toDb(estLevel || 1e-9, refLevel || 1e-9);
    }
  }
  const missing = refOnsets.length - matched;
  const extra = estOnsets.length - matched;
  return {
    referenceCount: refOnsets.length,
    matchedCount: matched,
    missingCount: missing,
    extraCount: extra,
    meanTimingErrorMs: matched > 0 ? timingErrorSum / matched : 0,
    meanAttackLevelErrorDb: matched > 0 ? levelErrorSum / matched : 0,
    preserved: refOnsets.length === 0 || (missing / Math.max(1, refOnsets.length) <= 0.1 && Math.abs((matched > 0 ? levelErrorSum / matched : 0)) <= 6),
  };
}

export interface LevelComparison {
  rmsReferenceDb: number;
  rmsEstimateDb: number;
  rmsDeviationDb: number;
  peakReferenceDb: number;
  peakEstimateDb: number;
  peakDeviationDb: number;
  loudnessDeviationDb: number;
}

/** Coarse loudness proxy: RMS of a 400 ms sliding window, averaged (no full ITU-R BS.1770 K-weighting). */
function windowedLoudnessDb(data: Float64Array, sampleRate: number): number {
  const windowSize = Math.max(1, Math.round(sampleRate * 0.4));
  let sumSq = 0;
  let windows = 0;
  for (let start = 0; start < data.length; start += windowSize) {
    let energy = 0;
    const end = Math.min(data.length, start + windowSize);
    for (let i = start; i < end; i++) energy += data[i] * data[i];
    const windowRms = Math.sqrt(energy / Math.max(1, end - start));
    sumSq += windowRms * windowRms;
    windows++;
  }
  return toDb(Math.sqrt(sumSq / Math.max(1, windows)) || 1e-12);
}

export function compareLevels(reference: Float64Array, estimate: Float64Array, sampleRate: number): LevelComparison {
  const rmsRefDb = toDb(rms(reference));
  const rmsEstDb = toDb(rms(estimate));
  const peakRefDb = toDb(peakAbs(reference));
  const peakEstDb = toDb(peakAbs(estimate));
  return {
    rmsReferenceDb: rmsRefDb,
    rmsEstimateDb: rmsEstDb,
    rmsDeviationDb: rmsEstDb - rmsRefDb,
    peakReferenceDb: peakRefDb,
    peakEstimateDb: peakEstDb,
    peakDeviationDb: peakEstDb - peakRefDb,
    loudnessDeviationDb: windowedLoudnessDb(estimate, sampleRate) - windowedLoudnessDb(reference, sampleRate),
  };
}

export interface SpectralComparison {
  logSpectralDistanceDb: number;
}

export function compareSpectrum(reference: Float64Array, estimate: Float64Array): SpectralComparison {
  return { logSpectralDistanceDb: logSpectralDistanceDb(reference, estimate) };
}

export interface PhaseComparison {
  /** Best alignment lag in samples found by cross-correlation (0 = perfectly aligned). */
  lagSamples: number;
  /** Cross-correlation coefficient at the best lag, in [-1, 1]. */
  correlation: number;
  timeShiftDetected: boolean;
}

export function comparePhase(reference: Float64Array, estimate: Float64Array, maxLagSamples = 512): PhaseComparison {
  const { lag, correlation } = findBestLag(reference, estimate, maxLagSamples);
  return { lagSamples: lag, correlation, timeShiftDetected: lag !== 0 && correlation > 0.3 };
}

export interface StemMetricsReport {
  stemId: string;
  sdrDb: number;
  siSdrDb: number;
  interferenceDb: number;
  spectral: SpectralComparison;
  levels: LevelComparison;
  stereo: StereoComparison;
  phase: PhaseComparison;
  transients: TransientComparison;
  bleed: BleedEntry[];
}

/** Full per-stem comparison: ground truth vs. separated output (§12–§15). */
export function evaluateStem(
  stemId: string,
  reference: StereoSignal,
  estimate: StereoSignal,
  otherStems: { id: string; signal: StereoSignal }[]
): StemMetricsReport {
  const n = alignedLength(reference, estimate);
  const refMono = downmixMono(reference.data, reference.channels, n);
  const estMono = downmixMono(estimate.data, estimate.channels, n);
  const otherMono = otherStems.map((other) => ({ id: other.id, data: downmixMono(other.signal.data, other.signal.channels, Math.min(n, other.signal.frames)) }));

  return {
    stemId,
    sdrDb: sdr(refMono, estMono),
    siSdrDb: siSdr(refMono, estMono),
    interferenceDb: interferenceDb(refMono, estMono, otherMono.map((o) => o.data)),
    spectral: compareSpectrum(refMono, estMono),
    levels: compareLevels(refMono, estMono, reference.sampleRate),
    stereo: compareStereo(reference, estimate),
    phase: comparePhase(refMono, estMono),
    transients: compareTransients(refMono, estMono, reference.sampleRate),
    bleed: measureBleed(stemId, refMono, estMono, otherMono),
  };
}

/**
 * Combines several objective metrics into the internal 1..10 scale (§24/§25).
 * This is a heuristic, documented mapping – NOT a claim that any single
 * formula captures perceived quality. It exists so automated CI runs have a
 * reproducible number to gate on; the Perceptual Gate (§30) is still
 * mandatory before a release decision.
 *
 * Weighting rationale:
 *  - SI-SDR dominates (source separation's primary objective metric) but is
 *    saturated at 20 dB (already "very good", higher does not mean "more
 *    correct" on real, noisy references).
 *  - Bleed, transient preservation and stereo width each subtract from the
 *    ceiling – a high SDR with destroyed transients or collapsed stereo must
 *    not score as "professional".
 */
export function qualityScore(report: StemMetricsReport): { score: number; breakdown: Record<string, number> } {
  const sdrScore = Math.max(0, Math.min(10, (report.siSdrDb / 20) * 10));
  const worstBleed = report.bleed.length > 0 ? Math.max(...report.bleed.map((b) => b.bleedDb)) : -60;
  const bleedPenalty = worstBleed > -6 ? 4 : worstBleed > -12 ? 2 : worstBleed > -18 ? 1 : 0;
  const transientPenalty = report.transients.preserved ? 0 : Math.min(3, (report.transients.missingCount / Math.max(1, report.transients.referenceCount)) * 6);
  const stereoPenalty = report.stereo.becameMono ? 3 : Math.min(1.5, Math.abs(report.stereo.widthDeltaDb) / 6);
  const spectralPenalty = Math.min(2, report.spectral.logSpectralDistanceDb / 10);
  const raw = sdrScore - bleedPenalty - transientPenalty - stereoPenalty - spectralPenalty;
  const score = Math.max(1, Math.min(MAX_QUALITY_SCORE, raw)); // §24: 10/10 is never claimed for pure separation.
  return {
    score,
    breakdown: {
      sdrScore,
      bleedPenalty,
      transientPenalty,
      stereoPenalty,
      spectralPenalty,
    },
  };
}

export function qualityLabel(score: number): string {
  if (score < 3) return 'unbrauchbar';
  if (score < 5) return 'grenzwertig';
  if (score < 7) return 'brauchbar mit deutlichen Fehlern';
  if (score < 8) return 'gut';
  if (score < 8.5) return 'sehr gut';
  if (score < 9) return 'professionell brauchbar (HIGH_QUALITY-Ziel)';
  return 'professionell brauchbar (MAXIMUM_QUALITY-Ziel)';
}
