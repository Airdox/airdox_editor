/**
 * @license
 * Beat grid helpers.
 *
 * Rekordbox stores a *variable* beat grid: every beat carries its own
 * timestamp and its own tempo. Real recordings (and anything not produced to a
 * fixed click) drift relative to a single constant BPM. Extrapolating
 * `firstBeat + index * 60 / bpm` therefore accumulates error the further you
 * get from the first beat — a few milliseconds early on, easily hundreds of
 * milliseconds several minutes in.
 *
 * These helpers query the *measured* beat list whenever it is present and only
 * fall back to constant-tempo maths when a track genuinely has no beat data.
 */

import { BeatGrid, BeatNode, DataOrigin } from '../types/rekordbox';

/** True when the grid carries real per-beat timestamps. */
export function hasMeasuredBeats(grid: BeatGrid | null | undefined): boolean {
  return !!grid && Array.isArray(grid.beats) && grid.beats.length > 1;
}

/** Seconds per beat for the constant-tempo fallback. */
export function secondsPerBeat(grid: BeatGrid): number {
  const bpm = grid.bpm > 0 ? grid.bpm : 130;
  return 60.0 / bpm;
}

/**
 * Index of the last beat at or before `time`, via binary search.
 * Returns -1 when `time` lies before the first beat.
 */
export function beatIndexAtOrBefore(beats: BeatNode[], time: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  let result = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid].time <= time) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return result;
}

/**
 * Fractional beat position of `time` on the grid.
 *
 * With measured beats the position is interpolated between the two
 * neighbouring beats, so it stays exact even when the tempo drifts. Positions
 * outside the measured range are extrapolated from the local tempo at the
 * corresponding edge rather than the track's average tempo.
 */
export function timeToBeatPosition(grid: BeatGrid, time: number): number {
  if (!hasMeasuredBeats(grid)) {
    return (time - grid.firstBeat) / secondsPerBeat(grid);
  }

  const beats = grid.beats;
  const first = beats[0];
  const last = beats[beats.length - 1];

  if (time <= first.time) {
    const localSpb = beats[1].time - first.time || secondsPerBeat(grid);
    return (time - first.time) / localSpb;
  }

  if (time >= last.time) {
    const prev = beats[beats.length - 2];
    const localSpb = last.time - prev.time || secondsPerBeat(grid);
    return beats.length - 1 + (time - last.time) / localSpb;
  }

  const i = beatIndexAtOrBefore(beats, time);
  const a = beats[i];
  const b = beats[i + 1];
  const span = b.time - a.time;
  if (span <= 0) return i;
  return i + (time - a.time) / span;
}

/**
 * Time in seconds of a (possibly fractional) beat position — the inverse of
 * {@link timeToBeatPosition}.
 */
export function beatPositionToTime(grid: BeatGrid, position: number): number {
  if (!hasMeasuredBeats(grid)) {
    return grid.firstBeat + position * secondsPerBeat(grid);
  }

  const beats = grid.beats;
  const last = beats.length - 1;

  if (position <= 0) {
    const localSpb = beats[1].time - beats[0].time || secondsPerBeat(grid);
    return beats[0].time + position * localSpb;
  }

  if (position >= last) {
    const localSpb = beats[last].time - beats[last - 1].time || secondsPerBeat(grid);
    return beats[last].time + (position - last) * localSpb;
  }

  const i = Math.floor(position);
  const frac = position - i;
  const a = beats[i];
  const b = beats[i + 1];
  return a.time + frac * (b.time - a.time);
}

/** Snaps `time` to the nearest beat on the grid. */
export function snapTimeToBeat(grid: BeatGrid, time: number): number {
  if (!hasMeasuredBeats(grid)) {
    const spb = secondsPerBeat(grid);
    const index = Math.round((time - grid.firstBeat) / spb);
    return Math.max(0, grid.firstBeat + index * spb);
  }
  return Math.max(0, beatPositionToTime(grid, Math.round(timeToBeatPosition(grid, time))));
}

/** Bar / beat label for a point in time, 1-based as shown in Rekordbox. */
export function barAndBeatAt(
  grid: BeatGrid,
  time: number
): { bar: number; beat: number; beatIndex: number } {
  const meter = grid.meter > 0 ? grid.meter : 4;

  if (hasMeasuredBeats(grid)) {
    const index = Math.max(0, Math.round(timeToBeatPosition(grid, time)));
    const node = grid.beats[Math.min(index, grid.beats.length - 1)];
    if (node && index < grid.beats.length) {
      return { bar: node.barNumber, beat: node.beatInBar, beatIndex: index };
    }
    return {
      bar: Math.floor(index / meter) + 1,
      beat: (index % meter) + 1,
      beatIndex: index,
    };
  }

  const index = Math.max(0, Math.round((time - grid.firstBeat) / secondsPerBeat(grid)));
  return {
    bar: Math.floor(index / meter) + 1,
    beat: (index % meter) + 1,
    beatIndex: index,
  };
}

/**
 * Beats intersecting the visible window `[from, to]`, for rendering grid lines.
 * Uses the measured timestamps so drawn beat lines match the audio.
 */
export function beatsInRange(grid: BeatGrid, from: number, to: number): BeatNode[] {
  if (hasMeasuredBeats(grid)) {
    const beats = grid.beats;
    const startIdx = Math.max(0, beatIndexAtOrBefore(beats, from));
    const out: BeatNode[] = [];
    for (let i = startIdx; i < beats.length; i++) {
      const t = beats[i].time;
      if (t > to) break;
      if (t >= from) out.push(beats[i]);
    }
    return out;
  }

  const spb = secondsPerBeat(grid);
  const meter = grid.meter > 0 ? grid.meter : 4;
  const startBeat = Math.max(0, Math.floor((from - grid.firstBeat) / spb));
  const endBeat = Math.ceil((to - grid.firstBeat) / spb);
  const out: BeatNode[] = [];

  for (let i = startBeat; i <= endBeat; i++) {
    const time = grid.firstBeat + i * spb;
    if (time < from || time > to) continue;
    out.push({
      index: i,
      time,
      isBarStart: i % meter === 0,
      barNumber: Math.floor(i / meter) + 1,
      beatInBar: (i % meter) + 1,
    });
  }

  return out;
}

/**
 * Extends a measured grid to `totalDuration` without discarding it.
 *
 * Rekordbox usually stores beats only up to the end of the analysed audio. If
 * the working track is longer, the tail is continued using the tempo of the
 * final measured beats — the measured part stays untouched.
 */
export function extendBeatGrid(grid: BeatGrid, totalDuration: number): BeatGrid {
  if (!hasMeasuredBeats(grid)) return grid;

  const beats = [...grid.beats];
  const last = beats[beats.length - 1];
  if (last.time >= totalDuration) return grid;

  const prev = beats[beats.length - 2];
  const spb = last.time - prev.time || secondsPerBeat(grid);
  const meter = grid.meter > 0 ? grid.meter : 4;

  let index = beats.length;
  let time = last.time + spb;
  let beatInBar = (last.beatInBar % meter) + 1;
  let barNumber = beatInBar === 1 ? last.barNumber + 1 : last.barNumber;

  while (time <= totalDuration && index < 200_000) {
    beats.push({ index, time, isBarStart: beatInBar === 1, barNumber, beatInBar });
    index += 1;
    time += spb;
    beatInBar = (beatInBar % meter) + 1;
    if (beatInBar === 1) barNumber += 1;
  }

  return { ...grid, beats };
}

/**
 * Rebuilds a grid from bare beat timestamps (as persisted in a project file).
 */
export function beatGridFromTimes(
  timesMs: number[],
  meter: number,
  bpm: number,
  origin: DataOrigin,
  firstBeatInBar: number = 1
): BeatGrid {
  const m = meter > 0 ? meter : 4;
  let beatInBar = firstBeatInBar >= 1 && firstBeatInBar <= m ? firstBeatInBar : 1;
  let barNumber = 1;
  const beats: BeatNode[] = [];

  for (let i = 0; i < timesMs.length; i++) {
    beats.push({
      index: i,
      time: timesMs[i] / 1000,
      isBarStart: beatInBar === 1,
      barNumber,
      beatInBar,
    });
    beatInBar = (beatInBar % m) + 1;
    if (beatInBar === 1) barNumber += 1;
  }

  return {
    firstBeat: beats.length > 0 ? beats[0].time : 0,
    bpm,
    meter: m,
    beats,
    origin,
  };
}
