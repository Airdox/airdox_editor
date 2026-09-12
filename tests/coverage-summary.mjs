/**
 * @license
 * Merged coverage report for BOTH test pipelines (test-only file).
 *
 * The project has two ways to run tests, and each transforms the sources
 * differently:
 *
 *   • `tests/*.test.{ts,mjs}` run through tsx (type-stripping only)
 *   • `tests/ui/**`, `tests/workflow/**` run through vitest + esbuild
 *
 * V8 reports coverage as byte offsets into the *transformed* script. A single
 * `c8 --all` run over both pipelines therefore merges offsets from two
 * different sources for the same URL, which drags per-file numbers below what
 * either pipeline actually reached (measured: `src/rekordbox/xmlParser.ts`
 * 60.96 % via tsx alone, 27.68 % in one merged run).
 *
 * So each pipeline is measured separately and merged per file by taking the
 * better-measured entry — "this many statements provably ran", never the
 * average of two mismatched measurements.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'coverage');
const tmpLegacy = join(outDir, 'tmp-legacy');
const tmpVitest = join(outDir, 'tmp-vitest');

function fresh(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function run(label, command) {
  console.log(`\n▶ ${label}`);
  const res = spawnSync(command, { cwd: root, shell: true, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`✘ ${label} fehlgeschlagen — Coverage-Report unvollständig.`);
    process.exitCode = 1;
  }
}

fresh(outDir);
fresh(tmpLegacy);
fresh(tmpVitest);

// 1. script suites (tsx) — the Rekordbox data pipeline lives here
run(
  'Skript-Suiten (tsx) unter c8',
  `npx c8 --temp-directory=${relative(root, tmpLegacy)} --report-dir=${relative(root, tmpLegacy)} --src=src --all --include='src/**' -r json-summary -r text node tests/run-all.mjs --only=script`
);

// 2. component + workflow suites (vitest, threads pool, jsdom)
run(
  'Komponenten- & Workflow-Suiten (vitest) unter c8',
  `npx c8 --temp-directory=${relative(root, tmpVitest)} --report-dir=${relative(root, tmpVitest)} --src=src --all --include='src/**' -r json-summary -r text npx vitest run --reporter=dot`
);

/** Reads the `content-all` json-summary c8 wrote into a temp dir. */
function readSummary(dir) {
  const file = join(dir, 'coverage-summary.json');
  if (!existsSync(file)) {
    console.error(`✘ ${file} fehlt — diese Pipeline hat keinen Report erzeugt.`);
    return null;
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

const legacy = readSummary(tmpLegacy);
const vitest = readSummary(tmpVitest);
if (!legacy || !vitest) process.exit(1);

/**
 * Merges two json-summary maps. c8's per-file entries carry the metrics at the
 * top level (`{ lines: {total, covered, pct}, … }`), keyed by absolute path.
 */
const METRICS = ['lines', 'statements', 'functions', 'branches'];
const pctOf = (entry, metric) => (entry && entry[metric] ? entry[metric].pct : -1);

function merge(a, b, sourceA, sourceB) {
  const norm = (map) =>
    Object.fromEntries(
      Object.entries(map)
        .filter(([key, entry]) => key !== 'total' && entry && entry.lines)
        // Keys are absolute here; the path under the project root is the form
        // both pipelines agree on.
        .map(([key, entry]) => [relative(root, resolve(root, key.replace(root + '/', ''))), entry])
    );
  const A = norm(a);
  const B = norm(b);
  const out = {};
  const sources = {};
  for (const key of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const entryA = A[key];
    const entryB = B[key];
    // "better measured" = the pass that reached more of the file's lines.
    const useB = entryB && pctOf(entryB, 'lines') > pctOf(entryA, 'lines');
    out[key] = useB ? entryB : entryA;
    sources[key] = useB ? sourceB : sourceA;
  }
  // The headline is recomputed from the chosen rows, so it matches the table.
  const totals = {};
  for (const metric of METRICS) {
    let covered = 0;
    let total = 0;
    for (const entry of Object.values(out)) {
      covered += entry[metric]?.covered ?? 0;
      total += entry[metric]?.total ?? 0;
    }
    totals[metric] = { total, covered, pct: total ? Number(((covered / total) * 100).toFixed(2)) : 100 };
  }
  return { result: out, sources, totals };
}

const merged = merge(legacy, vitest, 'tsx', 'vitest');

const fileEntries = merged.result;
const totalStats = merged.totals;

const rows = Object.entries(fileEntries)
  .map(([file, entry]) => ({
    file: relative(root, file),
    lines: entry.lines.pct,
    statements: entry.statements.pct,
    branches: entry.branches.pct,
    functions: entry.functions.pct,
    source: merged.sources[file],
  }))
  .filter((row) => row.file.startsWith('src'))
  .sort((x, y) => x.file.localeCompare(y.file));

function pad(text, width) {
  return text.length > width ? text.slice(0, width - 1) + '…' : text.padEnd(width);
}

console.log('\n════════════════════════════════════════════════════════════════════════');
console.log('  MERGED COVERAGE (beste Messung pro Datei aus beiden Pipelines)');
console.log('════════════════════════════════════════════════════════════════════════\n');
console.log(`${pad('Datei', 46)} ${pad('Lines', 8)}${pad('Stmts', 8)}${pad('Branch', 8)}${pad('Funcs', 8)}Messung`);
for (const row of rows) {
  console.log(
    `${pad(row.file, 46)} ${pad(String(row.lines.toFixed(1)), 8)}${pad(String(row.statements.toFixed(1)), 8)}${pad(
      String(row.branches.toFixed(1)),
      8
    )}${pad(String(row.functions.toFixed(1)), 8)}${row.source}`
  );
}
console.log(
  `\n${'─'.repeat(90)}`
);
console.log(
  `${pad('All files (src/**)', 46)} ${pad(String(totalStats.lines.pct.toFixed(1)), 8)}${pad(
    String(totalStats.statements.pct.toFixed(1)),
    8
  )}${pad(String(totalStats.branches.pct.toFixed(1)), 8)}${pad(String(totalStats.functions.pct.toFixed(1)), 8)}`
);

const belowTarget = rows.filter((row) => row.lines < 90);
if (belowTarget.length) {
  console.log(`\nUnter 90 % Lines (${belowTarget.length}):`);
  for (const row of belowTarget) console.log(`  ${pad(row.file, 46)} ${row.lines.toFixed(1)} %`);
}

writeFileSync(
  join(outDir, 'coverage-merged.json'),
  JSON.stringify({ total: totalStats, files: rows }, null, 2)
);
console.log(`\n→ ${relative(root, join(outDir, 'coverage-merged.json'))}`);
const strayFiles = readdirSync(tmpLegacy).length + readdirSync(tmpVitest).length;
console.log(`   (Rohdaten: coverage/tmp-legacy + coverage/tmp-vitest, ${strayFiles} V8-Reports)`);
