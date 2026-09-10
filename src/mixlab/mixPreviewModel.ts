/**
 * @license
 * Mix Lab preview model (Stage 2 vertical slice) — pure functions, no React,
 * no canvas, no DOM.
 *
 * DATA-INTEGRITY CONTRACT (von A bis Z):
 *  - Read-only: every function here only reads TrackModel / PaletteClip
 *    values. Nothing is mutated, nothing is written to the project, and no
 *    Rekordbox data (ANLZ/PPTH/PWV, DB, XML, audio) is added, removed, or
 *    altered.
 *  - No synthesis: waveforms are resolved exclusively through
 *    `selectTrackWaveform` (genuine ANLZ variants only). A missing waveform
 *    stays null and is reported as an honest issue — never invented.
 *  - Beat times are used verbatim from the stored ANLZ/PQTZ grid; the
 *    uniform firstBeat+bpm reconstruction runs only for grids without stored
 *    nodes and is disclosed through issues (same rule as the renderer).
 *  - The Mix Lab has NO apply path: the result describes a preview only.
 */

import {
  BeatNode,
  DataOrigin,
  PaletteClip,
  TrackModel,
  WaveformAnalysisData,
} from '../types/rekordbox';
import {
  VisibleBeat,
  beatIndexAtOrAfter,
  collectVisibleBeats,
  selectTrackWaveform,
} from '../waveform/renderModel';

/** Preview DSP crossfade curves (applied to loaded in-memory buffers only). */
export type MixCurve = 'LINEAR' | 'EQUAL_POWER' | 'SLOW_IN_FAST_OUT' | 'FAST_IN_SLOW_OUT';

export const MIX_CURVES: { id: MixCurve; label: string }[] = [
  { id: 'LINEAR', label: 'Linear' },
  { id: 'EQUAL_POWER', label: 'Equal Power (Kosinus)' },
  { id: 'SLOW_IN_FAST_OUT', label: 'Slow In / Fast Out' },
  { id: 'FAST_IN_SLOW_OUT', label: 'Fast In / Slow Out' },
];

export const CROSSFADE_BEAT_OPTIONS = [0.5, 1, 2, 4, 8, 16] as const;

/** Beat-grid snapping modes for the transition anchor. */
export type MixSnapMode = 'OFF' | 'BEAT' | 'BAR';

/** One Mix Lab slot: a full track or a palette clip (read-only reference). */
export interface MixSlotRef {
  kind: 'TRACK' | 'CLIP';
  /** Track id; for CLIP slots this is the clip's source track. */
  trackId: string;
  clipId?: string;
}

export interface MixPreviewSettings {
  slotA: MixSlotRef;
  slotB: MixSlotRef;
  curve: MixCurve;
  /** Crossfade length in beats of track A (outgoing tempo). */
  crossfadeBeats: number;
  beatSnap: MixSnapMode;
  /** Requested transition start on A's own timeline (seconds). */
  transitionPosition: number;
}

export interface MixBeatAnchor {
  /** Mix-timeline time where the crossfade actually starts (verbatim beat time). */
  time: number;
  barNumber: number;
  beatInBar: number;
  /** True when the anchor comes from a uniform tail continuation (not a verbatim PQTZ beat). */
  tailExtended: boolean;
  /** True when the requested position was moved to the anchor. */
  snapped: boolean;
  /** True when the anchor came from the documented uniform fallback grid. */
  uniformFallback: boolean;
}

export interface MixDropTarget {
  /** Mix-timeline time where B starts playing. */
  startOnMix: number;
  /** Position inside B's own timeline from which B starts playing. */
  offsetIntoB: number;
  /** Where B's first bar lands in A's bar/beat coordinates. */
  landsOnA: { barNumber: number; beatInBar: number } | null;
  /** B's first `ghostBars` bars on the mix timeline (dashed ghost preview). */
  ghostOnMix: { start: number; end: number } | null;
  /** True when the sync offset was clamped (e.g. clip range). */
  clamped: boolean;
}

export interface MixProvenanceInfo {
  origin: DataOrigin | null;
  sourceTag: string | null;
}

export interface MixPreviewResult {
  issues: string[];
  trackA: TrackModel;
  trackB: TrackModel;
  clipB: PaletteClip | null;
  curve: MixCurve;
  crossfadeBeats: number;
  crossfadeSeconds: number;
  /** Beats of A played before the crossfade starts (preview lead-in). */
  leadInBeats: number;
  anchor: MixBeatAnchor;
  drop: MixDropTarget;
  bpmA: number;
  bpmB: number;
  bpmDelta: number;
  bpmDriftNote: string | null;
  /** Crossfade envelope sampled for drawing (A gain / B gain, N points each). */
  envelopeA: number[];
  envelopeB: number[];
  /** Genuine ANLZ waveforms (null = honest empty state, never synthesized). */
  aWaveform: WaveformAnalysisData | null;
  bWaveform: WaveformAnalysisData | null;
  aProvenance: MixProvenanceInfo;
  bProvenance: MixProvenanceInfo;
  /** Verbatim beat lines inside the preview window. */
  aBeats: VisibleBeat[];
  bBeats: VisibleBeat[];
  /** Preview window on the mix timeline (= A's timeline), in seconds. */
  window: { start: number; end: number };
}

/** Preview lead-in / tail in beats of A. */
export const LEAD_IN_BEATS = 4;
export const TAIL_BEATS = 8;
/** B's ghost drop region spans this many B-bars. */
export const GHOST_BARS = 4;
/** Envelope resolution for drawing. */
export const ENVELOPE_SAMPLES = 96;
/** Canvas width assumed for ANLZ variant selection (px). */
export const PREVIEW_WIDTH_PX = 1400;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Crossfade gains at normalized position t ∈ [0,1].
 * All curves satisfy a(0)=1, b(0)=0, a(1)=0, b(1)=1 and are continuous.
 */
export function crossfadeGainsAt(curve: MixCurve, t: number): { a: number; b: number } {
  const x = clamp(t, 0, 1);
  switch (curve) {
    case 'EQUAL_POWER':
      return { a: Math.cos((Math.PI / 2) * x), b: Math.sin((Math.PI / 2) * x) };
    case 'SLOW_IN_FAST_OUT':
      return { a: 1 - x * x, b: x * x };
    case 'FAST_IN_SLOW_OUT':
      return { a: 1 - Math.sqrt(x), b: Math.sqrt(x) };
    case 'LINEAR':
    default:
      return { a: 1 - x, b: x };
  }
}

/** Samples the crossfade envelope for drawing (N+1 points per gain). */
export function sampleCrossfadeEnvelope(
  curve: MixCurve,
  samples: number
): { a: number[]; b: number[] } {
  const count = Math.max(2, Math.floor(samples));
  const a: number[] = new Array(count + 1);
  const b: number[] = new Array(count + 1);
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const g = crossfadeGainsAt(curve, t);
    a[i] = g.a;
    b[i] = g.b;
  }
  return { a, b };
}

interface ResolvedSlot {
  track: TrackModel;
  clip: PaletteClip | null;
}

function resolveSlot(
  ref: MixSlotRef,
  tracks: TrackModel[],
  clips: PaletteClip[]
): ResolvedSlot | null {
  const track = tracks.find((t) => t.id === ref.trackId);
  if (!track) return null;
  if (ref.kind === 'CLIP') {
    const clip = clips.find((c) => c.id === ref.clipId);
    if (!clip) return null;
    return { track, clip };
  }
  return { track, clip: null };
}

/** First bar-start beat of a grid, or the first node; null when empty. */
function firstBarStartOf(beats: { time: number; isBarStart: boolean }[]): number | null {
  if (beats.length === 0) return null;
  const barStart = beats.find((b) => b.isBarStart);
  return (barStart ? barStart.time : beats[0].time) ?? null;
}

interface UniformGrid {
  firstBeat: number;
  secondsPerBeat: number;
  meter: number;
}

/**
 * Resolves the beat grid to use for anchor math. Stored ANLZ/PQTZ nodes have
 * priority (verbatim times); the uniform firstBeat+bpm reconstruction runs
 * ONLY for grids without stored nodes and is reported by the caller.
 */
function gridFor(track: TrackModel, fallbackBpm: number): { nodes: BeatNode[]; uniform: UniformGrid; uniformFallback: boolean } {
  const grid = track.beatGrid;
  const bpm = grid && grid.bpm > 0 ? grid.bpm : fallbackBpm;
  const meter = grid && grid.meter > 0 ? grid.meter : 4;
  const firstBeat = grid ? grid.firstBeat : 0;
  const uniform: UniformGrid = {
    firstBeat,
    secondsPerBeat: 60 / bpm,
    meter,
  };
  const nodes: BeatNode[] = grid && grid.beats && grid.beats.length > 0 ? grid.beats : [];
  return { nodes, uniform, uniformFallback: nodes.length === 0 };
}

/**
 * Computes the full Mix Lab preview.
 *
 * Read-only contract: inputs are never mutated; the result is a pure
 * description of a crossfade preview and cannot be applied anywhere.
 */
export function computeMixPreview(
  settings: MixPreviewSettings,
  tracks: TrackModel[],
  clips: PaletteClip[]
): MixPreviewResult | null {
  const resolvedA = resolveSlot(settings.slotA, tracks, clips);
  const resolvedB = resolveSlot(settings.slotB, tracks, clips);
  if (!resolvedA || !resolvedB) return null;

  const trackA = resolvedA.track;
  const trackB = resolvedB.track;
  const clipB = resolvedB.clip;
  const issues: string[] = [];

  const bpmA = trackA.bpm > 0 ? trackA.bpm : 120;
  const bpmB = trackB.bpm > 0 ? trackB.bpm : bpmA;
  if (trackA.bpm <= 0) issues.push('A: BPM unbekannt – Vorschau rechnet mit 120 BPM (deklarierter Fallback).');
  if (trackB.bpm <= 0) issues.push('B: BPM unbekannt – Vorschau rechnet mit A-BPM (deklarierter Fallback).');

  const spbA = 60 / bpmA;
  const spbB = 60 / bpmB;
  const crossfadeSeconds = Math.max(0.05, settings.crossfadeBeats * spbA);

  // ── Anchor on A (transition start) ───────────────────────────────────────
  const gridA = gridFor(trackA, 120);
  if (gridA.uniformFallback) {
    issues.push('A: kein verbatim ANLZ-Beatgrid – Vorschau nutzt dokumentiertes Uniform-Grid (firstBeat+bpm).');
  }
  const maxTransition = Math.max(0, trackA.duration - spbA * 2);
  const requested = clamp(settings.transitionPosition, 0, maxTransition);

  let anchorTime = requested;
  let anchorBar = 1;
  let anchorBeat = 1;
  let anchorTail = false;
  let anchorUniform = gridA.uniformFallback;

  const snapToUniform = (time: number, mode: MixSnapMode) => {
    // Strict "at or after" on the uniform grid (the only documented fallback).
    let beatIdx = Math.max(0, Math.ceil((time - gridA.uniform.firstBeat) / gridA.uniform.secondsPerBeat - 1e-9));
    if (mode === 'BAR') {
      beatIdx = Math.ceil(beatIdx / gridA.uniform.meter) * gridA.uniform.meter;
    }
    return {
      time: gridA.uniform.firstBeat + beatIdx * gridA.uniform.secondsPerBeat,
      barNumber: Math.floor(beatIdx / gridA.uniform.meter) + 1,
      beatInBar: (beatIdx % gridA.uniform.meter) + 1,
      tail: false,
    };
  };

  if (settings.beatSnap !== 'OFF') {
    if (gridA.nodes.length > 0) {
      let idx = beatIndexAtOrAfter(gridA.nodes, requested - 1e-9);
      if (settings.beatSnap === 'BAR') {
        while (idx < gridA.nodes.length && !gridA.nodes[idx].isBarStart) idx++;
        if (idx >= gridA.nodes.length) {
          issues.push('A: kein Bar-Anker nach der Position gefunden – letzter verbatim Beat verwendet.');
          idx = gridA.nodes.length - 1;
        }
      }
      const node = gridA.nodes[Math.min(idx, gridA.nodes.length - 1)];
      anchorTime = node.time;
      anchorBar = node.barNumber;
      anchorBeat = node.beatInBar;
      anchorTail = node.tailExtended === true;
      if (anchorTail) {
        issues.push('A: Anker-Beat stammt aus Uniform-Fortsetzung (kein verbatim PQTZ-Beat).');
      }
    } else {
      const snapped = snapToUniform(requested, settings.beatSnap);
      anchorTime = snapped.time;
      anchorBar = snapped.barNumber;
      anchorBeat = snapped.beatInBar;
    }
  } else {
    // No snap: keep the requested position; still report bar/beat info from the grid when available.
    if (gridA.nodes.length > 0) {
      const idx = beatIndexAtOrAfter(gridA.nodes, anchorTime);
      if (idx < gridA.nodes.length) {
        anchorBar = gridA.nodes[idx].barNumber;
        anchorBeat = gridA.nodes[idx].beatInBar;
        anchorTail = gridA.nodes[idx].tailExtended === true;
      }
    }
  }
  anchorTime = clamp(anchorTime, 0, maxTransition);
  const snapped = Math.abs(anchorTime - requested) > 1e-6;

  // ── Drop target for B (beat-synced, verbatim) ────────────────────────────
  const gridB = gridFor(trackB, bpmA);
  let offsetIntoB: number;
  let dropClamped = false;

  const bFirstBar = firstBarStartOf(gridB.nodes);
  if (gridB.nodes.length === 0) {
    issues.push('B: kein verbatim ANLZ-Beatgrid – Beat-Sync über Uniform-Grid (deklarierter Fallback).');
    offsetIntoB = Math.max(0, gridB.uniform.firstBeat);
  } else if (bFirstBar === null) {
    issues.push('B: kein Bar-Anfang im Beatgrid – Sync auf ersten verbatim Beat.');
    offsetIntoB = gridB.nodes[0].time;
  } else {
    offsetIntoB = bFirstBar;
  }

  // Palette clips only expose their source range.
  if (clipB) {
    const rangeStart = clipB.sourceStart;
    const rangeEnd = Math.max(rangeStart, clipB.sourceEnd);
    const needed = offsetIntoB;
    if (needed < rangeStart || needed > rangeEnd - spbB) {
      offsetIntoB = clamp(needed, rangeStart, Math.max(rangeStart, rangeEnd - spbB));
      dropClamped = true;
      issues.push(
        `B (Clip): Sync-Offset ${needed.toFixed(3)} s liegt außerhalb der Clip-Spanne (${rangeStart.toFixed(3)}–${rangeEnd.toFixed(3)} s) – geclampt, Sync nicht exakt.`
      );
    }
  }

  const startOnMix = anchorTime - offsetIntoB;
  const ghostStart = anchorTime; // B's bar start lands on the anchor
  let ghostEnd = anchorTime + GHOST_BARS * gridB.uniform.meter * spbB;
  // Prefer verbatim B bar times for the ghost region when available.
  const bBarStarts = gridB.nodes.filter((n) => n.isBarStart).map((n) => n.time);
  if (bBarStarts.length > GHOST_BARS) {
    const first = bBarStarts[0];
    const fifth = bBarStarts[GHOST_BARS];
    ghostEnd = anchorTime + (fifth - first);
  }
  ghostEnd = Math.min(ghostEnd, startOnMix + trackB.duration - offsetIntoB);

  const bpmDelta = bpmB - bpmA;
  const barsForDrift = 8;
  const driftSeconds = barsForDrift * gridB.uniform.meter * (spbA - spbB);
  const bpmDriftNote =
    Math.abs(bpmDelta) > 0.25
      ? `BPM-Abweichung A ${bpmA.toFixed(1)} / B ${bpmB.toFixed(1)} (Δ ${bpmDelta >= 0 ? '+' : ''}${bpmDelta.toFixed(1)}) – nach ${barsForDrift} Bars ≈ ${Math.abs(driftSeconds).toFixed(2)} s Drift (Vorschau rechnet ohne Tempo-Anpassung).`
      : null;

  // ── Preview window on the mix timeline (= A's timeline) ──────────────────
  const windowStart = Math.max(0, anchorTime - LEAD_IN_BEATS * spbA);
  const windowEnd = Math.min(trackA.duration, anchorTime + crossfadeSeconds + TAIL_BEATS * spbA);
  const windowDuration = Math.max(0.001, windowEnd - windowStart);

  // ── Genuine ANLZ waveforms only (null = honest empty state) ──────────────
  const aWaveform = selectTrackWaveform(trackA, windowDuration, PREVIEW_WIDTH_PX);
  const bWaveform = selectTrackWaveform(trackB, windowDuration, PREVIEW_WIDTH_PX);
  if (!aWaveform) issues.push('A: keine ANLZ-Waveform – Spur A wird ohne Waveform gezeichnet (keine Synthese).');
  if (!bWaveform) issues.push('B: keine ANLZ-Waveform – Spur B wird ohne Waveform gezeichnet (keine Synthese).');
  if (clipB) {
    issues.push(
      `B ist ein Palette-Clip (${clipB.name}, ${clipB.sourceStart.toFixed(3)}–${clipB.sourceEnd.toFixed(3)} s der Quelle) – Vorschau nutzt die Quell-Waveform über die Clip-Spanne.`
    );
  }

  // ── Verbatim beat lines for drawing ──────────────────────────────────────
  const aBeats = gridA.nodes.length > 0
    ? collectVisibleBeats(gridA.nodes, windowStart, windowEnd)
    : [];
  // B's beats inside its visible mix region (own-time [offsetIntoB, offsetIntoB + visible]).
  const bVisibleFrom = Math.max(0, startOnMix - windowStart + offsetIntoB);
  const bVisibleTo = bVisibleFrom + windowDuration;
  const bBeats = gridB.nodes.length > 0
    ? collectVisibleBeats(gridB.nodes, bVisibleFrom, bVisibleTo)
    : [];

  const { a: envelopeA, b: envelopeB } = sampleCrossfadeEnvelope(settings.curve, ENVELOPE_SAMPLES);

  return {
    issues,
    trackA,
    trackB,
    clipB,
    curve: settings.curve,
    crossfadeBeats: settings.crossfadeBeats,
    crossfadeSeconds,
    leadInBeats: LEAD_IN_BEATS,
    anchor: {
      time: anchorTime,
      barNumber: anchorBar,
      beatInBar: anchorBeat,
      tailExtended: anchorTail,
      snapped,
      uniformFallback: anchorUniform || (settings.beatSnap !== 'OFF' && gridA.uniformFallback),
    },
    drop: {
      startOnMix: Math.max(0, startOnMix),
      offsetIntoB,
      landsOnA: { barNumber: anchorBar, beatInBar: anchorBeat },
      ghostOnMix: { start: ghostStart, end: ghostEnd },
      clamped: dropClamped,
    },
    bpmA,
    bpmB,
    bpmDelta,
    bpmDriftNote,
    envelopeA,
    envelopeB,
    aWaveform,
    bWaveform,
    aProvenance: {
      origin: aWaveform ? aWaveform.origin : null,
      sourceTag: aWaveform?.sourceTag ?? null,
    },
    bProvenance: {
      origin: bWaveform ? bWaveform.origin : null,
      sourceTag: bWaveform?.sourceTag ?? null,
    },
    aBeats,
    bBeats,
    window: { start: windowStart, end: windowEnd },
  };
}

/** Formats seconds as m:ss.mmm (UI text only). */
export function formatMixTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const ss = s.toFixed(3).padStart(6, '0');
  return `${m}:${ss}`;
}

/** Human-readable drop-target description (UI text only, German). */
export function describeDropTarget(result: MixPreviewResult): string {
  const lines: string[] = [];
  lines.push(`B startet:    ${formatMixTime(result.drop.startOnMix)} (Mix-Timeline)`);
  lines.push(`B-Offset:     ${result.drop.offsetIntoB.toFixed(3)} s in B${result.drop.clamped ? ' (geclampt)' : ''}`);
  if (result.drop.landsOnA) {
    lines.push(`Landung:      Bar ${result.drop.landsOnA.barNumber} / Beat ${result.drop.landsOnA.beatInBar} von A`);
  }
  lines.push(
    `Crossfade:    ${result.crossfadeBeats} Beats (${result.crossfadeSeconds.toFixed(3)} s) · ${MIX_CURVES.find((c) => c.id === result.curve)?.label ?? result.curve}`
  );
  lines.push(`BPM:          A ${result.bpmA.toFixed(1)} / B ${result.bpmB.toFixed(1)}`);
  if (result.bpmDriftNote) lines.push(result.bpmDriftNote);
  lines.push(
    result.anchor.uniformFallback
      ? 'Sync:         Uniform-Grid (dok. Fallback)'
      : `Sync:         ${result.anchor.snapped ? 'Beat-Anker (ANLZ verbatim)' : 'Position frei'} · Bar ${result.anchor.barNumber}/Beat ${result.anchor.beatInBar}${result.anchor.tailExtended ? ' (Tail)' : ''}`
  );
  return lines.join('\n');
}
