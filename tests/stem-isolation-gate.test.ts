import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateGoldStandardTrack, TEST_SEED } from '../src/stems/goldStandard';
import { buildGoldStandardVariants } from '../src/stems/goldStandardVariants';
import { buildStemGroupMap } from '../src/stems/stemGroupMapping';
import { PipelineDoubleSeparator } from '../src/stems/backends/pipelineDoubleSeparator';
import { createDefaultBackendFactory, StemSeparationEngine } from '../src/stems/stemSeparationEngine';
import { runStemIsolationGate } from '../src/stems/stemIsolationGate';
import { encodeWavFloat32 } from '../src/stems/wavIo';

async function run(): Promise<void> {
  const track = generateGoldStandardTrack();
  assert.equal(track.seed, TEST_SEED);
  assert.equal(track.seconds, 30);
  assert.equal(track.stems.size, 6);
  assert.equal(track.segments.length, 6);
  const repeat = generateGoldStandardTrack();
  assert.deepEqual(track.mix, repeat.mix, 'Goldstandard muss deterministisch sein');
  const variants = buildGoldStandardVariants(track);
  assert.ok(variants.length >= 15);
  assert.deepEqual(buildStemGroupMap(['vocals', 'drums', 'bass', 'other'], track.stemOrder).groups.get('other')?.sort(), ['fx', 'percussion', 'synth']);
  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-gate-'));
  try {
    const input = path.join(root, 'input.wav');
    await writeFile(input, encodeWavFloat32(track.sampleRate, 2, track.mix, track.frames));
    const engine = new StemSeparationEngine({ workingRoot: path.join(root, 'working'), outputRoot: path.join(root, 'output'), cacheRoot: path.join(root, 'cache'), modelStoreDir: path.join(root, 'models'), allowPipelineDouble: true, backendFactory: createDefaultBackendFactory({ pipelineDouble: new PipelineDoubleSeparator({ mode: 'coherent' }) }) });
    const report = await runStemIsolationGate({ engine, outputRoot: path.join(root, 'test_run'), request: { modelId: 'pipeline-double-v1' } });
    assert.equal(report.technicalPass, true);
    assert.equal(report.qualityPass, false);
    assert.equal(report.releaseDecision, 'TECHNICAL_PASS_QUALITY_FAIL');
    assert.equal(report.originalHashBefore, report.originalHashAfter);
    assert.ok(report.rows.length > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
  console.log('stem-isolation-gate: all tests passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
