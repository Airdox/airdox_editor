/**
 * Node bridge for the stem separation engine.
 *
 * `electron/main.cjs` is plain CommonJS and the engine is TypeScript, so the
 * main process cannot import `src/stems/*` directly. This file is the single
 * entry that gets bundled (`npm run build:stems-bridge` →
 * `dist/stems/node-bridge.cjs`) and it deliberately exposes only
 * structured-clone-safe data: job views, plain error objects and stem bytes.
 * No promises that reject with Error instances, no class instances, no
 * callbacks crossing the IPC boundary.
 *
 * `server.ts` imports `StemJobService` from the source directly (it is bundled
 * by esbuild anyway) – the browser/dev path and the desktop path therefore run
 * the same implementation, only the transport differs.
 */
import { StemJobService, type StemJobServiceOptions, type StartStemJobRequest } from './stemJobService';
import { clearRuntimeCaches } from './runtimeCaches';
import { RemoteStemJobService, type RemoteServiceEvent, type StartRemoteStemJobRequest } from './remote/remoteStemJobService';

export { clearRuntimeCaches };
import type {
  RemoteServiceStatus,
  RemoteSettings,
  RemoteStemJobView,
  StemBridgeError,
  StemBridgeResult,
  StemJobView,
  StemServiceStatus,
} from './transportTypes';
import { isStemError } from './errors';

/** Bumped whenever the IPC payload shape changes, so the renderer can refuse a stale bridge. */
export const STEM_BRIDGE_VERSION = 2;

function failure(error: unknown): StemBridgeError {
  if (isStemError(error)) {
    return { ok: false, code: error.code, message: error.message, details: error.details as Record<string, unknown> };
  }
  return { ok: false, code: 'INFERENCE_FAILED', message: error instanceof Error ? error.message : String(error) };
}

export interface StemBridge {
  version: number;
  status(): Promise<StemBridgeResult<StemServiceStatus>>;
  start(request: StartStemJobRequest): Promise<StemBridgeResult<StemJobView>>;
  wait(jobId: string): Promise<StemBridgeResult<StemJobView>>;
  job(jobId: string): StemBridgeResult<StemJobView | null>;
  jobs(): StemBridgeResult<StemJobView[]>;
  cancel(jobId: string, reason?: string): StemBridgeResult<{ accepted: boolean }>;
  pause(jobId: string): StemBridgeResult<{ accepted: boolean }>;
  resume(jobId: string): StemBridgeResult<{ accepted: boolean }>;
  stem(jobId: string, stemId: string): Promise<StemBridgeResult<{ stemId: string; wav: Uint8Array }>>;
  metadata(jobId: string): Promise<StemBridgeResult<{ metadata: unknown }>>;
  /** Attaches a listener for job events; returns the detach function. */
  onEvent(listener: (event: unknown) => void): () => void;

  /* --- High-Quality extern (Google Drive + Colab-Worker, §15) ------------- */
  remoteStatus(): Promise<StemBridgeResult<RemoteServiceStatus>>;
  startRemoteJob(request: StartRemoteStemJobRequest): Promise<StemBridgeResult<RemoteStemJobView>>;
  listRemoteJobs(): StemBridgeResult<RemoteStemJobView[]>;
  pollRemoteJobs(): Promise<StemBridgeResult<RemoteServiceStatus>>;
  cancelRemoteJob(jobId: string, reason?: string): Promise<StemBridgeResult<{ accepted: boolean }>>;
  resumeRemoteJobs(): Promise<StemBridgeResult<RemoteServiceStatus>>;
  configureRemoteJobs(settings: RemoteSettings): Promise<StemBridgeResult<RemoteServiceStatus>>;
  onRemoteEvent(listener: (event: unknown) => void): () => void;

  close(): void;
}

/**
 * Factory used by both `electron/stemEngineBridge.cjs` (through the bundle) and
 * the tests. `options.root` is the app data directory: the engine creates its
 * own `Working/`, `Separation/`, `Cache/`, `Models/` and `Staging/` below it.
 */
export function createStemBridge(options: StemJobServiceOptions): StemBridge {
  const service = new StemJobService(options);
  const listeners = new Set<(event: unknown) => void>();
  const detach = service.onEvent((event) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* a broken UI listener must never break a running job */
      }
    }
  });

  /*
   * Fernpfad (High Quality extern). Er hängt am selben Service: die Ergebnisse
   * werden später über `registerCompletedJob` in dessen Jobliste eingetragen,
   * sodass der Renderer sie über die bestehenden Kanäle liest (§42).
   */
  const remoteOptions = options as StemJobServiceOptions & {
    remote?: Omit<ConstructorParameters<typeof RemoteStemJobService>[0], 'root' | 'localService' | 'logger'>;
  };
  const remote = new RemoteStemJobService({
    root: options.root,
    localService: service,
    appVersion: process.env.npm_package_version ?? '0.4.2',
    env: options.env as Record<string, string | undefined> | undefined,
    registry: options.registry,
    allowPipelineDouble: options.allowPipelineDouble,
    logger: options.logger,
    ...(remoteOptions.remote ?? {}),
  });
  const remoteListeners = new Set<(event: unknown) => void>();
  const detachRemote = remote.onEvent((event: RemoteServiceEvent) => {
    for (const listener of remoteListeners) {
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
  });

  return {
    version: STEM_BRIDGE_VERSION,
    async status() {
      try {
        return { ok: true, data: await service.status() };
      } catch (error) {
        return failure(error);
      }
    },
    async start(request) {
      try {
        return { ok: true, data: await service.start(request) };
      } catch (error) {
        return failure(error);
      }
    },
    async wait(jobId) {
      try {
        return { ok: true, data: await service.waitFor(jobId) };
      } catch (error) {
        return failure(error);
      }
    },
    job(jobId) {
      try {
        return { ok: true, data: service.getJob(jobId) };
      } catch (error) {
        return failure(error);
      }
    },
    jobs() {
      return { ok: true, data: service.listJobs() };
    },
    cancel(jobId, reason) {
      return { ok: true, data: { accepted: service.cancel(jobId, reason) } };
    },
    pause(jobId) {
      return { ok: true, data: { accepted: service.pause(jobId) } };
    },
    resume(jobId) {
      return { ok: true, data: { accepted: service.resume(jobId) } };
    },
    async stem(jobId, stemId) {
      try {
        const bytes = await service.stemBytes(jobId, stemId);
        // A fresh Uint8Array view over a detached-safe copy: Node Buffers share
        // memory with the file cache, and IPC transfer must not alias it.
        return { ok: true, data: { stemId, wav: new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) } };
      } catch (error) {
        return failure(error);
      }
    },
    async metadata(jobId) {
      try {
        return { ok: true, data: { metadata: await service.jobMetadata(jobId) } };
      } catch (error) {
        return failure(error);
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async remoteStatus() {
      try {
        return { ok: true, data: await remote.status() };
      } catch (error) {
        return failure(error);
      }
    },
    async startRemoteJob(request) {
      try {
        return { ok: true, data: await remote.start(request) };
      } catch (error) {
        return failure(error);
      }
    },
    listRemoteJobs() {
      try {
        return { ok: true, data: remote.list() };
      } catch (error) {
        return failure(error);
      }
    },
    async pollRemoteJobs() {
      try {
        return { ok: true, data: await remote.poll() };
      } catch (error) {
        return failure(error);
      }
    },
    async cancelRemoteJob(jobId, reason) {
      try {
        return { ok: true, data: await remote.cancel(jobId, reason) };
      } catch (error) {
        return failure(error);
      }
    },
    async resumeRemoteJobs() {
      try {
        return { ok: true, data: await remote.resume() };
      } catch (error) {
        return failure(error);
      }
    },
    async configureRemoteJobs(settings) {
      try {
        return { ok: true, data: await remote.configure(settings) };
      } catch (error) {
        return failure(error);
      }
    },
    onRemoteEvent(listener) {
      remoteListeners.add(listener);
      return () => remoteListeners.delete(listener);
    },
    close() {
      detach();
      detachRemote();
      remote.dispose();
      listeners.clear();
      remoteListeners.clear();
    },
  };
}

export { StemJobService };
export default createStemBridge;
