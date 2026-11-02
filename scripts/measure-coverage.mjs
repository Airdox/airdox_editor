/** Bounded all-source c8 capture. c8 is supplied from an external TEMP prefix.
 * node scripts/measure-coverage.mjs --c8-prefix <prefix>
 * Snapshot evidence, not a certification of a concurrently changing checkout.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = file => path.relative(root, file).split(path.sep).join('/');
const write = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const tests = [
  ['tests/stem-top200-batch.test.ts', 180000],
  ['tests/stem-top200-convert.test.ts', 90000],
  ['tests/stem-top200-worker.test.mjs', 60000],
  ['tests/xml-file-update.test.ts', 90000],
  ['tests/xml-analysis-cache.test.mjs', 60000],
  ['tests/bundled-rekordbox-xml.test.ts', 60000],
  ['tests/large-xml-import.test.ts', 90000],
  ['tests/stem-remote-manifest.test.ts', 60000],
  ['tests/stem-remote-state-machine.test.ts', 60000],
  ['tests/stem-remote-manifest-python.test.mjs', 60000],
  ['tests/stem-engine-ipc-contract.test.ts', 60000],
  ['tests/stem-engine-cold-import.test.ts', 60000],
  ['tests/stem-remote-cancel-request-guard.test.ts', 60000],
  ['tests/stem-remote-data-flow.test.ts', 60000],
];
async function run(command, args, timeoutMs, env = {}) {
  const start = Date.now();
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); resolve({ exitCode: null, error: error.message, output, timedOut, durationMs: Date.now() - start }); });
    child.once('close', exitCode => { clearTimeout(timer); resolve({ exitCode, output, timedOut, durationMs: Date.now() - start }); });
  });
}
if (process.argv.includes('--child')) {
  const directory = process.argv[process.argv.indexOf('--child') + 1];
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < tests.length) {
      const [file, timeoutMs] = tests[cursor++];
      console.log(`START ${file}`);
      // Same tsx CLI as the repository runner; inherited V8 coverage reaches children.
      const args = /\.tsx?$/.test(file) ? [path.join(root, 'node_modules/tsx/dist/cli.mjs'), file] : [file];
      const result = { file, timeoutMs, ...await run(process.execPath, args, timeoutMs, { AIRDOX_TEST_SUITE: '1' }) };
      results.push(result);
      await write(path.join(directory, `coverage-test-${path.basename(file)}.json`), result);
      console.log(`END ${file}: exit=${result.exitCode} timeout=${result.timedOut}`);
    }
  }
  await Promise.all([worker(), worker()]);
  await write(path.join(directory, 'coverage-tests.json'), results);
  process.exitCode = results.some(result => result.exitCode !== 0 || result.timedOut) ? 1 : 0;
} else {
  const prefix = process.argv[process.argv.indexOf('--c8-prefix') + 1];
  if (!process.argv.includes('--c8-prefix') || !prefix) throw new Error('--c8-prefix is required');
  const directory = path.join(root, 'reports', `coverage-snapshot-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const sourceExtensions = /\.(?:[cm]?js|jsx|tsx?|py|cpp|cc|c|hpp|h|ps1|sh)$/i;
  const excluded = file => /(^|\/)(tests?|fixtures|support|node_modules|dist|release|artifacts|output|reports|resources|\.git)\//.test(file) || /\.test\.|\.helper\.|\.d\.ts$/.test(file) || /coverage/i.test(file);
  const list = () => [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  const all = list();
  const sourceFiles = all.filter(file => sourceExtensions.test(file) && !excluded(file));
  const hash = async file => createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  const inventory = await Promise.all(sourceFiles.map(async file => ({ file, sha256Before: await hash(file) })));
  const jsFiles = sourceFiles.filter(file => /\.(?:[cm]?js|jsx|tsx?)$/.test(file));
  const pythonFiles = sourceFiles.filter(file => file.endsWith('.py'));
  await write(path.join(directory, 'coverage-inventory.json'), { startedAt: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), inventory,
    excluded: all.filter(file => sourceExtensions.test(file) && excluded(file)),
    unmeasuredArtifacts: all.filter(file => /\.(ipynb|css|html|cmake)$|(^|\/)CMakeLists\.txt$/.test(file)), jsFiles, pythonFiles, tests });
  const config = JSON.parse(await readFile(path.join(root, 'scripts/project-coverage.c8.json'), 'utf8'));
  Object.assign(config, { include: jsFiles, 'reports-dir': rel(directory), 'temp-directory': rel(path.join(directory, 'coverage-raw')), 'check-coverage': false });
  await write(path.join(directory, 'coverage-c8.json'), config);
  const c8 = path.join(prefix, 'node_modules/c8/bin/c8.js');
  const pkg = JSON.parse(await readFile(path.join(prefix, 'node_modules/c8/package.json'), 'utf8'));
  console.log(`Snapshot ${rel(directory)}, c8 ${pkg.version}, ${jsFiles.length} JS/TS files`);
  // Capture regardless of threshold; report and enforce the numeric gate separately.
  const capture = await run(process.execPath, [c8, '--config', path.join(directory, 'coverage-c8.json'), process.execPath, fileURLToPath(import.meta.url), '--child', directory], 900000);
  await write(path.join(directory, 'coverage-command.json'), { c8Version: pkg.version, ...capture });
  console.log(capture.output);
  const coverage = JSON.parse(await readFile(path.join(directory, 'coverage-final.json'), 'utf8'));
  const summary = JSON.parse(await readFile(path.join(directory, 'coverage-summary.json'), 'utf8'));
  const actual = new Set(Object.keys(coverage).map(file => rel(file)));
  const missing = jsFiles.filter(file => !actual.has(file));
  const unexpected = [...actual].filter(file => !jsFiles.includes(file));
  const unloaded = Object.entries(coverage).filter(([, entry]) => !Object.values(entry.s).some(value => value > 0)).map(([file]) => rel(file));
  const changed = [];
  for (const entry of inventory) {
    entry.sha256After = await hash(entry.file).catch(() => null);
    if (entry.sha256Before !== entry.sha256After) changed.push(entry.file);
  }
  const added = list().filter(file => sourceExtensions.test(file) && !excluded(file) && !sourceFiles.includes(file));
  const rawFiles = (await readdir(path.join(directory, 'coverage-raw'))).filter(file => file.endsWith('.json'));
  const remapped = [];
  for (const file of rawFiles) {
    const data = JSON.parse(await readFile(path.join(directory, 'coverage-raw', file), 'utf8'));
    for (const [url, value] of Object.entries(data['source-map-cache'] ?? {})) {
      if (value?.data?.mappings && url.startsWith('file:')) {
        const filename = rel(fileURLToPath(url));
        if (jsFiles.includes(filename)) remapped.push({ file: filename, sources: value.data.sources });
      }
    }
  }
  const result = { completedAt: new Date().toISOString(), c8Version: pkg.version, sourceFileCount: inventory.length, jsSourceFileCount: jsFiles.length, reportedJsFileCount: actual.size,
    totals: summary.total, missing, unexpected, zeroStatementHitFiles: unloaded, changedDuringCapture: changed, addedDuringCapture: added,
    sourceMapEvidence: [...new Map(remapped.map(item => [item.file, item])).values()], rawFileCount: rawFiles.length,
    wholeProjectCoverage: null, criticalCoverageEstablished: false,
    reason: 'JS c8 aggregate only; Python, native, shell and notebook execution are separate. A bounded subset of tests is not whole-project test completeness.',
    jsNinetyPercentGate: ['lines', 'statements', 'functions', 'branches'].every(metric => summary.total[metric].pct >= 90),
    captureExitCode: capture.exitCode, captureTimedOut: capture.timedOut, inventory };
  await write(path.join(directory, 'coverage-reconciliation.json'), result);
  console.log(JSON.stringify({ directory: rel(directory), ...result, inventory: undefined, zeroStatementHitFiles: unloaded.length, sourceMapEvidence: result.sourceMapEvidence.length }, null, 2));
}
