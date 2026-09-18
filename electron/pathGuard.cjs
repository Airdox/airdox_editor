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
 * Main-process-owned registry of every source path opened read-only. Renderer
 * payloads are not a security boundary, so save/export checks must also use
 * this authoritative list even if a renderer accidentally omits a source.
 */
class OriginalSourceRegistry {
  constructor() {
    this.paths = new Map();
  }

  register(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) return false;
    this.paths.set(normalizeForCompare(filePath), path.resolve(filePath));
    return true;
  }

  registerMany(filePaths) {
    if (!Array.isArray(filePaths)) return;
    for (const filePath of filePaths) this.register(filePath);
  }

  isProtected(targetPath, additionalPaths = []) {
    return isProtectedTarget(targetPath, [...this.values(), ...(Array.isArray(additionalPaths) ? additionalPaths : [])]);
  }

  values() {
    return Array.from(this.paths.values());
  }
}

module.exports = { normalizeForCompare, isProtectedTarget, OriginalSourceRegistry };
