/**
 * @license
 * airdox Track-Part Detection Engine
 *
 * Segmentiert einen Track anhand der realen Wellenform-Spektralenergie
 * (Low/Mid/High + Peak pro Takt) in musikalische Parts:
 * INTRO, UP (Build-Up), DROP, BREAKDOWN (Break), CHORUS, VERSE, OUTRO.
 *
 * Die erkannten Parts werden als farbige Sektionen unter der Wellenform
 * gerendert; ihre Startpunkte (Drop, Break, Build) sind die prägnanten
 * Stellen, an denen automatische Cue-Punkte gesetzt werden.
 *
 * Die Analyse arbeitet ausschließlich auf vorhandenen Analyse-Buckets
 * (ANLZ oder lokale Analyse) — es wird niemals eine Struktur ohne echte
 * Wellenform-Daten erfunden. Ohne Analyse liefert die Funktion `null`.
 */

import { TrackModel, PhraseSection, DataOrigin } from '../types/rekordbox';

/** Rekordbox-nahe Part-Farben, geteilt zwischen Analyse und Rendering. */
export const PART_COLORS: Record<PhraseSection['name'], string> = {
  INTRO: '#3b82f6', // Blau
  UP: '#10b981', // Grün (Build-Up)
  DOWN: '#6366f1', // Indigo
  CHORUS: '#f59e0b', // Amber
  BREAKDOWN: '#8b5cf6', // Violett (Break)
  DROP: '#ef4444', // Rot
  OUTRO: '#60a5fa', // Hellblau
  VERSE: '#64748b', // Grau
  BRIDGE: '#14b8a6', // Teal
};

/** Ein Analyse-Block umfasst 4 Takte — die kleinste musikalische Part-Einheit. */
const BLOCK_BARS = 4;

/** Energie-Sprung zwischen Blöcken, der eine neue Sektion beginnt. */
const ENERGY_BOUNDARY = 0.18;
/** Bass-Sprung zwischen Blöcken, der eine neue Sektion beginnt (Kick rein/raus). */
const BASS_BOUNDARY = 0.25;

interface BlockFeature {
  /** 1-basierte Taktnummer des Blockanfangs. */
  startBar: number;
  bars: number;
  energy: number; // 0..1 relativ zum Track-Maximum
  low: number;
  mid: number;
  high: number;
}

interface Segment {
  startBar: number; // 1-basiert
  endBar: number; // exklusiv
  blocks: BlockFeature[];
  energy: number;
  low: number;
  high: number;
  rising: boolean;
  name?: PhraseSection['name'];
}

/**
 * Erkennt die musikalischen Parts eines Tracks aus seiner echten
 * Wellenform-Analyse. Grenzen liegen immer auf 4-Takt-Blöcken des Beatgrids
 * (Taktstriche), damit Cue-Punkte quantisiert auf dem Downbeat sitzen.
 *
 * @returns PhraseSection[] mit origin LOCAL_ANALYSIS oder `null`,
 *          wenn keine Analyse-Buckets vorhanden sind.
 */
export function detectTrackParts(track: TrackModel): PhraseSection[] | null {
  const analysis = track.analysis;
  if (!analysis || analysis.length === 0) return null;

  const meter = track.beatGrid?.meter || 4;
  const bpm = track.bpm > 0 ? track.bpm : track.beatGrid?.bpm || 128;
  const secPerBar = (60.0 / bpm) * meter;
  const firstBeat = Math.max(0, track.beatGrid?.firstBeat || 0);
  const duration = Math.max(1, track.duration);
  const totalBars = Math.floor((duration - firstBeat) / secPerBar);
  if (totalBars < BLOCK_BARS * 2) return null;

  const buckets = analysis.length;
  const secPerBucket = analysis.secPerBucket || duration / buckets;

  // 1. Takt-Features aus den realen Analyse-Buckets mitteln
  const barEnergy = new Float64Array(totalBars);
  const barLow = new Float64Array(totalBars);
  const barMid = new Float64Array(totalBars);
  const barHigh = new Float64Array(totalBars);

  for (let b = 0; b < totalBars; b++) {
    const t0 = firstBeat + b * secPerBar;
    const t1 = t0 + secPerBar;
    const k0 = Math.max(0, Math.floor(t0 / secPerBucket));
    const k1 = Math.min(buckets - 1, Math.ceil(t1 / secPerBucket));

    let sumPeak = 0;
    let sumLow = 0;
    let sumMid = 0;
    let sumHigh = 0;
    let count = 0;
    for (let k = k0; k <= k1; k++) {
      sumPeak += analysis.peaks[k] || 0;
      sumLow += analysis.lowEnergy[k] || 0;
      sumMid += analysis.midEnergy[k] || 0;
      sumHigh += analysis.highEnergy[k] || 0;
      count++;
    }
    const c = Math.max(1, count);
    const peak = sumPeak / c;
    const low = sumLow / c;
    const mid = sumMid / c;
    const high = sumHigh / c;

    barLow[b] = low;
    barMid[b] = mid;
    barHigh[b] = high;
    // Gewichtete Gesamt-Energie: Bass dominiert die Club-Wahrnehmung.
    barEnergy[b] = peak * 0.35 + low * 0.45 + mid * 0.2;
  }

  // 2. Robuste Normalisierung gegen das 95. Perzentil (Ausreißer-sicher)
  const robustRef = (values: Float64Array): number => {
    const sorted = Array.from(values).sort((a, b) => a - b);
    const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return ref > 0.0001 ? ref : 1;
  };
  const refE = robustRef(barEnergy);
  const refLow = robustRef(barLow);
  const refHigh = robustRef(barHigh);

  // 3. 4-Takt-Blöcke bilden (Grenzen bleiben auf den Taktstrichen)
  const blocks: BlockFeature[] = [];
  for (let b0 = 0; b0 < totalBars; b0 += BLOCK_BARS) {
    const b1 = Math.min(totalBars, b0 + BLOCK_BARS);
    let e = 0;
    let lo = 0;
    let mi = 0;
    let hi = 0;
    for (let b = b0; b < b1; b++) {
      e += Math.min(1, barEnergy[b] / refE);
      lo += Math.min(1, barLow[b] / refLow);
      mi += barMid[b];
      hi += Math.min(1, barHigh[b] / refHigh);
    }
    const n = b1 - b0;
    blocks.push({
      startBar: b0 + 1,
      bars: n,
      energy: e / n,
      low: lo / n,
      mid: mi / n,
      high: hi / n,
    });
  }
  if (blocks.length < 2) return null;

  // 4. Segmentierung: Neue Sektion, sobald sich das Energie-/Bass-Profil
  //    eines Blocks deutlich vom laufenden Segment unterscheidet.
  const segments: Segment[] = [];
  let currentBlocks: BlockFeature[] = [blocks[0]];

  const segmentAverage = (list: BlockFeature[]) => {
    let e = 0;
    let lo = 0;
    let hi = 0;
    let bars = 0;
    list.forEach((bl) => {
      e += bl.energy * bl.bars;
      lo += bl.low * bl.bars;
      hi += bl.high * bl.bars;
      bars += bl.bars;
    });
    const n = Math.max(1, bars);
    return { energy: e / n, low: lo / n, high: hi / n, bars };
  };

  const flushSegment = () => {
    if (currentBlocks.length === 0) return;
    const avg = segmentAverage(currentBlocks);
    const first = currentBlocks[0];
    const last = currentBlocks[currentBlocks.length - 1];
    segments.push({
      startBar: first.startBar,
      endBar: last.startBar + last.bars,
      blocks: currentBlocks,
      energy: avg.energy,
      low: avg.low,
      high: avg.high,
      // Riser/Build-Erkennung: Energie oder Höhen steigen innerhalb des Segments.
      rising:
        last.energy - first.energy > 0.06 ||
        last.high - first.high > 0.15,
    });
    currentBlocks = [];
  };

  for (let i = 1; i < blocks.length; i++) {
    const avg = segmentAverage(currentBlocks);
    const bl = blocks[i];
    const energyJump = Math.abs(bl.energy - avg.energy);
    const bassJump = Math.abs(bl.low - avg.low);
    if (energyJump > ENERGY_BOUNDARY || bassJump > BASS_BOUNDARY) {
      flushSegment();
    }
    currentBlocks.push(bl);
  }
  flushSegment();

  // 5. Klassifizierung der Segmente relativ zum Track-Maximum
  segments.forEach((seg, i) => {
    const next = segments[i + 1];
    const isFirst = i === 0;
    const isLast = i === segments.length - 1;

    if (isFirst && seg.energy < 0.55) {
      seg.name = 'INTRO';
      return;
    }
    if (isLast && seg.energy < 0.6) {
      seg.name = 'OUTRO';
      return;
    }
    if (seg.energy >= 0.78 && seg.low >= 0.6) {
      seg.name = 'DROP';
      return;
    }
    // Steigende Energie direkt vor einem energiereichen Part → Build-Up
    if (next && next.energy >= 0.75 && seg.rising && seg.energy < 0.75) {
      seg.name = 'UP';
      return;
    }
    // Wenig Bass mitten im Track → Break(down)
    if (seg.low <= 0.45 && seg.energy <= 0.7) {
      seg.name = 'BREAKDOWN';
      return;
    }
    if (seg.energy >= 0.62) {
      seg.name = 'CHORUS';
      return;
    }
    seg.name = 'VERSE';
  });

  // 6. Benachbarte Segmente mit identischem Part-Namen zusammenfassen
  const merged: Segment[] = [];
  segments.forEach((seg) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.name === seg.name) {
      prev.endBar = seg.endBar;
      const bars = prev.endBar - prev.startBar;
      const prevBars = bars - (seg.endBar - seg.startBar);
      const segBars = seg.endBar - seg.startBar;
      prev.energy = (prev.energy * prevBars + seg.energy * segBars) / Math.max(1, bars);
      prev.low = (prev.low * prevBars + seg.low * segBars) / Math.max(1, bars);
    } else {
      merged.push(seg);
    }
  });

  // 7. In PhraseSections mit klar deklarierter lokaler Analyse-Herkunft mappen
  return merged.map((seg, i) => {
    const isLast = i === merged.length - 1;
    return {
      id: `part-${i + 1}`,
      name: seg.name || 'VERSE',
      startBar: seg.startBar,
      endBar: seg.endBar,
      startTime: Math.max(0, firstBeat + (seg.startBar - 1) * secPerBar),
      endTime: isLast
        ? duration
        : Math.min(duration, firstBeat + (seg.endBar - 1) * secPerBar),
      color: PART_COLORS[seg.name || 'VERSE'],
      origin: DataOrigin.LOCAL_ANALYSIS,
    } satisfies PhraseSection;
  });
}
