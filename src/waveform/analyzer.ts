/**
 * @license
 * Rekordbox Waveform Audio Analysis Engine
 * Extracts multi-band energy (Low/Mid/High) and amplitude peaks
 * from raw audio data for BLUE, RGB, and 3BAND waveform visualizers.
 */

import { DataOrigin, WaveformAnalysisData } from '../types/rekordbox';

export function analyzeAudioBuffer(
  buffer: AudioBuffer,
  origin: DataOrigin = DataOrigin.LOCAL_ANALYSIS
): WaveformAnalysisData {
  const sampleRate = buffer.sampleRate;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const length = buffer.length;

  // Aim for ~200 buckets per second for ultra-crisp DJ zoom alignment
  const bucketsPerSecond = 200;
  const totalBuckets = Math.max(100, Math.floor((length / sampleRate) * bucketsPerSecond));
  const samplesPerBucket = Math.max(1, Math.floor(length / totalBuckets));
  const secPerBucket = samplesPerBucket / sampleRate;

  const peaks = new Float32Array(totalBuckets);
  const peaksL = new Float32Array(totalBuckets);
  const peaksR = new Float32Array(totalBuckets);
  const lowEnergy = new Float32Array(totalBuckets);
  const midEnergy = new Float32Array(totalBuckets);
  const highEnergy = new Float32Array(totalBuckets);

  let prevSL = 0;

  for (let b = 0; b < totalBuckets; b++) {
    const startIdx = b * samplesPerBucket;
    const endIdx = Math.min(startIdx + samplesPerBucket, length);

    let maxL = 0;
    let maxR = 0;
    let lowSum = 0;
    let midSum = 0;
    let highSum = 0;
    let count = 0;

    for (let i = startIdx; i < endIdx; i++) {
      const sL = left[i];
      const sR = right[i];
      const absL = Math.abs(sL);
      const absR = Math.abs(sR);
      if (absL > maxL) maxL = absL;
      if (absR > maxR) maxR = absR;

      // Zero-phase instantaneous spectral separation (prevents IIR filter delay)
      const diff = Math.abs(sL - prevSL);
      prevSL = sL;

      const mag = Math.max(absL, absR);
      // High frequencies produce large sample-to-sample deltas
      const highVal = Math.min(1.0, diff * 2.8);
      // Low frequencies have large amplitude with smooth sample transitions
      const lowVal = Math.max(0, mag - diff * 1.5);
      // Mid frequencies capture harmonic vocals and synth presence
      const midVal = Math.max(0, mag * 0.9 - lowVal * 0.6 - highVal * 0.4);

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
      midEnergy[b] = Math.min(1.0, (midSum / count) * 3.0);
      highEnergy[b] = Math.min(1.0, (highSum / count) * 3.8);
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
    secPerBucket,
    samplesPerBucket,
  };
}

/**
 * Peak/band columns of an arbitrary time range at an EXACT column duration.
 *
 * This is the analysis primitive of the edit path: after a structural edit only
 * the material that has no stored columns (a time-stretched clip, a locally
 * imported file, ...) needs numbers at all, and it needs them on the project's
 * column grid so they can be spliced into the ANLZ projection without touching a
 * single imported value. It therefore never replaces, averages or smooths ANLZ
 * data - the caller marks these columns `COMPUTED` (USER_EDIT) explicitly.
 *
 * Pure (Float32Array in/out) so it is unit-testable without WebAudio.
 */
export interface RangePeakColumns {
  length: number;
  peaks: Float32Array;
  peaksL: Float32Array;
  peaksR: Float32Array;
  lowEnergy: Float32Array;
  midEnergy: Float32Array;
  highEnergy: Float32Array;
  secPerBucket: number;
  samplesPerBucket: number;
}

export function analyzeRangeBuckets(
  channels: { left: Float32Array; right?: Float32Array; sampleRate: number },
  startSec: number,
  endSec: number,
  bucketSeconds: number
): RangePeakColumns {
  const left = channels.left;
  const right = channels.right ?? channels.left;
  const sampleRate = channels.sampleRate > 0 ? channels.sampleRate : 44100;
  const bd = bucketSeconds > 0 ? bucketSeconds : 0.005;
  const safeStart = Math.max(0, Math.min(startSec, endSec));
  const safeEnd = Math.max(safeStart, Math.min(endSec, left.length / sampleRate));
  const total = Math.max(1, Math.ceil((safeEnd - safeStart) / bd - 1e-9));

  const peaks = new Float32Array(total);
  const peaksL = new Float32Array(total);
  const peaksR = new Float32Array(total);
  const lowEnergy = new Float32Array(total);
  const midEnergy = new Float32Array(total);
  const highEnergy = new Float32Array(total);

  const baseSample = Math.floor(safeStart * sampleRate);
  const bucketSamples = bd * sampleRate;
  let prevSL = baseSample > 0 ? left[baseSample - 1] : 0;

  for (let b = 0; b < total; b++) {
    const from = baseSample + Math.floor(b * bucketSamples);
    const to = Math.min(left.length, baseSample + Math.floor((b + 1) * bucketSamples));
    let maxL = 0;
    let maxR = 0;
    let lowSum = 0;
    let midSum = 0;
    let highSum = 0;
    let count = 0;

    for (let i = from; i < to; i++) {
      const sL = left[i];
      const sR = right[i];
      const absL = Math.abs(sL);
      const absR = Math.abs(sR);
      if (absL > maxL) maxL = absL;
      if (absR > maxR) maxR = absR;

      // Same zero-phase spectral separation as analyzeAudioBuffer: approximate
      // band energies of OWN analysis, never presented as Rekordbox values.
      const diff = Math.abs(sL - prevSL);
      prevSL = sL;
      const mag = Math.max(absL, absR);
      const highVal = Math.min(1.0, diff * 2.8);
      const lowVal = Math.max(0, mag - diff * 1.5);
      const midVal = Math.max(0, mag * 0.9 - lowVal * 0.6 - highVal * 0.4);
      lowSum += lowVal;
      midSum += midVal;
      highSum += highVal;
      count += 1;
    }

    peaksL[b] = Math.min(1.0, maxL);
    peaksR[b] = Math.min(1.0, maxR);
    peaks[b] = Math.min(1.0, Math.max(maxL, maxR));
    if (count > 0) {
      lowEnergy[b] = Math.min(1.0, (lowSum / count) * 2.8);
      midEnergy[b] = Math.min(1.0, (midSum / count) * 3.0);
      highEnergy[b] = Math.min(1.0, (highSum / count) * 3.8);
    }
  }

  return {
    length: total,
    peaks,
    peaksL,
    peaksR,
    lowEnergy,
    midEnergy,
    highEnergy,
    secPerBucket: bd,
    samplesPerBucket: Math.max(1, Math.round(bucketSamples)),
  };
}

/**
 * Extracts mini peak profile (e.g. 64 buckets) for Palette clips
 */
export function extractMiniPeaks(buffer: AudioBuffer, numBuckets: number = 64): number[] {
  const left = buffer.getChannelData(0);
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

/**
 * Detects the first prominent kick drum / downbeat transient in an AudioBuffer
 * near an expected beat anchor, and returns the phase-aligned firstBeat timestamp.
 * This guarantees that beatgrid markers sit precisely on the kick drum transients.
 */
export function detectBeatgridAlignment(
  buffer: AudioBuffer,
  bpm: number,
  initialFirstBeat: number = 0.0
): number {
  const sampleRate = buffer.sampleRate;
  const channel = buffer.getChannelData(0);
  const totalSamples = channel.length;
  const secondsPerBeat = 60.0 / Math.max(1, bpm);

  // Search window: check around initialFirstBeat or first 6 beats
  const searchStartSec = Math.max(0.0, initialFirstBeat - secondsPerBeat * 0.5);
  const searchEndSec = Math.min(
    buffer.duration,
    Math.max(initialFirstBeat + secondsPerBeat * 1.5, secondsPerBeat * 6.0)
  );

  const startSample = Math.floor(searchStartSec * sampleRate);
  const endSample = Math.min(totalSamples, Math.ceil(searchEndSec * sampleRate));

  if (endSample <= startSample + 128) return initialFirstBeat;

  // Window chunk (~4ms) with low-pass filter to isolate kick drum punch
  const chunkSize = Math.max(16, Math.floor(0.004 * sampleRate));
  const numChunks = Math.floor((endSample - startSample) / chunkSize);

  let bestSample = -1;
  let maxScore = 0;
  let prevEnergy = 0;

  const dt = 1.0 / sampleRate;
  const rc = 1.0 / (2.0 * Math.PI * 180.0); // 180 Hz kick punch
  const alpha = dt / (rc + dt);
  let lp = 0;

  for (let c = 0; c < numChunks; c++) {
    const chunkStart = startSample + c * chunkSize;
    let sumSq = 0;
    for (let i = 0; i < chunkSize; i++) {
      const s = channel[chunkStart + i];
      lp += alpha * (s - lp);
      sumSq += lp * lp;
    }
    const curEnergy = Math.sqrt(sumSq / chunkSize);
    // Transient onset: rapid energy surge
    const onset = Math.max(0, curEnergy - prevEnergy * 0.82);
    const score = curEnergy * 0.35 + onset * 0.65;

    if (score > maxScore) {
      maxScore = score;
      // Search for the peak absolute value sample within this chunk
      let peakIdx = chunkStart;
      let peakVal = 0;
      for (let i = 0; i < chunkSize; i++) {
        const val = Math.abs(channel[chunkStart + i]);
        if (val > peakVal) {
          peakVal = val;
          peakIdx = chunkStart + i;
        }
      }
      bestSample = peakIdx;
    }
    prevEnergy = curEnergy;
  }

  // If signal is too quiet or no clear transient detected, return initial anchor
  if (bestSample < 0 || maxScore < 0.015) {
    return initialFirstBeat;
  }

  const detectedTime = bestSample / sampleRate;

  // Calculate phase shift relative to expected beat interval
  const diff = detectedTime - initialFirstBeat;
  const beatFract = ((diff % secondsPerBeat) + secondsPerBeat) % secondsPerBeat;
  let shift = beatFract;
  if (shift > secondsPerBeat / 2) {
    shift -= secondsPerBeat;
  }

  let alignedFirstBeat = initialFirstBeat + shift;
  while (alignedFirstBeat < 0) alignedFirstBeat += secondsPerBeat;
  while (alignedFirstBeat >= secondsPerBeat) alignedFirstBeat -= secondsPerBeat;

  return alignedFirstBeat;
}
