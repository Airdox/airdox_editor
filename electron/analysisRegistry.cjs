/**
 * Persistent Rekordbox analysis-path registry.
 *
 * This is intentionally a tiny JSON-backed index rather than another copy of
 * Rekordbox's SQLCipher library.  It stores only read-only references between
 * a track identity/media path and its ANLZ (.DAT/.EXT/.2EX) path.  Once a
 * mapping has been seen, the application can reopen the ANLZ source directly
 * and no longer has to reopen master.db merely to discover that relationship.
 */

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 100_000;
const MAX_STRING_LENGTH = 8_192;

function now() {
  return Date.now();
}

function cleanString(value, maxLength = MAX_STRING_LENGTH) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

/**
 * Normalizes Windows, POSIX and file:// paths without requiring that a Windows
 * path is meaningful on the platform currently running a test.
 */
function normalizePath(value) {
  let input = cleanString(value);
  if (!input) return '';
  try {
    if (/^file:/i.test(input)) {
      input = require('node:url').fileURLToPath(input);
    }
  } catch {
    // Keep the raw path below; a malformed file URL simply cannot be a strong key.
  }
  input = input.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  // Rekordbox's Windows paths are case-insensitive even when an index is being
  // inspected on another platform.
  if (/^[A-Za-z]:\//.test(input) || process.platform === 'win32') input = input.toLowerCase();
  return input;
}

function stableKey(entry) {
  const media = normalizePath(entry.mediaPath || entry.sourceMediaPath);
  const analysis = normalizePath(entry.analysisPath);
  const trackId = cleanString(entry.trackId, 512);
  return `${media || `track:${trackId || 'unknown'}`}|${analysis}`;
}

function validAnalysisPath(value) {
  const normalized = normalizePath(value);
  return /\.(dat|ext|2ex|anlz)$/i.test(normalized);
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const analysisPath = cleanString(raw.analysisPath);
  if (!validAnalysisPath(analysisPath)) return null;

  const trackId = cleanString(raw.trackId, 512);
  const mediaPath = cleanString(raw.mediaPath || raw.sourceMediaPath);
  const title = cleanString(raw.title, 1024);
  const artist = cleanString(raw.artist, 1024);
  if (!trackId && !mediaPath && !(title && artist)) return null;

  const formatValue = cleanString(raw.format, 16).toUpperCase();
  const format = ['DAT', 'EXT', '2EX', 'ANLZ'].includes(formatValue)
    ? formatValue
    : (analysisPath.split('.').pop() || 'ANLZ').toUpperCase();
  const observedAt = Number.isFinite(Number(raw.observedAt)) ? Number(raw.observedAt) : now();
  const modifiedAt = Number.isFinite(Number(raw.modifiedAt)) ? Number(raw.modifiedAt) : undefined;
  const size = Number.isFinite(Number(raw.size)) && Number(raw.size) >= 0 ? Number(raw.size) : undefined;
  const sourceDuration = Number.isFinite(Number(raw.sourceDuration)) && Number(raw.sourceDuration) > 0
    ? Number(raw.sourceDuration)
    : undefined;

  return {
    trackId,
    mediaPath,
    analysisPath,
    sourceMediaPath: cleanString(raw.sourceMediaPath),
    title,
    artist,
    format,
    source: cleanString(raw.source, 64) || 'UNKNOWN',
    observedAt,
    modifiedAt,
    size,
    sourceDuration,
  };
}

class AnalysisPathRegistry {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
    this.entries = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!raw || raw.version !== REGISTRY_VERSION || !Array.isArray(raw.entries)) return;
      for (const candidate of raw.entries) {
        const entry = sanitizeEntry(candidate);
        if (entry) this.entries.set(stableKey(entry), entry);
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        // A broken cache must never prevent the desktop app from starting. A
        // subsequent successful registration atomically replaces it.
        console.warn('[AnalysisRegistry] Index konnte nicht gelesen werden:', error.message || error);
      }
    }
  }

  persist() {
    this.load();
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const entries = Array.from(this.entries.values())
      .sort((a, b) => b.observedAt - a.observedAt)
      .slice(0, this.maxEntries);
    const payload = JSON.stringify({
      version: REGISTRY_VERSION,
      updatedAt: now(),
      entries,
    }, null, 2);
    const tempPath = `${this.filePath}.${process.pid}.${now()}.tmp`;
    fs.writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
  }

  registerMany(candidates) {
    this.load();
    const rows = Array.isArray(candidates) ? candidates : [];
    let accepted = 0;
    let rejected = 0;
    let updated = 0;

    for (const candidate of rows.slice(0, this.maxEntries)) {
      const entry = sanitizeEntry(candidate);
      if (!entry) {
        rejected++;
        continue;
      }
      const key = stableKey(entry);
      const previous = this.entries.get(key);
      // A later lightweight lookup/update may not know filesystem metadata.
      // Keep previously observed optional values instead of replacing them with
      // `undefined`, especially the source duration needed for ANLZ timing.
      this.entries.set(key, {
        ...previous,
        ...entry,
        size: entry.size ?? previous?.size,
        modifiedAt: entry.modifiedAt ?? previous?.modifiedAt,
        sourceDuration: entry.sourceDuration ?? previous?.sourceDuration,
        observedAt: now(),
      });
      accepted++;
      if (previous) updated++;
    }

    if (accepted > 0) {
      // Trim before writing so unbounded imports cannot turn this into a copy
      // of the library database.
      if (this.entries.size > this.maxEntries) {
        const retained = Array.from(this.entries.entries())
          .sort(([, a], [, b]) => b.observedAt - a.observedAt)
          .slice(0, this.maxEntries);
        this.entries = new Map(retained);
      }
      this.persist();
    }

    return { accepted, updated, rejected, total: this.entries.size };
  }

  /**
   * Finds the best mapping without trusting track ID alone. An exact media path
   * wins over an ID/title match so library IDs reused across devices cannot
   * attach an unrelated ANLZ file to a track.
   */
  find(query = {}) {
    this.load();
    const trackId = cleanString(query.trackId, 512);
    const mediaPath = normalizePath(query.mediaPath || query.sourceMediaPath);
    const title = cleanString(query.title, 1024).toLocaleLowerCase();
    const artist = cleanString(query.artist, 1024).toLocaleLowerCase();

    let best = null;
    let bestScore = 0;
    for (const entry of this.entries.values()) {
      let score = 0;
      const candidateMedia = normalizePath(entry.mediaPath || entry.sourceMediaPath);
      if (mediaPath && candidateMedia && mediaPath === candidateMedia) score += 100;
      if (trackId && entry.trackId && trackId === entry.trackId) score += 25;
      if (title && entry.title && title === entry.title.toLocaleLowerCase()) score += 8;
      if (artist && entry.artist && artist === entry.artist.toLocaleLowerCase()) score += 4;
      if (score > bestScore || (score === bestScore && score > 0 && best && entry.observedAt > best.observedAt)) {
        best = entry;
        bestScore = score;
      }
    }

    if (!best || bestScore <= 0) return null;
    return { ...best, matchScore: bestScore };
  }

  stats() {
    this.load();
    return { version: REGISTRY_VERSION, entries: this.entries.size, filePath: this.filePath };
  }
}

module.exports = {
  AnalysisPathRegistry,
  normalizePath,
  sanitizeEntry,
  REGISTRY_VERSION,
};
