/**
 * Track part detection from real buckets (4-bar blocks, energy/bass boundaries, INTRO/UP/DROP/BREAKDOWN classification)
 */

export interface PhraseSegment {
  id: string;
  startSeconds: number;
  endSeconds: number;
  bars: number;
  type: 'INTRO' | 'VERSE' | 'BUILD' | 'DROP' | 'BREAKDOWN' | 'OUTRO' | 'UP' | 'DOWN';
  energy: number;
  bassEnergy: number;
  confidence: number;
}

export interface Beat {
  time: number;
  bpm: number;
}

export interface AnalysisBuckets {
  data: Float32Array | number[];
  sampleRate?: number;
  channels?: number;
}

export function detectPhrases(beats: Beat[], buckets: AnalysisBuckets | null, duration: number): PhraseSegment[] {
  if (!beats || beats.length === 0 || duration <= 0) return [];

  const bpm = beats[0]?.bpm || 128;
  const barDuration = (60 / bpm) * 4; // 4 beats per bar
  const totalBars = Math.floor(duration / barDuration);

  // If we have real buckets, use energy analysis
  let energies: number[] = [];
  if (buckets && buckets.data) {
    const data = buckets.data;
    const bucketsPerBar = Math.max(1, Math.floor(data.length / Math.max(1, totalBars)));
    for (let bar = 0; bar < totalBars; bar++) {
      let sum = 0;
      let count = 0;
      for (let i = bar * bucketsPerBar; i < Math.min(data.length, (bar + 1) * bucketsPerBar); i++) {
        sum += Math.abs((data as any)[i] || 0);
        count++;
      }
      energies.push(count ? sum / count : 0);
    }
  } else {
    // Fallback: uniform energy
    energies = new Array(totalBars).fill(0.5);
  }

  // Detect boundaries via energy/bass changes
  const segments: PhraseSegment[] = [];
  let currentStartBar = 0;
  let currentEnergy = energies[0] || 0.5;

  for (let bar = 1; bar < totalBars; bar++) {
    const energy = energies[bar] || 0;
    const delta = Math.abs(energy - currentEnergy);
    const isBoundary = delta > 0.3 || bar % 16 === 0; // 16-bar phrases typical in EDM

    if (isBoundary || bar === totalBars - 1) {
      const startSec = currentStartBar * barDuration;
      const endSec = bar * barDuration;
      const bars = bar - currentStartBar;
      const avgEnergy = energies.slice(currentStartBar, bar).reduce((a, b) => a + b, 0) / Math.max(1, bars);

      let type: PhraseSegment['type'] = 'VERSE';
      if (currentStartBar === 0) type = 'INTRO';
      else if (bar === totalBars) type = 'OUTRO';
      else if (avgEnergy > 0.7) type = 'DROP';
      else if (avgEnergy > 0.5) type = 'BUILD';
      else if (avgEnergy < 0.3) type = 'BREAKDOWN';
      else type = 'VERSE';

      segments.push({
        id: `seg_${currentStartBar}_${bar}`,
        startSeconds: startSec,
        endSeconds: Math.min(endSec, duration),
        bars,
        type,
        energy: avgEnergy,
        bassEnergy: avgEnergy * 0.8, // simplified
        confidence: 0.8,
      });

      currentStartBar = bar;
      currentEnergy = energy;
    }
  }

  // Merge short segments (<4 bars) into neighbors
  const merged: PhraseSegment[] = [];
  for (const seg of segments) {
    if (seg.bars < 4 && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.endSeconds = seg.endSeconds;
      prev.bars += seg.bars;
      prev.energy = (prev.energy + seg.energy) / 2;
    } else {
      merged.push(seg);
    }
  }

  return merged;
}

export function classifyEnergyLevel(energy: number): 'low' | 'mid' | 'high' {
  if (energy < 0.33) return 'low';
  if (energy < 0.66) return 'mid';
  return 'high';
}
