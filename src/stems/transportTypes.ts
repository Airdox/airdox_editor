/**
 * Transport contract between the stem engine and the editor.
 *
 * These are the *only* shapes allowed to cross an IPC/HTTP boundary. They live
 * in their own module because both sides need them: the renderer (type-only
 * import, no Node dependencies) and `src/stems/stemJobService.ts` (the
 * implementation). Nothing here may import `node:*` – that is what keeps the
 * browser bundle free of the engine's file system code, and it is asserted by
 * `tests/stem-engine-ipc-contract.test.ts`.
 */
import type { ComputeDevice, JobStatus, QualityProfile, StemId } from './types';

/** Serializable per-stem result of a finished job. */
export interface StemJobStemView {
  id: StemId;
  displayName?: string;
  filePath: string;
  sha256: string;
  frames: number;
  sampleRate: number;
  channels: number;
  peak: number;
}

/** One separation job as the UI sees it. */
export interface StemJobView {
  jobId: string;
  /** Engine job id (`job_…`), known once the first progress event arrives. */
  engineJobId?: string;
  status: JobStatus;
  percent: number;
  phase: string;
  processedSeconds: number;
  totalSeconds: number;
  profile: QualityProfile;
  modelId: string;
  /** Stem ids exactly as the model descriptor declares them – never a constant. */
  stems: StemId[];
  chunkCount: number;
  cacheHit: boolean;
  trackName: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: { code: string; message: string };
  /** Set only for a COMPLETED job. */
  result?: {
    outputDir: string;
    metadataPath: string;
    stems: StemJobStemView[];
    validationPass: boolean;
    recombinationErrorDb?: number;
    originalUnchanged: boolean;
    trainedModel: boolean;
  };
}

/**
 * Rechengerät einer Separation. Bewusst derselbe Typ wie in der Engine
 * (`ComputeDevice`), damit UI und Engine nicht auseinanderlaufen –
 * `directml`/`coreml` sind die ONNX-GPU-Pfade.
 */
export type StemComputeDevice = ComputeDevice;

/** Validierungstiefe: live (schnell) oder Studio (volle Grenzanalyse). */
export type StemValidationMode = 'fast_dj' | 'studio_master';

export interface StemProfileInfo {
  profile: QualityProfile;
  modelId: string;
  family: string;
  stems: { id: StemId; displayName: string }[];
  available: boolean;
  reason?: string;
  description: string;
  parameters: { numOverlap: number; ensemblePasses: number };
}

export interface StemServiceStatus {
  ok: boolean;
  /** False when no profile can run (missing model or missing runtime). */
  usable: boolean;
  profiles: StemProfileInfo[];
  defaultProfile: QualityProfile;
  models: {
    id: string;
    family: string;
    version: string;
    /** Checkpoint format (`onnx` = läuft in-process, `safetensors-package`/`demucs-th` = Subprozess). */
    format?: string;
    installed: boolean;
    hashVerified: boolean;
    reason?: string;
    stems: StemId[];
    serves: QualityProfile[];
  }[];
  backends: { kind: string; name: string; available: boolean; reason?: string }[];
  /**
   * In-process ONNX runtime (DJ path): which execution providers the installed
   * `onnxruntime-node` can use and whether it loads at all. The settings menu
   * shows this instead of letting the user pick a device that cannot work.
   */
  onnx?: {
    runtimeAvailable: boolean;
    /** Chosen provider order, e.g. ['dml', 'cpu']. */
    providers: string[];
    /** Providers the shipped runtime carries, with bundle flag. */
    supported: { name: string; bundled: boolean }[];
    /** ONNX descriptor the DJ path would use, if the catalog has one. */
    modelId?: string;
    modelInstalled: boolean;
    reason?: string;
  };
  cacheEntries: { key: string; stems: number }[];
  roots: Record<'working' | 'output' | 'cache' | 'models' | 'staging', string>;
  registryIssues: unknown[];
  accessMode: 'ORIGINALS_READ_ONLY';
}

export type StemServiceEventType = 'progress' | 'completed' | 'cancelled' | 'failed';

export interface StemServiceEvent {
  type: StemServiceEventType;
  job: StemJobView;
}

export interface StartStemJobPayload {
  /** WAV bytes of the working copy; staged by the engine, never next to the original. */
  bytes?: Uint8Array;
  /** Alternative to `bytes`: a file inside the engine data directory. */
  inputPath?: string;
  trackName?: string;
  profile?: QualityProfile;
  /**
   * Explicit model/architecture. Wins over the profile default – that is what
   * the settings menu sends when the user pinned an architecture.
   */
  modelId?: string;
  stems?: StemId[];
  device?: StemComputeDevice;
  /** Validation depth for this job. `fast_dj` skips the boundary analysis. */
  mode?: StemValidationMode;
  precision?: 'native' | 'f32' | 'f16' | 'bf16' | 'q8_0';
  overlap?: number;
  chunkSizeSamples?: number;
  clipMode?: 'none' | 'rescale';
  dcRemoval?: boolean;
}

/**
 * Bridge results: a rejected promise over IPC loses its error code, so every
 * failure is a *value* here. `data` is a single nested field on purpose – an
 * intersection like `{ ok: true } & T` cannot be narrowed by `if (!result.ok)`
 * whenever `T` itself carries a boolean, and that narrowing is exactly what the
 * renderer relies on.
 */
export type StemBridgeError = { ok: false; code: string; message: string; details?: Record<string, unknown> };
export type StemBridgeResult<T> = { ok: true; data: T } | StemBridgeError;

/**
 * What `electron/preload.cjs` exposes and what `src/audio/stemEngine.ts`
 * expects. Kept as one interface so a missing method is a compile error rather
 * than a runtime `is not a function`.
 */
export interface StemDesktopApi {
  getStemEngineStatus(): Promise<StemBridgeResult<StemServiceStatus>>;
  startStemJob(payload: StartStemJobPayload): Promise<StemBridgeResult<StemJobView>>;
  waitStemJob(jobId: string): Promise<StemBridgeResult<StemJobView>>;
  getStemJob(jobId: string): Promise<StemBridgeResult<StemJobView | null>>;
  listStemJobs(): Promise<StemBridgeResult<StemJobView[]>>;
  cancelStemJob(jobId: string, reason?: string): Promise<StemBridgeResult<{ accepted: boolean }>>;
  pauseStemJob(jobId: string): Promise<StemBridgeResult<{ accepted: boolean }>>;
  resumeStemJob(jobId: string): Promise<StemBridgeResult<{ accepted: boolean }>>;
  readStemJobStem(jobId: string, stemId: StemId): Promise<StemBridgeResult<{ stemId: StemId; wav: Uint8Array }>>;
  readStemJobMetadata(jobId: string): Promise<StemBridgeResult<{ metadata: unknown }>>;
  onStemJobProgress(listener: (event: StemServiceEvent) => void): () => void;
}
