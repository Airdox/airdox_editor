/**
 * @license
 * Rekordbox DJ Editor - Comprehensive Diagnostic Logging System
 * 
 * Provides centralized high-resolution logging, error interception, ring-buffer persistence,
 * subscriber notifications, and complete incident telemetry for maximum transparency.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export type LogCategory =
  | 'SYSTEM'
  | 'XML_IMPORT'
  | 'AUDIO_ENGINE'
  | 'BEATGRID'
  | 'EDITING'
  | 'DATABASE'
  | 'UI';

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

class LoggerService {
  private static instance: LoggerService;
  private readonly maxEntries = 1000;
  private entries: LogEntry[] = [];
  private listeners: Set<LogListener> = new Set();
  private isInitialized = false;

  private constructor() {
    this.initGlobalHandlers();
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

    // Capture uncaught JavaScript runtime errors
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

    // Capture unhandled asynchronous Promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      this.fatal(
        'SYSTEM',
        `Unhandled Promise Rejection: ${message}`,
        { reason, stack }
      );
    });

    this.info('SYSTEM', 'Umfassendes Log-System erfolgreich initialisiert (Max Transparenz).');
  }

  public log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    details?: any
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
        stack = details.stack;
      } else {
        stack = new Error().stack;
      }
    }

    const entry: LogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: now.getTime(),
      timeString,
      level,
      category,
      message,
      details: details !== undefined ? this.sanitizeDetails(details) : undefined,
      stack,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    // Console output with Pioneer DJ-styled coloring
    this.printToConsole(entry);

    // Notify active listeners (e.g., live log modals)
    this.notifyListeners(entry);

    return entry;
  }

  private sanitizeDetails(details: any): any {
    try {
      if (details instanceof Error) {
        return {
          name: details.name,
          message: details.message,
          stack: details.stack,
        };
      }
      if (typeof details === 'object' && details !== null) {
        // Prevent circular references and huge DOM nodes
        if ('tagName' in details || 'nodeType' in details) {
          return `[DOM Element <${details.tagName}>]`;
        }
        return JSON.parse(JSON.stringify(details));
      }
      return details;
    } catch {
      return String(details);
    }
  }

  private printToConsole(entry: LogEntry) {
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
        console.error('Error in log listener:', err);
      }
    });
  }

  /**
   * Generates a complete JSON diagnostic report including browser environment,
   * audio context state, memory usage and historical log records.
   */
  public generateDiagnosticReport(appContextState?: any): string {
    const report = {
      title: 'Rekordbox DJ Audio Editor - Diagnosebericht',
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
