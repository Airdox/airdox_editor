/** Small deterministic synthesis primitives shared by technical fixtures. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function bandLimitedSaw(freq: number, t: number, sampleRate: number, harmonics = 16): number {
  let value = 0; const max = Math.max(1, Math.min(harmonics, Math.floor(sampleRate / (2 * Math.max(1, freq)))));
  for (let h = 1; h <= max; h++) value += Math.sin(2 * Math.PI * freq * h * t) / h;
  return value * (2 / Math.PI);
}
export function addKick(target: Float32Array, frames: number, sampleRate: number, start: number, gain: number): void {
  const len = Math.floor(sampleRate * .28);
  for (let i = 0; i < len && start + i < frames; i++) { const t = i / sampleRate; const freq = 145 * Math.exp(-t * 35) + 42; const v = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 13) * gain; target[(start + i) * 2] += v; target[(start + i) * 2 + 1] += v; }
}
export function addNoiseBurst(target: Float32Array, frames: number, sampleRate: number, start: number, length: number, gain: number, highPass: number, random: () => number): void {
  let pl = 0, pr = 0, rl = 0, rr = 0;
  for (let i = 0; i < length && start + i < frames; i++) { const e = Math.exp(-i / sampleRate * 38); const rawL = (random() * 2 - 1) * gain; const rawR = (random() * 2 - 1) * gain; const l = highPass * (pl + rawL - rl); const r = highPass * (pr + rawR - rr); rl = rawL; rr = rawR; pl = l; pr = r; target[(start + i) * 2] += l * e; target[(start + i) * 2 + 1] += r * e; }
}
export function addSupersaw(target: Float32Array, frames: number, sampleRate: number, freq: number, start: number, length: number, gain: number, width: number): void {
  for (let i = 0; i < length && start + i < frames; i++) { const t = i / sampleRate; const e = Math.min(1, t / .01) * Math.exp(-t * .7); let l = 0, r = 0; for (let v = 0; v < 7; v++) { const detune = 1 + (v - 3) * .004; const pan = (v / 6) * 2 - 1; const s = bandLimitedSaw(freq * detune, t, sampleRate, 12); l += s * (1 - pan * width); r += s * (1 + pan * width); } target[(start + i) * 2] += l / 7 * e * gain; target[(start + i) * 2 + 1] += r / 7 * e * gain; }
}
export function addVocal(target: Float32Array, frames: number, sampleRate: number, freq: number, start: number, length: number, gain: number): void {
  const harmonics = [1, 2, 3, 4, 5], weights = [1, .55, .34, .2, .12];
  for (let i = 0; i < length && start + i < frames; i++) { const t = i / sampleRate; const e = Math.min(1, t / .02) * Math.exp(-t * .45); let v = 0; for (let h = 0; h < harmonics.length; h++) v += Math.sin(2 * Math.PI * freq * harmonics[h] * t) * weights[h]; v *= e * gain / 1.9; target[(start + i) * 2] += v; target[(start + i) * 2 + 1] += v; }
}
