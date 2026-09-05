/**
 * @license
 * Rekordbox Waveform Audio Analysis Engine
 * Extracts multi-band energy (Low/Mid/High) and amplitude peaks
 * from raw audio data for BLUE, RGB, and 3BAND waveform visualizers.
 */

import { DataOrigin, WaveformAnalysisData } from '../types/rekordbox';
import { PcmAudio, pcmSampleCount } from '../audio/pcm';

export function analyzeAudioBuffer(
  buffer: AudioBuffer,
  origin: DataOrigin = DataOrigin.LOCAL_ANALYSIS
): WaveformAnalysisData {
  const pcm: PcmAudio = {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch)),
  };
  return analyzePcm(pcm, origin);
}

/**
 * Dieselbe Analyse auf dem reinen PCM-Modell – ohne AudioContext, damit nach
 * jedem Schnitt dieselbe Berechnung läuft, die auch die Tests prüfen.
 */
export function analyzePcm(
  pcm: PcmAudio,
  origin: DataOrigin = DataOrigin.LOCAL_ANALYSIS
): WaveformAnalysisData {
  const sampleRate = pcm.sampleRate || 44100;
  if (pcmSampleCount(pcm) === 0) {
    return {
      length: 0,
      peaks: new Float32Array(0),
      peaksL: new Float32Array(0),
      peaksR: new Float32Array(0),
      lowEnergy: new Float32Array(0),
      midEnergy: new Float32Array(0),
      highEnergy: new Float32Array(0),
      origin,
    };
  }
  const left = pcm.channels[0] ?? new Float32Array(0);
  const right = pcm.channels.length > 1 ? pcm.channels[1] : left;
  const length = left.length;

  // Aim for ~150-200 buckets per second of audio for ultra-crisp DJ zoom levels
  const bucketsPerSecond = 180;
  const totalBuckets = Math.max(100, Math.floor((length / sampleRate) * bucketsPerSecond));
  const samplesPerBucket = Math.max(1, Math.floor(length / totalBuckets));

  const peaks = new Float32Array(totalBuckets);
  const peaksL = new Float32Array(totalBuckets);
  const peaksR = new Float32Array(totalBuckets);
  const lowEnergy = new Float32Array(totalBuckets);
  const midEnergy = new Float32Array(totalBuckets);
  const highEnergy = new Float32Array(totalBuckets);

  // Simplified Butterworth-style IIR filter coefficients for real-time 3-band separation
  // Low-pass ~250 Hz, Band-pass 250-3500 Hz, High-pass >3500 Hz
  const dt = 1.0 / sampleRate;
  const rcLow = 1.0 / (2.0 * Math.PI * 260.0);
  const alphaLow = dt / (rcLow + dt);

  const rcHigh = 1.0 / (2.0 * Math.PI * 3500.0);
  const alphaHigh = rcHigh / (rcHigh + dt);

  let lowPrevL = 0;
  let highPrevL = 0;
  let inPrevL = 0;

  for (let b = 0; b < totalBuckets; b++) {
    const startIdx = b * samplesPerBucket;
    const endIdx = Math.min(startIdx + samplesPerBucket, length);

    let maxL = 0;
    let maxR = 0;
    let lowSum = 0;
    let midSum = 0;
    let highSum = 0;
    let count = 0;

    for (let i = startIdx; i < endIdx; i += 2) {
      const sL = left[i];
      const sR = right[i];
      const absL = Math.abs(sL);
      const absR = Math.abs(sR);
      if (absL > maxL) maxL = absL;
      if (absR > maxR) maxR = absR;

      // Low pass
      lowPrevL = lowPrevL + alphaLow * (sL - lowPrevL);
      const lowVal = Math.abs(lowPrevL);

      // High pass
      const highVal = Math.abs(alphaHigh * (highPrevL + sL - inPrevL));
      highPrevL = highVal;
      inPrevL = sL;

      // Mid band: difference
      const midVal = Math.max(0, absL - lowVal * 0.7 - highVal * 0.7);

      lowSum += lowVal;
      midSum += midVal;
      highSum += highVal;
      count++;
    }

    peaksL[b] = Math.min(1.0, maxL);
    peaksR[b] = Math.min(1.0, maxR);
    peaks[b] = Math.min(1.0, Math.max(maxL, maxR));

    if (count > 0) {
      // Normalize and amplify band energies for vibrant Rekordbox visualization
      lowEnergy[b] = Math.min(1.0, (lowSum / count) * 2.8);
      midEnergy[b] = Math.min(1.0, (midSum / count) * 3.2);
      highEnergy[b] = Math.min(1.0, (highSum / count) * 4.2);
    }
  }

  return {
    length: totalBuckets,
    peaks,
    peaksL,
    peaksR,
    lowEnergy,
    midEnergy,
    highEnergy,
    origin,
  };
}

/**
 * Extracts mini peak profile (e.g. 64 buckets) for Palette clips
 */
export function extractMiniPeaks(buffer: AudioBuffer, numBuckets: number = 64): number[] {
  return extractMiniPeaksPcm(
    { sampleRate: buffer.sampleRate, channels: Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch)) },
    numBuckets
  );
}

/** Mini-Peaks auf dem PCM-Modell (Palette-Vorschau, auch in Tests nutzbar). */
export function extractMiniPeaksPcm(pcm: PcmAudio, numBuckets: number = 64): number[] {
  const left = pcm.channels[0] ?? new Float32Array(0);
  const len = left.length;
  const step = Math.floor(len / numBuckets);
  const result: number[] = [];

  for (let b = 0; b < numBuckets; b++) {
    const start = b * step;
    const end = Math.min(start + step, len);
    let max = 0;
    for (let i = start; i < end; i += 4) {
      const val = Math.abs(left[i]);
      if (val > max) max = val;
    }
    result.push(Math.min(1.0, max));
  }

  return result;
}
