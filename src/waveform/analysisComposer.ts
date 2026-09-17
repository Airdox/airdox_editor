/**
 * Rekordbox waveform composition helpers.
 *
 * Rekordbox ANLZ files contain a precomputed, quantized waveform.  A project
 * edit must not silently replace untouched ANLZ regions with a browser-made
 * waveform.  This module splices those original buckets into a new timeline
 * and only uses a locally calculated analysis for regions that genuinely
 * cannot be represented by an original ANLZ source (for example an overdub).
 */

import { DataOrigin, EditSegment, WaveformAnalysisData, WaveformProvenance } from '../types/rekordbox';
import { analyzeAudioBuffer } from './analyzer';

export interface WaveformRegion {
  /** Inclusive start on the output/project timeline, in seconds. */
  outputStart: number;
  /** Exclusive end on the output/project timeline, in seconds. */
  outputEnd: number;
  /** Analysis from which the values are sampled. Omit for silence. */
  analysis?: WaveformAnalysisData | null;
  /** Full timeline duration represented by `analysis`. */
  sourceDuration?: number;
  /** Offset into the source analysis timeline, in seconds. */
  sourceStart?: number;
  /**
   * Source seconds consumed per output second.  A tempo adapted clip, for
   * example, uses its original duration divided by its adapted duration.
   */
  sourceTimeScale?: number;
  /** Explicit zero-energy project region (CLEAR / mute). */
  silence?: boolean;
}

export interface ComposeWaveformOptions {
  duration: number;
  regions: WaveformRegion[];
  /** Resolution to retain where possible. Defaults to the first source. */
  preferredSecondsPerBucket?: number;
  /** Description shown in the provenance inspector. */
  operation?: WaveformProvenance['operation'];
}

const EPSILON = 1e-8;

/** True only for precomputed Pioneer/Rekordbox waveform data. */
export function isNativeRekordboxWaveform(
  analysis: WaveformAnalysisData | null | undefined
): analysis is WaveformAnalysisData {
  return Boolean(
    analysis &&
      analysis.length > 0 &&
      (analysis.origin === DataOrigin.REKORDBOX_ANLZ ||
        (analysis.provenance?.nativeCoverage === 1 && analysis.provenance.projectCoverage === 0))
  );
}

/**
 * Resolves one analysis bucket's time span.  ANLZ sections do not always carry
 * an explicit bucket duration, therefore the owning track duration is the
 * authoritative fallback.
 */
export function getWaveformSecondsPerBucket(
  analysis: WaveformAnalysisData,
  sourceDuration: number
): number {
  const explicit = analysis.secPerBucket;
  if (explicit && Number.isFinite(explicit) && explicit > 0) return explicit;
  const duration = Math.max(EPSILON, sourceDuration);
  return duration / Math.max(1, analysis.length);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function emptyAnalysis(
  duration: number,
  secondsPerBucket: number,
  provenance: WaveformProvenance
): WaveformAnalysisData {
  const safeDuration = Math.max(EPSILON, duration);
  const count = Math.max(1, Math.round(safeDuration / Math.max(EPSILON, secondsPerBucket)));
  const actualSecondsPerBucket = safeDuration / count;
  return {
    length: count,
    peaks: new Float32Array(count),
    peaksL: new Float32Array(count),
    peaksR: new Float32Array(count),
    lowEnergy: new Float32Array(count),
    midEnergy: new Float32Array(count),
    highEnergy: new Float32Array(count),
    origin: provenance.nativeCoverage >= 0.999 && provenance.projectCoverage === 0
      ? DataOrigin.REKORDBOX_ANLZ
      : DataOrigin.PROJECT,
    secPerBucket: actualSecondsPerBucket,
    provenance,
  };
}

function sourceBucketAt(
  analysis: WaveformAnalysisData,
  sourceDuration: number,
  sourceTime: number
): number {
  if (analysis.length <= 1 || sourceDuration <= EPSILON) return 0;
  const normalized = clamp(sourceTime / sourceDuration, 0, 1 - Number.EPSILON);
  return clamp(Math.floor(normalized * analysis.length), 0, analysis.length - 1);
}

function sourceOriginFor(region: WaveformRegion): DataOrigin | undefined {
  return region.analysis?.origin;
}

/**
 * Copies a time range from a waveform into a standalone clip waveform.  The
 * returned values are still exact values from the original analysis; no DSP or
 * spectral approximation is performed.
 */
export function sliceWaveformAnalysis(
  analysis: WaveformAnalysisData | null | undefined,
  sourceDuration: number,
  start: number,
  end: number
): WaveformAnalysisData | undefined {
  if (!analysis || analysis.length <= 0) return undefined;
  const safeStart = clamp(Math.min(start, end), 0, Math.max(0, sourceDuration));
  const safeEnd = clamp(Math.max(start, end), safeStart, Math.max(safeStart, sourceDuration));
  const duration = Math.max(EPSILON, safeEnd - safeStart);
  const secondsPerBucket = getWaveformSecondsPerBucket(analysis, sourceDuration);

  // Preserve exact direct source data where a complete analysis is requested.
  if (safeStart <= EPSILON && Math.abs(safeEnd - sourceDuration) <= EPSILON) {
    return {
      ...analysis,
      peaks: new Float32Array(analysis.peaks),
      peaksL: new Float32Array(analysis.peaksL),
      peaksR: new Float32Array(analysis.peaksR),
      lowEnergy: new Float32Array(analysis.lowEnergy),
      midEnergy: new Float32Array(analysis.midEnergy),
      highEnergy: new Float32Array(analysis.highEnergy),
      secPerBucket: secondsPerBucket,
      provenance: {
        sourceOrigins: [analysis.origin],
        nativeCoverage: isNativeRekordboxWaveform(analysis) ? 1 : 0,
        projectCoverage: isNativeRekordboxWaveform(analysis) ? 0 : 1,
        operation: 'DIRECT',
      },
    };
  }

  return composeWaveformAnalysis({
    duration,
    preferredSecondsPerBucket: secondsPerBucket,
    operation: 'DIRECT',
    regions: [{
      outputStart: 0,
      outputEnd: duration,
      analysis,
      sourceDuration,
      sourceStart: safeStart,
    }],
  });
}

/**
 * Creates a waveform for a new project timeline by sampling supplied source
 * analyses.  It intentionally does not call the browser analyser: every
 * non-silent output bucket comes from one of the supplied analyses.
 */
export function composeWaveformAnalysis(options: ComposeWaveformOptions): WaveformAnalysisData {
  const duration = Math.max(EPSILON, options.duration);
  const usableRegions = options.regions
    .filter((region) => region.outputEnd > region.outputStart + EPSILON)
    .slice()
    .sort((a, b) => a.outputStart - b.outputStart);

  const firstSource = usableRegions.find((region) => region.analysis && region.analysis.length > 0);
  const secondsPerBucket = options.preferredSecondsPerBucket && options.preferredSecondsPerBucket > 0
    ? options.preferredSecondsPerBucket
    : firstSource?.analysis
      ? getWaveformSecondsPerBucket(firstSource.analysis, firstSource.sourceDuration || duration)
      : duration;

  const nativeSeconds = usableRegions.reduce((total, region) => {
    if (region.silence || !isNativeRekordboxWaveform(region.analysis)) return total;
    return total + Math.max(0, region.outputEnd - region.outputStart);
  }, 0);
  const projectSeconds = usableRegions.reduce((total, region) => {
    if (region.silence) return total;
    if (isNativeRekordboxWaveform(region.analysis)) return total;
    return total + Math.max(0, region.outputEnd - region.outputStart);
  }, 0);
  const sourceOrigins = Array.from(new Set(
    usableRegions
      .map(sourceOriginFor)
      .filter((origin): origin is DataOrigin => Boolean(origin))
  ));

  const provenance: WaveformProvenance = {
    sourceOrigins,
    nativeCoverage: clamp(nativeSeconds / duration, 0, 1),
    projectCoverage: clamp(projectSeconds / duration, 0, 1),
    operation: options.operation || 'SPLICED',
  };
  const result = emptyAnalysis(duration, secondsPerBucket, provenance);

  let regionIndex = 0;
  for (let bucket = 0; bucket < result.length; bucket++) {
    const outputTime = (bucket + 0.5) * (result.secPerBucket || duration / result.length);
    while (
      regionIndex < usableRegions.length - 1 &&
      outputTime >= usableRegions[regionIndex].outputEnd - EPSILON
    ) {
      regionIndex++;
    }
    const region = usableRegions[regionIndex];
    if (!region || region.silence || !region.analysis || region.analysis.length <= 0) continue;
    if (outputTime < region.outputStart - EPSILON || outputTime >= region.outputEnd + EPSILON) continue;

    const sourceDuration = region.sourceDuration || (region.analysis.secPerBucket || 0) * region.analysis.length || duration;
    const sourceTime = (region.sourceStart || 0) +
      (outputTime - region.outputStart) * (region.sourceTimeScale || 1);
    const sourceBucket = sourceBucketAt(region.analysis, sourceDuration, sourceTime);

    result.peaks[bucket] = region.analysis.peaks[sourceBucket] || 0;
    result.peaksL[bucket] = region.analysis.peaksL[sourceBucket] || 0;
    result.peaksR[bucket] = region.analysis.peaksR[sourceBucket] || 0;
    result.lowEnergy[bucket] = region.analysis.lowEnergy[sourceBucket] || 0;
    result.midEnergy[bucket] = region.analysis.midEnergy[sourceBucket] || 0;
    result.highEnergy[bucket] = region.analysis.highEnergy[sourceBucket] || 0;
  }

  return result;
}

/**
 * Builds a direct native/project split used by operations such as OVERDUB.
 * Original ANLZ data remains untouched outside the edited range while the
 * supplied local analysis represents only the changed range.
 */
export function composeMixedWaveform(
  baseAnalysis: WaveformAnalysisData,
  baseDuration: number,
  changedAnalysis: WaveformAnalysisData,
  changedStart: number,
  changedEnd: number,
  operation: WaveformProvenance['operation'] = 'MIXED'
): WaveformAnalysisData {
  const start = clamp(changedStart, 0, baseDuration);
  const end = clamp(changedEnd, start, baseDuration);
  return composeWaveformAnalysis({
    duration: baseDuration,
    preferredSecondsPerBucket: getWaveformSecondsPerBucket(baseAnalysis, baseDuration),
    operation,
    regions: [
      { outputStart: 0, outputEnd: start, analysis: baseAnalysis, sourceDuration: baseDuration, sourceStart: 0 },
      { outputStart: start, outputEnd: end, analysis: changedAnalysis, sourceDuration: baseDuration, sourceStart: start },
      { outputStart: end, outputEnd: baseDuration, analysis: baseAnalysis, sourceDuration: baseDuration, sourceStart: end },
    ],
  });
}


/**
 * Rebuilds a project waveform from its causal edit decision list after a
 * project is reopened. Untouched ORIGINAL/CUT regions are re-sampled from the
 * freshly opened native ANLZ data. Regions whose final audio genuinely differs
 * (insertions from another source, replacements, and overdubs) use an exact
 * local analysis of the rendered output only for those spans. This prevents a
 * project reload from silently throwing away all available Rekordbox buckets.
 */
export function composeWaveformFromEditSegments(
  renderedBuffer: AudioBuffer,
  nativeAnalysis: WaveformAnalysisData | null | undefined,
  nativeSourceDuration: number,
  segments: EditSegment[],
  sourceIdentity?: { path?: string; trackId?: string }
): WaveformAnalysisData {
  if (!isNativeRekordboxWaveform(nativeAnalysis)) {
    return analyzeAudioBuffer(renderedBuffer, DataOrigin.PROJECT);
  }

  const duration = Math.max(EPSILON, renderedBuffer.duration);
  const sourceDuration = Math.max(
    EPSILON,
    nativeSourceDuration || nativeAnalysis.secPerBucket! * nativeAnalysis.length || duration
  );
  const samePath = (a?: string, b?: string): boolean => {
    if (!a || !b) return false;
    return a.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase() ===
      b.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
  };
  const belongsToNativeSource = (segment: EditSegment): boolean => {
    // ORIGINAL/CUT ranges always address the active track's source buffer.
    if (segment.type === 'ORIGINAL' || segment.type === 'CUT') return true;
    if (segment.analysisSource?.path && sourceIdentity?.path) {
      return samePath(segment.analysisSource.path, sourceIdentity.path);
    }
    return Boolean(
      segment.analysisSourceTrackId && sourceIdentity?.trackId &&
      segment.analysisSourceTrackId === sourceIdentity.trackId
    );
  };

  let localAnalysis: WaveformAnalysisData | undefined;
  const localRegion = (outputStart: number, outputEnd: number): WaveformRegion => {
    if (!localAnalysis) localAnalysis = analyzeAudioBuffer(renderedBuffer, DataOrigin.PROJECT);
    return {
      outputStart,
      outputEnd,
      analysis: localAnalysis,
      sourceDuration: duration,
      sourceStart: outputStart,
    };
  };
  const trimRegion = (region: WaveformRegion, outputStart: number, outputEnd: number): WaveformRegion => {
    const sourceScale = region.sourceTimeScale || 1;
    return {
      ...region,
      outputStart,
      outputEnd,
      sourceStart: (region.sourceStart || 0) + (outputStart - region.outputStart) * sourceScale,
    };
  };
  const baseSegments = (segments || [])
    .filter((segment) => segment.projectDuration > EPSILON && segment.type !== 'OVERDUB')
    .slice()
    .sort((a, b) => a.projectStart - b.projectStart);

  // A missing EDL means the native waveform directly owns the complete buffer.
  if (baseSegments.length === 0) {
    return composeWaveformAnalysis({
      duration,
      preferredSecondsPerBucket: getWaveformSecondsPerBucket(nativeAnalysis, sourceDuration),
      operation: 'DIRECT',
      regions: [{
        outputStart: 0,
        outputEnd: duration,
        analysis: nativeAnalysis,
        sourceDuration,
        sourceStart: 0,
        sourceTimeScale: sourceDuration / duration,
      }],
    });
  }

  const regions: WaveformRegion[] = [];
  let cursor = 0;
  for (const segment of baseSegments) {
    const segmentStart = clamp(segment.projectStart, 0, duration);
    const segmentEnd = clamp(segment.projectStart + segment.projectDuration, segmentStart, duration);
    if (segmentEnd <= cursor + EPSILON) continue;
    if (segmentStart > cursor + EPSILON) regions.push(localRegion(cursor, segmentStart));

    const outputStart = Math.max(cursor, segmentStart);
    if (segment.type === 'SILENCE') {
      regions.push({ outputStart, outputEnd: segmentEnd, silence: true });
    } else if (belongsToNativeSource(segment)) {
      const nativeStart = segment.analysisSourceStart ?? segment.sourceStart;
      const nativeEnd = segment.analysisSourceEnd ?? segment.sourceEnd;
      const nativeSpan = Math.max(0, nativeEnd - nativeStart);
      const segmentScale = nativeSpan > EPSILON
        ? nativeSpan / Math.max(EPSILON, segment.projectDuration)
        : 1;
      regions.push({
        outputStart,
        outputEnd: segmentEnd,
        analysis: nativeAnalysis,
        sourceDuration,
        sourceStart: nativeStart + (outputStart - segmentStart) * segmentScale,
        sourceTimeScale: segmentScale,
      });
    } else {
      regions.push(localRegion(outputStart, segmentEnd));
    }
    cursor = Math.max(cursor, segmentEnd);
  }
  if (cursor < duration - EPSILON) regions.push(localRegion(cursor, duration));

  // An OVERDUB has the final mixed signal as its authoritative visual source.
  // Replace only its covered output span; untouched neighbours keep native data.
  const overlays = (segments || [])
    .filter((segment) => segment.type === 'OVERDUB' && segment.projectDuration > EPSILON)
    .slice()
    .sort((a, b) => a.projectStart - b.projectStart);
  for (const overlay of overlays) {
    const start = clamp(overlay.projectStart, 0, duration);
    const end = clamp(overlay.projectStart + overlay.projectDuration, start, duration);
    if (end <= start + EPSILON) continue;
    const next: WaveformRegion[] = [];
    for (const region of regions) {
      if (region.outputEnd <= start + EPSILON || region.outputStart >= end - EPSILON) {
        next.push(region);
        continue;
      }
      if (region.outputStart < start - EPSILON) next.push(trimRegion(region, region.outputStart, start));
      const coveredStart = Math.max(region.outputStart, start);
      const coveredEnd = Math.min(region.outputEnd, end);
      next.push(localRegion(coveredStart, coveredEnd));
      if (region.outputEnd > end + EPSILON) next.push(trimRegion(region, end, region.outputEnd));
    }
    regions.splice(0, regions.length, ...next);
  }

  return composeWaveformAnalysis({
    duration,
    preferredSecondsPerBucket: getWaveformSecondsPerBucket(nativeAnalysis, sourceDuration),
    operation: 'MIXED',
    regions,
  });
}
