'use strict';
/**
 * Durable single-line log writer for the desktop app (pure CommonJS,
 * unit-tested by tests/log-writer.test.mjs).
 *
 * Every decisive pipeline parameter (ANLZ resolution, file sizes, tags,
 * variants, merge verdicts, import counts) is mirrored from the renderer
 * into `<userData>/airdox-smart-editor.log` so a missing waveform can be
 * diagnosed from the file alone. The writer rotates at `maxBytes` into a
 * single `.prev.log` sibling and NEVER throws — logging must not break the
 * app it observes.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_MESSAGE_CHARS = 2000;
const MAX_DATA_CHARS = 4000;

function collapseLines(value) {
  return String(value).replace(/\r\n|\r|\n/g, ' \\n ');
}

function truncate(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…(+${value.length - maxChars} Zeichen)`;
}

function safeJson(data) {
  if (data === undefined) return undefined;
  try {
    return JSON.stringify(data);
  } catch {
    try {
      return JSON.stringify(String(data));
    } catch {
      return '"<nicht serialisierbar>"';
    }
  }
}

/**
 * Formats one structured entry as a single durable line:
 *   2026-09-09T16:42:31.512Z INFO [DATABASE] message | {"key":"value"}
 */
function formatLogLine(entry) {
  const ts = Number.isFinite(entry?.ts) ? entry.ts : Date.now();
  const level = String(entry?.level ?? 'INFO').toUpperCase();
  const category = String(entry?.category ?? 'SYSTEM').toUpperCase();
  const message = truncate(collapseLines(entry?.message ?? ''), MAX_MESSAGE_CHARS);
  const dataJson = safeJson(entry?.data);
  const dataSuffix = dataJson !== undefined ? ` | ${truncate(collapseLines(dataJson), MAX_DATA_CHARS)}` : '';
  return `${new Date(ts).toISOString()} ${level} [${category}] ${message}${dataSuffix}`;
}

/**
 * Creates a durable appending writer. Rotation: when the next append would
 * exceed `maxBytes`, the current file is renamed to `<name>.prev.log`
 * (overwritten) and a fresh file starts. `append` returns true on success
 * and false when the write failed — it never throws.
 */
function createLogWriter(filePath, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const prevPath = filePath.replace(/\.log$/i, '') + '.prev.log';
  let bytesWritten = 0;
  try {
    bytesWritten = fs.statSync(filePath).size;
  } catch {
    bytesWritten = 0;
  }

  function rotate() {
    try {
      if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
      fs.renameSync(filePath, prevPath);
    } catch {
      // rotation failed; keep writing into the current file
    }
    bytesWritten = 0;
  }

  return {
    filePath,
    prevPath,
    get bytesWritten() {
      return bytesWritten;
    },
    append(line) {
      try {
        const payload = `${collapseLines(line)}\n`;
        if (bytesWritten > 0 && bytesWritten + Buffer.byteLength(payload) > maxBytes) {
          rotate();
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, payload);
        bytesWritten += Buffer.byteLength(payload);
        return true;
      } catch {
        return false;
      }
    },
  };
}

module.exports = { formatLogLine, createLogWriter, DEFAULT_MAX_BYTES };
