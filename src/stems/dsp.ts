/**
 * DSP – minimal, dependency free signal analysis helpers for the Stem
 * Isolation Gate (part 2).
 *
 * Everything here is analysis only (no audio decode/encode, that lives in
 * `wavIo.ts`). Kept deliberately small: a radix-2 FFT, a magnitude STFT, an
 * onset/transient detector and a normalised cross-correlation lag finder are
 * all the primitives the quality metrics need.
 */

/** In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` length must be a power of two. */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error(`FFT-Länge muss eine Zweierpotenz sein, ist ${n}`);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Periodic Hann window. */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

export interface StftOptions {
  frameSize: number;
  hopSize: number;
}

/** Magnitude spectrogram (frames x bins, bins = frameSize/2 + 1) of a mono signal. */
export function magnitudeSpectrogram(signal: Float32Array | Float64Array, options: StftOptions): Float64Array[] {
  const { frameSize, hopSize } = options;
  const fftSize = nextPow2(frameSize);
  const window = hannWindow(frameSize);
  const frames: Float64Array[] = [];
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const bins = fftSize / 2 + 1;

  for (let start = 0; start + frameSize <= signal.length; start += hopSize) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < frameSize; i++) re[i] = signal[start + i] * window[i];
    fftInPlace(re, im);
    const mag = new Float64Array(bins);
    for (let b = 0; b < bins; b++) mag[b] = Math.hypot(re[b], im[b]);
    frames.push(mag);
  }
  return frames;
}

/**
 * Log-spectral distance between two signals (mean over frames of the RMS of
 * the per-bin dB difference). A small value means the spectral envelopes
 * match; a large value flags timbral/frequency errors a pure SDR number can
 * hide.
 */
export function logSpectralDistanceDb(
  reference: Float32Array | Float64Array,
  estimate: Float32Array | Float64Array,
  options: StftOptions = { frameSize: 1024, hopSize: 2048 }
): number {
  const refFrames = magnitudeSpectrogram(reference, options);
  const estFrames = magnitudeSpectrogram(estimate, options);
  const frames = Math.min(refFrames.length, estFrames.length);
  if (frames === 0) return 0;
  const eps = 1e-9;
  let total = 0;
  for (let f = 0; f < frames; f++) {
    const a = refFrames[f];
    const b = estFrames[f];
    let sumSq = 0;
    const bins = Math.min(a.length, b.length);
    for (let k = 0; k < bins; k++) {
      const da = 20 * Math.log10(a[k] + eps);
      const db = 20 * Math.log10(b[k] + eps);
      sumSq += (da - db) ** 2;
    }
    total += Math.sqrt(sumSq / bins);
  }
  return total / frames;
}

/** Downmix interleaved stereo (or n-channel) to mono by averaging channels. */
export function downmixMono(data: Float32Array, channels: number, frames: number): Float64Array {
  const out = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data[f * channels + c] || 0;
    out[f] = sum / channels;
  }
  return out;
}

export interface Onset {
  frame: number;
  strength: number;
}

/**
 * Simple broadband envelope onset detector (energy derivative with a
 * refractory guard). Not a spectral-flux onset detector – good enough to
 * locate percussive attacks (kick, clap, hat, pluck) in synthetic test
 * material where the ground truth transient time is already known and only
 * needs to be *matched*, not blindly discovered.
 */
export function detectOnsets(mono: Float64Array, sampleRate: number, thresholdRatio = 0.12, guardMs = 30): Onset[] {
  let peak = 0;
  for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  if (peak < 1e-9) return [];
  const threshold = peak * thresholdRatio;
  const guard = Math.max(1, Math.floor((guardMs / 1000) * sampleRate));
  const onsets: Onset[] = [];
  let previousEnv = 0;
  let lastOnset = -guard;
  const smoothing = Math.max(1, Math.floor(sampleRate * 0.001));
  for (let f = 0; f < mono.length; f += smoothing) {
    let env = 0;
    for (let i = f; i < Math.min(mono.length, f + smoothing); i++) env += Math.abs(mono[i]);
    env /= smoothing;
    const rise = env - previousEnv;
    if (rise > threshold && f - lastOnset >= guard) {
      onsets.push({ frame: f, strength: rise });
      lastOnset = f;
    }
    previousEnv = env;
  }
  return onsets;
}

/**
 * Finds the sample lag (within +/- maxLag) that maximises the normalised
 * cross-correlation between `reference` and `signal`. Used to detect a time
 * shift a chunked/overlap-add reconstruction must never introduce (§17).
 */
export function findBestLag(
  reference: Float64Array,
  signal: Float64Array,
  maxLag: number
): { lag: number; correlation: number } {
  let bestLag = 0;
  let bestScore = -Infinity;
  const totalN = Math.min(reference.length, signal.length);
  // Using a representative segment of up to 65536 samples avoids O(N*L) explosion on long files
  const n = Math.min(totalN, 65536);
  let refEnergy = 0;
  for (let i = 0; i < n; i++) refEnergy += reference[i] * reference[i];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0;
    let sigEnergy = 0;
    let count = 0;
    const start = Math.max(0, -lag);
    const end = Math.min(n, n - lag);
    for (let i = start; i < end; i++) {
      const r = reference[i];
      const s = signal[i + lag];
      dot += r * s;
      sigEnergy += s * s;
      count++;
    }
    if (count < n * 0.5) continue;
    const denom = Math.sqrt(refEnergy * sigEnergy);
    const score = denom > 1e-12 ? dot / denom : 0;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return { lag: bestLag, correlation: bestScore === -Infinity ? 0 : bestScore };
}

export function rms(data: Float32Array | Float64Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, data.length));
}

export function peakAbs(data: Float32Array | Float64Array): number {
  let p = 0;
  for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
  return p;
}

export function toDb(value: number, reference = 1): number {
  return 20 * Math.log10(Math.max(Math.abs(value), 1e-12) / Math.max(Math.abs(reference), 1e-12));
}
