/** Small JSONL protocol helpers used by external inference adapters. */
export interface BackendProtocolEvent {
  phase: string;
  [key: string]: unknown;
}

export function encodeBackendEvent(event: BackendProtocolEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseBackendEvent(line: string): BackendProtocolEvent {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== 'object' || typeof (value as { phase?: unknown }).phase !== 'string') {
    throw new Error('Ungültiges Backend-Ereignis');
  }
  return value as BackendProtocolEvent;
}

export function parseBackendEvents(text: string): BackendProtocolEvent[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseBackendEvent);
}

export const EXIT_CODE_MAP: Record<number, { code: string; retryable: boolean }> = {
  0: { code: 'OK', retryable: false },
  130: { code: 'CANCELLED', retryable: false },
  2: { code: 'INVALID_REQUEST', retryable: false },
  3: { code: 'MODEL_INCOMPATIBLE', retryable: false },
  4: { code: 'WRITE_DENIED', retryable: true },
  5: { code: 'AUDIO_CORRUPT', retryable: false },
};
