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
 * Fügt `djmdContent.FolderPath` und `FileNameL` zum Audiopfad zusammen.
 *
 * Rekordbox-7-Datenbanken speichern in `FolderPath` versionsabhängig entweder
 * das reine Verzeichnis (mit oder ohne Abschluss-Separator) **oder den vollen
 * Dateipfad**; `FileNameL` wiederholt dann nur den Basisnamen. Eine naive
 * Verkettung erzeugt `…/track.mp3track.mp3` und bricht lautlos den
 * Exakt-Match-Link XML↔DB sowie den PPTH-Plausibilitätsvergleich (beobachtet
 * an einer echten `D:\PIONEER\Master\master.db` am 10.09.2026).
 *
 * Regel (deterministisch, kein Raten): endet `FolderPath` (ohne
 * Abschluss-Separatoren) case-insensitiv auf `FileNameL`, wird `FolderPath`
 * unverändert übernommen; sonst Verzeichnis + erkannte Separator + Name.
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
  if (stripped.toLowerCase().endsWith(file.toLowerCase())) return stripped;
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${stripped}${sep}${file}`;
}

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
