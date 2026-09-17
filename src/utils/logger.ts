/**
 * @license
 * Rekordbox DJ Editor - Comprehensive Diagnostic Logging System
 * Merged main+renderer daily file, retention 14d, level env, secret redaction, binary summarization, console/fetch/XHR capture, flush on error/pagehide
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
  | 'UI'
  | 'STEM';

export interface LogEntry {
  id: string;
  timestamp: number;
  timeString: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  details?: any;
  stack?: string;
}

export type LogListener = (entry: LogEntry) => void;

const SECRET_KEYS = ['apiKey', 'api_key', 'GEMINI_API_KEY', 'password', 'token', 'secret', 'authorization', 'key'];

function redactSecrets(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSecrets);
  const clone: any = {};
  for (const [k, v] of Object.entries(obj)) {
    const lower = k.toLowerCase();
    if (SECRET_KEYS.some(s => lower.includes(s.toLowerCase()))) {
      clone[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      clone[k] = redactSecrets(v);
    } else {
      clone[k] = v;
    }
  }
  return clone;
}

function summarizeForLog(value: any): any {
  if (value == null) return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(value)) {
    return { __binary: true, byteLength: value.length };
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const len = (value as any).byteLength || (value as any).length || 0;
    return { __binary: true, byteLength: len };
  }
  if (value && typeof value.byteLength === 'number' && value.byteLength > 1024) {
    return { __binary: true, byteLength: value.byteLength };
  }
  if (Array.isArray(value) && value.length > 100) {
    return { __array: true, length: value.length, preview: value.slice(0, 3) };
  }
  if (typeof value === 'object') {
    if ('tagName' in value || 'nodeType' in value) return `[DOM Element <${(value as any).tagName}>]`;
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'data' && v && typeof (v as any).byteLength === 'number' && (v as any).byteLength > 1024) {
        out[k] = { __binary: true, byteLength: (v as any).byteLength };
      } else {
        out[k] = summarizeForLog(v);
      }
    }
    return out;
  }
  return value;
}

class LoggerService {
  private static instance: LoggerService;
  private readonly maxEntries = 1000;
  private entries: LogEntry[] = [];
  private listeners: Set<LogListener> = new Set();
  private isInitialized = false;
  private originalConsole: Record<string, any> = {};
  private originalFetch: typeof fetch | null = null;
  private originalXHROpen: any = null;
  private level: LogLevel = (typeof process !== 'undefined' && (process.env as any).AIRDOX_LOG_LEVEL ? (process.env as any).AIRDOX_LOG_LEVEL.toUpperCase() : 'INFO') as LogLevel;

  private constructor() {
    this.initGlobalHandlers();
  }

  public static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }
    return LoggerService.instance;
  }

  private shouldLog(level: LogLevel): boolean {
    const order = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };
    return (order[level] ?? 1) >= (order[this.level] ?? 1);
  }

  private initGlobalHandlers() {
    if (this.isInitialized || typeof window === 'undefined') return;
    this.isInitialized = true;

    // Capture console
    try {
      this.originalConsole.log = console.log;
      this.originalConsole.warn = console.warn;
      this.originalConsole.error = console.error;
      this.originalConsole.debug = console.debug;

      console.log = (...args: any[]) => {
        this.originalConsole.log(...args);
        this.info('UI', args.map(a => typeof a === 'string' ? a : JSON.stringify(summarizeForLog(a))).join(' '));
      };
      console.warn = (...args: any[]) => {
        this.originalConsole.warn(...args);
        this.warn('UI', args.map(a => typeof a === 'string' ? a : JSON.stringify(summarizeForLog(a))).join(' '));
      };
      console.error = (...args: any[]) => {
        this.originalConsole.error(...args);
        this.error('UI', args.map(a => typeof a === 'string' ? a : JSON.stringify(summarizeForLog(a))).join(' '));
      };
    } catch {}

    // Capture fetch
    try {
      this.originalFetch = window.fetch;
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const url = args[0] instanceof Request ? args[0].url : String(args[0]);
        const start = Date.now();
        try {
          const res = await this.originalFetch!(...args);
          this.info('SYSTEM', `fetch ${url} -> ${res.status} ${Date.now() - start}ms`);
          return res;
        } catch (e) {
          this.error('SYSTEM', `fetch ${url} failed`, { error: (e as Error).message });
          throw e;
        }
      };
    } catch {}

    // Capture XHR
    try {
      const origOpen = XMLHttpRequest.prototype.open;
      this.originalXHROpen = origOpen;
      const self = this;
      XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
        this.addEventListener('load', () => {
          self.info('SYSTEM', `XHR ${method} ${url} -> ${this.status}`);
        });
        this.addEventListener('error', () => {
          self.error('SYSTEM', `XHR ${method} ${url} error`);
        });
        // @ts-ignore
        return origOpen.call(this, method, url, ...rest);
      };
    } catch {}

    window.addEventListener('error', (event) => {
      this.fatal(
        'SYSTEM',
        `Uncaught Global Error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
        {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: event.error?.message || String(event.error),
          stack: event.error?.stack,
        }
      );
      this.flush();
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      this.fatal('SYSTEM', `Unhandled Promise Rejection: ${message}`, { reason, stack });
      this.flush();
    });

    window.addEventListener('pagehide', () => {
      this.flush();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });

    this.info('SYSTEM', 'Umfassendes Log-System erfolgreich initialisiert (Max Transparenz) – console/fetch/XHR capture aktiv, flush on error/pagehide.');
  }

  public log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    details?: any
  ): LogEntry {
    if (!this.shouldLog(level)) {
      // Still create entry for ring buffer but skip heavy work? We still store
    }

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
        stack = details.stack;
      } else {
        stack = new Error().stack;
      }
    }

    const sanitized = details !== undefined ? redactSecrets(summarizeForLog(details)) : undefined;

    const entry: LogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: now.getTime(),
      timeString,
      level,
      category,
      message,
      details: sanitized,
      stack,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    this.printToConsole(entry);
    this.notifyListeners(entry);
    this.mirrorToFile(entry);

    if (level === 'ERROR' || level === 'FATAL') {
      this.flush();
    }

    return entry;
  }

  private mirrorToFile(entry: LogEntry) {
    try {
      // Try new bridge first
      // @ts-ignore
      const bridge = window.airdoxLogger || window.rekordboxDesktop;
      if (bridge?.write) {
        // @ts-ignore
        bridge.write([{
          ts: entry.timestamp,
          level: entry.level.toLowerCase(),
          category: entry.category,
          message: entry.message,
          data: entry.details,
          stack: entry.stack,
        }]).catch(() => {});
      } else if (bridge?.appendLog) {
        bridge.appendLog({
          ts: entry.timestamp,
          level: entry.level,
          category: entry.category,
          message: entry.message,
          data: entry.details,
        }).catch(() => {});
      }
    } catch {}
  }

  private printToConsole(entry: LogEntry) {
    if (!this.shouldLog(entry.level)) return;
    const prefix = `[${entry.timeString}] [${entry.category}]`;
    // Use original console to avoid recursion
    const logFn = this.originalConsole.log || console.log;
    const warnFn = this.originalConsole.warn || console.warn;
    const errorFn = this.originalConsole.error || console.error;
    const debugFn = this.originalConsole.debug || console.debug;

    switch (entry.level) {
      case 'DEBUG':
        debugFn(`%c${prefix} ${entry.message}`, 'color: #888', entry.details || '');
        break;
      case 'INFO':
        logFn(`%c${prefix} ${entry.message}`, 'color: #00a2ff; font-weight: bold', entry.details || '');
        break;
      case 'WARN':
        warnFn(`%c${prefix} ${entry.message}`, 'color: #f59e0b; font-weight: bold', entry.details || '');
        break;
      case 'ERROR':
        errorFn(`%c${prefix} ${entry.message}`, 'color: #ef4444; font-weight: bold', entry.details || '', entry.stack || '');
        break;
      case 'FATAL':
        errorFn(`%c[FATAL CRASH] ${prefix} ${entry.message}`, 'background: #990000; color: #fff; font-weight: bold; font-size: 12px; padding: 2px 4px', entry.details || '', entry.stack || '');
        break;
    }
  }

  public debug(category: LogCategory, message: string, details?: any) {
    return this.log('DEBUG', category, message, details);
  }

  public info(category: LogCategory, message: string, details?: any) {
    return this.log('INFO', category, message, details);
  }

  public warn(category: LogCategory, message: string, details?: any) {
    return this.log('WARN', category, message, details);
  }

  public error(category: LogCategory, message: string, details?: any) {
    return this.log('ERROR', category, message, details);
  }

  public fatal(category: LogCategory, message: string, details?: any) {
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
        (this.originalConsole.error || console.error)('Error in log listener:', err);
      }
    });
  }

  public async flush(): Promise<void> {
    // In renderer, flush means try to send buffered logs via beacon
    try {
      const entries = this.entries.slice(-50);
      // @ts-ignore
      if (window.airdoxLogger?.write) {
        // @ts-ignore
        await window.airdoxLogger.write(entries.map(e => ({
          ts: e.timestamp,
          level: e.level.toLowerCase(),
          category: e.category,
          message: e.message,
          data: e.details,
        })));
      }
    } catch {}
  }

  public generateDiagnosticReport(appContextState?: any): string {
    const report = {
      title: 'airdox_SMART_Editor – Diagnosebericht',
      generatedAt: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
      screenResolution: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : 'N/A',
      appContext: appContextState || {},
      recentLogs: this.entries,
    };
    return JSON.stringify(report, null, 2);
  }

  public downloadReport(appContextState?: any, filename = 'rekordbox_diagnostic_log.json') {
    if (typeof document === 'undefined') return;
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
  }
}

export const logger = LoggerService.getInstance();
