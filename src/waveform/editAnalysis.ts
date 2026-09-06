/**
 * @license
 * Wellenform durch einen Eingriff tragen, statt sie neu zu erfinden.
 *
 * Die importierten Kurven (PWAV/PWV3…PWV7) sind Buckets mit einer festen Zeit
 * pro Bucket: `Spurdauer / Bucketanzahl`. Ein Schnitt in der Zeitachse ist im
 * Bucket-Raum dieselbe Operation an ganzen Indizes – Wegnehmen, Einfügen,
 * Umhängen. Was dabei unangetastet bleibt, muss deshalb Bit für Bit derselbe
 * Wert bleiben; gerechnet wird nur das Fenster, das das Material selbst nicht
 * mehr hergibt, und zwar in der Auflösung der importierten Spur.
 *
 * Genau das ist die Umsetzung von „Bearbeiten ≠ neu analysieren“: Der Editor
 * wirft nach einem Eingriff nicht die ganze Analyse weg.
 */

import { DataOrigin, WaveformAnalysisData } from '../types/rekordbox';
import { PcmAudio } from '../audio/pcm';
import { analyzePcmWindow } from './analyzer';

export type AnalysisEdit =
  /** Material wurde herausgenommen: die Buckets dahinter rücken nach vorne. */
  | { kind: 'remove'; startSec: number; endSec: number }
  /** Material wurde eingefügt: ab der Stelle rücken die Buckets nach hinten. */
  | { kind: 'insert'; atSec: number; lengthSec: number }
  /** Bereich wurde überlagert oder ersetzt: nur dieses Fenster ist neu. */
  | { kind: 'overlay'; startSec: number; endSec: number }
  /** Block wurde versetzt: die Buckets hängen um, nichts wird gerechnet. */
  | { kind: 'move'; fromStart: number; fromEnd: number; toStart: number };

export interface CarriedAnalysis {
  analysis: WaveformAnalysisData;
  /** Zeitbereiche, die nicht aus der Importkurve stammen. */
  recomputed: { startSec: number; endSec: number }[];
  /** Sekunden pro Bucket – gleich geblieben, deshalb bleiben die Werte gültig. */
  bucketDurationSec: number;
}

/** Zeit pro Bucket einer Kurve; 0, wenn nichts importiert ist. */
export function bucketDurationSec(analysis: WaveformAnalysisData | null | undefined, durationSec: number): number {
  if (!analysis || analysis.length <= 0 || durationSec <= 0) return 0;
  return durationSec / analysis.length;
}

/** Wie viele Buckets einer Kurve nach einem Eingriff eigener Rechnung sind. */
export function recomputedBucketCount(analysis: WaveformAnalysisData, durationSec: number): number {
  if (!analysis.recomputed || analysis.recomputed.length === 0 || analysis.length <= 0) return 0;
  const bd = durationSec / analysis.length;
  if (!(bd > 0)) return 0;
  let total = 0;
  for (const range of analysis.recomputed) {
    total += Math.max(1, Math.ceil((range.endSec - range.startSec) / bd));
  }
  return Math.min(analysis.length, total);
}

interface Piece {
  /** Zielindex im neuen Raster. */
  at: number;
  /** Quellindex in der Importkurve; -1 heißt: dieses Fenster muss gerechnet werden. */
  from: number;
  count: number;
}

/**
 * Überträgt die Importkurve durch einen Eingriff. `null` heißt: hier lässt sich
 * nichts tragen (keine Importkurve, falsche Größenverhältnisse) – der Aufrufer
 * soll dann vollständig neu rechnen und das auch beschriften.
 */
export function carryAnalysisThroughEdit(
  prev: WaveformAnalysisData | null | undefined,
  prevDurationSec: number,
  edit: AnalysisEdit,
  next: PcmAudio,
  nextDurationSec: number,
  origin: DataOrigin = DataOrigin.PROJECT
): CarriedAnalysis | null {
  if (!prev || prev.length <= 0 || prevDurationSec <= 0 || nextDurationSec <= 0) return null;
  const bd = prevDurationSec / prev.length;
  if (!(bd > 0) || !Number.isFinite(bd)) return null;
  const prevLength = prev.length;
  const index = (seconds: number) =>
    Math.max(0, Math.min(prevLength, Math.floor(seconds / bd)));
  const indexUp = (seconds: number) =>
    Math.max(0, Math.min(prevLength, Math.ceil(seconds / bd)));

  const pieces: Piece[] = [];
  const push = (at: number, from: number, count: number) => {
    if (count > 0) pieces.push({ at, from, count });
  };

  switch (edit.kind) {
    case 'remove': {
      const bStart = index(edit.startSec);
      const bEnd = Math.max(bStart, indexUp(edit.endSec));
      push(0, 0, bStart);
      push(bStart, bEnd, prevLength - bEnd);
      break;
    }
    case 'insert': {
      const bAt = index(edit.atSec);
      const inserted = Math.max(1, Math.ceil(edit.lengthSec / bd));
      push(0, 0, bAt);
      push(bAt, -1, inserted);
      push(bAt + inserted, bAt, prevLength - bAt);
      break;
    }
    case 'overlay': {
      const bStart = index(edit.startSec);
      const bEnd = Math.max(bStart + 1, indexUp(edit.endSec));
      push(0, 0, bStart);
      push(bStart, -1, bEnd - bStart);
      push(bEnd, bEnd, prevLength - bEnd);
      break;
    }
    case 'move': {
      const bFromStart = index(edit.fromStart);
      const bFromEnd = Math.max(bFromStart, indexUp(edit.fromEnd));
      const bToStart = Math.max(0, Math.min(edit.toStart <= edit.fromStart ? index(edit.toStart) : bFromStart, bFromStart));
      const moved = bFromEnd - bFromStart;
      if (moved <= 0) return null;
      // Zeitachse danach: Kopf bis zur Zielposition, der Block, das dazwischen
      // liegende Material (nach rechts gerückt), der Rest.
      push(0, 0, bToStart);
      push(bToStart, bFromStart, moved);
      push(bToStart + moved, bToStart, bFromStart - bToStart);
      push(bToStart + moved + (bFromStart - bToStart), bFromEnd, prevLength - bFromEnd);
      break;
    }
    default:
      return null;
  }

  const length = Math.max(1, Math.ceil(nextDurationSec / bd));
  const out: WaveformAnalysisData = {
    length,
    peaks: new Float32Array(length),
    peaksL: new Float32Array(length),
    peaksR: new Float32Array(length),
    lowEnergy: new Float32Array(length),
    midEnergy: new Float32Array(length),
    highEnergy: new Float32Array(length),
    origin: prev.origin ?? origin,
  };
  const copy = (target: Float32Array, source: Float32Array, at: number, from: number, count: number) => {
    const usable = Math.max(0, Math.min(count, length - at, source.length - from));
    if (usable > 0) target.set(source.subarray(from, from + usable), at);
  };
  for (const piece of pieces) {
    if (piece.from < 0) continue;
    copy(out.peaks, prev.peaks, piece.at, piece.from, piece.count);
    copy(out.peaksL, prev.peaksL, piece.at, piece.from, piece.count);
    copy(out.peaksR, prev.peaksR, piece.at, piece.from, piece.count);
    copy(out.lowEnergy, prev.lowEnergy, piece.at, piece.from, piece.count);
    copy(out.midEnergy, prev.midEnergy, piece.at, piece.from, piece.count);
    copy(out.highEnergy, prev.highEnergy, piece.at, piece.from, piece.count);
  }

  // Nur die Fenster eigener Rechnung – in der Auflösung der importierten Kurve.
  const recomputed: { startSec: number; endSec: number }[] = [];
  for (const piece of pieces) {
    if (piece.from >= 0) continue;
    const at = Math.min(length - 1, Math.max(0, piece.at));
    const count = Math.max(1, Math.min(piece.count, length - at));
    const window = analyzePcmWindow(
      next,
      at * bd,
      Math.min(nextDurationSec, (at + count) * bd),
      bd,
      origin
    );
    copy(out.peaks, window.peaks, at, 0, count);
    copy(out.peaksL, window.peaksL, at, 0, count);
    copy(out.peaksR, window.peaksR, at, 0, count);
    copy(out.lowEnergy, window.lowEnergy, at, 0, count);
    copy(out.midEnergy, window.midEnergy, at, 0, count);
    copy(out.highEnergy, window.highEnergy, at, 0, count);
    recomputed.push({ startSec: at * bd, endSec: Math.min(nextDurationSec, (at + count) * bd) });
  }
  out.recomputed = recomputed.length > 0 ? recomputed : undefined;
  return { analysis: out, recomputed, bucketDurationSec: bd };
}
