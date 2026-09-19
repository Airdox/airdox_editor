/**
 * ARBEITSKOPIE-SPEED (§ Workflow-Audit 19.09.2026) – die "2–3 Minuten Bremse":
 *
 * Die Vorbereitungsphase "Arbeitskopie …" lief im Produktionsbetrieb mehrere
 * Minuten *ohne* Fortschritt und blockierte den Main-Prozess (kein IPC, keine
 * Events). Wurzelursachen:
 *   #1 `resample()` re-rechnete pro Frame/Tap eine Bessel-Reihe (besselI0) und
 *      legte pro Frame ein weights-Array an – ~60 s für einen 6-minuten-48-kHz-
 *      Track auf einem flotten Desktop, Minuten auf einem Laptop. Der Renderer
 *      liefert die AudioBuffer im AudioContext-Tempo (Windows: 48 kHz), also
 *      traf das jeden Lauf.
 *   #2 der Loop lief synchron im Main-Prozess → UI/IPC froren, Abbruch griff
 *      erst nach der Prep.
 *   #3 `encodeWavFloat32` schrieb per DataView-Sample-Loop, `sha256Bytes`
 *      kopierte den ganzen Buffer, `stageBytes` kopierte den Mix zweimal.
 *
 * Dieser Test hält die Verträge fest:
 *   #1 Resampler: Werte innerhalb von float32-Rundung zum Referenz-Algorithmus
 *      (Down- UND Upsampling), Same-Rate-Early-Exit.
 *   #2 Resampler: Fortschritt monoton bis 1; Abbruch → ResampleCancelledError.
 *   #3 prepareWorkingCopy 48-kHz-Quelle: 44.1 kHz/2ch-Arbeitskopie, Phasen
 *      fingerprint→decode→resample→encode→verify, Resampling-Fortschritt.
 *   #4 Abbruch über Job-Token *während* des Resamplings → INFERENCE_CANCELLED
 *      (kein FAILED, keine halbe Arbeitskopie als Ergebnis).
 *   #5 encodeWavFloat32 Fast Path byte-identisch zum Legacy-Loop; zu kurze
 *      Buffer bleiben nullgefüllt (NaN→0-Semantik nur im Legacy-Pfad).
 *   #6 sha256Bytes: Zero-View über Subarrays, Digest unverändert.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  encodeWavFloat32,
  ResampleCancelledError,
  resample,
  sha256Bytes,
} from '../src/stems/wavIo';
import { prepareWorkingCopy } from '../src/stems/preprocessor';
import { StemSeparationError } from '../src/stems/errors';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  ARBEITSKOPIE: SPEED + FORTSCHRITT + ABBRUCH                      ');
console.log('═══════════════════════════════════════════════════════════════════');

/** Der frühere Resampler (Bessel pro Tap, Array pro Frame) – Referenz. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k <= 25; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}
const KAISER_BETA = 9.0;
const KAISER_DENOM = besselI0(KAISER_BETA);
function kaiserWindow(x: number): number {
  if (x <= -1 || x >= 1) return 0;
  return besselI0(KAISER_BETA * Math.sqrt(1 - x * x)) / KAISER_DENOM;
}
function resampleReference(input: Float32Array, channels: number, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const inFrames = Math.floor(input.length / channels);
  const outFrames = Math.max(1, Math.round(inFrames / ratio));
  const output = new Float32Array(outFrames * channels);
  const halfTaps = 32;
  const cutoff = Math.min(1, 1 / ratio) * 0.95;
  const support = halfTaps * Math.max(1, ratio);
  for (let n = 0; n < outFrames; n++) {
    const center = n * ratio;
    const start = Math.max(0, Math.ceil(center - support));
    const end = Math.min(inFrames - 1, Math.floor(center + support));
    const weights: number[] = [];
    let weightSum = 0;
    for (let i = start; i <= end; i++) {
      const x = (i - center) / Math.max(1, ratio);
      const sincArg = Math.PI * cutoff * x;
      const sinc = Math.abs(sincArg) < 1e-9 ? 1 : Math.sin(sincArg) / sincArg;
      const w = cutoff * sinc * kaiserWindow(x / halfTaps);
      weights.push(w);
      weightSum += w;
    }
    const norm = weightSum !== 0 ? 1 / weightSum : 0;
    for (let c = 0; c < channels; c++) {
      let acc = 0;
      for (let k = 0, i = start; i <= end; i++, k++) acc += input[i * channels + c] * weights[k] * norm;
      output[n * channels + c] = acc;
    }
  }
  return output;
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(a[i] - b[i]);
    if (v > d) d = v;
  }
  return d;
}

/** 30 s Plausible Audio (Sinus + Rauschen), endlich. */
function testSignal(frames: number, channels: number): Float32Array {
  const data = new Float32Array(frames * channels);
  let phase = 0;
  for (let i = 0; i < data.length; i++) {
    phase += 0.00037;
    data[i] = 0.25 * Math.sin(phase) + 0.01 * ((i % 97) / 97 - 0.5) * 2;
  }
  return data;
}

/* 1) Werte + Geometrie (Down- und Upsampling) -------------------------------- */
{
  const frames = 30 * 48000;
  const input = testSignal(frames, 2);

  const down = await resample(input, 2, 48000, 44100);
  const downRef = resampleReference(input, 2, 48000, 44100);
  assert.equal(down.length, downRef.length, 'Downsampling: Länge muss identisch sein');
  assert.ok(maxDiff(down, downRef) < 1e-6, `Downsampling: maxDiff ${maxDiff(down, downRef)} liegt außerhalb float32-Rundung`);

  const upInput = testSignal(30 * 44100, 2);
  const up = await resample(upInput, 2, 44100, 48000);
  const upRef = resampleReference(upInput, 2, 44100, 48000);
  assert.equal(up.length, upRef.length, 'Upsampling: Länge muss identisch sein');
  assert.ok(maxDiff(up, upRef) < 1e-6, `Upsampling: maxDiff ${maxDiff(up, upRef)} liegt außerhalb float32-Rundung`);

  const same = await resample(input, 2, 48000, 48000);
  assert.equal(same, input, 'Same-Rate: Early-Exit liefert denselben Buffer');

  const mono = testSignal(30 * 48000, 1);
  const monoRef = resampleReference(mono, 1, 48000, 44100);
  const monoOut = await resample(mono, 1, 48000, 44100);
  assert.equal(monoOut.length, monoRef.length, 'Mono: Länge muss identisch sein');
  assert.ok(maxDiff(monoOut, monoRef) < 1e-6, 'Mono: Werte innerhalb float32-Rundung');
  console.log('  [1] Resampler: Werte/Geometrie (48k→44.1k, 44.1k→48k, Mono, Same-Rate) ✔');
}

/* 2) Fortschritt + Abbruch des Resamplers ------------------------------------ */
{
  const input = testSignal(60 * 48000, 2);
  const fractions: number[] = [];
  await resample(input, 2, 48000, 44100, {
    yieldEveryFrames: 200_000,
    onProgress: (f) => fractions.push(f),
  });
  assert.ok(fractions.length > 3, 'onProgress: mehrere Meldungen erwartet');
  for (let i = 1; i < fractions.length; i++) {
    assert.ok(fractions[i] > fractions[i - 1], `onProgress muss monoton wachsen (Index ${i})`);
  }
  assert.equal(fractions[fractions.length - 1], 1, 'onProgress endet bei 1');

  let reports = 0;
  let threw: unknown;
  try {
    await resample(input, 2, 48000, 44100, {
      yieldEveryFrames: 100_000,
      isCancelled: () => reports++ >= 2,
    });
  } catch (error) {
    threw = error;
  }
  assert.ok(threw instanceof ResampleCancelledError, `Abbruch wirft ResampleCancelledError, wurde: ${String(threw)}`);
  console.log('  [2] Resampler: Fortschritt monoton bis 1, Abbruch → ResampleCancelledError ✔');
}

/* 3) prepareWorkingCopy: 48-kHz-Quelle, Phasen, Geometrie --------------------- */
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'airdox-wc-speed-'));
  try {
    const frames = 30 * 48000;
    const input = testSignal(frames, 2);
    const src = path.join(dir, 'mix48k.wav');
    await writeFile(src, encodeWavFloat32(48000, 2, input, frames));

    const events: { phase: string; fraction: number }[] = [];
    const working = await prepareWorkingCopy(src, {
      workingRoot: dir,
      baseName: 'speed',
      onProgress: (p) => events.push(p),
    });
    assert.equal(working.sampleRate, 44100, 'Arbeitskopie läuft bei 44.1 kHz');
    assert.equal(working.channels, 2, 'Arbeitskopie ist Stereo');
    assert.ok(Math.abs(working.frames - Math.round(frames / (48000 / 44100))) <= 2, 'Frame-Anzahl passend zum Ratio');
    assert.equal(working.resampled, true, 'resampled=true bei 48-kHz-Quelle');

    const order = ['fingerprint', 'decode', 'resample', 'encode', 'verify'];
    const firstAt: Record<string, number> = {};
    events.forEach((event, index) => {
      if (!(event.phase in firstAt)) firstAt[event.phase] = index;
    });
    for (const phase of order) {
      assert.ok(phase in firstAt, `Phase "${phase}" wurde gemeldet`);
    }
    for (let i = 1; i < order.length; i++) {
      assert.ok(firstAt[order[i]] > firstAt[order[i - 1]], `Phase "${order[i]}" kommt nach "${order[i - 1]}"`);
    }
    const resampleEvents = events.filter((event) => event.phase === 'resample');
    assert.ok(resampleEvents.length > 3, 'Resampling meldet mehrere Fortschritts-Schritte');
    assert.equal(resampleEvents[resampleEvents.length - 1].fraction, 1, 'Resampling-Fortschritt endet bei 1');
    console.log('  [3] prepareWorkingCopy 48 kHz: 44.1 kHz/Stereo, Phasen-Reihenfolge, Resampling-Fortschritt ✔');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* 4) Abbruch WÄHREND der Arbeitskopie → INFERENCE_CANCELLED ------------------- */
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'airdox-wc-abort-'));
  try {
    const frames = 30 * 48000;
    const input = testSignal(frames, 2);
    const src = path.join(dir, 'mix48k.wav');
    await writeFile(src, encodeWavFloat32(48000, 2, input, frames));

    const token = { cancelled: false };
    let resampleReports = 0;
    let threw: unknown;
    try {
      await prepareWorkingCopy(src, {
        workingRoot: dir,
        baseName: 'abort',
        token,
        onProgress: (p) => {
          if (p.phase === 'resample') {
            resampleReports++;
            // Nach dem zweiten Resampling-Schritt den Abbruch anstoßen.
            if (resampleReports >= 2) token.cancelled = true;
          }
        },
      });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw instanceof StemSeparationError, `Erwartet StemSeparationError, wurde: ${String(threw)}`);
    assert.equal((threw as StemSeparationError).code, 'INFERENCE_CANCELLED', 'Code ist INFERENCE_CANCELLED (kein FAILED)');
    assert.ok(resampleReports >= 2, 'Abbruch greift während des Resamplings, nicht erst danach');
    console.log('  [4] Abbruch über Token während Resampling → INFERENCE_CANCELLED ✔');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* 5) encodeWavFloat32: Fast Path byte-identisch, Kurz-Buffer nullgefüllt ------ */
{
  const data = testSignal(44100 * 2, 2);
  const fast = encodeWavFloat32(44100, 2, data);
  // Legacy-Pfad nachbauen (gleicher Header, per-Sample-Schleife).
  const frameCount = data.length / 2;
  const legacy = new Uint8Array(44 + frameCount * 8);
  const view = new DataView(legacy.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) legacy[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  ascii(36, 'data');
  view.setUint32(4, 36 + legacy.length - 44, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 44100 * 8, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  view.setUint32(40, legacy.length - 44, true);
  for (let i = 0; i < data.length; i++) view.setFloat32(44 + i * 4, data[i], true);
  assert.equal(fast.length, legacy.length, 'Fast Path: gleiche Länge');
  for (let i = 0; i < fast.length; i++) {
    assert.equal(fast[i], legacy[i], `Fast Path byte-identisch (Index ${i})`);
  }

  // Zu kurzer Buffer: Legacy-Semantik (NaN/undefined → 0) bleibt erhalten.
  const short = new Float32Array(4);
  const out = encodeWavFloat32(44100, 2, short, 3);
  assert.equal(out.length, 44 + 3 * 8);
  const tail = out.slice(44 + 4 * 4, 44 + 6 * 4); // Sample 3 (fehlend) muss null sein
  for (const byte of tail) assert.equal(byte, 0, 'Fehlende Samples bleiben nullgefüllt');
  console.log('  [5] encodeWavFloat32: Fast Path byte-identisch, Kurz-Buffer nullgefüllt ✔');
}

/* 6) sha256Bytes: Zero-View über Subarrays ------------------------------------ */
{
  const base = new Uint8Array(1 << 20);
  for (let i = 0; i < base.length; i++) base[i] = (i * 7) & 0xff;
  const sub = base.subarray(1234, 500_000);
  const expect = createHash('sha256').update(Buffer.from(sub.buffer, sub.byteOffset, sub.byteLength)).digest('hex');
  assert.equal(sha256Bytes(sub), expect, 'sha256Bytes hash den View-Bereich (nicht den Gesamtbuffer)');
  assert.equal(sha256Bytes(base), createHash('sha256').update(Buffer.from(base.buffer, 0, base.length)).digest('hex'), 'Vollbuffer unverändert');
  assert.equal(sha256Bytes(new ArrayBuffer(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'ArrayBuffer-Pfad');
  console.log('  [6] sha256Bytes: Zero-View über Subarrays, Digest unverändert ✔');
}

console.log('');
console.log('ARBEITSKOPIE-VERTRÄGE: ALLE BESTANDEN');
