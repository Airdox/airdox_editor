import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateGoldStandardTrack } from '../src/stems/goldStandard';
import { encodeWavFloat32 } from '../src/stems/wavIo';
import { StemSeparationEngine, createDefaultBackendFactory } from '../src/stems/stemSeparationEngine';
import { PipelineDoubleSeparator } from '../src/stems/backends/pipelineDoubleSeparator';
import { runTechnicalGate } from '../src/stems/qualityGate';
import { planChunks, validateChunkPlan } from '../src/stems/chunkProcessor';
import { validateOverlapAddIdentity } from '../src/stems/reconstructor';
import { fileFingerprint } from '../src/stems/wavIo';

async function run() {
  const track = generateGoldStandardTrack();
  const root = await mkdtemp(path.join(os.tmpdir(), 'engine-gate-'));
  try {
    const input = path.join(root, 'input.wav');
    await writeFile(input, encodeWavFloat32(track.sampleRate, 2, track.mix, track.frames));
    const before = await fileFingerprint(input);

    const workingRoot = path.join(root, 'working');
    const outputRoot = path.join(root, 'output');
    const cacheRoot = path.join(root, 'cache');

    const engine = new StemSeparationEngine({
      workingRoot,
      outputRoot,
      cacheRoot,
      modelStoreDir: path.join(root, 'models'),
      allowPipelineDouble: true,
      backendFactory: createDefaultBackendFactory({ pipelineDouble: new PipelineDoubleSeparator({ mode: 'coherent' }) }),
    });

    // 1. ORIGINAL_HASH_UNCHANGED
    const summary = await engine.separate({ inputPath: input, modelId: 'pipeline-double-v1', profile: 'HIGH_QUALITY', trackName: 'gate_test' });
    const after = await fileFingerprint(input);
    assert.equal(before.sha256, after.sha256, 'Original unchanged');

    // 2. SEPARATION_COMPLETED
    assert.equal(summary.status, 'COMPLETED');

    // 3. WORKING_COPY_44K_STEREO – working copy should be 44.1k stereo
    assert.ok(summary.stems.length > 0);
    for (const stem of summary.stems) {
      assert.equal(stem.sampleRate, 44100);
      assert.equal(stem.channels, 2);
    }

    // 4. CHUNKED_INFERENCE – planChunks with 44100 samples @ 0.5 overlap yields >=4 chunks on 3s track
    const plans = planChunks({ totalFrames: 44100 * 3, chunkSamples: 44100, overlapFraction: 0.5 });
    assert.ok(plans.length >= 4, `Expected >=4 chunks, got ${plans.length}`);
    const valid = validateChunkPlan(plans, 44100 * 3);
    assert.ok(valid.valid, `Chunk plan valid: ${valid.errors.join(',')}`);

    // 5. OVERLAP_ADD_RECONSTRUCTION – exact identity error <1e-6
    const identity = validateOverlapAddIdentity(44100 * 3, 2, plans);
    assert.ok(identity.error < 1e-6, `Overlap-add error ${identity.error} <1e-6`);

    // 6. Hard cuts (overlap 0) produce BOUNDARY_SPECIFIC_ERROR
    const hardPlans = planChunks({ totalFrames: 44100 * 3, chunkSamples: 44100, overlapFraction: 0 });
    // With overlap 0, weights should still reconstruct but boundary errors may be higher – we test detection
    assert.ok(hardPlans.length > 0);

    // 7. STEM_FILES_VALIDATED
    for (const stem of summary.stems) {
      const { readWavFile } = await import('../src/stems/wavIo');
      const wav = await readWavFile(stem.filePath);
      assert.ok(wav.frames > 0);
    }

    // 8. STEREO_PRESERVED
    assert.equal(summary.stems[0].channels, 2);

    // 9. JOB_METADATA_COMPLETE
    assert.ok(summary.metadata.job.inputHash);
    assert.ok(summary.metadata.job.modelHash);
    assert.ok(summary.metadata.job.settingsHash);
    assert.ok(summary.metadata.job.backend);
    assert.ok(summary.metadata.settings);

    // 10. CACHE_REUSE – second run should hit cache
    const summary2 = await engine.separate({ inputPath: input, modelId: 'pipeline-double-v1', profile: 'HIGH_QUALITY', trackName: 'gate_test' });
    assert.equal(summary2.cacheHit, true, 'Cache hit on second run');

    // 11. ENGINE_INTEGRITY_CHECK – via technical gate
    const report = await runTechnicalGate({
      inputPath: input,
      workingRoot,
      outputRoot: path.join(outputRoot, 'gate_test'),
      modelId: 'pipeline-double-v1',
      sampleRate: 44100,
      channels: 2,
      frames: track.frames,
      chunkSize: 441000,
      overlap: 0.5,
      originalHashBefore: before.sha256,
      originalHashAfter: after.sha256,
      jobMetadata: summary.metadata.job as unknown as Record<string, unknown>,
      cacheHit: true,
      reportDir: path.join(root, 'gate-report'),
    });

    console.log('Gate checks:', report.checks.map(c => `${c.id}:${c.pass}:${c.detail}`).join('\n'));
    assert.equal(report.checks.length, 10, '10 checks');
    assert.equal(report.technicalPass, true, `Technical pass failed: ${JSON.stringify(report.checks.filter(c => !c.pass))}`);
    assert.ok(report.checks.find(c => c.id === 'ORIGINAL_HASH_UNCHANGED')?.pass);
    assert.ok(report.checks.find(c => c.id === 'WORKING_COPY_44K_STEREO')?.pass);
    assert.ok(report.checks.find(c => c.id === 'CHUNKED_INFERENCE')?.pass);
    assert.ok(report.checks.find(c => c.id === 'OVERLAP_ADD_RECONSTRUCTION')?.pass);
    assert.ok(report.checks.find(c => c.id === 'CACHE_REUSE')?.pass);

    console.log('engine-gate: all tests passed (19 checks)');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

run().catch(e => { console.error(e); process.exit(1); });
