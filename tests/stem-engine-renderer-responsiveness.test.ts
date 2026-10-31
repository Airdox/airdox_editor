import { applyStemResultIfCurrent } from '../src/audio/stemResultGuard';
import assert from 'node:assert/strict';
import { encodeStemInputWav, prepareStemInput } from '../src/audio/stemInput';
import { withStemPreflightTimeout } from '../src/audio/stemPreflight';
import { stemEngine } from '../src/audio/stemEngine';
import { makeAudioBuffer } from './support/editingHarness';

const samples = new Float32Array(400_000);
samples[0] = 0.5;
samples[131_073] = -0.25;
samples[samples.length - 1] = 0.75;
const audio = makeAudioBuffer(samples, 44_100);
let beats = 0;
const heartbeat = setInterval(() => beats++, 0);
const prepared = await prepareStemInput(audio);
clearInterval(heartbeat);
assert.ok(beats >= 2, 'PCM preparation must yield to progress paint and input events between chunks');
assert.deepEqual(prepared.wav, encodeStemInputWav(audio), 'chunked output must remain byte-exact canonical stereo WAV');

const cancelled = { aborted: false };
const preparing = prepareStemInput(audio, { signal: cancelled });
setTimeout(() => { cancelled.aborted = true; }, 0);
await assert.rejects(preparing, (error: any) => error.code === 'INFERENCE_CANCELLED');

assert.equal(await withStemPreflightTimeout(Promise.resolve('ready'), 10), 'ready');
await assert.rejects(withStemPreflightTimeout(Promise.reject(new Error('IPC disconnected')), 20), /IPC disconnected/);
await assert.rejects(withStemPreflightTimeout(new Promise(() => {}), 5), /Stem-Engine antwortet nicht/);
assert.equal(await withStemPreflightTimeout(Promise.resolve('retry works'), 10), 'retry works');
const preflightSignal = { aborted: false };
const blockedPreflight = withStemPreflightTimeout(new Promise(() => {}), 30_000, preflightSignal);
preflightSignal.aborted = true;
await assert.rejects(blockedPreflight, (error: any) => error.code === 'INFERENCE_CANCELLED');

// Cancel must be accepted even before the renderer has a backend job ID.
const pending = stemEngine.separateWithEngine(audio, 'cancel-before-job', 'original', {});
assert.equal(stemEngine.cancelActiveEngineJob(), true, 'preparation has an immediate cancellation token');
await assert.rejects(pending, (error: any) => error.code === 'INFERENCE_CANCELLED');
assert.equal(stemEngine.getIsProcessing(), false, 'cancellation releases processing lock');
assert.equal(stemEngine.cancelActiveEngineJob(), false, 'completed cancellation leaves no stale job');

let resolveStart!: (value: any) => void;
let calledStart!: () => void;
const startCalled = new Promise<void>((resolve) => { calledStart = resolve; });
let cancelledJob: string | undefined;
let waitCalls = 0;
(globalThis as any).window = { rekordboxDesktop: { stemEngine: {
  startStemJob: () => { calledStart(); return new Promise((resolve) => { resolveStart = resolve; }); },
  cancelStemJob: async (jobId: string) => { cancelledJob = jobId; return { ok: true }; },
  waitStemJob: async () => { waitCalls++; throw new Error('must not wait or import after cancel'); },
} } };
try {
  const raced = stemEngine.separateWithEngine(audio, 'cancel-during-start', 'original', {});
  await startCalled;
  assert.equal(stemEngine.cancelActiveEngineJob(), true);
  resolveStart({ ok: true, data: { jobId: 'created-after-cancel' } });
  await assert.rejects(raced, (error: any) => error.code === 'INFERENCE_CANCELLED');
  assert.equal(cancelledJob, 'created-after-cancel', 'job created after cancellation is cancelled on the backend');
  assert.equal(waitCalls, 0, 'cancelled job is never waited on or imported');
  assert.equal(stemEngine.getIsProcessing(), false);
} finally {
  delete (globalThis as any).window;
}
console.log('Renderer STEM responsiveness: heartbeat, byte equality, cancel preparation/start race, readiness failure/timeout/retry passed.');

// Successful output import keeps PCM as AudioBuffer references. Full IPC WAV
// buffers are passed directly to the decoder; only subviews are copied.
const fullWav = new Uint8Array([1, 2, 3, 4]);
const partialWav = new Uint8Array([9, 5, 6, 9]).subarray(1, 3);
const decodedArguments: ArrayBuffer[] = [];
const decoded = makeAudioBuffer(Float32Array.from([0.5, -0.5]), 44_100);
const job = { jobId: 'import-output', status: 'COMPLETED', modelId: 'scnet-trained', stems: ['vocals', 'drums', 'bass', 'other'], result: { trainedModel: true } };
(globalThis as any).window = {
  AudioContext: class {
    async decodeAudioData(bytes: ArrayBuffer) { decodedArguments.push(bytes); return decoded; }
    async close() {}
  },
  rekordboxDesktop: { stemEngine: {
    startStemJob: async () => ({ ok: true, data: job }),
    waitStemJob: async () => ({ ok: true, data: job }),
    readStemJobStem: async (_job: string, stem: string) => ({ ok: true, data: { wav: stem === 'drums' ? partialWav : fullWav } }),
  } },
};
try {
  const progress: number[] = [];
  const result = await stemEngine.separateWithEngine(audio, 'import-track', 'original', { onProgress: (p) => progress.push(p.percent) });
  assert.equal(result.vocals, decoded);
  assert.equal(result.stemsById?.vocals, decoded, 'state and channel map share the decoded PCM buffer');
  assert.equal(decodedArguments[0], fullWav.buffer, 'full WAV decode must not allocate a redundant track-sized copy');
  assert.notEqual(decodedArguments[1], partialWav.buffer);
  assert.deepEqual(new Uint8Array(decodedArguments[1]), new Uint8Array([5, 6]), 'subview decode excludes unrelated backing data');
  assert.equal(progress.at(-1), 100);
  assert.equal(stemEngine.getIsProcessing(), false);
} finally {
  delete (globalThis as any).window;
  stemEngine.clearCache();
}
console.log('Renderer output import: four channels, shared PCM references, bounded WAV copies and 100% progress passed.');

let applied = 0;
let currentTarget = { trackId: 'track-before', buffer: audio as AudioBuffer | null };
const submittedTarget = { ...currentTarget };
let finish!: () => void;
const inferenceDone = new Promise<void>((resolve) => { finish = resolve; });
const lateResult = inferenceDone.then(() => applyStemResultIfCurrent(currentTarget, submittedTarget, () => { applied++; }));
currentTarget = { trackId: 'track-after', buffer: audio };
finish();
assert.equal(await lateResult, false, 'old inference result cannot replace stems after a track switch');
assert.equal(applied, 0);
currentTarget = { trackId: 'track-before', buffer: decoded };
assert.equal(applyStemResultIfCurrent(currentTarget, submittedTarget, () => { applied++; }), false, 'edits to the working copy invalidate the old result too');
assert.equal(applied, 0);
currentTarget = submittedTarget;
assert.equal(applyStemResultIfCurrent(currentTarget, submittedTarget, () => { applied++; }), true);
assert.equal(applied, 1);
console.log('Renderer result ownership: late track-switch and edited-working-copy results cannot replace current stems.');
