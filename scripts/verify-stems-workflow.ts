import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createStemBridge } from '../src/stems/nodeBridge';
import { readWavFile, encodeWavFloat32 } from '../src/stems/wavIo';

// Real installed weights + existing mixed audio. No synthetic separator or
// injected backend is permitted in this acceptance run.
const installed = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming'), 'airdox_SMART_Editor/stems');
const output = path.resolve(process.argv[2] ?? 'artifacts/stem-workflow');
await mkdir(output, { recursive: true });
const inputPath = process.argv[3] ?? path.join(installed, 'Staging', (await readdir(path.join(installed, 'Staging'))).find(file => file.endsWith('.wav'))!);
const originalBytes = await readFile(inputPath);
const originalHash = createHash('sha256').update(originalBytes).digest('hex');
const audio = await readWavFile(inputPath);
const seconds = Number(process.env.STEM_VERIFY_SECONDS ?? 12);
assert.ok(Number.isFinite(seconds) && seconds > 0);
const frames = Math.min(audio.frames, Math.floor(audio.sampleRate * seconds));
const input = encodeWavFloat32(audio.sampleRate, audio.channels, audio.data.slice(0, frames * audio.channels), frames);
await writeFile(path.join(output, 'mixture.wav'), input);
const bridge = createStemBridge({ root: output, modelStoreDir: path.join(installed, 'Models'), mode: 'fast_dj', device: 'cpu' });
const events: unknown[] = [];
bridge.onEvent(event => { events.push(event); console.log(JSON.stringify(event)); });
const started = Date.now();
let lastTick = started, maxLagMs = 0, ticks = 0;
const timer = setInterval(() => { const now = Date.now(); maxLagMs = Math.max(maxLagMs, now - lastTick - 100); lastTick = now; ticks++; }, 100);
try {
  const accepted = await bridge.start({ bytes: input, trackName: 'real-mix-acceptance', modelId: 'scnet-onnx-4stem-int8', family: 'scnet', profile: 'PREVIEW', device: 'cpu' });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const done = await bridge.wait(accepted.data.jobId);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.data.status, 'COMPLETED', JSON.stringify(done.data));
  assert.equal(done.data.cacheHit, false, 'Frische Inferenz erforderlich');
  const stems = [];
  for (const stemId of ['drums', 'bass', 'other', 'vocals']) {
    const response = await bridge.stem(accepted.data.jobId, stemId);
    assert.equal(response.ok, true, JSON.stringify(response));
    const target = path.join(output, `${stemId}.wav`);
    await writeFile(target, response.data.wav);
    const decoded = await readWavFile(target);
    assert.equal(decoded.frames, Math.round(frames * 44100 / audio.sampleRate));
    assert.equal(decoded.sampleRate, 44100);
    assert.equal(decoded.channels, 2);
    assert.ok(decoded.data.every(Number.isFinite));
    const rms = Math.sqrt(decoded.data.reduce((sum, value) => sum + value * value, 0) / decoded.data.length);
    assert.ok(rms > 1e-8, `${stemId} darf nicht stumm sein`);
    stems.push({ stemId, path: target, frames: decoded.frames, sampleRate: decoded.sampleRate, rms, bytes: response.data.wav.length, sha256: createHash('sha256').update(response.data.wav).digest('hex') });
  }
  assert.equal(new Set(stems.map(stem => stem.sha256)).size, 4);
  assert.equal(createHash('sha256').update(await readFile(inputPath)).digest('hex'), originalHash);
  assert.ok(ticks > 5, 'Main-Host Eventloop muss während Inferenz weiterlaufen');
  const evidence = { passed: true, createdAt: new Date().toISOString(), inputPath, originalSha256: originalHash, originalUnchanged: true, model: 'scnet-onnx-4stem-int8', realInference: true, durationSeconds: frames / audio.sampleRate, elapsedMs: Date.now() - started, hostTicks: ticks, maxHostLagMs: maxLagMs, job: done.data, stems };
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS real STEM workflow: ${stems.length} decodable distinct stems, ${ticks} host ticks, max lag ${maxLagMs} ms`);
} finally {
  clearInterval(timer); bridge.close();
  await writeFile(path.join(output, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(path.join(output, 'host-metrics.json'), JSON.stringify({ hostTicks: ticks, maxHostLagMs: maxLagMs, elapsedMs: Date.now() - started }, null, 2));
}
