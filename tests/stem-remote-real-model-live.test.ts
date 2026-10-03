// @manual
// @requires: python, torch, model
// True trained-model inference + Python worker + editor import. No Google/Windows claim.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeHarness, runPython } from './support/remotePythonHarness';

const modelDir = process.env.AIRODOX_STEM_MODEL_DIR;
assert.ok(modelDir, 'AIRODOX_STEM_MODEL_DIR required; no silent skip or synthetic fallback');
const evidence: unknown[] = [];
// 48 kHz deliberately exercises the exact rate seen in the user's log.
for (const rate of [44100, 48000]) {
  const h = await makeHarness(rate, true);
  const started = Date.now();
  try {
    const job = await h.start();
    const log = await runPython(['colab/remote_worker.py', '--root', h.drive, '--model-dir', path.resolve(modelDir),
      '--work-dir', path.join(h.base, 'worker'), '--device', 'cpu', '--once'], 15 * 60_000);
    console.log(log);
    const result = await h.verify(job.jobId);
    evidence.push({ sampleRate: rate, jobId: job.jobId, durationMs: Date.now() - started,
      model: result.modelId, originalSha256: h.before, originalUnchanged: true,
      stems: result.importedStems?.map(({ id, sha256, bytes }) => ({ id, sha256, bytes })), log });
  } finally { await h.dispose(); }
}
await mkdir('stem-gate-run', { recursive: true });
await writeFile('stem-gate-run/remote-real-model-evidence.json', JSON.stringify({
  test: 'real mixed audio -> trained BS-RoFormer -> Python worker -> editor import',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  testedAt: new Date().toISOString(), result: 'PASS', googleDriveTested: false, colabGpuTested: false, windowsUiTested: false,
  evidence,
}, null, 2));
console.log('PASS: real model at 44.1 and 48 kHz; originals unchanged; all four stems imported.');
