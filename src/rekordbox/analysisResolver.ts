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
 * Deterministic path derivation ONLY — never a guess:
 *  - leading separators are stripped, the path is normalized;
 *  - an optional leading `share/` component is dropped (it is re-added from
 *    the anchor below);
 *  - a remaining `PIONEER/USBANLZ/...` tail is re-anchored at
 *    `<dbDir>/share/PIONEER/USBANLZ/...`;
 *  - no music-folder mirroring, no filename construction, no track-name
 *    lookup, no recursive search, no hash-directory guessing, and no search
 *    of alternative storage locations.
 *
 * @param dbDir Directory containing the Rekordbox database (master.db /
 *   exportLibrary.db); used as the anchor for `<dbDir>/share/...`.
 * @param analysisDataPath Raw AnalysisDataPath value from the database row
 *   (e.g. `/PIONEER/USBANLZ/0e8/<UUID>/ANLZ0000.DAT` or an absolute path).
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
  for (const track of tracks) {
    const key = normalizeAudioKey(track.originalMedia?.location);
    const analysisDataPath = track.rawXmlAttributes?.analysisDataPath?.trim() ?? '';
    if (!key || !analysisDataPath || index.has(key)) continue;
    index.set(key, { trackId: track.id, analysisDataPath, sourceDbDir });
  }
  return index;
}

export interface SeededAnlzEntry {
  datPath: string | null;
  extPath: string | null;
  matchTier: 1;
  note: string;
}

/**
 * DB-first ANLZ resolution: seeds the audio-path → ANLZ index exclusively
 * with the EXACT targets from the Rekordbox database (AnalysisDataPath).
 *
 * This is the primary resolution path: master.db stores, for every analyzed
 * track, the precise analysis file. No filesystem search happens here — only
 * deterministic path derivation (resolveAnalysisFilePath) and the pure
 * DAT/EXT sibling rewrite (deriveSiblingExtension).
 *
 * Targets without a DB entry — or whose AnalysisDataPath cannot be resolved
 * deterministically — are returned as `unresolved`; ONLY those may fall back
 * to the PPTH file scan. An empty `unresolved` list means: zero file scans.
 */
export function seedAnlzIndexFromDb(
  targets: readonly string[],
  dbIndex: ReadonlyMap<string, DbAnalysisRef>
): { entries: Map<string, SeededAnlzEntry>; unresolved: string[] } {
  const entries = new Map<string, SeededAnlzEntry>();
  const unresolved: string[] = [];
  for (const target of targets) {
    const key = normalizeAudioKey(target);
    if (!key) continue;
    const ref = dbIndex.get(key);
    if (!ref) {
      unresolved.push(target);
      continue;
    }
    const resolved = resolveAnalysisFilePath(ref.sourceDbDir, ref.analysisDataPath);
    if (!resolved) {
      // Not deterministic → never guess; the PPTH scan may still find it.
      unresolved.push(target);
      continue;
    }
    const lower = resolved.toLowerCase();
    let datPath: string | null;
    let extPath: string | null;
    if (lower.endsWith('.dat')) {
      datPath = resolved;
      extPath = deriveSiblingExtension(resolved, 'EXT');
    } else if (lower.endsWith('.ext')) {
      extPath = resolved;
      datPath = deriveSiblingExtension(resolved, 'DAT');
    } else {
      datPath = resolved;
      extPath = null;
    }
    entries.set(key, {
      datPath,
      extPath,
      matchTier: 1,
      note: 'DB-Exaktziel (AnalysisDataPath aus master.db)',
    });
  }
  return { entries, unresolved };
}
