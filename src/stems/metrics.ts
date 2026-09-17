import { analyzeAudio, toPlanar } from './wavIo';
import { detectOnsets, downmixMono, findBestLag, logSpectralDistanceDb, peakAbs, rms, toDb } from './dsp';
export interface StereoSignal { data: Float32Array; channels: number; frames: number; sampleRate: number; }
const nOf = (a: StereoSignal, b: StereoSignal) => Math.min(a.frames, b.frames);
/** Upper reporting bound in dB: a finite ceiling keeps "identical" from becoming Infinity in reports/JSON. */
export const MAX_SDR_DB = 180;
/** Energy below which a buffer counts as silence; anything quieter cannot be scored meaningfully. */
const SILENCE_ENERGY = 1e-18;
function energyOf(data: Float64Array, n: number): number { let e = 0; for (let i = 0; i < n; i++) e += data[i] * data[i]; return e; }
/**
 * Classic (BSS-Eval style) SDR: 10*log10(||reference||^2 / ||reference - estimate||^2).
 * NOT scale invariant — a stem at the wrong level is penalised, which is what the
 * recombination and level checks need. A silent or degenerate estimate yields -MAX_SDR_DB,
 * never a perfect score.
 */
export function sdr(reference: Float64Array, estimate: Float64Array): number {
  const n = Math.min(reference.length, estimate.length); if (!n) return Number.NaN;
  const refEnergy = energyOf(reference, n); if (refEnergy < SILENCE_ENERGY) return Number.NaN;
  if (energyOf(estimate, n) < SILENCE_ENERGY) return -MAX_SDR_DB;
  let error = 0; for (let i = 0; i < n; i++) error += (estimate[i] - reference[i]) ** 2;
  return error < SILENCE_ENERGY ? MAX_SDR_DB : Math.max(-MAX_SDR_DB, Math.min(MAX_SDR_DB, 10 * Math.log10(refEnergy / error)));
}
/**
 * Scale-invariant SDR (Le Roux et al. 2019): the estimate is first projected onto the
 * reference, so a pure gain offset does not count as an error. A silent estimate has no
 * projection at all and is reported as -MAX_SDR_DB instead of a spurious perfect score.
 */
export function siSdr(reference: Float64Array, estimate: Float64Array): number {
  const n = Math.min(reference.length, estimate.length); if (!n) return Number.NaN;
  const refEnergy = energyOf(reference, n); if (refEnergy < SILENCE_ENERGY) return Number.NaN;
  if (energyOf(estimate, n) < SILENCE_ENERGY) return -MAX_SDR_DB;
  let dot = 0; for (let i = 0; i < n; i++) dot += reference[i] * estimate[i];
  const alpha = dot / refEnergy;
  let target = 0, error = 0; for (let i = 0; i < n; i++) { const v = alpha * reference[i]; target += v * v; error += (estimate[i] - v) ** 2; }
  if (target < SILENCE_ENERGY) return -MAX_SDR_DB;
  return error < SILENCE_ENERGY ? MAX_SDR_DB : Math.max(-MAX_SDR_DB, Math.min(MAX_SDR_DB, 10 * Math.log10(target / error)));
}
/**
 * SIR-like interference ratio in dB: energy of foreign sources found in the estimate,
 * relative to the energy explained by the target itself. The interferers are
 * Gram-Schmidt orthogonalised against the target (and each other) first, so energy
 * shared between correlated sources is not counted several times over.
 */
export function interferenceDb(target: Float64Array, estimate: Float64Array, interferers: Float64Array[]): number {
  const n = Math.min(target.length, estimate.length); if (!n || !interferers.length) return Number.POSITIVE_INFINITY;
  const ortho: Float64Array[] = [];
  for (const source of [target, ...interferers]) {
    const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = source[i] || 0;
    for (const u of ortho) { let d = 0, e = 0; for (let i = 0; i < n; i++) { d += v[i] * u[i]; e += u[i] * u[i]; } const c = e > SILENCE_ENERGY ? d / e : 0; if (c) for (let i = 0; i < n; i++) v[i] -= c * u[i]; }
    let norm = 0; for (let i = 0; i < n; i++) norm += v[i] * v[i];
    ortho.push(norm > SILENCE_ENERGY ? v : new Float64Array(n));
  }
  const explained = (u: Float64Array) => { let d = 0, e = 0; for (let i = 0; i < n; i++) { d += estimate[i] * u[i]; e += u[i] * u[i]; } return e > SILENCE_ENERGY ? d * d / e : 0; };
  const targetEnergy = explained(ortho[0]); let otherEnergy = 0; for (let k = 1; k < ortho.length; k++) otherEnergy += explained(ortho[k]);
  if (targetEnergy < SILENCE_ENERGY) return otherEnergy < SILENCE_ENERGY ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return toDb(Math.sqrt(otherEnergy), Math.sqrt(targetEnergy));
}
export interface BleedEntry { sourceId: string; bleedDb: number; }
export function measureBleed(targetId: string, targetRef: Float64Array, estimate: Float64Array, others: { id: string; data: Float64Array }[]): BleedEntry[] { let targetEnergy = 0; for (const v of targetRef) targetEnergy += v * v; return others.filter((o) => o.id !== targetId).map((other) => { const n = Math.min(estimate.length, other.data.length); let dot = 0, e = 0; for (let i = 0; i < n; i++) { dot += estimate[i] * other.data[i]; e += other.data[i] ** 2; } const explained = e > 1e-18 ? dot * dot / e : 0; return { sourceId: other.id, bleedDb: targetEnergy > 1e-18 ? toDb(Math.sqrt(explained), Math.sqrt(targetEnergy)) : Number.NEGATIVE_INFINITY }; }); }
export interface StereoMetrics { correlation: number; sideToMidRatio: number; midEnergyDb: number; sideEnergyDb: number; channelBalanceDb: number; }
export function stereoMetricsOf(data: Float32Array, channels: number, frames: number): StereoMetrics { const stats = analyzeAudio(data, channels, frames); const planar = toPlanar(data, channels, frames); let left = 0, right = 0; for (let i = 0; i < frames; i++) { left += (planar[0]?.[i] || 0) ** 2; right += (planar[Math.min(1, channels - 1)]?.[i] || 0) ** 2; } const mid = Math.sqrt((left + right) / 2); return { correlation: stats.stereoCorrelation, sideToMidRatio: stats.sideToMidRatio, midEnergyDb: toDb(mid), sideEnergyDb: toDb(mid * stats.sideToMidRatio), channelBalanceDb: toDb(Math.sqrt(left), Math.sqrt(right)) }; }
export interface StereoComparison extends StereoMetrics { correlationDelta: number; widthDeltaDb: number; becameMono: boolean; }
export function compareStereo(reference: StereoSignal, estimate: StereoSignal): StereoComparison { const n = nOf(reference, estimate), r = stereoMetricsOf(reference.data, reference.channels, n), e = stereoMetricsOf(estimate.data, estimate.channels, n); return { ...e, correlationDelta: e.correlation - r.correlation, widthDeltaDb: e.sideEnergyDb - r.sideEnergyDb, becameMono: r.sideToMidRatio > .05 && e.sideToMidRatio < .01 }; }
export interface TransientComparison { referenceCount: number; matchedCount: number; missingCount: number; extraCount: number; meanTimingErrorMs: number; meanAttackLevelErrorDb: number; preserved: boolean; }
export function compareTransients(reference: Float64Array, estimate: Float64Array, sampleRate: number, toleranceMs = 25): TransientComparison { const ref = detectOnsets(reference, sampleRate), est = detectOnsets(estimate, sampleRate), tolerance = toleranceMs / 1000 * sampleRate, used = new Set<number>(); let matched = 0, time = 0, level = 0; const attack = Math.max(1, Math.round(sampleRate * .008)); const attackLevel = (data: Float64Array, at: number) => Math.sqrt(data.slice(at, Math.min(data.length, at + attack)).reduce((s, x) => s + x * x, 0) / attack); for (const onset of ref) { let best = -1, distance = tolerance + 1; for (let i = 0; i < est.length; i++) if (!used.has(i) && Math.abs(est[i].frame - onset.frame) < distance) { best = i; distance = Math.abs(est[i].frame - onset.frame); } if (best >= 0) { used.add(best); matched++; time += distance / sampleRate * 1000; level += toDb(attackLevel(estimate, est[best].frame) || 1e-9, attackLevel(reference, onset.frame) || 1e-9); } } const missing = ref.length - matched, extra = est.length - matched, levelError = matched ? level / matched : 0; return { referenceCount: ref.length, matchedCount: matched, missingCount: missing, extraCount: extra, meanTimingErrorMs: matched ? time / matched : 0, meanAttackLevelErrorDb: levelError, preserved: !ref.length || missing / ref.length <= .1 && Math.abs(levelError) <= 6 }; }
export interface LevelComparison { rmsReferenceDb: number; rmsEstimateDb: number; rmsDeviationDb: number; peakReferenceDb: number; peakEstimateDb: number; peakDeviationDb: number; loudnessDeviationDb: number; }
/** Coarse loudness proxy: mean energy of 400 ms windows (no ITU-R BS.1770 K-weighting). */
function windowedLoudnessDb(data: Float64Array, sampleRate: number): number {
  const size = Math.max(1, Math.round(sampleRate * .4)); let sum = 0, windows = 0;
  for (let start = 0; start < data.length; start += size) { const end = Math.min(data.length, start + size); let e = 0; for (let i = start; i < end; i++) e += data[i] * data[i]; sum += e / Math.max(1, end - start); windows++; }
  return toDb(Math.sqrt(sum / Math.max(1, windows)));
}
export function compareLevels(reference: Float64Array, estimate: Float64Array, sampleRate: number): LevelComparison { const rr = toDb(rms(reference)), re = toDb(rms(estimate)), pr = toDb(peakAbs(reference)), pe = toDb(peakAbs(estimate)); return { rmsReferenceDb: rr, rmsEstimateDb: re, rmsDeviationDb: re - rr, peakReferenceDb: pr, peakEstimateDb: pe, peakDeviationDb: pe - pr, loudnessDeviationDb: windowedLoudnessDb(estimate, sampleRate) - windowedLoudnessDb(reference, sampleRate) }; }
export interface SpectralComparison { logSpectralDistanceDb: number; }
export function compareSpectrum(reference: Float64Array, estimate: Float64Array): SpectralComparison { return { logSpectralDistanceDb: logSpectralDistanceDb(reference, estimate) }; }
export interface PhaseComparison { lagSamples: number; correlation: number; timeShiftDetected: boolean; }
export function comparePhase(reference: Float64Array, estimate: Float64Array, maxLagSamples = 512): PhaseComparison { const result = findBestLag(reference, estimate, maxLagSamples); return { lagSamples: result.lag, correlation: result.correlation, timeShiftDetected: result.lag !== 0 && result.correlation > .3 }; }
export interface StemMetricsReport { stemId: string; sdrDb: number; siSdrDb: number; interferenceDb: number; spectral: SpectralComparison; levels: LevelComparison; stereo: StereoComparison; phase: PhaseComparison; transients: TransientComparison; bleed: BleedEntry[]; }
export function evaluateStem(stemId: string, reference: StereoSignal, estimate: StereoSignal, otherStems: { id: string; signal: StereoSignal }[]): StemMetricsReport { const n = nOf(reference, estimate), ref = downmixMono(reference.data, reference.channels, n), est = downmixMono(estimate.data, estimate.channels, n), others = otherStems.map((o) => ({ id: o.id, data: downmixMono(o.signal.data, o.signal.channels, Math.min(n, o.signal.frames)) })); return { stemId, sdrDb: sdr(ref, est), siSdrDb: siSdr(ref, est), interferenceDb: interferenceDb(ref, est, others.map((o) => o.data)), spectral: compareSpectrum(ref, est), levels: compareLevels(ref, est, reference.sampleRate), stereo: compareStereo(reference, estimate), phase: comparePhase(ref, est), transients: compareTransients(ref, est, reference.sampleRate), bleed: measureBleed(stemId, ref, est, others) }; }
export function qualityScore(report: StemMetricsReport): { score: number; breakdown: Record<string, number> } { const iso = Math.max(0, Math.min(10, report.siSdrDb / 2)); const bleed = report.bleed.length ? Math.max(...report.bleed.map((x) => x.bleedDb)) : -60; const bleedPenalty = bleed > -6 ? 4 : bleed > -12 ? 2 : bleed > -18 ? 1 : 0; const transientPenalty = report.transients.preserved ? 0 : Math.min(3, report.transients.missingCount / Math.max(1, report.transients.referenceCount) * 6); const stereoPenalty = report.stereo.becameMono ? 3 : Math.min(1.5, Math.abs(report.stereo.widthDeltaDb) / 6); const spectralPenalty = Math.min(2, report.spectral.logSpectralDistanceDb / 10); const score = Math.max(1, Math.min(9.5, iso - bleedPenalty - transientPenalty - stereoPenalty - spectralPenalty)); return { score, breakdown: { sdrScore: iso, bleedPenalty, transientPenalty, stereoPenalty, spectralPenalty } }; }
export function qualityLabel(score: number): string { if (score < 3) return 'unbrauchbar'; if (score < 5) return 'grenzwertig'; if (score < 7) return 'brauchbar mit deutlichen Fehlern'; if (score < 8) return 'gut'; if (score < 8.5) return 'sehr gut'; if (score < 9) return 'professionell brauchbar (HIGH_QUALITY-Ziel)'; return 'professionell brauchbar (MAXIMUM_QUALITY-Ziel)'; }
