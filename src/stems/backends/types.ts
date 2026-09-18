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

export interface BackendSeparationRequest {
  descriptor: ModelDescriptor;
  /** Path of the 44.1 kHz stereo float32 WAV slice to separate. */
  workingWavPath: string;
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
  stems: BackendStemFileRef[];
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
