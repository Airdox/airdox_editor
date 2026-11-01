// @manual
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Top200BatchService } from '../src/stems/remote/top200Batch';
import type { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';
import { readFile } from 'node:fs/promises';
import { decodeWav } from '../src/stems/wavIo';

const root = await mkdtemp(path.join(os.tmpdir(), 'top200-conversion-'));
try {
  const input = await writeTestAudio(root, 'source', generateEdmTestTrack({ seconds: 1 }));
  let converted = false;
  const remote = {
    async start(request: { inputPath: string; sourceOriginalPath: string }) {
      const audio = decodeWav(await readFile(request.inputPath));
      assert.equal(audio.sampleRate, 44100);
      assert.equal(request.sourceOriginalPath, input.mixPath);
      converted = true;
      return { jobId: 'conversion-test', status: 'PENDING' };
    },
    async publishBatch() {},
  } as unknown as RemoteStemJobService;
  const service = new Top200BatchService(root, remote);
  const batch = await service.create([{ id: 'track', originalMedia: { location: input.mixPath } }]);
  await service.wait(batch.id);
  assert.ok(converted, (await service.get(batch.id)).entries[0].error);
  console.log('Top200: real ffmpeg working-copy conversion passed');
} finally { await rm(root, { recursive: true, force: true }); }
