#!/usr/bin/env node
/**
 * airdox_SMART_Editor – Bundle-Budget-Prüfung.
 *
 * Warum es dieses Skript gibt:
 *   Der Startchunk ist in der Vergangenheit unbemerkt gewachsen (three.js lag
 *   komplett im Startpfad). Dieses Skript liest den Vite-Manifest
 *   (`dist/.vite/manifest.json`) und summiert **nur** den Entry-Chunk plus seine
 *   statischen Imports – Lazy-Chunks (Modals, XML-Sammlung) zählen bewusst
 *   nicht, weil sie erst bei Bedarf geladen werden.
 *
 * Aufruf:
 *   node scripts/check-bundle-budget.mjs            # nach `vite build`
 *   node scripts/check-bundle-budget.mjs --json
 * Budgets: `budgets.json` → `bundle.startGzipKb`, `bundle.startRawKb`.
 */

import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const MANIFEST = path.join(DIST, '.vite', 'manifest.json');

function fail(message) {
  console.error(`Bundle-Budget: ${message}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch {
  fail(`Manifest fehlt (${path.relative(ROOT, MANIFEST)}). Zuerst \`npx vite build\` ausführen.`);
}

const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entryKey) fail('Kein Entry-Chunk im Manifest gefunden.');

/** Sammelt statische Imports rekursiv (dynamische Imports bleiben außen vor). */
function collectStaticChunks(key, seen = new Set()) {
  if (seen.has(key)) return seen;
  seen.add(key);
  const entry = manifest[key];
  for (const imported of entry.imports ?? []) collectStaticChunks(imported, seen);
  return seen;
}

const chunks = [...collectStaticChunks(entryKey)];
let rawBytes = 0;
let gzipBytes = 0;
const rows = [];
for (const key of chunks) {
  const file = path.join(DIST, manifest[key].file);
  const code = readFileSync(file);
  const raw = statSync(file).size;
  const gz = gzipSync(code).byteLength;
  rawBytes += raw;
  gzipBytes += gz;
  rows.push({ chunk: key, file: manifest[key].file, rawKb: raw / 1024, gzipKb: gz / 1024 });
}

const budgets = JSON.parse(readFileSync(path.join(ROOT, 'budgets.json'), 'utf8')).bundle ?? {};
const limits = {
  startGzipKb: budgets.startGzipKb,
  startRawKb: budgets.startRawKb,
};
const measured = { startRawKb: rawBytes / 1024, startGzipKb: gzipBytes / 1024 };

const violations = Object.entries(limits)
  .filter(([key, limit]) => typeof limit === 'number' && measured[key] > limit)
  .map(([key, limit]) => `${key}: ${measured[key].toFixed(1)} > ${limit}`);

if (process.argv.includes('--json')) {
  process.stdout.write(
    JSON.stringify({ entry: entryKey, chunks: rows, measured, limits, violations }, null, 2) + '\n'
  );
} else {
  console.log('Startbundle (Entry + statische Imports, ohne Lazy-Chunks):');
  for (const row of rows.sort((a, b) => b.gzipKb - a.gzipKb)) {
    console.log(`  ${row.gzipKb.toFixed(1).padStart(7)} kB gzip  ${row.rawKb.toFixed(1).padStart(8)} kB roh  ${row.file}`);
  }
  console.log(
    `  Summe: ${measured.startGzipKb.toFixed(1)} kB gzip / ${measured.startRawKb.toFixed(1)} kB roh` +
      `  (Budget: ${limits.startGzipKb} kB gzip / ${limits.startRawKb} kB roh)`
  );
  if (violations.length > 0) {
    console.error('\nBudgetverletzungen:');
    for (const violation of violations) console.error(`  - ${violation}`);
  }
}

if (violations.length > 0) process.exit(1);
