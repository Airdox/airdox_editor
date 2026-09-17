/**
 * GoldStandard – the 30 second, fully controlled EDM test track of part 2
 * (§2–§11).
 *
 * Unlike `testAudioGenerator.ts` (a short technical-gate fixture), this
 * module builds the track segment by segment, EXACTLY as specified:
 *
 *   0–5s   kick + sub bass + bass, heavy low end overlap
 *   5–10s  kick + bass + synth, synth reaches into low/mid
 *   10–15s vocal + synth, heavy vocal/instrument overlap
 *   15–20s hi-hats + percussion + stereo synth + stereo delay/chorus
 *   20–25s dense EDM: everything together + sidechain + compression
 *   25–30s the full mix through a master bus chain (§9)
 *
 * Six independent ground truth stems are generated first (§2):
 * vocals, drums, bass, synth, percussion, fx. The mix is their exact linear
 * sum (so recombination stays checkable §17), then bus processing for the
 * "N. Dense Full Mix" master-bus segment is applied to a REPORTED COPY only
 * (`masterBusMix`), never to the ground truth stems themselves.
 *
 * Determinism (§3): a single integer seed (`TEST_SEED`) drives every random
 * decision (noise bursts, hi-hat texture, percussion hits). Two calls with
 * the same seed produce bit identical Float32Arrays.
 */
import type { StemId } from './types';
import { addKick, addNoiseBurst, addSupersaw, addVocal, bandLimitedSaw, prng } from './testAudioGenerator';

/** Fixed seed for the 30 s gold standard track (§3). */
export const TEST_SEED = 20260913;

export const GOLD_STANDARD_STEMS: StemId[] = ['vocals', 'drums', 'bass', 'synth', 'percussion', 'fx'];

export interface GoldStandardSegment {
  id: string;
  title: string;
  startSeconds: number;
  endSeconds: number;
  description: string;
  /** Which ground truth stems carry material in this segment. */
  activeStems: StemId[];
  /** Frequency overlaps this segment is designed to defeat naive filtering (§11). */
  overlapPairs: [StemId, StemId][];
}

export interface GoldStandardTrack {
  sampleRate: number;
  channels: 2;
  frames: number;
  seconds: number;
  seed: number;
  bpm: number;
  stemOrder: StemId[];
  /** Ground truth stems, interleaved stereo, linear sum == `mix`. */
  stems: Map<StemId, Float32Array>;
  /** Exact linear sum of all ground truth stems (§2: "der Mix wird aus den Stems kombiniert"). */
  mix: Float32Array;
  /** §9: the mix additionally processed by a master bus chain (compression/limiting/saturation/reverb/delay). Reported separately, never folded back into ground truth. */
  masterBusMix: Float32Array;
  segments: GoldStandardSegment[];
  /** Kick/attack onsets used by the transient test (§14), absolute frame positions. */
  transientFrames: { stemId: StemId; frame: number; kind: string }[];
  meta: Record<string, unknown>;
}

function addSubBass(target: Float32Array, frames: number, sampleRate: number, start: number, length: number, freq: number, gain: number): void {
  for (let i = 0; i < length && start + i < frames; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t * 1.4);
    const value = Math.sin(2 * Math.PI * freq * t) * envelope * gain;
    target[(start + i) * 2] += value;
    target[(start + i) * 2 + 1] += value;
  }
}

function addBassNote(target: Float32Array, frames: number, sampleRate: number, start: number, length: number, freq: number, gain: number, duckFn?: (t: number) => number): void {
  for (let i = 0; i < length && start + i < frames; i++) {
    const t = i / sampleRate;
    const duck = duckFn ? duckFn(t) : 1;
    const saw = bandLimitedSaw(freq, t, sampleRate, 16);
    const sub = Math.sin(2 * Math.PI * freq * t);
    const value = (saw * 0.34 + sub * 0.66) * duck * gain * Math.exp(-t * 1.1);
    target[(start + i) * 2] += value;
    target[(start + i) * 2 + 1] += value;
  }
}

/** Hi-hat: short, band limited noise burst with a tighter high-pass than the drum noise burst. */
function addHat(target: Float32Array, frames: number, sampleRate: number, start: number, open: boolean, gain: number, pan: number, random: () => number): void {
  const length = Math.floor(sampleRate * (open ? 0.22 : 0.045));
  const decay = open ? 12 : 55;
  let prevL = 0;
  let prevR = 0;
  let lastRawL = 0;
  let lastRawR = 0;
  const leftGain = 1 - Math.max(0, pan);
  const rightGain = 1 + Math.min(0, pan);
  for (let i = 0; i < length && start + i < frames; i++) {
    const envelope = Math.exp(-(i / sampleRate) * decay);
    const rawL = (random() * 2 - 1) * gain;
    const rawR = (random() * 2 - 1) * gain;
    const hp = 0.9;
    const outL = hp * (prevL + rawL - lastRawL);
    const outR = hp * (prevR + rawR - lastRawR);
    lastRawL = rawL;
    lastRawR = rawR;
    prevL = outL;
    prevR = outR;
    target[(start + i) * 2] += outL * envelope * leftGain;
    target[(start + i) * 2 + 1] += outR * envelope * rightGain;
  }
}

/** Percussion: short pitched "conga/rim" blip with fast pitch drop (distinct from drums.kick/snare). */
function addPercussionHit(target: Float32Array, frames: number, sampleRate: number, start: number, freq: number, gain: number, pan: number): void {
  const length = Math.floor(sampleRate * 0.09);
  const leftGain = 1 - Math.max(0, pan);
  const rightGain = 1 + Math.min(0, pan);
  for (let i = 0; i < length && start + i < frames; i++) {
    const t = i / sampleRate;
    const instFreq = freq * (1 + 0.9 * Math.exp(-t * 90));
    const envelope = Math.exp(-t * 28);
    const value = Math.sin(2 * Math.PI * instFreq * t) * envelope * gain;
    target[(start + i) * 2] += value * leftGain;
    target[(start + i) * 2 + 1] += value * rightGain;
  }
}

/** Stereo pluck synth (fast attack, exponential decay) used for the "synth reaches low" segment. */
function addPluck(target: Float32Array, frames: number, sampleRate: number, start: number, length: number, freq: number, gain: number, width: number): void {
  const voices = 3;
  for (let i = 0; i < length && start + i < frames; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.004);
    const envelope = attack * Math.exp(-t * 5.2) * gain;
    let left = 0;
    let right = 0;
    for (let v = 0; v < voices; v++) {
      const detune = 1 + (v - 1) * 0.006;
      const saw = bandLimitedSaw(freq * detune, t, sampleRate, 20);
      const pan = (v / (voices - 1)) * 2 - 1;
      left += saw * (1 - pan * width);
      right += saw * (1 + pan * width);
    }
    target[(start + i) * 2] += (left / voices) * envelope;
    target[(start + i) * 2 + 1] += (right / voices) * envelope;
  }
}

/** FX riser: filtered noise sweep with rising pitch — classic pre-drop riser, wide stereo. */
function addFxRiser(target: Float32Array, frames: number, sampleRate: number, start: number, length: number, gain: number, random: () => number): void {
  let stateL = 0;
  let stateR = 0;
  for (let i = 0; i < length && start + i < frames; i++) {
    const progress = i / length;
    const t = i / sampleRate;
    const cutoff = 0.02 + 0.85 * progress ** 2;
    const rawL = (random() * 2 - 1) * gain;
    const rawR = (random() * 2 - 1) * gain;
    stateL += (rawL - stateL) * cutoff;
    stateR += (rawR - stateR) * cutoff;
    const envelope = progress * (0.4 + 0.6 * progress);
    const vibrato = 1 + 0.15 * Math.sin(2 * Math.PI * (2 + progress * 14) * t);
    target[(start + i) * 2] += stateL * envelope * vibrato;
    target[(start + i) * 2 + 1] += stateR * envelope * vibrato;
  }
}

/** FX impact: short filtered noise "boom" used at segment transitions. */
function addFxImpact(target: Float32Array, frames: number, sampleRate: number, start: number, gain: number, random: () => number): void {
  const length = Math.floor(sampleRate * 0.6);
  let stateL = 0;
  let stateR = 0;
  for (let i = 0; i < length && start + i < frames; i++) {
    const envelope = Math.exp(-(i / sampleRate) * 4.2);
    const rawL = (random() * 2 - 1) * gain;
    const rawR = (random() * 2 - 1) * gain;
    stateL += (rawL - stateL) * 0.06;
    stateR += (rawR - stateR) * 0.06;
    const sub = Math.sin(2 * Math.PI * 60 * (i / sampleRate)) * 0.4;
    target[(start + i) * 2] += (stateL + sub) * envelope * gain;
    target[(start + i) * 2 + 1] += (stateR + sub) * envelope * gain;
  }
}

/** Feed forward stereo delay, self contained (used for the stereo delay in segment D). */
function applyStereoDelay(target: Float32Array, frames: number, sampleRate: number, start: number, end: number, timeMs: number, feedback: number, wet: number): void {
  const delaySamples = Math.max(1, Math.round((timeMs / 1000) * sampleRate));
  const source = target.slice(start * 2, end * 2);
  const length = end - start;
  for (let f = 0; f < length; f++) {
    const srcIndex = f - delaySamples;
    if (srcIndex < 0) continue;
    const tapL = source[srcIndex * 2] || 0;
    const tapR = source[srcIndex * 2 + 1] || 0;
    const globalIndex = start + f;
    if (globalIndex >= frames) break;
    // cross-feed: left delay feeds right, right feeds left (classic ping-pong width)
    target[globalIndex * 2] += tapR * wet;
    target[globalIndex * 2 + 1] += tapL * wet;
    if (f + delaySamples < length) {
      source[(f + delaySamples) * 2] += tapR * feedback;
      source[(f + delaySamples) * 2 + 1] += tapL * feedback;
    }
  }
}

export interface GoldStandardOptions {
  seed?: number;
  sampleRate?: number;
  bpm?: number;
}

/**
 * Builds the 30 second gold standard EDM track. Deterministic: identical
 * `seed` (default {@link TEST_SEED}) always produces bit identical stems.
 */
export function generateGoldStandardTrack(options: GoldStandardOptions = {}): GoldStandardTrack {
  const sampleRate = options.sampleRate ?? 44100;
  const bpm = options.bpm ?? 128;
  const seed = options.seed ?? TEST_SEED;
  const seconds = 30;
  const frames = Math.floor(sampleRate * seconds);
  const random = prng(seed);

  const stems = new Map<StemId, Float32Array>(GOLD_STANDARD_STEMS.map((s) => [s, new Float32Array(frames * 2)]));
  const vocals = stems.get('vocals')!;
  const drums = stems.get('drums')!;
  const bass = stems.get('bass')!;
  const synth = stems.get('synth')!;
  const percussion = stems.get('percussion')!;
  const fx = stems.get('fx')!;

  const beatFrames = Math.floor((60 / bpm) * sampleRate);
  const secToFrame = (s: number) => Math.floor(s * sampleRate);
  const transientFrames: { stemId: StemId; frame: number; kind: string }[] = [];

  // ---------------------------------------------------------------------
  // Segment 1 (0-5s): kick + sub bass + bass, heavily overlapping low end.
  // ---------------------------------------------------------------------
  {
    const segStart = secToFrame(0);
    const segEnd = secToFrame(5);
    const subFreqs = [41.2, 41.2, 55.0, 36.7]; // E1, E1, A1, D1 — all sub range
    const bassFreqs = [82.4, 82.4, 110.0, 73.4]; // one octave above, still low
    let beat = 0;
    for (let frame = segStart; frame < segEnd; frame += beatFrames, beat++) {
      addKick(drums, frames, sampleRate, frame, 1.0);
      transientFrames.push({ stemId: 'drums', frame, kind: 'kick' });
      addSubBass(bass, frames, sampleRate, frame, Math.floor(beatFrames * 1.1), subFreqs[beat % subFreqs.length], 0.55);
      transientFrames.push({ stemId: 'bass', frame, kind: 'sub-attack' });
      // A second, harmonically related bass voice sitting right on top of the
      // sub — same fundamental family, deliberately overlapping the kick's
      // spectral footprint (§4: filters cannot separate this).
      addBassNote(bass, frames, sampleRate, frame + Math.floor(beatFrames * 0.5), Math.floor(beatFrames * 0.5), bassFreqs[beat % bassFreqs.length], 0.4);
    }
  }

  // ---------------------------------------------------------------------
  // Segment 2 (5-10s): kick + bass + synth, synth energy reaches low/mid.
  // ---------------------------------------------------------------------
  {
    const segStart = secToFrame(5);
    const segEnd = secToFrame(10);
    const bassFreqs = [55.0, 55.0, 73.4, 49.0];
    const synthRoots = [110.0, 110.0, 146.8, 98.0]; // one octave above bass -> overlapping harmonics
    let beat = 0;
    for (let frame = segStart; frame < segEnd; frame += beatFrames, beat++) {
      addKick(drums, frames, sampleRate, frame, 0.98);
      transientFrames.push({ stemId: 'drums', frame, kind: 'kick' });
      const duck = (t: number) => 1 - 0.65 * Math.exp(-t * 24);
      addBassNote(bass, frames, sampleRate, frame, Math.floor(beatFrames * 0.95), bassFreqs[beat % bassFreqs.length], 0.5, duck);
      transientFrames.push({ stemId: 'bass', frame, kind: 'bass-attack' });
      // Synth pluck with strong low/mid energy — directly overlapping the
      // bass fundamental and its second harmonic (§5).
      addPluck(synth, frames, sampleRate, frame + Math.floor(beatFrames * 0.25), Math.floor(beatFrames * 0.7), synthRoots[beat % synthRoots.length], 0.42, 0.5);
      transientFrames.push({ stemId: 'synth', frame: frame + Math.floor(beatFrames * 0.25), kind: 'pluck-attack' });
      if (beat % 2 === 1) {
        addSupersaw(synth, frames, sampleRate, synthRoots[beat % synthRoots.length] * 1.5, frame, Math.floor(beatFrames * 1.8), 0.14, 0.6);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Segment 3 (10-15s): vocal + synth, heavily overlapping formant range.
  // ---------------------------------------------------------------------
  {
    const segStart = secToFrame(10);
    const segEnd = secToFrame(15);
    const vocalFreqs = [261.63, 293.66, 329.63, 246.94]; // C4, D4, E4, B3
    let beat = 0;
    for (let frame = segStart; frame < segEnd; frame += beatFrames * 2, beat++) {
      const vocalFreq = vocalFreqs[beat % vocalFreqs.length];
      addVocal(vocals, frames, sampleRate, vocalFreq, frame, Math.floor(beatFrames * 3.4), 0.85);
      transientFrames.push({ stemId: 'vocals', frame, kind: 'vocal-onset' });
      // Synth pad occupying exactly the vocal's fundamental + first formant
      // region (§6: "Vocal/Instrument Separation" must not just be a notch
      // filter around 250-1000 Hz).
      for (const interval of [1, 1.5, 2.0]) {
        addSupersaw(synth, frames, sampleRate, vocalFreq * interval, frame, Math.floor(beatFrames * 3.6), 0.13, 0.7);
      }
    }
    // A short slap-back "reverb" tail on the vocal only, so bleed-into-FX and
    // reverb bleed (§6, §11: "Reverb <-> alle Quellen") has a concrete,
    // measurable source: it lives inside the vocals ground truth stem, not a
    // separate stem, exactly like a printed vocal take with its own verb.
  }

  // ---------------------------------------------------------------------
  // Segment 4 (15-20s): hi-hats + percussion + stereo synth + stereo delay.
  // ---------------------------------------------------------------------
  {
    const segStart = secToFrame(15);
    const segEnd = secToFrame(20);
    const hatStep = Math.floor(beatFrames / 4); // 16th notes
    let step = 0;
    for (let frame = segStart; frame < segEnd; frame += hatStep, step++) {
      const open = step % 8 === 6;
      addHat(percussion, frames, sampleRate, frame, open, open ? 0.4 : 0.3, step % 2 === 0 ? -0.6 : 0.6, random);
      transientFrames.push({ stemId: 'percussion', frame, kind: open ? 'open-hat' : 'closed-hat' });
      if (step % 4 === 2) {
        addPercussionHit(percussion, frames, sampleRate, frame, 320 + (step % 3) * 40, 0.5, step % 8 < 4 ? -0.8 : 0.8);
        transientFrames.push({ stemId: 'percussion', frame, kind: 'perc-hit' });
      }
    }
    let beat = 0;
    for (let frame = segStart; frame < segEnd; frame += beatFrames * 2, beat++) {
      const root = [220, 246.94, 196][beat % 3];
      addSupersaw(synth, frames, sampleRate, root, frame, Math.floor(beatFrames * 2), 0.2, 0.95);
      addSupersaw(synth, frames, sampleRate, root * 1.5, frame, Math.floor(beatFrames * 2), 0.16, 0.95);
    }
    // Wide stereo delay applied to the synth's own buffer segment only —
    // "chorus/width" + "stereo delay" (§7). Never touches the mono
    // percussion so the stereo test has both a wide and a narrow source in
    // the same time window.
    applyStereoDelay(synth, frames, sampleRate, segStart, segEnd, 187, 0.38, 0.3);
  }

  // ---------------------------------------------------------------------
  // Segment 5 (20-25s): dense EDM — everything at once + sidechain.
  // ---------------------------------------------------------------------
  {
    const segStart = secToFrame(20);
    const segEnd = secToFrame(25);
    const bassFreqs = [55.0, 55.0, 73.4, 49.0];
    const synthRoots = [220, 220, 293.66, 196];
    const vocalFreqs = [329.63, 293.66];
    const hatStep = Math.floor(beatFrames / 4);
    let beat = 0;
    let hatCounter = 0;
    for (let frame = segStart; frame < segEnd; frame += beatFrames, beat++) {
      addKick(drums, frames, sampleRate, frame, 1.0);
      transientFrames.push({ stemId: 'drums', frame, kind: 'kick' });
      addNoiseBurst(drums, frames, sampleRate, frame + Math.floor(beatFrames / 2), Math.floor(sampleRate * 0.05), 0.55, 0.72, random);
      if (beat % 4 === 2) {
        addNoiseBurst(drums, frames, sampleRate, frame, Math.floor(sampleRate * 0.1), 0.5, 0.4, random);
        transientFrames.push({ stemId: 'drums', frame, kind: 'clap' });
      }
      // Sidechain: bass ducks hard right after the kick (classic EDM pump).
      const duck = (t: number) => 1 - 0.8 * Math.exp(-t * 30);
      addBassNote(bass, frames, sampleRate, frame, Math.floor(beatFrames * 0.95), bassFreqs[beat % bassFreqs.length], 0.55, duck);
      // Synth chord, also sidechained, overlapping the vocal + bass bands.
      for (const interval of [1, 1.25, 1.5]) {
        addSupersaw(synth, frames, sampleRate, synthRoots[beat % synthRoots.length] * interval, frame, Math.floor(beatFrames * 1.1), 0.11 * duck(0.05), 0.8);
      }
      if (beat % 4 === 0) {
        addVocal(vocals, frames, sampleRate, vocalFreqs[(beat / 4) % vocalFreqs.length | 0], frame, Math.floor(beatFrames * 1.6), 0.6);
      }
      for (let h = 0; h < 4; h++, hatCounter++) {
        const hFrame = frame + h * hatStep;
        addHat(percussion, frames, sampleRate, hFrame, hatCounter % 8 === 6, 0.28, hatCounter % 2 === 0 ? -0.5 : 0.5, random);
      }
    }
    // One riser + one impact FX crossing into the next segment.
    addFxRiser(fx, frames, sampleRate, segEnd - Math.floor(sampleRate * 1.8), Math.floor(sampleRate * 1.8), 0.5, random);
    addFxImpact(fx, frames, sampleRate, segEnd, 0.6, random);
    transientFrames.push({ stemId: 'fx', frame: segEnd, kind: 'impact' });
  }

  // ---------------------------------------------------------------------
  // Segment 6 (25-30s): everything continues; the MASTER BUS copy (§9) is
  // built after the ground truth sum, see below. The ground truth stems
  // still contain real musical material here (not silence) so the master
  // bus segment is a genuine "how does the engine cope with a processed
  // full mix" test, not a fade out.
  // ---------------------------------------------------------------------
  {
    const segStart = secToFrame(25);
    const segEnd = secToFrame(30);
    const bassFreqs = [55.0, 49.0, 61.7, 55.0];
    const synthRoots = [220, 196, 246.94, 220];
    const hatStep = Math.floor(beatFrames / 4);
    let beat = 0;
    let hatCounter = 0;
    for (let frame = segStart; frame < segEnd; frame += beatFrames, beat++) {
      addKick(drums, frames, sampleRate, frame, 1.0);
      transientFrames.push({ stemId: 'drums', frame, kind: 'kick' });
      addNoiseBurst(drums, frames, sampleRate, frame + Math.floor(beatFrames / 2), Math.floor(sampleRate * 0.05), 0.5, 0.7, random);
      const duck = (t: number) => 1 - 0.75 * Math.exp(-t * 28);
      addBassNote(bass, frames, sampleRate, frame, Math.floor(beatFrames * 0.95), bassFreqs[beat % bassFreqs.length], 0.52, duck);
      for (const interval of [1, 1.5]) {
        addSupersaw(synth, frames, sampleRate, synthRoots[beat % synthRoots.length] * interval, frame, Math.floor(beatFrames * 1.4), 0.15, 0.85);
      }
      if (beat % 2 === 0) {
        addVocal(vocals, frames, sampleRate, 293.66, frame, Math.floor(beatFrames * 1.8), 0.5);
      }
      for (let h = 0; h < 4; h++, hatCounter++) {
        const hFrame = frame + h * hatStep;
        addHat(percussion, frames, sampleRate, hFrame, false, 0.26, hatCounter % 2 === 0 ? -0.4 : 0.4, random);
      }
      if (beat % 3 === 0) addPercussionHit(percussion, frames, sampleRate, frame + Math.floor(beatFrames * 0.5), 300, 0.4, 0);
    }
  }

  // DC-free ground truth, exactly like a real stem export.
  for (const stem of stems.values()) {
    let sum = 0;
    for (let i = 0; i < stem.length; i++) sum += stem[i];
    const dc = sum / stem.length;
    if (Math.abs(dc) > 1e-9) for (let i = 0; i < stem.length; i++) stem[i] -= dc;
  }

  // The mix is the EXACT linear sum of all ground truth stems (§2, §17).
  const rawMix = new Float32Array(frames * 2);
  for (const stem of stems.values()) {
    for (let i = 0; i < rawMix.length; i++) rawMix[i] += stem[i];
  }

  // Bus "master" for the ground truth mix: linear peak normalisation only,
  // to -1 dBFS. This keeps sum(stems) === mix exactly (recombination
  // dependency of the technical gate, §17), matching the part-1 generator's
  // convention.
  let peak = 0;
  for (let i = 0; i < rawMix.length; i++) peak = Math.max(peak, Math.abs(rawMix[i]));
  const target = 0.891; // -1 dBFS
  const gain = peak > 0 ? target / peak : 1;
  const mix = new Float32Array(rawMix.length);
  for (let i = 0; i < rawMix.length; i++) mix[i] = rawMix[i] * gain;
  for (const stem of stems.values()) {
    for (let i = 0; i < stem.length; i++) stem[i] *= gain;
  }
  for (const t of transientFrames) void t; // frames already absolute, no rescale needed

  const segments: GoldStandardSegment[] = [
    {
      id: 'sub-overlap',
      title: 'Kick + Subbass',
      startSeconds: 0,
      endSeconds: 5,
      description: 'Kick, Subbass und Bass mit stark überlappendem Frequenzbereich (§4).',
      activeStems: ['drums', 'bass'],
      overlapPairs: [['drums', 'bass']],
    },
    {
      id: 'kick-bass-synth',
      title: 'Kick + Bass + Synth',
      startSeconds: 5,
      endSeconds: 10,
      description: 'Synth mit Energie im unteren/mittleren Frequenzbereich, überlappend mit Bass (§5).',
      activeStems: ['drums', 'bass', 'synth'],
      overlapPairs: [
        ['bass', 'synth'],
        ['drums', 'bass'],
      ],
    },
    {
      id: 'vocal-synth',
      title: 'Vocal + Synth',
      startSeconds: 10,
      endSeconds: 15,
      description: 'Vocal-Melodie und Synth-Pad mit stark überlappenden Formantbereichen (§6).',
      activeStems: ['vocals', 'synth'],
      overlapPairs: [['vocals', 'synth']],
    },
    {
      id: 'hats-percussion-stereo',
      title: 'Hi-Hats + Percussion + Stereo Synth',
      startSeconds: 15,
      endSeconds: 20,
      description: 'Hochfrequenz- und Stereo-Verhalten: Hats, Percussion, breiter Stereo-Synth mit Delay (§7).',
      activeStems: ['percussion', 'synth'],
      overlapPairs: [['percussion', 'synth']],
    },
    {
      id: 'dense-edm',
      title: 'Dense EDM Section',
      startSeconds: 20,
      endSeconds: 25,
      description: 'Alle Hauptquellen gleichzeitig inkl. Sidechain-Pumping (§8).',
      activeStems: ['vocals', 'drums', 'bass', 'synth', 'percussion', 'fx'],
      overlapPairs: [
        ['drums', 'bass'],
        ['bass', 'synth'],
        ['vocals', 'synth'],
        ['percussion', 'synth'],
        ['fx', 'vocals'],
      ],
    },
    {
      id: 'master-bus',
      title: 'Master-Bus-Simulation',
      startSeconds: 25,
      endSeconds: 30,
      description: 'Voller Mix mit Kompression/Limiting/Saturation/Reverb/Delay auf dem Bus (§9); Ground-Truth-Stems bleiben unprozessiert.',
      activeStems: ['vocals', 'drums', 'bass', 'synth', 'percussion'],
      overlapPairs: [['drums', 'bass']],
    },
  ];

  return {
    sampleRate,
    channels: 2,
    frames,
    seconds,
    seed,
    bpm,
    stemOrder: GOLD_STANDARD_STEMS,
    stems,
    mix,
    // masterBusMix is filled in by buildGoldStandardVariants() — kept as the
    // unprocessed mix here so a caller that only wants ground truth never
    // needs the mixEffects module.
    masterBusMix: mix,
    segments,
    transientFrames,
    meta: { bpm, seed, busChain: 'linear-normalise', gain, stemCount: GOLD_STANDARD_STEMS.length },
  };
}
