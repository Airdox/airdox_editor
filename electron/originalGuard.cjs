/**
 * @license
 * Original Protection Guard (permanent, main process).
 *
 * The hard, permanent safety net for the non-destructive rule:
 * once an original source (audio, ANLZ, database, XML) is registered,
 * the application may READ it — and ANY other operation (write, append,
 * overwrite, rename, move, delete, truncate) is blocked and logged as an
 * intervention.
 *
 * Why this exists on top of pathGuard.isProtectedTarget:
 *  - isProtectedTarget is per-call and relies on the renderer passing the
 *    protected paths with every request. This registry lives in the main
 *    process and is ALWAYS consulted by the write path, so the guarantee
 *    holds even if the renderer forgets, lags, or is buggy.
 *  - The registry accumulates every original the app has ever learned about
 *    in this session (tracks, ANLZ containers, databases, XML files).
 *
 * Fail-closed semantics for risky operations on registered originals.
 * Reading is always allowed — originals exist to be read, and the app must
 * never hide a missing source behind a synthesized substitute.
 *
 * Kept free of any Electron dependency so the Node test suite can verify it
 * independently of the desktop shell.
 */

const { normalizeForCompare } = require('./pathGuard.cjs');

/** Operations that can change or destroy a file. READ is never in this set. */
const RISKY_OPERATIONS = new Set([
  'WRITE',
  'APPEND',
  'OVERWRITE',
  'RENAME',
  'MOVE',
  'DELETE',
  'TRUNCATE',
]);

/**
 * Creates an isolated guard instance (the app uses one singleton in the
 * main process; tests create their own).
 */
function createOriginalGuard() {
  const originals = new Map(); // normalized path -> entry
  const interventions = [];

  /**
   * Registers original source paths. Entries may be strings or
   * { path, kind }. kind: 'AUDIO' | 'ANLZ' | 'DATABASE' | 'XML' | 'PROJECT'
   * | 'UNKNOWN'. Idempotent; returns how many new paths were added.
   */
  function registerOriginals(entries) {
    let added = 0;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const p = entry && typeof entry === 'object' ? entry.path : entry;
        if (typeof p !== 'string' || !p.trim()) continue;
        const key = normalizeForCompare(p);
        if (!originals.has(key)) {
          originals.set(key, {
            path: p,
            kind:
              entry && typeof entry === 'object' && typeof entry.kind === 'string' && entry.kind
                ? entry.kind
                : 'UNKNOWN',
            registeredAt: Date.now(),
          });
          added += 1;
        }
      }
    }
    return { added, total: originals.size };
  }

  /** Lists registered originals (for UI status display). */
  function listOriginals() {
    return Array.from(originals.values()).map((v) => ({ path: v.path, kind: v.kind }));
  }

  /** True when the path is a registered original (case-insensitive compare). */
  function isOriginal(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) return false;
    return originals.has(normalizeForCompare(filePath));
  }

  /**
   * Verdict for one operation on one path.
   *  - READ / OPEN_READ: always allowed (originals are read-only sources).
   *  - Unknown operation: allowed, treated as read-only (documented note).
   *  - Risky operation on a registered original: BLOCKED + intervention log.
   *  - Risky operation on anything else: allowed (working copy / new file).
   */
  function checkOperation(operation, filePath, context) {
    const op = String(operation || 'WRITE').toUpperCase();
    const base = { operation: op, filePath };

    if (op === 'READ' || op === 'OPEN_READ') {
      return { allowed: true, verdict: 'ALLOWED', ...base };
    }
    if (!RISKY_OPERATIONS.has(op)) {
      return {
        allowed: true,
        verdict: 'ALLOWED',
        ...base,
        note: 'Unbekannte Operation — vorsorglich als lesend behandelt.',
      };
    }
    if (typeof filePath === 'string' && isOriginal(filePath)) {
      const entry = originals.get(normalizeForCompare(filePath));
      interventions.push({
        ts: Date.now(),
        operation: op,
        target: filePath,
        original: entry.path,
        kind: entry.kind,
        context: context || null,
      });
      return {
        allowed: false,
        verdict: 'BLOCKED_ORIGINAL',
        ...base,
        originalPath: entry.path,
        kind: entry.kind,
        reason: 'Originalquelle geschützt: nur Lesegriffe sind erlaubt (Read-Only).',
      };
    }
    return { allowed: true, verdict: 'ALLOWED_WORKING_COPY', ...base };
  }

  /** Recent intervention records (last 200). */
  function interventionsLog() {
    return interventions.slice(-200);
  }

  /** Removes everything (test helper; the app never calls this). */
  function reset() {
    originals.clear();
    interventions.length = 0;
  }

  return {
    registerOriginals,
    listOriginals,
    isOriginal,
    checkOperation,
    interventionsLog,
    reset,
  };
}

module.exports = { createOriginalGuard, RISKY_OPERATIONS };
