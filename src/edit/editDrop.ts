/**
 * @license
 * Drag & drop → structural edit geometry (pure).
 *
 * A drop only says "this material, here, in this mode". Everything that follows
 * (window on the timeline, length change, segment type) is derived here, so the
 * pointer handling in the UI and the projection in `editTimeline.ts` can never
 * disagree about what the drop meant. No DOM, no audio: unit-testable in
 * tests/edit-dnd.test.ts.
 */

import { EditOperationType } from '../types/rekordbox';
import type { StructuralEditDelta } from './editTimeline';

export type StructuralDropMode = 'insert' | 'replace' | 'overdub';

/** Shortest window a replace/overdub drop will address. */
export const MIN_DROP_WINDOW = 0.001;

export interface DropPlanInput {
  mode: StructuralDropMode;
  /** Drop position on the project timeline, already snapped by the UI. */
  dropTime: number;
  /** Clip length in seconds AFTER tempo/pitch adaptation. */
  clipDuration: number;
  /** Current project timeline length (edited length, not the media length). */
  timelineDuration: number;
  /**
   * Explicit window end (a selection or a drag range). Only replace and overdub
   * use it; insert always takes exactly as much room as the clip brings.
   */
  windowEnd?: number;
}

export interface DropPlan {
  segmentType: Extract<EditOperationType, 'INSERT' | 'REPLACE' | 'OVERDUB'>;
  /** Where the material starts on the project timeline. */
  projectStart: number;
  /** How much timeline room the material occupies. */
  projectDuration: number;
  /** Timeline window the edit addresses (null for a pure insert). */
  window: { start: number; end: number } | null;
  /** Length change for everything behind the drop (null = length preserved). */
  delta: StructuralEditDelta | null;
  /** True when the drop was pulled back into the timeline bounds. */
  clamped: boolean;
  /** True when clip material is longer than the replace/overdub window. */
  truncated: boolean;
  /** Human-readable consequence, used in the operation feedback. */
  note: string;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Turns a drop into the geometry of the structural edit it produces.
 *
 * insert   – the clip occupies its own length, everything behind it shifts right.
 * replace  – the clip replaces a window of the SAME total length; the timeline
 *            does not change. A window shorter than the clip truncates the clip,
 *            a window longer than the clip is padded with silence by the projection.
 * overdub  – the clip is mixed over a window without touching the length.
 */
export function planClipDrop(input: DropPlanInput): DropPlan {
  const duration = Math.max(0, Number.isFinite(input.clipDuration) ? input.clipDuration : 0);
  const timeline = Math.max(0, Number.isFinite(input.timelineDuration) ? input.timelineDuration : 0);
  const position = clamp(input.dropTime, 0, timeline);
  let clamped = Math.abs(position - input.dropTime) > 1e-9 || input.dropTime < 0;

  if (input.mode === 'insert') {
    const projectDuration = duration;
    return {
      segmentType: 'INSERT',
      projectStart: position,
      projectDuration,
      window: { start: position, end: position + projectDuration },
      delta: {
        mode: 'insert',
        start: position,
        end: position + projectDuration,
        delta: projectDuration,
      },
      clamped,
      truncated: false,
      note:
        projectDuration > 0
          ? `Clip belegt ${projectDuration.toFixed(3)} s ab ${position.toFixed(3)} s; alles dahinter rückt nach rechts.`
          : `Clip enthält kein Audiomaterial für ${position.toFixed(3)} s.`,
    };
  }

  // A window mode needs room INSIDE the timeline: a drop at the very end would
  // otherwise build a window that reaches past the project end and silently
  // shorten the timeline by MIN_DROP_WINDOW. The start is pulled back instead.
  const windowStart = clamp(position, 0, Math.max(0, timeline - MIN_DROP_WINDOW));
  if (windowStart !== position) clamped = true;
  const wantEnd =
    input.windowEnd !== undefined && Number.isFinite(input.windowEnd)
      ? Math.max(input.windowEnd, windowStart + MIN_DROP_WINDOW)
      : windowStart + (duration > 0 ? duration : MIN_DROP_WINDOW);
  const end = clamp(
    wantEnd,
    windowStart + MIN_DROP_WINDOW,
    Math.max(windowStart + MIN_DROP_WINDOW, timeline)
  );
  const windowLen = end - position;
  const truncated = duration > windowLen + 1e-9;

  if (input.mode === 'replace') {
    return {
      segmentType: 'REPLACE',
      projectStart: windowStart,
      projectDuration: windowLen,
      window: { start: windowStart, end },
      delta: { mode: 'replace', start: windowStart, end, delta: 0 },
      clamped,
      truncated,
      note: truncated
        ? `Ersetzt ${position.toFixed(3)}–${end.toFixed(3)} s; ${duration.toFixed(3)} s Clip-Material passen nicht und werden abgeschnitten.`
        : duration + 1e-9 < windowLen
        ? `Ersetzt ${position.toFixed(3)}–${end.toFixed(3)} s; ${windowLen.toFixed(3)} s werden aus ${duration.toFixed(3)} s Clip-Material und Stille gefüllt.`
        : `Ersetzt ${position.toFixed(3)}–${end.toFixed(3)} s 1:1; Timeline-Länge bleibt unverändert.`,
    };
  }

  return {
    segmentType: 'OVERDUB',
    projectStart: windowStart,
    projectDuration: windowLen,
    window: { start: windowStart, end },
    delta: null,
    clamped,
    truncated,
    note: `Überlagert ${windowStart.toFixed(3)}–${end.toFixed(3)} s; die Timeline behält ihre Länge${
      truncated ? ', das Clip-Ende wird abgeschnitten' : ''
    }.`,
  };
}
