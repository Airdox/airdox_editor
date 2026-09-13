/**
 * @license
 * airdox_SMART_Editor – Comprehensive Diagnostic Logging System (renderer)
 *
 * Zentraler Logger für den gesamten Renderer-Prozess. Er löst das bisherige
 * Problem, dass Protokolle nur flüchtig im Arbeitsspeicher existierten:
 *
 *  1. Ringpuffer + Live-Subscriber für das SystemLogModal (wie bisher)
 *  2. Dauerhafte Datei-Persistenz:
 *       - Desktop (Electron): Bündelung über `rekordboxDesktop.writeLogEntries`
 *         in die gemeinsame Tageslogdatei des Main-Prozesses
 *       - Dev-Server (Browser):  POST /api/logs (ebenfalls Datei-persistiert)
 *       - Immer zusätzlicher localStorage-Ringpuffer als letzte Sicherung
 *  3. Globaler Abfang von:
 *       - window error / unhandledrejection
 *       - console.error / console.warn (Drittbibliotheken)
 *       - window.fetch / XMLHttpRequest (Netzwerkfehler & lange Anfragen)
 *  4. Sofort-Flush bei ERROR/FATAL und beim Verlassen/Verstecken der Seite
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
  | 'STEMS'
  | 'MIDI'
  | 'NETWORK'
  | 'IPC'
  | 'PROJECT'
  | 'WAVEFORM'
  | 'PERFORMANCE'
  | 'EXPORT';

export interface LogEntry {
  id: string;
  timestamp: number;
  timeString: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  details?: unknown;
  stack?: string;
  sessionId?: string;
}

export type LogListener = (entry: LogEntry) => void;

export interface FileLogInfo {
  sessionId: string;
  processName: string;
  logDirectory: string | null;
  currentFile: string | null;
  level: string;
  retentionDays: number;
  entriesWritten: number;
  platform?: string;
  pid?: number;
  userData?: string;
  isPackaged?: boolean;
}

const MAX_ENTRIES = 2000;
const STORAGE_KEY = 'airdox.logs.v1';
const STORAGE_MAX_ENTRIES = 400;
const FLUSH_INTERVAL_MS = 3000;
const FLUSH_BATCH_SIZE = 50;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
  FATAL: 50,
};

function createSessionId(): string {
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `renderer-${stamp}-${Math.random().toString(36).substring(2, 10)}`;
}

function timeStringFromDate(now: Date): string {
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(
    now.getMilliseconds(),
    3
  )}`;
}

/** DOM-Knoten, zyklische Objekte und Riesenpayloads protokollierfähig machen. */
function sanitizeDetails(details: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (details === undefined || details === null) return details;
  if (typeof details === 'string') {
    return details.length > 1200 ? `${details.slice(0, 1200)}… [${details.length} Zeichen]` : details;
  }
  if (typeof details === 'number' || typeof details === 'boolean') return details;
  if (typeof details === 'bigint') return details.toString();
  if (typeof details === 'function') return '[Function]';
  if (details instanceof Error) {
    return { name: details.name, message: details.message, stack: details.stack };
  }
  if (typeof details === 'object') {
    const obj = details as Record<string, unknown>;
    // Binärdaten nur zusammenfassen, niemals in das Log schreiben.
    if (typeof ArrayBuffer !== 'undefined' && details instanceof ArrayBuffer) {
      return { __binary: 'ArrayBuffer', byteLength: details.byteLength };
    }
    if (ArrayBuffer.isView(details)) {
      return { __binary: (details.constructor?.name as string) || 'TypedArray', byteLength: (details as { byteLength: number }).byteLength };
    }
    if (typeof Blob !== 'undefined' && details instanceof Blob) {
      return { __binary: 'Blob', byteLength: details.size, type: details.type };
    }
    if ('tagName' in obj || 'nodeType' in obj) {
      return `[DOM Element <${String((obj as { tagName?: string }).tagName || 'node')}>]`;
    }
    if (depth >= 4) return Array.isArray(details) ? `[Array ${details.length}]` : '[Object]';
    if (seen.has(details as object)) return '[Circular]';
    seen.add(details as object);

    if (Array.isArray(details)) {
      return details.slice(0, 25).map((item) => sanitizeDetails(item, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (/^(password|passwort|token|secret|api[-_]?key|gemini[-_]?key)$/i.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = sanitizeDetails(value, depth + 1, seen);
      }
    }
    return out;
  }
  return String(details);
}

class LoggerService {
  private static instance: LoggerService;
  private readonly maxEntries = MAX_ENTRIES;
  private entries: LogEntry[] = [];
  private listeners: Set<LogListener> = new Set();
  private isInitialized = false;
  private readonly sessionId = createSessionId();

  // Persistenz-Warteschlange
  private persistQueue: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private inFlightFlush: Promise<void> | null = null;
  private consoleCaptureInstalled = false;
  private networkCaptureInstalled = false;
  private mirroringToConsole = false;
  // In Node/Tests (kein window) bleibt die Konsole ruhig; im Browser läuft DEBUG mit.
  private minLevel: LogLevel = typeof window !== 'undefined' ? 'DEBUG' : 'INFO';

  private constructor() {
    this.initGlobalHandlers();
  }

  public static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }
    return LoggerService.instance;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  private isDesktop(): boolean {
    return typeof window !== 'undefined' && Boolean(window.rekordboxDesktop?.writeLogEntries);
  }

  private initGlobalHandlers() {
    if (this.isInitialized || typeof window === 'undefined') return;
    this.isInitialized = true;

    // Gespeicherte Einträge vorheriger Sitzungen wieder in den Puffer holen,
    // damit das Log-Modal nicht bei jedem Neuladen leer startet.
    this.restoreFromStorage();

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
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      this.fatal('SYSTEM', `Unhandled Promise Rejection: ${message}`, { reason, stack });
    });

    this.installConsoleCapture();
    this.installNetworkCapture();

    // Regelmäßig und bei Verlassen der Seite sichern.
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });
    window.addEventListener('pagehide', () => this.flush(true));
    window.addEventListener('beforeunload', () => this.flush(true));
    window.addEventListener('online', () => this.info('NETWORK', 'Netzwerkverbindung wiederhergestellt.'));
    window.addEventListener('offline', () => this.warn('NETWORK', 'Netzwerkverbindung verloren (offline).'));

    this.info('SYSTEM', 'Umfassendes Log-System initialisiert.', {
      sessionId: this.sessionId,
      desktopBridge: this.isDesktop(),
      userAgent: navigator.userAgent,
      language: navigator.language,
      screen: `${window.screen?.width}x${window.screen?.height}`,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      timestamp: new Date().toISOString(),
    });
  }

  /** Leitet console.warn/error aus Drittcode in den Logger um. */
  private installConsoleCapture() {
    if (this.consoleCaptureInstalled) return;
    this.consoleCaptureInstalled = true;
    let inside = false;

    const wrap = (method: 'warn' | 'error' | 'info', level: LogLevel) => {
      const original = console[method]?.bind(console);
      if (!original) return;
      console[method] = (...args: unknown[]) => {
        original(...args);
        if (inside || this.mirroringToConsole) return;
        inside = true;
        try {
          const message = args
            .map((a) =>
              typeof a === 'string'
                ? a.replace(/%c|color:[^;'\"]+/g, '').trim()
                : (() => {
                    try {
                      return JSON.stringify(sanitizeDetails(a));
                    } catch {
                      return String(a);
                    }
                  })()
            )
            .filter(Boolean)
            .join(' ');
          if (message && !message.startsWith('[')) {
            this.log(level, 'SYSTEM', `[console.${method}] ${message.slice(0, 600)}`);
          }
        } finally {
          inside = false;
        }
      };
    };
    wrap('error', 'ERROR');
    wrap('warn', 'WARN');
  }

  /** Protokolliert fehlgeschlagene/langsame fetch()- und XHR-Anfragen. */
  private installNetworkCapture() {
    if (this.networkCaptureInstalled) return;
    this.networkCaptureInstalled = true;

    if (typeof window.fetch === 'function') {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method || (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET') || 'GET';
        const startedAt = performance.now();
        try {
          const response = await originalFetch(input, init);
          const durationMs = Math.round(performance.now() - startedAt);
          if (!response.ok) {
            this.warn('NETWORK', `fetch ${method} ${url} → HTTP ${response.status}`, {
              durationMs,
              status: response.status,
            });
          } else if (durationMs > 5000) {
            this.warn('PERFORMANCE', `Langsame fetch-Anfrage ${method} ${url}: ${durationMs} ms`);
          }
          return response;
        } catch (error) {
          this.error('NETWORK', `fetch fehlgeschlagen: ${method} ${url} – ${(error as Error).message}`, {
            stack: (error as Error).stack,
          });
          throw error;
        }
      };
    }

    if (typeof XMLHttpRequest !== 'undefined') {
      const OriginalXHR = XMLHttpRequest;
      const originalOpen = OriginalXHR.prototype.open;
      const originalSend = OriginalXHR.prototype.send;
      OriginalXHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        (this as unknown as { __airdoxLog?: { method: string; url: string; startedAt: number } }).__airdoxLog = {
          method,
          url: String(url),
          startedAt: performance.now(),
        };
        return originalOpen.call(this, method, url, ...(rest as []));
      };
      OriginalXHR.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
        const meta = (this as unknown as { __airdoxLog?: { method: string; url: string; startedAt: number } }).__airdoxLog;
        this.addEventListener('loadend', () => {
          if (!meta) return;
          const durationMs = Math.round(performance.now() - meta.startedAt);
          if (this.status >= 400) {
            logger.warn('NETWORK', `XHR ${meta.method} ${meta.url} → HTTP ${this.status}`, { durationMs });
          }
        });
        this.addEventListener('error', () => {
          logger.error('NETWORK', `XHR fehlgeschlagen: ${meta?.method} ${meta?.url}`);
        });
        return originalSend.apply(this, args as []);
      };
    }
  }

  public setMinLevel(level: LogLevel) {
    this.minLevel = level;
  }

  public log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    details?: unknown
  ): LogEntry {
    const now = new Date();

    let stack: string | undefined;
    if (level === 'ERROR' || level === 'FATAL') {
      if (details instanceof Error) {
        stack = details.stack;
      } else if (details && typeof details === 'object' && 'stack' in details) {
        stack = String((details as { stack?: unknown }).stack);
      } else {
        stack = new Error().stack;
      }
    }

    const entry: LogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: now.getTime(),
      timeString: timeStringFromDate(now),
      level,
      category,
      message,
      sessionId: this.sessionId,
      details: details !== undefined ? sanitizeDetails(details) : undefined,
      stack,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    this.printToConsole(entry);
    this.notifyListeners(entry);
    this.persist(entry, level === 'ERROR' || level === 'FATAL');

    return entry;
  }

  private printToConsole(entry: LogEntry) {
    if (LEVEL_WEIGHT[entry.level] < LEVEL_WEIGHT[this.minLevel]) return;
    this.mirroringToConsole = true;
    try {
      const prefix = `[${entry.timeString}] [${entry.category}]`;
      switch (entry.level) {
        case 'DEBUG':
          // eslint-disable-next-line no-console
          console.debug(`%c${prefix} ${entry.message}`, 'color: #888', entry.details || '');
          break;
        case 'INFO':
          // eslint-disable-next-line no-console
          console.log(`%c${prefix} ${entry.message}`, 'color: #00a2ff; font-weight: bold', entry.details || '');
          break;
        case 'WARN':
          console.warn(`%c${prefix} ${entry.message}`, 'color: #f59e0b; font-weight: bold', entry.details || '');
          break;
        case 'ERROR':
          console.error(`%c${prefix} ${entry.message}`, 'color: #ef4444; font-weight: bold', entry.details || '', entry.stack || '');
          break;
        case 'FATAL':
          console.error(
            `%c[FATAL CRASH] ${prefix} ${entry.message}`,
            'background: #990000; color: #fff; font-weight: bold; font-size: 12px; padding: 2px 4px',
            entry.details || '',
            entry.stack || ''
          );
          break;
      }
    } finally {
      this.mirroringToConsole = false;
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
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nicht verfügbar */
    }
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
        // eslint-disable-next-line no-console
        console.error('Error in log listener:', err);
      }
    });
  }

  // --- Persistenz -----------------------------------------------------------

  private persist(entry: LogEntry, immediate: boolean) {
    this.persistQueue.push(entry);
    this.appendToStorage(entry);
    if (immediate || this.persistQueue.length >= FLUSH_BATCH_SIZE) {
      void this.flush(immediate);
    }
  }

  private appendToStorage(entry: LogEntry) {
    try {
      const existing = this.readStorage();
      existing.push({
        id: entry.id,
        timestamp: entry.timestamp,
        timeString: entry.timeString,
        level: entry.level,
        category: entry.category,
        message: entry.message,
        sessionId: entry.sessionId,
      });
      const trimmed = existing.slice(-STORAGE_MAX_ENTRIES);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // Quota / nicht verfügbar – Datei-Persistenz bleibt maßgeblich.
    }
  }

  private readStorage(): Array<Pick<LogEntry, 'id' | 'timestamp' | 'timeString' | 'level' | 'category' | 'message' | 'sessionId'>> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private restoreFromStorage() {
    try {
      const stored = this.readStorage();
      if (stored.length > 0) {
        this.entries = stored.slice(-Math.floor(this.maxEntries / 2)) as LogEntry[];
      }
    } catch {
      /* ignore */
    }
  }

  /** Sendet den Warteschlangen-Inhalt an den dateibasierten Main-/Server-Logger. */
  public async flush(urgent = false): Promise<void> {
    if (this.persistQueue.length === 0) return;
    if (this.inFlightFlush && !urgent) return this.inFlightFlush;

    const batch = this.persistQueue.splice(0, this.persistQueue.length);
    const payload = batch.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      level: e.level,
      category: e.category,
      message: e.message,
      details: e.details,
      stack: e.stack,
      sessionId: e.sessionId,
    }));

    const run = async (): Promise<void> => {
      // 1) Desktop: direkter, vertrauenswürdiger IPC-Kanal zur Logdatei.
      const bridge = typeof window !== 'undefined' ? window.rekordboxDesktop : undefined;
      if (bridge?.writeLogEntries) {
        try {
          bridge.writeLogEntries(payload);
          return;
        } catch {
          // darunter auf localStorage/hiernach HTTP verlassen
        }
      }
      // 2) Dev-Server: Sammel-Endpunkt (keepalive für urgent/unload).
      if (typeof fetch === 'function') {
        try {
          const response = await fetch('/api/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: payload }),
            keepalive: urgent,
          });
          if (response.ok) return;
        } catch {
          // Offline / kein Dev-Server – localStorage bleibt als Sicherung.
        }
      }
    };

    const task = run();
    this.inFlightFlush = task;
    try {
      await task;
    } finally {
      this.inFlightFlush = null;
    }
  }

  /** Informationen über die aktive Datei-Protokollierung (Desktop/Dev). */
  public async getFileLogInfo(): Promise<FileLogInfo | null> {
    try {
      const bridge = typeof window !== 'undefined' ? window.rekordboxDesktop : undefined;
      if (bridge?.getLogInfo) return await bridge.getLogInfo();
      if (typeof fetch === 'function') {
        const response = await fetch('/api/logs/info');
        if (response.ok) return (await response.json()) as FileLogInfo;
      }
    } catch {
      /* nicht erreichbar */
    }
    return null;
  }

  public async readFileLogTail(maxBytes = 262144): Promise<{ file: string | null; text: string } | null> {
    try {
      const bridge = typeof window !== 'undefined' ? window.rekordboxDesktop : undefined;
      if (bridge?.readLogTail) return await bridge.readLogTail(maxBytes);
      return null;
    } catch {
      return null;
    }
  }

  public async openLogFolder(): Promise<boolean> {
    try {
      const bridge = typeof window !== 'undefined' ? window.rekordboxDesktop : undefined;
      if (bridge?.openLogFolder) {
        await bridge.openLogFolder();
        return true;
      }
    } catch {
      /* nicht verfügbar */
    }
    return false;
  }

  /**
   * Generates a complete JSON diagnostic report including browser environment,
   * audio context state, memory usage and historical log records.
   */
  public generateDiagnosticReport(appContextState?: unknown): string {
    const report = {
      title: 'airdox_SMART_Editor – Diagnosebericht',
      generatedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
      language: typeof navigator !== 'undefined' ? navigator.language : 'N/A',
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      screenResolution: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : 'N/A',
      memory: (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory || null,
      appContext: appContextState || {},
      recentLogs: this.entries,
    };
    return JSON.stringify(report, null, 2);
  }

  public downloadReport(appContextState?: unknown, filename = 'airdox_diagnostic_log.json') {
    if (typeof document === 'undefined') return;
    // Sicherstellen, dass der Bericht auch wirklich alle wartenden Einträge enthält.
    void this.flush(true);
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
