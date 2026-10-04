// @requires: python
/**
 * FERNWORKER – KOMMANDOZEILEN-VERTRAG ZWISCHEN NOTEBOOK UND WORKER.
 *
 * Warum dieser Test existiert:
 *   Der Editor zeigt „Wartet auf den externen Rechner (Google Drive)“, solange
 *   kein Worker den Job beansprucht. Genau das kann passieren, obwohl in Colab
 *   alles „durchläuft“ – wenn das Notebook den Worker mit Optionen startet, die
 *   dieser gar nicht kennt. Zwei echte Defekte waren in dieser Lücke:
 *
 *   1. Das Notebook hängt `--model <id>` an, sobald ein Job in der Ablage liegt.
 *      `colab/remote_worker.py` kannte `--model` nicht – argparse akzeptierte es
 *      aber als **Abkürzung von `--model-dir`** und überschrieb damit den
 *      Modellordner mit der Modell-Id. Der Job wurde beansprucht und scheiterte
 *      am fehlenden Checkpoint, statt die Option abzulehnen.
 *   2. `--profile HIGH_QUALITY` (Formularfeld PROFIL) beendete den gesamten Lauf
 *      mit Exit 2: „unrecognized arguments“. Die Zelle endete sofort, niemand
 *      beanspruchte den Job – im Editor passierte schlicht nichts.
 *
 *   Beide Fälle sind hier festgenagelt: Die Zeile, die das Notebook baut, muss
 *   vom Worker akzeptiert werden, `--model` darf den Modellordner nicht
 *   anfassen, und unbekannte Optionen müssen laut abbrechen (nie still
 *   weiterlaufen). Zusätzlich belegt der Test, dass `--check-store` den
 *   Wartezustand benennt – die Diagnose für den Nutzer.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'colab', 'remote_worker.py');
const NOTEBOOK_MD = path.join(ROOT, 'colab', 'airdox-stem-remote-worker.md');

function runCandidate(command, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: ROOT,
        windowsHide: true,
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
assert.ok(existsSync(NOTEBOOK_MD), `Notebook-Quelle fehlt: ${NOTEBOOK_MD}`);

let python = null;
for (const candidate of pythonCandidates()) {
  const attempt = await runCandidate(candidate, [WORKER, '--help']);
  if (attempt.spawned && attempt.code === 0) {
    python = candidate;
    break;
  }
}
assert.ok(python, 'Kein Python gefunden – der Fernworker ist ohne Python nicht prüfbar.');

const help = await runCandidate(python, [WORKER, '--help']);
assert.equal(help.code, 0, `--help muss funktionieren:\n${help.out}`);

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  FERNWORKER (colab/remote_worker.py) – KOMMANDOZEILE & ABLAGE-DIAGNOSE');
console.log('═══════════════════════════════════════════════════════════════════');

// ── 1. Das Notebook darf nur Optionen bauen, die der Worker kennt ────────────
const notebook = readFileSync(NOTEBOOK_MD, 'utf8');
const cell5Code = notebook
  .split('<<<CELL')
  .filter((block) => block.includes('kommando') && block.includes('subprocess.run'))
  .join('\n');
assert.ok(cell5Code.length > 0, 'Zelle 5 (Worker starten) wurde im Notebook nicht gefunden.');
const notebookFlags = [...new Set([...cell5Code.matchAll(/"(--[a-z][a-z0-9-]*)"/g)].map((match) => match[1]))].sort();
assert.ok(notebookFlags.includes('--model') && notebookFlags.includes('--profile'), `Die Notebook-Zelle baut --model/--profile – gefunden: ${notebookFlags.join(', ')}`);
for (const flag of notebookFlags) {
  assert.ok(
    help.out.includes(flag),
    `Das Notebook startet den Worker mit ${flag}, aber der Worker kennt die Option nicht (Hänger „Wartet auf den externen Rechner“):\n${help.out}`
  );
}
console.log(`  ✓ Notebook-Flags sind dem Worker bekannt: ${notebookFlags.join(' ')}`);

// ── 2. `--model` ist ein Filter, niemals ein zweiter Modellordner ────────────
const probe = await runCandidate(python, [
  '-c',
  [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("worker", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'ns = module.parse_args(["--root", "/tmp/x", "--model-dir", "/content/models", "--model", "bsroformer-musdb18hq-4stem-zfturbo", "--profile", "HIGH_QUALITY"])',
    'print("model_dir=" + ns.model_dir)',
    'print("model=" + ns.model)',
    'print("profile=" + ns.profile)',
  ].join('\n'),
  WORKER,
]);
assert.equal(probe.code, 0, `parse_args-Prüfung fehlgeschlagen:\n${probe.out}`);
assert.match(probe.out, /model_dir=\/content\/models/, `--model hat den Modellordner verändert (argparse-Abkürzung!):\n${probe.out}`);
assert.match(probe.out, /model=bsroformer-musdb18hq-4stem-zfturbo/);
assert.match(probe.out, /profile=HIGH_QUALITY/);
console.log('  ✓ --model/--profile ändern den Modellordner nicht');

// ── 3. Unbekannte Optionen brechen laut ab (kein stilles Weiterlaufen) ───────
const tmp = mkdtempSync(path.join(os.tmpdir(), 'airdox-worker-cli-'));
try {
  const unknown = await runCandidate(python, [WORKER, '--root', tmp, '--kind', 'rclone']);
  assert.notEqual(unknown.code, 0, `Eine unbekannte Option darf den Lauf nicht fortsetzen:\n${unknown.out}`);
  assert.match(unknown.out, /unrecognized arguments/, `Die Ablehnung muss den Grund nennen:\n${unknown.out}`);
  console.log('  ✓ unbekannte Option ⇒ Exit ' + unknown.code + ' mit Klartext');

  // ── 4. Die echte Notebook-Zeile läuft (Ablage leer ⇒ 0 Jobs, Exit 0) ───────
  mkdirSync(path.join(tmp, 'jobs'), { recursive: true });
  const notebookCommand = [
    WORKER,
    '--root', tmp,
    '--model-dir', path.join(tmp, 'models'),
    '--adapter', path.join(tmp, 'adapter.py'),
    '--work-dir', path.join(tmp, 'work'),
    '--device', 'auto',
    '--poll', '15',
    '--cancel-poll', '5',
    '--worker', 'colab-cli-test',
    '--model', 'bsroformer-musdb18hq-4stem-zfturbo',
    '--profile', 'HIGH_QUALITY',
    '--max-jobs', '1',
    '--once',
  ];
  const empty = await runCandidate(python, notebookCommand);
  assert.equal(empty.code, 0, `Die Notebook-Zeile muss akzeptiert werden:\n${empty.out}`);
  assert.match(empty.out, /0 Job\(s\) bearbeitet – Ende \(--once\)/, `Kein sauberes Ende:\n${empty.out}`);
  console.log('  ✓ Notebook-Kommandozeile wird akzeptiert und endet sauber');

  // ── 4b. Dieselbe Zeile nimmt einen echten Job an und beendet ihn ──────────
  //     Ein Adapter-Double schreibt vier gültige WAVs – genau das, was der
  //     Editor als COMPLETED erwartet. Damit ist „Wartet auf den externen
  //     Rechner“ nicht nur eine Textaussage, sondern nachweislich überwunden.
  const workJobId = '99999999-8888-4777-8666-555555555555';
  const workJobDir = path.join(tmp, 'jobs', workJobId);
  mkdirSync(path.join(workJobDir, 'input'), { recursive: true });
  const workMix = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4096)]);
  writeFileSync(path.join(workJobDir, 'input', 'mix.wav'), workMix);
  writeFileSync(
    path.join(workJobDir, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        jobId: workJobId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'RUNNING',
        phase: 'Wartet auf den externen Rechner (Google Drive)',
        percent: 0,
        idempotencyKey: 'c'.repeat(64),
        origin: { app: 'airdox_SMART_Editor', version: 'test' },
        input: { fileName: 'mix.wav', relativePath: `jobs/${workJobId}/input/mix.wav`, sha256: 'd'.repeat(64), bytes: workMix.length },
        engine: {
          modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
          profile: 'HIGH_QUALITY',
          family: 'bs_roformer',
          stems: ['vocals', 'drums', 'bass', 'other'],
          stemOrder: ['vocals', 'drums', 'bass', 'other'],
          checkpoint: { file: 'model.ckpt' },
          chunkSizeSamples: 131584,
          numOverlap: 4,
        },
        output: { stems: [] },
      },
      null,
      2
    )}\n`
  );
  // Der Input-Hash im Manifest muss stimmen, sonst lehnt der Worker korrekt ab.
  const manifestPath = path.join(workJobDir, 'manifest.json');
  const stored = JSON.parse(readFileSync(manifestPath, 'utf8'));
  stored.input.sha256 = createHash('sha256').update(workMix).digest('hex');
  writeFileSync(manifestPath, `${JSON.stringify(stored, null, 2)}\n`);

  const adapterPath = path.join(tmp, 'fake_adapter.py');
  writeFileSync(
    adapterPath,
    [
      'import argparse, json, os, wave',
      'parser = argparse.ArgumentParser(allow_abbrev=False)',
      "for name in ('--family', '--checkpoint', '--input', '--output-dir', '--stem-order', '--stems', '--chunk-size', '--num-overlap', '--device', '--config'):",
      '    parser.add_argument(name)',
      'args = parser.parse_args()',
      "print(json.dumps({'type': 'progress', 'fraction': 0.5, 'phase': 'chunk 1'}), flush=True)",
      "for stem in [part for part in (args.stems or '').split(',') if part]:",
      "    with wave.open(os.path.join(args.output_dir, f'{stem}.wav'), 'wb') as handle:",
      '        handle.setnchannels(2)',
      '        handle.setsampwidth(2)',
      '        handle.setframerate(44100)',
      "        handle.writeframes(b'\\x00\\x00' * 256)",
      "print(json.dumps({'type': 'done', 'device': 'cpu', 'durationMs': 12}), flush=True)",
      '',
    ].join('\n')
  );

  const runNotebookLine = (extra = []) =>
    runCandidate(python, [
      WORKER,
      '--root', tmp,
      '--model-dir', path.join(tmp, 'models'),
      '--adapter', adapterPath,
      '--work-dir', path.join(tmp, 'work'),
      '--device', 'cpu',
      '--poll', '5',
      '--cancel-poll', '5',
      '--worker', 'colab-cli-e2e',
      '--model', 'bsroformer-musdb18hq-4stem-zfturbo',
      '--profile', 'HIGH_QUALITY',
      '--max-jobs', '1',
      '--once',
      ...extra,
    ]);
  const worked = await runNotebookLine(['--idle-log-seconds', '0']);
  assert.equal(worked.code, 0, `Der echte Joblauf muss sauber enden:\n${worked.out}`);
  const finished = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(finished.status, 'COMPLETED', `Der Job muss COMPLETED sein:\n${worked.out}\n${JSON.stringify(finished.error ?? {})}`);
  assert.equal((finished.output?.stems ?? []).length, 4, 'Alle vier Stems müssen im Manifest stehen');
  assert.ok(finished.worker?.id === 'colab-cli-e2e', 'Der Worker muss als Rechner im Manifest stehen');
  assert.ok(existsSync(path.join(workJobDir, 'output', 'result.json')), 'result.json fehlt');
  assert.ok(existsSync(path.join(workJobDir, 'claim.json')), 'claim.json fehlt');
  console.log('  ✓ Notebook-Zeile beansprucht den Job und beendet ihn als COMPLETED (4 Stems)');

  // Ein zweiter Lauf darf den fertigen Job nicht erneut rechnen (§19).
  const again = await runNotebookLine();
  assert.match(again.out, /0 Job\(s\) bearbeitet – Ende \(--once\)/, `Fertige Jobs dürfen nicht erneut laufen:\n${again.out}`);
  console.log('  ✓ COMPLETED bleibt COMPLETED – kein zweiter Lauf für denselben Job');

  // ── 5. `--check-store` benennt den Wartezustand und verändert nichts ──────
  const jobId = '11111111-2222-4333-8444-555555555555';
  const jobDir = path.join(tmp, 'jobs', jobId);
  mkdirSync(path.join(jobDir, 'input'), { recursive: true });
  const mix = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2048)]);
  writeFileSync(path.join(jobDir, 'input', 'mix.wav'), mix);
  const manifest = {
    schemaVersion: 1,
    jobId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'RUNNING',
    phase: 'Wartet auf den externen Rechner (Google Drive)',
    percent: 0,
    idempotencyKey: 'a'.repeat(64),
    origin: { app: 'airdox_SMART_Editor', version: 'test' },
    input: { fileName: 'mix.wav', relativePath: `jobs/${jobId}/input/mix.wav`, sha256: 'b'.repeat(64), bytes: mix.length },
    engine: {
      modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
      profile: 'HIGH_QUALITY',
      family: 'bs_roformer',
      stems: ['vocals', 'drums', 'bass', 'other'],
      stemOrder: ['vocals', 'drums', 'bass', 'other'],
      checkpoint: { file: 'model.ckpt' },
      chunkSizeSamples: 131584,
      numOverlap: 4,
    },
    output: { stems: [] },
  };
  writeFileSync(path.join(jobDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const snapshot = () => readdirSync(jobDir, { recursive: true }).sort().join('|');
  const before = snapshot();

  const waiting = await runCandidate(python, [WORKER, '--root', tmp, '--check-store']);
  assert.equal(waiting.code, 0, `--check-store muss auf einer lesbaren Ablage mit 0 enden:\n${waiting.out}`);
  assert.match(waiting.out, new RegExp(jobId), 'Die Diagnose muss den offenen Job nennen');
  assert.match(waiting.out, /ohne Lease/, `Der Wartezustand muss benannt werden:\n${waiting.out}`);
  assert.match(waiting.out, /Wartet auf den externen Rechner/, 'Die Phase des Editors muss sichtbar sein');
  assert.match(waiting.out, /Urteil:/, 'Es muss ein Urteil geben („was ist als Nächstes zu tun“)');
  assert.equal(snapshot(), before, '--check-store darf nichts in der Ablage verändern');
  console.log('  ✓ --check-store: „Wartet auf den externen Rechner“ wird als solches benannt');

  // Frische Lease eines anderen Rechners: der Job ist beansprucht, nicht wartend.
  writeFileSync(
    path.join(jobDir, 'claim.json'),
    JSON.stringify({ id: 'colab-anderer-rechner', host: 'colab', claimedAt: Date.now(), heartbeatAt: Date.now() })
  );
  const claimed = await runCandidate(python, [WORKER, '--root', tmp, '--check-store']);
  assert.match(claimed.out, /frisch beansprucht/, `Beanspruchter Job muss als solcher gemeldet werden:\n${claimed.out}`);
  rmSync(path.join(jobDir, 'claim.json'));

  // Modellfilter: anderer Wert im Formular ⇒ Worker würde überspringen.
  const mismatch = await runCandidate(python, [WORKER, '--root', tmp, '--check-store', '--model', 'ein-anderes-modell']);
  assert.match(mismatch.out, /überspringen/, `Modellfilter muss gemeldet werden:\n${mismatch.out}`);
  assert.match(mismatch.out, /Urteil:.*Modell/, `Das Urteil muss auf den Filter hinweisen:\n${mismatch.out}`);
  rmSync(path.join(jobDir, 'claim.json'), { force: true });
  console.log('  ✓ --check-store erkennt frische Lease, Modellfilter und Abbruchfahne');

  // Abbruchfahne des Editors.
  writeFileSync(path.join(jobDir, 'cancel.flag'), '{}');
  const cancelled = await runCandidate(python, [WORKER, '--root', tmp, '--check-store']);
  assert.match(cancelled.out, /Abbruchfahne: JA/, `Abbruchfahne muss gemeldet werden:\n${cancelled.out}`);
  rmSync(path.join(jobDir, 'cancel.flag'));

  // Fehlende Ablage: eindeutige Ursache statt stillem Warten.
  const missingRoot = path.join(tmp, 'gibt-es-nicht');
  const missing = await runCandidate(python, [WORKER, '--root', missingRoot, '--check-store']);
  assert.equal(missing.code, 1, `Fehlende Ablage muss als Fehler enden:\n${missing.out}`);
  assert.match(missing.out, /existiert nicht/, `Grund muss genannt werden:\n${missing.out}`);
  assert.ok(!existsSync(missingRoot), '--check-store darf keine Ordner anlegen');
  console.log('  ✓ fehlende Ablage ⇒ Exit 1 mit Grund (und ohne Schreiben)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── 6. Das gebaute Notebook passt zur Quelle ─────────────────────────────────
const ipynb = path.join(ROOT, 'colab', 'airdox-stem-remote-worker.ipynb');
if (existsSync(ipynb)) {
  assert.ok(statSync(ipynb).size > 0, 'Das gebaute Notebook ist leer.');
  const parsedNotebook = JSON.parse(readFileSync(ipynb, 'utf8'));
  const sources = parsedNotebook.cells.map((cell) => (Array.isArray(cell.source) ? cell.source.join('') : cell.source || '')).join('\n');
  assert.ok(sources.includes('--check-store'), 'Das gebaute Notebook muss den Vorflug enthalten (npm run stems:remote:notebook).');
  assert.ok(sources.includes('--model'), 'Das gebaute Notebook muss den Modellfilter enthalten.');
  console.log('  ✓ colab/airdox-stem-remote-worker.ipynb passt zur Quelle (.md)');
}

console.log('\n  Ergebnis: die Notebook-Kommandozeile, der Modellfilter und die Ablage-Diagnose sind belegt.');
