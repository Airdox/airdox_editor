/**
 * @license
 * Rekordbox Pitch & Tempo Audio DSP Engine
 * Provides high-fidelity WSOLA (Waveform Similarity Overlap-Add) time-stretching,
 * harmonic key detection & pitch-shifting, and automated clip adaptation.
 */

import { PaletteClip, TrackModel } from '../types/rekordbox';

export interface KeyInfo {
  root: number; // 0 = C, 1 = C#, 2 = D, ..., 11 = B
  isMinor: boolean;
  camelot: string;
  name: string;
}

const CAMELOT_MAP: Record<string, { root: number; isMinor: boolean; name: string }> = {
  // Minor keys (A)
  '1A': { root: 8, isMinor: true, name: 'G#m' },
  '2A': { root: 3, isMinor: true, name: 'D#m' },
  '3A': { root: 10, isMinor: true, name: 'A#m' },
  '4A': { root: 5, isMinor: true, name: 'Fm' },
  '5A': { root: 0, isMinor: true, name: 'Cm' },
  '6A': { root: 7, isMinor: true, name: 'Gm' },
  '7A': { root: 2, isMinor: true, name: 'Dm' },
  '8A': { root: 9, isMinor: true, name: 'Am' },
  '9A': { root: 4, isMinor: true, name: 'Em' },
  '10A': { root: 11, isMinor: true, name: 'Bm' },
  '11A': { root: 6, isMinor: true, name: 'F#m' },
  '12A': { root: 1, isMinor: true, name: 'C#m' },

  // Major keys (B)
  '1B': { root: 11, isMinor: false, name: 'B' },
  '2B': { root: 6, isMinor: false, name: 'F#' },
  '3B': { root: 1, isMinor: false, name: 'Db' },
  '4B': { root: 8, isMinor: false, name: 'Ab' },
  '5B': { root: 3, isMinor: false, name: 'Eb' },
  '6B': { root: 10, isMinor: false, name: 'Bb' },
  '7B': { root: 5, isMinor: false, name: 'F' },
  '8B': { root: 0, isMinor: false, name: 'C' },
  '9B': { root: 7, isMinor: false, name: 'G' },
  '10B': { root: 2, isMinor: false, name: 'D' },
  '11B': { root: 9, isMinor: false, name: 'A' },
  '12B': { root: 4, isMinor: false, name: 'E' },
};

const NOTE_NAME_TO_ROOT: Record<string, number> = {
  c: 0,
  'c#': 1,
  db: 1,
  d: 2,
  'd#': 3,
  eb: 3,
  e: 4,
  f: 5,
  'f#': 6,
  gb: 6,
  g: 7,
  'g#': 8,
  ab: 8,
  a: 9,
  'a#': 10,
  bb: 10,
  b: 11,
};

const ROOT_TO_CAMELOT_MINOR: string[] = [
  '5A',  // 0: Cm
  '12A', // 1: C#m
  '7A',  // 2: Dm
  '2A',  // 3: D#m
  '9A',  // 4: Em
  '4A',  // 5: Fm
  '11A', // 6: F#m
  '6A',  // 7: Gm
  '1A',  // 8: G#m
  '8A',  // 9: Am
  '3A',  // 10: A#m
  '10A', // 11: Bm
];

const ROOT_TO_CAMELOT_MAJOR: string[] = [
  '8B',  // 0: C
  '3B',  // 1: Db
  '10B', // 2: D
  '5B',  // 3: Eb
  '12B', // 4: E
  '7B',  // 5: F
  '2B',  // 6: F#
  '9B',  // 7: G
  '4B',  // 8: Ab
  '11B', // 9: A
  '6B',  // 10: Bb
  '1B',  // 11: B
];

/**
 * Parse any Camelot (e.g. "8A", "11B") or Standard notation ("Am", "F#m", "C") key
 */
export function parseMusicalKey(rawKey: string | undefined): KeyInfo | null {
  if (!rawKey) return null;
  const clean = rawKey.trim().toUpperCase();

  // Check direct Camelot code
  if (CAMELOT_MAP[clean]) {
    const entry = CAMELOT_MAP[clean];
    return {
      root: entry.root,
      isMinor: entry.isMinor,
      camelot: clean,
      name: entry.name,
    };
  }

  // Parse standard note string: e.g. "F#m", "Db MIN", "C MAJOR", "Bb"
  const lower = rawKey.trim().toLowerCase();
  const isMinor = lower.includes('m') && !lower.includes('maj');
  const noteMatch = lower.match(/^([a-g][#b]?)/);
  if (noteMatch && NOTE_NAME_TO_ROOT[noteMatch[1]] !== undefined) {
    const root = NOTE_NAME_TO_ROOT[noteMatch[1]];
    const camelot = isMinor ? ROOT_TO_CAMELOT_MINOR[root] : ROOT_TO_CAMELOT_MAJOR[root];
    const name = `${noteMatch[1].toUpperCase()}${isMinor ? 'm' : ''}`;
    return {
      root,
      isMinor,
      camelot,
      name,
    };
  }

  return null;
}

/**
 * Calculates the optimal semitone pitch shift to harmonize sourceKey with targetKey.
 * Prioritizes:
 * 1. Exact match (0 semitones)
 * 2. Relative Major/Minor (0 semitones - same key signature)
 * 3. Chromatic transposition to closest root (range -6 to +6 semitones)
 */
export function calculateHarmonicPitchShift(
  sourceKeyStr: string | undefined,
  targetKeyStr: string | undefined
): { semitones: number; harmonicRelation: string } {
  const src = parseMusicalKey(sourceKeyStr);
  const tgt = parseMusicalKey(targetKeyStr);

  if (!src || !tgt) {
    return { semitones: 0, harmonicRelation: 'Unbekannte Tonart' };
  }

  // Exact same key
  if (src.root === tgt.root && src.isMinor === tgt.isMinor) {
    return { semitones: 0, harmonicRelation: 'Identische Tonart (100% harmonisch)' };
  }

  // Relative Major / Minor (e.g. Am (8A) and C (8B) share exact same scale notes!)
  if (src.camelot.slice(0, -1) === tgt.camelot.slice(0, -1)) {
    return { semitones: 0, harmonicRelation: 'Parallele/Relative Tonart (Harmonisch kompatibel)' };
  }

  // Determine required pitch shift between roots in range [-6, +6]
  let diff = (tgt.root - src.root) % 12;
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;

  const sign = diff >= 0 ? `+${diff}` : `${diff}`;
  return {
    semitones: diff,
    harmonicRelation: `Transponierung um ${sign} Halbtöne (${src.camelot} ➔ ${tgt.camelot})`,
  };
}

/**
 * Resamples multichannel audio by a speed ratio (e.g. >1 faster/higher, <1 slower/lower)
 * using linear interpolation.
 */
export function resampleChannelData(
  channels: Float32Array[],
  speedRatio: number
): Float32Array[] {
  if (Math.abs(speedRatio - 1.0) < 0.0001) {
    return channels.map((ch) => new Float32Array(ch));
  }

  const numChannels = channels.length;
  const inLength = channels[0].length;
  const outLength = Math.max(1, Math.floor(inLength / speedRatio));
  const outChannels: Float32Array[] = [];

  for (let c = 0; c < numChannels; c++) {
    const inCh = channels[c];
    const outCh = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcPos = i * speedRatio;
      const index0 = Math.floor(srcPos);
      const index1 = Math.min(inLength - 1, index0 + 1);
      const frac = srcPos - index0;
      outCh[i] = inCh[index0] * (1 - frac) + inCh[index1] * frac;
    }
    outChannels.push(outCh);
  }

  return outChannels;
}

/**
 * High-fidelity Waveform Similarity Overlap-Add (WSOLA) Time-Stretching Algorithm.
 * Changes duration without altering pitch.
 * 
 * @param channels Array of channel data (Float32Array)
 * @param sampleRate Sample rate in Hz (e.g. 44100)
 * @param stretchFactor Target duration ratio = (newDuration / oldDuration)
 *                      If stretchFactor < 1, audio plays faster (shorter duration).
 *                      If stretchFactor > 1, audio plays slower (longer duration).
 */
export function wsolaTimeStretchChannelData(
  channels: Float32Array[],
  sampleRate: number,
  stretchFactor: number
): Float32Array[] {
  // If stretch factor is virtually 1, return a copy
  if (Math.abs(stretchFactor - 1.0) < 0.002) {
    return channels.map((ch) => new Float32Array(ch));
  }

  const inLength = channels[0].length;
  const outLength = Math.max(1, Math.floor(inLength * stretchFactor));
  const numChannels = channels.length;

  // Window sizing based on sample rate
  // ~40ms window
  const windowSize = Math.min(2048, Math.max(512, Math.floor(sampleRate * 0.04)));
  const synthHop = Math.floor(windowSize / 4); // 75% overlap
  const searchRadius = Math.floor(synthHop * 0.75);

  // Pre-calculate Hann window
  const window = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));
  }

  // Create mono reference for multichannel phase alignment (prevents stereo smearing)
  const monoRef = new Float32Array(inLength);
  for (let c = 0; c < numChannels; c++) {
    const ch = channels[c];
    for (let i = 0; i < inLength; i++) {
      monoRef[i] += ch[i] / numChannels;
    }
  }

  // Allocate output buffers & normalization weights
  const outChannels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    outChannels.push(new Float32Array(outLength));
  }
  const weightSum = new Float32Array(outLength);

  let prevBestOffset = 0;
  const numFrames = Math.floor((outLength - windowSize) / synthHop);

  for (let f = 0; f < numFrames; f++) {
    const outPos = f * synthHop;
    // Target input position corresponding to current output frame
    const nominalInPos = Math.floor(outPos / stretchFactor);

    // Find best alignment offset delta in [-searchRadius, +searchRadius]
    // using cross-correlation with previous frame extrapolation
    let bestOffset = nominalInPos;
    let maxCorrelation = -Infinity;

    const minSearch = Math.max(0, nominalInPos - searchRadius);
    const maxSearch = Math.min(inLength - windowSize, nominalInPos + searchRadius);

    const desiredRefPos = prevBestOffset + synthHop;

    if (f === 0 || desiredRefPos + windowSize > inLength) {
      bestOffset = Math.min(inLength - windowSize, Math.max(0, nominalInPos));
    } else {
      // Cross-correlation search
      for (let cand = minSearch; cand <= maxSearch; cand += 2) {
        let corr = 0;
        // Sample every 2nd value for real-time speedup
        for (let i = 0; i < windowSize; i += 2) {
          corr += monoRef[cand + i] * monoRef[desiredRefPos + i];
        }
        if (corr > maxCorrelation) {
          maxCorrelation = corr;
          bestOffset = cand;
        }
      }
    }

    prevBestOffset = bestOffset;

    // Overlap-add for each channel with Hann window
    for (let c = 0; c < numChannels; c++) {
      const inCh = channels[c];
      const outCh = outChannels[c];
      for (let i = 0; i < windowSize; i++) {
        const idx = outPos + i;
        if (idx < outLength && bestOffset + i < inLength) {
          outCh[idx] += inCh[bestOffset + i] * window[i];
        }
      }
    }

    for (let i = 0; i < windowSize; i++) {
      const idx = outPos + i;
      if (idx < outLength) {
        weightSum[idx] += window[i];
      }
    }
  }

  // Normalize by overlap window weights to eliminate amplitude modulation
  for (let i = 0; i < outLength; i++) {
    const w = weightSum[i];
    if (w > 0.001) {
      for (let c = 0; c < numChannels; c++) {
        outChannels[c][i] /= w;
      }
    }
  }

  return outChannels;
}

/**
 * Pitch-shift audio by exact semitones while preserving its exact duration!
 * Combines resampling with WSOLA time-stretch.
 */
export function pitchShiftChannelData(
  channels: Float32Array[],
  sampleRate: number,
  semitones: number
): Float32Array[] {
  if (semitones === 0) {
    return channels.map((ch) => new Float32Array(ch));
  }

  // Pitch shift ratio (frequency factor)
  const pitchRatio = Math.pow(2, semitones / 12);

  // 1. Resample by pitch ratio (alters pitch and scales length by 1 / pitchRatio)
  const resampled = resampleChannelData(channels, pitchRatio);

  // 2. Time-stretch by pitchRatio to return to the original duration
  const stretched = wsolaTimeStretchChannelData(resampled, sampleRate, pitchRatio);

  return stretched;
}

/**
 * Full audio buffer adaptation for cross-track insertion.
 * Adapts clip tempo to destination track BPM and optionally shifts pitch to match key.
 */
export function adaptClipAudioBuffer(
  clipBuffer: AudioBuffer,
  clipBpm: number,
  clipKey: string | undefined,
  destTrackBpm: number,
  destTrackKey: string | undefined,
  matchPitch: boolean,
  createBufferFn: (numberOfChannels: number, length: number, sampleRate: number) => AudioBuffer
): {
  adaptedBuffer: AudioBuffer;
  tempoRatio: number;
  semitonesShifted: number;
  harmonicRelation: string;
  originalDuration: number;
  newDuration: number;
} {
  const numChannels = clipBuffer.numberOfChannels;
  const sampleRate = clipBuffer.sampleRate;
  const originalDuration = clipBuffer.duration;

  // Extract raw channel data
  const rawChannels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    rawChannels.push(clipBuffer.getChannelData(c));
  }

  // 1. Calculate tempo adjustment factor:
  // If destination BPM is higher, clip should play faster (duration factor < 1)
  const safeClipBpm = clipBpm > 0 ? clipBpm : 120.0;
  const safeDestBpm = destTrackBpm > 0 ? destTrackBpm : safeClipBpm;
  const tempoRatio = safeDestBpm / safeClipBpm;
  // duration factor = 1 / tempoRatio = safeClipBpm / safeDestBpm
  const durationStretchFactor = safeClipBpm / safeDestBpm;

  let processedChannels = rawChannels;

  // 2. Pitch shifting if requested
  let semitonesShifted = 0;
  let harmonicRelation = 'Keine Tonhöhenanpassung';

  if (matchPitch && clipKey && destTrackKey) {
    const shiftInfo = calculateHarmonicPitchShift(clipKey, destTrackKey);
    semitonesShifted = shiftInfo.semitones;
    harmonicRelation = shiftInfo.harmonicRelation;

    if (semitonesShifted !== 0) {
      processedChannels = pitchShiftChannelData(processedChannels, sampleRate, semitonesShifted);
    }
  }

  // 3. WSOLA Time-Stretch to match destination track BPM
  if (Math.abs(durationStretchFactor - 1.0) > 0.002) {
    processedChannels = wsolaTimeStretchChannelData(
      processedChannels,
      sampleRate,
      durationStretchFactor
    );
  }

  // Wrap back into AudioBuffer
  const outLength = processedChannels[0].length;
  const outBuffer = createBufferFn(numChannels, outLength, sampleRate);
  for (let c = 0; c < numChannels; c++) {
    const chData = outBuffer.getChannelData(c);
    chData.set(processedChannels[c]);
  }

  return {
    adaptedBuffer: outBuffer,
    tempoRatio,
    semitonesShifted,
    harmonicRelation,
    originalDuration,
    newDuration: outBuffer.duration,
  };
}
