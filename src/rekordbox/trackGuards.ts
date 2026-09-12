/**
 * @license
 * Pure deck-loader and edit guards for Rekordbox-sourced tracks (no React,
 * no audio APIs).
 *
 * These helpers lock the non-negotiable rules of the implementation order in
 * testable code: Rekordbox tracks never receive own-generated analysis, their
 * audio and analysis load paths stay separated, grid edits preserve original
 * intervals and stay traceable, and persisted grids round-trip verbatim.
 * Covered by tests/track-guards.test.ts.
 */

import { BeatGrid, BeatNode, DataOrigin } from '../types/rekordbox';
import { SerializedBeatGrid } from './projectFile';
import { buildBeatGridFromTempo } from './xmlParser';

/**
 * Tracks whose origin is a Rekordbox source (XML / DB / ANLZ) must NEVER
 * receive own-generated data. Waveform comes only from ANLZ, beatgrid only
 * from TEMPO/PQTZ parameters, cues/loops only from POSITION_MARK/djmdCue/
 * PCOB/PCO2, phrases only from PSSI.
 */
export function isRekordboxOrigin(origin: DataOrigin | undefined): boolean {
  return (
    origin === DataOrigin.REKORDBOX_XML ||
    origin === DataOrigin.REKORDBOX_DB ||
    origin === DataOrigin.REKORDBOX_ANLZ
  );
}

/**
 * Waveform source rule for deck loading: Rekordbox tracks resolve their
 * waveform exclusively from ANLZ (auto-resolved or manually assigned);
 * only non-Rekordbox tracks may fall back to local peak analysis of
 * readable audio — audio and analysis stay separate decisions.
 */
export function selectDeckWaveformSource(origin: DataOrigin | undefined): 'ANLZ_ONLY' | 'LOCAL_ALLOWED' {
  return isRekordboxOrigin(origin) ? 'ANLZ_ONLY' : 'LOCAL_ALLOWED';
}

/**
 * Rigidly shifts every beat node by `deltaSec`, preserving the original
 * intervals (verbatim PQTZ grids keep their timing; uniform grids shift
 * identically to a rebuild). Nodes shifted before zero are dropped and the
 * survivors re-indexed; bar numbers, flags and tail provenance are kept.
 */
export function shiftBeatNodes(beats: BeatNode[], deltaSec: number): BeatNode[] {
  if (!(deltaSec > 0) && !(deltaSec < 0)) {
    return beats.map((node, index) => ({ ...node, index }));
  }
  const shifted: BeatNode[] = [];
  for (const node of beats) {
    const time = node.time + deltaSec;
    if (time < 0) continue;
    shifted.push({ ...node, index: shifted.length, time });
  }
  return shifted;
}

export type GridEditSource = 'SHIFT' | 'SET_1_1' | 'AUTO_ALIGN';

const GRID_EDIT_LABELS: Record<GridEditSource, string> = {
  SHIFT: 'Grid-Shift',
  SET_1_1: 'Set 1.1',
  AUTO_ALIGN: 'Auto-Align',
};

/**
 * Builds the user-facing change notice for a manual grid edit (shown in the
 * operation feedback and the system log). The original state stays recoverable
 * through Undo, which snapshots the grid before the edit.
 */
export function describeGridEdit(
  source: GridEditSource,
  oldFirstBeat: number,
  newFirstBeat: number,
  nodeCount: number
): string {
  const deltaMs = (newFirstBeat - oldFirstBeat) * 1000;
  const sign = deltaMs >= 0 ? '+' : '';
  return (
    `${GRID_EDIT_LABELS[source]}: Beatgrid um ${sign}${deltaMs.toFixed(1)} ms verschoben ` +
    `(First Beat ${oldFirstBeat.toFixed(3)}s → ${newFirstBeat.toFixed(3)}s, ${nodeCount} Beats, ` +
    `Originalintervalle erhalten, als USER_EDIT markiert). Der vorherige Stand ist per Undo wiederherstellbar.`
  );
}

function baseNameOfPath(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // keep raw value
  }
  return decoded.split(/[\\/]/).pop()?.split('?')[0].toLowerCase() ?? '';
}

/**
 * Plausibility guard for ANLZ assignment: the PPTH source path stored inside
 * the container should reference the same audio file as the track. Returns a
 * German warning note on mismatch, null when the assignment is plausible.
 * A missing PPTH path or a missing track path never warns (nothing to compare).
 */
export function ppthMismatchNote(
  extractionPath: string | undefined,
  expectedPath: string
): string | null {
  if (!extractionPath || !expectedPath) return null;
  if (baseNameOfPath(extractionPath) === baseNameOfPath(expectedPath)) return null;
  return `PPTH-Verweis (${extractionPath}) weicht vom Track-Pfad ab – Zuordnung prüfen.`;
}

/**
 * Rebuilds a persisted beat grid: verbatim node adoption (re-indexed, flags
 * intact) when the project stores nodes; a uniform rebuild from the scalars
 * only for older files — the single documented legacy fallback, keeping the
 * stored grid origin when present, else the track origin.
 */
export function adoptSerializedGrid(
  persisted: SerializedBeatGrid,
  durationSec: number,
  trackOrigin: DataOrigin
): BeatGrid {
  const origin = persisted.origin ?? trackOrigin;
  if (persisted.beats && persisted.beats.length > 0) {
    const firstBeat = persisted.firstBeat;
    return {
      firstBeat,
      bpm: persisted.bpm,
      meter: persisted.meter,
      beats: persisted.beats.map((node, index) => ({
        index,
        time: node.time,
        isBarStart: node.isBarStart,
        barNumber: node.barNumber,
        beatInBar: node.beatInBar,
        ...(node.bpm !== undefined ? { bpm: node.bpm } : {}),
        ...(node.tailExtended === true ? { tailExtended: true as const } : {}),
      })),
      origin,
    };
  }
  if (isRekordboxOrigin(origin)) {
    return {
      firstBeat: persisted.firstBeat,
      bpm: persisted.bpm,
      meter: persisted.meter,
      beats: [],
      origin,
    };
  }
  return buildBeatGridFromTempo(
    persisted.firstBeat,
    persisted.bpm,
    durationSec,
    persisted.meter,
    origin
  );
}

/**
 * Normalizes a binary bridge payload to an ArrayBuffer.
 *
 * Electron IPC structured-clones Node Buffers to Uint8Array (never back to
 * ArrayBuffer), so desktop readers must not assume ArrayBuffer input:
 * `new DataView(view)` and `decodeAudioData(view)` throw TypeError on views,
 * which previously failed every desktop ANLZ/audio intake silently.
 * ArrayBuffers pass through untouched; views are copied byte-exactly (never
 * aliased, since pooled buffers may share a larger backing store).
 */
export function ensureArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as Uint8Array;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  throw new Error('Unerwarteter Binärdatentyp vom Desktop-Bridge (weder ArrayBuffer noch Uint8Array).');
}
