import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLibraryStemProbe } from '../src/features/library/probeLibraryStems';
import { getLibraryStemStatus } from '../src/features/library';
import { encodeWavFloat32 } from '../src/stems/wavIo';

const root = await mkdtemp(path.join(os.tmpdir(), 'library-batch-'));
try {
  const directory = path.join(root, 'Separation', 'saved');
  await mkdir(directory, { recursive: true });
  const sourcePath = path.join(root, 'original.wav');
  const wav = encodeWavFloat32(44100, 2, new Float32Array(200).fill(0.1));
  await writeFile(sourcePath, wav);
  const original = await stat(sourcePath);
  const hash = createHash('sha256').update(wav).digest('hex');
  const ids = ['vocals', 'instrumental'];
  for (const id of ids) await writeFile(path.join(directory, `${id}.wav`), wav);
  const metadata = {
    status: 'COMPLETED', inputPath: sourcePath,
    originalIntegrity: { path: sourcePath, unchanged: true, sizeBefore: original.size, mtimeMsBefore: original.mtimeMs },
    settings: { stems: ids }, timing: { finishedAt: 1 },
    stems: ids.map(id => ({ id, complete: true, filePath: path.join(directory, `${id}.wav`), bytes: wav.length,
      sha256: hash, sampleRate: 44100, channelCount: 2, frames: 100 })),
  };
  const manifest = path.join(directory, 'job.json');
  await writeFile(manifest, JSON.stringify(metadata));
  const requests = [{ trackId: 'one', sourcePath }, { trackId: 'two', sourcePath }, { trackId: 'absent', sourcePath: path.join(root, 'other.wav') }];
  const probe = createLibraryStemProbe(root);
  const track = (id: string, source = sourcePath) => ({ id, originalMedia: { location: source, accessMode: 'READ_ONLY' as const, status: 'UNVERIFIED' as const } });
  const firstPromise = probe(requests);
  assert.equal(probe(requests), firstPromise, 'identical overlapping batches share work');
  const first = await firstPromise;
  assert.equal(getLibraryStemStatus(track('one'), first), 'available');
  assert.equal(getLibraryStemStatus(track('two'), first), 'available');
  assert.equal(getLibraryStemStatus(track('absent', requests[2].sourcePath), first), 'missing');
  assert.equal(getLibraryStemStatus(track('one'), await probe(requests)), 'available', 'cached validation is re-statted');
  await writeFile(path.join(directory, 'vocals.wav'), new Uint8Array(wav.length));
  assert.equal(getLibraryStemStatus(track('one'), await probe(requests)), 'missing', 'same-size damage invalidates cache');
  await writeFile(path.join(directory, 'vocals.wav'), wav);
  assert.equal(getLibraryStemStatus(track('one'), await probe(requests)), 'available');
  // Renderer jobs fingerprint the generated PCM input, not the XML original.
  // Explicit unedited-source provenance allows lookup after staging is removed.
  const staged = { ...metadata,
    inputPath: path.join(root, 'deleted-engine-input.wav'),
    originalIntegrity: { ...metadata.originalIntegrity, path: path.join(root, 'deleted-engine-input.wav') },
    settings: { ...metadata.settings, extras: { librarySourcePath: pathToFileURL(sourcePath).href, librarySourceSize: original.size,
      librarySourceModifiedAt: original.mtimeMs, librarySourceUnedited: true } },
  };
  await writeFile(manifest, JSON.stringify(staged));
  assert.equal(getLibraryStemStatus(track('one'), await probe(requests)), 'available');
  await writeFile(manifest, JSON.stringify({ ...staged, settings: { ...staged.settings,
    extras: { ...staged.settings.extras, librarySourceUnedited: false } } }));
  assert.notEqual(getLibraryStemStatus(track('one'), await probe(requests)), 'available', 'edited inputs cannot claim original provenance');
  await writeFile(manifest, JSON.stringify(metadata));
  await rm(path.join(directory, 'instrumental.wav'));
  assert.equal(getLibraryStemStatus(track('one'), await probe(requests)), 'missing', 'COMPLETED is insufficient');
  await writeFile(path.join(directory, 'instrumental.wav'), wav);
  await writeFile(sourcePath, new Uint8Array(10));
  assert.equal(getLibraryStemStatus(track('one'), await probe(requests)), 'missing', 'changed original invalidates association');
  await writeFile(path.join(directory, 'job.json'), '{broken');
  assert.equal(getLibraryStemStatus(track('one'), await probe(requests)), 'unknown', 'incomplete scan cannot claim absence');
  console.log('Library batch probe: unloaded tracks, deduplication, actual WAV readback, cache invalidation and unknown scans passed.');
} finally { await rm(root, { recursive: true, force: true }); }
