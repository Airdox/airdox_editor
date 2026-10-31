import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type separateFnType from '@audio/neural-separate';
import type { CancellationToken } from '../chunkProcessor';
import { StemSeparationError } from '../errors';

type SeparateResult = Pick<Awaited<ReturnType<typeof separateFnType>>, 'stems'>;

// Keep the worker self contained so the source, server bundle and packaged
// Electron bridge use exactly the same path without a second build artifact.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const control = new Int32Array(workerData.controlBuffer);
(async () => {
  const separate = (await import(workerData.moduleUrl)).default;
  // Supply the native runtime's session options through the library's loader
  // hook. Functions cannot cross workerData, so create this hook in the worker.
  const session = workerData.runtimeModuleUrl
    ? async spec => (await import(workerData.runtimeModuleUrl)).load(spec, {
        backend: 'node', sessionOptions: workerData.options.sessionOptions,
      })
    : undefined;
  const result = await separate(workerData.channels, {
    ...workerData.options,
    ...(session ? { session } : {}),
    progress: (event) => {
      // Pause at model segment boundaries; a native session already running
      // finishes its segment, while the host remains responsive throughout.
      while (Atomics.load(control, 0) === 1) Atomics.wait(control, 0, 1);
      parentPort.postMessage({ type: 'progress', event });
    },
  });
  const transfers = [...new Set(Object.values(result.stems).flat().map(c => c.buffer))];
  parentPort.postMessage({ type: 'result', result: { stems: result.stems } }, transfers);
})().catch(error => parentPort.postMessage({ type: 'error', message: error.message, stack: error.stack }));
`;

/** CPU STFT/iSTFT must never monopolize Electron's IPC/event loop. */
export function runScnetWorker(
  channels: Float32Array[],
  options: Record<string, unknown>,
  token?: CancellationToken,
  onProgress?: (event: { chunk: number; totalChunks: number }) => void,
  moduleUrl?: string,
): Promise<SeparateResult> {
  token?.throwIfCancelled();
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const control = new Int32Array(controlBuffer);
  Atomics.store(control, 0, token?.paused ? 1 : 0);
  const requireHere = createRequire(typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'package.json'));
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      channels, options, controlBuffer,
      moduleUrl: moduleUrl ?? pathToFileURL(requireHere.resolve('@audio/neural-separate')).href,
      runtimeModuleUrl: !moduleUrl && options.sessionOptions
        ? pathToFileURL(createRequire(requireHere.resolve('@audio/neural-separate')).resolve('@audio/neural-runtime')).href : undefined,
    },
    transferList: channels.map(channel => channel.buffer as ArrayBuffer),
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: SeparateResult) => {
      if (settled) return;
      settled = true;
      clearInterval(cancellation);
      // Native sessions and FFT caches belong to this job, not the UI host.
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result!);
    };
    const cancellation = setInterval(() => {
      if (token?.cancelled) finish(new StemSeparationError('INFERENCE_CANCELLED', token.reason ?? 'Separation abgebrochen'));
      Atomics.store(control, 0, token?.paused ? 1 : 0);
      if (!token?.paused) Atomics.notify(control, 0);
    }, 50);
    worker.on('message', (message) => {
      if (settled) return;
      if (message.type === 'result') finish(undefined, message.result);
      else if (message.type === 'error') finish(new StemSeparationError('INFERENCE_FAILED', `SCNet: ${message.message}`));
      else if (message.type === 'progress') {
        try { onProgress?.(message.event); } catch (error) { finish(error); }
      }
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => {
      if (!settled) finish(new StemSeparationError('INFERENCE_FAILED', `SCNet-Worker ohne Ergebnis beendet (Exit ${code}).`));
    });
  });
}
