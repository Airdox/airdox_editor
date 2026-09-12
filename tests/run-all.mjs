/**
 * @license
 * One runner for every test style in this repository.
 *
 * - `tests/*.test.ts` / `tests/*.test.mjs`  → executed as standalone scripts (tsx loader)
 * - `tests/ui/**`, `tests/workflow/**`      → executed by vitest (jsdom, coverage)
 *
 * Auto-discovery is deliberate: a test file that nobody listed in package.json
 * still runs, so the coverage goal cannot silently miss a module. `npm run
 * coverage` wraps THIS file, so both styles are measured in one V8 coverage run.
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Which directories vitest owns is read out of vitest.config.ts (`test.include`
 * globs) — the runner, the coverage merge and the registry guard therefore
 * share one source of truth and cannot drift apart. Support directories that
 * hold no suites of their own are skipped as well, so nothing is run twice.
 */
const SUPPORT_DIRS = new Set(['helpers', 'setup', 'fixtures']);

function vitestOwnedDirs() {
  const configPath = join(root, 'vitest.config.ts');
  if (!existsSync(configPath)) return [];
  const config = readFileSync(configPath, 'utf8');
  return [...config.matchAll(/'(tests\/[^']+?)\/\*\*/g)].map((m) => m[1].replace(/^tests\//, ''));
}

const VITEST_OWNED = new Set([...vitestOwnedDirs(), ...SUPPORT_DIRS]);

function walk(dir, filter, acc = []) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) {
      if (dir === 'tests' && VITEST_OWNED.has(entry)) continue;
      walk(relative(root, full), filter, acc);
    } else if (filter(entry)) acc.push(relative(root, full));
  }
  return acc;
}

const scriptTests = walk('tests', (name) => /\.test\.(ts|mts|mjs)$/.test(name)).sort();
const vitestDirs = vitestOwnedDirs().map((dir) => `tests/${dir}`);
const hasVitest = vitestDirs.some((dir) =>
  existsSync(join(root, dir)) && readdirSync(join(root, dir)).some((f) => /\.test\.tsx?$/.test(f))
);

// `--list` prints what would run and exits — the registry guard uses it to check
// discovery without starting 25+ suites.
if (process.argv.includes('--list')) {
  console.log(JSON.stringify({ scriptTests, vitestDirs, hasVitest }, null, 2));
  process.exit(0);
}

const results = [];
const started = Date.now();

function run(label, args, opts = {}) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: opts.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: opts.capture ? 'utf8' : undefined,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const ok = res.status === 0;
  results.push({ label, ok, ms });
  if (!ok && opts.capture) {
    console.log(`\n--- ${label} failed ---`);
    console.log((res.stdout || '') + (res.stderr || ''));
  }
  return ok;
}

function runShell(command) {
  const t0 = Date.now();
  const res = spawnSync(command, { cwd: root, shell: true, stdio: 'inherit' });
  const ok = res.status === 0;
  results.push({ label: command, ok, ms: Date.now() - t0 });
  return ok;
}

// `--only=script` / `--only=vitest` selects one pipeline; `tests/coverage-summary.mjs`
// uses them to measure each pipeline on its own (mixed transpilers corrupt the
// byte offsets of a merged V8 report).
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : 'all';
if (only !== 'all' && only !== 'script' && only !== 'vitest') {
  console.error(`Unbekanntes --only=${only} (erlaubt: script | vitest | all)`);
  process.exit(2);
}

if (only === 'all' || only === 'script') {
console.log(`\n▶ ${scriptTests.length} Skript-Suiten (tsx)\n`);
for (const file of scriptTests) {
  const useTsx = file.endsWith('.ts') && !file.endsWith('.mjs');
  const args = useTsx ? ['--import', 'tsx', file] : [file];
  run(file, args);
}
}

if (hasVitest && (only === 'all' || only === 'vitest')) {
  console.log(`\n▶ vitest (Komponenten- & Workflow-Suiten)\n`);
  const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
  runShell(`${existsSync(bin) ? `node ${join(root, 'node_modules', 'vitest', 'vitest.mjs')}` : 'npx vitest'} run --reporter=dot`);
}

const failed = results.filter((r) => !r.ok);
const total = results.length;
console.log('\n' + '═'.repeat(74));
console.log(`  RUN-ALL  •  ${total - failed.length}/${total} Suiten grün  •  ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (failed.length) {
  console.log('  Fehlende/fehlgeschlagene Suiten:');
  for (const f of failed) console.log(`    ✗ ${f.label}`);
}
console.log('═'.repeat(74) + '\n');
process.exit(failed.length ? 1 : 0);
