/**
 * @license
 * FFT (radix 2) für den Phasenvocoder – reines TypeScript, keine Abhängigkeiten.
 *
 * Der Vocoder braucht Hin- und Rücktransformation großer Rahmen; ein
 *stellfreier, iterativer Algorithmus ist hier schnell genug (44 kHz, 2048
 * Samples pro Rahmen ≈ 0,2 ms) und in den Tests direkt über die Spektralordnung
 * prüfbar (Parseval, Hin- und Rückweg, Sinuston in der richtigen Tonne).
 */

/** Nächste Zweierpotenz ≥ n. */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** true, wenn n eine Zweierpotenz ≥ 2 ist. */
export function isPow2(n: number): boolean {
  return Number.isFinite(n) && n >= 2 && (n & (n - 1)) === 0;
}

const TWIDDLES = new Map<string, { cos: Float64Array; sin: Float64Array }>();

/** Vorrechnete Drehscheiben – der teils teure Teil jeder FFT, hier pro Größe einmal. */
function twiddleTable(size: number, inverse: boolean): { cos: Float64Array; sin: Float64Array } {
  const key = `${size}:${inverse ? 'i' : 'f'}`;
  const cached = TWIDDLES.get(key);
  if (cached) return cached;
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < size / 2; k++) {
    const angle = (sign * 2 * Math.PI * k) / size;
    cos[k] = Math.cos(angle);
    sin[k] = Math.sin(angle);
  }
  const table = { cos, sin };
  TWIDDLES.set(key, table);
  return table;
}

/**
 * In-place FFT über getrennte Real-/Imaginärteile. Länge muss eine Zweierpotenz
 * sein; die Rücktransformation erfolgt über `ifftRadix2`.
 */
export function fftRadix2(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (!isPow2(n) || im.length !== n) throw new Error(`FFT braucht Zweierpotenzen, bekommen: ${n}`);

  // Bit-Umkehrung (Stockham-lite: erst vertauschen, dann Schwämme anwenden)
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  const twiddle = twiddleTable(n, inverse);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len; // Schritt in der Vorausrechnung (eine Tabelle pro Größe)
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const wr = twiddle.cos[k * stride];
        const wi = twiddle.sin[k * stride];
        const ar = re[start + k];
        const ai = im[start + k];
        const br = re[start + k + half] * wr - im[start + k + half] * wi;
        const bi = re[start + k + half] * wi + im[start + k + half] * wr;
        re[start + k] = ar + br;
        im[start + k] = ai + bi;
        re[start + k + half] = ar - br;
        im[start + k + half] = ai - bi;
      }
    }
  }

  if (inverse) {
    const scale = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= scale;
      im[i] *= scale;
    }
  }
}

/** Rücktransformation (mit 1/n Skala). */
export function ifftRadix2(re: Float64Array, im: Float64Array): void {
  fftRadix2(re, im, true);
}

/** Leistungsspektrum (|X|²) eines reellen Signals; Länge wird auf Zweierpotenz aufgefüllt. */
export function magnitudeSpectrum(signal: Float64Array | Float32Array, fftSize: number): Float64Array {
  const size = nextPow2(Math.max(2, fftSize));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const limit = Math.min(size, signal.length);
  for (let i = 0; i < limit; i++) re[i] = signal[i];
  fftRadix2(re, im);
  const bins = size / 2 + 1;
  const out = new Float64Array(bins);
  for (let k = 0; k < bins; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}
