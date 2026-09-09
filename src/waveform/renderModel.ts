/**
 * @license
 * Pure render-model helpers for the waveform views (no React, no canvas).
 *
 * Kept free of any view dependency so the zoom/variant and beat-window rules
 * stay unit-testable: renderers must pick genuine ANLZ data, never synthesize
 * it. Covered by tests/waveform-variants.test.ts.
 */

import { BeatNode } from '../types/rekordbox';

/** First index with beats[i].time >= time (beat nodes are time-ordered). */
export function beatIndexAtOrAfter(beats: BeatNode[], time: number): number {
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface VisibleBeat {
  time: number;
  isBar: boolean;
  barNumber: number;
  /** True for uniform tail continuations appended after the last verbatim beat. */
  tail: boolean;
}

/**
 * Collects the beat nodes inside [winStart, winEnd] for rendering, carrying
 * the tail provenance flag through so views can distinguish verbatim Rekordbox
 * beats from uniform continuations. Nodes outside the window are skipped via
 * binary search; collection stops at `cap` entries.
 */
export function collectVisibleBeats(
  beats: BeatNode[],
  winStart: number,
  winEnd: number,
  cap: number = 50000
): VisibleBeat[] {
  const visible: VisibleBeat[] = [];
  let idx = Math.max(0, beatIndexAtOrAfter(beats, winStart) - 1);
  for (; idx < beats.length; idx++) {
    const node = beats[idx];
    if (node.time > winEnd) break;
    if (node.time < winStart) continue;
    visible.push({
      time: node.time,
      isBar: node.isBarStart,
      barNumber: node.barNumber,
      tail: node.tailExtended === true,
    });
    if (visible.length >= cap) break;
  }
  return visible;
}

/**
 * Selects the ANLZ waveform variant that matches the current zoom. Every
 * variant spans the full track, so the visible bucket count of variant `i` is
 * `bucketCounts[i] * viewDurationSec / trackDurationSec`.
 *
 * Rule: use the coarsest variant that still resolves every pixel column
 * (visible buckets >= widthPx); when no variant resolves the view (deep zoom),
 * use the finest available instead of inventing detail. Returns the index into
 * `bucketCounts`, or -1 when there is no candidate.
 */
export function selectWaveformVariant(
  bucketCounts: number[],
  viewDurationSec: number,
  trackDurationSec: number,
  widthPx: number
): number {
  if (bucketCounts.length === 0) return -1;
  if (!(widthPx > 0) || !(viewDurationSec > 0) || !(trackDurationSec > 0)) {
    return indexOfMax(bucketCounts);
  }
  const fraction = Math.min(1, viewDurationSec / trackDurationSec);
  let bestSufficient = -1;
  for (let i = 0; i < bucketCounts.length; i++) {
    if (bucketCounts[i] * fraction >= widthPx) {
      if (bestSufficient === -1 || bucketCounts[i] < bucketCounts[bestSufficient]) {
        bestSufficient = i;
      }
    }
  }
  return bestSufficient === -1 ? indexOfMax(bucketCounts) : bestSufficient;
}

function indexOfMax(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[best]) best = i;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Authentic visual lock (reference/01–03): the renderers must visualize the
// stored ANLZ band values verbatim — no recombination, no invented spectral
// formulas. Pinned by tests/render-look.test.ts.
// ---------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Authentic Rekordbox band colors: low = red, mid = green, high = blue. */
export const BAND_COLOR_LOW: Rgb = { r: 255, g: 0, b: 0 };
export const BAND_COLOR_MID: Rgb = { r: 0, g: 230, b: 0 };
export const BAND_COLOR_HIGH: Rgb = { r: 0, g: 90, b: 255 };

/** Classic Rekordbox preview blue for mono (PWAV/PWV2/PWV3) variants. */
export const MONO_PREVIEW_BLUE = '#00a2ff';
export const MONO_PREVIEW_CORE = '#b3e5fc';

export interface BandBar {
  color: Rgb;
  /** Half height of the centered bar in px; 0 = band silent, nothing drawn. */
  halfHeight: number;
}

/**
 * Verbatim pass-through visualization of decoded ANLZ band values: each
 * stored band value becomes one centered bar in its authentic band color,
 * drawn in low → mid → high order so the high band forms the blue core that
 * is visible inside loud red columns (reference 01/02). The values are used
 * exactly as stored; only a 1 px minimum keeps non-silent bands visible.
 */
export function bandColumnBars(
  low: number,
  mid: number,
  high: number,
  maxHalfH: number
): BandBar[] {
  const scale = (v: number) =>
    v > 0 ? Math.max(1, Math.min(1, v) * maxHalfH) : 0;
  return [
    { color: BAND_COLOR_LOW, halfHeight: scale(low) },
    { color: BAND_COLOR_MID, halfHeight: scale(mid) },
    { color: BAND_COLOR_HIGH, halfHeight: scale(high) },
  ];
}

/**
 * Comb look from the reference: once a column slot is wider than 2 px a 1 px
 * black gap separates neighbouring columns; narrow columns stay solid.
 */
export function columnDrawWidth(slotWidth: number): number {
  if (!(slotWidth > 0)) return 1;
  if (slotWidth <= 2) return slotWidth;
  return Math.max(1, slotWidth - 1);
}

/** Rekordbox shades alternate bars slightly lighter behind the waveform. */
export function isBarShaded(barNumber: number): boolean {
  return barNumber % 2 === 0;
}

/** Background tone painted behind shaded (even) bars. */
export const BAR_SHADE_FILL = '#101117';

// ---------------------------------------------------------------------------
// Honest preview (no ANLZ assigned): visualize ONLY the imported beatgrid
// structure — bar/beat columns with fixed heights. No envelopes, no invented
// audio, no analyzeAudioBuffer. Pinned by tests/render-look.test.ts (R6).
// ---------------------------------------------------------------------------

export const PREVIEW_ALPHA = 0.55;
export const PREVIEW_BAR_FRACTION = 0.6;
export const PREVIEW_BEAT_FRACTION = 0.35;

/** Preview contour height purely from the imported bar/beat structure. */
export function previewBeatHalfHeight(isBar: boolean, maxHalfH: number): number {
  return (isBar ? PREVIEW_BAR_FRACTION : PREVIEW_BEAT_FRACTION) * maxHalfH;
}

/**
 * Peak-hold downsampling for the overview: takes the stored values verbatim
 * (per-band maximum inside the column) — no averaging, no smoothing, nothing
 * computed beyond selecting stored samples. Pinned by R7.
 */
export function peakHoldColumn(
  peaks: Float32Array,
  lowEnergy: Float32Array,
  midEnergy: Float32Array,
  highEnergy: Float32Array,
  start: number,
  end: number
): { peak: number; low: number; mid: number; high: number } {
  let peak = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  for (let b = start; b < end; b++) {
    const p = peaks[b] || 0;
    if (p > peak) peak = p;
    const l = lowEnergy[b] || 0;
    if (l > low) low = l;
    const m = midEnergy[b] || 0;
    if (m > mid) mid = m;
    const h = highEnergy[b] || 0;
    if (h > high) high = h;
  }
  return { peak, low, mid, high };
}
