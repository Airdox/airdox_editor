/** Small JSONL protocol helpers used by external inference adapters. */
export interface BackendProtocolEvent { phase: string; [key: string]: unknown; }
export function encodeBackendEvent(event: BackendProtocolEvent): string { return `${JSON.stringify(event)}\n`; }
export function parseBackendEvent(line: string): BackendProtocolEvent { const value: unknown = JSON.parse(line); if (!value || typeof value !== 'object' || typeof (value as { phase?: unknown }).phase !== 'string') throw new Error('Ungültiges Backend-Ereignis'); return value as BackendProtocolEvent; }
export function parseBackendEvents(text: string): BackendProtocolEvent[] { return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(parseBackendEvent); }
