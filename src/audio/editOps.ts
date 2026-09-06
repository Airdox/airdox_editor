/**
 * @license
 * Airdox_intelligents_Editor – Editier-Operationen
 *
 * Eine Operation, zwei Verwendungen: Die Werkzeugleiste des Editors ruft genau
 * diese Funktionen auf, und die Tests unter Node rufen dieselben auf. Deshalb ist
 * der Workflow (Ausschneiden, Kopieren, Einfügen, Einschneiden, Overdub, Palette)
 * ohne Browser prüfbar.
 *
 * Alle Operationen sind rein: sie geben ein neues Zielobjekt zurück und verändern
 * das Original nie. Das ist zugleich die Zusage an die Nutzer – die Quelldatei
 * bleibt unberührt, geschnitten wird nur die Arbeitskopie.
 */

import { BeatGrid, BeatNode, CuePoint, DataOrigin, LoopPoint } from '../types/rekordbox';
import {
  PcmAudio,
  clampRange,
  pcmConcat,
  pcmDuration,
  pcmInsertSamples,
  pcmMixHeadroom,
  pcmOverwrite,
  pcmRemoveSamples,
  pcmSampleCount,
  pcmSilence,
  pcmSlice,
} from './pcm';

export interface EditableAudio {
  audio: PcmAudio;
  cues: CuePoint[];
  loops: LoopPoint[];
  beatGrid: BeatGrid;
}

export type EditKind =
  | 'COPY_TO_END'
  | 'MOVE_TO_START'
  | 'REMOVE_RANGE'
  | 'PASTE_AT'
  | 'INSERT_CLIP'
  | 'REPLACE_RANGE'
  | 'OVERDUB_RANGE'
  | 'SILENCE_RANGE';

export interface EditReport {
  kind: EditKind;
  /** Kurzbeschreibung für das Feedback-Protokoll, auf Deutsch. */
  description: string;
  sourceStart: number;
  sourceEnd: number;
  targetStart: number;
  targetEnd: number;
  durationSec: number;
  startBeat: number;
  endBeat: number;
  barsCount: number;
  addedSamples: number;
  removedSamples: number;
  /** Stille, die eingefügt wurde, damit ein Block auf einem Taktanfang landet. */
  padSamples: number;
  shiftedCues: number;
  removedCues: number;
  movedCues: number;
  shiftedLoops: number;
  beatCountAfter: number;
  beatCountBefore: number;
  /** Samplezahl vorher/nachher – für Tests die kürzeste Kontrolle der Längenmathematik. */
  samplesBefore: number;
  samplesAfter: number;
  warnings: string[];
}

export interface EditOutcome {
  target: EditableAudio;
  report: EditReport;
}

/** Overdub kennt die Pegel-Rechnung und weist sie aus – für Oberfläche und Tests. */
export interface OverdubOutcome extends EditOutcome {
  mix: {
    gainUsed: number;
    gainRequested: number;
    dryPeak: number;
    peakAfter: number;
    regionScale: number;
    attenuated: boolean;
  };
}

export function secondsPerBeat(grid: BeatGrid): number {
  return 60.0 / (grid.bpm || 120);
}

/**
 * Trägt das Raster die von Rekordbox gelieferten Beat-Zeiten (PQTZ in der
 * ANLZ-Datei, fortdauernde `TEMPO`-Angaben aus der XML), sind **diese** Werte
 * maßgeblich – eine aus BPM fortgeschriebene Rechnung ersetzt sie nicht.
 * Eine leere Liste heißt: bewusst kompakt importiert (Sammlungsliste), dann ist
 * die Fortschreibung dieselbe Rechnung wie in Rekordbox und keine Analyse.
 */
export function hasRealBeats(grid: BeatGrid): boolean {
  return Array.isArray(grid.beats) && grid.beats.length > 0;
}

/** Mittlere Beatlänge – bei importierten Beats aus deren eigener Zeitspanne. */
export function averageSecondsPerBeat(grid: BeatGrid): number {
  const beats = grid.beats;
  if (hasRealBeats(grid) && beats && beats.length > 1) {
    const first = beats[0];
    const last = beats[beats.length - 1];
    const span = last.time - first.time;
    const steps = last.index - first.index;
    if (span > 0 && steps > 0) return span / steps;
  }
  return secondsPerBeat(grid);
}

/** Beatnummer (gebrochen) zu einer Zeit, interpoliert zwischen den echten Beats. */
export function beatPosition(grid: BeatGrid, seconds: number): number {
  const beats = grid.beats;
  if (!hasRealBeats(grid) || !beats || beats.length === 0) {
    return (seconds - grid.firstBeat) / secondsPerBeat(grid);
  }
  if (beats.length === 1) {
    return beats[0].index + (seconds - beats[0].time) / secondsPerBeat(grid);
  }
  if (seconds <= beats[0].time) {
    const step = beats[1].time > beats[0].time ? beats[1].time - beats[0].time : secondsPerBeat(grid);
    return beats[0].index + (seconds - beats[0].time) / step;
  }
  const last = beats[beats.length - 1];
  if (seconds >= last.time) {
    return last.index + (seconds - last.time) / secondsPerBeat(grid);
  }
  let low = 0;
  let high = beats.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (beats[mid].time <= seconds) low = mid;
    else high = mid - 1;
  }
  const a = beats[low];
  const b = beats[low + 1];
  const step = b.time > a.time ? b.time - a.time : secondsPerBeat(grid);
  return a.index + (seconds - a.time) / step;
}

export function beatTime(grid: BeatGrid, beatIndex: number): number {
  const known = grid.beats?.[beatIndex];
  if (known) return known.time;
  return grid.firstBeat + beatIndex * secondsPerBeat(grid);
}

export function nearestBeatIndex(grid: BeatGrid, seconds: number): number {
  const beats = grid.beats;
  if (!hasRealBeats(grid) || !beats || beats.length === 0) {
    return Math.round((seconds - grid.firstBeat) / secondsPerBeat(grid));
  }
  // nächstliegender Beat aus der importierten Liste (monoton nach Zeit)
  let low = 0;
  let high = beats.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (beats[mid].time < seconds) low = mid + 1;
    else high = mid;
  }
  const before = beats[Math.max(0, low - 1)];
  const after = beats[low];
  return Math.abs(before.time - seconds) <= Math.abs(after.time - seconds) ? before.index : after.index;
}

/** Auf Beat- oder Taktraster einrasten (Quantize des Editors). */
export function snapToGrid(
  grid: BeatGrid,
  seconds: number,
  mode: 'beat' | 'bar' | 'off' = 'beat',
  direction: 'nearest' | 'up' = 'nearest'
): { seconds: number; snapped: boolean } {
  if (mode === 'off') return { seconds, snapped: false };
  const beats = grid.beats;
  // Rasten auf die Positionen, die Rekordbox selbst gesetzt hat – innerhalb der
  // importierten Liste. Jenseits des letzten Beats gibt es keinen Importwert, dort
  // wird das Raster fortgeschrieben (sonst könnte ans Ende nicht über die Länge
  // hinaus gerastet werden).
  if (hasRealBeats(grid) && beats && beats.length > 0 && seconds <= beats[beats.length - 1].time + 1e-9) {
    const list = mode === 'bar' ? beats.filter((beat) => beat.isBarStart) : beats;
    const pool = list.length > 0 ? list : beats;
    const pick =
      direction === 'up'
        ? pool.find((beat) => beat.time >= seconds - 1e-9) ?? pool[pool.length - 1]
        : (() => {
            let low = 0;
            let high = pool.length - 1;
            while (low < high) {
              const mid = (low + high) >> 1;
              if (pool[mid].time < seconds) low = mid + 1;
              else high = mid;
            }
            const before = pool[Math.max(0, low - 1)];
            const after = pool[low];
            return Math.abs(before.time - seconds) <= Math.abs(after.time - seconds) ? before : after;
          })();
    const snappedTime = Math.max(0, pick.time);
    return { seconds: snappedTime, snapped: Math.abs(snappedTime - seconds) > 1e-9 };
  }
  const spb = secondsPerBeat(grid);
  const unit = mode === 'bar' ? spb * Math.max(1, grid.meter) : spb;
  const raw = (seconds - grid.firstBeat) / unit;
  const count = direction === 'up' ? Math.ceil(raw - 1e-9) : Math.round(raw);
  const snappedTime = Math.max(0, grid.firstBeat + count * unit);
  return { seconds: snappedTime, snapped: Math.abs(snappedTime - seconds) > 1e-9 };
}

/** Beatgrid an die neue Länge anpassen; erster Beat und BPM bleiben erhalten. */
export function regrowBeatGrid(grid: BeatGrid, durationSec: number): BeatGrid {
  // Importierte Beats behalten ihre Zeiten und bleiben innerhalb der neuen Länge
  // stehen; nur das Ende wird gleichmäßig fortgeschrieben, damit die Spur bedeckt
  // bleibt. Ohne importierte Liste entsteht dasselbe uniformes Raster wie vorher.
  const kept = hasRealBeats(grid) ? grid.beats.filter((beat) => beat.time <= durationSec + 1e-9) : [];
  return {
    ...grid,
    beats: fitBeats(grid, kept, durationSec),
    origin: grid.origin ?? DataOrigin.PROJECT,
  };
}

/** Verschiebungspläne, die ein Eingriff an der Timeline erzeugt. */
export type GridRipple =
  | { kind: 'remove'; startSec: number; endSec: number }
  | { kind: 'insert'; atSec: number; lengthSec: number };

/**
 * Beatgrid durch die Eingriffe einer Operation schicken statt es neu zu erfinden:
 * Beats innerhalb eines entfernten Bereichs entfallen, alle danach folgenden rücken
 * um genau die Länge des Eingriffs – die *übrigen* Zeiten bleiben die von
 * Rekordbox gelieferten (100-%-Regel: Originaldaten gewinnen immer).
 */
export function rippleBeatGrid(grid: BeatGrid, ripples: GridRipple[], durationSec: number): BeatGrid {
  if (!hasRealBeats(grid)) return regrowBeatGrid(grid, durationSec);
  let beats = grid.beats.map((beat) => ({ ...beat }));
  for (const ripple of ripples) {
    if (ripple.kind === 'remove') {
      const lengthSec = Math.max(0, ripple.endSec - ripple.startSec);
      const kept: BeatNode[] = [];
      for (const beat of beats) {
        if (beat.time >= ripple.startSec - 1e-9 && beat.time < ripple.endSec - 1e-9) continue;
        kept.push(beat.time >= ripple.endSec - 1e-9 ? { ...beat, time: beat.time - lengthSec } : beat);
      }
      beats = kept;
    } else {
      const lengthSec = Math.max(0, ripple.lengthSec);
      if (lengthSec <= 0) continue;
      beats = beats.map((beat) => (beat.time >= ripple.atSec - 1e-9 ? { ...beat, time: beat.time + lengthSec } : beat));
    }
  }
  return { ...grid, beats: fitBeats(grid, beats, durationSec), origin: grid.origin ?? DataOrigin.PROJECT };
}

/**
 * Bereich an eine frühere Position setzen – die Beats des Blocks wandern mit,
 * ihre Zeiten bleiben die importierten (nur um den Versatz verschoben).
 */
export function moveBeatGrid(
  grid: BeatGrid,
  fromStart: number,
  fromEnd: number,
  toStart: number,
  durationSec: number
): BeatGrid {
  if (!hasRealBeats(grid)) return regrowBeatGrid(grid, durationSec);
  const lengthSec = Math.max(0, fromEnd - fromStart);
  const moved: BeatNode[] = [];
  const rest: BeatNode[] = [];
  for (const beat of grid.beats) {
    if (beat.time >= fromStart - 1e-9 && beat.time < fromEnd - 1e-9) {
      moved.push({ ...beat, time: toStart + (beat.time - fromStart) });
    } else if (beat.time >= toStart - 1e-9 && beat.time < fromStart - 1e-9) {
      rest.push({ ...beat, time: beat.time + lengthSec });
    } else {
      rest.push({ ...beat });
    }
  }
  const beats = [...rest, ...moved].sort((a, b) => a.time - b.time);
  return { ...grid, beats: fitBeats(grid, beats, durationSec), origin: grid.origin ?? DataOrigin.PROJECT };
}

/**
 * Nummerierung neu setzen und den Rand auffüllen – die importierten Zeiten
 * bleiben, wie sie sind. Gefüllt wird nach beiden Seiten aus dem Raster
 * fortgeschrieben (dieselbe Rechnung wie Rekordbox, keine neue Analyse): nach
 * vorne bis `firstBeat`, damit ein vorn eingefügter Block weiter auf Takt 1
 * anfängt, und nach hinten bis zur neuen Länge.
 */
function fitBeats(grid: BeatGrid, beats: BeatNode[], durationSec: number): BeatNode[] {
  const spb = averageSecondsPerBeat(grid);
  const meter = Math.max(1, grid.meter);
  const within = beats
    .filter((beat) => beat.time <= durationSec + 1e-9)
    .sort((a, b) => a.time - b.time);

  const out: BeatNode[] = [...within];
  const firstTime = out.length > 0 ? out[0].time : grid.firstBeat;
  const before: BeatNode[] = [];
  for (let time = firstTime - spb; time >= grid.firstBeat - 1e-9; time -= spb) {
    before.push({ index: 0, time, isBarStart: false, barNumber: 0, beatInBar: 0 });
  }
  before.reverse();
  out.unshift(...before);

  // Abdeckung: das Raster folgt dem Material, nie darüber hinaus – nach vorn bis
  // `firstBeat`, nach hinten bis zur neuen Länge.
  if (out.length === 0) out.push({ index: 0, time: grid.firstBeat, isBarStart: true, barNumber: 1, beatInBar: 1 });
  while (out[out.length - 1].time < durationSec - 1e-9) {
    const i = out.length;
    out.push({
      index: i,
      time: out[i - 1].time + spb,
      isBarStart: false,
      barNumber: 0,
      beatInBar: 0,
    });
  }
  while (out.length > 1 && out[out.length - 1].time > durationSec + 1e-9) out.pop();

  // Bar-Bezüge: importierte Werte behalten, fortgeschriebene Takte aus dem Raster.
  return out.map((beat, i) => {
    const carried = within.find((candidate) => candidate.time === beat.time);
    if (carried) return { ...beat, index: i };
    return {
      ...beat,
      index: i,
      isBarStart: i % meter === 0,
      barNumber: Math.floor(i / meter) + 1,
      beatInBar: (i % meter) + 1,
    };
  });
}

function shiftCues(
  cues: CuePoint[],
  fromSec: number,
  deltaSec: number,
  options: { removeInside?: [number, number] } = {}
): { cues: CuePoint[]; shifted: number; removed: number } {
  let shifted = 0;
  let removed = 0;
  const [inFrom, inTo] = options.removeInside ?? [0, 0];
  const next: CuePoint[] = [];
  for (const cue of cues) {
    if (options.removeInside && cue.position >= inFrom && cue.position < inTo) {
      removed++;
      continue;
    }
    if (cue.position >= fromSec) {
      shifted++;
      const position = Math.max(0, cue.position + deltaSec);
      next.push({ ...cue, position, inMsec: Math.round(position * 1000) });
    } else {
      next.push(cue);
    }
  }
  return { cues: next, shifted, removed };
}

function shiftLoops(
  loops: LoopPoint[],
  fromSec: number,
  deltaSec: number,
  options: { removeInside?: [number, number] } = {}
): { loops: LoopPoint[]; shifted: number } {
  let shifted = 0;
  const [inFrom, inTo] = options.removeInside ?? [0, 0];
  const next: LoopPoint[] = [];
  for (const loop of loops) {
    if (options.removeInside && loop.start >= inFrom && loop.end <= inTo) continue; // ganz entfernt
    let { start, end } = loop;
    let touched = false;
    if (options.removeInside) {
      const [a, b] = options.removeInside;
      const removedLen = b - a;
      if (end <= a || start >= b) {
        if (start >= b) {
          start -= removedLen;
          end -= removedLen;
          touched = true;
        }
      } else if (start < a && end > b) {
        end -= removedLen; // der Loop umspannt den Schnitt: innen fehlt genau der Schnitt
        touched = true;
      } else if (start < a) {
        end = a; // endet imremoveden Bereich: bis zur Nahtstelle behalten
        touched = true;
      } else if (end > b) {
        start = a; // beginnt imremoveden Bereich: auf die Nahtstelle ziehen
        end -= removedLen;
        touched = true;
      } else {
        continue; // lag vollständig im removeden Bereich
      }
      if (end <= start) continue;
    }
    if (deltaSec !== 0 && start >= fromSec) {
      start = Math.max(0, start + deltaSec);
      end = Math.max(start, end + deltaSec);
      touched = true;
    }
    if (touched) shifted++;
    next.push({ ...loop, start, end, length: end - start });
  }
  return { loops: next, shifted };
}

function reportBase(kind: EditKind, target: EditableAudio): EditReport {
  return {
    kind,
    description: '',
    sourceStart: 0,
    sourceEnd: 0,
    targetStart: 0,
    targetEnd: 0,
    durationSec: 0,
    startBeat: 0,
    endBeat: 0,
    barsCount: 0,
    addedSamples: 0,
    removedSamples: 0,
    padSamples: 0,
    shiftedCues: 0,
    removedCues: 0,
    movedCues: 0,
    shiftedLoops: 0,
    beatCountAfter: target.beatGrid.beats.length,
    beatCountBefore: target.beatGrid.beats.length,
    samplesBefore: pcmSampleCount(target.audio),
    samplesAfter: pcmSampleCount(target.audio),
    warnings: [],
  };
}

function describeBeats(grid: BeatGrid, startSec: number, endSec: number) {
  // Beatlage aus dem importierten Raster (bei uniformem Raster identisch zur
  // Teilung durch die Beatlänge).
  const startBeat = beatPosition(grid, startSec);
  const endBeat = beatPosition(grid, endSec);
  return {
    startBeat,
    endBeat,
    barsCount: (endBeat - startBeat) / Math.max(1, grid.meter),
  };
}

/**
 * Bereich ausschneiden und removing den Rest nachziehen (Delete/Cut mit Ripple).
 */
export function removeRange(target: EditableAudio, startSec: number, endSec: number): EditOutcome {
  const total = pcmSampleCount(target.audio);
  const range = clampRange(target.audio.sampleRate, total, startSec, endSec);
  const report = reportBase('REMOVE_RANGE', target);
  if (range.length <= 0) {
    report.warnings.push('Der Bereich ist leer – keine Änderung.');
    return { target, report };
  }

  const audio = pcmRemoveSamples(target.audio, range.startSample, range.endSample);
  const delta = -range.length / target.audio.sampleRate;
  const cues = shiftCues(target.cues, range.end, delta, { removeInside: [range.start, range.end] });
  const loops = shiftLoops(target.loops, range.end, delta, { removeInside: [range.start, range.end] });
  const beatGrid = rippleBeatGrid(
    target.beatGrid,
    [{ kind: 'remove', startSec: range.start, endSec: range.end }],
    pcmDuration(audio)
  );

  const newTarget: EditableAudio = { audio, cues: cues.cues, loops: loops.loops, beatGrid };
  const beats = describeBeats(target.beatGrid, range.start, range.end);
  Object.assign(report, beats, {
    sourceStart: range.start,
    sourceEnd: range.end,
    targetStart: range.start,
    targetEnd: range.start,
    durationSec: range.length / target.audio.sampleRate,
    removedSamples: range.length,
    samplesAfter: pcmSampleCount(audio),
    shiftedCues: cues.shifted,
    removedCues: cues.removed,
    shiftedLoops: loops.shifted,
    beatCountAfter: beatGrid.beats.length,
    description:
      `${(range.length / target.audio.sampleRate).toFixed(3)} s entfernt; ` +
      `${cues.shifted} Marker um ${Math.abs(delta).toFixed(3)} s nachgezogen, ` +
      `${cues.removed} Marker im Bereich gelöscht.`,
  });
  return { target: newTarget, report };
}

/**
 * Bereich ans Ende kopieren. Auf Wunsch wird bis zum nächsten Taktanfang aufgefüllt,
 * damit der Copy exakt im Beatgrid liegt (das erwartet ein DJ).
 */
export function copyRangeToEnd(
  target: EditableAudio,
  startSec: number,
  endSec: number,
  options: { alignToBar?: boolean } = {}
): EditOutcome {
  const alignToBar = options.alignToBar ?? true;
  const total = pcmSampleCount(target.audio);
  const range = clampRange(target.audio.sampleRate, total, startSec, endSec);
  const report = reportBase('COPY_TO_END', target);
  if (range.length <= 0) {
    report.warnings.push('Der Bereich ist leer – keine Änderung.');
    return { target, report };
  }

  const block = pcmSlice(target.audio, range.start, range.end);
  const sr = target.audio.sampleRate;
  let padSamples = 0;
  const blockBeats = (range.length / sr) / secondsPerBeat(target.beatGrid);
  if (Math.abs(blockBeats - Math.round(blockBeats)) > 1e-3) {
    report.warnings.push(
      `Der Copy ist ${(blockBeats).toFixed(2)} Beats lang und liegt damit nicht auf dem Beatgrid – ` +
      'Quantize einschalten oder Bereich über „Beats wählen“ setzen.'
    );
  }
  if (alignToBar) {
    const grid = target.beatGrid;
    const barSec = secondsPerBeat(grid) * Math.max(1, grid.meter);
    const endOfTrack = total / sr;
    const nextBarTime =
      grid.firstBeat + Math.ceil((endOfTrack - grid.firstBeat) / barSec - 1e-9) * barSec;
    padSamples = Math.max(0, Math.round(nextBarTime * sr) - total);
  }
  const pad = padSamples > 0 ? pcmSilence(target.audio, padSamples) : null;
  const audio = pad ? pcmConcat([target.audio, pad, block]) : pcmConcat([target.audio, block]);
  const beatGrid = regrowBeatGrid(target.beatGrid, pcmDuration(audio));
  const newTarget: EditableAudio = { audio, cues: target.cues, loops: target.loops, beatGrid };

  const appendedAtSample = total + padSamples;
  const beats = describeBeats(target.beatGrid, range.start, range.end);
  Object.assign(report, beats, {
    sourceStart: range.start,
    sourceEnd: range.end,
    targetStart: appendedAtSample / target.audio.sampleRate,
    targetEnd: (appendedAtSample + range.length) / target.audio.sampleRate,
    durationSec: range.length / target.audio.sampleRate,
    addedSamples: range.length + padSamples,
    padSamples,
    samplesAfter: pcmSampleCount(audio),
    beatCountAfter: beatGrid.beats.length,
    description:
      `${(range.length / target.audio.sampleRate).toFixed(3)} s kopiert und ans Ende gesetzt` +
      (padSamples > 0 ? ` (Stille bis zum Taktanfang: ${(padSamples / target.audio.sampleRate).toFixed(3)} s)` : '') +
      `. Original bleibt unverändert.`,
  });
  return { target: newTarget, report };
}

/**
 * Bereich an den Anfang setzen (Taktanfang) und dort entfernen, wo er war.
 * Material nach dem entfernten Bereich bleibt zeitlich an derselben Stelle.
 */
export function moveRangeToStart(
  target: EditableAudio,
  startSec: number,
  endSec: number,
  options: { atSec?: number } = {}
): EditOutcome {
  const total = pcmSampleCount(target.audio);
  const range = clampRange(target.audio.sampleRate, total, startSec, endSec);
  const report = reportBase('MOVE_TO_START', target);
  if (range.length <= 0) {
    report.warnings.push('Der Bereich ist leer – keine Änderung.');
    return { target, report };
  }

  const sr = target.audio.sampleRate;
  const atSec = Math.max(0, Math.min(options.atSec ?? target.beatGrid.firstBeat, range.start));
  const atSample = Math.floor(atSec * sr);
  const blockLenSec = range.length / sr;
  const block = pcmSlice(target.audio, range.start, range.end);

  // Zerlegung: alles vor der Zielposition, dann der Block, dann der Rest ohne den
  // alten Bereich. Material zwischen Zielposition und altem Bereich rückt nach rechts.
  const audio = pcmConcat([
    { sampleRate: sr, channels: target.audio.channels.map((c) => Float32Array.from(c.subarray(0, atSample))) },
    block,
    { sampleRate: sr, channels: target.audio.channels.map((c) => Float32Array.from(c.subarray(atSample, range.startSample))) },
    { sampleRate: sr, channels: target.audio.channels.map((c) => Float32Array.from(c.subarray(range.endSample, total))) },
  ]);

  const moveHead = atSample / sr + blockLenSec; // alles vor der Zielposition
  const cues: CuePoint[] = [];
  let moved = 0;
  for (const cue of [...target.cues].sort((x, y) => x.position - y.position)) {
    let position = cue.position;
    if (position >= range.start && position < range.end) {
      moved++;
      position = atSec + (position - range.start);
    } else if (position < atSec) {
      position += moveHead;
    } else if (position < range.start) {
      position += blockLenSec;
    }
    cues.push({ ...cue, position: Math.max(0, position), inMsec: Math.round(Math.max(0, position) * 1000) });
  }

  const loops: LoopPoint[] = [];
  for (const loop of target.loops) {
    let { start, end } = loop;
    if (start >= range.start && end <= range.end) {
      start = atSec + (start - range.start);
      end = atSec + (end - range.start);
    } else if (end <= atSec) {
      start += moveHead;
      end += moveHead;
    } else if (end <= range.start) {
      start += blockLenSec;
      end += blockLenSec;
    } else if (start >= range.end) {
      // bleibt an Ort und Stelle: links entfernt, links wieder eingefügt
    } else if (start < range.start && end > range.end) {
      end -= blockLenSec; // der herausgenommen Teil fehlt in der Mitte
    } else {
      continue;
    }
    if (end > start) loops.push({ ...loop, start, end, length: end - start });
  }
  const beatGrid = moveBeatGrid(target.beatGrid, range.start, range.end, atSec, pcmDuration(audio));

  const newTarget: EditableAudio = { audio, cues, loops, beatGrid };
  const beats = describeBeats(target.beatGrid, range.start, range.end);
  Object.assign(report, beats, {
    sourceStart: range.start,
    sourceEnd: range.end,
    targetStart: atSec,
    targetEnd: atSec + blockLenSec,
    durationSec: blockLenSec,
    addedSamples: 0,
    removedSamples: 0,
    movedCues: moved,
    samplesAfter: pcmSampleCount(audio),
    beatCountAfter: beatGrid.beats.length,
    description:
      `${blockLenSec.toFixed(3)} s an Position ${atSec.toFixed(3)} s gesetzt und an der ` +
      `Stelle ${range.start.toFixed(3)}–${range.end.toFixed(3)} s entfernt; ${moved} Marker wandern mit.`,
  });
  return { target: newTarget, report };
}

/** Alles ab einer Sampleposition (für Zerlegungen beim Verschieben). */
function pcmAfterSample(pcm: PcmAudio, fromSample: number): PcmAudio {
  const total = pcmSampleCount(pcm);
  const a = Math.max(0, Math.min(Math.floor(fromSample), total));
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((src) => Float32Array.from(src.subarray(a, total))),
  };
}

/** Ausschneiden (Cut): Bereich in die Zwischenablage und aus der Spur entfernen. */
export function cutRange(target: EditableAudio, startSec: number, endSec: number): { clip: PcmAudio } & EditOutcome {
  const total = pcmSampleCount(target.audio);
  const range = clampRange(target.audio.sampleRate, total, startSec, endSec);
  const clip = pcmSlice(target.audio, range.start, range.end);
  const outcome = removeRange(target, range.start, range.end);
  outcome.report.kind = 'REMOVE_RANGE';
  outcome.report.description = `Ausschnitten (${(range.length / target.audio.sampleRate).toFixed(3)} s) in die Ablage gelegt; ${outcome.report.description}`;
  return { clip, ...outcome };
}

/** Kopieren eines Bereichs in die Zwischenablage (ohne Änderung an der Spur). */
export function copyRange(target: EditableAudio, startSec: number, endSec: number): PcmAudio {
  const total = pcmSampleCount(target.audio);
  const range = clampRange(target.audio.sampleRate, total, startSec, endSec);
  return pcmSlice(target.audio, range.start, range.end);
}

/** Einfügen an Position: überschreibt, verlängert die Spur aber bei Bedarf. */
export function pasteAt(target: EditableAudio, atSec: number, clip: PcmAudio): EditOutcome {
  const report = reportBase('PASTE_AT', target);
  const atSample = Math.floor(Math.max(0, atSec) * target.audio.sampleRate);
  const clipSamples = pcmSampleCount(clip);
  if (clipSamples <= 0) {
    report.warnings.push('Die Zwischenablage ist leer.');
    return { target, report };
  }

  const audio = pcmOverwrite(target.audio, atSample, atSample + clipSamples, clip, { extendIfNeeded: true });
  const blockLenSec = clipSamples / target.audio.sampleRate;
  const beatGrid = regrowBeatGrid(target.beatGrid, pcmDuration(audio));
  const newTarget: EditableAudio = { audio, cues: target.cues, loops: target.loops, beatGrid };

  Object.assign(report, describeBeats(target.beatGrid, atSec, atSec + blockLenSec), {
    targetStart: atSec,
    targetEnd: atSec + blockLenSec,
    durationSec: blockLenSec,
    addedSamples: Math.max(0, pcmSampleCount(audio) - pcmSampleCount(target.audio)),
    samplesAfter: pcmSampleCount(audio),
    beatCountAfter: beatGrid.beats.length,
    description: `${blockLenSec.toFixed(3)} s ab ${atSec.toFixed(3)} s eingefügt (überschreibt den Bereich, ohne die Timeline zu verschieben).`,
  });
  return { target: newTarget, report };
}

/** Einschneiden (Insert): Clip in die Timeline schieben, alles danach rückt nach rechts. */
export function insertClipAt(target: EditableAudio, atSec: number, clip: PcmAudio): EditOutcome {
  const report = reportBase('INSERT_CLIP', target);
  const clipSamples = pcmSampleCount(clip);
  if (clipSamples <= 0) {
    report.warnings.push('Der Clip enthält keine Samples.');
    return { target, report };
  }

  const total = pcmSampleCount(target.audio);
  const at = Math.max(0, Math.min(Math.floor(atSec * target.audio.sampleRate), total));
  const audio = pcmInsertSamples(target.audio, at, clip);
  const blockLenSec = clipSamples / target.audio.sampleRate;
  const cues = shiftCues(target.cues, atSec, blockLenSec);
  const loops = shiftLoops(target.loops, atSec, blockLenSec);
  const beatGrid = rippleBeatGrid(
    target.beatGrid,
    [{ kind: 'insert', atSec, lengthSec: blockLenSec }],
    pcmDuration(audio)
  );
  const newTarget: EditableAudio = { audio, cues: cues.cues, loops: loops.loops, beatGrid };

  Object.assign(report, describeBeats(target.beatGrid, atSec, atSec + blockLenSec), {
    targetStart: atSec,
    targetEnd: atSec + blockLenSec,
    durationSec: blockLenSec,
    addedSamples: clipSamples,
    samplesAfter: pcmSampleCount(audio),
    shiftedCues: cues.shifted,
    shiftedLoops: loops.shifted,
    beatCountAfter: beatGrid.beats.length,
    description:
      `${blockLenSec.toFixed(3)} s an ${atSec.toFixed(3)} s eingeschnitten; ` +
      `${cues.shifted} Marker und ${loops.shifted} Loops um +${blockLenSec.toFixed(3)} s verschoben.`,
  });
  return { target: newTarget, report };
}

/** Ersetzen: Clip überschreibt genau den gewählten Bereich, Länge bleibt gleich. */
export function replaceRange(target: EditableAudio, startSec: number, endSec: number, clip: PcmAudio): EditOutcome {
  const total = pcmSampleCount(target.audio);
  const range = clampRange(target.audio.sampleRate, total, startSec, endSec);
  const report = reportBase('REPLACE_RANGE', target);
  const audio = pcmOverwrite(target.audio, range.startSample, range.endSample, clip);
  const newTarget: EditableAudio = { audio, cues: target.cues, loops: target.loops, beatGrid: target.beatGrid };
  Object.assign(report, describeBeats(target.beatGrid, range.start, range.end), {
    sourceStart: range.start,
    sourceEnd: range.end,
    targetStart: range.start,
    targetEnd: range.end,
    durationSec: range.length / target.audio.sampleRate,
    samplesAfter: pcmSampleCount(audio),
    description:
      `Bereich ${range.start.toFixed(3)}–${range.end.toFixed(3)} s durch den Clip ersetzt` +
      (pcmSampleCount(clip) < range.length
        ? `; der Rest des Bereichs ist danach still (Clip war kürzer).` : `.`),
  });
  return { target: newTarget, report };
}

/** Overdub: Clip über den gewählten Bereich mischen (Sättigung statt Clipping). */
/**
 * Clip über einen Bereich mischen (Overdub). Länge, Cues, Loops und Beatgrid
 * bleiben unangetastet.
 *
 * Pegel: linear addieren, aber nie über die Obergrenze. Früher begrenzte ein
 * tanh die Summe – das verbog jedes Sample im Überlappungsbereich, auch die
 * leisen des Vorhandenen. Jetzt wird nur der zugeführte Clip so weit leiser
 * gerechnet, dass |dry| + |wet| garantiert unter `ceiling` bleibt; das
 * vorhandene Material bleibt bitgenau, außer es wäre ohne Zutun schon darüber –
 * dann geht der Bereich als Ganzes auf die Obergrenze (`regionScale`) und der
 * Bericht sagt das.
 */
export function overdubRange(
  target: EditableAudio,
  startSec: number,
  endSec: number,
  clip: PcmAudio,
  gain = 1,
  options: { ceiling?: number } = {}
): OverdubOutcome {
  const total = pcmSampleCount(target.audio);
  const range = clampRange(target.audio.sampleRate, total, startSec, endSec);
  const report = reportBase('OVERDUB_RANGE', target);
  const mix = pcmMixHeadroom(target.audio, range.startSample, clip, gain, range.length, options.ceiling ?? 0.999);
  const audio = mix.pcm;
  const newTarget: EditableAudio = { audio, cues: target.cues, loops: target.loops, beatGrid: target.beatGrid };
  const notes: string[] = [];
  if (mix.attenuated) {
    notes.push(
      `Clip-Pegel von ${gain.toFixed(3)} auf ${mix.gainUsed.toFixed(3)} gesenkt (${dbText(mix.gainUsed / gain)}) – ` +
        'die Summe bleibt unter der Obergrenze'
    );
  }
  if (mix.regionScale < 1) {
    notes.push(`Überlappungsbereich um ${dbText(mix.regionScale)} abgesenkt, weil das vorhandene Material bereits über der Obergrenze lag`);
    report.warnings.push('Vorhandenes Material war übersteuernd – Bereich angeglichen, Clip nicht hart begrenzt.');
  }
  Object.assign(report, describeBeats(target.beatGrid, range.start, range.end), {
    targetStart: range.start,
    targetEnd: range.end,
    durationSec: range.length / target.audio.sampleRate,
    samplesAfter: pcmSampleCount(audio),
    description:
      `Clip mit Verstärkung ${mix.gainUsed.toFixed(3)} über ${range.start.toFixed(3)}–${range.end.toFixed(3)} s gemischt ` +
      `(Peak danach ${mix.peakAfter.toFixed(3)})${notes.length ? ' – ' + notes.join('; ') : ''}.`,
  });
  return { target: newTarget, report, mix };
}

function dbText(ratio: number): string {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return '−∞ dB';
  return `${(20 * Math.log10(ratio)).toFixed(1)} dB`;
}

/** Bereich stummschalten (Clear), Länge und Beatgrid bleiben unangetastet. */
export function silenceRange(target: EditableAudio, startSec: number, endSec: number): EditOutcome {
  const total = pcmSampleCount(target.audio);
  const range = clampRange(target.audio.sampleRate, total, startSec, endSec);
  const report = reportBase('SILENCE_RANGE', target);
  const audio = pcmOverwrite(target.audio, range.startSample, range.endSample, null);
  const newTarget: EditableAudio = { audio, cues: target.cues, loops: target.loops, beatGrid: target.beatGrid };
  Object.assign(report, describeBeats(target.beatGrid, range.start, range.end), {
    targetStart: range.start,
    targetEnd: range.end,
    durationSec: range.length / target.audio.sampleRate,
    samplesAfter: pcmSampleCount(audio),
    description: `${(range.length / target.audio.sampleRate).toFixed(3)} s stummgeschaltet; Timeline-Dauer unverändert.`,
  });
  return { target: newTarget, report };
}
