/**
 * @license
 * Effect Engine – pure DSP helpers for effect tracks.
 *
 * Deliberately free of Web Audio API dependencies so it can be unit tested in
 * plain Node (see tests/effect-engine.test.ts). All functions operate on
 * Float32Array channel data and mutate it in place over a sample range.
 */

import { EffectSegment, EffectTrack, EffectType } from '../types/rekordbox';

/** Clamps a value into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/**
 * Converts a segment's time range into a sample range clipped to the buffer.
 * Returns null when the segment lies fully outside the buffer.
 */
export function segmentToSampleRange(
  segment: EffectSegment,
  sampleRate: number,
  length: number
): { start: number; end: number } | null {
  const start = Math.max(0, Math.floor(segment.startTime * sampleRate));
  const end = Math.min(length, Math.ceil(segment.endTime * sampleRate));
  if (end <= start) return null;
  return { start, end };
}

/**
 * GAIN – linear amplitude multiplication.
 * `amount` is the gain factor (1 = unchanged, 0 = silence).
 */
export function applyGain(
  data: Float32Array,
  start: number,
  end: number,
  amount: number
): void {
  const gain = clamp(amount, 0, 8);
  for (let i = start; i < end; i++) {
    data[i] = data[i] * gain;
  }
}

/**
 * LOWPASS – one-pole IIR lowpass filter.
 * `cutoffHz` is the -3 dB corner frequency.
 */
export function applyLowpass(
  data: Float32Array,
  start: number,
  end: number,
  cutoffHz: number,
  sampleRate: number
): void {
  const nyquist = sampleRate / 2;
  const cutoff = clamp(cutoffHz, 20, Math.max(21, nyquist - 1));
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoff);
  const alpha = dt / (rc + dt);

  let prev = data[start];
  for (let i = start; i < end; i++) {
    prev = prev + alpha * (data[i] - prev);
    data[i] = prev;
  }
}

/**
 * ECHO – feedback delay line.
 * `delayTime` in seconds, `feedback` in [0, 0.95), `mix` in [0, 1].
 */
export function applyEcho(
  data: Float32Array,
  start: number,
  end: number,
  delayTime: number,
  feedback: number,
  mix: number,
  sampleRate: number
): void {
  const delaySamples = Math.max(1, Math.floor(clamp(delayTime, 0.001, 5) * sampleRate));
  const fb = clamp(feedback, 0, 0.95);
  const wet = clamp(mix, 0, 1);
  if (wet === 0) return;

  const length = end - start;
  const dry = new Float32Array(length);
  dry.set(data.subarray(start, end));

  const wetBuf = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const delayed = i >= delaySamples ? wetBuf[i - delaySamples] : 0;
    wetBuf[i] = dry[i] + delayed * fb;
  }

  for (let i = 0; i < length; i++) {
    data[start + i] = dry[i] * (1 - wet) + wetBuf[i] * wet;
  }
}

/**
 * Applies a single effect segment to one channel of audio data.
 * Unknown effect types are ignored (forward compatible).
 */
export function applyEffectSegment(
  data: Float32Array,
  segment: EffectSegment,
  sampleRate: number
): void {
  if (segment.bypass) return;
  const range = segmentToSampleRange(segment, sampleRate, data.length);
  if (!range) return;

  const p = segment.params ?? {};
  const type: EffectType = segment.type;

  switch (type) {
    case 'GAIN':
      applyGain(data, range.start, range.end, p.amount ?? 1);
      break;
    case 'LOWPASS':
      applyLowpass(data, range.start, range.end, p.cutoffHz ?? 1000, sampleRate);
      break;
    case 'ECHO':
      applyEcho(
        data,
        range.start,
        range.end,
        p.delayTime ?? 0.25,
        p.feedback ?? 0.4,
        p.mix ?? 0.5,
        sampleRate
      );
      break;
    default:
      break;
  }
}

/**
 * Applies every non-muted effect track (in order) to one channel.
 */
export function applyEffectTracks(
  data: Float32Array,
  tracks: EffectTrack[],
  sampleRate: number
): void {
  for (const track of tracks) {
    if (track.muted) continue;
    for (const segment of track.segments) {
      applyEffectSegment(data, segment, sampleRate);
    }
  }
}
