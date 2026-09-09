/**
 * Read-only source protection (Phase 4).
 *
 * The desktop export path writes only to NEW files. This module implements the
 * single hard rule the bridge enforces: a chosen save target must never equal
 * an original Rekordbox source (audio, XML, ANLZ or database) path. It is kept
 * free of any Electron dependency so the Node test suite can verify the rule
 * independently of the desktop shell.
 */

const path = require('node:path');

/** Normalize a path for comparison (resolved, slash-normalized, case-folded). */
function normalizeForCompare(filePath) {
  return path.resolve(String(filePath)).replace(/\\/g, '/').toLowerCase();
}

/**
 * Returns true when `targetPath` collides with any original source path.
 * Case-insensitive so a save to "C:\Music\Track.WAV" cannot overwrite an
 * original "C:\Music\Track.wav" (fail-closed on case-sensitive filesystems).
 */
function isProtectedTarget(targetPath, protectedPaths) {
  if (!Array.isArray(protectedPaths) || protectedPaths.length === 0) return false;
  const key = normalizeForCompare(targetPath);
  return protectedPaths.some(
    (p) => typeof p === 'string' && p.trim() !== '' && normalizeForCompare(p) === key
  );
}

/**
 * Resolves an XML LOCATION value to a local filesystem path (or null when it
 * is not a local file reference). Absolute paths are resolved, file:// URLs
 * are decoded via fileURLToPath, anything else (http(s), custom schemes,
 * relative library paths) maps to null or a resolved path without searching.
 * Pure apart from path resolution; used by the Electron bridge and unit-tested.
 */
function toLocalPath(location) {
  if (typeof location !== 'string' || !location.trim()) return null;

  try {
    if (/^[a-z]:[\\/]/i.test(location) || path.isAbsolute(location)) {
      return path.resolve(location);
    }

    if (/^[a-z][a-z\d+.-]*:/i.test(location)) {
      const url = new URL(location);
      return url.protocol === 'file:' ? require('node:url').fileURLToPath(url) : null;
    }

    return path.resolve(location);
  } catch {
    return null;
  }
}

module.exports = { normalizeForCompare, isProtectedTarget, toLocalPath };
