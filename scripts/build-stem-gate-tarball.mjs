#!/usr/bin/env node
/**
 * Baut das Archiv für einen **fremden Rechner** (Google Colab, Arbeits-PC mit
 * Netzwerk, CI-Runner mit GPU) – dort, wo diese Sandbox nicht hinreicht:
 * GitHub-Release-Assets (die trainierten Gewichte) sind hier nicht erreichbar,
 * siehe docs/COLAB_STEM_GATE.md.
 *
 * Inhalt = `git ls-files` des aktuellen Stands (ohne node_modules, ohne dist,
 * ohne Ausgaben). Absichtlich **die Quelltexte**, kein Build: der Freigabe-Lauf
 * soll genau den Code messen, der später ausgeliefert wird, und das
 * Setup-Skript muss den Checkpoint gegen `src/stems/modelCatalog.json` prüfen
 * können (das Archiv enthält den Katalog, damit die Hash-Kette vollständig ist).
 *
 *   node scripts/build-stem-gate-tarball.mjs [--out stem-gate-colab.tar.gz]
 *
 * Danach in Colab:
 *   Datei nach Google Drive legen und im Notebook colab/airdox-stem-gate.ipynb
 *   die Zelle „Archiv aus Drive" benutzen – oder `git clone`, falls das Notebook
 *   auf ein erreichbares Repo zugreifen kann.
 *
 * Das Archiv enthält KEINE Gewichte – die lädt das Setup-Skript vor Ort.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = (() => {
  const index = process.argv.indexOf('--out');
  return index >= 0 && process.argv[index + 1] ? path.resolve(ROOT, process.argv[index + 1]) : path.join(ROOT, 'stem-gate-colab.tar.gz');
})();

/** Was der Freigabe-Lauf braucht – enger als das ganze Repo. */
const INCLUDE_DIRS = ['src', 'tests', 'python', 'scripts', 'docs'];
const INCLUDE_FILES = ['package.json', 'package-lock.json', 'tsconfig.json'];
/** Kein Test braucht das; spart Liste und Zeit. */
const EXCLUDE = [
  'tests/fixtures/musdb-falcon69/*.wav', // 5 MB Demucs-Fixture, für BS-RoFormer nicht nötig
  'src/**/*.md',
];

function git(...args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} fehlgeschlagen: ${result.stderr.trim()}`);
  return result.stdout;
}

const tracked = git('ls-files').split('\n').filter(Boolean);
const files = tracked.filter((file) => {
  if (EXCLUDE.some((pattern) => matchGlob(file, pattern))) return false;
  const [top] = file.split('/');
  if (INCLUDE_FILES.includes(file)) return true;
  if (!INCLUDE_DIRS.includes(top)) return false;
  // Testausgaben und Berichte nicht mitnehmen
  if (file.startsWith('tests/fixtures/') && !/bsroformer|backends/.test(file)) return false;
  return true;
});

if (files.length === 0) throw new Error('Keine Dateien gefunden – git ls-files leer?');

mkdirSync(path.dirname(OUT), { recursive: true });
// Umweg über ein Staging-Verzeichnis: so heißt der Wurzelordner im Archiv
// zuverlässig `airdox-editor/` (GNU tar und bsdtar haben unterschiedliche
// Syntax für --transform), und es landen genau die aufgelisteten Dateien hinein.
const stagingParent = mkdtempSync(path.join(tmpdir(), 'airdox-gate-tar-'));
const staging = path.join(stagingParent, 'airdox-editor');
try {
  for (const file of files) {
    const target = path.join(staging, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(ROOT, file), target);
  }
  const tar = spawnSync('tar', ['--create', '--gzip', '--file', OUT, 'airdox-editor'], {
    cwd: stagingParent,
    stdio: 'inherit',
  });
  if (tar.status !== 0) throw new Error('tar fehlgeschlagen');
} finally {
  rmSync(stagingParent, { recursive: true, force: true });
}

const head = git('rev-parse', 'HEAD').trim();
const info = `${path.basename(OUT)}: ${files.length} Dateien, ${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB, Stand ${head}`;
console.log(`\n✓ ${info}`);
console.log(`  Ablage: ${OUT}`);
console.log('  In Colab hochladen (Google Drive) oder direkt dort mit git auschecken.');
console.log(`  WICHTIG: dieser Stand muss der sein, der ausgeliefert wird – der Lauf misst genau diesen Code.`);

/** Minimal-Glob für die Ausschlussliste (* in einem Segment). */
function matchGlob(file, pattern) {
  const source = pattern
    .split('/')
    .map((segment) =>
      segment === '**' ? '.*' : segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    )
    .join('/')
    .replace(/\/\.\.\//g, '/(?:.*/)?');
  return new RegExp(`^${source}$`).test(file);
}
