/**
 * Extended error codes for new stem pipeline.
 * Includes codes from §4, §5, §15, §30.
 */

export type StemRuntimeErrorCode =
  | 'STEM_ENGINE_UNAVAILABLE'
  | 'CHECKPOINT_MISSING'
  | 'CONFIG_MISSING'
  | 'MODEL_HASH_MISMATCH'
  | 'MODEL_CORRUPT'
  | 'MODEL_MISSING'
  | 'RUNTIME_MISSING'
  | 'PYTHON_MISSING'
  | 'PYTHON_VERSION_UNSUPPORTED'
  | 'TORCH_MISSING'
  | 'CUDA_UNAVAILABLE'
  | 'GPU_OUT_OF_MEMORY'
  | 'WRITE_DENIED'
  | 'AUDIO_INVALID'
  | 'JOB_CANCELLED'
  | 'CACHE_CORRUPT'
  | 'ORIGINAL_MODIFIED'
  | 'VALIDATION_FAILED'
  | 'BACKEND_UNAVAILABLE'
  | 'LICENSE_UNVERIFIED'
  | 'NOT_INSTALLED'
  | 'HASH_MISMATCH'
  | 'INVALID_CONFIG'
  | 'MISSING_CHECKPOINT'
  | 'MISSING_CONFIG';

export class StemRuntimeError extends Error {
  public readonly code: StemRuntimeErrorCode;
  public readonly details: Record<string, unknown>;

  constructor(code: StemRuntimeErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'StemRuntimeError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isStemRuntimeError(e: unknown): e is StemRuntimeError {
  return e instanceof StemRuntimeError;
}
