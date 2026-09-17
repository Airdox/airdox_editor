/**
 * Persistent compact track↔ANLZ path index, never writes to Rekordbox sources
 * NormalizePath, sanitizeEntry
 */

const fs = require('node:fs');
const path = require('node:path');

function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  // Normalize slashes, lowercase drive letter on Windows, remove trailing slash
  let normalized = p.replace(/\\/g, '/');
  // Remove leading file://
  normalized = normalized.replace(/^file:\/\//, '');
  // Decode URI
  try { normalized = decodeURIComponent(normalized); } catch {}
  // Lowercase for case-insensitive check but preserve for storage? We store lowercased key
  normalized = normalized.trim();
  // Remove trailing slash
  if (normalized.endsWith('/') && normalized.length > 1) normalized = normalized.slice(0, -1);
  return normalized;
}

function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const trackId = entry.trackId || entry.id;
  const anlzPath = entry.anlzPath || entry.analysisPath;
  if (!trackId || !anlzPath) return null;
  const normalizedTrack = normalizePath(String(trackId));
  const normalizedAnlz = normalizePath(String(anlzPath));
  if (!normalizedTrack || !normalizedAnlz) return null;
  // Basic validation: ANLZ path should contain USBANLZ or PIONEER
  if (!normalizedAnlz.toUpperCase().includes('USBANLZ') && !normalizedAnlz.toUpperCase().includes('PIONEER')) {
    // Allow but warn – still store
  }
  return {
    trackId: normalizedTrack,
    anlzPath: normalizedAnlz,
    lastSeen: entry.lastSeen || Date.now(),
    source: entry.source || 'auto',
  };
}

class AnalysisPathRegistry {
  constructor(filePath) {
    this.filePath = filePath;
    this.map = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const e of data) {
            const sanitized = sanitizeEntry(e);
            if (sanitized) this.map.set(sanitized.trackId.toLowerCase(), sanitized);
          }
        } else if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            const sanitized = sanitizeEntry({ trackId: k, anlzPath: v, lastSeen: Date.now() });
            if (sanitized) this.map.set(sanitized.trackId.toLowerCase(), sanitized);
          }
        }
      }
    } catch (e) {
      console.warn('[analysisRegistry] load failed', e.message);
    }
    this.loaded = true;
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const arr = Array.from(this.map.values());
      fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2));
    } catch (e) {
      console.warn('[analysisRegistry] save failed', e.message);
    }
  }

  get(trackId) {
    this.load();
    const key = normalizePath(trackId).toLowerCase();
    return this.map.get(key) || null;
  }

  set(trackId, anlzPath, source = 'auto') {
    this.load();
    const entry = sanitizeEntry({ trackId, anlzPath, source, lastSeen: Date.now() });
    if (!entry) return false;
    this.map.set(entry.trackId.toLowerCase(), entry);
    this.save();
    return true;
  }

  has(trackId) {
    this.load();
    return this.map.has(normalizePath(trackId).toLowerCase());
  }

  delete(trackId) {
    this.load();
    const deleted = this.map.delete(normalizePath(trackId).toLowerCase());
    if (deleted) this.save();
    return deleted;
  }

  list() {
    this.load();
    return Array.from(this.map.values());
  }

  clear() {
    this.map.clear();
    this.save();
  }
}

function createAnalysisRegistry(app) {
  let filePath;
  try {
    if (app && typeof app.getPath === 'function') {
      filePath = path.join(app.getPath('userData'), 'analysis-path-registry.json');
    } else {
      filePath = path.join(process.cwd(), 'analysis-path-registry.json');
    }
  } catch {
    filePath = path.join(process.cwd(), 'analysis-path-registry.json');
  }
  return new AnalysisPathRegistry(filePath);
}

module.exports = {
  AnalysisPathRegistry,
  createAnalysisRegistry,
  normalizePath,
  sanitizeEntry,
};
