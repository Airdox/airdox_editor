import assert from 'node:assert/strict';
import { ScnetSeparator } from '../src/stems/backends/scnetSeparator';
import { SeparationCancellationToken } from '../src/stems/chunkProcessor';
import type { BackendSeparationRequest } from '../src/stems/backends/types';
import type { ModelDescriptor } from '../src/stems/types';

const descriptor = {
  id: 'scnet-test', family: 'scnet', version: 'test',
  checkpoint: { file: 'scnet/scnet.int8.onnx', format: 'onnx' },
  sampleRate: 44100, inputChannels: 2,
  outputStems: ['drums', 'bass', 'other', 'vocals'],
  stemOrder: ['drums', 'bass', 'other', 'vocals'],
  stemDisplayNames: { drums: 'Drums', bass: 'Bass', other: 'Other', vocals: 'Vocals' },
  modelHash: '0'.repeat(64), license: 'MIT', backendSupport: ['onnx'], precision: ['f32'],
  recommendedOverlap: 1, chunkSizeSamples: 485100,
  qualityProfile: { serves: ['PREVIEW'], numOverlap: { PREVIEW: 1 } },
} as unknown as ModelDescriptor;

function request(overrides: Partial<BackendSeparationRequest> = {}): BackendSeparationRequest {
  return {
    descriptor, workingWavPath: '', workingSamples: new Float32Array([0.1, -0.1, 0.2, -0.2]),
    sampleRate: 44100, channels: 2, outputDir: '', startSample: 0, frames: 2,
    stems: ['drums', 'vocals'], chunkIndex: 0, chunkCount: 1, numOverlap: 1,
    ensemblePasses: 1, precision: 'f32', device: 'auto', profile: 'PREVIEW', ...overrides,
  };
}

let observedStep: number | undefined;
const fakeSeparate = async (audio: Float32Array[], opts: { step?: number; progress?: (p: { chunk: number; totalChunks: number }) => void }) => {
  observedStep = opts.step;
  assert.ok(Math.abs(audio[0][0] - 0.1) < 1e-6 && Math.abs(audio[0][1] - 0.2) < 1e-6);
  assert.ok(Math.abs(audio[1][0] + 0.1) < 1e-6 && Math.abs(audio[1][1] + 0.2) < 1e-6);
  opts.progress?.({ chunk: 1, totalChunks: 1 });
  return {
    sampleRate: 44100,
    residual: [new Float32Array(2), new Float32Array(2)],
    stems: {
      drums: [new Float32Array([0.01, 0.02]), new Float32Array([-0.01, -0.02])],
      vocals: [new Float32Array([0.03, 0.04]), new Float32Array([-0.03, -0.04])],
    },
  };
};

async function run() {
  const separator = new ScnetSeparator({ modelStoreDir: 'unused-in-test', separate: fakeSeparate as never });
  const progress: string[] = [];
  const result = await separator.separate(request({ onProgress: (_fraction, phase) => progress.push(phase) }));
  assert.equal(result.engine, 'scnet');
  assert.equal(result.backend, 'onnx');
  assert.equal(result.inlineStems?.length, 2);
  assert.equal(result.inlineStems?.[0].outputIndex, 0);
  assert.equal(result.inlineStems?.[1].outputIndex, 3);
  assert.ok(result.inlineStems![1].samples.every((sample, index) => Math.abs(sample - [0.03, -0.03, 0.04, -0.04][index]) < 1e-6));
  assert.ok(progress.some((phase) => phase.includes('Abschnitt 1/1')));
  assert.equal(result.stems.length, 0, 'SCNet returns samples in memory; no temporary chunk files');
  assert.equal(observedStep, 0.5, 'PREVIEW uses the faster DJ overlap setting');

  await separator.separate(request({ profile: 'BALANCED' }));
  assert.equal(observedStep, 0.4, 'BALANCED retains more overlap while staying within the measured budget');

  const token = new SeparationCancellationToken();
  token.cancel('test cancel');
  await assert.rejects(
    () => separator.separate(request({ token })),
    /test cancel/,
  );
  console.log('SCNet adapter: stereo mapping, stem order, progress and cancellation passed.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
