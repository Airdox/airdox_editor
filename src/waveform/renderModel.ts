/**
 * @license
 * Pure render-model helpers for the waveform views (no React, no canvas).
 *
 * Kept free of any view dependency so the zoom/variant and beat-window rules
 * stay unit-testable: renderers must pick genuine ANLZ data, never synthesize
 * it. Covered by tests/waveform-variants.test.ts.
 */

import { BeatGrid, BeatNode, DataOrigin, WaveformAnalysisData } from '../types/rekordbox';

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

/** Structural view of a TrackModel that the renderer selection needs. */
export interface RenderTrackWaveformSource {
  duration: number;
  analysis?: WaveformAnalysisData | null;
  analysisVariants?: WaveformAnalysisData[];
}

/**
 * Resolves the genuine waveform a renderer must draw for the current zoom.
 *
 * Only real data is ever returned: the ANLZ variants attached to the track
 * (plus the plain `analysis` variant). When the track carries no Rekordbox
 * waveform at all this returns null and the renderer shows the honest empty
 * state — it never synthesizes columns from BPM/beatgrid.
 */
export function selectTrackWaveform(
  track: RenderTrackWaveformSource,
  viewDurationSec: number,
  widthPx: number
): WaveformAnalysisData | null {
  const candidates =
    track.analysisVariants && track.analysisVariants.length > 0
      ? track.analysisVariants
      : track.analysis
        ? [track.analysis]
        : [];
  if (candidates.length === 0) return null;
  const index = selectWaveformVariant(
    candidates.map((candidate) => candidate.length),
    viewDurationSec,
    track.duration,
    widthPx
  );
  return index >= 0 ? candidates[index] : null;
}

/**
 * Human-readable missing-waveform status (honest empty state). Distinguishes
 * Rekordbox-sourced tracks (their waveform may only come from ANLZ, so a
 * missing waveform means "no Rekordbox analysis data found") from local
 * tracks without an analysis.
 */
export function waveformMissingNotice(track: { origin?: DataOrigin }): {
  title: string;
  hint: string;
} {
  const origin = track.origin;
  const isRekordbox =
    origin === DataOrigin.REKORDBOX_XML ||
    origin === DataOrigin.REKORDBOX_DB ||
    origin === DataOrigin.REKORDBOX_ANLZ;
  return isRekordbox
    ? {
        title: 'Keine Rekordbox-Waveformdaten vorhanden.',
        hint: 'Keine Rekordbox-Analysedaten gefunden – ANLZ über DATA zuordnen oder AnalysisDataPath prüfen.',
      }
    : {
        title: 'Keine Waveformdaten vorhanden.',
        hint: 'Für diesen Track existiert keine Wellenform-Analyse.',
      };
}

export interface GridRenderSelection {
  beats: VisibleBeat[];
  /** True only when no stored beat nodes existed (documented uniform case). */
  uniformFallback: boolean;
}

/**
 * Resolves the beat lines a renderer must draw for a view window.
 *
 * Original Rekordbox beat nodes (PQTZ / persisted dense grid) have priority
 * and are used verbatim — their exact times are never re-quantized. The
 * uniform firstBeat+bpm reconstruction runs ONLY for grids without stored
 * nodes (the documented compact-entry case) and reports itself through
 * `uniformFallback` so views can mark the difference.
 */
export function selectGridRenderBeats(
  beatGrid: Pick<BeatGrid, 'beats' | 'firstBeat' | 'bpm' | 'meter'>,
  winStart: number,
  winEnd: number,
  cap: number = 50000
): GridRenderSelection {
  if (beatGrid.beats && beatGrid.beats.length > 0) {
    return {
      beats: collectVisibleBeats(beatGrid.beats, winStart, winEnd, cap),
      uniformFallback: false,
    };
  }
  const bpm = beatGrid.bpm > 0 ? beatGrid.bpm : 130;
  const meter = beatGrid.meter > 0 ? beatGrid.meter : 4;
  const secondsPerBeat = 60.0 / bpm;
  const startBeat = Math.max(0, Math.floor((winStart - beatGrid.firstBeat) / secondsPerBeat));
  const endBeat = Math.ceil((winEnd - beatGrid.firstBeat) / secondsPerBeat);
  const beats: VisibleBeat[] = [];
  for (let b = startBeat; b <= endBeat; b++) {
    beats.push({
      time: beatGrid.firstBeat + b * secondsPerBeat,
      isBar: b % meter === 0,
      barNumber: Math.floor(b / meter) + 1,
      tail: false,
    });
    if (beats.length >= cap) break;
  }
  return { beats, uniformFallback: true };
}
