import type { BackendCapabilities, StemId } from '../types';
import type { SeparationCancellationToken } from '../chunkProcessor';

export interface BackendSeparationRequest {
  inputPath: string;
  outputRoot: string;
  stemOrder: StemId[];
  sampleRate: number;
  channels: number;
  token?: SeparationCancellationToken;
  onProgress?: (entry: { chunkIndex?: number; phase: string; detail?: string }) => void;
  extras?: Record<string, string | number | boolean>;
}

export interface BackendStemResult {
  id: StemId;
  filePath: string;
  sampleRate: number;
  channels: number;
  frames: number;
}

export interface BackendSeparationResult {
  stems: BackendStemResult[];
  events: { phase: string; detail?: string }[];
}

export interface IStemSeparator {
  readonly backendId: string;
  capabilities(): BackendCapabilities;
  separate(request: BackendSeparationRequest): Promise<BackendSeparationResult>;
}

export const EXIT_CODE_MAP: Record<number, string> = {
  0: 'OK',
  130: 'CANCELLED',
  2: 'INVALID_REQUEST',
  3: 'MODEL_INCOMPATIBLE',
  4: 'IO_ERROR',
  5: 'AUDIO_ERROR',
};

export function mapExitCode(code: number | null): { code: string; retryable: boolean } {
  if (code === 0) return { code: 'OK', retryable: false };
  if (code === 130) return { code: 'CANCELLED', retryable: false };
  if (code === 2) return { code: 'INVALID_REQUEST', retryable: false };
  if (code === 3) return { code: 'MODEL_INCOMPATIBLE', retryable: false };
  if (code === 4) return { code: 'WRITE_DENIED', retryable: true };
  if (code === 5) return { code: 'AUDIO_CORRUPT', retryable: false };
  return { code: 'INFERENCE_FAILED', retryable: true };
}
