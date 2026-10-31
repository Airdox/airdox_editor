import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createStemBridge } from '../src/stems/nodeBridge';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { readWavFile } from '../src/stems/wavIo';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.resolve(process.env.STEM_MATRIX_OUTPUT ?? path.join(repo, 'artifacts/stem-model-matrix-20261030'));
await mkdir(output, { recursive: true });
const input = path.join(repo, 'artifacts/stem-workflow-final-20261030/mixture.wav');
const installed = path.join(process.env.APPDATA!, 'airdox_SMART_Editor/stems');
const models = process.env.STEM_MATRIX_MODELS?.split(',') ?? ['bsroformer-musdb18hq-4stem-zfturbo', 'bsroformer-viperx-vocals-1297', 'melbandroformer-viperx-vocals-3005', 'htdemucs-ft-4stem', 'htdemucs-onnx-4stem-fp16'];
const maxMsPerModel = Number(process.env.STEM_MATRIX_TIMEOUT_MS ?? 180000);

if (process.argv[2] === '--child') {
  const modelId = process.argv[3];
  const descriptor = ModelRegistry.fromBundledCatalog().require(modelId);
  const requireHere = createRequire(import.meta.url);
  const { resolveEnginePaths } = requireHere('../electron/stemEngineBridge.cjs');
  const paths = resolveEnginePaths(repo, installed);
  const root = path.join(output, modelId);
  const started = Date.now();
  const bridge = createStemBridge({ ...paths, root, mode: 'fast_dj', device: 'cpu' });
  const events: unknown[] = [];
  bridge.onEvent(event => { events.push(event); console.log(JSON.stringify(event)); });
  let evidence: Record<string, unknown>;
  try {
    const accepted = await bridge.start({ bytes: await readFile(input), modelId, family: descriptor.family, profile: descriptor.qualityProfile.serves.includes('PREVIEW') ? 'PREVIEW' : 'BALANCED', trackName: `matrix-${modelId}`, device: 'cpu', precision: 'f32' });
    if (accepted.ok === false) throw Object.assign(new Error(accepted.message), { code: accepted.code });
    const done = await bridge.wait(accepted.data.jobId);
    if (done.ok === false) throw Object.assign(new Error(done.message), { code: done.code });
    assert.equal(done.data.status, 'COMPLETED', JSON.stringify(done.data.error));
    assert.equal(done.data.cacheHit, false);
    const stems = [];
    for (const stemId of descriptor.outputStems) {
      const result = await bridge.stem(accepted.data.jobId, stemId);
      if (result.ok === false) throw new Error(result.message);
      const target = path.join(root, `${stemId}.wav`);
      await writeFile(target, result.data.wav);
      const decoded = await readWavFile(target);
      assert.equal(decoded.channels, 2);
      assert.equal(decoded.frames, 88200);
      assert.equal(decoded.sampleRate, 44100);
      assert.ok(decoded.data.every(Number.isFinite));
      stems.push({ stemId, path: target, frames: decoded.frames, channels: decoded.channels, sampleRate: decoded.sampleRate, sha256: createHash('sha256').update(result.data.wav).digest('hex') });
    }
    assert.equal(stems.length, descriptor.outputStems.length);
    assert.equal(new Set(stems.map(stem => stem.sha256)).size, stems.length);
    evidence = { status: 'pass', modelId, elapsedMs: Date.now() - started, job: done.data, stems };
  } catch (error) {
    evidence = { status: 'error', modelId, elapsedMs: Date.now() - started, code: (error as any).code, error: error instanceof Error ? error.message : String(error), remediation: 'Siehe Fehlertext und events.json; keine erfolgreiche Modelltrennung behauptet.' };
  } finally { bridge.close(); }
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} else {
  const matrix = [];
  for (const modelId of models) {
    const root = path.join(output, modelId);
    await mkdir(root, { recursive: true });
    const result = await new Promise<{ code: number | null; timeout: boolean; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--child', modelId], { cwd: repo, windowsHide: true, env: process.env });
      let stdout = '', stderr = '', timeout = false;
      const timer = setTimeout(() => {
        timeout = true;
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      }, maxMsPerModel);
      child.stdout.on('data', chunk => { stdout += chunk.toString(); appendFileSync(path.join(root, 'live.log'), chunk); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, timeout, stdout, stderr }); });
      child.on('error', error => { clearTimeout(timer); resolve({ code: null, timeout, stdout, stderr: error.message }); });
    });
    await writeFile(path.join(root, 'process.log'), result.stdout + '\nSTDERR\n' + result.stderr);
    let evidence;
    try { evidence = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8')); }
    catch { evidence = { status: result.timeout ? 'timeout' : 'error', modelId, error: result.timeout ? `${maxMsPerModel / 1000}s deadline reached; child process tree terminated` : result.stderr, exitCode: result.code }; }
    matrix.push(evidence);
    await writeFile(path.join(output, 'matrix-evidence.json'), JSON.stringify({ createdAt: new Date().toISOString(), input, inputSeconds: 2, maxMsPerModel, models: matrix }, null, 2));
    console.log(`${modelId}: ${evidence.status}: ${evidence.error ?? evidence.elapsedMs + ' ms'}`);
  }
}
