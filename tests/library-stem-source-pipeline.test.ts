import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLibrarySourceExtras, stemEngine } from '../src/audio/stemEngine';
import { makeAudioBuffer } from './support/editingHarness';
import { buildCollectionTrackModel } from '../src/features/import/collectionTrackModel';
import { getLibraryStemStatus, sanitizeLibrarySourceExtras } from '../src/features/library';
import { createLibraryStemProbe } from '../src/features/library/probeLibraryStems';
import { StemJobService, type StartStemJobRequest } from '../src/stems/stemJobService';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { PipelineDoubleSeparator } from '../src/stems/backends/pipelineDoubleSeparator';
import { createDefaultBackendFactory } from '../src/stems/stemSeparationEngine';
import { encodeWavFloat32 } from '../src/stems/wavIo';
import type { ModelDescriptor, SeparationJobMetadata } from '../src/stems/types';
import { DataOrigin } from '../src/types/rekordbox';

const root = await mkdtemp(path.join(os.tmpdir(), 'library-source-pipeline-'));
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
try {
  const originalPath = path.join(root, 'Music', 'XML Original.wav');
  await mkdir(path.dirname(originalPath));
  const samples = Float32Array.from({ length: 8192 }, (_, i) => 0.2 * Math.sin(i / 13));
  const buffer = makeAudioBuffer(samples, 44100, samples);
  // Interleaved original audio exists separately from the engine's generated input.
  const interleaved = new Float32Array(samples.length * 2);
  samples.forEach((value, i) => { interleaved[i * 2] = value; interleaved[i * 2 + 1] = value; });
  await writeFile(originalPath, encodeWavFloat32(44100, 2, interleaved));
  const sourceStat = await stat(originalPath);
  const track = buildCollectionTrackModel({ id: 'xml-original', duration: buffer.duration,
    originalMedia: { location: originalPath, resolvedPath: originalPath, accessMode: 'READ_ONLY', status: 'AVAILABLE',
      size: sourceStat.size, modifiedAt: sourceStat.mtimeMs } }, 0, DataOrigin.REKORDBOX_XML);
  track.audioBuffer = buffer;
  const extras = buildLibrarySourceExtras(buffer, track);
  assert.equal(extras?.librarySourcePath, originalPath);
  assert.equal(extras?.librarySourceUnedited, true);
  assert.equal(buildLibrarySourceExtras(makeAudioBuffer(samples, 44100, samples), track), undefined, 'another working revision cannot claim original identity');
  for (const segment of [ { ...track.workingSegments[0], gain: 0.5 },
    { ...track.workingSegments[0], type: 'INSERT' as const }, { ...track.workingSegments[0], sourceStart: 1 },
    { ...track.workingSegments[0], sourceEnd: NaN } ]) {
    assert.equal(buildLibrarySourceExtras(buffer, { ...track, workingSegments: [segment] }), undefined);
  }
  assert.equal(buildLibrarySourceExtras(buffer, { ...track, originalMedia: { ...track.originalMedia!, status: 'UNVERIFIED' } }), undefined);
  assert.deepEqual(sanitizeLibrarySourceExtras({ ...extras, unwantedEngineSwitch: true }), extras);
  assert.equal(sanitizeLibrarySourceExtras({ ...extras, librarySourceUnedited: false }), undefined);

  let captured: StartStemJobRequest | undefined;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { rekordboxDesktop: { stemEngine: {
    startStemJob: async (payload: StartStemJobRequest) => {
      captured = payload;
      return { ok: false, code: 'CAPTURED', message: 'payload captured before model startup' };
    },
    startRemoteStemJob: async (payload: StartStemJobRequest & { sourceOriginalPath?: string }) => {
      assert.deepEqual(payload.extras, extras);
      assert.equal(payload.sourceOriginalPath, originalPath);
      return { ok: false, code: 'CAPTURED', message: 'remote source payload captured' };
    },
  } } } });
  stemEngine.clearCache();
  await assert.rejects(stemEngine.separateWithEngine(buffer, track.id, 'uncomputed-source-hash', { sourceTrack: track, profile: 'PREVIEW' }), /CAPTURED/);
  assert.deepEqual(captured?.extras, extras, 'desktop request carries actual source provenance');
  const desktopRequest = captured!;
  assert.ok(desktopRequest.bytes instanceof Uint8Array);
  await assert.rejects(stemEngine.separateRemoteWithEngine(buffer, track.id, 'uncomputed-source-hash', { sourceTrack: track }), /CAPTURED/);

  // Exercise the HTTP renderer payload too, without starting a real HTTP server.
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  let httpBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    if (String(url) === '/api/stems/jobs' || String(url) === '/api/stems/remote/start') {
      httpBody = JSON.parse(String(options?.body));
      return { ok: false, status: 400, json: async () => ({ ok: false, code: 'CAPTURED', message: 'CAPTURED' }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true, data: null }) } as Response;
  }) as typeof fetch;
  await assert.rejects(stemEngine.separateWithEngine(buffer, track.id, 'uncomputed-source-hash', { sourceTrack: track, profile: 'PREVIEW' }), /CAPTURED/);
  assert.deepEqual(httpBody?.extras, extras);
  await assert.rejects(stemEngine.separateRemoteWithEngine(buffer, track.id, 'uncomputed-source-hash', { sourceTrack: track }), /CAPTURED/);
  assert.deepEqual(httpBody?.extras, extras);
  assert.equal(httpBody?.sourceOriginalPath, originalPath);

  // Real service + real job.json + real WAV artifacts; only neural inference is a double.
  const descriptor: ModelDescriptor = {
    id: 'library-source-double', family: 'pipeline_double', version: '1',
    checkpoint: { file: 'library-source.synthetic', format: 'synthetic' }, sampleRate: 44100, inputChannels: 2,
    outputStems: ['vocals', 'other'], stemOrder: ['vocals', 'other'], stemDisplayNames: { vocals: 'Vocals', other: 'Other' },
    modelHash: 'synthetic:library-source', license: 'MIT', backendSupport: ['in-process'], precision: ['f32'],
    recommendedOverlap: 1, chunkSizeSamples: 8192,
    qualityProfile: { serves: ['PREVIEW'], numOverlap: { PREVIEW: 1 }, rationale: 'Source provenance regression only' },
  } as ModelDescriptor;
  const service = new StemJobService({ root, allowPipelineDouble: true, registry: ModelRegistry.fromBundledCatalog({ extra: [descriptor] }),
    backendFactory: createDefaultBackendFactory({ pipelineDouble: new PipelineDoubleSeparator() }), chunkSizeSamples: 8192 });
  const started = await service.start({ ...desktopRequest, extras: sanitizeLibrarySourceExtras(desktopRequest.extras), modelId: descriptor.id });
  const finished = await service.waitFor(started.jobId);
  assert.equal(finished.status, 'COMPLETED', finished.error?.message);
  const metadata = JSON.parse(await readFile(finished.result!.metadataPath, 'utf8')) as SeparationJobMetadata;
  assert.notEqual(metadata.inputPath, originalPath);
  assert.notEqual(metadata.originalIntegrity.path, originalPath, 'engine integrity describes staging, not the XML original');
  assert.match(metadata.inputPath, /Staging/i);
  assert.equal(metadata.settings.extras?.librarySourcePath, originalPath, 'provenance survives actual service/engine persistence');
  await rm(metadata.inputPath); // generated input is disposable after separation
  const probe = createLibraryStemProbe(root);
  const snapshot = await probe([{ trackId: track.id, sourcePath: originalPath }]);
  assert.equal(getLibraryStemStatus(track, snapshot), 'available', 'unloaded XML source resolves despite a different/deleted staging input');
  await writeFile(originalPath, 'changed original');
  assert.equal(getLibraryStemStatus(track, await probe([{ trackId: track.id, sourcePath: originalPath }])), 'missing');
  console.log('Library source pipeline: renderer IPC/HTTP payload → real staged job → manifest → verified original-path probe passed.');
} finally {
  globalThis.fetch = originalFetch;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  stemEngine.clearCache();
  await rm(root, { recursive: true, force: true });
}
