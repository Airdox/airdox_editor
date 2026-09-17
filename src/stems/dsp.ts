/** Dependency-free signal analysis primitives used by the quality gate. */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (!n || (n & (n - 1)) !== 0 || im.length !== n) throw new Error(`FFT-Länge muss eine Zweierpotenz sein, ist ${n}`);
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = (inverse ? 1 : -1) * 2 * Math.PI / len; const wr = Math.cos(a), wi = Math.sin(a); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const uR = re[i + k], uI = im[i + k]; const j = i + k + len / 2; const vR = re[j] * cr - im[j] * ci, vI = re[j] * ci + im[j] * cr; re[i + k] = uR + vR; im[i + k] = uI + vI; re[j] = uR - vR; im[j] = uI - vI; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function nextPow2(n: number): number { let p = 1; while (p < n) p <<= 1; return p; }
export function hannWindow(size: number): Float64Array { const w = new Float64Array(size); for (let i = 0; i < size; i++) w[i] = .5 - .5 * Math.cos(2 * Math.PI * i / size); return w; }
export interface StftOptions { frameSize: number; hopSize: number; }
export function magnitudeSpectrogram(signal: Float32Array | Float64Array, options: StftOptions): Float64Array[] {
  const size = Math.max(1, options.frameSize), fftSize = nextPow2(size), window = hannWindow(size), out: Float64Array[] = [];
  for (let start = 0; start + size <= signal.length; start += Math.max(1, options.hopSize)) { const re = new Float64Array(fftSize), im = new Float64Array(fftSize); for (let i = 0; i < size; i++) re[i] = signal[start + i] * window[i]; fftInPlace(re, im); const m = new Float64Array(fftSize / 2 + 1); for (let k = 0; k < m.length; k++) m[k] = Math.hypot(re[k], im[k]); out.push(m); }
  return out;
}
export function logSpectralDistanceDb(reference: Float32Array | Float64Array, estimate: Float32Array | Float64Array, options: StftOptions = { frameSize: 2048, hopSize: 1024 }): number {
  const a = magnitudeSpectrogram(reference, options), b = magnitudeSpectrogram(estimate, options), count = Math.min(a.length, b.length); if (!count) return 0; let total = 0;
  for (let f = 0; f < count; f++) { const bins = Math.min(a[f].length, b[f].length); let sum = 0; for (let k = 0; k < bins; k++) { const d = 20 * Math.log10((a[f][k] + 1e-9) / (b[f][k] + 1e-9)); sum += d * d; } total += Math.sqrt(sum / Math.max(1, bins)); }
  return total / count;
}
export function downmixMono(data: Float32Array, channels: number, frames: number): Float64Array { const out = new Float64Array(frames), ch = Math.max(1, channels); for (let f = 0; f < frames; f++) { let s = 0; for (let c = 0; c < ch; c++) s += data[f * ch + c] || 0; out[f] = s / ch; } return out; }
export interface Onset { frame: number; strength: number; }
export function detectOnsets(mono: Float64Array, sampleRate: number, thresholdRatio = .12, guardMs = 30): Onset[] {
  let peak = 0; for (const v of mono) peak = Math.max(peak, Math.abs(v)); if (peak < 1e-9) return []; const threshold = peak * thresholdRatio, guard = Math.max(1, Math.floor(sampleRate * guardMs / 1000)), step = Math.max(1, Math.floor(sampleRate / 1000)); let previous = 0, last = -guard; const result: Onset[] = [];
  for (let f = 0; f < mono.length; f += step) { let env = 0; for (let i = f; i < Math.min(mono.length, f + step); i++) env += Math.abs(mono[i]); env /= step; const rise = env - previous; if (rise > threshold && f - last >= guard) { result.push({ frame: f, strength: rise }); last = f; } previous = env; } return result;
}
export function findBestLag(reference: Float64Array, signal: Float64Array, maxLag: number): { lag: number; correlation: number } {
  const n = Math.min(reference.length, signal.length), limit = Math.max(0, Math.floor(maxLag)); let refEnergy = 0; for (let i = 0; i < n; i++) refEnergy += reference[i] ** 2; let bestLag = 0, best = -Infinity;
  for (let lag = -limit; lag <= limit; lag++) { let dot = 0, energy = 0, count = 0; const start = Math.max(0, -lag), end = Math.min(n, n - lag); for (let i = start; i < end; i++) { dot += reference[i] * signal[i + lag]; energy += signal[i + lag] ** 2; count++; } if (count < n * .5) continue; const score = refEnergy && energy ? dot / Math.sqrt(refEnergy * energy) : 0; if (score > best) { best = score; bestLag = lag; } }
  return { lag: bestLag, correlation: best === -Infinity ? 0 : best };
}
export function rms(data: Float32Array | Float64Array): number { let sum = 0; for (const v of data) sum += v * v; return Math.sqrt(sum / Math.max(1, data.length)); }
export function peakAbs(data: Float32Array | Float64Array): number { let p = 0; for (const v of data) p = Math.max(p, Math.abs(v)); return p; }
export function toDb(value: number, reference = 1): number { return 20 * Math.log10(Math.max(1e-12, Math.abs(value)) / Math.max(1e-12, Math.abs(reference))); }
