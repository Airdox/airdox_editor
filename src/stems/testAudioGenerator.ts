/**
 * TestAudioGenerator – deterministic EDM material for engine tests.
 *
 * Part 1 uses this to drive the technical gate; part 2 (Stem Isolation Gate)
 * extends the same generator with ground truth, bleed, reverb/delay scenarios
 * and perceptual QA. Everything is generated from a fixed seed, so a test run
 * is bit reproducible.
 *
 * The generator is NOT a separation engine and must never be used as one.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeWavFloat32, sha256Bytes } from './wavIo';
import type { StemId } from './types';

export interface TestTrackOptions {
  seconds?: number;
  sampleRate?: number;
  bpm?: number;
  seed?: number;
}

export interface GeneratedTrack {
  sampleRate: number;
  channels: 2;
  frames: number;
  seconds: number;
  /** Ground truth stems, interleaved stereo. */
  stems: Map<StemId, Float32Array>;
  stemOrder: StemId[];
  /** The mix the stems sum to (before limiting). */
  mix: Float32Array;
  /** Kick onset positions in frames – used for boundary/transient tests. */
  transientFrames: number[];
  meta: Record<string, unknown>;
}

/**
 * Band limited sawtooth (additive, 1/n amplitudes).
 *
 * A mathematically hard sawtooth has a sample level discontinuity every period.
 * That would make the boundary click detector fire on the *material* instead of
 * on real chunk artefacts – and no real synthesiser produces it either.
 */
export function bandLimitedSaw(freq: number, t: number, sampleRate: number, harmonics = 16): number {
  const maxHarmonics = Math.max(1, Math.min(harmonics, Math.floor(sampleRate / (2 * freq))));
  let value = 0;
  for (let h = 1; h <= maxHarmonics; h++) {
    value += (Math.sin(2 * Math.PI * freq * h * t) * (h % 2 === 0 ? -1 : 1)) / h;
  }
  return value * (2 / Math.PI);
}

/** Deterministic PRNG (mulberry32). Exported so other generators (§3: gold standard) use the same, seeded, reproducible source of randomness. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function addKick(target: Float32Array, frames: number, sampleRate: number, start: number, gain: number): void {
  const length = Math.floor(sampleRate * 0.28);
  for (let i = 0; i < length && start + i < frames; i++) {
    const t = i / sampleRate;
    const freq = 45 + 90 * Math.exp(-t * 34);
    const envelope = Math.exp(-t * 9);
    const value = Math.sin(2 * Math.PI * freq * t) * envelope * gain;
    target[(start + i) * 2] += value;
    target[(start + i) * 2 + 1] += value;
  }
}

export function addNoiseBurst(target: Float32Array, frames: number, sampleRate: number, start: number, length: number, gain: number, highPass: number, random: () => number): void {
  let previousLeft = 0;
  let previousRight = 0;
  let lastRawLeft = 0;
  let lastRawRight = 0;
  for (let i = 0; i < length && start + i < frames; i++) {
    const envelope = Math.exp(-(i / sampleRate) * 42);
    const rawL = (random() * 2 - 1) * gain;
    const rawR = (random() * 2 - 1) * gain;
    // One pole high pass (y[n] = a * (y[n-1] + x[n] - x[n-1])) keeps the burst
    // in the "hat" region and is DC free by construction.
    const outL = highPass * (previousLeft + rawL - lastRawLeft);
    const outR = highPass * (previousRight + rawR - lastRawRight);
    lastRawLeft = rawL;
    lastRawRight = rawR;
    previousLeft = outL;
    previousRight = outR;
    target[(start + i) * 2] += outL * envelope;
    target[(start + i) * 2 + 1] += outR * envelope;
  }
}

export function addSupersaw(target: Float32Array, frames: number, sampleRate: number, freq: number, start: number, length: number, gain: number, width: number): void {
  const voices = 7;
  for (let i = 0; i < length && start + i < frames; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.02);
    const release = Math.min(1, (length - i) / (sampleRate * 0.08));
    let left = 0;
    let right = 0;
    for (let v = 0; v < voices; v++) {
      const detune = 1 + (v - (voices - 1) / 2) * 0.0035;
      const saw = bandLimitedSaw(freq * detune, t, sampleRate, 24);
      const pan = (v / (voices - 1)) * 2 - 1;
      left += saw * (1 - pan * width) * 0.5;
      right += saw * (1 + pan * width) * 0.5;
    }
    const envelope = attack * release * gain;
    target[(start + i) * 2] += (left / voices) * envelope;
    target[(start + i) * 2 + 1] += (right / voices) * envelope;
  }
}

export function addVocal(target: Float32Array, frames: number, sampleRate: number, freq: number, start: number, length: number, gain: number): void {
  const harmonics = [1, 2, 3, 4, 5];
  const weights = [1, 0.55, 0.34, 0.2, 0.12];
  for (let i = 0; i < length && start + i < frames; i++) {
    const t = i / sampleRate;
    const vibrato = 1 + 0.012 * Math.sin(2 * Math.PI * 5.4 * t);
    let value = 0;
    for (let h = 0; h < harmonics.length; h++) {
      value += Math.sin(2 * Math.PI * freq * harmonics[h] * vibrato * t) * weights[h];
    }
    const attack = Math.min(1, t / 0.03);
    const release = Math.min(1, (length - i) / (sampleRate * 0.12));
    const envelope = attack * release * gain * 0.35;
    // Reverb-like tail: a short feedback comb on the same buffer.
    target[(start + i) * 2] += value * envelope;
    target[(start + i) * 2 + 1] += value * envelope;
    const delayFrames = Math.floor(sampleRate * 0.083);
    if (start + i + delayFrames < frames) {
      target[(start + i + delayFrames) * 2] += value * envelope * 0.22;
      target[(start + i + delayFrames) * 2 + 1] += value * envelope * 0.16;
    }
  }
}

/**
 * Generates a short techno style arrangement: four on the floor kick, offbeat
 * hats, sidechained sub bass, wide supersaw chords and a centre vocal with a
 * short delay tail. Stereo content (width, delay, panning) is deliberate so the
 * engine's stereo preservation can be measured.
 */
export function generateEdmTestTrack(options: TestTrackOptions = {}): GeneratedTrack {
  const sampleRate = options.sampleRate ?? 44100;
  const seconds = options.seconds ?? 6;
  const bpm = options.bpm ?? 126;
  const frames = Math.floor(sampleRate * seconds);
  const random = prng(options.seed ?? 0x5eed);

  const stemOrder: StemId[] = ['vocals', 'drums', 'bass', 'other'];
  const stems = new Map<StemId, Float32Array>(stemOrder.map((stem) => [stem, new Float32Array(frames * 2)]));
  const drums = stems.get('drums')!;
  const bass = stems.get('bass')!;
  const other = stems.get('other')!;
  const vocals = stems.get('vocals')!;

  const beatFrames = Math.floor((60 / bpm) * sampleRate);
  const transientFrames: number[] = [];
  const bassNotes = [55, 55, 73.42, 49];
  const chordRoots = [220, 261.63, 174.61];

  for (let beat = 0, frame = 0; frame < frames; beat++, frame += beatFrames) {
    addKick(drums, frames, sampleRate, frame, 0.95);
    transientFrames.push(frame);
    addNoiseBurst(drums, frames, sampleRate, frame + Math.floor(beatFrames / 2), Math.floor(sampleRate * 0.06), 0.5, 0.72, random);
    if (beat % 4 === 2) {
      addNoiseBurst(drums, frames, sampleRate, frame, Math.floor(sampleRate * 0.12), 0.42, 0.45, random);
    }

    const noteLength = Math.floor(beatFrames * 0.9);
    const noteFreq = bassNotes[beat % bassNotes.length];
    for (let i = 0; i < noteLength && frame + i < frames; i++) {
      const t = i / sampleRate;
      // Sidechain pumping: the bass ducks right after every kick.
      const duck = 1 - 0.72 * Math.exp(-t * 26);
      const saw = bandLimitedSaw(noteFreq, t, sampleRate, 16);
      const sub = Math.sin(2 * Math.PI * noteFreq * t);
      const value = (saw * 0.32 + sub * 0.68) * duck * 0.62 * Math.exp(-t * 1.2);
      bass[(frame + i) * 2] += value;
      bass[(frame + i) * 2 + 1] += value;
    }

    if (beat % 2 === 0) {
      const chordFrame = frame;
      const root = chordRoots[(beat / 2) % chordRoots.length | 0];
      for (const interval of [1, 1.1892, 1.4983]) {
        addSupersaw(other, frames, sampleRate, root * interval, chordFrame, Math.floor(beatFrames * 1.8), 0.16, 0.75);
      }
    }

    if (beat % 8 === 4) {
      const vocalFreq = 329.63 * (beat % 16 === 12 ? 1.1225 : 1);
      addVocal(vocals, frames, sampleRate, vocalFreq, frame, Math.floor(beatFrames * 3.2), 0.9);
    }
  }

  // Every ground truth stem is made DC free, exactly like a real stem export.
  for (const stem of stems.values()) {
    let sum = 0;
    for (let i = 0; i < stem.length; i++) sum += stem[i];
    const dc = sum / stem.length;
    if (Math.abs(dc) > 1e-9) for (let i = 0; i < stem.length; i++) stem[i] -= dc;
  }

  const mix = new Float32Array(frames * 2);
  for (const stem of stems.values()) {
    for (let i = 0; i < mix.length; i++) mix[i] += stem[i];
  }

  // Bus "master": linear normalisation to -1 dBFS only. Keeping the bus chain
  // linear means the ground truth stems still sum EXACTLY to the mixture, which
  // the recombination check of the technical gate depends on. Optional soft
  // saturation (part 2) is applied to a separate copy and reported as such.
  let peak = 0;
  for (let i = 0; i < mix.length; i++) peak = Math.max(peak, Math.abs(mix[i]));
  const target = 0.891; // -1 dBFS
  const gain = peak > 0 ? target / peak : 1;
  for (let i = 0; i < mix.length; i++) mix[i] *= gain;
  for (const stem of stems.values()) {
    for (let i = 0; i < stem.length; i++) stem[i] *= gain;
  }

  return {
    sampleRate,
    channels: 2,
    frames,
    seconds,
    stems,
    stemOrder,
    mix,
    transientFrames,
    meta: { bpm, seed: options.seed ?? 0x5eed, beats: Math.floor(frames / beatFrames), gain, busChain: 'linear-normalise' },
  };
}

export interface WrittenTestAudio {
  directory: string;
  mixPath: string;
  stemPaths: Map<StemId, string>;
  mixHash: string;
  stemHashes: Map<StemId, string>;
  track: GeneratedTrack;
}

/** Writes mix + ground truth stems as float32 WAV files (never overwrites originals). */
export async function writeTestAudio(directory: string, baseName: string, track: GeneratedTrack): Promise<WrittenTestAudio> {
  await mkdir(directory, { recursive: true });
  const mixBytes = encodeWavFloat32(track.sampleRate, 2, track.mix, track.frames);
  const mixPath = path.join(directory, `${baseName}_mixture.wav`);
  await writeFile(mixPath, mixBytes);
  const stemPaths = new Map<StemId, string>();
  const stemHashes = new Map<StemId, string>();
  for (const [stemId, data] of track.stems) {
    const bytes = encodeWavFloat32(track.sampleRate, 2, data, track.frames);
    const target = path.join(directory, `${baseName}_${stemId}.wav`);
    await writeFile(target, bytes);
    stemPaths.set(stemId, target);
    stemHashes.set(stemId, sha256Bytes(bytes));
  }
  return { directory, mixPath, stemPaths, mixHash: sha256Bytes(mixBytes), stemHashes, track };
}
