/**
 * Runtime types for stem pipeline – implements §22, §23, §13, §14, §15.
 */

export type QualityProfile = 'PREVIEW' | 'BALANCED' | 'HIGH' | 'MAXIMUM_QUALITY';
export const QUALITY_PROFILES: QualityProfile[] = ['PREVIEW', 'BALANCED', 'HIGH', 'MAXIMUM_QUALITY'];

export type StemId = 'vocals' | 'drums' | 'bass' | 'other' | string;

export type ComputeDevice = 'auto' | 'cpu' | 'cuda' | 'vulkan' | 'metal';
export type ModelPrecision = 'native' | 'f32' | 'f16' | 'bf16' | 'q8_0';

export interface StemRequest {
  sourcePath: string;
  sourceFingerprint: string; // sha256 before
  requestedStems: StemId[];
  qualityProfile: QualityProfile;
  device: ComputeDevice;
  precision: ModelPrecision;
}

export interface StemDiagnostics {
  pythonVersion: string | null;
  pythonPath: string | null;
  torchVersion: string | null;
  cudaAvailable: boolean;
  cudaVersion: string | null;
  gpuName: string | null;
  gpuMemory: string | null;
  modelPath: string | null;
  configPath: string | null;
  checkpointPath: string | null;
  checkpointSha256: string | null;
  modelStatus: string;
  engineStatus: string;
}

export interface PreflightCheckResult {
  name: string;
  ok: boolean;
  critical: boolean;
  message?: string;
}

export interface PreflightResultV2 {
  status: 'READY' | 'UNAVAILABLE';
  engine: 'bsroformer';
  model: string;
  python: string;
  torch: string;
  device: string;
  checkpointVerified: boolean;
  checks?: PreflightCheckResult[];
  reason?: string;
}

export type EngineStatus = 'READY' | 'UNAVAILABLE' | 'LOADING' | 'ERROR';
export type ModelStatus = 'AVAILABLE' | 'MISSING_CHECKPOINT' | 'MISSING_CONFIG' | 'HASH_MISMATCH' | 'INVALID_CONFIG' | 'LICENSE_UNVERIFIED' | 'NOT_INSTALLED';

export interface SeparationMetrics {
  engine: string;
  model: string;
  device: string;
  precision: string;
  processingTimeMs: number;
  rtf: number; // real-time factor
  outputFiles: string[];
  qualityMetrics?: {
    recombinationErrorDb?: number;
    validationPass?: boolean;
  };
}
