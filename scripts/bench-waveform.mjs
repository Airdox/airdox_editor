#!/usr/bin/env node
/**
 * airdox_SMART_Editor – Performance-Benchmark für Analyse und Wellenform-Zeichnung.
 *
 * Warum es dieses Skript gibt:
 *   Die Wellenform wird pro Pixel aus der Analyse gesampelt. Ob das schnell
 *   genug ist, war bisher nur Gefühlssache. Dieses Skript erzeugt
 *   reproduzierbare Zahlen (Node, tsx), damit Refaktorisierungen gegen eine
 *   Baseline gemessen werden können statt gegen Erinnerung.
 *
 * Aufrufe:
 *   npx tsx scripts/bench-waveform.mjs              # lesbare Ausgabe
 *   npx tsx scripts/bench-waveform.mjs --json       # Maschinenlesbar (CI)
 *   npx tsx scripts/bench-waveform.mjs --budget     # Exit 1 bei Budgetverletzung
 *
 * Budgets stehen in `budgets.json` (Schlüssel `bench`).
 *
 * Robustheit: Jeder Fall wird `AIRDOX_BENCH_REPEATS`-mal (Standard 5) gemessen,
 * das Budget wird gegen das **Minimum** geprüft. Einzelne Läufe streuen hier um
 * Faktor 2 (JIT-Aufwärmen, GC, CPU-Konkurrenz) – das Minimum ist der stabilste
 * Schätzer für die eigentliche Rechenarbeit und damit die einzige Zahl, die als
 * Regressionstor taugt. Der Median wird zum Vergleich mitausgegeben.
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const checkBudget = args.has('--budget');

/** Anzahl der Wiederholungen pro Messfall (Minimum zählt fürs Budget). */
const REPEATS = Math.max(1, Number(process.env.AIRDOX_BENCH_REPEATS ?? 5) || 5);

/** Minimum und Median einer Messreihe – Median nur zur Information. */
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return { min: sorted[0], median };
}

const { analyzeAudioBuffer } = await import(path.join(ROOT, 'src/waveform/analyzer.ts'));
const { sampleWaveformColumn } = await import(path.join(ROOT, 'src/waveform/spectralColor.ts'));

/** Deterministisches Testsignal (kein Zufall, damit Läufe vergleichbar sind). */
function makeBuffer(seconds, sampleRate = 44100, channels = 2) {
  const length = Math.floor(seconds * sampleRate);
  const data = [];
  for (let c = 0; c < channels; c++) {
    const arr = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      arr[i] = Math.sin(i * 0.01) * 0.6 + Math.sin(i * 0.31) * 0.3;
    }
    data.push(arr);
  }
  return {
    sampleRate,
    numberOfChannels: channels,
    length,
    duration: seconds,
    getChannelData: (channel) => data[channel],
  };
}

/** Eine vollständige Frame-Zeichnung: `columns` Spalten über das sichtbare Fenster. */
function measureColumns(analysis, duration, windowSeconds, columns) {
  const started = performance.now();
  let checksum = 0;
  for (let x = 0; x < columns; x++) {
    const t0 = (x / columns) * windowSeconds;
    const t1 = ((x + 1) / columns) * windowSeconds;
    checksum += sampleWaveformColumn(analysis, t0, t1, duration, { bpm: 128, firstBeat: 0 }).totalAmp;
  }
  return { ms: performance.now() - started, checksum };
}

const results = {};
const columnsFor = (seconds) => [
  `columns18s${seconds}sMs`,
  `columnsFullTrack${seconds}sMs`,
];

for (const seconds of [30, 300]) {
  const buffer = makeBuffer(seconds);
  const analysis = analyzeAudioBuffer(buffer); // Aufwärmlauf, zählt nicht
  results[`analyze${seconds}sBuckets`] = analysis.length;
  // Aufwärmlauf für die Zeichenpfade (JIT) – separat, damit er die Messung nicht verzerrt.
  measureColumns(analysis, buffer.duration, 18, 1920);
  measureColumns(analysis, buffer.duration, buffer.duration, 1920);

  const analyzeSamples = [];
  const windowSamples = [];
  const fullTrackSamples = [];
  for (let run = 0; run < REPEATS; run++) {
    const analyzeStart = performance.now();
    analyzeAudioBuffer(buffer);
    analyzeSamples.push(performance.now() - analyzeStart);

    windowSamples.push(measureColumns(analysis, buffer.duration, 18, 1920).ms);
    fullTrackSamples.push(measureColumns(analysis, buffer.duration, buffer.duration, 1920).ms);
  }

  const analyze = summarize(analyzeSamples);
  const window18s = summarize(windowSamples);
  const fullTrack = summarize(fullTrackSamples);

  results[`analyze${seconds}sMs`] = Number(analyze.min.toFixed(2));
  results[`analyze${seconds}sMedianMs`] = Number(analyze.median.toFixed(2));
  results[columnsFor(seconds)[0]] = Number(window18s.min.toFixed(3));
  results[`columns18s${seconds}sMedianMs`] = Number(window18s.median.toFixed(3));
  results[columnsFor(seconds)[1]] = Number(fullTrack.min.toFixed(3));
  results[`columnsFullTrack${seconds}sMedianMs`] = Number(fullTrack.median.toFixed(3));
}

const budgetsPath = path.join(ROOT, 'budgets.json');
let violations = [];
if (asJson || checkBudget) {
  let budgets = { bench: {} };
  try {
    budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'));
  } catch {
    /* ohne Budgets nur messen */
  }
  const bench = budgets.bench ?? {};
  violations = Object.entries(bench)
    .filter(([key, limit]) => typeof results[key] === 'number' && results[key] > limit)
    .map(([key, limit]) => `${key}: ${results[key]} > ${limit}`);
}

if (asJson) {
  process.stdout.write(JSON.stringify({ measuredAt: new Date().toISOString(), results, violations }, null, 2) + '\n');
} else {
  console.log(`Benchmark (Node + tsx, deterministisches Signal, Minimum aus ${REPEATS} Läufen)`);
  console.log(`  analyzeAudioBuffer(30 s)          : ${results['analyze30sMs']} ms  (Median ${results['analyze30sMedianMs']} ms, ${results['analyze30sBuckets']} Buckets)`);
  console.log(`  analyzeAudioBuffer(300 s)         : ${results['analyze300sMs']} ms  (Median ${results['analyze300sMedianMs']} ms, ${results['analyze300sBuckets']} Buckets)`);
  console.log(`  1920 Spalten, 18-s-Fenster (30 s) : ${results['columns18s30sMs']} ms  (Median ${results['columns18s30sMedianMs']} ms)`);
  console.log(`  1920 Spalten, Full-Track (300 s)  : ${results['columnsFullTrack300sMs']} ms  (Median ${results['columnsFullTrack300sMedianMs']} ms)`);
  if (violations.length > 0) {
    console.error('\nBudgetverletzungen:');
    for (const violation of violations) console.error(`  - ${violation}`);
  }
}

if (checkBudget && violations.length > 0) {
  process.exit(1);
}
