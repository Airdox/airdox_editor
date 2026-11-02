import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Top200BatchService } from '../src/stems/remote/top200Batch';
import type { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';

const root = await mkdtemp(path.join(os.tmpdir(), 'airdox-batch-checkpoint-'));
try {
  const source = path.join(root, 'synthetic-audio.wav');
  await writeFile(source, Buffer.from('synthetic transport fixture'));
  const checkpoints: { count: number; complete: boolean }[] = [];
  let submissions = 0;
  const remote = {
    async start() { submissions++; return { jobId: `checkpoint-job-${submissions}`, status: 'RUNNING' }; },
    async publishBatch(_id: string, jobIds: string[], uploadComplete = true) { checkpoints.push({ count: jobIds.length, complete: uploadComplete }); },
  } as unknown as RemoteStemJobService;
  const service = new Top200BatchService(root, remote, copyFile);
  const batch = await service.create(Array.from({ length: 21 }, (_, index) => ({ id: `track-${index}`, originalMedia: { location: source } })));
  await service.wait(batch.id);
  assert.deepEqual(checkpoints, [{ count: 10, complete: false }, { count: 20, complete: false }, { count: 21, complete: true }]);
  assert.equal((await service.get(batch.id)).uploadComplete, true);
  assert.equal(submissions, 21);
  console.log('Top200 publishes resumable checkpoints after 10 and 20 submissions before the final descriptor');
} finally { await rm(root, { recursive: true, force: true }); }
