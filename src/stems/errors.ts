export type StemSeparationErrorCode =
  | 'AUDIO_MISSING'
  | 'AUDIO_CORRUPT'
  | 'AUDIO_UNSUPPORTED_FORMAT'
  | 'WRITE_DENIED'
  | 'BACKEND_UNAVAILABLE'
  | 'INFERENCE_FAILED'
  | 'CANCELLED'
  | 'INVALID_REQUEST'
  | 'CACHE_CORRUPT';

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
