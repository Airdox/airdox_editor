/**
 * MixEffects – deterministic, dependency free bus processing primitives.
 *
 * Used exclusively to build the part 2 gold standard mix VARIANTS (§10:
 * normalised / compressed / limited / saturated / clipped / widened / …).
 * Every function is a pure, seed free transform of interleaved stereo
 * float32 so the whole test system stays bit reproducible (§3).
 *
 * None of this is separation code and none of it runs inside the engine –
 * it only *creates test material* that stresses the engine's assumptions
 * (linear sum, stereo width, transients) the way real masters do.
 */

export interface StereoBuffer {
  data: Float32Array;
  sampleRate: number;
  frames: number;
}

function clone(buffer: StereoBuffer): StereoBuffer {
  return { data: new Float32Array(buffer.data), sampleRate: buffer.sampleRate, frames: buffer.frames };
}

export function peakOf(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

export function linearToDb(value: number): number {
  return 20 * Math.log10(Math.max(Math.abs(value), 1e-12));
}

/** Peak normalisation to a target dBFS ceiling. */
export function peakNormalize(buffer: StereoBuffer, targetDb: number): StereoBuffer {
  const out = clone(buffer);
  const peak = peakOf(out.data) || 1e-9;
  const gain = dbToLinear(targetDb) / peak;
  for (let i = 0; i < out.data.length; i++) out.data[i] *= gain;
  return out;
}

export interface CompressorOptions {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

/**
 * Feed forward RMS compressor with exponential attack/release smoothing.
 * Simple by design (no lookahead) – enough to create a musically plausible
 * loudness/pumping profile for the "compressed" test variants.
 */
export function compress(buffer: StereoBuffer, options: CompressorOptions): StereoBuffer {
  const out = clone(buffer);
  const { thresholdDb, ratio, attackMs, releaseMs, makeupDb } = options;
  const attackCoeff = Math.exp(-1 / ((attackMs / 1000) * buffer.sampleRate));
  const releaseCoeff = Math.exp(-1 / ((releaseMs / 1000) * buffer.sampleRate));
  const makeup = dbToLinear(makeupDb);
  let envelope = 0;
  for (let f = 0; f < buffer.frames; f++) {
    const l = out.data[f * 2] || 0;
    const r = out.data[f * 2 + 1] || 0;
    const level = Math.sqrt((l * l + r * r) / 2);
    envelope = level > envelope ? attackCoeff * envelope + (1 - attackCoeff) * level : releaseCoeff * envelope + (1 - releaseCoeff) * level;
    const levelDb = linearToDb(envelope || 1e-9);
    let gainDb = 0;
    if (levelDb > thresholdDb) gainDb = (thresholdDb - levelDb) * (1 - 1 / ratio);
    const gain = dbToLinear(gainDb) * makeup;
    out.data[f * 2] = l * gain;
    out.data[f * 2 + 1] = r * gain;
  }
  return out;
}

/** Fast attack / fast release compressor used as a soft (non brickwall) limiter. */
export function softLimit(buffer: StereoBuffer, ceilingDb: number): StereoBuffer {
  return compress(buffer, { thresholdDb: ceilingDb - 0.2, ratio: 20, attackMs: 0.3, releaseMs: 50, makeupDb: 0 });
}

/** tanh waveshaper – odd-harmonic soft saturation. */
export function saturate(buffer: StereoBuffer, drive: number): StereoBuffer {
  const out = clone(buffer);
  const norm = Math.tanh(drive);
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.tanh(out.data[i] * drive) / norm;
  return out;
}

/** Hard digital clip at `ceiling` (intentional, tests robustness to over-level material). */
export function hardClip(buffer: StereoBuffer, ceiling: number): StereoBuffer {
  const out = clone(buffer);
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.max(-ceiling, Math.min(ceiling, out.data[i]));
  return out;
}

/** Mid/side stereo width control. factor 1 = unchanged, >1 = wider, <1 = narrower. */
export function stereoWidth(buffer: StereoBuffer, factor: number): StereoBuffer {
  const out = clone(buffer);
  for (let f = 0; f < buffer.frames; f++) {
    const l = out.data[f * 2] || 0;
    const r = out.data[f * 2 + 1] || 0;
    const mid = (l + r) * 0.5;
    const side = (l - r) * 0.5 * factor;
    out.data[f * 2] = mid + side;
    out.data[f * 2 + 1] = mid - side;
  }
  return out;
}

/** Slow, deterministic hard-pan LFO — stresses extreme, time varying stereo balance. */
export function extremePan(buffer: StereoBuffer, rateHz: number): StereoBuffer {
  const out = clone(buffer);
  for (let f = 0; f < buffer.frames; f++) {
    const t = f / buffer.sampleRate;
    const pan = Math.sin(2 * Math.PI * rateHz * t); // -1..1
    const leftGain = Math.min(1, 1 - pan);
    const rightGain = Math.min(1, 1 + pan);
    const l = out.data[f * 2] || 0;
    const r = out.data[f * 2 + 1] || 0;
    out.data[f * 2] = l * leftGain;
    out.data[f * 2 + 1] = r * rightGain;
  }
  return out;
}

export interface DelayOptions {
  timeMs: number;
  feedback: number;
  wet: number;
}

/** Simple feedback delay (stereo, cross-feeding taps for width). */
export function feedbackDelay(buffer: StereoBuffer, options: DelayOptions): StereoBuffer {
  const out = clone(buffer);
  const delaySamples = Math.max(1, Math.round((options.timeMs / 1000) * buffer.sampleRate));
  const wet = options.wet;
  const fb = options.feedback;
  for (let f = 0; f < buffer.frames; f++) {
    const srcIndex = f - delaySamples;
    if (srcIndex < 0) continue;
    const tapL = out.data[srcIndex * 2] || 0;
    const tapR = out.data[srcIndex * 2 + 1] || 0;
    out.data[f * 2] += tapR * fb * wet;
    out.data[f * 2 + 1] += tapL * fb * wet;
  }
  // Blend a direct wet copy at unity delay too (audible slap on top of feedback).
  const direct = new Float32Array(out.data.length);
  for (let f = 0; f < buffer.frames; f++) {
    const srcIndex = f - delaySamples;
    if (srcIndex < 0) continue;
    direct[f * 2] = buffer.data[srcIndex * 2] || 0;
    direct[f * 2 + 1] = buffer.data[srcIndex * 2 + 1] || 0;
  }
  for (let i = 0; i < out.data.length; i++) out.data[i] += direct[i] * wet;
  return out;
}

export interface ReverbOptions {
  wet: number;
  decay: number;
  predelayMs: number;
}

/**
 * Minimal Schroeder style reverb: four parallel comb filters into two
 * series all-pass stages. Not audiophile grade, but a genuinely diffuse,
 * frequency dependent tail – enough to make "heavy reverb" bleed test
 * material realistic (reverb energy smears across all sources it was
 * applied to, exactly what §12 asks to stress).
 */
export function simpleReverb(buffer: StereoBuffer, options: ReverbOptions): StereoBuffer {
  const { sampleRate } = buffer;
  const predelay = Math.round((options.predelayMs / 1000) * sampleRate);
  const combTimesMs = [29.7, 37.1, 41.1, 43.7];
  const allpassTimesMs = [5.0, 1.7];
  const input = new Float32Array(buffer.data.length + predelay * 2);
  for (let f = 0; f < buffer.frames; f++) {
    input[(f + predelay) * 2] = buffer.data[f * 2] || 0;
    input[(f + predelay) * 2 + 1] = buffer.data[f * 2 + 1] || 0;
  }
  const totalFrames = Math.floor(input.length / 2);

  function combFilter(channelData: Float32Array, delayMs: number, decay: number): Float32Array {
    const delay = Math.max(1, Math.round((delayMs / 1000) * sampleRate));
    const out = new Float32Array(channelData.length);
    const buf = new Float32Array(delay);
    let idx = 0;
    for (let i = 0; i < channelData.length; i++) {
      const delayed = buf[idx];
      out[i] = delayed;
      buf[idx] = channelData[i] + delayed * decay;
      idx = (idx + 1) % delay;
    }
    return out;
  }
  function allpassFilter(channelData: Float32Array, delayMs: number, g = 0.5): Float32Array {
    const delay = Math.max(1, Math.round((delayMs / 1000) * sampleRate));
    const out = new Float32Array(channelData.length);
    const buf = new Float32Array(delay);
    let idx = 0;
    for (let i = 0; i < channelData.length; i++) {
      const bufOut = buf[idx];
      const inVal = channelData[i];
      const vn = inVal - g * bufOut;
      out[i] = bufOut + g * vn;
      buf[idx] = vn;
      idx = (idx + 1) % delay;
    }
    return out;
  }

  const wetChannels: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const mono = new Float32Array(totalFrames);
    for (let f = 0; f < totalFrames; f++) mono[f] = input[f * 2 + c];
    let combSum = new Float32Array(totalFrames);
    for (const time of combTimesMs) {
      const comb = combFilter(mono, time + c * 0.6, options.decay);
      for (let i = 0; i < totalFrames; i++) combSum[i] += comb[i] / combTimesMs.length;
    }
    let ap = combSum;
    for (const time of allpassTimesMs) ap = allpassFilter(ap, time + c * 0.3);
    wetChannels.push(ap);
  }

  const out: StereoBuffer = { data: new Float32Array(buffer.data.length), sampleRate, frames: buffer.frames };
  for (let f = 0; f < buffer.frames; f++) {
    const dryL = buffer.data[f * 2] || 0;
    const dryR = buffer.data[f * 2 + 1] || 0;
    const wetL = wetChannels[0][f] || 0;
    const wetR = wetChannels[1][f] || 0;
    out.data[f * 2] = dryL + wetL * options.wet;
    out.data[f * 2 + 1] = dryR + wetR * options.wet;
  }
  return out;
}

export interface SidechainOptions {
  beatFrames: number;
  duckDb: number;
  attackMs: number;
  releaseMs: number;
  offsetFrames?: number;
}

/**
 * Global (mix bus) sidechain ducking synced to a beat grid – the classic
 * "pumping" master bus compressor found on almost every commercial EDM
 * master. Applied post-sum, unlike the per-stem sidechain already baked
 * into the bass stem of the gold standard track.
 */
export function sidechainDuck(buffer: StereoBuffer, options: SidechainOptions): StereoBuffer {
  const out = clone(buffer);
  const attackSamples = Math.max(1, Math.round((options.attackMs / 1000) * buffer.sampleRate));
  const releaseSamples = Math.max(1, Math.round((options.releaseMs / 1000) * buffer.sampleRate));
  const duckGain = dbToLinear(options.duckDb);
  const offset = options.offsetFrames ?? 0;
  for (let f = 0; f < buffer.frames; f++) {
    const sincePulse = ((f - offset) % options.beatFrames + options.beatFrames) % options.beatFrames;
    let gain: number;
    if (sincePulse < attackSamples) {
      gain = 1 - (1 - duckGain) * (sincePulse / attackSamples);
    } else if (sincePulse < attackSamples + releaseSamples) {
      const x = (sincePulse - attackSamples) / releaseSamples;
      gain = duckGain + (1 - duckGain) * x;
    } else {
      gain = 1;
    }
    out.data[f * 2] *= gain;
    out.data[f * 2 + 1] *= gain;
  }
  return out;
}
