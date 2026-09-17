/** Shared types for the non-destructive stem-separation pipeline. */
export type StemId = 'vocals' | 'drums' | 'bass' | 'other' | 'synth' | 'percussion' | 'fx' | (string & {});

export type StemProfile = 'PREVIEW' | 'HIGH_QUALITY' | 'MAXIMUM_QUALITY';

export interface StemDescriptor {
  id: StemId;
  label?: string;
  order?: number;
}

export interface BackendCapabilities {
  trainedModel: boolean;
  supportsCancellation?: boolean;
  supportsStereo?: boolean;
  stemOrder: StemId[];
  [key: string]: unknown;
}

export type StemSeparationErrorCode =
  | 'AUDIO_MISSING'
  | 'AUDIO_CORRUPT'
  | 'AUDIO_UNSUPPORTED_FORMAT'
  | 'WRITE_DENIED'
  | 'BACKEND_UNAVAILABLE'
  | 'INFERENCE_FAILED'
  | 'CANCELLED'
  | 'INVALID_REQUEST'
  | 'CACHE_CORRUPT'
  | 'ORIGINAL_MODIFIED'
  | 'MODEL_INCOMPATIBLE'
  | 'MODEL_HASH_MISMATCH'
  | 'STEM_VALIDATION_FAILED'
  | 'RECOMBINATION_FAILED'
  | 'BOUNDARY_SPECIFIC_ERROR'
  | 'WORKING_COPY_FAILED'
  | 'CHUNK_PLAN_INVALID'
  | 'SETTINGS_INVALID'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface SeparationSettings {
  modelId: string;
  profile: StemProfile;
  chunkSize: number;
  overlap: number;
  numOverlap: number;
  ensemblePasses: number;
  precision: 'float32' | 'float16' | 'int8';
  sampleRate: number;
  channels: number;
  extras?: Record<string, string | number | boolean>;
}

export interface JobMetadata {
  jobId: string;
  createdAt: number;
  inputPath: string;
  inputHash: string;
  inputSize: number;
  modelId: string;
  modelHash: string;
  settingsHash: string;
  settings: SeparationSettings;
  backend: string;
  precision: string;
  extras?: Record<string, string | number | boolean>;
  version: string;
}

export interface TransportTypes {
  request: {
    inputPath: string;
    outputRoot: string;
    modelId: string;
    profile: StemProfile;
  };
  response: {
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
    stems: { id: StemId; filePath: string }[];
  };
}
