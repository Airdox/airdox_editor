/**
 * @license
 * airdox DJ Smart Copilot - Mix-In & Energy Phrase Analysis Engine
 * Analyzes track waveform spectral energy (low/mid/high) across musical phrase structures
 * to calculate and propose optimal DJ mix-in points, transition windows, and cue placements.
 */

import { TrackModel, PhraseSection, DataOrigin, CuePoint } from '../types/rekordbox';
import { analyzeAudioBuffer } from '../waveform/analyzer';

export type MixInType =
  | 'PRIMARY_BLEND'      // Optimal standard 16-32 bar mix-in (kicks lock in, low clash)
  | 'EXTENDED_INTRO'     // Bar 1 / early beat for long progressive blends
  | 'HIGH_ENERGY_DROP'   // Direct drop/chorus cut for quick mix & drop swaps
  | 'BUILD_UP_TENSION';  // Build-up section for ramping energy into drop

export interface MixInPointCandidate {
  id: string;
  type: MixInType;
  label: string;
  barNumber: number;
  beatNumber: number;
  timeSeconds: number;
  timeFormatted: string; // e.g. "0:31.23"
  phraseName: string;
  phraseDurationBars: number;
  energyPercent: number;
  bassEnergyPercent: number;
  midEnergyPercent: number;
  highEnergyPercent: number;
  energyDescription: string;
  recommendationScore: number; // 0 - 100
  djMixingRationale: string;
  transitionLengthBars: number; // e.g. 16 or 32 bars
  suggestedCueSlot: 'A' | 'B' | 'C' | 'D' | 'MEMORY';
  isRecommendedPrimary: boolean;
}

export interface PhraseEnergySummary {
  id: string;
  name: PhraseSection['name'] | string;
  startBar: number;
  endBar: number;
  startTime: number;
  endTime: number;
  durationBars: number;
  color: string;
  energyPercent: number;
  bassPercent: number;
  midPercent: number;
  highPercent: number;
}

export interface MixInAnalysisReport {
  trackId: string;
  trackTitle: string;
  artist: string;
  bpm: number;
  key: string;
  durationSeconds: number;
  totalBars: number;
  optimalPoint: MixInPointCandidate;
  allCandidates: MixInPointCandidate[];
  energySummary: {
    introAvgEnergy: number;
    bodyAvgEnergy: number;
    peakEnergy: number;
    peakBar: number;
    kickEntryBar: number;
    kickEntryTime: number;
    energyDynamicRange: 'HIGH' | 'MEDIUM' | 'STEADY';
  };
  phraseEnergies: PhraseEnergySummary[];
  djStrategyAdvice: string;
}

/**
 * Format seconds into mm:ss.xx
 */
export function formatTimePrecise(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00.00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const wholeSecs = Math.floor(secs);
  const centiSecs = Math.floor((secs - wholeSecs) * 100);
  return `${mins}:${wholeSecs.toString().padStart(2, '0')}.${centiSecs.toString().padStart(2, '0')}`;
}

/**
 * Ensures a track has phrase sections. If none exist, generates
 * standard Rekordbox-aligned arrangement phrases.
 */
export function resolveTrackPhrases(track: TrackModel): PhraseSection[] {
  if (track.phrases && track.phrases.length > 0) {
    return track.phrases;
  }

  const bpm = track.bpm || 128.0;
  const secPerBeat = 60.0 / bpm;
  const secPerBar = secPerBeat * 4.0;
  const totalBars = Math.max(1, Math.floor(track.duration / secPerBar));
  const firstBeat = track.beatGrid?.firstBeat || 0.0;

  const phrases: PhraseSection[] = [];
  let currentBar = 1;

  // Standard electronic arrangement template
  const template: { name: PhraseSection['name']; bars: number; color: string }[] = [
    { name: 'INTRO', bars: 16, color: '#3b82f6' },      // Blue
    { name: 'UP', bars: 16, color: '#10b981' },         // Green (Build-up)
    { name: 'CHORUS', bars: 32, color: '#f59e0b' },     // Amber (Drop 1)
    { name: 'BREAKDOWN', bars: 16, color: '#8b5cf6' },  // Purple
    { name: 'DROP', bars: 32, color: '#ef4444' },       // Red (Drop 2)
    { name: 'CHORUS', bars: 32, color: '#f59e0b' },     // Amber
    { name: 'OUTRO', bars: 16, color: '#3b82f6' },      // Blue
  ];

  for (let i = 0; i < template.length && currentBar <= totalBars; i++) {
    const t = template[i];
    const barsInPhrase = Math.min(t.bars, totalBars - currentBar + 1);
    const startBar = currentBar;
    const endBar = currentBar + barsInPhrase;
    const startTime = firstBeat + (startBar - 1) * secPerBar;
    const endTime = firstBeat + (endBar - 1) * secPerBar;

    phrases.push({
      id: `phrase-${i + 1}`,
      name: t.name,
      startBar,
      endBar,
      startTime: Math.max(0, startTime),
      endTime: Math.min(track.duration, endTime),
      color: t.color,
      origin: DataOrigin.GENERATED_FALLBACK,
    });

    currentBar += barsInPhrase;
  }

  return phrases;
}

/**
 * Main analysis function: computes energy levels, phrase metrics,
 * and pinpoints the optimal mix-in candidates.
 */
export function analyzeTrackForMixIn(track: TrackModel): MixInAnalysisReport {
  const bpm = track.bpm || 128.0;
  const secPerBeat = 60.0 / bpm;
  const secPerBar = secPerBeat * 4.0;
  const duration = Math.max(1.0, track.duration);
  const totalBars = Math.max(1, Math.floor(duration / secPerBar));
  const firstBeat = track.beatGrid?.firstBeat || 0.0;

  // 1. Ensure waveform analysis is present
  let analysis = track.analysis;
  if (!analysis && track.audioBuffer) {
    try {
      analysis = analyzeAudioBuffer(track.audioBuffer);
    } catch (err) {
      console.warn('[MixAnalysis] AudioBuffer analysis failed:', err);
    }
  }

  // 2. Resolve phrase sections
  const phrases = resolveTrackPhrases(track);

  // 3. Compute bar-by-bar energy profile
  const barEnergies: {
    bar: number;
    time: number;
    peak: number;
    low: number;
    mid: number;
    high: number;
    overall: number;
  }[] = [];

  const buckets = analysis?.length || 0;
  const secPerBucket = analysis?.secPerBucket || (buckets > 0 ? duration / buckets : 0.005);

  for (let b = 1; b <= totalBars; b++) {
    const barStart = firstBeat + (b - 1) * secPerBar;
    const barEnd = barStart + secPerBar;

    if (analysis && buckets > 0) {
      const startBucket = Math.max(0, Math.floor(barStart / secPerBucket));
      const endBucket = Math.min(buckets - 1, Math.ceil(barEnd / secPerBucket));
      let sumPeak = 0;
      let sumLow = 0;
      let sumMid = 0;
      let sumHigh = 0;
      let count = 0;

      for (let k = startBucket; k <= endBucket; k++) {
        sumPeak += analysis.peaks[k] || 0;
        sumLow += analysis.lowEnergy[k] || 0;
        sumMid += analysis.midEnergy[k] || 0;
        sumHigh += analysis.highEnergy[k] || 0;
        count++;
      }

      const c = Math.max(1, count);
      const avgPeak = sumPeak / c;
      const avgLow = sumLow / c;
      const avgMid = sumMid / c;
      const avgHigh = sumHigh / c;
      const overall = avgPeak * 0.4 + avgLow * 0.4 + avgMid * 0.2;

      barEnergies.push({
        bar: b,
        time: barStart,
        peak: avgPeak,
        low: avgLow,
        mid: avgMid,
        high: avgHigh,
        overall,
      });
    } else {
      // Synthetic fallback curve if no audio buffer or analysis buckets exist
      let simulatedOverall = 0.25;
      let simulatedLow = 0.15;
      let simulatedMid = 0.3;
      let simulatedHigh = 0.2;

      if (b <= 16) {
        // Intro (rising)
        simulatedOverall = 0.2 + (b / 16) * 0.25;
        simulatedLow = b >= 9 ? 0.45 : 0.15;
      } else if (b <= 32) {
        // Build-up
        simulatedOverall = 0.45 + ((b - 16) / 16) * 0.35;
        simulatedLow = 0.55;
        simulatedHigh = 0.6;
      } else if (b <= 64) {
        // Drop 1
        simulatedOverall = 0.88;
        simulatedLow = 0.9;
        simulatedMid = 0.7;
      } else {
        simulatedOverall = 0.6;
        simulatedLow = 0.6;
      }

      barEnergies.push({
        bar: b,
        time: barStart,
        peak: simulatedOverall,
        low: simulatedLow,
        mid: simulatedMid,
        high: simulatedHigh,
        overall: simulatedOverall,
      });
    }
  }

  // 4. Summarize Phrase Energies
  const phraseEnergies: PhraseEnergySummary[] = phrases.map((p) => {
    const barsInP = barEnergies.filter((be) => be.bar >= p.startBar && be.bar < p.endBar);
    const count = Math.max(1, barsInP.length);
    const avgOverall = barsInP.reduce((acc, curr) => acc + curr.overall, 0) / count;
    const avgLow = barsInP.reduce((acc, curr) => acc + curr.low, 0) / count;
    const avgMid = barsInP.reduce((acc, curr) => acc + curr.mid, 0) / count;
    const avgHigh = barsInP.reduce((acc, curr) => acc + curr.high, 0) / count;

    return {
      id: p.id,
      name: p.name,
      startBar: p.startBar,
      endBar: p.endBar,
      startTime: p.startTime,
      endTime: p.endTime,
      durationBars: p.endBar - p.startBar,
      color: p.color,
      energyPercent: Math.round(Math.min(100, Math.max(0, avgOverall * 100))),
      bassPercent: Math.round(Math.min(100, Math.max(0, avgLow * 100))),
      midPercent: Math.round(Math.min(100, Math.max(0, avgMid * 100))),
      highPercent: Math.round(Math.min(100, Math.max(0, avgHigh * 100))),
    };
  });

  // 5. Detect Kick & Bass Entry Point (where kicks lock into solid rhythm)
  let kickEntryBar = 1;
  let kickFound = false;

  // Search through first 33 bars for first significant low-frequency rise
  for (let i = 0; i < Math.min(32, barEnergies.length); i++) {
    const be = barEnergies[i];
    if (be.low >= 0.28 || be.peak >= 0.35) {
      // Check if following bars maintain the low energy
      const nextBars = barEnergies.slice(i, i + 3);
      const isSustained = nextBars.length > 0 && nextBars.every((nb) => nb.low >= 0.22);
      if (isSustained) {
        kickEntryBar = be.bar;
        kickFound = true;
        break;
      }
    }
  }

  // If intro has sparse drums or filter sweep until Bar 17, check Bar 17 jump
  const bar17Energy = barEnergies[16]?.low || 0;
  const bar1To16AvgLow =
    barEnergies.slice(0, 16).reduce((acc, b) => acc + b.low, 0) / Math.max(1, Math.min(16, barEnergies.length));

  if (!kickFound || (bar17Energy > bar1To16AvgLow + 0.15 && bar17Energy >= 0.35)) {
    // Classic 16-bar intro setup where full kick drum enters at Bar 17
    if (totalBars >= 17) {
      kickEntryBar = 17;
    }
  }

  const kickEntryTime = firstBeat + (kickEntryBar - 1) * secPerBar;

  // Peak bar and max energy calculation
  let maxEnergy = 0;
  let peakBar = 1;
  barEnergies.forEach((be) => {
    if (be.overall > maxEnergy) {
      maxEnergy = be.overall;
      peakBar = be.bar;
    }
  });

  const introBars = barEnergies.slice(0, 16);
  const introAvgEnergy = Math.round(
    ((introBars.reduce((acc, b) => acc + b.overall, 0) / Math.max(1, introBars.length)) || 0.3) * 100
  );
  const bodyBars = barEnergies.slice(16);
  const bodyAvgEnergy = Math.round(
    ((bodyBars.reduce((acc, b) => acc + b.overall, 0) / Math.max(1, bodyBars.length)) || 0.7) * 100
  );

  const dynamicDiff = Math.abs(bodyAvgEnergy - introAvgEnergy);
  const energyDynamicRange: 'HIGH' | 'MEDIUM' | 'STEADY' =
    dynamicDiff > 30 ? 'HIGH' : dynamicDiff > 15 ? 'MEDIUM' : 'STEADY';

  // 6. Build Mix-In Point Candidates
  const allCandidates: MixInPointCandidate[] = [];

  // Determine the primary mix-in bar
  // If Bar 17 exists and has steady energy, or if kickEntryBar is a strong phrase anchor (Bar 1, 9, 17, 33)
  let primaryBar = kickEntryBar;
  // Snap to nearest 8-bar or 16-bar phrase boundary for DJ compatibility
  if (primaryBar > 1 && primaryBar < 17 && primaryBar !== 9) {
    primaryBar = primaryBar <= 8 ? 1 : 17;
  }
  if (totalBars >= 17 && primaryBar < 17 && bar17Energy >= 0.3) {
    // If Bar 17 introduces the full rhythm, it's usually preferred for a standard 32-bar mix
    primaryBar = 17;
  }

  const primaryTime = firstBeat + (primaryBar - 1) * secPerBar;
  const primaryBarData = barEnergies[primaryBar - 1] || barEnergies[0];
  const primaryPhrase = phrases.find((p) => primaryBar >= p.startBar && primaryBar < p.endBar) || phrases[0];

  // Candidate 1: PRIMARY BLEND (Golden Standard Mix-In)
  const primaryCand: MixInPointCandidate = {
    id: 'mixin-primary',
    type: 'PRIMARY_BLEND',
    label: `Optimaler Mix-In (Takt ${primaryBar}.1)`,
    barNumber: primaryBar,
    beatNumber: 1,
    timeSeconds: primaryTime,
    timeFormatted: formatTimePrecise(primaryTime),
    phraseName: primaryPhrase ? `${primaryPhrase.name} (Takt ${primaryBar})` : `Intro (Takt ${primaryBar})`,
    phraseDurationBars: primaryPhrase ? primaryPhrase.endBar - primaryPhrase.startBar : 16,
    energyPercent: Math.round(Math.min(100, (primaryBarData?.overall || 0.45) * 100)),
    bassEnergyPercent: Math.round(Math.min(100, (primaryBarData?.low || 0.4) * 100)),
    midEnergyPercent: Math.round(Math.min(100, (primaryBarData?.mid || 0.3) * 100)),
    highEnergyPercent: Math.round(Math.min(100, (primaryBarData?.high || 0.35) * 100)),
    energyDescription:
      primaryBar === 1
        ? 'Sofortiger Rhythmus-Start (Kick & Bass von Beginn an aktiv)'
        : 'Rhythmischer Einstiegspunkt (Kick & Bassline stabilisieren sich, minimale Vokalkollision)',
    recommendationScore: 98,
    djMixingRationale:
      primaryBar === 1
        ? 'Da der Track direkt mit dem Beat beginnt, eignet sich Takt 1.1 hervorragend für einen synchronen 32- oder 64-Takt-Übergang über den Outro des laufenden Tracks.'
        : `Takt ${primaryBar}.1 bietet 16 bis 32 Takte sauberen musikalischen Vorlauf bis zum Drop/Chorus. Der Kick-Rhythmus ist stabil für EQ-Bass-Swaps, ohne störende Vokalüberschneidungen.`,
    transitionLengthBars: 32,
    suggestedCueSlot: 'A',
    isRecommendedPrimary: true,
  };
  allCandidates.push(primaryCand);

  // Candidate 2: EXTENDED INTRO (Bar 1.1) - If primary is not Bar 1
  if (primaryBar !== 1) {
    const bar1Data = barEnergies[0];
    allCandidates.push({
      id: 'mixin-intro-start',
      type: 'EXTENDED_INTRO',
      label: 'Intro-Start (Takt 1.1 - Progressive Blend)',
      barNumber: 1,
      beatNumber: 1,
      timeSeconds: firstBeat,
      timeFormatted: formatTimePrecise(firstBeat),
      phraseName: 'INTRO (Start)',
      phraseDurationBars: phrases[0] ? phrases[0].endBar - phrases[0].startBar : 16,
      energyPercent: Math.round(Math.min(100, (bar1Data?.overall || 0.25) * 100)),
      bassEnergyPercent: Math.round(Math.min(100, (bar1Data?.low || 0.15) * 100)),
      midEnergyPercent: Math.round(Math.min(100, (bar1Data?.mid || 0.25) * 100)),
      highEnergyPercent: Math.round(Math.min(100, (bar1Data?.high || 0.2) * 100)),
      energyDescription: 'Sanfter Einstieg (Atmosphärisch, gefiltert oder perkussiv)',
      recommendationScore: 84,
      djMixingRationale:
        'Ideal für lange, progressive Übergänge (64 Takte) mit High-Pass-Filter. Der Track baut sich unmerklich unter dem laufenden Track auf.',
      transitionLengthBars: 64,
      suggestedCueSlot: 'B',
      isRecommendedPrimary: false,
    });
  }

  // Candidate 3: BUILD-UP / PRE-DROP (UP Phrase)
  const upPhrase = phrases.find((p) => p.name === 'UP' || p.name === 'VERSE' || p.name === 'BRIDGE');
  if (upPhrase && upPhrase.startBar !== primaryBar && upPhrase.startBar < totalBars - 16) {
    const upBarData = barEnergies[upPhrase.startBar - 1];
    allCandidates.push({
      id: 'mixin-build-up',
      type: 'BUILD_UP_TENSION',
      label: `Build-Up Einstieg (Takt ${upPhrase.startBar}.1 - Spannung)`,
      barNumber: upPhrase.startBar,
      beatNumber: 1,
      timeSeconds: upPhrase.startTime,
      timeFormatted: formatTimePrecise(upPhrase.startTime),
      phraseName: `${upPhrase.name} (Spannungsaufbau)`,
      phraseDurationBars: upPhrase.endBar - upPhrase.startBar,
      energyPercent: Math.round(Math.min(100, (upBarData?.overall || 0.6) * 100)),
      bassEnergyPercent: Math.round(Math.min(100, (upBarData?.low || 0.5) * 100)),
      midEnergyPercent: Math.round(Math.min(100, (upBarData?.mid || 0.55) * 100)),
      highEnergyPercent: Math.round(Math.min(100, (upBarData?.high || 0.6) * 100)),
      energyDescription: 'Steigende Energie (Snare Rolls, Riser & Melodie-Elemente)',
      recommendationScore: 88,
      djMixingRationale:
        'Perfekt, um den Spannungsaufbau beider Tracks simultan hochzuziehen und genau auf dem Drop des neuen Tracks umzuschalten.',
      transitionLengthBars: 16,
      suggestedCueSlot: 'C',
      isRecommendedPrimary: false,
    });
  }

  // Candidate 4: HIGH ENERGY DROP / CHORUS CUT
  const dropPhrase = phrases.find((p) => p.name === 'CHORUS' || p.name === 'DROP');
  if (dropPhrase && dropPhrase.startBar !== primaryBar) {
    const dropBarData = barEnergies[dropPhrase.startBar - 1];
    allCandidates.push({
      id: 'mixin-drop-cut',
      type: 'HIGH_ENERGY_DROP',
      label: `Drop / Chorus Cut (Takt ${dropPhrase.startBar}.1 - Peak Energy)`,
      barNumber: dropPhrase.startBar,
      beatNumber: 1,
      timeSeconds: dropPhrase.startTime,
      timeFormatted: formatTimePrecise(dropPhrase.startTime),
      phraseName: `${dropPhrase.name} (Maximaler Druck)`,
      phraseDurationBars: dropPhrase.endBar - dropPhrase.startBar,
      energyPercent: Math.round(Math.min(100, (dropBarData?.overall || 0.88) * 100)),
      bassEnergyPercent: Math.round(Math.min(100, (dropBarData?.low || 0.9) * 100)),
      midEnergyPercent: Math.round(Math.min(100, (dropBarData?.mid || 0.75) * 100)),
      highEnergyPercent: Math.round(Math.min(100, (dropBarData?.high || 0.8) * 100)),
      energyDescription: 'Volle Spitzenenergie (Voller Bass, druckvolle Drums, Lead-Synthesizer)',
      recommendationScore: 91,
      djMixingRationale:
        'Für Hard Cuts, Quick-Mixes oder Drop-Swaps. Tausche den laufenden Track auf dem 1. Schlag des Drops hart aus, um maximale Club-Wirkung zu erzielen.',
      transitionLengthBars: 8,
      suggestedCueSlot: 'D',
      isRecommendedPrimary: false,
    });
  }

  // Overall DJ mixing strategy advice based on energy curve
  let djStrategyAdvice = `Für "${track.title || 'Track'}" (${bpm.toFixed(1)} BPM, Tonart ${track.key || '--'}): `;
  if (primaryBar === 17) {
    djStrategyAdvice += `Der ideale Mix-In liegt bei Takt 17.1 (${formatTimePrecise(primaryTime)}). Die ersten 16 Takte sind Intro/Aufbau; ab Takt 17 greift das rhythmische Fundament. Setze Hot Cue A hier für einen 32-Takt-Übergang.`;
  } else if (primaryBar === 1) {
    djStrategyAdvice += `Der Track besitzt sofort ab Takt 1.1 (${formatTimePrecise(firstBeat)}) ein starkes Beat-Fundament. Du kannst sofort ab Beat 1 starten und über 32 bis 64 Takte mit dem Outro des laufenden Tracks überblenden.`;
  } else {
    djStrategyAdvice += `Optimaler Einstiegspunkt bei Takt ${primaryBar}.1 (${formatTimePrecise(primaryTime)}). Ausgeglichenes Frequenzspektrum für saubere EQ-Mischungen.`;
  }

  return {
    trackId: track.id,
    trackTitle: track.title,
    artist: track.artist,
    bpm,
    key: track.key,
    durationSeconds: duration,
    totalBars,
    optimalPoint: primaryCand,
    allCandidates,
    energySummary: {
      introAvgEnergy,
      bodyAvgEnergy,
      peakEnergy: Math.round(maxEnergy * 100),
      peakBar,
      kickEntryBar,
      kickEntryTime,
      energyDynamicRange,
    },
    phraseEnergies,
    djStrategyAdvice,
  };
}

/**
 * Convenience helper to create a Hot Cue or Memory Cue for a Mix-In candidate
 */
export function createCueForMixIn(
  candidate: MixInPointCandidate,
  type: 'HOT_CUE' | 'MEMORY' = 'HOT_CUE'
): CuePoint {
  const slotLetter = candidate.suggestedCueSlot === 'MEMORY' ? 'A' : candidate.suggestedCueSlot;
  const hotCueMap: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

  return {
    id: `cue-mixin-${Date.now()}-${candidate.barNumber}`,
    name: `MIX-IN ${candidate.barNumber}.${candidate.beatNumber}`,
    type,
    hotCueNum: type === 'HOT_CUE' ? hotCueMap[slotLetter] ?? 0 : undefined,
    letter: type === 'HOT_CUE' ? slotLetter : undefined,
    position: candidate.timeSeconds,
    inMsec: Math.round(candidate.timeSeconds * 1000),
    barNumber: candidate.barNumber,
    beatNumber: candidate.beatNumber,
    comment: `Mix-In (${candidate.energyPercent}% Energy | ${candidate.transitionLengthBars} Bars)`,
    color: '#10b981', // Rekordbox Emerald Green Cue
    origin: DataOrigin.USER_EDIT,
  };
}

export interface CamelotMatch {
  code: string;
  musicalKey: string;
  type: 'EXACT' | 'RELATIVE' | 'ENERGY_UP' | 'ENERGY_DOWN' | 'POWER_BOOST';
  badgeColor: string;
  label: string;
  description: string;
}

export interface CamelotInfo {
  code: string;
  musicalKey: string;
  isMinor: boolean;
  matches: CamelotMatch[];
}

const CAMELOT_MAP: Record<string, { code: string; musicalKey: string; num: number; letter: 'A' | 'B' }> = {
  // Minor (A)
  '1a': { code: '1A', musicalKey: 'Abm / G#m', num: 1, letter: 'A' },
  'abm': { code: '1A', musicalKey: 'Abm', num: 1, letter: 'A' },
  'g#m': { code: '1A', musicalKey: 'G#m', num: 1, letter: 'A' },
  '2a': { code: '2A', musicalKey: 'Ebm / D#m', num: 2, letter: 'A' },
  'ebm': { code: '2A', musicalKey: 'Ebm', num: 2, letter: 'A' },
  'd#m': { code: '2A', musicalKey: 'D#m', num: 2, letter: 'A' },
  '3a': { code: '3A', musicalKey: 'Bbm / A#m', num: 3, letter: 'A' },
  'bbm': { code: '3A', musicalKey: 'Bbm', num: 3, letter: 'A' },
  'a#m': { code: '3A', musicalKey: 'A#m', num: 3, letter: 'A' },
  '4a': { code: '4A', musicalKey: 'Fm', num: 4, letter: 'A' },
  'fm': { code: '4A', musicalKey: 'Fm', num: 4, letter: 'A' },
  '5a': { code: '5A', musicalKey: 'Cm', num: 5, letter: 'A' },
  'cm': { code: '5A', musicalKey: 'Cm', num: 5, letter: 'A' },
  '6a': { code: '6A', musicalKey: 'Gm', num: 6, letter: 'A' },
  'gm': { code: '6A', musicalKey: 'Gm', num: 6, letter: 'A' },
  '7a': { code: '7A', musicalKey: 'Dm', num: 7, letter: 'A' },
  'dm': { code: '7A', musicalKey: 'Dm', num: 7, letter: 'A' },
  '8a': { code: '8A', musicalKey: 'Am', num: 8, letter: 'A' },
  'am': { code: '8A', musicalKey: 'Am', num: 8, letter: 'A' },
  '9a': { code: '9A', musicalKey: 'Em', num: 9, letter: 'A' },
  'em': { code: '9A', musicalKey: 'Em', num: 9, letter: 'A' },
  '10a': { code: '10A', musicalKey: 'Bm', num: 10, letter: 'A' },
  'bm': { code: '10A', musicalKey: 'Bm', num: 10, letter: 'A' },
  '11a': { code: '11A', musicalKey: 'F#m', num: 11, letter: 'A' },
  'f#m': { code: '11A', musicalKey: 'F#m', num: 11, letter: 'A' },
  '12a': { code: '12A', musicalKey: 'Dbm / C#m', num: 12, letter: 'A' },
  'dbm': { code: '12A', musicalKey: 'Dbm', num: 12, letter: 'A' },
  'c#m': { code: '12A', musicalKey: 'C#m', num: 12, letter: 'A' },

  // Major (B)
  '1b': { code: '1B', musicalKey: 'B', num: 1, letter: 'B' },
  'b': { code: '1B', musicalKey: 'B', num: 1, letter: 'B' },
  '2b': { code: '2B', musicalKey: 'F# / Gb', num: 2, letter: 'B' },
  'f#': { code: '2B', musicalKey: 'F#', num: 2, letter: 'B' },
  'gb': { code: '2B', musicalKey: 'Gb', num: 2, letter: 'B' },
  '3b': { code: '3B', musicalKey: 'Db / C#', num: 3, letter: 'B' },
  'db': { code: '3B', musicalKey: 'Db', num: 3, letter: 'B' },
  'c#': { code: '3B', musicalKey: 'C#', num: 3, letter: 'B' },
  '4b': { code: '4B', musicalKey: 'Ab / G#', num: 4, letter: 'B' },
  'ab': { code: '4B', musicalKey: 'Ab', num: 4, letter: 'B' },
  'g#': { code: '4B', musicalKey: 'G#', num: 4, letter: 'B' },
  '5b': { code: '5B', musicalKey: 'Eb / D#', num: 5, letter: 'B' },
  'eb': { code: '5B', musicalKey: 'Eb', num: 5, letter: 'B' },
  'd#': { code: '5B', musicalKey: 'D#', num: 5, letter: 'B' },
  '6b': { code: '6B', musicalKey: 'Bb / A#', num: 6, letter: 'B' },
  'bb': { code: '6B', musicalKey: 'Bb', num: 6, letter: 'B' },
  'a#': { code: '6B', musicalKey: 'A#', num: 6, letter: 'B' },
  '7b': { code: '7B', musicalKey: 'F', num: 7, letter: 'B' },
  'f': { code: '7B', musicalKey: 'F', num: 7, letter: 'B' },
  '8b': { code: '8B', musicalKey: 'C', num: 8, letter: 'B' },
  'c': { code: '8B', musicalKey: 'C', num: 8, letter: 'B' },
  '9b': { code: '9B', musicalKey: 'G', num: 9, letter: 'B' },
  'g': { code: '9B', musicalKey: 'G', num: 9, letter: 'B' },
  '10b': { code: '10B', musicalKey: 'D', num: 10, letter: 'B' },
  'd': { code: '10B', musicalKey: 'D', num: 10, letter: 'B' },
  '11b': { code: '11B', musicalKey: 'A', num: 11, letter: 'B' },
  'a': { code: '11B', musicalKey: 'A', num: 11, letter: 'B' },
  '12b': { code: '12B', musicalKey: 'E', num: 12, letter: 'B' },
  'e': { code: '12B', musicalKey: 'E', num: 12, letter: 'B' },
};

const CODE_TO_KEY: Record<string, string> = {
  '1A': 'Abm', '2A': 'Ebm', '3A': 'Bbm', '4A': 'Fm', '5A': 'Cm', '6A': 'Gm',
  '7A': 'Dm', '8A': 'Am', '9A': 'Em', '10A': 'Bm', '11A': 'F#m', '12A': 'Dbm',
  '1B': 'B', '2B': 'F#', '3B': 'Db', '4B': 'Ab', '5B': 'Eb', '6B': 'Bb',
  '7B': 'F', '8B': 'C', '9B': 'G', '10B': 'D', '11B': 'A', '12B': 'E',
};

export function getCamelotInfo(rawKey?: string): CamelotInfo {
  const norm = (rawKey || '8A').toLowerCase().replace(/\s+/g, '').replace('minor', 'm').replace('maj', '');
  const entry = CAMELOT_MAP[norm] || CAMELOT_MAP['8a'];

  const n = entry.num;
  const l = entry.letter;
  const oppL: 'A' | 'B' = l === 'A' ? 'B' : 'A';

  const wrap = (val: number) => {
    let r = val % 12;
    if (r <= 0) r += 12;
    return r;
  };

  const codeExact = `${n}${l}`;
  const codeRelative = `${n}${oppL}`;
  const codeEnergyUp = `${wrap(n + 1)}${l}`;
  const codeEnergyDown = `${wrap(n - 1)}${l}`;
  const codePowerBoost = `${wrap(n + 2)}${l}`;

  const matches: CamelotMatch[] = [
    {
      code: codeExact,
      musicalKey: CODE_TO_KEY[codeExact] || entry.musicalKey,
      type: 'EXACT',
      badgeColor: '#10b981',
      label: 'Identisch (100% Match)',
      description: 'Nahtlose, harmonisch unsichtbare Mischung ohne Tonart-Reibung.',
    },
    {
      code: codeRelative,
      musicalKey: CODE_TO_KEY[codeRelative] || '',
      type: 'RELATIVE',
      badgeColor: '#00a2ff',
      label: l === 'A' ? 'Relativ Dur' : 'Relativ Moll',
      description: 'Stimmungswechsel (heller/dunkler) bei gleichen Tonstufen.',
    },
    {
      code: codeEnergyUp,
      musicalKey: CODE_TO_KEY[codeEnergyUp] || '',
      type: 'ENERGY_UP',
      badgeColor: '#f59e0b',
      label: 'Energy Boost (+1)',
      description: 'Erhöht die musikalische Spannung auf der Tanzfläche spürbar.',
    },
    {
      code: codeEnergyDown,
      musicalKey: CODE_TO_KEY[codeEnergyDown] || '',
      type: 'ENERGY_DOWN',
      badgeColor: '#6366f1',
      label: 'Warm Down (-1)',
      description: 'Beruhigender, entspannter Übergang mit tieferer Resonanz.',
    },
    {
      code: codePowerBoost,
      musicalKey: CODE_TO_KEY[codePowerBoost] || '',
      type: 'POWER_BOOST',
      badgeColor: '#ec4899',
      label: 'Power Step (+2)',
      description: 'Starker, euphorisierender Energiesprung für Peak-Time Momente.',
    },
  ];

  return {
    code: entry.code,
    musicalKey: entry.musicalKey,
    isMinor: l === 'A',
    matches,
  };
}
