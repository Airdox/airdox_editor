/**
 * @license
 * Non-destructive edit projection (pure — no React, no WebAudio, no canvas).
 *
 * Every structural edit (Insert / Replace / Delete / Clear / Overdub) is stored
 * as an `EditSegment` on the track. This module turns that append-only edit list
 * into the ONE authoritative project timeline: an ordered, gapless list of spans
 * where every span knows which source material it shows and how it was adapted.
 *
 * Why a projection instead of mutated buffers:
 * - audio rendering, waveform composition, playhead limits, cue/loop/phrase and
 *   beatgrid re-timing all read the SAME span list, so a follow-up state can
 *   never contradict the audio (the classic "waveform no longer matches" bug),
 * - Undo/Redo only has to restore the segment list (already snapshotted), the
 *   derived state is recomputed from it,
 * - untouched material keeps its exact source positions, which lets the
 *   waveform compositor copy already stored ANLZ columns verbatim instead of
 *   re-analysing the file (see ./editWaveform.ts).
 *
 * Segment semantics applied in list order (the order they were performed):
 * - ORIGINAL : the base layout (source material of the deck)
 * - INSERT   : split at `projectStart`, insert clip material, everything after
 *              shifts right by the inserted duration
 * - REPLACE  : split at `projectStart`/`+projectDuration`, drop that range, put
 *              the clip in (padded with silence when the clip is shorter, so the
 *              project duration of the window is preserved), shift the rest
 * - CUT      : remove `projectStart..+projectDuration`, everything after shifts left
 * - CLEAR    : same range, but kept on the timeline and muted (silence span)
 * - OVERDUB  : never changes the layout; recorded as a mix overlay
 */

import {
  BeatNode,
  CuePoint,
  DataOrigin,
  EditSegment,
  LoopPoint,
  PhraseSection,
} from '../types/rekordbox';

/** Floating point tolerance for all timeline boundaries. */
export const TIME_EPS = 1e-6;

export type SpanKind = 'original' | 'clip' | 'silence';

export interface TimelineSpan {
  id: string;
  kind: SpanKind;
  /** Start in seconds on the EDITED project timeline. */
  projectStart: number;
  /** Length in seconds on the project timeline. */
  duration: number;
  /**
   * 'original': seconds into the deck's pristine source audio/ANLZ analysis.
   * 'clip'    : seconds into the clip buffer that is played (already adapted).
   * 'silence' : always 0.
   */
  sourceStart: number;
  /** The `EditSegment` that produced this span ('base' for the untouched original). */
  segmentId: string;
  clipId?: string;
  /** Clip spans: identity of the material inside the SOURCE track. */
  sourceTrackId?: string;
  /** Clip spans: start (seconds) of the clip inside its source track. */
  sourceClipStart?: number;
  /** Applied tempo factor (dest BPM / clip BPM). 1.0 = timing untouched. */
  tempoRatio: number;
  /** Applied pitch shift in semitones. 0 = harmonic content untouched. */
  pitchShift: number;
  gain: number;
}

/** Non-destructive mix overlay (OVERDUB): drawn/rendered on top of the layout. */
export interface OverdubSpan {
  id: string;
  segmentId: string;
  projectStart: number;
  duration: number;
  sourceStart: number;
  clipId?: string;
  sourceTrackId?: string;
  sourceClipStart?: number;
  tempoRatio: number;
  pitchShift: number;
  gain: number;
}

export interface ProjectedTimeline {
  /** Ordered, gapless, covering `[0, duration)`. */
  spans: TimelineSpan[];
  /** Overdub overlays, ordered by project start. */
  overdubs: OverdubSpan[];
  /** Total project (edited) duration in seconds. */
  duration: number;
  /** True when the edit list is exactly the untouched original. */
  isIdentity: boolean;
  /** Number of segments that changed the layout (insert/replace/cut/clear). */
  structuralEdits: number;
}

export interface ProjectionInput {
  segments: EditSegment[];
  /** Duration of the pristine source audio the ORIGINAL material refers to. */
  sourceDuration: number;
}

/** The clip material a segment plays, as far as the projection needs it. */
export interface SegmentMaterial {
  /** Duration of the audio that is actually played (adapted clip buffer). */
  playDuration: number;
}

function clipSpan(seg: EditSegment, duration: number, kind: 'clip' | 'silence'): TimelineSpan {
  return {
    id: `${seg.id}:${kind}`,
    kind,
    projectStart: 0,
    duration,
    sourceStart: kind === 'clip' ? seg.sourceStart ?? 0 : 0,
    segmentId: seg.id,
    clipId: seg.clipId,
    sourceTrackId: seg.sourceTrackId,
    sourceClipStart: seg.sourceClipStart,
    tempoRatio: seg.tempoRatio ?? 1.0,
    pitchShift: seg.pitchShift ?? 0,
    gain: seg.gain ?? 1.0,
  };
}

function copySpan(span: TimelineSpan): TimelineSpan {
  return { ...span };
}

/**
 * Splits the layout at `t` (if it falls strictly inside a span) and returns the
 * index of the first span starting at or after `t`.
 */
function splitAt(layout: TimelineSpan[], t: number): number {
  for (let i = 0; i < layout.length; i++) {
    const span = layout[i];
    const start = span.projectStart;
    const end = start + span.duration;
    if (t > start + TIME_EPS && t < end - TIME_EPS) {
      const leftDur = t - start;
      const rightDur = end - t;
      const right: TimelineSpan = {
        ...copySpan(span),
        id: `${span.id}@${t.toFixed(6)}`,
        projectStart: t,
        duration: rightDur,
        sourceStart:
          span.kind === 'original'
            ? span.sourceStart + leftDur
            : span.kind === 'clip'
            ? span.sourceStart + leftDur
            : 0,
        sourceClipStart:
          span.kind === 'clip' && span.sourceClipStart !== undefined
            ? span.sourceClipStart + leftDur * span.tempoRatio
            : span.sourceClipStart,
      };
      layout[i] = { ...copySpan(span), duration: leftDur };
      layout.splice(i + 1, 0, right);
      return i + 1;
    }
    if (start >= t - TIME_EPS) return i;
  }
  return layout.length;
}

/** Removes every part of `[a, b)` from the layout, keeping the remainder. */
function cutRange(layout: TimelineSpan[], a: number, b: number): void {
  if (!(b > a)) return;
  // Split at the far end first, then at the near end, then re-resolve the far
  // index: splitting at `a` inserts an element and would otherwise invalidate
  // the boundary index found for `b`.
  splitAt(layout, b);
  const beforeIdx = splitAt(layout, a);
  const afterIdx = splitAt(layout, b);
  const removed: number[] = [];
  for (let i = beforeIdx; i < afterIdx; i++) {
    const span = layout[i];
    const start = span.projectStart;
    const end = start + span.duration;
    if (end <= a + TIME_EPS || start >= b - TIME_EPS) continue;
    if (start < a - TIME_EPS) {
      // Partially covered head of the span: keep the left part.
      const keep = a - start;
      layout[i] = { ...copySpan(span), duration: keep };
      continue;
    }
    if (end > b + TIME_EPS) {
      // Partially covered tail: keep the right part.
      const drop = b - start;
      layout[i] = {
        ...copySpan(span),
        projectStart: b,
        duration: end - b,
        sourceStart: span.sourceStart + drop,
        sourceClipStart:
          span.sourceClipStart !== undefined
            ? span.sourceClipStart + drop * span.tempoRatio
            : undefined,
      };
      continue;
    }
    removed.push(i);
  }
  for (let i = removed.length - 1; i >= 0; i--) layout.splice(removed[i], 1);
}

/** Replaces `[a, b)` with `replacement` (already positioned at 0). */
function replaceRange(layout: TimelineSpan[], a: number, b: number, replacement: TimelineSpan[]): void {
  cutRange(layout, a, b);
  const idx = splitAt(layout, a);
  layout.splice(idx, 0, ...replacement);
}

/** Cumulative re-numbering so the layout stays gapless. */
function renumber(layout: TimelineSpan[]): number {
  let cursor = 0;
  for (const span of layout) {
    span.projectStart = cursor;
    cursor += span.duration;
  }
  return cursor;
}

/**
 * Builds the authoritative project timeline from the track's edit segments.
 * `materialOf` supplies the played duration of clip material (from the segment's
 * clip buffer) so REPLACE can pad/trim deterministically.
 */
export function projectEditTimeline(
  input: ProjectionInput,
  materialOf?: (seg: EditSegment) => SegmentMaterial | null
): ProjectedTimeline {
  const segments = input.segments ?? [];
  const sourceDuration = Math.max(0, input.sourceDuration || 0);

  const baseSeg = segments.find((s) => s.type === 'ORIGINAL');
  const layout: TimelineSpan[] = [
    {
      id: baseSeg?.id ?? 'base',
      kind: 'original',
      projectStart: 0,
      duration: baseSeg && baseSeg.projectDuration > 0 ? baseSeg.projectDuration : sourceDuration,
      sourceStart: baseSeg?.sourceStart ?? 0,
      segmentId: baseSeg?.id ?? 'base',
      tempoRatio: 1.0,
      pitchShift: 0,
      gain: baseSeg?.gain ?? 1.0,
    },
  ];

  const overdubs: OverdubSpan[] = [];
  let structuralEdits = 0;

  for (const seg of segments) {
    if (seg.type === 'ORIGINAL') continue;

    const start = Math.max(0, seg.projectStart);
    const length = Math.max(0, seg.projectDuration);

    if (seg.type === 'OVERDUB') {
      if (length > 0) {
        overdubs.push({
          id: seg.id,
          segmentId: seg.id,
          projectStart: start,
          duration: length,
          sourceStart: seg.sourceStart ?? 0,
          clipId: seg.clipId,
          sourceTrackId: seg.sourceTrackId,
          sourceClipStart: seg.sourceClipStart,
          tempoRatio: seg.tempoRatio ?? 1.0,
          pitchShift: seg.pitchShift ?? 0,
          gain: seg.gain ?? 1.0,
        });
      }
      continue;
    }

    if (!(length > 0)) continue;

    if (seg.type === 'INSERT') {
      const idx = splitAt(layout, Math.min(start, renumber(layout)));
      layout.splice(idx, 0, clipSpan(seg, length, 'clip'));
      structuralEdits += 1;
    } else if (seg.type === 'REPLACE') {
      const available =
        materialOf?.(seg)?.playDuration ?? Math.max(0, (seg.sourceEnd ?? 0) - (seg.sourceStart ?? 0));
      const clipLength = Math.min(length, available > 0 ? available : length);
      const filler: TimelineSpan[] = [clipSpan(seg, clipLength, 'clip')];
      if (length - clipLength > TIME_EPS) {
        filler.push(clipSpan(seg, length - clipLength, 'silence'));
      }
      replaceRange(layout, start, start + length, filler);
      structuralEdits += 1;
    } else if (seg.type === 'CUT') {
      cutRange(layout, start, start + length);
      structuralEdits += 1;
    } else if (seg.type === 'CLEAR') {
      const silence = clipSpan(seg, length, 'silence');
      replaceRange(layout, start, start + length, [silence]);
      structuralEdits += 1;
    }
    renumber(layout);
  }

  const duration = renumber(layout);
  renumberOverdubs(overdubs, duration);

  const isIdentity =
    structuralEdits === 0 &&
    overdubs.length === 0 &&
    layout.length === 1 &&
    layout[0].kind === 'original' &&
    Math.abs(layout[0].duration - sourceDuration) < TIME_EPS &&
    Math.abs(layout[0].sourceStart) < TIME_EPS;

  return { spans: layout, overdubs, duration, isIdentity, structuralEdits };
}

function renumberOverdubs(overdubs: OverdubSpan[], duration: number): void {
  // Overdubs keep their own absolute project position (they never move the
  // layout); they are only clamped so they cannot extend past the project end.
  for (const od of overdubs) {
    od.projectStart = Math.max(0, Math.min(duration, od.projectStart));
    od.duration = Math.max(0, Math.min(od.duration, duration - od.projectStart));
  }
  overdubs.sort((a, b) => a.projectStart - b.projectStart);
}

/** The span covering project time `t` (null when `t` is outside the project). */
export function locateSpan(
  timeline: ProjectedTimeline,
  t: number
): { span: TimelineSpan; offset: number; index: number } | null {
  if (!(timeline.duration > 0) || t < -TIME_EPS || t > timeline.duration + TIME_EPS) return null;
  let lo = 0;
  let hi = timeline.spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = timeline.spans[mid];
    const end = span.projectStart + span.duration;
    if (t < span.projectStart - TIME_EPS) hi = mid - 1;
    else if (t > end + TIME_EPS) lo = mid + 1;
    else return { span, offset: Math.max(0, t - span.projectStart), index: mid };
  }
  return null;
}

/** Position of the material inside the clip buffer that is actually played. */
export function clipBufferTimeOf(span: TimelineSpan, offsetInSpan: number): number {
  return Math.max(0, span.sourceStart + offsetInSpan);
}

/**
 * Position of the same moment inside the clip's SOURCE track (the deck the clip
 * was cut from). Only meaningful together with `sourceTrackId`; the mapping is
 * exact for untouched timing (tempoRatio 1.0) and otherwise the best honest
 * estimate (a stretched clip covers `tempoRatio`× source seconds per played second).
 */
export function sourceTrackTimeOf(span: TimelineSpan, offsetInSpan: number): number {
  const inClip = span.sourceStart + offsetInSpan;
  const base = span.sourceClipStart ?? 0;
  return base + inClip * span.tempoRatio;
}

/** True when the clip span may reuse its source track's stored columns verbatim. */
export function spanAllowsVerbatimClipColumns(span: TimelineSpan): boolean {
  return (
    span.kind === 'clip' &&
    Math.abs(span.tempoRatio - 1.0) <= 0.002 &&
    span.pitchShift === 0 &&
    Math.abs(span.gain - 1.0) <= TIME_EPS &&
    span.sourceTrackId !== undefined &&
    span.sourceClipStart !== undefined
  );
}

// ---------------------------------------------------------------------------
// Follow-up state: re-timing of cues, loops, phrases and beat nodes
// ---------------------------------------------------------------------------

export type StructuralEditMode = 'insert' | 'remove' | 'replace' | 'clear' | 'move';

export interface StructuralEditDelta {
  mode: StructuralEditMode;
  /** Affected window on the project timeline BEFORE the edit. */
  start: number;
  end: number;
  /** Signed duration change applied to everything after `end` (or `start`). */
  delta: number;
}

/** Maps one time through a structural edit; null = the time fell inside removed material. */
export function retimeTime(t: number, edit: StructuralEditDelta): number | null {
  if (edit.mode === 'insert') {
    return t >= edit.start - TIME_EPS ? t + edit.delta : t;
  }
  if (edit.mode === 'remove') {
    if (t <= edit.start + TIME_EPS) return t;
    if (t >= edit.end - TIME_EPS) return Math.max(0, t + edit.delta);
    return null;
  }
  if (edit.mode === 'move') {
    // A moved span only shifts markers inside its own window.
    if (t >= edit.start - TIME_EPS && t <= edit.end + TIME_EPS) return t + edit.delta;
    return t;
  }
  return t; // replace/clear keep the timeline length
}

export function retimeTimeClamped(t: number, edit: StructuralEditDelta): number | null {
  const mapped = retimeTime(t, edit);
  if (mapped !== null) return mapped;
  // Marker inside removed material: collapse onto the cut position.
  return Math.max(0, edit.start);
}

/**
 * Re-times cue markers through a structural edit. Markers inside removed
 * material are dropped (their audio is gone); markers on/after the edit point
 * follow the shifted material.
 */
export function retimeCues(cues: CuePoint[], edit: StructuralEditDelta): { cues: CuePoint[]; dropped: number; moved: number } {
  const out: CuePoint[] = [];
  let dropped = 0;
  let moved = 0;
  for (const cue of cues ?? []) {
    const mapped = retimeTime(cue.position, edit);
    if (mapped === null) {
      dropped += 1;
      continue;
    }
    if (Math.abs(mapped - cue.position) > TIME_EPS) moved += 1;
    out.push({ ...cue, position: Math.max(0, mapped) });
  }
  return { cues: out, dropped, moved };
}

/** Re-times loops; loops that lose their length are dropped. */
export function retimeLoops(loops: LoopPoint[], edit: StructuralEditDelta): { loops: LoopPoint[]; dropped: number } {
  const out: LoopPoint[] = [];
  let dropped = 0;
  for (const loop of loops ?? []) {
    const start = retimeTimeClamped(loop.start, edit);
    const end = retimeTimeClamped(loop.end, edit);
    if (start === null || end === null) {
      dropped += 1;
      continue;
    }
    const length = end - start;
    if (length <= TIME_EPS) {
      dropped += 1;
      continue;
    }
    out.push({ ...loop, start, end, length });
  }
  return { loops: out, dropped };
}

/**
 * Re-times PSSI phrases. Bar numbers are only shifted for phrases that START at
 * or after the edit point, and only when the delta is an exact number of bars —
 * otherwise the phrase keeps its imported bar span and only its times move,
 * which is stated openly instead of silently re-quantizing the grid.
 */
export function retimePhrases(
  phrases: PhraseSection[],
  edit: StructuralEditDelta,
  secondsPerBar: number
): { phrases: PhraseSection[]; dropped: number; barShifted: number } {
  const out: PhraseSection[] = [];
  let dropped = 0;
  let barShifted = 0;
  const wholeBars = secondsPerBar > 0 ? Math.round(edit.delta / secondsPerBar) : 0;
  const exactBars = secondsPerBar > 0 && Math.abs(edit.delta - wholeBars * secondsPerBar) < 1e-3;
  const shiftsBars = edit.mode === 'insert' || edit.mode === 'remove';
  for (const phrase of phrases ?? []) {
    const startTime = retimeTimeClamped(phrase.startTime, edit);
    const endTime = retimeTimeClamped(phrase.endTime, edit);
    if (startTime === null || endTime === null) {
      dropped += 1;
      continue;
    }
    if (endTime - startTime <= TIME_EPS) {
      dropped += 1;
      continue;
    }
    const afterEditPoint =
      edit.mode === 'insert'
        ? phrase.startTime >= edit.start - TIME_EPS
        : phrase.startTime >= edit.end - TIME_EPS;
    const shiftBars = shiftsBars && exactBars && afterEditPoint ? wholeBars : 0;
    if (shiftBars !== 0) barShifted += 1;
    out.push({
      ...phrase,
      startTime,
      endTime,
      startBar: Math.max(1, phrase.startBar + shiftBars),
      endBar: Math.max(1, phrase.endBar + shiftBars),
    });
  }
  return { phrases: out, dropped, barShifted };
}

/** Re-times beat nodes; nodes inside removed material drop out, survivors re-index. */
export function retimeBeatNodes(
  beats: BeatNode[],
  edit: StructuralEditDelta
): { beats: BeatNode[]; dropped: number } {
  const out: BeatNode[] = [];
  let dropped = 0;
  for (const node of beats ?? []) {
    const time = retimeTime(node.time, edit);
    if (time === null || time < -TIME_EPS) {
      dropped += 1;
      continue;
    }
    out.push({ ...node, index: out.length, time: Math.max(0, time) });
  }
  out.sort((a, b) => a.time - b.time);
  out.forEach((node, index) => {
    node.index = index;
  });
  return { beats: out, dropped };
}

/**
 * Continues the grid across a material gap (an inserted clip window) with the
 * deck's uniform beat interval, so quantized editing keeps working inside and
 * behind the inserted material. The generated nodes are explicitly flagged
 * `insertGrid` — they are a user-edit consequence, never presented as PQTZ data,
 * and every imported node keeps its own time, bar flag and bar number.
 */
export function extendGridAcrossGap(
  beats: BeatNode[],
  gapStart: number,
  gapEnd: number,
  bpm: number,
  meter: number,
  firstBeat: number
): { beats: BeatNode[]; generated: number } {
  if (!(gapEnd > gapStart + TIME_EPS) || !(bpm > 0)) return { beats, generated: 0 };
  const spb = 60.0 / bpm;

  let anchor: BeatNode | null = null;
  for (const node of beats ?? []) {
    if (node.time <= gapStart + TIME_EPS && (!anchor || node.time > anchor.time)) anchor = node;
  }
  let anchorTime: number;
  let beatInBar: number;
  let barNumber: number;
  if (anchor) {
    anchorTime = anchor.time;
    beatInBar = (anchor.beatInBar % meter) + 1;
    barNumber = anchor.barNumber + (anchor.beatInBar === meter ? 1 : 0);
  } else {
    // No beat before the gap: derive the anchor from the uniform grid scalars.
    const beatIndex = Math.floor((gapStart - firstBeat) / spb);
    anchorTime = firstBeat + beatIndex * spb;
    while (anchorTime > gapStart + TIME_EPS) anchorTime -= spb;
    const wrapped = ((beatIndex % meter) + meter) % meter;
    beatInBar = wrapped + 1;
    barNumber = Math.floor(beatIndex / meter) + 1;
  }

  const generated: BeatNode[] = [];
  let time = anchorTime + spb;
  while (time < gapStart - TIME_EPS) time += spb;
  while (time < gapEnd - TIME_EPS) {
    const isBarStart = beatInBar === 1;
    generated.push({
      index: 0,
      time,
      isBarStart,
      barNumber,
      beatInBar,
      insertGrid: true,
    });
    beatInBar = (beatInBar % meter) + 1;
    if (beatInBar === 1) barNumber += 1;
    time += spb;
  }
  if (generated.length === 0) return { beats, generated: 0 };

  // Re-indexed on COPIES: the caller's node objects are never mutated.
  const merged = [...(beats ?? []), ...generated]
    .sort((a, b) => a.time - b.time)
    .map((node, i) => ({ ...node, index: i }));
  return { beats: merged, generated: generated.length };
}

/** Grid provenance after a structural edit: user edit, but the imported nodes survive. */
export function gridOriginAfterEdit(current: DataOrigin, edit: StructuralEditDelta): DataOrigin {
  if (edit.mode === 'insert' || edit.mode === 'remove') return DataOrigin.USER_EDIT;
  return current;
}

/**
 * Human-readable summary of what a structural edit did to the follow-up state —
 * used by the operation feedback modal so the consequence is visible, not implied.
 */
export function describeStructuralEdit(edit: StructuralEditDelta, counts: { cues: number; loops: number; phrases: number; beats: number; dropped: number }): string {
  const shift =
    Math.abs(edit.delta) < TIME_EPS
      ? 'Timeline-Dauer unverändert'
      : `Folgendes Material um ${edit.delta > 0 ? '+' : ''}${edit.delta.toFixed(3)}s verschoben`;
  const parts = [
    shift,
    `${counts.cues} Cues neu gesetzt`,
    `${counts.loops} Loops`,
    `${counts.phrases} Phrasen`,
    `${counts.beats} Beat-Knoten`,
  ];
  if (counts.dropped > 0) parts.push(`${counts.dropped} Marker innerhalb des entfernten Bereichs aufgehoben`);
  return parts.join(' • ');
}
