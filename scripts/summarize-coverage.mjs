/** Reconcile the retained c8/Python evidence and write a human-readable snapshot. */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(process.argv[2]);
const json = async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
const inventory = await json('coverage-inventory.json');
const js = await json('coverage-reconciliation.json');
const py = await json('coverage-python-reconciliation.json');
const pyData = await json('coverage-python.json');
const tests = await json('coverage-tests.json');
const coverage = await json('coverage-final.json');
const summary = await json('coverage-summary.json');
const relative = name => path.relative(root, name).split(path.sep).join('/');
const byPath = new Map(Object.entries(coverage).map(([name, entry]) => [relative(name), entry]));
const bySummary = new Map(Object.entries(summary).filter(([name]) => name !== 'total').map(([name, entry]) => [relative(name), entry]));
const loaded = new Set();
for (const rawName of await readdir(path.join(directory, 'coverage-raw'))) {
  if (!rawName.endsWith('.json')) continue;
  const raw = JSON.parse(await readFile(path.join(directory, 'coverage-raw', rawName), 'utf8'));
  for (const entry of raw.result ?? []) {
    if (entry.url.startsWith('file:')) loaded.add(relative(fileURLToPath(entry.url)));
  }
}
const neverLoaded = inventory.jsFiles.filter(file => !loaded.has(file));
const neverLoadedWithoutZeroEntry = neverLoaded.filter(file => !byPath.has(file) || Object.values(byPath.get(file).s).some(count => count > 0));
const keyFile = 'src/stems/remote/top200Batch.ts';
const keySource = (await readFile(path.join(root, keyFile), 'utf8')).split(/\r?\n/);
const originalLine = keySource.findIndex(line => line.includes('const seen = new Set')) + 1;
const keyEntry = byPath.get(keyFile);
const lineHits = Object.entries(keyEntry.statementMap).filter(([, loc]) => loc.start.line <= originalLine && loc.end.line >= originalLine).map(([id]) => keyEntry.s[id]);
const mappingEvidence = js.sourceMapEvidence.find(item => item.file === keyFile);
const sourceMapCheck = { file: keyFile, originalLine, originalText: keySource[originalLine - 1], statementHitCounts: lineHits,
  inlineMapCaptured: Boolean(mappingEvidence), sources: mappingEvidence?.sources,
  passed: Boolean(mappingEvidence) && originalLine > 0 && lineHits.some(count => count > 0) };
const detail = {
  sourceMapCheck, neverLoadedFiles: neverLoaded, neverLoadedWithoutZeroEntry,
  passedTestFiles: tests.filter(test => test.exitCode === 0 && !test.timedOut).map(test => test.file),
  incompleteTestFiles: tests.filter(test => test.exitCode !== 0 || test.timedOut),
  sourceCounts: Object.fromEntries(['.ts', '.tsx', '.mjs', '.cjs', '.py', '.cpp', '.h', '.sh', '.ps1'].map(ext => [ext, inventory.inventory.filter(item => path.extname(item.file) === ext).length])),
};
await writeFile(path.join(directory, 'coverage-validation.json'), JSON.stringify(detail, null, 2) + '\n');
const fraction = (hit, total) => `${hit}/${total} (${(100 * hit / total).toFixed(4)}%)`;
const metric = (value, name) => fraction(value[name].covered, value[name].total);
const critical = ['src/stems/remote/top200Batch.ts', 'src/stems/remote/batchCollection.ts', 'src/features/import/xmlCollectionUpdate.ts', 'electron/analysisRegistry.cjs', 'src/rekordbox/xmlParser.ts', 'src/stems/remote/manifest.ts', 'src/stems/remote/remoteStemJobService.ts', 'src/stems/remote/remoteCancelRequestGuard.ts', 'src/stems/backends/runtimeProbe.ts', 'src/stems/nodeBridge.ts', 'server.ts', 'src/App.tsx'];
const pyCritical = ['colab/top200_batch.py', 'colab/remote_worker.py', 'python/bsroformer_inference.py'];
const lines = [
  '# Numeric coverage snapshot: release gate remains unmet', '',
  `Base HEAD: \`${inventory.revision}\`. JS capture ${inventory.startedAt} to ${js.completedAt}. These are per-runtime snapshots with before/after hashes, not certification of the current changing checkout.`, '',
  '| Runtime and exact scope | Line coverage | Statement coverage | Branch coverage | Function coverage |',
  '|---|---:|---:|---:|---:|',
  `| JS/TS, ${js.reportedJsFileCount} initial-manifest files, c8 ${js.c8Version} --all | ${metric(js.totals, 'lines')} | ${metric(js.totals, 'statements')} | ${metric(js.totals, 'branches')} | ${metric(js.totals, 'functions')} |`,
  `| Python, all ${py.reportedFiles.length} manifest files, coverage.py ${py.coverageVersion}, branch enabled | ${fraction(py.totals.covered_lines, py.totals.num_statements)} | Executable-line measure | ${fraction(py.totals.covered_branches, py.totals.num_branches)} | Not collected |`,
  '| Native: 11 C++/header files | Unmeasured | Unmeasured | Unmeasured | Unmeasured |',
  '| Shell/PowerShell: 9 files | Unmeasured | Unmeasured | Unmeasured | Unmeasured |', '',
  '**Whole-project coverage: unknown. >=90% whole project and 100% critical paths remain unestablished; every measured JS dimension and Python lines/branches is below 90%. No measured percentage in this report represents the whole project.**', '',
  '## Denominators and source-map validation', '',
  `The initial inventory has ${inventory.inventory.length} first-party source files. The exact JS and Python file lists and reviewed-out paths are retained in coverage-inventory.json. Includes src, electron, server.ts, root config code, operational scripts and tools/legacy. Excludes tests/fixtures/support, declaration-only .d.ts, coverage tooling, node_modules, dist/release/artifacts/output, resource/report trees. Notebook cells, HTML, CSS and CMake remain separately listed and unmeasured. Nonignored untracked source existing at inventory time is included. Generated electron/generated/anlzStructure.cjs is conservatively retained; no generated-code exclusion was added to improve results.`, '',
  `JS reconciliation: ${js.jsSourceFileCount} expected and ${js.reportedJsFileCount} reported; missing ${js.missing.length}, unexpected ${js.unexpected.length}. ${neverLoaded.length} source files never appeared in raw V8 script URLs; every one has a zero-hit report entry (violations: ${neverLoadedWithoutZeroEntry.length}). ${js.zeroStatementHitFiles.length} files have zero statement hits overall. These file counts are denominator checks, not coverage percentages.`, '',
  `Retained ${js.rawFileCount} raw V8 profiles and inline source-map evidence for ${js.sourceMapEvidence.length} inventoried files. Original-source smoke check: ${keyFile}:${originalLine}, \`${sourceMapCheck.originalText.trim()}\`, has mapped hit counts ${JSON.stringify(lineHits)} and captured map sources ${JSON.stringify(mappingEvidence?.sources)}; check ${sourceMapCheck.passed ? 'PASSED' : 'FAILED'}. coverage-final.json and lcov.info use original .ts/.tsx paths. Node/tsx children inherited NODE_V8_COVERAGE.`, '',
  'The percentages above are the actual c8/V8-to-Istanbul reporting model, not AST instrumentation. For never-loaded files c8 creates synthetic zero coverage: line/statement units can include comments, blank lines and TypeScript-only declarations, while branch/function placeholders do not enumerate every actual branch/function. Thus do not interpret the branch aggregate as a complete AST branch denominator or a 100% critical-path proof. Preserve these limitations when comparing to another coverage provider. The per-runtime metrics must not be averaged, and c8 line units must not be silently combined with Python executable lines.', '',
  `Python used ${py.executable}, version ${py.python.split(' ')[0]}. Explicit morfs report all ${py.inventoryFiles.length} Python files, including non-package tools/legacy scripts: missing ${py.missingFiles.length}, unexpected ${py.unexpectedFiles.length}. ${Object.values(pyData.files).filter(file => file.summary.covered_lines === 0).length} Python files were entirely unexecuted and contribute full executable-line/branch denominators. The combined coverage.py display ${(py.totals.percent_covered).toFixed(4)}% mixes lines and branches; it is not the Python line percentage shown above.`, '',
  '## Critical-code measurements', '',
  '| JS/TS source | Lines | Branches | Functions |', '|---|---:|---:|---:|',
  ...critical.map(file => { const value = bySummary.get(file); return `| ${file} | ${value ? metric(value, 'lines') : 'Absent from initial snapshot'} | ${value ? metric(value, 'branches') : 'Unmeasured'} | ${value ? metric(value, 'functions') : 'Unmeasured'} |`; }), '',
  '| Python source | Executable lines | Branches |', '|---|---:|---:|',
  ...pyCritical.map(file => { const value = Object.entries(pyData.files).find(([name]) => name.replaceAll('\\', '/') === file)?.[1]?.summary; return `| ${file} | ${fraction(value.covered_lines, value.num_statements)} | ${fraction(value.covered_branches, value.num_branches)} |`; }), '',
  'No selected critical module has complete branch evidence across the full required path. In particular, 100% lines for batchCollection is accompanied by uncovered branches; even a module with 100% synthetic coverage would not prove the cross-runtime scenario matrix.', '',
  '## Test execution and existing behavioral evidence', '',
  `Bounded JS selection: ${detail.passedTestFiles.length} test files passed, ${detail.incompleteTestFiles.length} incomplete. Maximum concurrency two; per-file limits 60-180 seconds; no live GPU or real Top200 batch. This pass count is not coverage.`, '',
  '| Selected test | Result | Seconds |', '|---|---|---:|',
  ...tests.map(test => `| ${test.file} | ${test.timedOut ? 'TIMEOUT / incomplete' : test.exitCode === 0 ? 'PASS' : `FAIL (exit ${test.exitCode})`} | ${(test.durationMs / 1000).toFixed(3)} |`), '',
  'Passing behavior includes Top200 ranking/limit/deduplication, model authority, missing/input-file guards, original integrity, published batch scope, restart without reconversion/duplicate work, checked result import and retry; real ffmpeg working-copy conversion; XML replacement/updated rankings and persisted analysis-cache invalidation; schema/path/idempotency validation; state transitions; TS/Python fixture agreement; IPC contract and a delayed cold-import fake; cancellation request guard. Engines/workers use pipeline doubles or mocked runtimes where specified in the tests. The data-flow suite hit its 60-second bound; its result is incomplete, not a passing suite, and no retry or product fix was made by this audit. No duplicate stem-remote-job-service regression was launched.', '',
  `Python results: ${py.results.map(result => `${result.file} ${result.args.join(' ')} => ${result.exitCode ? 'FAIL' : 'PASS'}`).join('; ')}. The corrected >=0 elapsed-time assertion now passes on the installed Python 3.11 timer. The worker self-test exercises manifest/lease/cancellation before and during inference using a fake adapter and explicitly requires no Torch/GPU. Python stdout was inspected; complete counters and test exit codes are retained.`, '',
  '## Concurrent changes and certification limits', '',
  `Six initial-manifest source files changed during the JS capture: ${js.changedDuringCapture.map(file => `\`${file}\``).join(', ')}. Per-file hashes before and after are in coverage-reconciliation.json. Additional sources appeared after inventory: ${js.addedDuringCapture.map(file => `\`${file}\``).join(', ')}. They are outside this initial 217-file JS denominator and must be included in the next current-checkout run.`, '',
  `Python has its own before/after hashes; changes during its shorter capture: ${py.changedDuringCapture.length ? py.changedDuringCapture.join(', ') : 'none'}. Its starting contents may differ from the earlier JS inventory, especially where the persistent-adapter agent was editing. Selected test files were not frozen or hashed before execution; another agent changed the cold-import test during this work. Interpret the observed passes as execution evidence, not as tests of a pinned committed test tree.`, '',
  'The IPC test can copy/build a temporary node-bridge bundle without source maps. Such bundle execution cannot be credited to original nodeBridge.ts; that source remains in the denominator at zero. Browser renderer/Electron host, server routes, actual Drive sync, persistent trained-model lifecycle, native code and notebook bootstrap have no complete instrumented end-to-end evidence here. Runtime host-test fixes and Python adapter work remain with their owning agents; this audit did not alter them.', '',
  '## Reproduction and next gate', '',
  'c8 10.1.3 was installed into a task-specific OS TEMP prefix using --no-save --package-lock=false --ignore-scripts. Repository package.json and lockfiles were untouched. Raw data, coverage-final.json, coverage-summary.json, lcov.info, logs, hashes and generated c8 config are retained together in this report directory.', '',
  '```powershell',
  "$coveragePrefix = Join-Path $env:TEMP 'airdox-coverage-5e99747-c8-10.1.3'",
  'node scripts/measure-coverage.mjs --c8-prefix $coveragePrefix',
  "& 'C:/Users/p_kro/AppData/Local/Programs/Python/Python311/python.exe' scripts/python-coverage.py <new-report-directory>",
  'node scripts/summarize-coverage.mjs <new-report-directory>', '```', '',
  'The collector disables c8 threshold failure only to retain a baseline. coverage-reconciliation.json explicitly records jsNinetyPercentGate=false and wholeProjectCoverage=null; the child capture exit is 1 because of the timed-out suite, not a green release verdict. The script itself exits successfully when evidence generation succeeds, so it is not a release-gate command.', '',
  'Before the real Top200 run: freeze source/test hashes, reconcile newly added files, complete the data-flow suite with a justified bounded limit, run the broader appropriate non-live suites, and instrument missing runtimes/browser/Electron paths. Keep unloaded source at zero. Adopt explicit denominator definitions (c8 provider vs AST statement instrumentation), per-runtime floors, and a reviewed critical scenario-to-test matrix with all required failure/race/restart paths and representative real-model acceptance evidence. Neither this bounded baseline nor earlier targeted passes meet the user prerequisite.', '',
];
await writeFile(path.join(directory, 'coverage-findings.md'), lines.join('\n'));
console.log(JSON.stringify({ directory: relative(directory), sourceMapCheck, js: js.totals, python: py.totals, neverLoadedFiles: neverLoaded.length, neverLoadedWithoutZeroEntry, testsPassed: detail.passedTestFiles.length, testsIncomplete: detail.incompleteTestFiles.length }, null, 2));
if (!sourceMapCheck.passed || neverLoadedWithoutZeroEntry.length || js.missing.length || js.unexpected.length || py.missingFiles.length || py.unexpectedFiles.length) process.exitCode = 1;
