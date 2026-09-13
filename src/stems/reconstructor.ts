/**
 * Reconstructor – overlap-add / crossfade reconstruction (§13, §14).
 *
 * Each chunk is faded in/out with a raised cosine over its overlap region and
 * accumulated. The accumulated signal is divided by the accumulated window, so
 * the reconstruction is *exact* for identical chunk content (identity input in,
 * identity output out) and free of level jumps for real model output.
 *
 * This is the outer reconstruction of the engine. It runs in addition to the
 * model's own overlap-add – a chunk border is therefore never a hard cut.
 */
import type { ChunkPlan } from './chunkProcessor';

export interface ReconstructorOptions {
  totalFrames: number;
  channels: number;
  plans: ChunkPlan[];
}

/** Raised cosine (Hann) crossfade window for one chunk. */
export function chunkWindow(plan: ChunkPlan): Float32Array {
  const length = plan.endSample - plan.startSample;
  const window = new Float32Array(length);
  const fadeIn = plan.isFirst ? 0 : Math.max(0, plan.overlapIn);
  const fadeOut = plan.isLast ? 0 : Math.max(0, plan.overlapOut);
  for (let i = 0; i < length; i++) {
    let weight = 1;
    if (fadeIn > 0 && i < fadeIn) {
      const x = i / fadeIn;
      weight = Math.min(weight, 0.5 - 0.5 * Math.cos(Math.PI * x));
    }
    if (fadeOut > 0 && i >= length - fadeOut) {
      const x = (length - 1 - i) / fadeOut;
      weight = Math.min(weight, 0.5 - 0.5 * Math.cos(Math.PI * x));
    }
    window[i] = weight;
  }
  return window;
}

/**
 * Accumulates interleaved chunk outputs into a full length buffer.
 * `write` is called per chunk with the chunk's interleaved samples.
 */
export class OverlapAddReconstructor {
  private readonly accumulator: Float32Array;
  private readonly windowSum: Float32Array;
  private readonly channels: number;
  private readonly totalFrames: number;
  private chunksAdded = 0;
  private readonly boundaries: number[] = [];

  constructor(options: ReconstructorOptions) {
    this.totalFrames = options.totalFrames;
    this.channels = options.channels;
    this.accumulator = new Float32Array(options.totalFrames * options.channels);
    this.windowSum = new Float32Array(options.totalFrames);
    for (const plan of options.plans) {
      if (plan.index > 0) this.boundaries.push(plan.startSample);
    }
  }

  get boundarySampleOffsets(): number[] {
    return [...this.boundaries];
  }

  /** Adds one chunk (interleaved, `plan.endSample - plan.startSample` frames). */
  add(plan: ChunkPlan, interleaved: Float32Array): void {
    const window = chunkWindow(plan);
    const length = plan.endSample - plan.startSample;
    if (interleaved.length < length * this.channels) {
      throw new Error(
        `Chunk ${plan.index} lieferte ${interleaved.length} Samples, erwartet ${length * this.channels}`
      );
    }
    for (let i = 0; i < length; i++) {
      const w = window[i];
      if (w === 0) continue;
      const target = plan.startSample + i;
      this.windowSum[target] += w;
      const base = target * this.channels;
      for (let c = 0; c < this.channels; c++) {
        this.accumulator[base + c] += interleaved[i * this.channels + c] * w;
      }
    }
    this.chunksAdded++;
  }

  get addedChunks(): number {
    return this.chunksAdded;
  }

  /** Normalises the accumulated signal and returns interleaved float32. */
  finalize(): Float32Array {
    const out = new Float32Array(this.totalFrames * this.channels);
    for (let f = 0; f < this.totalFrames; f++) {
      const w = this.windowSum[f];
      const scale = w > 1e-9 ? 1 / w : 0;
      for (let c = 0; c < this.channels; c++) {
        out[f * this.channels + c] = this.accumulator[f * this.channels + c] * scale;
      }
    }
    return out;
  }
}

/**
 * Convenience helper: reconstructs several stems at once from per-chunk maps.
 * `chunks[i]` maps stem id -> interleaved chunk samples.
 */
export function reconstructStems(
  stemIds: string[],
  plans: ChunkPlan[],
  chunks: Map<string, Float32Array>[],
  totalFrames: number,
  channels: number
): Map<string, Float32Array> {
  const reconstructors = new Map<string, OverlapAddReconstructor>();
  for (const stem of stemIds) {
    reconstructors.set(stem, new OverlapAddReconstructor({ totalFrames, channels, plans }));
  }
  chunks.forEach((chunkMap, index) => {
    const plan = plans[index];
    for (const stem of stemIds) {
      const data = chunkMap.get(stem);
      if (!data) throw new Error(`Chunk ${index} enthält keinen Stem "${stem}"`);
      reconstructors.get(stem)!.add(plan, data);
    }
  });
  const result = new Map<string, Float32Array>();
  for (const stem of stemIds) result.set(stem, reconstructors.get(stem)!.finalize());
  return result;
}

/**
 * Measures the artefacts §14 asks about: clicks, level jumps, phase/stereo
 * jumps and duplicated or lost transients around chunk borders.
 */
export interface ContinuityMeasurement {
  boundaryDeltaDb: number;
  interiorDeltaDb: number;
  excessDb: number;
  rmsJumpDb: number;
  stereoJump: number;
  duplicateTransients: number;
  missingTransients: number;
}

export function measureContinuity(
  data: Float32Array,
  channels: number,
  totalFrames: number,
  boundaries: number[],
  reference?: Float32Array
): ContinuityMeasurement {
  const peak = (() => {
    let p = 0;
    for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
    return p || 1e-9;
  })();


  const windowWidth = Math.max(64, Math.floor(totalFrames / 2000));
  // Click detection via the discrete second difference: a step discontinuity of
  // size D produces |x[n] - (x[n-1] + x[n+1]) / 2| ~ D/2 while smooth audio
  // stays at the level of its local curvature. The reference is the 99.9th
  // percentile away from the borders, so sparse transients of the music do not
  // hide an artefact.
  const secondDifference = (signal: Float32Array, frame: number, channel: number) => {
    const previous = signal[(frame - 1) * channels + channel] || 0;
    const current = signal[frame * channels + channel] || 0;
    const next = signal[(frame + 1) * channels + channel] || 0;
    return Math.abs(current - (previous + next) * 0.5);
  };
  const interiorSamples: number[] = [];
  for (let f = 1; f < totalFrames - 1; f++) {
    if (boundaries.some((b) => Math.abs(f - b) <= 2)) continue;
    for (let c = 0; c < channels; c++) interiorSamples.push(secondDifference(data, f, c));
  }
  interiorSamples.sort((a, b) => a - b);
  const interiorReference = interiorSamples.length > 0
    ? interiorSamples[Math.min(interiorSamples.length - 1, Math.floor(interiorSamples.length * 0.999))]
    : 0;
  let boundaryMax = 0;
  let rmsJump = 0;
  let stereoJump = 0;
  for (const b of boundaries) {
    for (let c = 0; c < channels; c++) {
      for (const frame of [b - 1, b, b + 1]) {
        if (frame < 1 || frame >= totalFrames - 1) continue;
        const value = secondDifference(data, frame, c);
        if (value > boundaryMax) boundaryMax = value;
      }
    }
    // A level jump is an artefact only when the reconstruction swings more than
    // the reference does at the same border.
    const ratio = (signal: Float32Array, border: number) => {
      let beforeSq = 0;
      let afterSq = 0;
      let count = 0;
      for (let f = Math.max(0, border - windowWidth); f < Math.min(totalFrames, border + windowWidth); f++) {
        const target = f < border ? (a: number) => (beforeSq += a * a) : (a: number) => (afterSq += a * a);
        for (let c = 0; c < channels; c++) target(signal[f * channels + c] || 0);
        count++;
      }
      const beforeRms = Math.sqrt(beforeSq / Math.max(1, count * channels));
      const afterRms = Math.sqrt(afterSq / Math.max(1, count * channels));
      return 20 * Math.log10((afterRms + 1e-9) / (beforeRms + 1e-9));
    };
    const referenceRatio = reference ? ratio(reference, b) : 0;
    const jumpDb = Math.abs(ratio(data, b) - referenceRatio);
    if (jumpDb > rmsJump) rmsJump = jumpDb;
    if (channels === 2 && reference) {
      // A stereo jump is only an artefact when the *change* of the mid/side
      // correlation across the border differs from the change the reference
      // (the working copy) shows at the same place. Natural stereo movement of
      // the music must not be reported as a chunk artefact.
      const corrDelta = (signal: Float32Array, border: number) => {
        const corr = (from: number) => {
          let mid = 0;
          let side = 0;
          let ms = 0;
          for (let f = Math.max(0, from); f < Math.min(totalFrames, from + windowWidth * 2); f++) {
            const l = signal[f * channels] || 0;
            const r = signal[f * channels + 1] || 0;
            mid += ((l + r) * 0.5) ** 2;
            side += ((l - r) * 0.5) ** 2;
            ms += ((l + r) * 0.5) * ((l - r) * 0.5);
          }
          const denom = Math.sqrt(mid * side);
          return denom > 1e-12 ? ms / denom : 0;
        };
        return corr(border) - corr(border - windowWidth * 2);
      };
      const jump = Math.abs(corrDelta(data, b) - corrDelta(reference!, b));
      if (jump > stereoJump) stereoJump = jump;
    }
  }

  // Transient detection on the envelope slope, compared against the reference
  // (the working copy) to find doubled or vanished transients near borders.
  const transientThreshold = peak * 0.18;
  const transientGuard = Math.max(128, Math.floor(totalFrames / 400));
  const findTransients = (signal: Float32Array) => {
    const found: number[] = [];
    let previous = 0;
    for (let f = 1; f < totalFrames; f++) {
      let env = 0;
      for (let c = 0; c < channels; c++) env += Math.abs(signal[f * channels + c] || 0);
      env /= channels;
      if (env - previous > transientThreshold) {
        if (found.length === 0 || f - found[found.length - 1] > transientGuard) found.push(f);
      }
      previous = env;
    }
    return found;
  };

  let duplicateTransients = 0;
  let missingTransients = 0;
  if (reference) {
    // One-to-one matching of transient positions between the reconstruction and
    // the reference. An output transient without a partner is a doubled/new
    // transient; a reference transient without a partner is a lost one. Only
    // events close to a chunk border are counted as boundary artefacts – the
    // model itself may legitimately reshape transients elsewhere (part 2).
    const referenceTransients = findTransients(reference);
    const outputTransients = findTransients(data);
    const tolerance = Math.max(64, Math.floor(0.04 * 44100)); // +/- 40 ms
    const referenceUsed = new Array<boolean>(referenceTransients.length).fill(false);
    const atBoundary = (frame: number) => boundaries.some((border) => Math.abs(frame - border) <= tolerance);
    for (const frame of outputTransients) {
      let bestIndex = -1;
      let bestDistance = tolerance + 1;
      for (let i = 0; i < referenceTransients.length; i++) {
        if (referenceUsed[i]) continue;
        const distance = Math.abs(referenceTransients[i] - frame);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }
      if (bestIndex >= 0) referenceUsed[bestIndex] = true;
      else if (atBoundary(frame)) duplicateTransients++;
    }
    for (let i = 0; i < referenceTransients.length; i++) {
      if (!referenceUsed[i] && atBoundary(referenceTransients[i])) missingTransients++;
    }
  }

  const toDb = (value: number) => 20 * Math.log10(Math.max(value, 1e-12) / peak);
  return {
    boundaryDeltaDb: toDb(boundaryMax),
    interiorDeltaDb: toDb(interiorReference || 1e-12),
    excessDb: toDb(boundaryMax) - toDb(interiorReference || 1e-12),
    rmsJumpDb: rmsJump,
    stereoJump,
    duplicateTransients,
    missingTransients,
  };
}


/**
 * Localisation of the reconstruction error around chunk borders (§14).
 *
 * Returns the worst error at a border and the 99.9th percentile of the error
 * elsewhere, both relative to the reference peak. A border specific problem
 * shows up as a positive excess even when the overall error is dominated by the
 * model itself.
 */
export function measureBoundaryError(
  output: Float32Array,
  reference: Float32Array,
  channels: number,
  totalFrames: number,
  boundaries: number[],
  tolerance = 1764
): { boundaryErrorDb: number; interiorErrorDb: number; boundaryErrorExcessDb: number } {
  const length = Math.min(output.length, reference.length);
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(reference[i]));
  peak = peak || 1e-12;

  const interior: number[] = [];
  let boundaryMax = 0;
  const nearBoundary = (frame: number) => boundaries.some((border) => Math.abs(frame - border) <= tolerance);
  for (let f = 0; f < totalFrames; f++) {
    let error = 0;
    for (let c = 0; c < channels; c++) {
      error = Math.max(error, Math.abs((output[f * channels + c] || 0) - (reference[f * channels + c] || 0)));
    }
    if (nearBoundary(f)) {
      if (error > boundaryMax) boundaryMax = error;
    } else {
      interior.push(error);
    }
  }
  interior.sort((a, b) => a - b);
  const interiorReference = interior.length > 0
    ? interior[Math.min(interior.length - 1, Math.floor(interior.length * 0.999))]
    : 0;
  const toDb = (value: number) => 20 * Math.log10(Math.max(value, 1e-12) / peak);
  return {
    boundaryErrorDb: toDb(boundaryMax),
    interiorErrorDb: toDb(interiorReference || 1e-12),
    boundaryErrorExcessDb: toDb(boundaryMax) - toDb(interiorReference || 1e-12),
  };
}
