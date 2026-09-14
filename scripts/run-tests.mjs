#!/usr/bin/env node
/**
 * airdox_SMART_Editor – zentraler Test-Runner.
 *
 * Warum es dieses Skript gibt:
 *   `npm test` war eine einzelne, von Hand gepflegte `&&`-Kette in package.json.
 *   Jeder Branch, der einen Test hinzufügte, musste genau diese eine Zeile
 *   umschreiben – parallele Branches erzeugten dabei doppelt vorhandene
 *   `"test"`-Schlüssel, also syntaktisch ungültiges JSON. `npm ci` brach dann
 *   in der CI mit einer kryptischen Fehlermeldung ab (verifiziert auf main nach
 *   PR #30/#31). Dieser Runner ersetzt die Kette durch eine Dateisuche:
 *   neue Testdateien brauchen KEINE Änderung an package.json mehr.
 *
 * Entdeckt wird alles unter tests/**:
 *   *.test.ts / *.test.tsx   → `tsx`
 *   *.test.mjs / *.test.cjs  → `node`
 *   (tests/support/**, tests/fixtures/** und *.helper.* laufen nicht mit)
 *
 * Steuerung über Direktiven im Kommentar-Kopf einer Testdatei:
 *   // @requires: python, torch, demucs, model, network
 *     → der Test wird übersprungen (SKIP, kein Fehler), wenn die Umgebung
 *       etwas davon nicht bietet. Erfüllt ein Test seine requirements nicht und
 *       `--fail-on-skip` ist gesetzt, gilt das als Fehler (Freigabe-Läufe).
 *   // @manual
 *     → läuft nie automatisch, nur über --filter/--only explizit aufrufbar.
 *
 * Aufruf:
 *   node scripts/run-tests.mjs                      komplette Suite
 *   node scripts/run-tests.mjs --list               nur Auflistung + SKIP-Gründe
 *   node scripts/run-tests.mjs --filter stem-separation-
 *   node scripts/run-tests.mjs --group stems        Stem-Engine Teil 1 (CI-Suite)
 *   node scripts/run-tests.mjs --group stems --fail-on-skip
 *   node scripts/run-tests.mjs --only file-logger --serial --timeout 120000
 */

import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join(ROOT, 'tests');
/** Ziel für die Ferndiagnose fehlgeschlagener Tests (CI lädt die Datei als Artefakt). */
const FAILURE_REPORT = 'test-runner-failure.txt';

/** Gruppen sind die einzigen Namen, die package.json/CI kennen muss. */
const GROUPS = {
  // Stem-Separations-Engine: Kern, Anbindung und Verträge. Alles reines
  // TypeScript und ohne Python ausführbar (die python-abhängigen Suiten
  // erklären sich über @requires-Direktiven selbst für SKIP).
  stems: (file) =>
    /stem-separation-|stem-isolation-gate|stem-job-service|stem-engine/.test(file) && !/live/.test(file),
  // Die Freigabe-Läufe mit echten Gewichten (Checkpoint + PyTorch nötig). Beide
  // sind ohne installierten Checkpoint ein sauberer SKIP – `test:stems:release`
  // dreht das mit --fail-on-skip um, damit niemand "grün" liest, wo nichts lief.
  // Der Demucs-Real-File-Lauf bleibt über `test:stems:real` adressierbar.
  'stems-live': (file) => /stem-separation-.*live|stem-isolation-gate-live/.test(file),
  // CI-Freigabe: alles, was ohne Spezialumgebung wirklich laufen muss.
  'stems-release': (file) =>
    /stem-separation-|stem-isolation-gate|stem-job-service|stem-engine/.test(file) && !/live/.test(file),
  logging: (file) => /logger/.test(file),
  all: () => true,
};

/**
 * Umgebungsnachweise. Jeder ist billig (<= ein Prozessstart) und wird
 * gecacht, damit 30 Tests nicht 30-mal Python starten.
 */
const probes = new Map();

function cached(key, fn) {
  if (!probes.has(key)) probes.set(key, fn());
  return probes.get(key);
}

function runQuiet(command, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, reason: `Konnte ${command} nicht starten` });
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ ok: false, reason: `Zeitüberschreitung bei ${command}` });
    }, timeoutMs);
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { out += c.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: out.trim() });
    });
  });
}

/** Python-Kandidaten – dieselbe Reihenfolge wie `electron/demucsRunner.cjs`. */
function pythonCandidates() {
  const fromEnv = process.env.AIRODOX_STEM_PYTHON;
  const venv = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
  return [fromEnv, venv, 'python3', 'python'].filter(Boolean);
}

async function findPython() {
  for (const candidate of pythonCandidates()) {
    const probe = await runQuiet(candidate, ['-c', 'import sys; print(sys.version_info[:3])'], 10000);
    if (probe.ok) return candidate;
  }
  return null;
}

const REQUIREMENTS = {
  python: async () => ({ ok: Boolean(await cached('python', findPython)) }),
  torch: async () => {
    const python = await cached('python', findPython);
    if (!python) return { ok: false, reason: 'kein Python gefunden' };
    const probe = await cached('torch', () => runQuiet(python, ['-c', 'import torch'], 30000));
    return probe.ok ? { ok: true } : { ok: false, reason: `${python} kann torch nicht importieren` };
  },
  demucs: async () => {
    const python = await cached('python', findPython);
    if (!python) return { ok: false, reason: 'kein Python gefunden' };
    const probe = await cached('demucs', () => runQuiet(python, ['-c', 'import demucs'], 30000));
    return probe.ok ? { ok: true } : { ok: false, reason: `${python} hat kein demucs installiert` };
  },
  // Derselbe Store wie scripts/setup-bsroformer-model.sh:
  // AIRODOX_STEM_CHECKPOINT_DIR > ${AIRODOX_STEM_HOME:-~/.cache/airdox-stems}/checkpoints
  model: async () => {
    const home = process.env.AIRODOX_STEM_HOME || path.join(os.homedir(), '.cache', 'airdox-stems');
    const dir = process.env.AIRODOX_STEM_MODEL_DIR || process.env.AIRODOX_STEM_CHECKPOINT_DIR || path.join(home, 'checkpoints');
    const checkpoint = process.env.AIRODOX_STEM_CHECKPOINT || 'model_bs_roformer_ep_17_sdr_9.6568.ckpt';
    return existsSync(path.join(dir, checkpoint))
      ? { ok: true }
      : { ok: false, reason: `Checkpoint fehlt in ${dir} (erwartet: ${checkpoint}; Setup: npm run stems:setup:bsroformer)` };
  },
  network: async () => {
    const result = await cached('network', () => new Promise((resolve) => {
      const socket = net.connect({ host: 'registry.npmjs.org', port: 443 });
      const done = (ok) => { socket.destroy(); resolve({ ok }); };
      socket.setTimeout(4000);
      socket.on('connect', () => done(true));
      socket.on('timeout', () => done(false));
      socket.on('error', () => done(false));
    }));
    return result;
  },
};

const SKIP_MARKERS = {
  python: 'Python (npm run stems:setup)',
  torch: 'PyTorch im venv',
  demucs: 'Demucs-Paket',
  model: 'trainierten BS-RoFormer-Checkpoint',
  network: 'Netzwerkzugriff',
};

/** Liest die Direktiven aus den ersten 60 Zeilen der Testdatei. */
async function readDirectives(file) {
  const text = await readFile(path.join(ROOT, file), 'utf8').catch(() => '');
  const head = text.split('\n').slice(0, 60).join('\n');
  const requires = [];
  const directive = /@requires:\s*([a-z, _-]+)/i.exec(head);
  if (directive) {
    for (const name of directive[1].split(',')) {
      const key = name.trim().toLowerCase();
      if (key && key !== 'none') requires.push(key);
    }
  }
  return { requires, manual: /@manual\b/i.test(head) };
}

async function collectTestFiles() {
  const found = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'fixtures' || entry.name === 'support' || entry.name === 'node_modules') continue;
        await walk(absolute);
        continue;
      }
      const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
      if (!/\.test\.(ts|tsx|mjs|cjs)$/.test(entry.name)) continue;
      if (entry.name.includes('.helper.')) continue;
      found.push(relative);
    }
  };
  await walk(TESTS_DIR);
  found.sort();
  return found;
}

function parseArgs(argv) {
  const options = {
    filters: [],
    excludes: [],
    groups: [],
    only: [],
    list: false,
    serial: false,
    failOnSkip: false,
    /** Umgebungsvariablen für die Kindprozesse (--set-env KEY=WERT). */
    env: {},
    includeManual: false,
    jobs: Math.max(1, Math.min(8, os.cpus().length - 1 || 1)),
    timeoutMs: 30 * 60 * 1000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--filter' || arg === '--exclude' || arg === '--group' || arg === '--only' || arg === '--jobs' || arg === '--timeout') {
      const value = next();
      if (value === undefined) throw new Error(`${arg} benötigt einen Wert`);
      if (arg === '--filter') options.filters.push(value);
      else if (arg === '--exclude') options.excludes.push(value);
      else if (arg === '--group') {
        if (!GROUPS[value]) throw new Error(`Unbekannte Gruppe "${value}". Verfügbar: ${Object.keys(GROUPS).join(', ')}`);
        options.groups.push(value);
      } else if (arg === '--only') options.only.push(value);
      else if (arg === '--jobs') options.jobs = Math.max(1, Number.parseInt(value, 10) || 1);
      else options.timeoutMs = Math.max(1000, Number.parseInt(value, 10) || options.timeoutMs);
      continue;
    }
    if (arg === '--list') { options.list = true; continue; }
    if (arg === '--serial') { options.serial = true; continue; }
    if (arg === '--fail-on-skip') { options.failOnSkip = true; continue; }
    if (arg === '--set-env') {
      const value = next();
      const split = value ? value.indexOf('=') : -1;
      if (split <= 0) throw new Error('--set-env erwartet KEY=WERT');
      // Anführungszeichen abnehmen: `npm run … -- --set-env 'A=b'` liefert sie auf
      // Windows über cmd mit, auf Unix nicht – der Wert soll überall gleich sein.
      const unquote = (text) => text.replace(/^['"]|['"]$/g, '');
      options.env[unquote(value.slice(0, split))] = unquote(value.slice(split + 1));
      continue;
    }
    if (arg === '--include-manual') { options.includeManual = true; continue; }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Verwendung: node scripts/run-tests.mjs [Optionen]\n' +
        `  --filter <substr>   nur Tests, deren Pfad den Text enthält (wiederholbar)\n` +
        `  --exclude <substr>  Tests ausschließen (wiederholbar)\n` +
        `  --group <name>      vorgegebene Auswahl: ${Object.keys(GROUPS).join(', ')}\n` +
        `  --only <substr>     wie --filter, ignoriert --manual\n` +
        `  --list              nur Auflistung samt SKIP-Gründen\n` +
        `  --serial            ein Test nach dem anderen\n` +
        `  --jobs <n>          Parallelität (Default ${Math.max(1, os.cpus().length - 1)})\n` +
        `  --timeout <ms>      Abbruchzeit je Test (Default ${30 * 60 * 1000})\n` +
        `  --fail-on-skip      ein SKIP gilt als Fehler (Freigabe-Läufe)\n` +
        `  --set-env KEY=WERT  Umgebung für die Tests (wiederholbar) – plattformneutral,\n` +
        `                      weil 'KEY=WERT cmd' unter Windows-cmd nicht funktioniert\n`
      );
      process.exit(0);
    }
    if (!arg.startsWith('-')) { options.filters.push(arg); continue; }
    throw new Error(`Unbekannte Option "${arg}" (--help zeigt die Liste)`);
  }
  if (options.only.length) {
    options.filters.push(...options.only);
    options.includeManual = true;
  }
  if (options.serial) options.jobs = 1;
  return options;
}

function selectFiles(files, options) {
  const groups = options.groups.length ? options.groups : null;
  return files.filter((file) => {
    if (groups && !groups.some((group) => GROUPS[group](file))) return false;
    if (options.filters.length && !options.filters.some((needle) => file.includes(needle))) return false;
    if (options.excludes.some((needle) => file.includes(needle))) return false;
    return true;
  });
}

/**
 * `.ts`/`.tsx` laufen über das lokale `tsx` (dasselbe Tool, das die alten
 * package.json-Ketten benutzt haben), `.mjs`/`.cjs` direkt über node.
 */
function commandFor(file) {
  const isTs = /\.tsx?$/.test(file);
  const tsxEntry = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!isTs) return { command: process.execPath, args: [path.join(ROOT, file)] };
  if (existsSync(tsxEntry)) return { command: process.execPath, args: [tsxEntry, path.join(ROOT, file)] };
  return { command: path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx'), args: [path.join(ROOT, file)] };
}

function runTest(file, timeoutMs, extraEnv = {}) {
  const { command, args } = commandFor(file);
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd: ROOT,
        windowsHide: true,
        env: { ...process.env, ...extraEnv, AIRDOX_TEST_SUITE: '1', NODE_OPTIONS: process.env.NODE_OPTIONS || '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ file, ok: false, durationMs: 0, output: `Konnte den Test nicht starten: ${error.message}` });
      return;
    }
    let output = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    const capture = (stream) => stream.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 200_000) output = `${output.slice(0, 200_000)}\n… (Ausgabe gekürzt)`;
    });
    capture(child.stdout);
    capture(child.stderr);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ file, ok: false, durationMs: Date.now() - started, output: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        file,
        ok: code === 0,
        durationMs: Date.now() - started,
        output,
        timedOut: signal === 'SIGKILL' && code !== 0,
      });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = selectFiles(await collectTestFiles(), options);
  if (!files.length) {
    console.error('Keine Tests gefunden. `--list` zeigt die Auswahl, `--help` die Optionen.');
    process.exit(1);
  }

  /** @type {{file: string, requires: string[], manual: boolean, skip?: string}[]} */
  const plan = [];
  for (const file of files) {
    const directives = await readDirectives(file);
    const entry = { file, requires: directives.requires, manual: directives.manual };
    if (directives.manual && !options.includeManual) {
      entry.skip = 'markiert mit @manual (nur explizit ausführen)';
    } else {
      for (const requirement of directives.requires) {
        const probe = REQUIREMENTS[requirement];
        if (!probe) {
          entry.skip = `unbekannte Requirement-Direktive "${requirement}"`;
          break;
        }
        const result = await probe();
        if (!result.ok) {
          entry.skip = `${SKIP_MARKERS[requirement] ?? requirement} fehlt${result.reason ? ` (${result.reason})` : ''}`;
          break;
        }
      }
    }
    plan.push(entry);
  }

  if (options.list) {
    for (const entry of plan) {
      console.log(`${entry.skip ? 'SKIP' : 'RUN '}  ${entry.file}${entry.skip ? `  ← ${entry.skip}` : ''}`);
    }
    console.log(`\n${plan.filter((e) => !e.skip).length} von ${plan.length} Tests ausführbar.`);
    return;
  }

  const queue = plan.filter((entry) => !entry.skip);
  const skipped = plan.filter((entry) => entry.skip);
  const results = [];
  let index = 0;
  const width = String(queue.length).length;

  const worker = async () => {
    while (index < queue.length) {
      const current = index++;
      const entry = queue[current];
      const label = `[${String(current + 1).padStart(width, '0')}/${String(queue.length).padStart(width, '0')}]`;
      process.stdout.write(`${label} … ${entry.file}\n`);
      const result = await runTest(entry.file, options.timeoutMs, options.env);
      results.push(result);
      const seconds = (result.durationMs / 1000).toFixed(1);
      if (result.ok) {
        process.stdout.write(`${label} ok   ${entry.file} (${seconds}s)\n`);
      } else {
        process.stdout.write(`${label} FEHLER ${entry.file} (${seconds}s)${result.timedOut ? ' – Zeitüberschreitung' : ''}\n`);
        const tail = result.output.trim().split('\n').slice(-40).join('\n');
        process.stdout.write(`${tail.split('\n').map((line) => `      ${line}`).join('\n')}\n`);
      }
    }
  };

  const startedAt = Date.now();
  const concurrency = Math.max(1, Math.min(options.jobs, queue.length));
  await Promise.all(Array.from({ length: concurrency }, worker));

  const failed = results.filter((result) => !result.ok);
  console.log('\n────────────────────────────────────────────────────────────');
  for (const entry of skipped) console.log(`  SKIP  ${entry.file}  ← ${entry.skip}`);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `  ${results.length - failed.length}/${results.length} Tests bestanden, ` +
    `${skipped.length} übersprungen, ${failed.length} fehlgeschlagen  (${seconds}s, ${concurrency} parallel)`
  );
  console.log('────────────────────────────────────────────────────────────');

  if (failed.length) {
    // Ferndiagnose: Auf CI-Runnern hängen die Job-Logs an einem externen
    // Blob-Storage, das nicht in jeder Umgebung erreichbar ist (bei uns
    // SSL_ERROR_SYSCALL). Deshalb landet die vollständige Ausgabe der
    // fehlgeschlagenen Tests als Datei im Arbeitsverzeichnis, und der Workflow
    // lädt sie als Artefakt hoch.
    const report = failed
      .map((result) => `===== ${result.file} =====\n${result.output.trim() || '(keine Ausgabe)'}\n`)
      .join('\n');
    await writeFile(path.join(ROOT, FAILURE_REPORT), `Test-Runner: ${failed.length} von ${results.length} fehlgeschlagen\n${report}`);
    console.log(`\nVollständige Ausgabe der Fehlschläge: ${FAILURE_REPORT}`);
    process.exit(1);
  }
  if (skipped.length && options.failOnSkip) {
    console.error(`\n${skipped.length} Test(s) wurden übersprungen – bei --fail-on-skip ist das ein Fehler.`);
    process.exit(1);
  }
}

// Importiert (z. B. vom Test der dieses Skript selbst prüft) → nur Exports,
// kein Lauf. Gestartet über `node scripts/run-tests.mjs` → Suite ausführen.
export { collectTestFiles, readDirectives, GROUPS, parseArgs, selectFiles, main };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
