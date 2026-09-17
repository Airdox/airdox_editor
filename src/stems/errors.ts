import type { StemSeparationErrorCode } from './types';

export class StemSeparationError extends Error {
  readonly code: StemSeparationErrorCode;
  readonly cause?: unknown;

  constructor(code: StemSeparationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'StemSeparationError';
    this.code = code;
    this.cause = cause;
  }
}

export function asStemSeparationError(error: unknown, fallback: StemSeparationErrorCode = 'INFERENCE_FAILED'): StemSeparationError {
  return error instanceof StemSeparationError
    ? error
    : new StemSeparationError(fallback, error instanceof Error ? error.message : String(error), error);
}

export const ERROR_MATRIX: Record<StemSeparationErrorCode, { httpStatus: number; retryable: boolean; description: string }> = {
  AUDIO_MISSING: { httpStatus: 404, retryable: false, description: 'Input audio file not found' },
  AUDIO_CORRUPT: { httpStatus: 422, retryable: false, description: 'Audio file corrupt or unreadable' },
  AUDIO_UNSUPPORTED_FORMAT: { httpStatus: 415, retryable: false, description: 'Unsupported audio format' },
  WRITE_DENIED: { httpStatus: 403, retryable: false, description: 'Output directory not writable' },
  BACKEND_UNAVAILABLE: { httpStatus: 503, retryable: true, description: 'Separation backend unavailable' },
  INFERENCE_FAILED: { httpStatus: 500, retryable: true, description: 'Inference failed' },
  CANCELLED: { httpStatus: 499, retryable: false, description: 'Job cancelled' },
  INVALID_REQUEST: { httpStatus: 400, retryable: false, description: 'Invalid separation request' },
  CACHE_CORRUPT: { httpStatus: 500, retryable: true, description: 'Cache entry corrupt' },
  ORIGINAL_MODIFIED: { httpStatus: 500, retryable: false, description: 'Original file was modified during processing - HARD FAIL' },
  MODEL_INCOMPATIBLE: { httpStatus: 422, retryable: false, description: 'Model incompatible with requested stems' },
  MODEL_HASH_MISMATCH: { httpStatus: 500, retryable: false, description: 'Model checkpoint hash mismatch' },
  STEM_VALIDATION_FAILED: { httpStatus: 500, retryable: true, description: 'Separated stem validation failed' },
  RECOMBINATION_FAILED: { httpStatus: 500, retryable: true, description: 'Recombination check failed' },
  BOUNDARY_SPECIFIC_ERROR: { httpStatus: 500, retryable: true, description: 'Boundary artifact detected' },
  WORKING_COPY_FAILED: { httpStatus: 500, retryable: true, description: 'Working copy creation failed' },
  CHUNK_PLAN_INVALID: { httpStatus: 400, retryable: false, description: 'Chunk plan invalid' },
  SETTINGS_INVALID: { httpStatus: 400, retryable: false, description: 'Settings invalid' },
  TIMEOUT: { httpStatus: 504, retryable: true, description: 'Separation timed out' },
  UNKNOWN: { httpStatus: 500, retryable: true, description: 'Unknown error' },
};

export function isHardFail(code: StemSeparationErrorCode): boolean {
  return code === 'ORIGINAL_MODIFIED';
}
