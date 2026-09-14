'use strict';

// @requires: python, demucs
// Läuft nur mit installierter Demucs-Umgebung (npm run stems:setup).
// Der Test-Runner überspringt diese Datei sonst sauber statt rot.

/**
 * Real-file Demucs acceptance test.
 * Input to production inference: ONE finished mixture.wav only.
 * Optional references are opened strictly after inference for objective scoring.
 */
const assert = require('node:assert/strict');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { separateWav, STEM_NAMES } = require('../electron/demucsRunner.cjs');

function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', 'RIFF WAV expected');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', 'WAVE expected');
  let offset = 12, format, channels, bits, dataOffset, dataLength;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === 'data') { dataOffset = offset + 8; dataLength = size; break; }
    offset += 8 + size + (size & 1);
  }
  assert.ok(dataOffset && dataLength && channels, 'WAV fmt/data chunks expected');
  const bytesPerSample = bits / 8;
  const frames = Math.floor(dataLength / bytesPerSample / channels);
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const at = dataOffset + (i * channels + ch) * bytesPerSample;
      if (format === 1 && bits === 16) sum += view.getInt16(at, true) / 32768;
      else if (format === 1 && bits === 24) {
        let value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
        if (value & 0x800000) value |= 0xff000000;
        sum += value / 8388608;
      } else if (format === 3 && bits === 32) sum += view.getFloat32(at, true);
      else throw new Error(`Unsupported WAV format=${format}, bits=${bits}`);
    }
    mono[i] = sum / channels;
  }
  return mono;
}

function rms(signal) {
  let energy = 0;
  for (const sample of signal) energy += sample * sample;
  return Math.sqrt(energy / Math.max(1, signal.length));
}

function siSdr(estimate, reference) {
  const n = Math.min(estimate.length, reference.length);
  let dot = 0, refEnergy = 0;
  for (let i = 0; i < n; i++) { dot += estimate[i] * reference[i]; refEnergy += reference[i] ** 2; }
  const scale = dot / Math.max(refEnergy, 1e-20);
  let targetEnergy = 0, noiseEnergy = 0;
  for (let i = 0; i < n; i++) {
    const target = scale * reference[i];
    targetEnergy += target * target;
    noiseEnergy += (estimate[i] - target) ** 2;
  }
  return 10 * Math.log10(targetEnergy / Math.max(noiseEnergy, 1e-20));
}

async function run() {
  const mixPath = process.env.STEM_BENCHMARK_MIX;
  assert.ok(mixPath, 'Set STEM_BENCHMARK_MIX to a finished stereo song mix (WAV).');
  const outputDir = path.resolve(process.env.STEM_BENCHMARK_OUTPUT || 'stem-test-output');
  const referenceDir = process.env.STEM_BENCHMARK_REFERENCES;
  const mix = await readFile(path.resolve(mixPath));
  const result = await separateWav(mix, { repoRoot: path.join(__dirname, '..') });
  await mkdir(outputDir, { recursive: true });

  const hashes = new Set();
  for (const stem of STEM_NAMES) {
    const bytes = result.stems[stem];
    assert.ok(bytes.length > 44, `${stem}.wav must contain audio`);
    const signal = decodeWav(bytes);
    const level = 20 * Math.log10(Math.max(rms(signal), 1e-12));
    assert.ok(Number.isFinite(level) && level > -80, `${stem} is unexpectedly silent (${level.toFixed(1)} dBFS)`);
    hashes.add(crypto.createHash('sha256').update(bytes).digest('hex'));
    await writeFile(path.join(outputDir, `${stem}.wav`), bytes);
    console.log(`${stem}.wav: ${level.toFixed(1)} dBFS`);

    if (referenceDir) {
      const reference = decodeWav(await readFile(path.join(path.resolve(referenceDir), `${stem}.wav`)));
      const score = siSdr(signal, reference);
      const minimum = Number(process.env.STEM_MIN_SI_SDR || 0);
      console.log(`${stem}: SI-SDR ${score.toFixed(2)} dB (minimum ${minimum} dB)`);
      assert.ok(score >= minimum, `${stem} SI-SDR ${score.toFixed(2)} dB is below ${minimum} dB`);
    }
  }
  assert.equal(hashes.size, 4, 'All four inferred stems must be different files');
  console.log(`PASS: ${result.model} separated one blind song mix into ${outputDir}`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
