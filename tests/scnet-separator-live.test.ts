// @manual
// @requires: onnxruntime
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScnetSeparator } from '../src/stems/backends/scnetSeparator';
import { ModelRegistry } from '../src/stems/modelRegistry';

async function run() {
  const sourceStore = process.env.AUDIO_NEURAL_CACHE || path.join(os.homedir(), '.cache', 'audiojs', 'neural');
  const modelStore = await mkdtemp(path.join(os.tmpdir(), 'scnet-live-'));
  try {
    await mkdir(path.join(modelStore, 'scnet'), { recursive: true });
    await copyFile(path.join(sourceStore, 'scnet', 'scnet.int8.onnx'), path.join(modelStore, 'scnet', 'scnet.int8.onnx'));
    const descriptor = ModelRegistry.fromBundledCatalog().require('scnet-onnx-4stem-int8');
    const frames = 11 * 44100;
    const samples = new Float32Array(frames * 2);
    for (let frame = 0; frame < frames; frame++) {
      const t = frame / 44100;
      samples[frame * 2] = 0.25 * Math.sin(2 * Math.PI * 110 * t) + 0.08 * Math.sin(2 * Math.PI * 880 * t);
      samples[frame * 2 + 1] = 0.23 * Math.sin(2 * Math.PI * 110 * t + 0.2) + 0.07 * Math.sin(2 * Math.PI * 1320 * t);
    }
    const separator = new ScnetSeparator({ modelStoreDir: modelStore });
    const availability = await separator.isAvailable({ descriptor });
    assert.equal(availability.available, true, availability.reason);
    let progress = 0;
    const result = await separator.separate({
      descriptor, workingWavPath: '', workingSamples: samples, sampleRate: 44100, channels: 2,
      outputDir: '', startSample: 0, frames, stems: descriptor.outputStems,
      chunkIndex: 0, chunkCount: 1, numOverlap: 1, ensemblePasses: 1,
      precision: 'f32', device: 'cpu', profile: 'PREVIEW',
      onProgress: (fraction) => { progress = Math.max(progress, fraction); },
    });
    assert.equal(result.inlineStems?.length, 4);
    assert.ok(result.inlineStems?.every((stem) => stem.frames === frames && stem.channels === 2));
    assert.ok(result.inlineStems?.every((stem) => stem.samples.every(Number.isFinite)));
    assert.ok(result.inlineStems?.every((stem) => Math.sqrt(stem.samples.reduce((sum, value) => sum + value * value, 0) / stem.samples.length) > 1e-5), 'all requested stems contain signal');
    for (let i = 0; i < result.inlineStems!.length; i++) {
      for (let j = i + 1; j < result.inlineStems!.length; j++) {
        assert.ok(result.inlineStems![i].samples.some((sample, index) => Math.abs(sample - result.inlineStems![j].samples[index]) > 1e-5), 'stem outputs are not identical copies');
      }
    }
    assert.equal(result.device, 'cpu');
    assert.equal(progress, 1);
    console.log('SCNet live adapter: real ONNX model produced four finite, aligned stereo stems.');
  } finally {
    await rm(modelStore, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
