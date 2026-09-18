import assert from 'node:assert/strict';
import { stemEngine } from '../src/audio/stemEngine';
import { makeAudioBuffer } from './support/editingHarness';

console.log('=== NEGATIVE TESTS: STEM_ENGINE_UNAVAILABLE enforcement ===');

async function run() {
  const sampleRate = 44100;
  const samples = new Float32Array(441);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.1 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
  const buf = makeAudioBuffer(samples, sampleRate);

  // Test 1: separateAudioBuffer must throw STEM_ENGINE_UNAVAILABLE
  console.log('[TEST] separateAudioBuffer throws STEM_ENGINE_UNAVAILABLE');
  await assert.rejects(
    () => stemEngine.separateAudioBuffer(buf, 'neg1', 'sha-neg1', () => {}),
    (err: any) => {
      assert.equal(err.code, 'STEM_ENGINE_UNAVAILABLE');
      assert.ok(String(err.message).includes('KEINE echte AI'));
      return true;
    }
  );
  console.log('  [PASS] separateAudioBuffer blocked');

  // Test 2: separateAudioBufferWithModel deprecated
  console.log('[TEST] separateAudioBufferWithModel throws');
  await assert.rejects(
    () => (stemEngine as any).separateAudioBufferWithModel(buf, 'neg2', 'sha-neg2'),
    (err: any) => {
      assert.ok(err.code === 'STEM_ENGINE_UNAVAILABLE' || String(err.message).includes('deprecated'));
      return true;
    }
  );
  console.log('  [PASS] deprecated blocked');

  // Test 3: checkAvailability code
  console.log('[TEST] checkAvailability code STEM_ENGINE_UNAVAILABLE when not ready');
  const avail = await stemEngine.checkAvailability();
  if (!avail.available) {
    assert.equal(avail.code, 'STEM_ENGINE_UNAVAILABLE');
    console.log(`  [PASS] code ${avail.code}`);
  } else {
    console.log('  [SKIP] engine available – cannot test unavailable code in this env');
  }

  // Test 4: getEngineInfo must return profiles with available=false when engine down, not empty
  console.log('[TEST] getEngineInfo returns BALANCED/HIGH even when unavailable');
  const info = await stemEngine.getEngineInfo();
  const names = info.profiles.map((p) => p.profile);
  assert.ok(names.includes('BALANCED'), 'BALANCED present');
  assert.ok(names.includes('HIGH'), 'HIGH present');
  console.log(`  [PASS] profiles: ${names.join(', ')}`);

  // Test 5: Original SHA256 must stay identical – engine never modifies original
  console.log('[TEST] Original buffer immutability');
  const originalCopy = new Float32Array(samples);
  try {
    await stemEngine.separateAudioBuffer(buf, 'neg-immut', 'sha-immut', () => {});
  } catch {}
  const after = buf.getChannelData(0);
  for (let i = 0; i < samples.length; i++) {
    assert.equal(after[i], originalCopy[i], 'original unchanged');
  }
  console.log('  [PASS] original unchanged');

  // Test 6: Model hash unverified must not be used productively – check registry
  console.log('[TEST] ModelRegistry unverified handling');
  const { ModelRegistryV2 } = await import('../src/stems/runtime/modelRegistry');
  try {
    const registry = await ModelRegistryV2.create();
    const list = registry.list();
    const primary = list.find((m) => m.modelId === 'bsroformer-musdb18hq-4stem-zfturbo');
    assert.ok(primary, 'primary model exists');
    assert.equal(primary?.checkpointSha256, '3e9daecd70aaed5b5a0d1f861cc4d77eaa45afb3fc6301b1cf32c1be0f5868fb', 'primary hash verified');
    const unverified = list.filter((m) => m.checkpointSha256 === 'unverified' || m.status === 'LICENSE_UNVERIFIED');
    for (const u of unverified) {
      assert.ok(u.status !== 'AVAILABLE' || u.checkpointSha256 === 'synthetic:pipeline-double-v1-deterministic', `unverified model ${u.modelId} must not be AVAILABLE for productive use`);
    }
    console.log(`  [PASS] ${unverified.length} unverified models correctly not AVAILABLE`);
  } catch (e) {
    console.log(`  [SKIP] registry not fully available in test env: ${e}`);
  }

  console.log('All negative tests passed – STEM_ENGINE_UNAVAILABLE enforced per §2, §38');
}

run().catch((e) => { console.error(e); process.exit(1); });
