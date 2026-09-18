/**
 * Heuristic, dependency-free stem separator.
 *
 * This module runs everywhere (browser + Node) and needs neither Python nor a
 * trained checkpoint. It separates a mix into `vocals / drums / bass / other`
 * with classic signal-processing tricks:
 *
 *  - vocals: centre-channel extraction (mid/side dominance) limited to the
 *    vocal band, with centre transients suppressed,
 *  - drums:  transient (fast-vs-slow envelope) gate on the residual,
 *  - bass:   4th-order Butterworth low shelf on the residual,
 *  - other:  the exact residual of the three stems above.
 *
 * Because `other` is computed as `mix - vocals - drums - bass`, the four stems
 * always sum back to the original mix sample-for-sample (non-destructive).
 *
 * HONESTY: this is a heuristic, not a trained model. It can never claim
 * `trainedModel: true` and it will never pass the Stem Isolation Gate quality
 * stage on its own – it only guarantees a technically clean pipeline.
 */
import type { StemId } from './types';

export const DSP_SEPARATOR_ENGINE = 'dsp-heuristic-v1';
export const DSP_STEM_ORDER: readonly StemId[] = ['vocals', 'drums', 'bass', 'other'];
export const DSP_STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Inst',
};

export interface DspAudio {
  /** Interleaved samples. */
  data: Float32Array;
  sampleRate: number;
  channels: number;
  frames: number;
}

export interface DspStem {
  id: StemId;
  label: string;
  /** Interleaved samples, same layout as the input. */
  data: Float32Array;
  sampleRate: number;
  channels: number;
  frames: number;
}

export interface DspSeparatorOptions {
  /** Which stems to produce, in order. `other` is always the residual. */
  stemOrder?: readonly StemId[];
  /** Lower edge of the vocal band in Hz. */
  vocalLowHz?: number;
  /** Upper edge of the vocal band in Hz. */
  vocalHighHz?: number;
  /** Bass/drums crossover in Hz. */
  bassCrossoverHz?: number;
  /** How much side energy suppresses the centre estimate (>1 = strict). */
  centerDominance?: number;
  /** How much of a centre transient is kept out of the vocal stem (0..1). */
  transientVocalDuck?: number;
  /** Fast-vs-slow envelope ratio that counts as a drum hit (>1 = strict). */
  transientSensitivity?: number;
  /** Attack of the drum gate in ms (how fast a hit opens the gate). */
  drumGateAttackMs?: number;
  /** Release of the drum gate in ms (how long a hit body is kept). */
  drumGateReleaseMs?: number;
  /** Release of the fast/slow envelope pair that detects transients, in ms. */
  transientFastReleaseMs?: number;
  transientSlowAttackMs?: number;
  transientSlowReleaseMs?: number;
  /** Called after every processed block (chunked mode). */
  onProgress?: (progress: { phase: string; processedFrames: number; totalFrames: number; ratio: number }) => void;
}

export interface DspSeparationReport {
  engine: typeof DSP_SEPARATOR_ENGINE;
  trainedModel: false;
  qualityTier: 'HEURISTIC';
  stemOrder: StemId[];
  stems: DspStem[];
  sampleRate: number;
  channels: number;
  frames: number;
  /** Largest |mix - Σstems| deviation over the whole track. */
  recombinationMaxError: number;
  durationMs: number;
  notes: string[];
}

const EPSILON = 1e-9;
/** Below this envelope level a gain stage stays closed (silence is silence). */
const NOISE_FLOOR = 1e-5;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/** Smooth hermite ramp – avoids zipper noise on gain changes. */
function smoothstep(value: number): number {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
}

function coefficient(timeMs: number, sampleRate: number): number {
  const timeSeconds = Math.max(1e-4, timeMs / 1000);
  return Math.exp(-1 / Math.max(1e-6, timeSeconds * sampleRate));
}

/** RBJ biquad – the only filter primitive used here. */
class Biquad {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(type: 'lowpass' | 'highpass', frequency: number, sampleRate: number, q: number) {
    const nyquist = sampleRate / 2;
    const f = Math.min(nyquist * 0.495, Math.max(8, frequency));
    const w0 = (2 * Math.PI * f) / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * Math.max(0.05, q));
    const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos);
    const b0 = b1 / (type === 'lowpass' ? 2 : -2);
    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b0 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(input: number): number {
    const output = this.b0 * input + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = output;
    return output;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/** Cascaded biquads; `order: 4` builds a Butterworth response. */
class FilterCascade {
  private readonly stages: Biquad[];

  constructor(type: 'lowpass' | 'highpass', frequency: number, sampleRate: number, order: 2 | 4 = 4) {
    const qValues = order === 4 ? [0.5411961, 1.306563] : [0.7071068];
    this.stages = qValues.map((q) => new Biquad(type, frequency, sampleRate, q));
  }

  process(input: number): number {
    let value = input;
    for (const stage of this.stages) value = stage.process(value);
    return value;
  }

  reset(): void {
    for (const stage of this.stages) stage.reset();
  }
}

/** Peak envelope follower with separate attack/release behaviour. */
class EnvelopeFollower {
  private readonly attack: number;
  private readonly release: number;
  value = 0;

  constructor(sampleRate: number, attackMs: number, releaseMs: number) {
    this.attack = coefficient(attackMs, sampleRate);
    this.release = coefficient(releaseMs, sampleRate);
  }

  follow(input: number): number {
    const level = Math.abs(input);
    const factor = level > this.value ? this.attack : this.release;
    this.value = factor * this.value + (1 - factor) * level;
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

/** One-pole smoother with asymmetric attack/release (gain stage anti-zipper). */
class AsymmetricSmoother {
  private readonly attack: number;
  private readonly release: number;
  private value = 0;

  constructor(sampleRate: number, attackMs: number, releaseMs: number) {
    this.attack = coefficient(attackMs, sampleRate);
    this.release = coefficient(releaseMs, sampleRate);
  }

  apply(target: number): number {
    const factor = target > this.value ? this.attack : this.release;
    this.value = factor * this.value + (1 - factor) * target;
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

export interface DspStemBlock {
  vocals: Float32Array;
  drums: Float32Array;
  bass: Float32Array;
  other: Float32Array;
}

/**
 * Streaming separator: feed it consecutive interleaved blocks and it returns
 * the stem blocks. Filter/envelope state is carried across blocks, so chunked
 * processing is bit-identical to processing the whole track at once.
 */
export class DspStemSeparatorStream {
  readonly sampleRate: number;
  readonly channels: number;
  readonly mono: boolean;

  private readonly options: Required<Pick<DspSeparatorOptions, 'centerDominance' | 'transientVocalDuck' | 'transientSensitivity'>>;
  private readonly vocalHigh: FilterCascade;
  private readonly vocalLow: FilterCascade;
  private readonly bassFilters: FilterCascade[];
  private readonly envMid: EnvelopeFollower;
  private readonly envSide: EnvelopeFollower;
  private readonly envMidFast: EnvelopeFollower;
  private readonly envMidSlow: EnvelopeFollower;
  private readonly envResFast: EnvelopeFollower;
  private readonly envResSlow: EnvelopeFollower;

  private readonly centerSmoother: AsymmetricSmoother;
  private readonly midGateSmoother: AsymmetricSmoother;
  private readonly resGateSmoother: AsymmetricSmoother;

  private maxRecombinationError = 0;

  constructor(sampleRate: number, channels: number, options: DspSeparatorOptions = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate < 3000) throw new Error(`Ungültige Sample-Rate für Stem-Separation: ${sampleRate}`);
    if (channels !== 1 && channels !== 2) throw new Error(`Stem-Separation unterstützt Mono oder Stereo, nicht ${channels} Kanäle`);
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.mono = channels === 1;
    this.options = {
      centerDominance: options.centerDominance ?? 1.4,
      transientVocalDuck: Math.min(1, Math.max(0, options.transientVocalDuck ?? 0.85)),
      transientSensitivity: options.transientSensitivity ?? 1.05,
    };
    const vocalLowHz = options.vocalLowHz ?? 170;
    const vocalHighHz = Math.max(vocalLowHz * 2, options.vocalHighHz ?? 9000);
    const bassCrossoverHz = options.bassCrossoverHz ?? 170;
    this.vocalHigh = new FilterCascade('highpass', vocalLowHz, sampleRate, 4);
    this.vocalLow = new FilterCascade('lowpass', vocalHighHz, sampleRate, 4);
    this.bassFilters = [0, 1].map(() => new FilterCascade('lowpass', bassCrossoverHz, sampleRate, 4));
    this.envMid = new EnvelopeFollower(sampleRate, 4, 70);
    this.envSide = new EnvelopeFollower(sampleRate, 4, 70);
    this.envMidFast = new EnvelopeFollower(sampleRate, 0.5, 45);
    this.envMidSlow = new EnvelopeFollower(sampleRate, 40, 350);
    this.envResFast = new EnvelopeFollower(sampleRate, 0.5, options.transientFastReleaseMs ?? 45);
    this.envResSlow = new EnvelopeFollower(sampleRate, options.transientSlowAttackMs ?? 60, options.transientSlowReleaseMs ?? 220);

    this.centerSmoother = new AsymmetricSmoother(sampleRate, 8, 60);
    this.midGateSmoother = new AsymmetricSmoother(sampleRate, 0.6, 90);
    this.resGateSmoother = new AsymmetricSmoother(sampleRate, options.drumGateAttackMs ?? 1.2, options.drumGateReleaseMs ?? 110);
  }

  get recombinationMaxError(): number {
    return this.maxRecombinationError;
  }

  reset(): void {
    this.vocalHigh.reset();
    this.vocalLow.reset();
    for (const filter of this.bassFilters) filter.reset();
    for (const env of [this.envMid, this.envSide, this.envMidFast, this.envMidSlow, this.envResFast, this.envResSlow]) env.reset();
    for (const smoother of [this.centerSmoother, this.midGateSmoother, this.resGateSmoother]) smoother.reset();
    this.maxRecombinationError = 0;
  }

  /** Process one interleaved block; returns one interleaved block per stem. */
  push(block: Float32Array): DspStemBlock {
    const channels = this.channels;
    const frames = Math.floor(block.length / channels);
    const vocals = new Float32Array(frames * channels);
    const drums = new Float32Array(frames * channels);
    const bass = new Float32Array(frames * channels);
    const other = new Float32Array(frames * channels);
    const duck = this.options.transientVocalDuck;

    for (let f = 0; f < frames; f++) {
      const offset = f * channels;
      const left = block[offset] || 0;
      const right = channels === 2 ? block[offset + 1] || 0 : left;
      const mid = (left + right) * 0.5;
      const side = channels === 2 ? (left - right) * 0.5 : 0;

      // --- 1. centre dominance (mid/side) -------------------------------
      const envMid = this.envMid.follow(mid);
      const envSide = this.envSide.follow(side);
      const dominance = envMid > NOISE_FLOOR ? (envMid - this.options.centerDominance * envSide) / (envMid + EPSILON) : 0;

      // --- 2. centre transients belong to the drums, not the vocals ------
      const midFast = this.envMidFast.follow(mid);
      const midSlow = this.envMidSlow.follow(mid);
      const midTransient = midFast > NOISE_FLOOR ? (midFast - this.options.transientSensitivity * midSlow) / (midFast + EPSILON) : 0;
      const midGate = this.midGateSmoother.apply(smoothstep(midTransient));

      const centerGain = this.centerSmoother.apply(smoothstep(dominance));
      const vocalGain = centerGain * (1 - duck * midGate);
      const vocalMid = this.vocalLow.process(this.vocalHigh.process(mid)) * vocalGain;

      // --- 3. residual after the vocal stem ------------------------------
      const residualLeft = left - vocalMid;
      const residualRight = right - vocalMid;
      // Rectified sum (not the mono downmix) so out-of-phase, hard-panned
      // percussion still triggers the gate instead of cancelling itself out.
      const residualLevel = (Math.abs(residualLeft) + Math.abs(residualRight)) * 0.5;

      // --- 4. transient gate = drums/percussion --------------------------
      const resFast = this.envResFast.follow(residualLevel);
      const resSlow = this.envResSlow.follow(residualLevel);
      const resTransient = resFast > NOISE_FLOOR ? (resFast - this.options.transientSensitivity * resSlow) / (resFast + EPSILON) : 0;
      const drumGate = this.resGateSmoother.apply(smoothstep(resTransient));

      const drumLeft = residualLeft * drumGate;
      const drumRight = residualRight * drumGate;
      const afterDrumsLeft = residualLeft - drumLeft;
      const afterDrumsRight = residualRight - drumRight;

      // --- 5. bass = sustained low end of the remaining signal -----------
      const bassLeft = this.bassFilters[0].process(afterDrumsLeft);
      const bassRight = this.bassFilters[1].process(afterDrumsRight);

      // --- 6. other = exact residual (guarantees lossless recombination) --
      const otherLeft = afterDrumsLeft - bassLeft;
      const otherRight = afterDrumsRight - bassRight;

      if (channels === 2) {
        vocals[offset] = vocalMid;
        vocals[offset + 1] = vocalMid;
        drums[offset] = drumLeft;
        drums[offset + 1] = drumRight;
        bass[offset] = bassLeft;
        bass[offset + 1] = bassRight;
        other[offset] = otherLeft;
        other[offset + 1] = otherRight;
        this.trackError(left, vocalMid + drumLeft + bassLeft + otherLeft);
        this.trackError(right, vocalMid + drumRight + bassRight + otherRight);
      } else {
        vocals[offset] = vocalMid;
        drums[offset] = drumLeft;
        bass[offset] = bassLeft;
        other[offset] = otherLeft;
        this.trackError(left, vocalMid + drumLeft + bassLeft + otherLeft);
      }
    }

    return { vocals, drums, bass, other };
  }

  private trackError(original: number, recombined: number): void {
    const error = Math.abs(original - recombined);
    if (error > this.maxRecombinationError) this.maxRecombinationError = error;
  }
}

function normalizeOptions(input: DspAudio, options: DspSeparatorOptions = {}): { stemOrder: StemId[]; notes: string[] } {
  const stemOrder = (options.stemOrder?.length ? options.stemOrder : DSP_STEM_ORDER).map((id) => id as StemId);
  const notes: string[] = [
    'Interne Heuristik-Separation (Mid/Side + Transienten-Gate + Frequenzweiche) – kein trainiertes KI-Modell.',
  ];
  if (input.channels === 1) notes.push('Mono-Material: Vocals/Inst-Trennung ist ohne Stereo-Bild nur eingeschränkt möglich.');
  if (!stemOrder.includes('other')) notes.push('Ohne "other"-Stem ist die Summe der Stems kleiner als der Originalmix.');
  return { stemOrder: [...stemOrder], notes };
}

/** Synchronous one-shot separation (used by Node tests and short previews). */
export function separateStemsDsp(input: DspAudio, options: DspSeparatorOptions = {}): DspSeparationReport {
  const started = Date.now();
  const { stemOrder, notes } = normalizeOptions(input, options);
  const stream = new DspStemSeparatorStream(input.sampleRate, input.channels, options);
  const blocks = stream.push(input.data);
  const stems = buildStems(input, stemOrder, blocks);
  return {
    engine: DSP_SEPARATOR_ENGINE,
    trainedModel: false,
    qualityTier: 'HEURISTIC',
    stemOrder: [...stemOrder],
    stems,
    sampleRate: input.sampleRate,
    channels: input.channels,
    frames: input.frames,
    recombinationMaxError: stream.recombinationMaxError,
    durationMs: Date.now() - started,
    notes,
  };
}

export interface ChunkedDspOptions extends DspSeparatorOptions {
  /** Block size in frames; smaller blocks keep the UI responsive. */
  blockFrames?: number;
  /** Awaited between blocks so the event loop can paint progress. */
  yieldBetweenBlocks?: () => Promise<void>;
  /** Optional cooperative cancellation. */
  isCancelled?: () => boolean;
}

/**
 * Chunked separation that keeps a browser UI responsive: every block is
 * processed, reported and then handed back to the event loop.
 */
export async function separateStemsDspChunked(input: DspAudio, options: ChunkedDspOptions = {}): Promise<DspSeparationReport> {
  const started = Date.now();
  const { stemOrder, notes } = normalizeOptions(input, options);
  const stream = new DspStemSeparatorStream(input.sampleRate, input.channels, options);
  const channels = input.channels;
  const totalFrames = Math.max(0, input.frames);
  const blockFrames = Math.max(1024, Math.min(totalFrames || 1024, options.blockFrames ?? Math.floor(input.sampleRate * 0.5)));
  const accumulator = new Map<StemId, Float32Array>(stemOrder.map((id) => [id, new Float32Array(totalFrames * channels)]));
  const yieldControl = options.yieldBetweenBlocks ?? (async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  for (let start = 0; start < totalFrames; start += blockFrames) {
    if (options.isCancelled?.()) throw new Error('Stem-Separation abgebrochen');
    const end = Math.min(totalFrames, start + blockFrames);
    const block = input.data.subarray(start * channels, end * channels);
    const result = stream.push(block);
    for (const id of stemOrder) {
      const target = accumulator.get(id);
      if (!target) continue;
      target.set((result as unknown as Record<string, Float32Array>)[id].subarray(0, (end - start) * channels), start * channels);
    }
    options.onProgress?.({ phase: 'separating', processedFrames: end, totalFrames, ratio: totalFrames ? end / totalFrames : 1 });
    if (end < totalFrames) await yieldControl();
  }

  const stems: DspStem[] = stemOrder.map((id) => ({
    id,
    label: DSP_STEM_LABELS[id] ?? id,
    data: accumulator.get(id) ?? new Float32Array(totalFrames * channels),
    sampleRate: input.sampleRate,
    channels,
    frames: totalFrames,
  }));

  return {
    engine: DSP_SEPARATOR_ENGINE,
    trainedModel: false,
    qualityTier: 'HEURISTIC',
    stemOrder: [...stemOrder],
    stems,
    sampleRate: input.sampleRate,
    channels,
    frames: totalFrames,
    recombinationMaxError: stream.recombinationMaxError,
    durationMs: Date.now() - started,
    notes,
  };
}

function buildStems(input: DspAudio, stemOrder: StemId[], blocks: DspStemBlock): DspStem[] {
  return stemOrder.map((id) => ({
    id,
    label: DSP_STEM_LABELS[id] ?? id,
    data: (blocks as unknown as Record<string, Float32Array>)[id] ?? new Float32Array(input.frames * input.channels),
    sampleRate: input.sampleRate,
    channels: input.channels,
    frames: input.frames,
  }));
}

/** Sum of all stems – used by tests and the recombination gate. */
export function sumDspStems(stems: DspStem[]): Float32Array {
  const length = stems.reduce((max, stem) => Math.max(max, stem.data.length), 0);
  const out = new Float32Array(length);
  for (const stem of stems) for (let i = 0; i < stem.data.length; i++) out[i] += stem.data[i];
  return out;
}
