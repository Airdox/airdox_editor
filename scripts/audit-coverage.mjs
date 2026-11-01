/** Dependency-free, bounded coverage evidence capture. NOT an Istanbul reporter.
 * node scripts/audit-coverage.mjs [--run]
 * Raw V8 output cannot honestly supply TS statement/branch coverage without a
 * source-map-aware converter. Every in-scope source stays in the inventory.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'reports', 'coverage-audit');
await mkdir(output, { recursive: true });
const startedAt = new Date().toISOString();
const raw = path.join(output, `coverage-raw-${Date.now()}`);
const all = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
const extension = /\.(?:[cm]?js|jsx|tsx?|py|cpp|cc|c|hpp|h|ps1|sh)$/i;
const excluded = file => /(^|\/)(tests?|fixtures|support|node_modules|dist|release|artifacts|output|reports|resources|\.git)\//.test(file) || /\.test\.|\.helper\.|\.d\.ts$/.test(file) || /coverage/i.test(file);
const sourceFiles = all.filter(file => extension.test(file) && !excluded(file));
const inventory = [];
for (const file of sourceFiles) {
  const content = await readFile(path.join(root, file));
  inventory.push({ file, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length,
    physicalLines: content.toString('utf8').split(/\r?\n/).length, observedExecutedByV8: false });
}
const suites = [
  'tests/stem-top200-batch.test.ts',
  'tests/stem-top200-worker.test.mjs',
  'tests/stem-remote-manifest.test.ts',
  'tests/stem-remote-state-machine.test.ts',
];
const results = [];
if (process.argv.includes('--run')) {
  await mkdir(raw, { recursive: true });
  for (const file of suites) {
    console.log(`Coverage capture: ${file}`);
    const start = Date.now();
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [...(/\.tsx?$/.test(file) ? ['--import', 'tsx'] : []), file], {
        cwd: root, windowsHide: true, env: { ...process.env, NODE_V8_COVERAGE: raw, AIRDOX_TEST_SUITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let timedOut = false;
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
      child.on('error', error => { clearTimeout(timer); resolve({ exitCode: null, error: error.message, output, timedOut }); });
      child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, output, timedOut }); });
    });
    results.push({ file, durationMs: Date.now() - start, ...result });
    console.log(`${file}: exit=${result.exitCode}, timeout=${result.timedOut}`);
  }
}
const observed = new Set();
const rawFiles = process.argv.includes('--run') ? (await readdir(raw)).filter(file => file.endsWith('.json')) : [];
for (const name of rawFiles) {
  const data = JSON.parse(await readFile(path.join(raw, name), 'utf8'));
  for (const script of data.result ?? []) {
    if (!script.url.startsWith('file:')) continue;
    const file = path.relative(root, fileURLToPath(script.url)).split(path.sep).join('/');
    if (script.functions.some(fn => fn.ranges.some(range => range.count > 0))) observed.add(file);
  }
}
for (const entry of inventory) entry.observedExecutedByV8 = observed.has(entry.file);
const byExtension = {};
for (const item of inventory) {
  const ext = path.extname(item.file);
  byExtension[ext] ??= { files: 0, observedExecutedFiles: 0 };
  byExtension[ext].files++;
  if (item.observedExecutedByV8) byExtension[ext].observedExecutedFiles++;
}
const changedDuringCapture = [];
for (const item of inventory) {
  const current = createHash('sha256').update(await readFile(path.join(root, item.file))).digest('hex');
  if (current !== item.sha256) changedDuringCapture.push(item.file);
}
const report = {
  startedAt, completedAt: new Date().toISOString(), node: process.version,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  scope: 'All tracked and nonignored untracked first-party JS/TS/Python/C/C++/header/PowerShell/shell source; excludes test/fixture/support trees, declarations, generated/build/resource/report trees and coverage tooling. Includes scripts, tools and root configuration code. Exact denominator candidates are inventory[].file.',
  exclusions: all.filter(file => extension.test(file) && excluded(file)),
  unmeasuredArtifacts: all.filter(file => /\.(ipynb|css|html|cmake)$|(^|\/)CMakeLists\.txt$/.test(file)),
  sourceFileCount: inventory.length, byExtension, changedDuringCapture,
  coverage: { lines: null, statements: null, branches: null, functions: null,
    reason: 'No installed source-map-aware V8-to-Istanbul reporter. File execution observations and physical line counts are NOT coverage. Python/native/browser execution is uninstrumented.' },
  gate: { requiredTotalPercent: 90, requiredCriticalPercent: 100, satisfied: false, status: 'NOT_ESTABLISHED' },
  rawDirectory: process.argv.includes('--run') ? path.relative(root, raw).split(path.sep).join('/') : null,
  rawFileCount: rawFiles.length, results, inventory,
};
await writeFile(path.join(output, 'coverage-baseline.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ sourceFileCount: report.sourceFileCount, byExtension, rawFileCount: rawFiles.length, changedDuringCapture, gate: report.gate }, null, 2));
