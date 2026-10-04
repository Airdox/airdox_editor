// @requires: python
/**
 * FERNWORKER-Selbsttest (Colab/Node-Ablage) – hier läuft `colab/remote_worker.py --self-test`.
 *
 * Warum als eigener Test und nicht nur als npm-Skript: der Worker ist die eine
 * Hälfte des externen Pfads, die nie im Editor startet. Sein Abbruchverhalten
 * war genau das, was Nutzer als „ich drücke Abbrechen und es passiert nichts“
 * erleben – die `cancel.flag` wurde nur **vor** dem Start eines Jobs gesehen,
 * nicht während der (minutes- bis stundenlangen) Rechnung. Der Selbsttest prüft
 * beides, ohne Torch/GPU:
 *
 *   5 · Abbruch vor dem Start ⇒ `CANCELLED`, Fahne ist danach verbraucht
 *   6 · Watchdog: Fahne erscheint im Lauf ⇒ Kindprozess wird beendet
 *   8 · End-to-End: ein langsam rechnender Adapter wird mitten im Lauf
 *       gestoppt, das Manifest endet `CANCELLED`, es liegen keine Ergebnisse
 *
 * Ein Weglassen dieses Tests wäre billig: der Job hätte 20 GPU-Minuten weiter
 * gerechnet, nachdem der Nutzer längst abgebrochen hatte.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'colab', 'remote_worker.py');

function runCandidate(command, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: ROOT,
        windowsHide: true,
        // Redirected Python output can use the Windows ANSI code page; Node
        // decodes captured child output as UTF-8, so make the test protocol
        // encoding explicit on every platform.
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ spawned: false, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* schon weg */
      }
      resolve({ spawned: true, code: null, out, reason: `Zeitüberschreitung nach ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ spawned: false, reason: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ spawned: true, code, out });
    });
  });
}

/** Dieselbe Kandidatenreihenfolge wie `scripts/run-tests.mjs` (venv zuerst). */
function pythonCandidates() {
  const fromEnv = process.env.PYTHON || process.env.AIRODOX_PYTHON;
  const venv = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
  return [fromEnv, existsSync(venv) ? venv : null, 'python3', 'python'].filter(Boolean);
}

assert.ok(existsSync(WORKER), `Fernworker fehlt: ${WORKER}`);

let result = null;
let tried = [];
for (const candidate of pythonCandidates()) {
  tried.push(candidate);
  const attempt = await runCandidate(candidate, [WORKER, '--self-test']);
  if (attempt.spawned && attempt.code === 0) {
    result = { ...attempt, python: candidate };
    break;
  }
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  FERNWORKER (colab/remote_worker.py) – PROTOKOLL- UND ABBRUCHSELBSTTEST');
console.log('═══════════════════════════════════════════════════════════════════');

assert.ok(result, `Kein Python gefunden (versucht: ${tried.join(', ')})`);
assert.equal(
  result.code,
  0,
  `Der Selbsttest des Fernworkers lief nicht durch (${result.python} – ${result.reason ?? `Exit ${result.code}`}):\n${result.out}`
);
assert.match(result.out, /Selbsttest OK/, `Der Selbsttest meldet kein OK:\n${result.out}`);
for (const marker of ['abgebrochen (cancel.flag)', 'während der Rechnung']) {
  assert.ok(result.out.includes(marker), `Abbruchpfad nicht ausgeführt – erwartet „${marker}“:\n${result.out}`);
}
console.log(`  ✓ ${result.python} – Manifest, Idempotenz, Vollständigkeit, Lease`);
console.log('  ✓ Abbruch gewinnt: vor dem Start **und** mitten in der Rechnung');
console.log('  ✓ cancel.flag wird verbraucht – ein neuer Lauf im selben Ordner bleibt benutzbar');
