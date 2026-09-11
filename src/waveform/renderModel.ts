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

export function rgbCss(c: Rgb): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

// ---------------------------------------------------------------------------
// Documented visualizations (Deep Symmetry / crate-digger ANLZ spec). The
// renderers only apply these mappings to the stored values — nothing is
// recombined or invented. Pinned by tests/render-look.test.ts.
// ---------------------------------------------------------------------------

/** Blue waveform (PWAV/PWV2/PWV3): whiteness 0 = darkest blue … 1 = near white. */
export const MONO_BLUE_DARK: Rgb = { r: 0, g: 0, b: 140 };
export const MONO_BLUE_WHITE: Rgb = { r: 225, g: 240, b: 255 };

export function monoBlueColor(whiteness: number): Rgb {
  const t = Math.min(1, Math.max(0, whiteness));
  return {
    r: Math.round(MONO_BLUE_DARK.r + (MONO_BLUE_WHITE.r - MONO_BLUE_DARK.r) * t),
    g: Math.round(MONO_BLUE_DARK.g + (MONO_BLUE_WHITE.g - MONO_BLUE_DARK.g) * t),
    b: Math.round(MONO_BLUE_DARK.b + (MONO_BLUE_WHITE.b - MONO_BLUE_DARK.b) * t),
  };
}

/** PWV5 color detail: the stored red/green/blue components ARE the column color. */
export function rgbColumnColor(r: number, g: number, b: number): Rgb {
  const to255 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return { r: to255(r), g: to255(g), b: to255(b) };
}

/** PWV4 color preview: two-tone columns, back = rgb·luminance, front brighter. */
export const PWV4_FRONT_BOOST = 32 / 127;

export function pwv4BackColor(r: number, g: number, b: number, luminance: number): Rgb {
  const lum = Math.min(1, Math.max(0, luminance));
  return {
    r: Math.round(Math.min(1, r) * lum * 255),
    g: Math.round(Math.min(1, g) * lum * 255),
    b: Math.round(Math.min(1, b) * lum * 255),
  };
}

export function pwv4FrontColor(r: number, g: number, b: number, luminance: number): Rgb {
  const lum = Math.min(1, Math.max(0, luminance));
  const boosted = (v: number) => Math.min(1, Math.min(1, v) * lum + PWV4_FRONT_BOOST);
  return {
    r: Math.round(boosted(r) * 255),
    g: Math.round(boosted(g) * 255),
    b: Math.round(boosted(b) * 255),
  };
}

/**
 * 3-band waveform (PWV6/PWV7): documented colors — lows dark blue, mid-range
 * amber, highs white — drawn on the same axis, highs last. The mid band is
 * translucent so the low+mid overlap reads brown, as in the original.
 */
export const THREE_BAND_LOW: Rgb = { r: 0, g: 0, b: 190 };
export const THREE_BAND_MID: Rgb = { r: 255, g: 176, b: 0 };
export const THREE_BAND_HIGH: Rgb = { r: 255, g: 255, b: 255 };
export const THREE_BAND_MID_ALPHA = 0.75;

export interface BandLayer {
  color: Rgb;
  alpha: number;
  /** Half height of the centered bar in px; 0 = silent, nothing drawn. */
  halfHeight: number;
}

export function threeBandLayers(
  low: number,
  mid: number,
  high: number,
  maxHalfH: number
): BandLayer[] {
  const scale = (v: number) => (v > 0 ? Math.max(1, Math.min(1, v) * maxHalfH) : 0);
  return [
    { color: THREE_BAND_LOW, alpha: 1, halfHeight: scale(low) },
    { color: THREE_BAND_MID, alpha: THREE_BAND_MID_ALPHA, halfHeight: scale(mid) },
    { color: THREE_BAND_HIGH, alpha: 1, halfHeight: scale(high) },
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
