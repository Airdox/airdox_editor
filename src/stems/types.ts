/**
 * StemSeparationEngine – core contracts.
 *
 * This module (and every other file under `src/stems/`) is GUI-free. It never
 * imports React, `window`, Electron or the audio engine of the editor, so the
 * whole separation pipeline can be driven headlessly from `node`/`tsx`.
 *
 * Design rules enforced by these types:
 *  - Models are data, not code. Everything model specific lives in a
 *    {@link ModelDescriptor} that comes from the {@link ModelRegistry}.
 *  - The stem order is *never* assumed. `stemOrder[i]` is the stem produced at
 *    model output index `i`; a backend must map its files through it.
 *  - Every separation is a job with fully reproducible metadata.
 */

/** Trained model families. BS-RoFormer is the primary high-quality engine. */
export type ModelFamily =
  | 'bs_roformer'
  | 'mel_band_roformer'
  | 'htdemucs'
  | 'pipeline_double';

/**
 * How the weights are executed.
 * - `native-cli`  : native C++ binary (audio.cpp / BSRoformer.cpp style)
 * - `python-torch`: Python + PyTorch runtime (development / offline tests)
 * - `in-process`  : inside this process (contract double for automated tests)
 * - `onnx`        : ONNX Runtime inside this process – GPU via DirectML/CUDA/
 *                   CoreML, no Python, no subprocess, no chunk files on disk
 */
export type BackendKind = 'native-cli' | 'python-torch' | 'in-process' | 'onnx';

/** Weight storage precision. Mirrors the modes exposed by native runtimes. */
export type ModelPrecision = 'native' | 'f32' | 'f16' | 'bf16' | 'q8_0';

/**
 * Requested compute device.
 * `directml` is the Windows DX12 path (AMD/NVIDIA/Intel), `coreml` the Apple
 * path – the ONNX backend maps both onto its execution providers.
 */
export type ComputeDevice = 'auto' | 'cpu' | 'cuda' | 'vulkan' | 'metal' | 'directml' | 'coreml';

/**
 * Processing mode (§ new, DJ path).
 *
 * - `studio_master`: full validation – boundary metrics, recombination check,
 *   continuity measurement. Slow, but every artefact is reported.
 * - `fast_dj`: validation reduced to the checks that actually protect the user
 *   (file geometry, finite samples, peak, non-silence). Meant for live work
 *   where a stem must be there in seconds.
 */
export type ProcessingMode = 'fast_dj' | 'studio_master';

export const PROCESSING_MODES: ProcessingMode[] = ['fast_dj', 'studio_master'];

/**
 * Quality profiles – per §23.
 * PREVIEW trades quality for speed,
 * BALANCED is balanced,
 * HIGH uses BS-RoFormer with recommended parameters,
 * HIGH_QUALITY is alias for HIGH (legacy),
 * MAXIMUM_QUALITY pushes overlap/ensemble.
 */
export type QualityProfile = 'PREVIEW' | 'BALANCED' | 'HIGH' | 'HIGH_QUALITY' | 'MAXIMUM_QUALITY';

export const QUALITY_PROFILES: QualityProfile[] = ['PREVIEW', 'BALANCED', 'HIGH', 'HIGH_QUALITY', 'MAXIMUM_QUALITY'];

/** A stem id is dynamic – it is whatever the model descriptor declares. */
export type StemId = string;

export type CheckpointFormat =
  | 'gguf'
  | 'safetensors-package'
  | 'pytorch-ckpt'
  | 'yaml'
  | 'demucs-th'
  | 'onnx'
  | 'synthetic';

export interface ModelCheckpointRef {
  /** File name inside the local model store (never an absolute path). */
  file: string;
  format: CheckpointFormat;
  /** Optional download location used by `ModelManager.ensureAvailable()`. */
  url?: string;
  sha256?: string;
  bytes?: number;
}

/**
 * Which quality profiles a model is allowed to serve, and with which
 * parameters. Kept in the descriptor so quality settings stay data driven.
 */
export interface QualityProfileSpec {
  /** Profiles this model may be selected for. */
  serves: QualityProfile[];
  /** num_overlap (model passes) per profile. Higher = better boundaries. */
  numOverlap: Partial<Record<QualityProfile, number>>;
  /** Additional inference passes / ensemble members for MAXIMUM_QUALITY. */
  ensemblePasses?: Partial<Record<QualityProfile, number>>;
  /** Free-form rationale, surfaced in the job metadata. */
  rationale?: string;
}

export interface ModelDescriptor {
  id: string;
  family: ModelFamily;
  /** New field per §4 */
  architecture?: string;
  version: string;
  checkpoint: ModelCheckpointRef;
  /** Architecture config (YAML/JSON) required by PyTorch style runtimes. */
  config?: ModelCheckpointRef;
  /** New fields per §4 */
  checkpointSha256?: string;
  supportedStems?: StemId[];
  sourceUrl?: string;
  weightLicense?: string;
  licenseUrl?: string;
  sampleRate: number;
  /** Channels the model consumes. 2 = native stereo, no downmixing. */
  inputChannels: number;
  /** Canonical stem ids this model can produce. */
  outputStems: StemId[];
  /**
   * Stem id per model output index. `stemOrder[2]` is what the model emits at
   * output index 2. This is the single source of truth for output mapping.
   */
  stemOrder: StemId[];
  stemDisplayNames: Record<StemId, string>;
  /** sha256 of the checkpoint; part of the cache key and the job metadata. */
  modelHash: string;
  license: string;
  backendSupport: BackendKind[];
  precision: ModelPrecision[];
  /** Model recommended num_overlap (inner overlap inside one chunk). */
  recommendedOverlap: number;
  /** Outer chunk length in samples at `sampleRate` (bounds peak memory). */
  chunkSizeSamples: number;
  qualityProfile: QualityProfileSpec;
  notes?: string;
}

/** One separated stem as stored on disk. */
export interface StemDescriptor {
  id: StemId;
  displayName: string;
  /** Index in `ModelDescriptor.stemOrder` this file came from. */
  outputIndex: number;
  channelCount: number;
  sampleRate: number;
  frames: number;
  filePath: string;
  sha256: string;
  bytes: number;
  peak: number;
  rms: number;
  /** true only when every check of §17 passed for this file. */
  complete: boolean;
}

export type JobStatus =
  | 'PENDING'
  | 'PREPARING'
  | 'RUNNING'
  | 'RECONSTRUCTING'
  | 'VALIDATING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export interface SeparationProgress {
  jobId: string;
  status: JobStatus;
  /** 0..100 */
  percent: number;
  phase: string;
  processedSeconds: number;
  totalSeconds: number;
  chunkIndex?: number;
  chunkCount?: number;
}

export type ProgressCallback = (progress: SeparationProgress) => void;

/** Fully reproducible settings of one separation run. */
export interface SeparationSettings {
  profile: QualityProfile;
  modelId: string;
  modelVersion: string;
  modelHash: string;
  family: ModelFamily;
  backend: BackendKind;
  precision: ModelPrecision;
  device: ComputeDevice;
  sampleRate: number;
  channels: number;
  /** Outer chunk length in samples. */
  chunkSizeSamples: number;
  /** Outer overlap fraction, 0..0.95. */
  chunkOverlap: number;
  /** Inner model passes (num_overlap). */
  numOverlap: number;
  ensemblePasses: number;
  clipMode: 'none' | 'rescale';
  /** Subtract a per-stem DC offset (changes the stem sum – opt-in). */
  dcRemoval: boolean;
  stems: StemId[];
  /** Free-form, engine specific options (session options, env, …). */
  extras: Record<string, string | number | boolean>;
}

export interface JobTiming {
  startedAt: number;
  finishedAt?: number;
  prepareMs?: number;
  inferenceMs?: number;
  reconstructMs?: number;
  validateMs?: number;
  totalMs?: number;
}

export interface StemValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  stemId?: StemId;
}

export interface BoundaryContinuityReport {
  /** Max |x[n] - x[n-1]| at chunk borders, in dB relative to the file peak. */
  boundaryDeltaDb: number;
  /** Same metric measured inside chunks (reference). */
  interiorDeltaDb: number;
  /** boundaryDeltaDb - interiorDeltaDb; <= threshold means no audible click. */
  excessDb: number;
  /** Max RMS jump across a border in dB. */
  rmsJumpDb: number;
  /** Max mid/side correlation jump across a border. */
  stereoJump: number;
  /** Detected duplicate transients within +/- 40 ms of a border. */
  duplicateTransients: number;
  /** Detected transients that vanished at a border. */
  missingTransients: number;
  /**
   * Reconstruction error |sum(stems) - mix| measured at chunk borders,
   * relative to the mix peak. This is the direct answer to §14: the same
   * passage must not sound different just because it sits on a border.
   */
  boundaryErrorDb: number;
  /** 99.9th percentile of the same error away from the borders. */
  interiorErrorDb: number;
  /** boundaryErrorDb - interiorErrorDb; a border specific problem is > 0. */
  boundaryErrorExcessDb: number;
  boundarySampleOffsets: number[];
  pass: boolean;
}

export interface StemValidationReport {
  stemId: StemId;
  pass: boolean;
  issues: StemValidationIssue[];
  headerOk: boolean;
  sampleRateOk: boolean;
  channelCountOk: boolean;
  frameCountOk: boolean;
  sizePlausible: boolean;
  sha256: string;
  finiteSamples: boolean;
  peak: number;
  rms: number;
  dcOffset: number;
}

export interface QualityValidationReport {
  pass: boolean;
  issues: StemValidationIssue[];
  stems: StemValidationReport[];
  /**
   * Boundary/continuity analysis. `null` in `fast_dj` mode: the metric was
   * **not measured** – that is different from "measured and fine" and must be
   * displayed as such.
   */
  continuity: BoundaryContinuityReport | null;
  /** Sum of all stems vs. the working copy, in dB (recombination sanity). */
  recombinationErrorDb: number | null;
  /** True when the result came from a trained model rather than a double. */
  fromTrainedModel: boolean;
  /** Which validation depth produced this report. */
  mode?: ProcessingMode;
}

/** Immutable integrity snapshot of the read-only original. */
export interface OriginalIntegrity {
  path: string;
  sha256Before: string;
  sha256After?: string;
  sizeBefore: number;
  sizeAfter?: number;
  mtimeMsBefore: number;
  mtimeMsAfter?: number;
  unchanged: boolean;
  checkedAt: number;
}

export interface SeparationJobMetadata {
  jobId: string;
  schemaVersion: number;
  status: JobStatus;
  inputPath: string;
  inputAudioHash: string;
  inputFormat: string;
  originalIntegrity: OriginalIntegrity;
  workingCopyPath: string;
  settings: SeparationSettings;
  settingsHash: string;
  cacheKey: string;
  cacheHit: boolean;
  chunkCount: number;
  chunkPlan: { index: number; startSample: number; endSample: number }[];
  stems: StemDescriptor[];
  validation?: QualityValidationReport;
  timing: JobTiming;
  /** Human readable trace, useful for support and regression hunting. */
  events: { at: number; phase: string; detail?: string }[];
  error?: { code: string; message: string };
}

export const JOB_SCHEMA_VERSION = 1;

/** Every failure mode of §16 gets a stable machine readable code. Extended per §4, §30. */
export type StemErrorCode =
  | 'MODEL_MISSING'
  | 'MODEL_CORRUPT'
  | 'MODEL_INCOMPATIBLE'
  | 'MODEL_REGISTRY_INVALID'
  | 'MODEL_HASH_MISMATCH'
  | 'CHECKPOINT_MISSING'
  | 'CONFIG_MISSING'
  | 'HASH_MISMATCH'
  | 'INVALID_CONFIG'
  | 'LICENSE_UNVERIFIED'
  | 'NOT_INSTALLED'
  | 'STEM_ENGINE_UNAVAILABLE'
  | 'RUNTIME_MISSING'
  | 'PYTHON_MISSING'
  | 'PYTHON_VERSION_UNSUPPORTED'
  | 'TORCH_MISSING'
  | 'AUDIO_MISSING'
  | 'AUDIO_CORRUPT'
  | 'AUDIO_UNSUPPORTED_FORMAT'
  | 'AUDIO_INVALID_SAMPLE_RATE'
  | 'AUDIO_INVALID'
  | 'GPU_UNAVAILABLE'
  | 'GPU_OUT_OF_MEMORY'
  | 'CPU_FALLBACK_REQUIRED'
  | 'WRITE_DENIED'
  | 'DISK_FULL'
  | 'INFERENCE_CANCELLED'
  | 'INFERENCE_FAILED'
  | 'BACKEND_UNAVAILABLE'
  | 'CACHE_CORRUPT'
  | 'STEM_CONFIG_INVALID'
  | 'ORIGINAL_MODIFIED'
  | 'VALIDATION_FAILED';

export interface SeparationJobSummary {
  jobId: string;
  status: JobStatus;
  metadataPath: string;
  stems: StemDescriptor[];
  cacheHit: boolean;
  validation?: QualityValidationReport;
  originalIntegrity: OriginalIntegrity;
  metadata: SeparationJobMetadata;
  /**
   * Rechengerät, das tatsächlich gerechnet hat (nach etwaigem Ausweichen auf
   * CPU). Ohne dieses Feld wusste die UI nicht, ob DirectML gegriffen hat oder
   * ob der Job im CPU-Fallback gelandet ist (§7, §13, §36).
   */
  device?: ComputeDevice;
  /** True, wenn das gewünschte Gerät nicht nutzbar war und CPU gerechnet hat. */
  cpuFallback?: boolean;
  /** Menschlich lesbarer Grund des Ausweichens (z. B. DirectML-Treiberfehler). */
  fallbackReason?: string;
}
