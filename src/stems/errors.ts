/**
 * Typed errors for the stem separation engine.
 *
 * Every failure path of the specification maps to a stable `StemErrorCode` so
 * callers (CLI, Electron main, tests, quality gate) can react without parsing
 * human readable text.
 */
import type { StemErrorCode } from './types';

export class StemSeparationError extends Error {
  public readonly code: StemErrorCode;
  public readonly details: Record<string, unknown>;
  public readonly cause?: unknown;

  constructor(code: StemErrorCode, message: string, details: Record<string, unknown> = {}, cause?: unknown) {
    super(message);
    this.name = 'StemSeparationError';
    this.code = code;
    this.details = details;
    this.cause = cause;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * Rendert eine beliebige Ursache lesbar. `String({...})` ergäbe nur
 * „[object Object]“ – die produktiv gesehene „Diagnose“ ohne Inhalt.
 */
function causeToText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause === undefined || cause === null) return '';
  if (typeof cause === 'string') return cause;
  if (typeof cause === 'number' || typeof cause === 'boolean' || typeof cause === 'bigint') return String(cause);
  try {
    return JSON.stringify(cause).slice(0, 2000);
  } catch {
    return Object.prototype.toString.call(cause);
  }
}

/**
 * Turns arbitrary process/IO failures into typed engine errors. Kept in one
 * place so the backend transports and the orchestrator classify identically.
 *
 * Only unambiguous OS level signatures are remapped. "File not found" is
 * deliberately NOT mapped to MODEL_MISSING: the caller knows whether a missing
 * path means a missing model, a missing audio file or a missing executable.
 */
export function classifyFailure(code: StemErrorCode, message: string, cause?: unknown): StemSeparationError {
  const text = causeToText(cause);
  const combined = text ? `${message} (${text})` : message;
  const haystack = `${message} ${text}`.toLowerCase();

  const map: [RegExp, StemErrorCode][] = [
    [/enospc|no space left|disk full/, 'DISK_FULL'],
    [/eacces|eperm|permission denied|read-only file system|readonly/, 'WRITE_DENIED'],
    [/out of memory|oom|cannot allocate memory|cuda error: out of memory|std::bad_alloc/, 'GPU_OUT_OF_MEMORY'],
    [/cancel|aborted|sigterm|killed/, 'INFERENCE_CANCELLED'],
  ];
  for (const [pattern, mapped] of map) {
    if (pattern.test(haystack)) return new StemSeparationError(mapped, combined, { originalCode: code }, cause);
  }
  return new StemSeparationError(code, combined, {}, cause);
}

export function isStemError(error: unknown): error is StemSeparationError {
  return error instanceof StemSeparationError;
}

export function describeError(error: unknown): { code: string; message: string } {
  if (isStemError(error)) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'INFERENCE_FAILED', message: error.message };
  return { code: 'INFERENCE_FAILED', message: String(error) };
}
