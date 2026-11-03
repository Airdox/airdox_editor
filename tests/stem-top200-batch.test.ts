import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selectTop200, Top200BatchService, checkBatchTrack } from '../src/stems/remote/top200Batch';
import { pathToFileURL } from 'node:url';
import { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';
import { StemJobService } from '../src/stems/stemJobService';
import { FolderTransport } from '../src/stems/remote/transport';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';
import { runWorkerCycle } from '../scripts/stem-remote-worker';
import { mapRekordboxDatabaseRows } from '../src/rekordbox/dbParser';
import { batchTracksFromImportedCollection } from '../src/stems/remote/batchCollection';

const ranked = selectTop200(Array.from({ length: 240 }, (_, index) => ({ id: String(index), playCount: index })));
assert.equal(ranked.length, 200);
assert.equal(ranked[0].id, '239');
assert.equal(ranked[199].id, '40');
const importedCollection = [{ id: 'from-import', title: 'Same title', playCount: 88, originalMedia: { location: 'file:///E:/original%20track.flac' } }];
assert.throws(() => batchTracksFromImportedCollection([], []), /importieren/);
assert.equal(batchTracksFromImportedCollection(importedCollection, [{ id: 'other-id', title: 'Same title', analysisSource: { gateCode: 'OK', originalPath: 'wrong-file' } }])[0].originalMedia?.location, importedCollection[0].originalMedia.location);
assert.equal(batchTracksFromImportedCollection(importedCollection, [{ id: 'from-import', analysisSource: { gateCode: 'OK', originalPath: 'stale-file' } }])[0].originalMedia?.location, importedCollection[0].originalMedia.location);
assert.equal(batchTracksFromImportedCollection([{ ...importedCollection[0], originalSha256: 'a'.repeat(64) }], [{ id: 'from-import', originalSha256: 'a'.repeat(64), analysisSource: { gateCode: 'OK', originalPath: 'verified-file' } }])[0].originalMedia?.location, 'verified-file');
assert.equal(batchTracksFromImportedCollection(importedCollection, [{ id: 'from-import', analysisSource: { originalPath: 'unverified-file' } }])[0].originalMedia?.location, importedCollection[0].originalMedia.location);
assert.equal(importedCollection[0].originalMedia.location, 'file:///E:/original%20track.flac');
const mapped = mapRekordboxDatabaseRows({ content: [{ ID: 'dj-low', Title: 'Low', DJPlayCount: 4 }, { ID: 'dj-high', Title: 'High', DJPlayCount: 99 }], cues: [], artists: [], albums: [], genres: [], keys: [], labels: [], playlists: [], songPlaylists: [] }, 'MASTER_DB');
assert.equal(selectTop200(mapped.tracks.map(track => ({ ...track, id: String(track.id) })))[0].title, 'High');
assert.deepEqual(selectTop200([{ id: 'b', playCount: NaN }, { id: 'a' }, { id: 'a', playCount: 30 }]).map(track => track.id), ['a', 'b']);
const base = await mkdtemp(path.join(os.tmpdir(), 'airdox-top200-'));
const root = path.join(base, 'engine');
const drive = path.join(base, 'drive');
await mkdir(drive);
const local = new StemJobService({ root, allowPipelineDouble: true });
const transport = new FolderTransport({ root: drive });
const remote = new RemoteStemJobService({ root, localService: local, transport, allowPipelineDouble: true, disableBackgroundPolling: true, env: {} });
const batchRemote = {
  start: (request: any) => remote.start({ ...request, profile: 'PREVIEW', modelId: 'pipeline-double-v1' }),
  get: remote.get.bind(remote), poll: remote.poll.bind(remote), publishBatch: remote.publishBatch.bind(remote),
  retryImport: remote.retryImport.bind(remote),
  restoreCompletedJob: remote.restoreCompletedJob.bind(remote),
} as RemoteStemJobService;
try {
  const first = await writeTestAudio(path.join(base, 'audio'), 'first', generateEdmTestTrack({ seconds: 1 }));
  assert.equal(await checkBatchTrack({ id: 'url-track', originalMedia: { location: pathToFileURL(first.mixPath).href } }), first.mixPath);
  await assert.rejects(() => checkBatchTrack({ id: 'relative-track', originalMedia: { location: 'relative/path.mp3' } }), /nicht absolut/);
  const second = await writeTestAudio(path.join(base, 'audio'), 'second', generateEdmTestTrack({ seconds: 2 }));
  const originals = await Promise.all([readFile(first.mixPath), readFile(second.mixPath)]);
  const batches = new Top200BatchService(root, batchRemote, copyFile);
  const tracks = [{ id: 'missing', playCount: 50, originalMedia: { location: path.join(base, 'missing.mp3') } }, { id: 'first', playCount: 40, originalMedia: { location: first.mixPath } }, { id: 'second', playCount: 30, originalMedia: { location: second.mixPath } }];
  const preview = await batches.preview(tracks);
  assert.equal(preview[0].status, 'FAILED');
  assert.equal(preview[1].inputPath, first.mixPath);
  const batch = await batches.create(tracks);
  await batches.wait(batch.id);
  const uploaded = await batches.get(batch.id);
  assert.equal(uploaded.modelId, 'bsroformer-musdb18hq-4stem-zfturbo');
  await assert.rejects(() => batches.create(tracks, 'bsroformer-viperx-vocals-1297'), /nicht verifiziert/);
  assert.equal(uploaded.entries.filter(entry => entry.jobId).length, 2);
  const published = JSON.parse(await readFile(path.join(drive, 'batches', batch.id + '.json'), 'utf8'));
  assert.deepEqual(published.jobIds, uploaded.entries.flatMap(entry => entry.jobId ? [entry.jobId] : []));
  const restarted = new Top200BatchService(root, batchRemote, async () => { throw new Error('Must not reconvert submitted tracks'); });
  restarted.resume(batch.id);
  await restarted.wait(batch.id);
  assert.equal(remote.list().length, 2);
  await runWorkerCycle({ root: drive, kind: 'folder', workDir: path.join(base, 'worker'), workerId: 'batch-test', once: true, pollMs: 1000, maxJobs: 2, allowPipelineDouble: true, quiet: true }, transport);
  const readBytes = transport.readBytes.bind(transport);
  let simulatedFullDisk = true;
  transport.readBytes = async relative => {
    if (simulatedFullDisk && relative.includes('/output/') && relative.endsWith('.wav')) {
      simulatedFullDisk = false;
      throw Object.assign(new Error('ENOSPC: synthetic import-read failure'), { code: 'ENOSPC' });
    }
    return readBytes(relative);
  };
  const firstImport = await restarted.refresh(batch.id);
  assert.ok(firstImport.entries.some(entry => entry.jobId && entry.status === 'FAILED'));
  transport.readBytes = readBytes;
  await restarted.retry(batch.id);
  await restarted.wait(batch.id);
  assert.equal(remote.list().length, 2, 'Import-only retry must not dispatch another separation');
  const imported = await restarted.refresh(batch.id);
  const coldLocal = new StemJobService({ root, allowPipelineDouble: true });
  const coldRemote = new RemoteStemJobService({ root, localService: coldLocal, disableBackgroundPolling: true, env: {} });
  const coldBatch = new Top200BatchService(root, coldRemote, copyFile);
  for (const entry of imported.entries.slice(1)) {
    assert.equal(entry.status, 'COMPLETED');
    assert.equal(entry.localJobId, entry.jobId);
    assert.equal(await restarted.lookup(entry.track.id, entry.originalSha256!), entry.jobId);
    assert.equal(await restarted.lookup(entry.track.id, 'wrong-hash'), null);
    const restoredId = await coldBatch.lookup(entry.track.id, entry.originalSha256!);
    assert.ok(restoredId && coldLocal.getJob(restoredId)?.result?.validationPass);
  }
  assert.deepEqual(await readFile(first.mixPath), originals[0]);
  assert.deepEqual(await readFile(second.mixPath), originals[1]);
  const failedBatch = await batches.create([{ id: 'recoverable', originalMedia: { location: path.join(base, 'later.wav') } }]);
  await batches.wait(failedBatch.id);
  await copyFile(first.mixPath, path.join(base, 'later.wav'));
  await batches.retry(failedBatch.id);
  await batches.wait(failedBatch.id);
  assert.ok((await batches.get(failedBatch.id)).entries[0].jobId);
  console.log('Top200: ranking, limit, missing file, mapping, publication, restart, two-job worker, checked import and original integrity passed');
} finally { remote.dispose(); await rm(base, { recursive: true, force: true }); }
