#!/usr/bin/env node
/** Local, reproducible evidence only; never asserts that Google/Colab ran. */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'package.json',
  'scripts/remote-evidence.mjs',
  'scripts/run-tests.mjs',
  'scripts/md-to-notebook.mjs',
  'src/stems/remote/manifest.ts',
  'src/stems/remote/remoteStemJobService.ts',
  'src/stems/remote/diagnostics.ts',
  'src/stems/remote/layout.ts',
  'src/stems/remote/types.ts',
  'src/stems/remote/transport.ts',
  'src/stems/remote/settings.ts',
  'src/stems/transportTypes.ts',
  'src/components/Modals/RemoteFlowModal.tsx',
  'src/components/Modals/RemoteSetupModal.tsx',
  'src/components/DeckStemsControl.tsx',
  'scripts/stem-remote-worker.ts',
  'colab/remote_worker.py',
  'colab/airdox-stem-remote-worker.md',
  'colab/airdox-stem-remote-worker.ipynb',
  'colab/README.md',
  'src/stems/modelCatalog.json',
  'tests/stem-remote-cancel-request-guard.test.ts',
  'tests/stem-remote-job-service.test.ts',
  'tests/stem-remote-manifest-python.test.mjs',
  'tests/stem-remote-worker-selftest.test.mjs',
  // Hält die tatsächlich vom Notebook verwendeten CLI-Optionen fest.
  'tests/stem-remote-worker-cli.test.mjs',
  'tests/stem-remote-manifest.test.ts',
  'tests/stem-remote-setup-config.test.ts',
  'docs/STEM_REMOTE_HQ.md',
  'docs/STEM_REMOTE_NACHWEISKETTE.md',
  'docs/FERN_JOB_LOGDIAGNOSE.md',
];
const out = path.join(root, 'stem-gate-run', 'remote-evidence.json');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const source = Object.fromEntries(files.map((file) => [file, sha256(readFileSync(path.join(root, file)))]));
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
const checks = [
  ['notebook-sync', 'node', ['scripts/md-to-notebook.mjs', 'colab/airdox-stem-remote-worker.md', '--check']],
  ['wait-warning-regression', 'node', ['scripts/run-tests.mjs', '--only', 'stem-remote-job-service', '--serial']],
  ['colab-worker-selftest', 'node', ['scripts/run-tests.mjs', '--only', 'stem-remote-worker-selftest', '--serial']],
  ['remote-protocol-suite', 'npm', ['run', 'test:stems:remote']],
];
const results = [];
for (const [name, command, args] of checks) {
  // Do not save subprocess logs: they may contain local paths or user data.
  const startedAt = Date.now();
  const proc = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    timeout: 300_000,
    shell: process.platform === 'win32',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  results.push({
    name,
    passed: proc.status === 0 && !proc.error,
    exitCode: proc.status,
    error: proc.error?.code ?? null,
    durationMs: Date.now() - startedAt,
  });
}
const report = {
  schemaVersion: 2,
  scope: 'LOCAL_SIMULATION_ONLY',
  googleDriveVerified: false,
  colabVerified: false,
  modelWeightsVerified: false,
  createdAt: new Date().toISOString(),
  gitCommit: git.status === 0 ? git.stdout.trim() : null,
  trackedWorktreeDirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null,
  sourceSha256: source,
  checks: results,
  passed: results.every((result) => result.passed),
};
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(`Local evidence: ${out} (${report.passed ? 'PASS' : 'FAIL'}; Google/Colab NOT verified)`);
if (!report.passed) process.exitCode = 1;
