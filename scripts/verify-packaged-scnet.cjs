'use strict';
// Execute with the packaged Electron's ELECTRON_RUN_AS_NODE=1 runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

function wavInfo(bytes) {
  const b = Buffer.from(bytes);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  let format, data;
  for (let p = 12; p + 8 <= b.length;) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') format = { code: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), sampleRate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  assert.equal(format?.code, 3, 'Float32 WAV');
  assert.equal(format.bits, 32);
  assert.ok(data?.length);
  let energy = 0;
  for (let i = 0; i < data.length; i += 4) {
    const sample = data.readFloatLE(i);
    assert.ok(Number.isFinite(sample)); energy += sample * sample;
  }
  return { channels: format.channels, sampleRate: format.sampleRate, frames: data.length / 4 / format.channels, rms: Math.sqrt(energy / (data.length / 4)) };
}

(async () => {
  const [bundlePath, inputPath, outPath] = process.argv.slice(2);
  const { createStemBridge } = require(path.resolve(bundlePath));
  const root = path.resolve(outPath);
  await fs.mkdir(root, { recursive: true });
  const input = await fs.readFile(inputPath);
  const originalHash = createHash('sha256').update(input).digest('hex');
  const original = wavInfo(input);
  const bridge = createStemBridge({ root, modelStoreDir: path.join(process.env.APPDATA, 'airdox_SMART_Editor/stems/Models'), mode: 'fast_dj', device: 'cpu' });
  const start = performance.now();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 100);
  try {
    const accepted = await bridge.start({ bytes: input, trackName: 'packaged-scnet-real-inference', modelId: 'scnet-onnx-4stem-int8', family: 'scnet', profile: 'PREVIEW', device: 'cpu' });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const finished = await bridge.wait(accepted.data.jobId);
    assert.equal(finished.ok, true, JSON.stringify(finished));
    assert.equal(finished.data.status, 'COMPLETED', JSON.stringify(finished));
    assert.equal(finished.data.cacheHit, false, 'Fresh model inference required');
    const stems = [];
    for (const id of ['vocals', 'drums', 'bass', 'other']) {
      const response = await bridge.stem(accepted.data.jobId, id);
      assert.equal(response.ok, true);
      const info = wavInfo(response.data.wav);
      assert.equal(info.channels, original.channels);
      assert.equal(info.sampleRate, original.sampleRate);
      assert.equal(info.frames, original.frames);
      assert.ok(info.rms > 1e-8);
      stems.push({ id, ...info, sha256: createHash('sha256').update(response.data.wav).digest('hex') });
    }
    assert.equal(new Set(stems.map(s => s.sha256)).size, 4);
    assert.equal(createHash('sha256').update(await fs.readFile(inputPath)).digest('hex'), originalHash);
    assert.ok(ticks > 10, 'Main thread stays responsive');
    const report = { pass: true, electron: process.versions.electron, bundlePath, originalHash, elapsedMs: performance.now() - start, ticks, original, stems, job: finished.data };
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`PASS packaged SCNet: four distinct aligned stems, ${ticks} host ticks, ${Math.round(report.elapsedMs)} ms`);
  } finally { clearInterval(timer); bridge.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
