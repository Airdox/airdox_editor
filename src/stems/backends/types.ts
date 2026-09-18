/**
 * Backend contract (§18).
 *
 * `IStemSeparator` is the only interface the core engine knows. BS-RoFormer,
 * Mel-Band RoFormer, HTDemucs and future models are implementations of it; the
 * engine never touches family specific details.
 */
import type { CancellationToken } from '../chunkProcessor';
import type {
  BackendKind,
  ComputeDevice,
  ModelDescriptor,
  ModelFamily,
  ModelPrecision,
  QualityProfile,
  StemId,
} from '../types';

/**
 * One stem that a backend produced **in memory**.
 *
 * In-memory is the DJ path: a chunk never becomes a file. A backend that
 * declares `capabilities().inMemory` receives the slice as interleaved
 * float32 and answers with interleaved float32 – the engine then never writes
 * `chunk_NNNN.wav` nor the stem WAVs of that chunk. Final stems are still
 * written once, because the product has to exist as a file.
 */
export interface InlineStem {
  name: string;
  /** Interleaved float32, `frames * channels` samples. */
  samples: Float32Array;
  frames: number;
  channels: number;
  /** Model output index, resolved through the descriptor's stem order. */
  outputIndex?: number;
}

export interface BackendSeparationRequest {
  descriptor: ModelDescriptor;
  /** Path of the 44.1 kHz stereo float32 WAV slice to separate. */
  workingWavPath: string;
  /**
   * In-memory slice for backends with `capabilities().inMemory`.
   * Interleaved float32 of the *whole* slice (not a segment).
   */
  workingSamples?: Float32Array;
  /** Sample rate / channels of `workingSamples` (defaults: descriptor values). */
  sampleRate?: number;
  channels?: number;
  /** Directory the backend writes its stem WAV files into. */
  outputDir: string;
  /** Absolute offset of this slice inside the full working copy. */
  startSample: number;
  /** Frame count of this slice. */
  frames: number;
  /** Requested stems; always a subset of `descriptor.outputStems`. */
  stems: StemId[];
  chunkIndex: number;
  chunkCount: number;
  /** Inner model overlap (num_overlap passes). */
  numOverlap: number;
  /** Extra full passes averaged for MAXIMUM_QUALITY. */
  ensemblePasses: number;
  precision: ModelPrecision;
  device: ComputeDevice;
  profile: QualityProfile;
  token?: CancellationToken;
  onProgress?: (fraction: number, phase: string) => void;
  extras?: Record<string, string | number | boolean>;
}

export interface BackendStemFileRef {
  name: string;
  filePath: string;
  outputIndex?: number;
}

export interface BackendSeparationResponse {
  /** Family that actually produced the result, e.g. `bs_roformer`. */
  engine: ModelFamily;
  backend: BackendKind;
  /** File based result; empty for pure in-memory backends. */
  stems: BackendStemFileRef[];
  /** In-memory result; present when `capabilities().inMemory` is true. */
  inlineStems?: InlineStem[];
  device: ComputeDevice;
  /** True when the requested device was unavailable and CPU was used. */
  cpuFallback?: boolean;
  /** Backend specific diagnostics (session options, timings, backend name). */
  report?: Record<string, unknown>;
}

export interface BackendAvailability {
  available: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
  /** Executables/runtimes that were probed. */
  probes?: { name: string; found: boolean; detail?: string }[];
}

export interface BackendCapabilities {
  kind: BackendKind;
  family: ModelFamily;
  name: string;
  supportedDevices: ComputeDevice[];
  supportedPrecision: ModelPrecision[];
  /** True when the backend streams progress while working. */
  streamsProgress: boolean;
  /** True when the backend can be cancelled cooperatively. */
  cancellable: boolean;
  /** True for trained models; false for the pipeline test double. */
  trainedModel: boolean;
  /**
   * True when the backend accepts `workingSamples` and answers with
   * `inlineStems`. The engine then skips chunk WAVs entirely – no
   * `chunk_NNNN.wav`, no per-chunk output directory, no temporary stem files.
   */
  inMemory: boolean;
}

export interface IStemSeparator {
  readonly kind: BackendKind;
  readonly family: ModelFamily;
  readonly name: string;
  capabilities(): BackendCapabilities;
  isAvailable(): Promise<BackendAvailability>;
  separate(request: BackendSeparationRequest): Promise<BackendSeparationResponse>;
}

/**
 * Resolves a backend for a descriptor + requested kind. Order matters: native
 * first (no Python dependency in the shipped app, §7), then Python.
 */
export type BackendResolver = (descriptor: ModelDescriptor, preferred?: BackendKind) => IStemSeparator | undefined;
