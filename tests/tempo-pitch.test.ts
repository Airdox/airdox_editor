/**
 * @license
 * Airdox_intelligents_Editor – Nachweis: Tempo- und Tonhöhenanpassung von Clips
 *
 * Geprüft wird der Weg, den die App geht, wenn ein Clip aus einer Spur mit
 * anderem Tempo in eine andere Spur soll: erst der Pegel, dann die Dauer
 * (`fitClipForTrack` → `fitToTempo`), und beides landet in derselben Meldung,
 * die auch die Statuszeile zeigt. Gemessen wird am Signal – nicht an der
 * Rechnung des Modulautors:
 *
 *   · liegt ein Impuls nach dem Anpassen auf jedem Schlag des Zielrasters?
 *   · bleibt die Grundfrequenz stehen (Vocoder) oder wandert sie (Resample)?
 *   · stimmt die Länge auf ein Sample, damit der nächste Takt nicht rutscht?
 *
 * Ausführen: npx tsx tests/tempo-pitch.test.ts   (bzw. npm run proof:tempo-pitch)
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { PcmAudio, pcmDuration, pcmPeak, pcmRangesEqual, pcmSampleCount } from '../src/audio/pcm';
import {
  STRETCH_FRAME_SECONDS,
  centsFromRatio,
  fitLength,
  fitToTempo,
  phaseVocodeStretch,
  planTempoFit,
  resamplePcm,
  semitonesFromRatio,
  tempoFitNote,
  tempoSpeed,
  wsolaStretch,
} from '../src/audio/timeStretch';
import { ifftRadix2, fftRadix2, magnitudeSpectrum, nextPow2 } from '../src/audio/fft';
import { CLIP_NORM_TARGET_PEAK, applyClipDrop, clipDropNote, describeClipFit } from '../src/audio/clipLibrary';
import { EditableAudio } from '../src/audio/editOps';
import { BeatGrid, DataOrigin } from '../src/types/rekordbox';

// ── Material mit messbarer Signatur ────────────────────────────────────────

const SR = 44100;
const SOURCE_BPM = 120;
const TARGET_BPM = 128;
const BARS = 8;
const BAR_SECONDS_SOURCE = (60 / SOURCE_BPM) * 4;
const BAR_SECONDS_TARGET = (60 / TARGET_BPM) * 4;
const CLIP_SECONDS = BARS * BAR_SECONDS_SOURCE; // 16 s
const CLIP_SAMPLES = Math.round(CLIP_SECONDS * SR);

/** Ein Takt = ein Impulspaar (Kick-artiger Einschwingvorgang) auf tiefer Note. */
function musicLikePcm(): PcmAudio {
  const left = new Float32Array(CLIP_SAMPLES);
  const right = new Float32Array(CLIP_SAMPLES);
  for (let bar = 0; bar < BARS; bar++) {
    const freq = 110 + bar * 55; // eigene Tonhöhe je Takt – damit man sie wiederfindet
    const startSample = Math.round(bar * BAR_SECONDS_SOURCE * SR);
    const endSample = Math.round((bar + 1) * BAR_SECONDS_SOURCE * SR);
    for (let i = startSample; i < endSample; i++) {
      const local = i - startSample;
      const beat = local / ((60 / SOURCE_BPM) * SR); // 0 … 4 innerhalb des Takts
      const envelope = 0.25 + 0.75 * Math.exp(-3.2 * (beat % 1)); // Einschwingen auf jedem Schlag
      const value =
        envelope *
        (0.6 * Math.sin((2 * Math.PI * freq * local) / SR) +
          0.25 * Math.sin((2 * Math.PI * freq * 2 * local) / SR) +
          0.15 * Math.sin((2 * Math.PI * freq * 3 * local) / SR));
      left[i] = value;
      right[i] = value * 0.5; // festes Verhältnis – fällt bei Kanalversatz auf
    }
  }
  return { sampleRate: SR, channels: [left, right] };
}

/** Goertzel-Leistung einer Frequenz (normiert auf die Rahmenlänge). */
function tonePower(pcm: PcmAudio, freq: number, startSample = 0, samples?: number): number {
  const data = pcm.channels[0];
  const from = Math.max(0, startSample);
  const n = Math.max(1, Math.min(samples ?? data.length - from, data.length - from));
  const k = (freq * n) / SR;
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = data[from + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

function bestToneFrequency(pcm: PcmAudio, from: number, to: number, step = 0.5): { freq: number; power: number } {
  let best = { freq: from, power: -1 };
  for (let freq = from; freq <= to; freq += step) {
    const power = tonePower(pcm, freq);
    if (power > best.power) best = { freq, power };
  }
  return best;
}

/**
 * Impulszeiten – unabhängig vom Stretch-Code gemessen: Kurzzeitenergie in 5-ms-Fenstern,
 * geglättet, dann gieriges Peak-Picking mit Refraktärzeit. Die Refraktärzeit verhindert,
 * dass Nachschwingen desselben Einschwingvorgangs als zweiter Impuls zählt.
 */
/** Energie je Takt – ein Phasevocoder darf keinem Takt Löcher schlagen. */
function barRootMeanSquares(pcm: PcmAudio, bars: number): number[] {
  const data = pcm.channels[0];
  const barSamples = Math.floor(data.length / bars);
  const out: number[] = [];
  for (let start = 0; start + barSamples <= data.length; start += barSamples) {
    let sum = 0;
    for (let i = start; i < start + barSamples; i++) sum += data[i] * data[i];
    out.push(Math.sqrt(sum / barSamples));
  }
  return out;
}

function onsetTimes(pcm: PcmAudio, options: { refractoryMs?: number; factor?: number } = {}): number[] {
  const refractory = Math.round(((options.refractoryMs ?? 140) / 1000) * SR);
  const win = Math.round(0.005 * SR);
  const data = pcm.channels[0];
  const envelope: number[] = [];
  for (let i = 0; i + win < data.length; i += win) {
    let sum = 0;
    for (let j = 0; j < win; j++) sum += Math.abs(data[i + j]);
    envelope.push(sum / win);
  }
  const smooth = envelope.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(envelope.length - 1, i + 2); j++) {
      sum += envelope[j];
      n += 1;
    }
    return sum / n;
  });
  const sorted = [...smooth].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const threshold = median * (options.factor ?? 1.35);
  const taken: number[] = [];
  const blocked = new Uint8Array(smooth.length);
  const order = smooth.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
  for (const { value, index } of order) {
    if (value < threshold) break;
    if (blocked[index]) continue;
    taken.push(index);
    const from = Math.max(0, index - refractory / win);
    const to = Math.min(smooth.length - 1, index + refractory / win);
    for (let i = Math.floor(from); i <= Math.ceil(to); i++) blocked[i] = 1;
  }
  // Verfeinern: Der Augenblick, in dem die geglättete Hüllkurve die Hälfte des
  // Abstandes zum vorherigen Tal überschreitet, ist deutlich unempfindlicher
  // gegen die Form des Einschwingvorgangs als das Maximum selbst.
  return taken
    .sort((a, b) => a - b)
    .map((index) => {
      const back = Math.max(0, index - Math.round(0.05 * SR / win));
      let valley = smooth[index];
      for (let i = back; i <= index; i++) valley = Math.min(valley, smooth[i]);
      const level = valley + 0.5 * (smooth[index] - valley);
      let at = back;
      for (let i = back; i <= index; i++) {
        if (smooth[i] >= level) {
          at = i;
          break;
        }
      }
      return (at * win) / SR;
    });
}

function grid(seconds: number, bpm: number, meter = 4): BeatGrid {
  const spb = 60 / bpm;
  const beats = Array.from({ length: Math.max(1, Math.floor(seconds / spb) + 1) }, (_, i) => ({
    index: i,
    time: i * spb,
    isBarStart: i % meter === 0,
    barNumber: Math.floor(i / meter) + 1,
    beatInBar: (i % meter) + 1,
  }));
  return { firstBeat: 0, bpm, meter, origin: DataOrigin.LOCAL_ANALYSIS, beats };
}

// ── Testrahmen ─────────────────────────────────────────────────────────────

const ARTIFACT_DIR = path.join('tests', 'artifacts', 'tempo-pitch');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

interface CheckResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
  error?: string;
}

const results: CheckResult[] = [];

function check(name: string, expected: string, run: () => string): void {
  try {
    const actual = run();
    results.push({ name, passed: true, expected, actual });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const carried = err instanceof Error ? (err as unknown as { actual?: unknown }).actual : undefined;
    results.push({ name, passed: false, expected, actual: typeof carried === 'string' ? carried : error, error });
  }
}

function expect(condition: unknown, message: string, actual?: string): void {
  if (!condition) {
    const err = new Error(message) as Error & { actual?: string };
    err.actual = actual !== undefined ? `${message} – tatsächlich: ${actual}` : message;
    throw err;
  }
}

const material = musicLikePcm();
const speed = tempoSpeed(SOURCE_BPM, TARGET_BPM);

// ── 1. FFT-Grundlagen ──────────────────────────────────────────────────────

check('FFT: Sinuston landet in der erwarteten Tonne', 'Spitzenbin = nächstgelegene Bin zur Frequenz', () => {
  const size = 4096;
  const freq = 220;
  const data = new Float64Array(size);
  for (let i = 0; i < size; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  const spectrum = magnitudeSpectrum(data, size);
  let bestBin = 0;
  let bestValue = -1;
  for (let k = 1; k < spectrum.length - 1; k++) {
    if (spectrum[k] > bestValue) {
      bestValue = spectrum[k];
      bestBin = k;
    }
  }
  const expectedBin = Math.round((freq * size) / SR);
  expect(Math.abs(bestBin - expectedBin) <= 1, 'Spitzenbin falsch', `${bestBin} statt ${expectedBin}`);
  return `Bin ${bestBin} (erwartet ${expectedBin}) → ${((bestBin * SR) / size).toFixed(1)} Hz bei ${freq} Hz Ton`;
});

check('FFT: Hin- und Rückweg sind exakt (Parseval und Identität)', 'maximale Abweichung < 1e-9', () => {
  const size = nextPow2(2048);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let energy = 0;
  for (let i = 0; i < size; i++) {
    re[i] = Math.sin((2 * Math.PI * 100 * i) / SR) + 0.3 * Math.cos((2 * Math.PI * 900 * i) / SR);
    energy += re[i] * re[i];
  }
  const original = Float64Array.from(re);
  fftRadix2(re, im);
  let spectral = 0;
  for (let i = 0; i < size; i++) spectral += (re[i] * re[i] + im[i] * im[i]) / size;
  ifftRadix2(re, im);
  let worst = 0;
  for (let i = 0; i < size; i++) worst = Math.max(worst, Math.abs(re[i] - original[i]));
  expect(worst < 1e-9, 'Rücktransformation nicht exakt', worst.toExponential(2));
  const energyRatio = spectral / energy;
  expect(Math.abs(energyRatio - 1) < 1e-6, 'Parseval verletzt', energyRatio.toFixed(8));
  return `Abweichung ${worst.toExponential(2)}, Energieverhältnis ${energyRatio.toFixed(8)}`;
});

// ── 2. Vocoder: Länge, Tonhöhe, Raster ─────────────────────────────────────

check('Vocoder: Länge stimmt auf unter einen Rahmen', `Ziel ${Math.round(CLIP_SAMPLES / speed)} Samples ± ${Math.round(STRETCH_FRAME_SECONDS * SR)}`, () => {
  const stretched = phaseVocodeStretch(material, speed);
  const expected = Math.round(CLIP_SAMPLES / speed);
  const deviation = Math.abs(pcmSampleCount(stretched.pcm) - expected);
  expect(!stretched.untouched, 'Vocoder hat nichts getan');
  expect(deviation <= Math.round(STRETCH_FRAME_SECONDS * SR), 'Länge weicht zu stark ab', String(deviation));
  expect(stretched.frames > 10, 'zu wenige Rahmen', String(stretched.frames));
  return `${pcmSampleCount(stretched.pcm)} Samples (erwartet ${expected}, Δ ${deviation} = ${(deviation / SR * 1000).toFixed(2)} ms), ${stretched.frames} Rahmen, Sprungweite ${stretched.analysisHop}`;
});

check('Vocoder: Tonhöhe bleibt, wo sie war', 'Grundfrequenz unverändert, keine Verstärkung bei f·ratio', () => {
  const stretched = fitLength(phaseVocodeStretch(material, speed).pcm, Math.round(CLIP_SAMPLES / speed));
  const raw = tonePower(material, 110);
  const held = tonePower(stretched, 110);
  const moved = tonePower(stretched, 110 * speed);
  expect(held / raw > 0.85, 'Tonhöhe gelitten', `Ratio ${(held / raw).toFixed(3)}`);
  expect(moved / raw < 0.5, 'Tonhöhe ist mitgewandert', `Ratio ${(moved / raw).toFixed(3)}`);
  return `bei 110 Hz ${(held / raw).toFixed(3)} × Ausgangsleistung, bei ${(110 * speed).toFixed(1)} Hz nur ${(moved / raw).toFixed(3)}`;
});

check('Vocoder: Impulse treffen das Zielraster (der eigentliche Zweck)', 'jeder Schlag auf dem 128-BPM-Raster, innerhalb des Messrauschens', () => {
  const stretched = fitLength(phaseVocodeStretch(material, speed).pcm, Math.round(CLIP_SAMPLES / speed));
  // Der Detektor selbst hat eine Sollbruchstelle: Auch am unbearbeiteten Material
  // sitzt das Maximum der geglätteten Hüllkurve ein paar Millisekunden nach dem
  // Einschwingvorgang. Diese Spanne wird gemessen, nicht vorausgesetzt – nur
  // gegen sie darf die Anpassung gewinnen.
  const reference = onsetTimes(material, { refractoryMs: 250 });
  const sourceBeat = 60 / SOURCE_BPM;
  let slop = 0;
  for (const onset of reference) {
    const offset = Math.abs(onset / sourceBeat - Math.round(onset / sourceBeat)) * sourceBeat;
    if (offset > slop) slop = offset;
  }
  const toleranceMs = Math.max(12, slop * 1000 + 6);

  const onsets = onsetTimes(stretched, { refractoryMs: 250 });
  expect(Math.abs(onsets.length - reference.length) <= 4, 'andere Anzahl Impulse als im Material', `${onsets.length} gegen ${reference.length}`);
  const beat = 60 / TARGET_BPM;
  const offsets = onsets.map((onset) => Math.abs(onset / beat - Math.round(onset / beat)) * beat * 1000);
  const sortedOffsets = [...offsets].sort((a, b) => a - b);
  const medianOffset = sortedOffsets[Math.floor(sortedOffsets.length / 2)];
  const maxOffset = sortedOffsets[sortedOffsets.length - 1];
  // Der Lauf über die ganze Länge ist die eigentliche Frage: Wenn die Anpassung
  // fehlt, addiert sich der Fehler Takt für Takt – der Abstand der Impulse muss
  // deshalb die Schlaglänge des Zieltempos treffen, nicht bloß die Lage.
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  onsets.forEach((onset, index) => {
    sumX += index;
    sumY += onset;
    sumXY += index * onset;
    sumXX += index * index;
  });
  const slope = (onsets.length * sumXY - sumX * sumY) / (onsets.length * sumXX - sumX * sumX);
  expect(Math.abs(slope - beat) < 0.002, 'Impulsabstand trifft das Zieltempo nicht', `${(slope * 1000).toFixed(2)} ms statt ${(beat * 1000).toFixed(2)} ms`);
  expect(medianOffset <= toleranceMs, 'Impulse liegen im Median neben dem Raster', `${medianOffset.toFixed(1)} ms (Toleranz ${toleranceMs.toFixed(1)} ms)`);
  // Gegen das Quelltempo müssten sie daneben liegen, sonst wäre der Test trivial.
  const sourceOffsets = onsets.map((onset) => Math.abs(onset / sourceBeat - Math.round(onset / sourceBeat)) * sourceBeat * 1000);
  const medianSource = [...sourceOffsets].sort((a, b) => a - b)[Math.floor(sourceOffsets.length / 2)];
  expect(medianSource > toleranceMs, 'Test wäre auch ohne Anpassung grün', `${medianSource.toFixed(1)} ms`);
  return `${onsets.length} Impulse, Versatz gegen 128 BPM: Median ${medianOffset.toFixed(1)} ms, größten ${maxOffset.toFixed(1)} ms (Toleranz ${toleranceMs.toFixed(1)} ms, Messrauschen am unbearbeiteten Material ${(slop * 1000).toFixed(1)} ms); Schlagabstand ${(slope * 1000).toFixed(2)} ms (Soll ${(beat * 1000).toFixed(2)} ms); gegen 120 BPM wären es ${medianSource.toFixed(1)} ms Median`;
});

check('Vocoder: Pegel bleibt am Eingang (kein Rand-Ausreißer)', 'Spitze 0,5–1,5 × Eingang, Sinus-RMS ±1 %', () => {
  const stretched = phaseVocodeStretch(material, speed).pcm;
  const inPeak = pcmPeak(material);
  const outPeak = pcmPeak(stretched);
  expect(outPeak > inPeak * 0.5 && outPeak < inPeak * 1.5, 'Spitze wandert zu stark', `${outPeak.toFixed(4)} gegen ${inPeak.toFixed(4)}`);
  // Stationäres Material muss in der Lautstärke exakt gehalten werden.
  const n = Math.round(2 * SR);
  const sine = new Float32Array(n);
  for (let i = 0; i < n; i++) sine[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR);
  const held = phaseVocodeStretch({ sampleRate: SR, channels: [sine, new Float32Array(n)] }, speed).pcm;
  let inPower = 0;
  let outPower = 0;
  for (let i = 0; i < n; i++) inPower += sine[i] * sine[i];
  const limit = Math.min(n, held.channels[0].length);
  for (let i = 0; i < limit; i++) outPower += held.channels[0][i] * held.channels[0][i];
  const ratio = Math.sqrt(outPower / limit / (inPower / n));
  expect(Math.abs(ratio - 1) < 0.02, 'Sinus wird in der Lautstärke verändert', ratio.toFixed(4));
  return `Clip: Spitze ${inPeak.toFixed(4)} → ${outPeak.toFixed(4)}; Sinus-RMS-Verhältnis ${ratio.toFixed(4)}`;
});

check('Vocoder: Pegel je Takt hält (keine Löcher)', 'kein Takt weicht mehr als 8 % ab', () => {
  const stretched = fitLength(phaseVocodeStretch(material, speed).pcm, Math.round(CLIP_SAMPLES / speed));
  const inputBars = barRootMeanSquares(material, BARS);
  const outputBars = barRootMeanSquares(stretched, BARS);
  expect(outputBars.length === BARS && inputBars.length === BARS, 'Taktanzahl passt nicht', `${outputBars.length} gegen ${inputBars.length}`);
  let worst = 0;
  let worstBar = 0;
  for (let bar = 0; bar < BARS; bar++) {
    const error = Math.abs(outputBars[bar] / inputBars[bar] - 1);
    if (error > worst) {
      worst = error;
      worstBar = bar;
    }
  }
  // Der erste Takt beginnt im Material mit einer harten Stufe von Stille auf
  // vollen Ausschlag – genau an einer Rahmengrenze. Die kostet am Rand einige
  // Prozente; Löcher, wie sie ein nicht-COLA-konsistentes Syntheseraster schlägt,
  // sind damit nicht zu verwechseln (gemessen: 20–70 % über einzelne Takte verteilt).
  expect(worst <= 0.08, `Takt ${worstBar} im Pegel verfälscht`, `${(worst * 100).toFixed(1)} %`);
  return `Pegelverhältnisse je Takt ${outputBars.map((value, i) => (value / inputBars[i]).toFixed(3)).join(' ')} – größter Fehler ${(worst * 100).toFixed(1)} % (Takt ${worstBar})`;
});

check('Vocoder: Kanäle bleiben zueinander proportional', 'rechts = 0,5 × links, exakt', () => {
  const stretched = phaseVocodeStretch(material, speed).pcm;
  let worst = 0;
  const left = stretched.channels[0];
  const right = stretched.channels[1];
  for (let i = 0; i < left.length; i++) worst = Math.max(worst, Math.abs(left[i] - 2 * right[i]));
  expect(worst < 1e-6, 'Stereo läuft auseinander', worst.toExponential(2));
  return `größte Abweichung ${worst.toExponential(2)}`;
});

check('Vocoder: zweiter Lauf liefert bitgleiche Samples', 'identische Arrays', () => {
  const a = phaseVocodeStretch(material, speed).pcm;
  const b = phaseVocodeStretch(material, speed).pcm;
  expect(
    pcmRangesEqual(a, 0, b, 0, pcmSampleCount(a)) && pcmRangesEqual(b, 0, a, 0, pcmSampleCount(b)),
    'nicht deterministisch'
  );
  return `${pcmSampleCount(a)} Samples, beide Läufe bitgleich`;
});

// ── 3. Resample: der Weg mit Tonhöhe ───────────────────────────────────────

check('Resample: Länge gleich, Tonhöhe wandert mit dem Tempo', `Spitze bei 110·${speed.toFixed(4)} Hz`, () => {
  const resampled = resamplePcm(material, speed);
  const expected = Math.floor(CLIP_SAMPLES / speed);
  expect(Math.abs(pcmSampleCount(resampled) - expected) <= 1, 'Länge falsch', `${pcmSampleCount(resampled)} statt ${expected}`);
  const wanted = 110 * speed;
  const found = bestToneFrequency(resampled, 100, 130, 0.1);
  expect(Math.abs(found.freq - wanted) < 1.5, 'Tonhöhe wandert anders als erwartet', `${found.freq.toFixed(2)} Hz statt ${wanted.toFixed(2)} Hz`);
  const cents = centsFromRatio(speed);
  expect(Math.abs(cents - 111.73) < 0.5, 'Cent-Angabe falsch', cents.toFixed(2));
  return `${pcmSampleCount(resampled)} Samples, Spitze ${found.freq.toFixed(2)} Hz (erwartet ${wanted.toFixed(2)}), ${cents.toFixed(1)} Cent = ${semitonesFromRatio(speed).toFixed(2)} Halbtöne`;
});

check('beide Wege erzeugen dieselbe Dauer', '±1 Sample nach fitLength', () => {
  const target = Math.round(CLIP_SAMPLES / speed);
  const vocoded = fitLength(phaseVocodeStretch(material, speed).pcm, target);
  const resampled = fitLength(resamplePcm(material, speed), target);
  expect(pcmSampleCount(vocoded) === target && pcmSampleCount(resampled) === target, 'fitLength kürzt/polstert nicht exakt', `${pcmSampleCount(vocoded)}/${pcmSampleCount(resampled)}`);
  return `${pcmSampleCount(vocoded)} = ${pcmSampleCount(resampled)} = ${target} Samples`;
});

check('fitLength: Stutzen und Auffüllen', 'exakte Samplezahl, Lücken still', () => {
  const short = fitLength(material, 1000);
  const long = fitLength(material, CLIP_SAMPLES + 500);
  expect(pcmSampleCount(short) === 1000, 'kürzen falsch', String(pcmSampleCount(short)));
  expect(pcmSampleCount(long) === CLIP_SAMPLES + 500, 'auffüllen falsch', String(pcmSampleCount(long)));
  const tail = long.channels[0].subarray(CLIP_SAMPLES);
  let tailPeak = 0;
  for (const value of tail) tailPeak = Math.max(tailPeak, Math.abs(value));
  expect(tailPeak === 0, 'Auffüllung ist nicht still', String(tailPeak));
  return `${pcmSampleCount(short)} und ${pcmSampleCount(long)} Samples, angehängte Stille ${tail.length} Samples`;
});

// ── 4. fitToTempo: Entscheidungen und Meldungen ────────────────────────────

check('fitToTempo: meldet jede Entscheidung richtig', 'aus / kein tempo / praktisch gleich / stumm / zu kurz', () => {
  const off = fitToTempo(material, { sourceBpm: SOURCE_BPM, targetBpm: TARGET_BPM, enabled: false });
  expect(off.report.skipped === 'aus' && !off.report.applied, 'aus wird nicht gemeldet', String(off.report.skipped));
  expect(pcmSampleCount(off.pcm) === CLIP_SAMPLES, 'trotz „aus“ gerechnet');

  const noGrid = fitToTempo(material, { sourceBpm: 0, targetBpm: TARGET_BPM });
  expect(noGrid.report.skipped === 'kein tempo', 'fehlendes Raster nicht gemeldet', String(noGrid.report.skipped));

  const equal = fitToTempo(material, { sourceBpm: 130, targetBpm: 130 });
  expect(equal.report.skipped === 'praktisch gleich', 'Gleichklang nicht gemeldet', String(equal.report.skipped));
  expect(tempoFitNote(equal.report) === null, 'Grundmeldung hätte still sein müssen');

  const silent = fitToTempo({ sampleRate: SR, channels: [new Float32Array(SR * 4), new Float32Array(SR * 4)] }, { sourceBpm: SOURCE_BPM, targetBpm: TARGET_BPM });
  expect(silent.report.skipped === 'stumm', 'Stille anders gemeldet', String(silent.report.skipped));

  const tinyLoud = { sampleRate: SR, channels: [new Float32Array(0)] };
  {
    const n = Math.round(SR * 0.02);
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = 0.7 * Math.sin((2 * Math.PI * 200 * i) / SR);
    tinyLoud.channels = [tone, new Float32Array(n)];
  }
  const tiny = fitToTempo(tinyLoud, { sourceBpm: SOURCE_BPM, targetBpm: TARGET_BPM });
  expect(tiny.report.skipped === 'zu kurz', 'kurzes Material anders gemeldet', String(tiny.report.skipped));

  const applied = fitToTempo(material, { sourceBpm: SOURCE_BPM, targetBpm: TARGET_BPM });
  expect(applied.report.applied && applied.report.method === 'vocoder', 'Standardweg ist nicht der Vocoder', applied.report.method);
  const note = tempoFitNote(applied.report) ?? '';
  expect(/Tempo an Zielspur angepasst/.test(note) && /Tonhöhe bleibt gleich/.test(note), `Meldung unvollständig: ${note}`);
  return `fünf Meldungen korrekt; Standard: ${applied.report.method}, Text „${note}“`;
});

check('fitToTempo: Key-Lock aus nimmt die Tonhöhe mit', 'pitchCents = 1200·log2(ratio)', () => {
  const withPitch = fitToTempo(material, { sourceBpm: SOURCE_BPM, targetBpm: TARGET_BPM, pitchFollowsTempo: true });
  expect(withPitch.report.method === 'resample', 'falscher Weg', withPitch.report.method);
  const expected = centsFromRatio(speed);
  expect(Math.abs(withPitch.report.pitchCents - expected) < 1e-6, 'Cent-Wert falsch', `${withPitch.report.pitchCents} vs ${expected}`);
  const found = bestToneFrequency(withPitch.pcm, 100, 130, 0.1);
  expect(Math.abs(found.freq - 110 * speed) < 1.5, 'Tonhöhe wanderte nicht mit', `${found.freq.toFixed(2)} Hz`);
  const without = fitToTempo(material, { sourceBpm: SOURCE_BPM, targetBpm: TARGET_BPM });
  expect(Math.abs(without.report.pitchCents) < 1e-9, 'Vocoder behauptet eine Tonhöhenverschiebung', String(without.report.pitchCents));
  return `${expected.toFixed(1)} Cent vorhergesagt, gemessen ${found.freq.toFixed(2)} Hz (erwartet ${(110 * speed).toFixed(2)})`;
});

check('planTempoFit: die Oberfläche zeigt, was gleich passiert', 'ohne zu rechnen: Verhältnis, Prozent, Cent', () => {
  const planned = planTempoFit(SOURCE_BPM, TARGET_BPM, { enabled: true, pitchFollowsTempo: true });
  expect(planned.willApply, 'Plane sagt „nichts“');
  expect(Math.abs(planned.speed - speed) < 1e-12, 'Verhältnis falsch', String(planned.speed));
  expect(Math.abs(planned.pitchCents - centsFromRatio(speed)) < 1e-6, 'Cent falsch', String(planned.pitchCents));
  const off = planTempoFit(SOURCE_BPM, TARGET_BPM, { enabled: false });
  expect(!off.willApply && off.reason === 'aus', 'Schalter aus wird ignoriert', off.reason);
  const same = planTempoFit(TARGET_BPM, TARGET_BPM, { enabled: true });
  expect(!same.willApply && same.reason === 'praktisch gleich', 'Gleichklang fehlt', same.reason);
  const plannedDuration = CLIP_SECONDS / planned.speed;
  const real = fitToTempo(material, { sourceBpm: SOURCE_BPM, targetBpm: TARGET_BPM });
  expect(Math.abs(pcmDuration(real.pcm) - plannedDuration) < 0.001, 'Plan und Rechnung weichen ab', `${pcmDuration(real.pcm)} vs ${plannedDuration}`);
  return `+${planned.percent.toFixed(1)} % → ${plannedDuration.toFixed(4)} s (gerechnet ${pcmDuration(real.pcm).toFixed(4)} s)`;
});

// ── 5. Die Bibliothek: Tempoangleichung vor der Ablage ─────────────────────

const silentTrackBars = Math.round(4 * BAR_SECONDS_TARGET * SR);
const targetTrack: EditableAudio = {
  audio: { sampleRate: SR, channels: [new Float32Array(silentTrackBars), new Float32Array(silentTrackBars)] },
  cues: [],
  loops: [],
  beatGrid: grid(silentTrackBars / SR, TARGET_BPM),
};

check('Ablage in fremde Spur: Clip wird exakt acht Takte des Zieltempos', `8 · ${Math.round(BAR_SECONDS_TARGET * SR)} Samples`, () => {
  const before = pcmSampleCount(targetTrack.audio);
  const outcome = applyClipDrop(targetTrack, material, 0, {
    mode: 'insert',
    quantize: true,
    sourceBpm: SOURCE_BPM,
    tempoMatch: true,
  });
  const expectedBlock = Math.round(BARS * BAR_SECONDS_TARGET * SR);
  expect(Math.abs(pcmSampleCount(outcome.placedAudio) - expectedBlock) <= 1, 'eingefügte Länge passt nicht zum Zielraster', `${pcmSampleCount(outcome.placedAudio)} statt ${expectedBlock}`);
  expect(outcome.tempo.applied && outcome.tempo.method === 'vocoder', 'Tempo nicht angepasst', `${outcome.tempo.method}/${outcome.tempo.skipped ?? 'ok'}`);
  expect(Math.abs(outcome.clipEndSeconds - BARS * BAR_SECONDS_TARGET) < 0.001, 'Clip-Ende liegt nicht auf einer Taktgrenze', String(outcome.clipEndSeconds));
  expect(pcmSampleCount(outcome.target.audio) - before === pcmSampleCount(outcome.placedAudio), 'Spur wuchs um die falsche Menge');
  return `${pcmSampleCount(outcome.placedAudio)} Samples eingefügt (${BARS} Takte à ${BAR_SECONDS_TARGET.toFixed(4)} s), Spur danach ${pcmSampleCount(outcome.target.audio)} Samples`;
});

check('Ablage: Pegel und Tempo stehen gemeinsam in der Meldung', 'ein Satz mit „normalisiert“ und „Tempo an Zielspur“', () => {
  const outcome = applyClipDrop(targetTrack, material, 0, { mode: 'insert', quantize: true, sourceBpm: SOURCE_BPM, tempoMatch: true });
  const note = clipDropNote(outcome) ?? '';
  expect(/normalisiert/.test(note), `Pegel fehlt in der Meldung: ${note}`);
  expect(/Tempo an Zielspur angepasst/.test(note), `Tempo fehlt in der Meldung: ${note}`);
  expect(/Phasenvocoder/.test(note), `Weg nicht benannt: ${note}`);
  expect(Math.abs(outcome.level.peakAfter - CLIP_NORM_TARGET_PEAK) < 0.02, 'Pegel nicht beim Ziel', String(outcome.level.peakAfter));
  expect(pcmPeak(outcome.placedAudio) <= 0.999 + 1e-6, 'Clip über der Obergrenze', String(pcmPeak(outcome.placedAudio)));
  return note;
});

check('Ablage ohne Tempoangleichung: Clip behält seine alte Länge', `${CLIP_SAMPLES} Samples`, () => {
  const untouched = applyClipDrop(targetTrack, material, 0, { mode: 'insert', quantize: true, sourceBpm: SOURCE_BPM, tempoMatch: false });
  expect(pcmSampleCount(untouched.placedAudio) === CLIP_SAMPLES, 'trotz Aus geschoben', String(pcmSampleCount(untouched.placedAudio)));
  expect(untouched.tempo.skipped === 'aus', 'Meldung fehlt', String(untouched.tempo.skipped));
  const clipEndBeats = (untouched.clipEndSeconds / (60 / TARGET_BPM)) % 4;
  expect(Math.abs(clipEndBeats) > 0.05 && Math.abs(clipEndBeats - 4) > 0.05, 'Ende läge zufällig auf dem Takt', String(clipEndBeats));
  return `${pcmSampleCount(untouched.placedAudio)} Samples, Clip-Ende ${(untouched.clipEndSeconds / (60 / TARGET_BPM)).toFixed(2)} Beats nach Zielraster (Taktversatz ${clipEndBeats.toFixed(2)} Beats)`;
});

check('Ersetzen in fremdes Tempo: Taktzahl bleibt, Rest der Spur rückt nicht', 'Länge der Spur gleich, Inhalt 8 Takte', () => {
  const filled: EditableAudio = {
    ...targetTrack,
    audio: {
      sampleRate: SR,
      channels: [new Float32Array(Math.round(16 * BAR_SECONDS_TARGET * SR)), new Float32Array(Math.round(16 * BAR_SECONDS_TARGET * SR))],
    },
  };
  const outcome = applyClipDrop(filled, material, 4 * BAR_SECONDS_TARGET, {
    mode: 'replace',
    quantize: true,
    sourceBpm: SOURCE_BPM,
    tempoMatch: true,
  });
  expect(pcmSampleCount(outcome.target.audio) === pcmSampleCount(filled.audio), 'Länge hat sich geändert', String(pcmSampleCount(outcome.target.audio)));
  expect(outcome.report.kind === 'REPLACE_RANGE', 'falscher Bericht', outcome.report.kind);
  const startSample = Math.round(outcome.atSeconds * SR);
  expect(pcmRangesEqual(outcome.target.audio, startSample, outcome.placedAudio, 0, pcmSampleCount(outcome.placedAudio) - 1), 'Ersatz liegt nicht an der Zielzeit');
  const outside = pcmRangesEqual(outcome.target.audio, 0, filled.audio, 0, startSample - 1) &&
    pcmRangesEqual(outcome.target.audio, startSample + pcmSampleCount(outcome.placedAudio), filled.audio, startSample + pcmSampleCount(outcome.placedAudio), pcmSampleCount(filled.audio) - startSample - pcmSampleCount(outcome.placedAudio));
  expect(outside, 'Außerhalb des Ersatzes verändert');
  return `ersetzt ab ${outcome.atSeconds.toFixed(4)} s über ${pcmSampleCount(outcome.placedAudio)} Samples, Spur bleibt ${pcmSampleCount(outcome.target.audio)} Samples`;
});

check('describeClipFit: Text der Oberfläche rechnet wie die Ablage', 'Plan-Text mit Ziel-BPM und Prozent', () => {
  const text = describeClipFit(
    { id: 'x', name: 'x', sourceTrackId: 'a', sourceTrackName: 'a', sourceStart: 0, sourceEnd: CLIP_SECONDS, duration: CLIP_SECONDS, beats: 32, bars: BARS, bpm: SOURCE_BPM, key: '1A', color: '', origin: DataOrigin.LOCAL_ANALYSIS },
    TARGET_BPM,
    { tempoMatch: true, pitchFollowsTempo: false }
  );
  expect(/120\.0 → 128\.0 BPM \(\+6\.7 %/.test(text), `Text unvollständig: ${text}`);
  expect(/Tonhöhe bleibt/.test(text), `Tonhöhe falsch benannt: ${text}`);
  const withPitch = describeClipFit(
    { id: 'x', name: 'x', sourceTrackId: 'a', sourceTrackName: 'a', sourceStart: 0, sourceEnd: CLIP_SECONDS, duration: CLIP_SECONDS, beats: 32, bars: BARS, bpm: SOURCE_BPM, key: '1A', color: '', origin: DataOrigin.LOCAL_ANALYSIS },
    TARGET_BPM,
    { tempoMatch: true, pitchFollowsTempo: true }
  );
  expect(/Cent/.test(withPitch), `Cent fehlt: ${withPitch}`);
  return text;
});

// ── 6. WSOLA als Ausweg für sehr kurzes Material ───────────────────────────

check('WSOLA: für kurzes Material brauchbar, Länge stimmt', `±1 Rahmen um ${Math.round(CLIP_SAMPLES / speed)}`, () => {
  const short = fitLength(material, Math.round(0.4 * SR)); // 0,4 s: zu kurz für den Vocoder-Fahrplan
  const fallback = fitToTempo(short, { sourceBpm: SOURCE_BPM, targetBpm: TARGET_BPM });
  expect(fallback.report.method === 'vocoder' || fallback.report.method === 'wsola', 'kein Weg', fallback.report.method);
  const stretched = wsolaStretch(material, speed);
  expect(!stretched.untouched, 'WSOLA tat nichts');
  const expected = Math.round(pcmSampleCount(material) / speed);
  expect(Math.abs(pcmSampleCount(stretched.pcm) - expected) <= 2 * Math.round(STRETCH_FRAME_SECONDS * SR), 'WSOLA-Länge weit weg', String(pcmSampleCount(stretched.pcm) - expected));
  expect(pcmSampleCount(fallback.pcm) > 0, 'Fallback ohne Material');
  return `Fallback-Methode ${fallback.report.method}; WSOLA am langen Clip: ${pcmSampleCount(stretched.pcm)} Samples (Δ ${pcmSampleCount(stretched.pcm) - expected}), ${stretched.frames} Rahmen`;
});

// ── 7. Kosten (damit die Oberfläche nicht stehen bleibt) ──────────────────

check('Kosten: acht Takte Material in nützlicher Frist', 'unter 4 s für 16 s Material in Stereo', () => {
  const t0 = performance.now();
  const stretched = phaseVocodeStretch(material, speed);
  const ms = performance.now() - t0;
  expect(pcmSampleCount(stretched.pcm) > 0, 'nichts gerechnet');
  expect(ms < 4000, 'zu langsam', `${ms.toFixed(0)} ms`);
  return `${ms.toFixed(0)} ms für ${CLIP_SECONDS.toFixed(1)} s Stereo bei ${SR} Hz (${(ms / CLIP_SECONDS).toFixed(0)} ms pro Sekunde Audio)`;
});

// ── Auswertung ────────────────────────────────────────────────────────────

const failed = results.filter((entry) => !entry.passed).length;

fs.writeFileSync(
  path.join(ARTIFACT_DIR, 'NACHWEIS.md'),
  [
    '# Nachweis: Tempo- und Tonhöhenanpassung von Clips',
    '',
    'Ein Clip aus einer 120-BPM-Spur, der in eine 128-BPM-Spur soll, muss schneller werden –',
    'sonst liegen seine Beats nach zwei Takten neben dem Raster. Geprüft wird an Musik-artigem',
    'Material (acht Takte, jeder mit eigener Grundfrequenz, auf jedem Schlag ein Einschwingvorgang):',
    'die Impulse werden im Ergebnis **gemessen** (Hüllkurven-Maxima) und gegen das Zielraster',
    'gerechnet, die Tonhöhe mit Goertzel – beides ohne Kenntnis der Stretch-Logik.',
    '',
    `Material: ${BARS} Takte @ ${SOURCE_BPM} BPM, ${SR} Hz, ${CLIP_SAMPLES} Samples (${CLIP_SECONDS.toFixed(2)} s).`,
    `Ziel: ${TARGET_BPM} BPM → Verhältnis ${speed.toFixed(6)} (Soll-Länge ${Math.round(CLIP_SAMPLES / speed)} Samples = ${BARS} Takte à ${BAR_SECONDS_TARGET.toFixed(4)} s).`,
    '',
    '| # | Prüfung | erwartet | tatsächlich | Ergebnis |',
    '| --- | --- | --- | --- | --- |',
    ...results.map(
      (entry, index) =>
        `| ${index + 1} | ${entry.name.replace(/\|/g, '/')} | ${entry.expected.replace(/\|/g, '/')} | ${entry.actual.replace(/\|/g, '/')} | ${
          entry.passed ? '✓' : '✗ ' + (entry.error ?? '').replace(/\|/g, '/')
        } |`
    ),
    '',
    'Wege: `phaseVocodeStretch` (Tonhöhe bleibt – Rahmenlänge 46 ms, 75 % Überlappung,',
    'Phasenfortschritt je Tonne auf den Synthesefahrplan gerechnet), `resamplePcm`',
    '(Tonhöhe wandert mit – Key-Lock aus), `wsolaStretch` (Ausweg für sehr kurzes Material).',
    'Reihenfolge in `fitClipForTrack`: erst Pegel (`normalizeClipAudio`), dann Tempo – danach',
    'liegt der Clip samplegenau auf der Taktgrenze der Zielspur.',
    '',
    'Erzeugt von `npx tsx tests/tempo-pitch.test.ts`.',
    '',
  ].join('\n'),
  'utf-8'
);

console.log('\n═══ Tempo und Tonhöhe beim Clip-Austausch: Nachweis ═══\n');
for (let index = 0; index < results.length; index++) {
  const entry = results[index];
  console.log(`${entry.passed ? '✓' : '✗'} [${index + 1}] ${entry.name}`);
  console.log(`      erwartet    : ${entry.expected}`);
  console.log(`      tatsächlich : ${entry.actual}`);
  if (!entry.passed) console.log(`      FEHLER      : ${entry.error}`);
}
console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Total: ${results.length} | Passed: ${results.length - failed} | Failed: ${failed}`);
console.log(`Beweise: ${path.join(ARTIFACT_DIR, 'NACHWEIS.md')}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
process.exit(0);
