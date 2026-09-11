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
  const segments = rel.split(/[\\/]+/);
  if (
    segments.length < 4 ||
    segments[0].toLowerCase() !== 'pioneer' ||
    segments[1].toLowerCase() !== 'usbanlz' ||
    segments.some((part) => !part || part === '.' || part === '..')
  ) return null;

  const dir = (dbDir ?? '').trim().replace(/[\\/]+$/, '');
  if (!dir) return null;
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir}${sep}share${sep}${segments.join(sep)}`;
}

/**
 * Joins djmdContent.FolderPath and FileNameL without corrupting Rekordbox 7
 * rows where FolderPath already contains the complete media file path.
 * This is deterministic path handling, not matching or guessing.
 */
export function joinAudioPath(
  folder: string | undefined | null,
  fileName: string | undefined | null
): string {
  const file = (fileName ?? '').trim();
  const dir = (folder ?? '').trim();
  if (!file) return dir;
  if (!dir) return file;
  const stripped = dir.replace(/[\\/]+$/, '');
  const base = stripped.split(/[\\/]/).pop() ?? '';
  if (base.toLowerCase() === file.toLowerCase()) return stripped;
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${stripped}${sep}${file}`;
}

/**
 * Normalizes an audio location (XML `file://` LOCATION or DB media path) into
 * a canonical exact key. URL-decoded, separator-unified, case-folded.
 */
export function normalizeAudioKey(input: string | undefined | null): string {
  if (!input) return '';
  let s = input.trim();
  const fileMatch = s.match(/^file:\/\/(localhost)?\/?/i);
  if (fileMatch) {
    s = s.slice(fileMatch[0].length);
  }
  // Windows long-path prefix (\\?\C:\...) → plain drive path (stay in sync
  // with electron/dbReader.cjs normalizeAnlzPathKey).
  s = s.replace(/^\\\\\?\\([a-zA-Z]:)/, '$1');
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
  /** Exact canonical spellings of djmdContent.FolderPath for identity checks. */
  audioKeys?: string[];
}

/**
 * Derives the deterministic sibling analysis file for a resolved ANLZ path.
 * Rekordbox splits every analysis across two files in the same folder:
 * ANLZnnnn.DAT (source path, beat grid, cues, preview waveforms) and
 * ANLZnnnn.EXT (full-resolution color waveform PWV5, PSSI phrase structure,
 * PCO2 extended cues). The sibling is a pure string rewrite — same folder,
 * same basename, only the extension swapped — never a search.
 *
 * Returns null when the path already carries the target extension
 * (case-insensitive) or has no extension to replace.
 */
export function deriveSiblingExtension(filePath: string, targetExt: string): string | null {
  const trimmed = (filePath ?? '').trim();
  const ext = targetExt.replace(/^\./, '');
  if (!trimmed || !ext) return null;
  const match = trimmed.match(/^(.*)\.([A-Za-z0-9]+)$/);
  if (!match) return null;
  if (match[2].toLowerCase() === ext.toLowerCase()) return null;
  return `${match[1]}.${ext}`;
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
  // A canonical audio path that maps to more than one distinct analysis
  // reference is ambiguous: linking it would mean picking an arbitrary row.
  // Ambiguous keys are excluded entirely — a truthful pipeline error beats a
  // silently wrong waveform.
  const ambiguousKeys = new Set<string>();
  const dbDirKey = normalizeAudioKey(sourceDbDir);
  for (const track of tracks) {
    const key = normalizeAudioKey(track.originalMedia?.location);
    const analysisDataPath = track.rawXmlAttributes?.analysisDataPath?.trim() ?? '';
    if (!key || !analysisDataPath) continue;
    const audioKeys = [key];
    // Rekordbox 7 can export media below its library directory as a path
    // relative to master.db: file://localhost//contents_<id>/... . The DB row
    // contains the corresponding absolute path. Both keys are exact forms of
    // the same address; deriving the relative spelling requires no search.
    if (dbDirKey && key.startsWith(`${dbDirKey}/`)) {
      const relative = key.slice(dbDirKey.length + 1);
      if (relative) audioKeys.push(relative, `/${relative}`);
    }
    const ref = { trackId: track.id, analysisDataPath, sourceDbDir, audioKeys };
    for (const audioKey of audioKeys) {
      if (ambiguousKeys.has(audioKey)) continue;
      const existing = index.get(audioKey);
      if (!existing) {
        index.set(audioKey, ref);
      } else if (
        existing.analysisDataPath !== ref.analysisDataPath ||
        existing.sourceDbDir !== ref.sourceDbDir
      ) {
        // Same physical audio path, different analysis rows → never guess.
        index.delete(audioKey);
        ambiguousKeys.add(audioKey);
      }
    }
  }
  return index;
}

/**
 * Indexes the exact desktop content identity separately from audio paths.
 * Duplicate IDs are removed from the result so callers can never select an
 * arbitrary row. This is the guarded Rekordbox 7.2.16 XML TrackID contract.
 */
export function buildDbAnalysisIdIndex(
  tracks: {
    id: string;
    originalMedia?: { location: string };
    rawXmlAttributes?: Record<string, string>;
  }[],
  sourceDbDir: string
): Map<string, DbAnalysisRef> {
  const result = new Map<string, DbAnalysisRef>();
  const ambiguous = new Set<string>();
  for (const track of tracks) {
    const ref = buildDbAnalysisIndex([track], sourceDbDir).values().next().value as DbAnalysisRef | undefined;
    if (!ref) continue;
    const id = String(ref.trackId);
    if (result.has(id) && result.get(id) !== ref) {
      ambiguous.add(id);
      result.delete(id);
    } else if (!ambiguous.has(id)) {
      result.set(id, ref);
    }
  }
  return result;
}

/**
 * Resolves XML TrackID only when the same ID exists exactly once in master.db
 * and its FolderPath is the exact canonical XML Location. No path-only or
 * metadata fallback is performed.
 */
export function resolveVerifiedDbIdentity(
  idIndex: Map<string, DbAnalysisRef>,
  xmlTrackId: string,
  xmlLocation: string | undefined | null
): DbAnalysisRef | null {
  const ref = idIndex.get(String(xmlTrackId));
  const xmlKey = normalizeAudioKey(xmlLocation);
  if (!ref || !xmlKey || !ref.audioKeys?.includes(xmlKey)) return null;
  return ref;
}
