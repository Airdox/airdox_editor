import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { StemJobService } from '../src/stems/stemJobService';
import { encodeWavFloat32 } from '../src/stems/wavIo';

const root = await mkdtemp(path.join(os.tmpdir(), 'stem-saved-library-'));
try {
  const dir = path.join(root, 'Separation', 'previous-session');
  await mkdir(dir, { recursive: true });
  const wav = encodeWavFloat32(44100, 2, new Float32Array(200).fill(0.1));
  const digest = createHash('sha256').update(wav).digest('hex');
  const ids = ['drums', 'bass', 'other', 'vocals'];
  for (const id of ids) await writeFile(path.join(dir, `${id}.wav`), wav);
  const metadata = {
    jobId: 'previous-job', status: 'COMPLETED', inputAudioHash: digest,
    settings: { modelId: 'scnet-onnx-4stem-int8', family: 'scnet', profile: 'PREVIEW', device: 'cpu', stems: ids },
    chunkCount: 1, originalIntegrity: { unchanged: true }, timing: { startedAt: 1, finishedAt: 2 },
    validation: { pass: true, fromTrainedModel: true },
    stems: ids.map((id, outputIndex) => ({ id, outputIndex, filePath: path.join(dir, `${id}.wav`),
      sha256: digest, bytes: wav.length, complete: true, sampleRate: 44100, channelCount: 2, frames: 100, peak: 0.1 })),
  };
  await writeFile(path.join(dir, 'job.json'), JSON.stringify(metadata));
  const query = { inputFingerprint: `stem-pcm-wav-v1:sha256:${digest}` };
  // A fresh service has no RAM jobs and no installed model. No inference may run.
  const service = new StemJobService({ root, backendFactory: { candidates() { throw new Error('Inference must not run'); } } });
  assert.equal(service.listJobs().length, 0);
  const saved = await service.findSaved(query);
  assert.equal(saved?.cacheHit, true);
  assert.deepEqual(saved?.stems, ids);
  assert.equal(saved?.result?.outputDir, dir);
  assert.deepEqual(await service.stemBytes(saved!.jobId, 'vocals'), Buffer.from(wav));
  assert.equal(await service.findSaved({ inputFingerprint: `stem-pcm-wav-v1:sha256:${'0'.repeat(64)}` }), null);
  assert.equal(await service.findSaved({ ...query, modelId: 'another-model' }), null);
  assert.equal(await service.findSaved({ ...query, profile: 'HIGH' }), null);
  const restarted = new StemJobService({ root });
  assert.equal((await restarted.findSaved(query))?.cacheHit, true);
  // Same-size damage is caught by SHA-256, without discarding the stored files.
  await writeFile(path.join(dir, 'vocals.wav'), new Uint8Array(wav.length));
  assert.equal(await restarted.findSaved(query), null);

  // Legacy remote imports did verify hashes during import, but old job.json
  // files have no persisted technical validation report. Recheck once, then
  // persist the report so subsequent sessions can reuse the result.
  const legacyDir = path.join(root, 'Separation', 'legacy-remote');
  await mkdir(legacyDir, { recursive: true });
  for (const id of ids) await writeFile(path.join(legacyDir, `${id}.wav`), wav);
  const remoteInputHash = createHash('sha256').update('distinct-remote-input').digest('hex');
  const legacy = {
    ...metadata,
    jobId: 'legacy-remote-job', inputAudioHash: remoteInputHash,
    settings: { ...metadata.settings, extras: { remote: true } },
    validation: undefined,
    timing: { startedAt: 3, finishedAt: 4 },
    stems: ids.map((id, outputIndex) => ({ ...metadata.stems[outputIndex], filePath: path.join(legacyDir, `${id}.wav`) })),
  };
  const legacyPath = path.join(legacyDir, 'job.json');
  await writeFile(legacyPath, JSON.stringify(legacy));
  const legacyQuery = { inputFingerprint: `stem-pcm-wav-v1:sha256:${remoteInputHash}` };
  const migrated = await new StemJobService({ root }).findSaved(legacyQuery);
  assert.equal(migrated?.cacheHit, true);
  const persisted = JSON.parse(await readFile(legacyPath, 'utf8'));
  assert.equal(persisted.validation.pass, true);
  assert.equal(persisted.validation.stems.length, 4);
  assert.equal((await new StemJobService({ root }).findSaved(legacyQuery))?.cacheHit, true);

  // A matching SHA and byte count alone cannot make non-finite samples valid.
  const invalidWav = Buffer.from(wav);
  invalidWav.writeFloatLE(Number.NaN, 44);
  await writeFile(path.join(legacyDir, 'vocals.wav'), invalidWav);
  const invalidHash = createHash('sha256').update(invalidWav).digest('hex');
  legacy.stems[3].sha256 = invalidHash;
  await writeFile(legacyPath, JSON.stringify(legacy));
  assert.equal(await new StemJobService({ root }).findSaved(legacyQuery), null);
  console.log('Saved stem library: restart, no model/inference, exact input/profile/model, WAV readback and corruption passed.');
} finally { await rm(root, { recursive: true, force: true }); }
