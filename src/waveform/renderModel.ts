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
