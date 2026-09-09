/**
 * @license
 * Rekordbox AnalysisDataPath Resolver & XML↔DB Track-Linker (pure, tested).
 *
 * Resolves the ANLZ analysis file of a track deterministically:
 *
 *   <directory containing master.db>/
 *       share/
 *           PIONEER/
 *               USBANLZ/
 *                   <hash>/<uuid>/ANLZ0000.DAT
 *
 * Rules (no guessing, no searching, no reconstruction from track names):
 *  - Absolute paths (Windows drive / UNC) and absolute file:// URLs are used
 *    verbatim.
 *  - Device-relative forms `[/]PIONEER/USBANLZ/...` (optionally prefixed with
 *    `share/`) resolve against `<dbDir>/share/`.
 *  - Every other relative form resolves to null: the caller must fall back to
 *    manual ANLZ assignment instead of searching the filesystem.
 *
 * The XML↔DB link is an exact match on the normalized audio path only
 * (XML LOCATION vs. DB FolderPath+FileName); there is no fuzzy/metadata
 * similarity matching.
 */

/** Directory portion of a file path (pure string operation, any separator). */
export function dirOfPath(filePath: string): string {
  const s = filePath.trim().replace(/[\\/]+$/, '');
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx > 0 ? s.slice(0, idx) : s;
}

/**
 * Resolves an AnalysisDataPath value to a concrete ANLZ file path.
 *
 * @param dbDir Directory containing the Rekordbox database (master.db /
 *   exportLibrary.db); used as the anchor for `<dbDir>/share/...`.
 * @param analysisDataPath Raw AnalysisDataPath value from the database row.
 * @returns Absolute file path, or null when no deterministic resolution exists.
 */
export function resolveAnalysisFilePath(
  dbDir: string | undefined | null,
  analysisDataPath: string | undefined | null
): string | null {
  const raw = (analysisDataPath ?? '').trim();
  if (!raw) return null;

  // Absolute paths are used verbatim — never reinterpreted.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return raw;

  let rel = raw;
  const fileMatch = rel.match(/^file:\/\/(localhost)?\/?/i);
  if (fileMatch) {
    rel = rel.slice(fileMatch[0].length);
    try {
      rel = decodeURIComponent(rel);
    } catch {
      // keep raw value
    }
    if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('\\\\')) return rel;
    const withDrive = rel.replace(/^\/([a-zA-Z]:)/, '$1');
    if (/^[a-zA-Z]:[\\/]/.test(withDrive)) return withDrive;
  }

  // Device-relative form: [/][share/]PIONEER/USBANLZ/... → <dbDir>/share/PIONEER/...
  rel = rel.replace(/^[\\/]+/, '').replace(/^share[\\/]/i, '');
  if (!/^PIONEER[\\/]/i.test(rel)) return null;

  const dir = (dbDir ?? '').trim().replace(/[\\/]+$/, '');
  if (!dir) return null;
  const sep = dir.includes('\\') ? '\\' : '/';
  const tail = rel.replace(/[\\/]+/g, sep);
  return `${dir}${sep}share${sep}${tail}`;
}

/**
 * Normalizes an audio location (XML `file://` LOCATION or DB
 * FolderPath+FileName) into a canonical key so both spellings of the same
 * file compare equal. URL-decoded, separator-unified, case-folded.
 */
export function normalizeAudioKey(input: string | undefined | null): string {
  if (!input) return '';
  let s = input.trim();
  const fileMatch = s.match(/^file:\/\/(localhost)?\/?/i);
  if (fileMatch) {
    s = s.slice(fileMatch[0].length);
  }
  if (s.includes('%')) {
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep raw value
    }
  }
  s = s.replace(/\\/g, '/');
  s = s.replace(/^\/([a-zA-Z]:\/)/, '$1');
  s = s.replace(/\/{2,}/g, '/');
  return s.toLowerCase();
}

export interface DbAnalysisRef {
  trackId: string;
  analysisDataPath: string;
  sourceDbDir: string;
}

/**
 * Builds the deterministic XML→DB analysis index: normalized audio path →
 * ANLZ reference. Tracks without a location or without an AnalysisDataPath
 * are skipped (first entry wins on duplicates).
 */
export function buildDbAnalysisIndex(
  tracks: {
    id: string;
    originalMedia?: { location: string };
    rawXmlAttributes?: Record<string, string>;
  }[],
  sourceDbDir: string
): Map<string, DbAnalysisRef> {
  const index = new Map<string, DbAnalysisRef>();
  for (const track of tracks) {
    const key = normalizeAudioKey(track.originalMedia?.location);
    const analysisDataPath = track.rawXmlAttributes?.analysisDataPath?.trim() ?? '';
    if (!key || !analysisDataPath || index.has(key)) continue;
    index.set(key, { trackId: track.id, analysisDataPath, sourceDbDir });
  }
  return index;
}
