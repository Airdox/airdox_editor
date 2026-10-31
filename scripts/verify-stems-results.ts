import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readWavFile } from '../src/stems/wavIo';

const output = path.resolve(process.argv[2] ?? 'artifacts/stem-workflow-20261030');
const job = JSON.parse(await readFile(path.join(output, 'Separation/real-mix-acceptance/job.json'), 'utf8'));
assert.equal(job.status, 'COMPLETED');
assert.equal(job.cacheHit, false);
assert.equal(job.originalIntegrity.unchanged, true);
const stems = [];
for (const stem of job.stems) {
  const stemPath = path.join(output, 'Separation/real-mix-acceptance', `${stem.id ?? stem.name}.wav`);
  const bytes = await readFile(stemPath);
  const decoded = await readWavFile(stemPath);
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.sampleRate, 44100);
  assert.equal(decoded.frames, stem.frames);
  assert.ok(decoded.data.every(Number.isFinite));
  const rms = Math.sqrt(decoded.data.reduce((sum, value) => sum + value * value, 0) / decoded.data.length);
  assert.ok(rms > 1e-8);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, stem.sha256);
  stems.push({ stemId: stem.id ?? stem.name, path: stemPath, frames: decoded.frames, sampleRate: decoded.sampleRate, rms, sha256, bytes: bytes.length });
  await copyFile(stemPath, path.join(output, `${stem.id ?? stem.name}.wav`));
}
assert.equal(stems.length, 4);
assert.equal(new Set(stems.map(stem => stem.sha256)).size, 4);
await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ passed: true, verifiedAt: new Date().toISOString(), realInference: true, cacheHit: false, durationSeconds: stems[0].frames / 44100, originalIntegrity: job.originalIntegrity, settings: job.settings, timing: job.timing, validation: job.validation, stems }, null, 2));
console.log('PASS: four fresh real SCNet outputs, stereo/44.1kHz, finite/non-silent/distinct, exact SHA256 match, unchanged original.');
