/**
 * Main/server file logger with daily rotation, session header, IPC audit, process handlers
 * Merges main + renderer logs into same daily file: %APPDATA%/airdox_SMART_Editor/logs/airdox-editor-YYYY-MM-DD.log or logs/ dev
 * Retention 14d via AIRDOX_LOG_RETENTION_DAYS, level via AIRDOX_LOG_LEVEL, secret redaction, binary summarization
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = (process.env.AIRDOX_LOG_LEVEL || 'info').toLowerCase();
let logDir = null;
let currentFile = null;
let fileStream = null;
let sessionId = null;

function getRetentionDays() {
  const v = parseInt(process.env.AIRDOX_LOG_RETENTION_DAYS || '14', 10);
  return Number.isFinite(v) && v > 0 ? v : 14;
}

function ensureSessionId() {
  if (!sessionId) {
    sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return sessionId;
}

function getLogDir(app) {
  if (logDir) return logDir;
  try {
    if (app && typeof app.getPath === 'function') {
      logDir = path.join(app.getPath('userData'), 'logs');
    } else {
      // dev fallback
      logDir = path.join(process.cwd(), 'logs');
    }
  } catch {
    logDir = path.join(process.cwd(), 'logs');
  }
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {}
  return logDir;
}

function getLogFilePath(app, date = new Date()) {
  const dir = getLogDir(app);
  const day = date.toISOString().slice(0, 10);
  return path.join(dir, `airdox-editor-${day}.log`);
}

function shouldLog(level) {
  const lvl = LEVELS[level] ?? LEVELS.info;
  const cur = LEVELS[currentLevel] ?? LEVELS.info;
  return lvl >= cur;
}

function redactSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const secretKeys = ['apiKey', 'api_key', 'GEMINI_API_KEY', 'password', 'token', 'secret', 'authorization'];
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(clone)) {
    const lower = key.toLowerCase();
    if (secretKeys.some(s => lower.includes(s.toLowerCase()))) {
      clone[key] = '[REDACTED]';
    } else if (typeof clone[key] === 'object' && clone[key] !== null) {
      clone[key] = redactSecrets(clone[key]);
    }
  }
  return clone;
}

function summarizeForLog(value) {
  if (value == null) return value;
  if (Buffer.isBuffer(value)) {
    return { __binary: true, byteLength: value.length, preview: value.slice(0, 20).toString('hex') };
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || (typeof value === 'object' && value.byteLength && value.buffer)) {
    const len = value.byteLength || value.length || 0;
    return { __binary: true, byteLength: len };
  }
  if (typeof value === 'object') {
    // Check for large arrays
    if (Array.isArray(value) && value.length > 100) {
      return { __array: true, length: value.length, preview: value.slice(0, 5) };
    }
    // Recursively summarize
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'data' && (v instanceof Uint8Array || Buffer.isBuffer(v) || (v && typeof v.byteLength === 'number' && v.byteLength > 1024))) {
        out[k] = { __binary: true, byteLength: v.byteLength || v.length || 0 };
      } else {
        out[k] = summarizeForLog(v);
      }
    }
    return out;
  }
  return value;
}

function formatLine(level, message, meta) {
  const ts = new Date().toISOString();
  const sid = ensureSessionId();
  const safeMeta = redactSecrets(summarizeForLog(meta || {}));
  const metaStr = Object.keys(safeMeta).length ? ` ${JSON.stringify(safeMeta)}` : '';
  return `[${ts}] [${level.toUpperCase()}] [${sid}] ${message}${metaStr}\n`;
}

function openStream(app) {
  const filePath = getLogFilePath(app);
  if (currentFile === filePath && fileStream) return fileStream;
  try {
    if (fileStream) {
      try { fileStream.end(); } catch {}
    }
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fileStream = fs.createWriteStream(filePath, { flags: 'a' });
    currentFile = filePath;
    // Session header
    const header = formatLine('info', 'Session started', {
      pid: process.pid,
      platform: os.platform(),
      arch: os.arch(),
      version: process.versions.electron || process.version,
      appVersion: (() => { try { return require('../package.json').version; } catch { return 'unknown'; } })(),
    });
    fileStream.write(header);
    return fileStream;
  } catch (e) {
    console.error('[logger] Failed to open log file', e);
    return null;
  }
}

function configureLogger(options = {}) {
  const { app, level } = options;
  if (level) currentLevel = level.toLowerCase();
  getLogDir(app);
  openStream(app);
  // Cleanup old logs
  try {
    cleanupOldLogs(getLogDir(app));
  } catch {}
  // Process handlers
  if (!global.__airdox_logger_handlers_installed) {
    global.__airdox_logger_handlers_installed = true;
    process.on('uncaughtException', (err) => {
      try { error('Uncaught exception', { error: err.message, stack: err.stack }); } catch {}
    });
    process.on('unhandledRejection', (reason) => {
      try { error('Unhandled rejection', { reason: String(reason) }); } catch {}
    });
  }
}

function cleanupOldLogs(dir) {
  const retention = getRetentionDays();
  const cutoff = Date.now() - retention * 24 * 60 * 60 * 1000;
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.startsWith('airdox-editor-') || !f.endsWith('.log')) continue;
      const full = path.join(dir, f);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
        }
      } catch {}
    }
  } catch {}
}

function write(level, message, meta, app) {
  if (!shouldLog(level)) return;
  try {
    const stream = openStream(app);
    const line = formatLine(level, message, meta);
    if (stream) stream.write(line);
    // Also console
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.log;
    consoleFn(`[${level}] ${message}`, meta ? JSON.stringify(redactSecrets(summarizeForLog(meta))).slice(0, 500) : '');
  } catch (e) {
    console.error('[logger] write failed', e);
  }
}

function debug(msg, meta, app) { write('debug', msg, meta, app); }
function info(msg, meta, app) { write('info', msg, meta, app); }
function warn(msg, meta, app) { write('warn', msg, meta, app); }
function error(msg, meta, app) { write('error', msg, meta, app); }

function ingestRendererEntries(entries, app) {
  if (!Array.isArray(entries)) entries = [entries];
  for (const entry of entries) {
    if (!entry) continue;
    const level = entry.level || entry.severity || 'info';
    const message = entry.message || entry.msg || JSON.stringify(entry).slice(0, 500);
    const meta = { ...entry, source: 'renderer', level: undefined, message: undefined };
    write(level, `[renderer] ${message}`, meta, app);
  }
}

function getCurrentLogPath(app) {
  return getLogFilePath(app);
}

function flush() {
  return new Promise((resolve) => {
    if (!fileStream) return resolve();
    fileStream.write('', () => resolve());
  });
}

module.exports = {
  configureLogger,
  getLogDir,
  getLogFilePath,
  getCurrentLogPath,
  debug,
  info,
  warn,
  error,
  ingestRendererEntries,
  summarizeForLog,
  redactSecrets,
  formatLogLine: (entry) => {
    const level = entry.level || 'info';
    const msg = entry.message || '';
    return formatLine(level, msg, entry);
  },
  createLogWriter: (filePath) => {
    // Legacy compatibility
    const dir = path.dirname(filePath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    return {
      filePath,
      append: (line) => {
        try { stream.write(line + '\n'); return true; } catch { return false; }
      },
    };
  },
};
