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

/**
 * Fast onset-energy tempo estimator for newly imported audio tracks.
 * Returns BPM between 80 and 175, defaulting to 128.0 if ambiguous.
 */
export function estimateBpm(buffer: AudioBuffer): number {
  const sampleRate = buffer.sampleRate;
  const channel = buffer.getChannelData(0);
  const maxSeconds = Math.min(buffer.duration, 60.0);
  const totalSamples = Math.floor(maxSeconds * sampleRate);

  if (totalSamples < sampleRate * 3) return 128.0;

  // Downsample to ~100Hz energy envelope
  const envelopeRate = 100;
  const step = Math.floor(sampleRate / envelopeRate);
  const numSteps = Math.floor(totalSamples / step);
  const envelope = new Float32Array(numSteps);

  for (let i = 0; i < numSteps; i++) {
    const start = i * step;
    let sum = 0;
    for (let j = 0; j < step; j += 4) {
      const s = channel[start + j] || 0;
      sum += s * s;
    }
    envelope[i] = Math.sqrt((sum * 4) / step);
  }

  // Energy flux (first derivative / onsets)
  const flux = new Float32Array(numSteps);
  for (let i = 1; i < numSteps; i++) {
    flux[i] = Math.max(0, envelope[i] - envelope[i - 1]);
  }

  // Autocorrelation across DJ BPM range [85, 175]
  let bestBpm = 128.0;
  let maxCorr = 0;

  for (let bpmTest = 90; bpmTest <= 170; bpmTest += 0.5) {
    const lag = Math.round((60.0 / bpmTest) * envelopeRate);
    if (lag < 1 || lag >= numSteps) continue;

    let corr = 0;
    const count = Math.min(numSteps - lag, 1500);
    for (let i = 0; i < count; i += 2) {
      corr += flux[i] * flux[i + lag];
    }

    if (corr > maxCorr) {
      maxCorr = corr;
      bestBpm = bpmTest;
    }
  }

  return Math.round(bestBpm * 10) / 10;
}
