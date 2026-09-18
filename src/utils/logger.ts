/**
 * @license
 * Rekordbox DJ Editor - Comprehensive Diagnostic Logging System
 *
 * Provides centralized high-resolution logging, error interception, ring-buffer
 * persistence, subscriber notifications, durable desktop mirroring, and complete
 * incident telemetry. Logging is strictly diagnostic: every sink is best-effort
 * and can never interrupt the operation being observed.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export type LogCategory =
  | 'SYSTEM'
  | 'XML_IMPORT'
  | 'AUDIO_ENGINE'
  | 'BEATGRID'
  | 'EDITING'
  | 'DATABASE'
  | 'CHATBOT'
  | 'UI';

export interface LogEntry {
  id: string;
  timestamp: number;
  timeString: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  details?: unknown;
  stack?: string;
}

export type LogListener = (entry: LogEntry) => void;

interface DesktopPersistenceEntry {
  ts: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data: {
    id: string;
    details?: unknown;
    stack?: string;
  };
}

export interface LoggerServiceOptions {
  /** Test-only override. The production ring buffer always retains 1,000 entries. */
  maxEntries?: number;
  /** Allows deterministic unit tests without registering browser-global handlers. */
  installGlobalHandlers?: boolean;
}

const MAX_DETAIL_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_CHARS = 8_000;

// Do not redact the ordinary musical `key` field. This list is deliberately
// specific to credentials and SQLCipher material so useful Rekordbox metadata
// (paths, IDs, BPM, title, artist, analysis tags) remains diagnosable.
const SENSITIVE_DETAIL_KEY = /^(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|credential|credentials|secret|client[_-]?secret|private[_-]?key|sqlcipher(?:[_-]?key)?|encryption[_-]?key|cookie|set[_-]?cookie)$/i;

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[nicht darstellbar]';
  }
}

/** Remove common credentials from free text before it reaches any log sink. */
export function redactLogText(value: unknown): string {
  const text = safeString(value);
  return text
    .replace(/\b((?:sqlcipher(?:[_-]?key)?|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|credential|client[_-]?secret)\s*[=:]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/("(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|credential|credentials|secret|client[_-]?secret|private[_-]?key|sqlcipher(?:[_-]?key)?|encryption[_-]?key)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+\-/=]+/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@');
}

function truncateString(value: string): string {
  return value.length <= MAX_STRING_CHARS
    ? value
    : `${value.slice(0, MAX_STRING_CHARS)}…(+${value.length - MAX_STRING_CHARS} Zeichen)`;
}

function isDomLike(value: object): value is { tagName?: unknown; nodeName?: unknown; nodeType?: unknown } {
  try {
    return 'tagName' in value || 'nodeName' in value || 'nodeType' in value;
  } catch {
    return false;
  }
}

/**
 * Produces an immutable, bounded, JSON-safe diagnostic value. Circular input,
 * DOM nodes, binary payloads and unsupported JavaScript values never escape
 * into the ring buffer or the desktop IPC payload.
 */
export function sanitizeLogDetails(details: unknown): unknown {
  const seen = new WeakSet<object>();

  const sanitize = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return truncateString(redactLogText(value));
    if (typeof value === 'undefined') return '[undefined]';
    if (typeof value === 'bigint') return `[BigInt ${value.toString()}]`;
    if (typeof value === 'symbol') return `[Symbol ${safeString(value)}]`;
    if (typeof value === 'function') return `[Function ${(value as Function).name || 'anonymous'}]`;

    if (value instanceof Error) {
      return {
        name: value.name || 'Error',
        message: truncateString(redactLogText(value.message)),
        stack: value.stack ? truncateString(redactLogText(value.stack)) : undefined,
      };
    }

    if (depth >= MAX_DETAIL_DEPTH) return '[maximale Diagnosetiefe erreicht]';
    if (typeof value !== 'object') return truncateString(redactLogText(value));

    if (isDomLike(value)) {
      let tagName = 'unknown';
      try {
        tagName = safeString(value.tagName ?? value.nodeName ?? 'unknown').toUpperCase();
      } catch {
        // A hostile proxy still has to remain non-fatal to the logger.
      }
      return `[DOM Element <${tagName}>]`;
    }

    if (ArrayBuffer.isView(value)) {
      return `[Binary data ${value.byteLength} bytes]`;
    }
    if (value instanceof ArrayBuffer) return `[Binary data ${value.byteLength} bytes]`;
    if (value instanceof Date) {
      try {
        return value.toISOString();
      } catch {
        return '[Ungültiges Datum]';
      }
    }

    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1));
      if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} weitere Einträge]`);
      return items;
    }

    const record: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch {
      return '[Nicht serialisierbares Objekt]';
    }
    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
      if (SENSITIVE_DETAIL_KEY.test(key)) {
        record[key] = '[REDACTED]';
        continue;
      }
      try {
        record[key] = sanitize((value as Record<string, unknown>)[key], depth + 1);
      } catch {
        record[key] = '[Nicht lesbar]';
      }
    }
    if (keys.length > MAX_OBJECT_KEYS) record.__truncatedKeys = `+${keys.length - MAX_OBJECT_KEYS} weitere Schlüssel`;
    return record;
  };

  try {
    return sanitize(details, 0);
  } catch {
    return '[Nicht serialisierbare Diagnosedaten]';
  }
}

export class LoggerService {
  private static instance: LoggerService;
  private readonly maxEntries: number;
  private entries: LogEntry[] = [];
  private listeners: Set<LogListener> = new Set();
  private isInitialized = false;

  public constructor(options: LoggerServiceOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 1000));
    if (options.installGlobalHandlers !== false) this.initGlobalHandlers();
  }

  public static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }
    return LoggerService.instance;
  }

  private initGlobalHandlers() {
    if (this.isInitialized || typeof window === 'undefined') return;
    this.isInitialized = true;

    // Capture uncaught JavaScript runtime errors.
    window.addEventListener('error', (event) => {
      const error = event.error instanceof Error ? event.error : undefined;
      this.fatal(
        'SYSTEM',
        `Uncaught Global Error: ${redactLogText(event.message)} at ${event.filename}:${event.lineno}:${event.colno}`,
        {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: error ?? event.error,
          stack: error?.stack,
        }
      );
    });

    // Capture unhandled asynchronous Promise rejections.
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : safeString(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      this.fatal('SYSTEM', `Unhandled Promise Rejection: ${redactLogText(message)}`, { reason, stack });
    });

    this.info('SYSTEM', 'Umfassendes Log-System erfolgreich initialisiert (Max Transparenz).');
  }

  public log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    details?: unknown
  ): LogEntry {
    const now = new Date();
    const timeString = `${now.getHours().toString().padStart(2, '0')}:${now
      .getMinutes()
      .toString()
      .padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now
      .getMilliseconds()
      .toString()
      .padStart(3, '0')}`;

    let stack: string | undefined;
    if (level === 'ERROR' || level === 'FATAL') {
      if (details instanceof Error) {
        stack = details.stack ? redactLogText(details.stack) : undefined;
      } else if (
        details &&
        typeof details === 'object' &&
        'stack' in details &&
        typeof (details as { stack?: unknown }).stack === 'string'
      ) {
        // Global error handlers pass their original stack inside structured
        // details; retain it as the primary incident stack rather than
        // replacing it with a logger-internal call-site trace.
        stack = redactLogText((details as { stack: string }).stack);
      } else {
        try {
          stack = redactLogText(new Error().stack || '');
        } catch {
          stack = undefined;
        }
      }
    }

    const entry: LogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: now.getTime(),
      timeString,
      level,
      category,
      message: truncateString(redactLogText(message)),
      details: details !== undefined ? sanitizeLogDetails(details) : undefined,
      stack,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();

    // The following three sinks are deliberately isolated from application
    // logic. A bad console, listener, preload bridge, IPC rejection or file
    // writer cannot turn a diagnostic event into an application failure.
    this.printToConsole(entry);
    this.notifyListeners(entry);
    this.persistToDesktop(entry);

    return entry;
  }

  /**
   * Best-effort Electron mirror. Browser/Vite builds have no bridge and remain
   * fully functional with console + ring-buffer + live modal diagnostics.
   * This method never calls logger.error: doing so would create a recursion
   * loop when the persistence path itself is unavailable.
   */
  private persistToDesktop(entry: LogEntry): void {
    try {
      if (typeof window === 'undefined') return;
      const appendLog = window.rekordboxDesktop?.appendLog;
      if (typeof appendLog !== 'function') return;
      const payload: DesktopPersistenceEntry = {
        ts: entry.timestamp,
        level: entry.level,
        category: entry.category,
        message: entry.message,
        data: {
          id: entry.id,
          details: entry.details,
          stack: entry.stack,
        },
      };
      // `appendLog` may throw synchronously (a malformed preload mock) or
      // asynchronously (IPC/write failure); both paths are intentionally
      // swallowed and do not recursively generate another log entry.
      const result = appendLog(payload);
      Promise.resolve(result).catch(() => undefined);
    } catch {
      // Persistence is diagnostically useful, never operationally required.
    }
  }

  private printToConsole(entry: LogEntry) {
    try {
      const prefix = `[${entry.timeString}] [${entry.category}]`;
      switch (entry.level) {
        case 'DEBUG':
          console.debug(`%c${prefix} ${entry.message}`, 'color: #888', entry.details || '');
          break;
        case 'INFO':
          console.log(`%c${prefix} ${entry.message}`, 'color: #00a2ff; font-weight: bold', entry.details || '');
          break;
        case 'WARN':
          console.warn(`%c${prefix} ${entry.message}`, 'color: #f59e0b; font-weight: bold', entry.details || '');
          break;
        case 'ERROR':
          console.error(`%c${prefix} ${entry.message}`, 'color: #ef4444; font-weight: bold', entry.details || '', entry.stack || '');
          break;
        case 'FATAL':
          console.error(`%c[FATAL CRASH] ${prefix} ${entry.message}`, 'background: #990000; color: #fff; font-weight: bold; font-size: 12px; padding: 2px 4px', entry.details || '', entry.stack || '');
          break;
      }
    } catch {
      // Some test/dev consoles can be unavailable. Never escalate from here.
    }
  }

  public debug(category: LogCategory, message: string, details?: unknown) {
    return this.log('DEBUG', category, message, details);
  }

  public info(category: LogCategory, message: string, details?: unknown) {
    return this.log('INFO', category, message, details);
  }

  public warn(category: LogCategory, message: string, details?: unknown) {
    return this.log('WARN', category, message, details);
  }

  public error(category: LogCategory, message: string, details?: unknown) {
    return this.log('ERROR', category, message, details);
  }

  public fatal(category: LogCategory, message: string, details?: unknown) {
    return this.log('FATAL', category, message, details);
  }

  public getEntries(): LogEntry[] {
    return [...this.entries];
  }

  public clear() {
    this.entries = [];
    this.info('SYSTEM', 'Log-Puffer zurückgesetzt.');
  }

  public subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(entry: LogEntry) {
    this.listeners.forEach((listener) => {
      try {
        listener(entry);
      } catch (err) {
        // Do not use the logger from this recovery path; a broken listener
        // must not recursively invoke every logging sink.
        try {
          console.error('Error in log listener:', err);
        } catch {
          // noop
        }
      }
    });
  }

  /**
   * Generates a complete JSON diagnostic report including browser environment,
   * audio context state, memory usage and historical log records.
   */
  public generateDiagnosticReport(appContextState?: unknown): string {
    const report = {
      title: 'airdox_SMART_Editor – Diagnosebericht',
      generatedAt: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
      screenResolution: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : 'N/A',
      appContext: appContextState ? sanitizeLogDetails(appContextState) : {},
      recentLogs: this.entries,
    };
    return JSON.stringify(report, null, 2);
  }

  public downloadReport(appContextState?: unknown, filename = 'rekordbox_diagnostic_log.json') {
    if (typeof document === 'undefined') return;
    try {
      const jsonStr = this.generateDiagnosticReport(appContextState);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Export is a convenience function; it must not destabilize the UI.
    }
  }
}

export const logger = LoggerService.getInstance();
