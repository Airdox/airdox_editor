'use strict';

/**
 * @license
 * airdox_SMART_Editor – Main-process / Node file logger.
 *
 * Single source of truth for everything that happens OUTSIDE the renderer:
 * Electron lifecycle, IPC handlers, protocol handling, Python/Demucs child
 * processes, the Express dev server and uncaught process-level failures.
 *
 * Characteristics:
 *  - append-only, human-readable *.log files, rotated once per local day
 *  - serialized, non-blocking writes with a synchronous shutdown flush
 *  - renderer entries are ingested over IPC and merged into the same file so
 *    a session's complete audit trail lives in one place (main + renderer)
 *  - automatic pruning beyond the retention window
 *  - works both inside Electron and in plain Node (server.ts / tests)
 *
 * Log file location:
 *  - Desktop : <userData>/logs/airdox-editor-YYYY-MM-DD.log
 *              (Windows: %APPDATA%/airdox_SMART_Editor/logs)
 *  - Dev     : <repo>/logs/airdox-editor-YYYY-MM-DD.log
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const LEVELS = Object.freeze({
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
  FATAL: 50,
});

const FILE_PREFIX = 'airdox-editor';
const MAX_DETAIL_CHARS = 6000;
const MAX_LINE_CHARS = 12000;

function localDateStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localTimestamp(d = new Date()) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${localDateStamp(d)} ${hh}:${mm}:${ss}.${ms}`;
}

function createSessionId() {
  const d = new Date();
  const stamp =
    localDateStamp(d).replace(/-/g, '') +
    '-' +
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0') +
    String(d.getSeconds()).padStart(2, '0');
  return `${stamp}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[nicht serialisierbar]"';
  }
}

function truncate(text, max = MAX_LINE_CHARS) {
  if (typeof text !== 'string') return text;
  return text.length > max ? `${text.slice(0, max)}… [abgeschnitten, ${text.length} Zeichen]` : text;
}

/**
 * Replaces binary payloads, DOM nodes, circular structures and secrets with a
 * compact, log-safe description so IPC arguments/results can be audited
 * without writing megabytes of audio into the log file.
 */
function summarizeForLog(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > 400 ? `${value.slice(0, 400)}… [${value.length} Zeichen]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (typeof value === 'function') return '[Function]';
  if (value instanceof Error) {
    return { __type: value.name || 'Error', message: value.message, stack: value.stack };
  }

  // Binary: ArrayBuffer, TypedArrays, Node Buffer
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    return { __binary: 'ArrayBuffer', byteLength: value.byteLength };
  }
  if (ArrayBuffer.isView(value)) {
    return { __binary: value.constructor?.name || 'TypedArray', byteLength: value.byteLength };
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return { __binary: 'Buffer', byteLength: value.length };
  }

  if (typeof value !== 'object') return String(value);
  if (depth >= 4) return Array.isArray(value) ? `[Array ${value.length}]` : '[Object]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => summarizeForLog(item, depth + 1, seen));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (/^(password|passwort|token|secret|api[-_]?key|gemini[-_]?key)$/i.test(key)) {
      out[key] = '[redacted]';
    } else if (typeof val !== 'object' || val === null) {
      out[key] = summarizeForLog(val, depth + 1, seen);
    } else {
      out[key] = summarizeForLog(val, depth + 1, seen);
    }
  }
  return out;
}

class FileLogger {
  constructor() {
    this.sessionId = createSessionId();
    this.startedAt = localTimestamp();
    this.processName = process.env.AIRDOX_LOG_PROCESS || 'main';
    this.logDirectory = null;
    this.currentDate = localDateStamp();
    this.configured = false;
    this.levelName = (process.env.AIRDOX_LOG_LEVEL || 'INFO').toUpperCase();
    this.retentionDays = Number(process.env.AIRDOX_LOG_RETENTION_DAYS) || 14;
    this.entriesWritten = 0;
    this.appInfo = {};
    this.preBuffer = [];
    this.pendingLines = [];
    this.writeChain = Promise.resolve();
    this.flushTimer = null;
    this.processHandlersInstalled = false;
    this.consoleCaptureInstalled = false;
    this.mirroringToConsole = false;
  }

  configure(options = {}) {
    if (options.logDirectory) this.logDirectory = path.resolve(options.logDirectory);
    if (options.level) this.levelName = String(options.level).toUpperCase();
    if (options.retentionDays !== undefined) {
      const days = Number(options.retentionDays);
      if (Number.isFinite(days) && days >= 0) this.retentionDays = days;
    }
    if (options.processName) this.processName = options.processName;
    if (options.appInfo) this.appInfo = { ...this.appInfo, ...options.appInfo };
    if (!this.logDirectory) {
      throw new Error('FileLogger.configure: logDirectory ist erforderlich.');
    }

    fs.mkdirSync(this.logDirectory, { recursive: true });
    this.configured = true;
    this.currentDate = localDateStamp();

    const header = this.formatSessionHeader();
    const buffered = this.preBuffer.splice(0);
    this.pendingLines.push(header, ...buffered);
    this.scheduleFlush(0);

    this.info('SYSTEM', `Datei-Logging initialisiert (${this.processName})`, {
      logDirectory: this.logDirectory,
      currentFile: this.getCurrentFilePath(),
      level: this.levelName,
      retentionDays: this.retentionDays,
      sessionId: this.sessionId,
    });

    this.pruneOldLogs().catch((err) =>
      process.stderr.write(`[logger] Aufräumen alter Logs fehlgeschlagen: ${err?.message || err}\n`)
    );
    return this;
  }

  levelWeight() {
    return LEVELS[this.levelName] ?? LEVELS.INFO;
  }

  getCurrentFilePath() {
    return path.join(this.logDirectory || '.', `${FILE_PREFIX}-${this.currentDate}.log`);
  }

  getLogDirectory() {
    return this.logDirectory;
  }

  getInfo() {
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      processName: this.processName,
      logDirectory: this.logDirectory,
      currentFile: this.configured ? this.getCurrentFilePath() : null,
      level: this.levelName,
      retentionDays: this.retentionDays,
      entriesWritten: this.entriesWritten,
      versions: { ...process.versions },
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      appVersion: this.appInfo.appVersion || null,
    };
  }

  debug(category, message, details) {
    return this.write('DEBUG', category, message, details);
  }
  info(category, message, details) {
    return this.write('INFO', category, message, details);
  }
  warn(category, message, details) {
    return this.write('WARN', category, message, details);
  }
  error(category, message, details) {
    return this.write('ERROR', category, message, details);
  }
  fatal(category, message, details) {
    return this.write('FATAL', category, message, details);
  }

  write(level, category, message, details, meta = {}) {
    if ((LEVELS[level] ?? LEVELS.INFO) < this.levelWeight()) return null;
    const entry = {
      timestamp: Date.now(),
      level,
      category: category || 'SYSTEM',
      process: meta.process || this.processName,
      message: typeof message === 'string' ? message : safeJson(message),
      details,
      stack: details instanceof Error ? details.stack : meta.stack,
      source: meta.source,
    };
    const line = this.formatLine(entry);
    this.mirrorToConsole(entry, line);

    if (!this.configured) {
      this.preBuffer.push(line);
      // Never let the pre-ready buffer grow without bounds.
      if (this.preBuffer.length > 500) this.preBuffer.shift();
    } else {
      this.rotateIfNeeded();
      this.pendingLines.push(line);
      this.scheduleFlush(LEVELS[level] >= LEVELS.ERROR ? 0 : 250);
    }
    this.entriesWritten += 1;
    return entry;
  }

  /**
   * Accepts a batch of renderer LogEntry objects (structured-clone safe) and
   * merges them into the same daily file, tagged [renderer/<category>].
   */
  ingestRendererEntries(entries) {
    if (!Array.isArray(entries)) return { accepted: 0 };
    let accepted = 0;
    for (const raw of entries.slice(-2000)) {
      if (!raw || typeof raw.message !== 'string') continue;
      const level = LEVELS[raw.level] ? raw.level : 'INFO';
      if (LEVELS[level] < this.levelWeight()) continue;
      const entry = {
        timestamp: Number(raw.timestamp) || Date.now(),
        level,
        category: raw.category || 'UI',
        process: 'renderer',
        message: raw.message,
        details: raw.details,
        stack: raw.stack,
        source: raw.sessionId ? `renderer:${raw.sessionId}` : 'renderer',
      };
      const line = this.formatLine(entry);
      this.mirrorToConsole(entry, line);
      if (!this.configured) this.preBuffer.push(line);
      else {
        this.rotateIfNeeded();
        this.pendingLines.push(line);
      }
      accepted += 1;
      this.entriesWritten += 1;
    }
    if (accepted > 0) this.scheduleFlush(0);
    return { accepted };
  }

  formatSessionHeader() {
    const info = this.getInfo();
    const lines = [
      '='.repeat(88),
      `SESSION ${this.sessionId} START ${this.startedAt}`,
      `  App      : ${this.appInfo.appName || 'airdox_SMART_Editor'} ${this.appInfo.appVersion || ''}`.trimEnd(),
      `  Prozess  : ${this.processName} | PID ${process.pid}`,
      `  System   : ${process.platform} ${process.arch} | Electron ${process.versions.electron || '-'} | Node ${process.version} | Chrome ${process.versions.chrome || '-'}`,
      `  Arbeitsverzeichnis: ${process.cwd()}`,
      `  Log-Level: ${this.levelName} | Aufbewahrung: ${this.retentionDays} Tage`,
      `  Log-Datei: ${this.getCurrentFilePath()}`,
    ];
    if (process.argv && process.argv.length) {
      lines.push(`  argv     : ${process.argv.map((a) => summarizeForLog(a)).join(' ')}`);
    }
    lines.push('='.repeat(88));
    return `${lines.join('\n')}\n`;
  }

  formatLine(entry) {
    const ts = localTimestamp(new Date(entry.timestamp));
    const level = String(entry.level || 'INFO').padEnd(5, ' ');
    const sourceTag = entry.source ? ` {${entry.source}}` : '';
    const head = `${ts} [${level}] [${entry.process}/${entry.category}]${sourceTag} ${entry.message}`;
    const parts = [head];

    if (entry.details !== undefined) {
      const detail =
        entry.details instanceof Error
          ? safeJson(summarizeForLog({ name: entry.details.name, message: entry.details.message }))
          : safeJson(summarizeForLog(entry.details));
      if (detail && detail !== '{}' && detail !== 'null') {
        parts.push(`  ↳ ${truncate(detail, MAX_DETAIL_CHARS)}`);
      }
    }
    if (entry.stack && typeof entry.stack === 'string') {
      const stackText = String(entry.stack)
        .split('\n')
        .slice(0, 20)
        .map((l) => `    ${l.trim()}`)
        .join('\n');
      parts.push(stackText);
    }
    return truncate(parts.join('\n')) + '\n';
  }

  mirrorToConsole(entry, line) {
    // File output is authoritative; still mirror to the terminal (dev runs,
    // `electron .` from a console). Strip trailing newline for console calls.
    const trimmed = line.trimEnd();
    this.mirroringToConsole = true;
    try {
      /* eslint-disable no-console */
      switch (entry.level) {
        case 'DEBUG':
          if (process.stdout.isTTY) console.debug?.(trimmed);
          break;
        case 'INFO':
          console.log(trimmed);
          break;
        case 'WARN':
          console.warn(trimmed);
          break;
        case 'ERROR':
        case 'FATAL':
          console.error(trimmed);
          break;
      }
      /* eslint-enable no-console */
    } finally {
      this.mirroringToConsole = false;
    }
  }

  rotateIfNeeded() {
    const today = localDateStamp();
    if (today !== this.currentDate) {
      this.currentDate = today;
      this.info('SYSTEM', `Log-Tagesrotation → ${path.basename(this.getCurrentFilePath())}`);
    }
  }

  scheduleFlush(delay = 250) {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) =>
        process.stderr.write(`[logger] Schreiben fehlgeschlagen: ${err?.message || err}\n`)
      );
    }, delay);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  flush() {
    this.writeChain = this.writeChain.then(async () => {
      if (!this.configured || this.pendingLines.length === 0) return;
      const batch = this.pendingLines.splice(0, this.pendingLines.length).join('');
      await fsp.appendFile(this.getCurrentFilePath(), batch, 'utf8');
    });
    return this.writeChain;
  }

  /** Synchronous fallback used during process shutdown / hard crashes. */
  flushSync() {
    try {
      if (!this.configured || this.pendingLines.length === 0) return;
      const batch = this.pendingLines.splice(0, this.pendingLines.length).join('');
      fs.appendFileSync(this.getCurrentFilePath(), batch, 'utf8');
    } catch (err) {
      process.stderr.write(`[logger] flushSync fehlgeschlagen: ${err?.message || err}\n`);
    }
  }

  async pruneOldLogs() {
    if (!this.configured) return;
    let files = [];
    try {
      files = await fsp.readdir(this.logDirectory);
    } catch {
      return;
    }
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);
    const stampRe = new RegExp(`^${FILE_PREFIX}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
    for (const name of files) {
      const match = name.match(stampRe);
      if (!match) continue;
      const fileDate = new Date(`${match[1]}T00:00:00`);
      if (Number.isNaN(fileDate.getTime())) continue;
      if (fileDate < cutoff) {
        try {
          await fsp.unlink(path.join(this.logDirectory, name));
          this.debug('SYSTEM', `Alte Log-Datei entfernt: ${name}`);
        } catch {
          /* best effort */
        }
      }
    }
  }

  /** Returns the tail of today's log file (main + renderer, this session and earlier). */
  readRecent(maxBytes = 256 * 1024) {
    if (!this.configured) return { file: null, text: '' };
    const file = this.getCurrentFilePath();
    let text = '';
    try {
      const stat = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      try {
        const size = Math.min(stat.size, maxBytes);
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, stat.size - size);
        text = buf.toString('utf8');
        if (stat.size > maxBytes && text.includes('\n')) {
          text = text.slice(text.indexOf('\n') + 1);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
    return { file, text };
  }

  installProcessHandlers() {
    if (this.processHandlersInstalled) return;
    this.processHandlersInstalled = true;

    process.on('uncaughtException', (err, origin) => {
      this.fatal('SYSTEM', `Uncaught Exception (${origin}): ${err?.message || err}`, {
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
      });
      this.flushSync();
    });
    process.on('unhandledRejection', (reason) => {
      const err = reason instanceof Error ? reason : null;
      this.fatal(
        'SYSTEM',
        `Unhandled Promise Rejection: ${err?.message || String(reason)}`,
        err || { reason: String(reason) }
      );
      this.flushSync();
    });

    const exitHandler = () => this.flushSync();
    process.on('beforeExit', exitHandler);
    process.on('exit', exitHandler);
    process.on('SIGINT', () => {
      this.info('SYSTEM', 'SIGINT erhalten – Prozess beendet sich.');
      this.flushSync();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      this.info('SYSTEM', 'SIGTERM erhalten – Prozess beendet sich.');
      this.flushSync();
      process.exit(0);
    });
  }

  /**
   * Forwards any console.* produced by Electron internals / third-party code
   * into the file. Re-entrant: the logger's own console mirror is skipped.
   */
  installConsoleCapture() {
    if (this.consoleCaptureInstalled || typeof console === 'undefined') return;
    this.consoleCaptureInstalled = true;
    let inside = false;
    const wrap = (method, level) => {
      const original = console[method]?.bind(console);
      if (!original) return;
      console[method] = (...args) => {
        if (inside || this.mirroringToConsole) {
          original(...args);
          return;
        }
        inside = true;
        try {
          const message = args
            .map((a) => (typeof a === 'string' ? a : safeJson(summarizeForLog(a))))
            .join(' ')
            .replace(/%c|color:[^;'\"]+/g, '')
            .trim();
          if (message) this.write(level, 'CONSOLE', message);
          original(...args);
        } catch {
          original(...args);
        } finally {
          inside = false;
        }
      };
    };
    wrap('error', 'ERROR');
    wrap('warn', 'WARN');
    wrap('info', 'INFO');
  }
}

const mainLogger = new FileLogger();

module.exports = {
  mainLogger,
  FileLogger,
  LEVELS,
  summarizeForLog,
  localDateStamp,
};
