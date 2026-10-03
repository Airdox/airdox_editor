import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StemJobService } from '../../src/stems/stemJobService';
import { RemoteStemJobService } from '../../src/stems/remote/remoteStemJobService';
import { FolderTransport } from '../../src/stems/remote/transport';
import { decodeWav, encodeWavFloat32, sha256Bytes } from '../../src/stems/wavIo';

export const MODEL = 'bsroformer-musdb18hq-4stem-zfturbo';
export const python = process.env.AIRODOX_STEM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
export async function runPython(args: string[], timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(python, args, { env: { ...globalThis.process.env, OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' } });
    let log = '';
    process.stdout.on('data', (chunk) => { log += chunk; });
    process.stderr.on('data', (chunk) => { log += chunk; });
    const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new Error(`Python timeout: ${log}`)); }, timeout);
    process.once('error', (error) => { clearTimeout(timer); reject(error); });
    process.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve(log) : reject(new Error(`Python exit ${code}: ${log}`)); });
  });
}
export async function makeHarness(rate = 44100, realAudio = false) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'airdox-python-remote-'));
  const root = path.join(base, 'editor');
  const drive = path.join(base, 'drive');
  await mkdir(drive);
  const original = path.join(base, 'original.wav');
  let frames = rate / 2;
  let data = Float32Array.from({ length: frames * 2 }, (_, i) => Math.sin(Math.floor(i / 2) / 20) * .1);
  if (realAudio) {
    const decoded = decodeWav(await readFile('tests/fixtures/musdb-falcon69/mixture.wav'));
    frames = rate * 2;
    data = new Float32Array(frames * 2);
    for (let frame = 0; frame < frames; frame++) {
      const source = Math.min(decoded.frames - 1, Math.floor(frame * decoded.sampleRate / rate));
      for (let c = 0; c < 2; c++) data[frame * 2 + c] = decoded.data[source * decoded.channels + c];
    }
  }
  const bytes = encodeWavFloat32(rate, 2, data, frames);
  await writeFile(original, bytes);
  const before = sha256Bytes(bytes);
  const local = new StemJobService({ root });
  const transport = new FolderTransport({ root: drive });
  let now = Date.now();
  const settings = { outputSyncWaitMs: 1000, workerWaitMs: 10000, workerLeaseMs: 3000, jobTimeoutMs: 1200000 };
  const create = () => new RemoteStemJobService({ root, localService: local, transport, settings, disableBackgroundPolling: true, now: () => now });
  let remote = create();
  return {
    base, root, drive, original, before, transport, local, settings,
    get remote() { return remote; },
    advance(ms: number) { now += ms; },
    async restart() { remote.dispose(); remote = create(); await remote.resume(); },
    async start() { return remote.start({ inputPath: original, modelId: MODEL, profile: 'HIGH_QUALITY', trackName: 'protocol-test' }); },
    async worker() { return runPython(['tests/fixtures/remote/run_worker.py', drive, path.join(base, 'worker')]); },
    async verify(jobId: string) {
      const status = await remote.poll();
      const job = status.jobs.find((j) => j.jobId === jobId)!;
      assert.equal(job.status, 'COMPLETED', JSON.stringify(job));
      assert.equal(job.importedStems?.length, 4);
      for (const stem of job.importedStems!) {
        const raw = await readFile(stem.filePath);
        assert.equal(sha256Bytes(raw), stem.sha256);
        const decoded = decodeWav(raw);
        assert.equal(decoded.sampleRate, rate);
        assert.equal(decoded.frames, frames);
        assert.equal(decoded.channels, 2);
      }
      assert.equal(sha256Bytes(await readFile(original)), before, 'original is unchanged');
      return job;
    },
    async dispose() { remote.dispose(); await rm(base, { recursive: true, force: true }); },
  };
}
