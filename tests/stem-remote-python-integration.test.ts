// @requires: python
// Real editor service + Python worker + explicit DSP fixture (NOT a model test).
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { makeHarness } from './support/remotePythonHarness';

async function scenario(name: string, test: (h: Awaited<ReturnType<typeof makeHarness>>) => Promise<void>) {
  const h = await makeHarness();
  try { await test(h); console.log(`PASS: ${name}`); } finally { await h.dispose(); }
}
await scenario('editor -> Python -> four FLOAT stems -> persistent import; idempotency', async h => {
  const job = await h.start();
  assert.equal((await h.start()).jobId, job.jobId);
  console.log(await h.worker());
  await h.verify(job.jobId);
  assert.equal((await h.start()).jobId, job.jobId);
});
await scenario('restart imports completed Python job', async h => {
  const job = await h.start();
  await h.worker();
  await h.restart();
  await h.verify(job.jobId);
});
await scenario('late Drive output is retried, not discarded', async h => {
  const job = await h.start();
  await h.worker();
  const file = path.join(h.drive, 'jobs', job.jobId, 'output', 'bass.wav');
  const bytes = await readFile(file);
  await rm(file);
  assert.equal((await h.remote.poll()).jobs[0].status, 'VALIDATING');
  await writeFile(file, bytes);
  await h.verify(job.jobId);
});
await scenario('missing results have a finite grace period; late success cannot revive failure', async h => {
  const job = await h.start();
  await h.worker();
  const file = path.join(h.drive, 'jobs', job.jobId, 'output', 'bass.wav');
  const bytes = await readFile(file);
  await rm(file);
  await h.remote.poll();
  h.advance(1100);
  assert.equal((await h.remote.poll()).jobs[0].error?.code, 'REMOTE_OUTPUT_SYNC_TIMEOUT');
  await writeFile(file, bytes);
  assert.equal((await h.remote.poll()).jobs[0].status, 'FAILED');
});
await scenario('no worker and no heartbeat are different actionable failures', async h => {
  const job = await h.start();
  h.advance(10001);
  assert.equal((await h.remote.poll()).jobs[0].error?.code, 'REMOTE_WORKER_NOT_STARTED');
  const next = await h.start();
  const file = path.join(h.drive, 'jobs', next.jobId, 'manifest.json');
  const m = JSON.parse(await readFile(file, 'utf8'));
  m.worker = { id: 'gone', claimedAt: Date.now(), heartbeatAt: Date.now() };
  await writeFile(file, JSON.stringify(m));
  h.advance(4000);
  const view = (await h.remote.poll()).jobs.find(j => j.jobId === next.jobId)!;
  assert.equal(view.error?.code, 'REMOTE_WORKER_STALE');
  assert.notEqual(next.jobId, job.jobId);
});
await scenario('offline jobs still reach their absolute deadline', async h => {
  await h.start();
  await rm(h.drive, { recursive: true });
  h.advance(1200001);
  assert.equal((await h.remote.poll()).jobs[0].error?.code, 'REMOTE_TIMEOUT');
  await mkdir(h.drive);
  assert.equal((await h.remote.poll()).jobs[0].status, 'FAILED');
});
await scenario('folder access is not worker readiness; stale/stopped workers are not green', async h => {
  assert.equal((await h.remote.status()).workerReady, false);
  const health = { schemaVersion: 1, version: 'colab-worker/2', state: 'ready', id: 'worker', device: 'cpu', heartbeatAt: Date.now() };
  await h.transport.writeText('worker.json', JSON.stringify(health));
  assert.equal((await h.remote.status()).workerReady, true);
  h.advance(181000);
  assert.equal((await h.remote.status()).workerReady, false);
});
await scenario('cancelled jobs never import late results', async h => {
  const job = await h.start();
  await h.worker();
  await h.remote.cancel(job.jobId, 'test cancellation before import');
  assert.equal((await h.remote.poll()).jobs[0].status, 'CANCELLED');
});

await scenario('already imported results remain playable after a fresh process, even offline', async h => {
  const job = await h.start();
  await h.worker();
  await h.verify(job.jobId);
  await rm(h.drive, { recursive: true });
  await h.restart();
  assert.ok((await h.local.stemBytes(job.jobId, 'vocals')).length > 44);
  assert.equal(h.remote.get(job.jobId)?.status, 'COMPLETED');
});
await scenario('cancellation during result download cannot be overwritten by completed import', async h => {
  const job = await h.start();
  await h.worker();
  const read = h.transport.readBytes.bind(h.transport);
  h.transport.readBytes = async (file) => {
    const bytes = await read(file);
    if (file.endsWith('/vocals.wav')) await h.remote.cancel(job.jobId, 'cancel during import');
    return bytes;
  };
  await h.remote.poll();
  assert.equal(h.remote.get(job.jobId)?.status, 'CANCELLED');
  await assert.rejects(h.local.stemBytes(job.jobId, 'vocals'));
});
