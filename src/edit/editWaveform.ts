/**
 * @license
 * Additive ("Aufrechnung") waveform composition for the edited deck (pure).
 *
 * The question this module answers: after an Insert / Replace / Delete, must the
 * whole file be re-analysed? No. The pristine ANLZ columns remain correct for
 * every untouched moment of the project — only their timeline position changed.
 * So the projected waveform is built column-wise:
 *
 *   1. untouched original material → the stored ANLZ column is COPIED (index
 *      re-mapped through the edit projection; no resampling, no averaging, no
 *      smoothing, no invented detail),
 *   2. inserted/replaced clip material → the columns of the clip's own source
 *      track are copied the same way whenever the clip plays verbatim
 *      (tempoRatio 1.0, no pitch shift, unity gain): those numbers already exist,
 *   3. material without stored columns (time-stretched or pitch-shifted clip
 *      audio, local imports) → peaks/band energies are computed FROM THE AUDIO
 *      THAT ACTUALLY PLAYS and explicitly flagged `COMPUTED` / `USER_EDIT`,
 *   4. cleared ranges → real digital silence, flagged `SILENCE`,
 *   5. regions whose source has no analysis (Rekordbox track without ANLZ) →
 *      flagged `MISSING` and drawn EMPTY. Nothing is invented, which keeps the
 *      ANLZ-only guarantee of the Rekordbox production path intact.
 *
 * Because every composite is re-derived from the pristine arrays (never from the
 * previously displayed composite), repeated edits, Undo/Redo and project
 * re-openings cannot degrade or drift the imported waveform.
 */

import { DataOrigin, WaveformAnalysisData } from '../types/rekordbox';
import {
  OverdubSpan,
  ProjectedTimeline,
  TIME_EPS,
  TimelineSpan,
  sourceTrackTimeOf,
  spanAllowsVerbatimClipColumns,
} from './editTimeline';
import { analyzeRangeBuckets } from '../waveform/analyzer';

/** Per-column provenance codes (see `WaveformAnalysisData.provenance`). */
export const ColumnSource = {
  /** Verbatim ANLZ column at its untouched position. */
  ANLZ: 0,
  /** Verbatim ANLZ column re-timed by a structural edit. */
  ANLZ_RETIMED: 1,
  /** Verbatim column taken from another loaded track (palette clip source). */
  CLIP_ANLZ: 2,
  /** Peaks/bands computed from edited user audio (never Rekordbox data). */
  COMPUTED: 3,
  /** Overdub overlay mixed onto the underlying columns. */
  MIX: 4,
  /** Cleared (muted) range — real digital silence. */
  SILENCE: 5,
  /** No source data exists; drawn empty instead of invented. */
  MISSING: 6,
} as const;

export type ColumnSourceCode = (typeof ColumnSource)[keyof typeof ColumnSource];

export const COLUMN_SOURCE_LABELS: Record<number, string> = {
  [ColumnSource.ANLZ]: 'ANLZ unverändert',
  [ColumnSource.ANLZ_RETIMED]: 'ANLZ neu eingesetzt',
  [ColumnSource.CLIP_ANLZ]: 'ANLZ des Clip-Ursprungs',
  [ColumnSource.COMPUTED]: 'aus Edit-Audio berechnet',
  [ColumnSource.MIX]: 'Overdub-Mischung',
  [ColumnSource.SILENCE]: 'Stille (Clear)',
  [ColumnSource.MISSING]: 'keine Daten (ANLZ fehlt)',
};

export const COLUMN_SOURCE_SHORT: Record<number, string> = {
  [ColumnSource.ANLZ]: 'ANLZ',
  [ColumnSource.ANLZ_RETIMED]: 'ANLZ⇄',
  [ColumnSource.CLIP_ANLZ]: 'CLIP-ANLZ',
  [ColumnSource.COMPUTED]: 'BERECHNET',
  [ColumnSource.MIX]: 'MIX',
  [ColumnSource.SILENCE]: 'STILLE',
  [ColumnSource.MISSING]: '—',
};

/** True when a column's numbers come from own analysis instead of ANLZ storage. */
export function isComputedColumn(code: number | undefined): boolean {
  return code === ColumnSource.COMPUTED || code === ColumnSource.MIX;
}

/** True when a column must stay visibly empty (no data, nothing invented). */
export function isEmptyColumn(code: number | undefined): boolean {
  return code === ColumnSource.MISSING;
}

/** Audio channels needed to compute columns for a range. */
export interface RangeChannels {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

/** A computed column set for one range (all arrays share one length). */
export interface RangeAnalysis {
  peaks: Float32Array;
  peaksL: Float32Array;
  peaksR: Float32Array;
  lowEnergy: Float32Array;
  midEnergy: Float32Array;
  highEnergy: Float32Array;
}

/** Injected range analyzer (defaults to the documented peak/band estimator). */
export type RangeAnalyzer = (
  channels: RangeChannels,
  startSec: number,
  endSec: number,
  bucketSeconds: number
) => RangeAnalysis;

/**
 * Everything the compositor needs about the clip material of one span: the
 * pristine analysis of the track the clip came from (for verbatim column reuse)
 * plus the audio that is actually played (for honest computed columns).
 */
export interface ClipColumnSource {
  sourceVariants: WaveformAnalysisData[];
  /** Duration of the clip's source track (its column → time mapping). */
  sourceDuration: number;
  playChannels: RangeChannels | null;
}

export type ClipSourceResolver = (span: TimelineSpan) => ClipColumnSource | null;

export interface EditWaveformInput {
  timeline: ProjectedTimeline;
  /** Pristine variants of the deck track (never mutated by edits). */
  baseVariants: WaveformAnalysisData[];
  /** Duration the base variants span (the pristine source duration). */
  baseSourceDuration: number;
  clipResolver: ClipSourceResolver;
  analyzeRange?: RangeAnalyzer;
  /** Sample rate used for the derived `samplesPerBucket` bookkeeping. */
  sampleRate?: number;
  /** Column duration used when the deck has no ANLZ variant at all. */
  fallbackBucketSeconds?: number;
  /** Upper bound for composite columns (0 = uncapped); truncation is reported. */
  maxColumns?: number;
}

export interface EditWaveformStats {
  variants: number;
  sourceTags: string[];
  columns: number;
  bucketSeconds: number;
  verbatimColumns: number;
  retimedColumns: number;
  clipColumns: number;
  computedColumns: number;
  mixColumns: number;
  /** Overdub overlay taken from STORED columns of the clip source (nothing computed). */
  mixStoredColumns: number;
  /** Overdub overlay that had to be measured from the clip audio (no stored columns). */
  mixComputedColumns: number;
  silenceColumns: number;
  missingColumns: number;
  truncated: boolean;
  /** Spans whose clip material had no stored columns (computed instead). */
  spansComputed: number;
  /** Spans that reused stored columns of a foreign source track. */
  spansVerbatimClip: number;
  /** Spans with no data at all (rendered honestly empty). */
  spansMissing: number;
}

interface ColumnArrays {
  peaks: Float32Array;
  peaksL: Float32Array;
  peaksR: Float32Array;
  lowEnergy: Float32Array;
  midEnergy: Float32Array;
  highEnergy: Float32Array;
  whiteness?: Float32Array;
  luminance?: Float32Array;
  backPeaks?: Float32Array;
  frontPeaks?: Float32Array;
  provenance: Uint8Array;
}

function allocate(base: WaveformAnalysisData | null, count: number): ColumnArrays {
  return {
    peaks: new Float32Array(count),
    peaksL: new Float32Array(count),
    peaksR: new Float32Array(count),
    lowEnergy: new Float32Array(count),
    midEnergy: new Float32Array(count),
    highEnergy: new Float32Array(count),
    ...(base?.whiteness ? { whiteness: new Float32Array(count) } : {}),
    ...(base?.luminance ? { luminance: new Float32Array(count) } : {}),
    ...(base?.backPeaks ? { backPeaks: new Float32Array(count) } : {}),
    ...(base?.frontPeaks ? { frontPeaks: new Float32Array(count) } : {}),
    provenance: new Uint8Array(count).fill(ColumnSource.MISSING),
  };
}

/**
 * Bucket index of a time. The 1e-6 bucket tolerance matters: boundaries come
 * from float arithmetic (`3.0 / 0.1 = 29.999999999999996`), and without it a
 * span boundary would silently steal the previous column.
 */
function bucketIndexOf(t: number, bucketSeconds: number): number {
  return Math.max(0, Math.floor(t / bucketSeconds + 1e-6));
}

/**
 * Last column that starts BEFORE `t` (a span `[a, b)` owns columns
 * `floor(a/bd) … ceil(b/bd)-1`). Using the same `bucketIndexOf` on the end would
 * hand every span one extra column and let the following span overwrite it, so
 * two neighbouring spans could fight over a boundary column.
 */
function bucketEndIndex(t: number, bucketSeconds: number): number {
  return Math.max(0, Math.ceil(t / bucketSeconds - 1e-6) - 1);
}

/**
 * Fills output columns `[outStart, outStart + count)` from `src` (a variant that
 * spans `srcDuration` seconds with uniform column width `srcBucketSeconds`),
 * where output column `outStart + i` represents project time
 * `projectStartOfSpan + (i)*outBucketSeconds` and the source time is
 * `srcStartSec + i * outBucketSeconds * timeScale`.
 *
 * Selection is NEAREST-COLUMN only: a source value is copied byte-exactly or not
 * at all — no interpolation, no averaging. When resolutions differ, columns are
 * repeated or skipped, which is why such spans are labelled explicitly.
 */
function fillFromVariant(
  out: ColumnArrays,
  outStart: number,
  count: number,
  src: WaveformAnalysisData,
  srcBucketSeconds: number,
  srcStartSec: number,
  outBucketSeconds: number,
  code: ColumnSourceCode,
  /** Extra per-column mapping override: source time for output index i. */
  timeOf?: (i: number) => number
): number {
  const srcLength = src.length;
  if (srcLength === 0 || !(srcBucketSeconds > 0)) return 0;
  const srcDurationSec = srcLength * srcBucketSeconds;
  let written = 0;
  for (let i = 0; i < count; i++) {
    const outIdx = outStart + i;
    if (outIdx >= out.peaks.length) break;
    const srcTime = timeOf ? timeOf(i) : srcStartSec + i * outBucketSeconds;
    if (!(srcTime >= 0) || srcTime >= srcDurationSec - TIME_EPS) break;
    const sIdx = Math.max(0, Math.min(srcLength - 1, Math.floor(srcTime / srcBucketSeconds + 1e-9)));
    out.peaks[outIdx] = src.peaks[sIdx];
    out.peaksL[outIdx] = src.peaksL[sIdx];
    out.peaksR[outIdx] = src.peaksR[sIdx];
    out.lowEnergy[outIdx] = src.lowEnergy[sIdx];
    out.midEnergy[outIdx] = src.midEnergy[sIdx];
    out.highEnergy[outIdx] = src.highEnergy[sIdx];
    if (out.whiteness) out.whiteness[outIdx] = src.whiteness ? src.whiteness[sIdx] : src.peaks[sIdx];
    if (out.luminance) out.luminance[outIdx] = src.luminance ? src.luminance[sIdx] : 1;
    if (out.backPeaks) out.backPeaks[outIdx] = src.backPeaks ? src.backPeaks[sIdx] : src.peaks[sIdx];
    if (out.frontPeaks) out.frontPeaks[outIdx] = src.frontPeaks ? src.frontPeaks[sIdx] : src.peaks[sIdx];
    out.provenance[outIdx] = code;
    written += 1;
  }
  return written;
}

/**
 * Verbatim typed-array block copy for the (very common) case where a span's
 * source position differs from its project position by an exact multiple of the
 * column duration: the values are then literally the same numbers at a shifted
 * index, which is the cheapest possible proof that nothing was recomputed.
 */
function blockCopy(
  out: ColumnArrays,
  src: WaveformAnalysisData,
  outStart: number,
  srcStart: number,
  count: number,
  code: ColumnSourceCode,
  bucketSeconds: number,
  projectStart: number,
  sourceStart: number
): boolean {
  const shift = srcStart - outStart;
  if (!Number.isInteger(shift) || shift < 0) return false;
  // Only an exact whole-column displacement may be copied as a block: any other
  // phase must go through the nearest-column mapper so no value is invented.
  const exact = Math.abs(sourceStart - projectStart - shift * bucketSeconds) < 1e-9;
  if (!exact) return false;
  if (outStart < 0 || srcStart < 0 || srcStart + count > src.length || outStart + count > out.peaks.length) {
    return false;
  }
  out.peaks.set(src.peaks.subarray(srcStart, srcStart + count), outStart);
  out.peaksL.set(src.peaksL.subarray(srcStart, srcStart + count), outStart);
  out.peaksR.set(src.peaksR.subarray(srcStart, srcStart + count), outStart);
  out.lowEnergy.set(src.lowEnergy.subarray(srcStart, srcStart + count), outStart);
  out.midEnergy.set(src.midEnergy.subarray(srcStart, srcStart + count), outStart);
  out.highEnergy.set(src.highEnergy.subarray(srcStart, srcStart + count), outStart);
  if (out.whiteness) {
    if (src.whiteness) out.whiteness.set(src.whiteness.subarray(srcStart, srcStart + count), outStart);
    else out.whiteness.fill(0, outStart, outStart + count);
  }
  if (out.luminance && src.luminance) {
    out.luminance.set(src.luminance.subarray(srcStart, srcStart + count), outStart);
  }
  if (out.backPeaks && src.backPeaks) {
    out.backPeaks.set(src.backPeaks.subarray(srcStart, srcStart + count), outStart);
  }
  if (out.frontPeaks && src.frontPeaks) {
    out.frontPeaks.set(src.frontPeaks.subarray(srcStart, srcStart + count), outStart);
  }
  for (let i = 0; i < count; i++) out.provenance[outStart + i] = code;
  return true;
}

/**
 * Adds one real overlay column onto a layout column. Both sides are measured
 * values (stored ANLZ column or analyzed peak of the actual clip audio) — the
 * function only sums them and limits the result to the normalized range, it
 * never invents, smooths or averages across neighbours.
 */
function overlayColumns(
  out: ColumnArrays,
  outIdx: number,
  src: ColumnArrays,
  srcIdx: number,
  gain: number
): void {
  const g = Number.isFinite(gain) ? Math.max(0, gain) : 1;
  const mix = (base: number, over: number) => Math.min(1, base + over * g);
  out.peaks[outIdx] = mix(out.peaks[outIdx], src.peaks[srcIdx]);
  out.peaksL[outIdx] = mix(out.peaksL[outIdx], src.peaksL[srcIdx]);
  out.peaksR[outIdx] = mix(out.peaksR[outIdx], src.peaksR[srcIdx]);
  out.lowEnergy[outIdx] = mix(out.lowEnergy[outIdx], src.lowEnergy[srcIdx]);
  out.midEnergy[outIdx] = mix(out.midEnergy[outIdx], src.midEnergy[srcIdx]);
  out.highEnergy[outIdx] = mix(out.highEnergy[outIdx], src.highEnergy[srcIdx]);
  // Colour/whiteness channels are only ever carried over from the layer that is
  // drawn: mixing them arithmetically would create colors neither source had.
  if (out.backPeaks) out.backPeaks[outIdx] = mix(out.backPeaks[outIdx], src.backPeaks?.[srcIdx] ?? src.peaks[srcIdx]);
  if (out.frontPeaks) out.frontPeaks[outIdx] = mix(out.frontPeaks[outIdx], src.frontPeaks?.[srcIdx] ?? src.peaks[srcIdx]);
}

function writeComputed(
  out: ColumnArrays,
  outStart: number,
  count: number,
  channels: RangeChannels,
  startSec: number,
  endSec: number,
  bucketSeconds: number,
  analyzer: RangeAnalyzer,
  code: ColumnSourceCode
): void {
  if (count <= 0) return;
  const analysis = analyzer(channels, startSec, endSec, bucketSeconds);
  const n = Math.min(count, analysis.peaks.length);
  for (let i = 0; i < n; i++) {
    const j = outStart + i;
    if (j >= out.peaks.length) break;
    out.peaks[j] = analysis.peaks[i];
    out.peaksL[j] = analysis.peaksL[i];
    out.peaksR[j] = analysis.peaksR[i];
    out.lowEnergy[j] = analysis.lowEnergy[i];
    out.midEnergy[j] = analysis.midEnergy[i];
    out.highEnergy[j] = analysis.highEnergy[i];
    // No stored whiteness/luminance exists for computed audio: neutral maxima,
    // the renderer overrides the color of COMPUTED columns anyway.
    if (out.whiteness) out.whiteness[j] = 1;
    if (out.luminance) out.luminance[j] = 1;
    if (out.backPeaks) out.backPeaks[j] = analysis.peaks[i];
    if (out.frontPeaks) out.frontPeaks[j] = analysis.peaks[i];
    out.provenance[j] = code;
  }
  // Material shorter than the span stays honest: real silence for the rest.
  for (let i = n; i < count; i++) {
    const j = outStart + i;
    if (j >= out.peaks.length) break;
    out.provenance[j] = ColumnSource.SILENCE;
  }
}

function overdubAsSpan(od: OverdubSpan): TimelineSpan {
  return {
    id: od.id,
    kind: 'clip',
    projectStart: od.projectStart,
    duration: od.duration,
    sourceStart: od.sourceStart,
    segmentId: od.segmentId,
    clipId: od.clipId,
    sourceTrackId: od.sourceTrackId,
    sourceClipStart: od.sourceClipStart,
    tempoRatio: od.tempoRatio,
    pitchShift: od.pitchShift,
    gain: od.gain,
  };
}

/**
 * Builds the projected waveform variants of the current edit state — one
 * composite per pristine ANLZ variant, so the zoom-based variant selection of
 * the renderers keeps working on the edited timeline as well.
 */
export function buildEditWaveformVariants(input: EditWaveformInput): {
  variants: WaveformAnalysisData[];
  stats: EditWaveformStats;
} {
  const analyzer = input.analyzeRange ?? analyzeRangeBuckets;
  const { timeline } = input;
  const projectDuration = Math.max(0.0001, timeline.duration);
  const baseVariants = (input.baseVariants ?? []).filter((v) => v && v.length > 0);
  const fallbackBucketSeconds =
    input.fallbackBucketSeconds && input.fallbackBucketSeconds > 0
      ? input.fallbackBucketSeconds
      : 0.005;
  const sampleRate = input.sampleRate && input.sampleRate > 0 ? input.sampleRate : 44100;

  const stats: EditWaveformStats = {
    variants: 0,
    sourceTags: baseVariants.map((v) => v.sourceTag ?? 'ANLZ'),
    columns: 0,
    bucketSeconds: 0,
    verbatimColumns: 0,
    retimedColumns: 0,
    clipColumns: 0,
    computedColumns: 0,
    mixColumns: 0,
    mixStoredColumns: 0,
    mixComputedColumns: 0,
    silenceColumns: 0,
    missingColumns: 0,
    truncated: false,
    spansComputed: 0,
    spansVerbatimClip: 0,
    spansMissing: 0,
  };

  const outputs: WaveformAnalysisData[] = [];
  const toProject: Array<WaveformAnalysisData | null> =
    baseVariants.length > 0 ? baseVariants : [null];
  const baseSourceDuration = Math.max(0.0001, input.baseSourceDuration || 0);

  for (const base of toProject) {
    const bucketSeconds = base
      ? base.secPerBucket && base.secPerBucket > 0
        ? base.secPerBucket
        : baseSourceDuration / base.length
      : fallbackBucketSeconds;
    if (!(bucketSeconds > 0) || !Number.isFinite(bucketSeconds)) continue;

    let outCount = Math.max(1, Math.ceil(projectDuration / bucketSeconds - 1e-9));
    const maxColumns = input.maxColumns ?? 0;
    if (maxColumns > 0 && outCount > maxColumns) {
      outCount = maxColumns;
      stats.truncated = true;
    }

    const out = allocate(base, outCount);

    for (const span of timeline.spans) {
      if (!(span.duration > 0)) continue;
      const startIdx = bucketIndexOf(span.projectStart, bucketSeconds);
      const endIdx = Math.min(outCount - 1, bucketEndIndex(span.projectStart + span.duration, bucketSeconds));
      const count = Math.max(0, endIdx - startIdx + 1);
      if (count <= 0) continue;

      if (span.kind === 'silence') {
        // Silence is written, not merely marked: a neighbouring span may share a
        // boundary column, and stale audio must never survive a Clear.
        for (let i = 0; i < count; i++) {
          const j = startIdx + i;
          if (j >= outCount) break;
          out.peaks[j] = 0;
          out.peaksL[j] = 0;
          out.peaksR[j] = 0;
          out.lowEnergy[j] = 0;
          out.midEnergy[j] = 0;
          out.highEnergy[j] = 0;
          if (out.whiteness) out.whiteness[j] = 0;
          if (out.luminance) out.luminance[j] = 0;
          if (out.backPeaks) out.backPeaks[j] = 0;
          if (out.frontPeaks) out.frontPeaks[j] = 0;
          out.provenance[j] = ColumnSource.SILENCE;
        }
        continue;
      }

      if (span.kind === 'original') {
        if (!base) {
          for (let i = 0; i < count; i++) out.provenance[startIdx + i] = ColumnSource.MISSING;
          stats.spansMissing += 1;
          continue;
        }
        const srcStartIdx = bucketIndexOf(span.sourceStart, bucketSeconds);
        const code =
          Math.abs(span.projectStart - span.sourceStart) < TIME_EPS
            ? ColumnSource.ANLZ
            : ColumnSource.ANLZ_RETIMED;
        const copied = blockCopy(
          out,
          base,
          startIdx,
          srcStartIdx,
          count,
          code,
          bucketSeconds,
          span.projectStart,
          span.sourceStart
        );
        if (!copied) {
          fillFromVariant(out, startIdx, count, base, bucketSeconds, span.sourceStart, bucketSeconds, code, (i) =>
            Math.max(0, span.sourceStart + (startIdx + i) * bucketSeconds - span.projectStart)
          );
        }
        continue;
      }

      // Clip material: prefer the stored columns of the clip's own source track.
      const verbatimAllowed = spanAllowsVerbatimClipColumns(span);
      const resolved = input.clipResolver(span);
      const clipVariant =
        verbatimAllowed && resolved && resolved.sourceVariants.length > 0 ? resolved.sourceVariants[0] : null;
      const clipSourceDuration = resolved ? resolved.sourceDuration : 0;

      if (clipVariant && clipSourceDuration > 0) {
        const clipBucketSeconds =
          clipVariant.secPerBucket && clipVariant.secPerBucket > 0
            ? clipVariant.secPerBucket
            : clipSourceDuration / clipVariant.length;
        const written = fillFromVariant(
          out,
          startIdx,
          count,
          clipVariant,
          clipBucketSeconds,
          0,
          bucketSeconds,
          ColumnSource.CLIP_ANLZ,
          (i) => sourceTrackTimeOf(span, (startIdx + i) * bucketSeconds - span.projectStart)
        );
        for (let i = written; i < count; i++) {
          const j = startIdx + i;
          if (j < outCount) out.provenance[j] = ColumnSource.MISSING;
        }
        if (written > 0) stats.spansVerbatimClip += 1;
        else stats.spansMissing += 1;
        continue;
      }

      const channels = resolved?.playChannels ?? null;
      if (channels) {
        writeComputed(
          out,
          startIdx,
          count,
          channels,
          span.sourceStart,
          span.sourceStart + span.duration,
          bucketSeconds,
          analyzer,
          ColumnSource.COMPUTED
        );
        stats.spansComputed += 1;
        continue;
      }

      for (let i = 0; i < count; i++) out.provenance[startIdx + i] = ColumnSource.MISSING;
      stats.spansMissing += 1;
    }

    // Overdub overlays are OVERLAID, not picked: both column sets are real
    // (stored ANLZ of the clip source when available, otherwise measured from
    // the clip audio) and are summed onto the layout columns, then limited to the
    // normalized 0..1 range. The previous per-column maximum simply discarded the
    // quieter layer, so the picture did not match the audible mix. Labelled MIX —
    // never passed off as pure stored ANLZ data.
    for (const od of timeline.overdubs) {
      if (!(od.duration > 0)) continue;
      const span = overdubAsSpan(od);
      const startIdx = bucketIndexOf(od.projectStart, bucketSeconds);
      const endIdx = Math.min(
        outCount - 1,
        bucketEndIndex(od.projectStart + od.duration, bucketSeconds)
      );
      const count = Math.max(0, endIdx - startIdx + 1);
      if (count <= 0) continue;
      const resolved = input.clipResolver(span);
      const overlayVariant =
        spanAllowsVerbatimClipColumns(span) && resolved && resolved.sourceVariants.length > 0
          ? resolved.sourceVariants[0]
          : null;

      if (overlayVariant) {
        const clipBucketSeconds =
          overlayVariant.secPerBucket && overlayVariant.secPerBucket > 0
            ? overlayVariant.secPerBucket
            : (resolved?.sourceDuration ?? 0) / Math.max(1, overlayVariant.length);
        const tmp = allocate(overlayVariant, count);
        const written = fillFromVariant(
          tmp,
          0,
          count,
          overlayVariant,
          clipBucketSeconds,
          0,
          bucketSeconds,
          ColumnSource.CLIP_ANLZ,
          (i) => sourceTrackTimeOf(span, (startIdx + i) * bucketSeconds - span.projectStart)
        );
        for (let i = 0; i < written; i++) {
          overlayColumns(out, startIdx + i, tmp, i, span.gain);
          stats.mixStoredColumns += 1;
          if (out.provenance[startIdx + i] !== ColumnSource.SILENCE) {
            out.provenance[startIdx + i] = ColumnSource.MIX;
          }
        }
        continue;
      }

      const channels = resolved?.playChannels ?? null;
      if (!channels) continue;
      const usable = Math.min(span.duration, channels.right.length / channels.sampleRate - span.sourceStart);
      if (!(usable > 0)) continue;
      const analysis = analyzer(
        channels,
        span.sourceStart,
        span.sourceStart + usable,
        bucketSeconds
      );
      const n = Math.min(count, analysis.peaks.length);
      const overlayGain = span.gain * 0.85;
      for (let i = 0; i < n; i++) {
        const j = startIdx + i;
        if (j >= out.peaks.length) break;
        overlayColumns(
          out,
          j,
          {
            peaks: analysis.peaks,
            peaksL: analysis.peaksL ?? analysis.peaks,
            peaksR: analysis.peaksR ?? analysis.peaks,
            lowEnergy: analysis.lowEnergy,
            midEnergy: analysis.midEnergy,
            highEnergy: analysis.highEnergy,
          } as unknown as ColumnArrays,
          i,
          overlayGain
        );
        stats.mixComputedColumns += 1;
        if (out.provenance[j] !== ColumnSource.SILENCE) out.provenance[j] = ColumnSource.MIX;
      }
    }

    let verbatim = 0;
    let retimed = 0;
    let clip = 0;
    let computed = 0;
    let mix = 0;
    let silence = 0;
    let missing = 0;
    for (let j = 0; j < outCount; j++) {
      switch (out.provenance[j]) {
        case ColumnSource.ANLZ:
          verbatim += 1;
          break;
        case ColumnSource.ANLZ_RETIMED:
          retimed += 1;
          break;
        case ColumnSource.CLIP_ANLZ:
          clip += 1;
          break;
        case ColumnSource.COMPUTED:
          computed += 1;
          break;
        case ColumnSource.MIX:
          mix += 1;
          break;
        case ColumnSource.SILENCE:
          silence += 1;
          break;
        default:
          missing += 1;
      }
    }

    outputs.push({
      length: outCount,
      peaks: out.peaks,
      peaksL: out.peaksL,
      peaksR: out.peaksR,
      lowEnergy: out.lowEnergy,
      midEnergy: out.midEnergy,
      highEnergy: out.highEnergy,
      ...(out.whiteness ? { whiteness: out.whiteness } : {}),
      ...(out.luminance ? { luminance: out.luminance } : {}),
      ...(out.backPeaks ? { backPeaks: out.backPeaks } : {}),
      ...(out.frontPeaks ? { frontPeaks: out.frontPeaks } : {}),
      provenance: out.provenance,
      isEditComposite: true,
      origin: DataOrigin.USER_EDIT,
      secPerBucket: bucketSeconds,
      samplesPerBucket: Math.max(1, Math.round(bucketSeconds * sampleRate)),
      // The base tag is kept so the documented color rule (mono blue vs. band
      // palette) still applies to the copied columns; `isEditComposite` and
      // `provenance` state openly which columns are no longer pure ANLZ.
      sourceTag: base?.sourceTag,
      label: base ? `${base.sourceTag ?? 'ANLZ'} → EDIT` : 'BERECHNET (EDIT)',
    });

    stats.variants = outputs.length;
    if (outputs.length === 1) {
      stats.bucketSeconds = bucketSeconds;
      stats.columns = outCount;
      stats.verbatimColumns = verbatim;
      stats.retimedColumns = retimed;
      stats.clipColumns = clip;
      stats.computedColumns = computed;
      stats.mixColumns = mix;
      stats.silenceColumns = silence;
      stats.missingColumns = missing;
    }
  }

  return { variants: outputs, stats };
}

/** Counts provenance codes of a variant (legend in the UI, assertions in tests). */
export function countProvenance(provenance: Uint8Array | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!provenance) return counts;
  for (let i = 0; i < provenance.length; i++) {
    const label = COLUMN_SOURCE_LABELS[provenance[i]] ?? String(provenance[i]);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

/** One-line, honest status of an edit composite for the waveform footer. */
export function describeEditWaveform(stats: EditWaveformStats, projectDurationSec: number): string {
  const stored = stats.verbatimColumns + stats.retimedColumns + stats.clipColumns;
  const parts: string[] = [];
  if (stored > 0) {
    parts.push(
      `${stored} Spalten ANLZ übernommen (${stats.verbatimColumns} unverändert, ${stats.retimedColumns} neu eingesetzt${
        stats.clipColumns > 0 ? `, ${stats.clipColumns} aus Clip-Quelle` : ''
      })`
    );
  }
  if (stats.computedColumns > 0) parts.push(`${stats.computedColumns} Spalten aus Edit-Audio berechnet`);
  if (stats.mixColumns > 0) {
    const stored = stats.mixStoredColumns ?? 0;
    const measured = stats.mixComputedColumns ?? 0;
    const how: string[] = [];
    if (stored > 0) how.push(`${stored} aus gespeicherten Spalten überlagert`);
    if (measured > 0) how.push(`${measured} Overlay aus Edit-Audio gemessen`);
    parts.push(`${stats.mixColumns} Spalten Overdub-Mix${how.length ? ` (${how.join(', ')})` : ''}`);
  }
  if (stats.silenceColumns > 0) parts.push(`${stats.silenceColumns} Spalten Stille`);
  if (stats.missingColumns > 0) parts.push(`${stats.missingColumns} Spalten ohne Daten (nicht erfunden)`);
  parts.push(`Projekt ${projectDurationSec.toFixed(3)}s`);
  return parts.join(' • ');
}
