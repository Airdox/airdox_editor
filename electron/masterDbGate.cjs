/**
 * Master-DB-Gate (Phase 5) – verbindliche Track-Lade-Kette.
 *
 * Der Gate ist die ausschlaggebende Entscheidung darüber, ob ein Track aus der
 * eingebetteten `rekordbox_export2.xml` in das Deck geladen werden darf:
 *
 *   TrackID (eingebettete XML)
 *        → master.db / exportLibrary.db   (read-only, SQLCipher)
 *        → djmdContent (ID, FolderPath, FileNameL, AnalysisDataPath)
 *        → Rekordbox-ANLZ                (read-only, Struktur- + Waveform-Check)
 *        → Original-Audio                (read-only)
 *
 * Es gibt bewusst keinen Fallback. Fehlt ein Glied der Kette, liefert der
 * Gate einen harten Fehlercode – eine lokal berechnete Ersatz-Waveform ist
 * keine erlaubte Reaktion, weder hier noch im Renderer.
 *
 * Zustandsmaschine (GATE_CODES):
 *   OK
 *   MASTER_DB_NOT_FOUND        – keine master.db/exportLibrary.db auffindbar
 *   SQLCIPHER_UNAVAILABLE      – better-sqlite3-multiple-ciphers fehlt
 *   MASTER_DB_OPEN_FAILED      – Datei nicht entschlüssel-/lesbar
 *   MASTER_DB_SCHEMA_INVALID   – Tabellen/Spalten djmdContent unbrauchbar
 *   TRACK_NOT_FOUND_IN_MASTER_DB – TrackID in keiner Datenbank enthalten
 *   ANLZ_NOT_FOUND             – (AnalysisDataPath-)Datei fehlt
 *   ANLZ_READ_FAILED           – ANLZ nicht lesbar / zu groß
 *   ANLZ_INVALID               – keine gültige ANLZ-Sektionsstruktur
 *   REKORDBOX_WAVEFORM_MISSING – gültige ANLZ ohne PWAV/PWV2..PWV7-Abschnitt
 *   ORIGINAL_AUDIO_NOT_FOUND   – Originaldatei fehlt oder Pfad ungültig
 *
 * Das Modul ist Electron-frei. Sämtliche I/O-Abhängigkeiten sind injectbar,
 * damit tests/master-db-gate.test.mjs die vollständige Zustandsmaschine ohne
 * eine echte SQLCipher-Datenbank prüfen kann. Alle Operationen sind lesend;
 * der Gate schreibt niemals in eine Quelldatei.
 */

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const dbReader = require('./dbReader.cjs');

const GATE_CODES = Object.freeze([
  'OK',
  'MASTER_DB_NOT_FOUND',
  'SQLCIPHER_UNAVAILABLE',
  'MASTER_DB_OPEN_FAILED',
  'MASTER_DB_SCHEMA_INVALID',
  'TRACK_NOT_FOUND_IN_MASTER_DB',
  'ANLZ_NOT_FOUND',
  'ANLZ_READ_FAILED',
  'ANLZ_INVALID',
  'REKORDBOX_WAVEFORM_MISSING',
  'ORIGINAL_AUDIO_NOT_FOUND',
]);

/** Waveform sections of the documented ANLZ format (Deep Symmetry). */
const WAVEFORM_TAGS = Object.freeze(['PWAV', 'PWV2', 'PWV3', 'PWV4', 'PWV5', 'PWV6', 'PWV7']);
const ANLZ_EXTENSIONS = Object.freeze(['.dat', '.ext', '.2ex']);
/** Same hard cap as the existing read-analysis-file IPC channel. */
const MAX_ANALYSIS_BYTES = 1024 * 1024 * 1024;

/**
 * Converts an XML `Location`, a Windows path or a file:// URL into a local
 * filesystem path. Returns null for anything that is not a local path.
 */
function toLocalPath(location) {
  if (typeof location !== 'string' || !location.trim()) return null;
  const value = location.trim();
  try {
    if (/^[a-z]:[\\/]/i.test(value) || path.isAbsolute(value)) {
      // POSIX runtimes resolve drive paths relative to cwd; keep the raw
      // drive path so the value stays meaningful (tests inject their own
      // stat/readFile anyway, on Windows path.resolve is a no-op here).
      if (/^[a-z]:[\\/]/i.test(value) && process.platform !== 'win32') return value;
      return path.resolve(value);
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
      const url = new URL(value);
      if (url.protocol !== 'file:') return null;
      const resolved = fileURLToPath(url);
      return resolved || null;
    }
    return path.resolve(value);
  } catch {
    return null;
  }
}

/** Mirrors dbParser.joinWindowsPath for FolderPath + FileNameL rows. */
function joinWindowsPath(folder, fileName) {
  if (!fileName) return folder || undefined;
  if (!folder) return fileName;
  const sep = folder.includes('\\') ? '\\' : '/';
  return folder.replace(/[\\/]+$/, '') + sep + fileName;
}

function isPrintableTag(value) {
  return typeof value === 'string' && /^[\x20-\x7e]{4}$/.test(value);
}

function hasWaveformSection(tags) {
  return tags.some((tag) => WAVEFORM_TAGS.includes(tag));
}

/**
 * Walks the ANLZ section envelope exactly like src/rekordbox/anlzParser.ts:
 * 4-byte tag, u32-BE @+4 (header length), u32-BE @+8 (total section length,
 * with @+4 as fallback for legacy writers), PMAI file header skipped first.
 *
 * Returns { valid, tags, hasWaveform, truncated, ppthPath?, reason? }.
 * `ppthPath` is the source-audio path recorded by Rekordbox inside the PPTH
 * section (UTF-16BE); `valid` means at least one section could be walked –
 * the full binary parse (waveform peaks, cues, grid) still happens
 * renderer-side with parseAnlzBinary.
 */
function scanAnlzSections(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const base = { tags: [], hasWaveform: false, truncated: false, ppthPath: undefined };
  const len = buffer.length;

  if (len < 12) {
    return { ...base, valid: false, reason: `ANLZ-Datei ist kleiner als 12 Bytes (${len}).` };
  }

  let offset = 0;
  const firstTag = buffer.toString('ascii', 0, 4);
  if (firstTag === 'PMAI') {
    const headerLength = buffer.readUInt32BE(4);
    offset = headerLength >= 12 && headerLength <= len ? headerLength : 0;
  } else if (!isPrintableTag(firstTag)) {
    return { ...base, valid: false, reason: 'Erstes ANLZ-Sektionstag ist kein lesbares 4-Byte-Tag.' };
  }

  const tags = [];
  let ppthPath;
  const done = (reason) => ({
    ...base,
    tags,
    ppthPath,
    hasWaveform: hasWaveformSection(tags),
    truncated: tags.length > 0,
    valid: tags.length > 0,
    ...(tags.length > 0 ? {} : { reason }),
  });

  while (offset + 12 <= len) {
    const tag = buffer.toString('ascii', offset, offset + 4);
    if (!isPrintableTag(tag)) {
      return done('Unerwartete Bytes statt eines ANLZ-Sektionstags.');
    }
    const lenHeader = buffer.readUInt32BE(offset + 4);
    const lenTag = buffer.readUInt32BE(offset + 8);
    let chunkSize = lenTag;
    if (chunkSize < 12 || offset + chunkSize > len) chunkSize = lenHeader;
    if (chunkSize < 12 || offset + chunkSize > len) {
      return done('Sektionslänge der ANLZ-Datei ist ungültig.');
    }
    if (tag === 'PPTH' && offset + 0x10 <= offset + chunkSize && !ppthPath) {
      const byteLength = buffer.readUInt32BE(offset + 0x0c);
      if (byteLength > 0 && byteLength <= chunkSize - 0x10) {
        let decoded = '';
        const units = byteLength >= 2 ? Math.floor(byteLength / 2) : byteLength;
        for (let i = 0; i < units; i++) {
          const code = byteLength >= 2
            ? buffer.readUInt16BE(offset + 0x10 + i * 2)
            : buffer.readUInt8(offset + 0x10 + i);
          if (code === 0) break;
          decoded += String.fromCharCode(code);
        }
        if (decoded.trim()) ppthPath = decoded.replace(/\0+$/, '').trim();
      }
    }
    tags.push(tag);
    offset += chunkSize;
  }

  if (tags.length === 0) {
    return { ...base, valid: false, reason: 'Keine ANLZ-Sektionen konnten gelesen werden.' };
  }
  return { ...base, tags, ppthPath, hasWaveform: hasWaveformSection(tags), truncated: false, valid: true };
}

function fail(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra };
}

/**
 * Resolves one track through the mandatory master.db → ANLZ → original-audio
 * chain. Never writes, never analyses, never falls back.
 *
 * @param {{trackId?: string, mediaPath?: string, title?: string, artist?: string}} query
 * @param {object} [deps] Test seams: locateRekordboxDatabases, isCipherAvailable,
 *   openContentRow, stat, readFile.
 * @returns {Promise<{ok: boolean, code: string, reason?: string, ...}>}
 */
async function resolveTrackFromMasterDb(query = {}, deps = {}) {
  const locate = deps.locateRekordboxDatabases || dbReader.locateRekordboxDatabases;
  const isCipherAvailable = deps.isCipherAvailable || dbReader.isCipherAvailable;
  const openContentRow = deps.openContentRow || dbReader.openContentRow;
  const stat = deps.stat || ((target) => fs.promises.stat(target));
  const readFile = deps.readFile || ((target) => fs.promises.readFile(target));

  const trackId = String(query.trackId ?? '').trim();
  const requestedMedia = typeof query.mediaPath === 'string' && query.mediaPath.trim()
    ? query.mediaPath.trim()
    : '';

  if (!trackId) {
    return fail('TRACK_NOT_FOUND_IN_MASTER_DB', 'Keine TrackID für den Master-DB-Gate übergeben.');
  }

  let candidates = [];
  try {
    candidates = (await locate()) || [];
  } catch (error) {
    return fail('MASTER_DB_NOT_FOUND', `Datenbanksuche fehlgeschlagen: ${error.message || error}`);
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return fail(
      'MASTER_DB_NOT_FOUND',
      'Keine lokale Rekordbox-Datenbank (master.db / exportLibrary.db) gefunden.'
    );
  }

  if (typeof isCipherAvailable === 'function' && !isCipherAvailable()) {
    return fail(
      'SQLCIPHER_UNAVAILABLE',
      'Das SQLCipher-Modul (better-sqlite3-multiple-ciphers) ist nicht verfügbar; master.db kann nicht lesend geöffnet werden.'
    );
  }

  // Prefer the local master.db; exportLibrary.db (OneLibrary) is the fallback.
  const ordered = candidates
    .slice()
    .sort((a, b) => (a && a.kind === 'MASTER_DB' ? 0 : 1) - (b && b.kind === 'MASTER_DB' ? 0 : 1));

  let openedAny = false;
  let hit = null;
  const openErrors = [];
  const schemaErrors = [];

  for (const candidate of ordered) {
    if (!candidate || !candidate.path) continue;
    let result;
    try {
      result = await openContentRow(candidate.path, trackId);
    } catch (error) {
      openErrors.push(`${candidate.path}: ${error.message || error}`);
      continue;
    }
    if (!result || result.available === false) {
      if (result && result.schemaInvalid) schemaErrors.push(result.reason || candidate.path);
      else openErrors.push((result && result.reason) || `${candidate.path}: nicht lesbar`);
      continue;
    }
    openedAny = true;
    if (result.row) {
      hit = { result, candidate };
      break;
    }
  }

  const dbContext = hit
    ? { dbPath: hit.candidate.path, dbType: hit.result.dbType || hit.candidate.kind }
    : {};

  if (!hit) {
    if (!openedAny) {
      if (schemaErrors.length > 0) {
        return fail('MASTER_DB_SCHEMA_INVALID', schemaErrors.join(' | '), dbContext);
      }
      return fail(
        'MASTER_DB_OPEN_FAILED',
        openErrors.join(' | ') || 'Die Rekordbox-Datenbank konnte nicht lesend geöffnet werden.',
        dbContext
      );
    }
    return fail(
      'TRACK_NOT_FOUND_IN_MASTER_DB',
      `TrackID ${trackId} ist in keiner lokalen Rekordbox-Datenbank enthalten.`,
      dbContext
    );
  }

  const { result, candidate } = hit;
  const row = result.row;
  const dbType = result.dbType || candidate.kind;
  const folderPath = String(row.FolderPath ?? row.path ?? '').trim();
  const fileName = String(row.FileNameL ?? row.fileName ?? '').trim();
  const rawAnalysisPath = String(row.AnalysisDataPath ?? row.analysisDataFilePath ?? '').trim();

  const content = {
    id: String(row.ID ?? row.content_id ?? trackId),
    title: String(row.Title ?? row.title ?? '').trim() || undefined,
    folderPath: folderPath || undefined,
    fileName: fileName || undefined,
    analysisDataPath: rawAnalysisPath || undefined,
  };

  // --- djmdContent → AnalysisDataPath → ANLZ (read-only) -------------------
  if (!rawAnalysisPath) {
    return fail(
      'ANLZ_NOT_FOUND',
      `Der Datenbank-Datensatz für TrackID ${content.id} enthält keinen AnalysisDataPath.`,
      { ...dbContext, content }
    );
  }

  const analysisPath = toLocalPath(rawAnalysisPath) || rawAnalysisPath;
  let analysisStat;
  try {
    analysisStat = await stat(analysisPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fail('ANLZ_NOT_FOUND', `ANLZ-Datei nicht gefunden: ${analysisPath}`, { ...dbContext, content });
    }
    return fail(
      'ANLZ_READ_FAILED',
      `ANLZ-Datei nicht lesbar: ${analysisPath} (${error.message || error})`,
      { ...dbContext, content }
    );
  }
  if (!analysisStat || !analysisStat.isFile()) {
    return fail('ANLZ_NOT_FOUND', `ANLZ-Pfad verweist nicht auf eine Datei: ${analysisPath}`, {
      ...dbContext,
      content,
    });
  }
  if (analysisStat.size > MAX_ANALYSIS_BYTES) {
    return fail(
      'ANLZ_READ_FAILED',
      `ANLZ-Datei ist größer als 1 GB und wird nicht gelesen: ${analysisPath}`,
      { ...dbContext, content }
    );
  }
  if (!ANLZ_EXTENSIONS.includes(path.extname(analysisPath).toLowerCase())) {
    return fail(
      'ANLZ_INVALID',
      `AnalysisDataPath ist keine unterstützte Rekordbox-ANLZ-Datei (.dat/.ext/.2ex): ${analysisPath}`,
      { ...dbContext, content }
    );
  }

  let analysisBytes;
  try {
    analysisBytes = await readFile(analysisPath);
  } catch (error) {
    return fail(
      'ANLZ_READ_FAILED',
      `ANLZ-Datei konnte nicht lesend geöffnet werden: ${analysisPath} (${error.message || error})`,
      { ...dbContext, content }
    );
  }

  const scan = scanAnlzSections(Buffer.isBuffer(analysisBytes) ? analysisBytes : Buffer.from(analysisBytes || []));
  if (!scan.valid) {
    return fail('ANLZ_INVALID', `${analysisPath}: ${scan.reason || 'Ungültige ANLZ-Struktur.'}`, {
      ...dbContext,
      content,
    });
  }
  if (!scan.hasWaveform) {
    return fail(
      'REKORDBOX_WAVEFORM_MISSING',
      `Die ANLZ-Datei enthält keinen Waveform-Abschnitt (PWAV/PWV2..PWV7): ${analysisPath} [Sektionen: ${scan.tags.join(', ')}]`,
      { ...dbContext, content }
    );
  }

  // --- Original-Audio (read-only) ------------------------------------------
  // Kandidatenreihenfolge: XML-Location zuerst (Bibliothekspfad), dann der
  // master.db-Pfad (FolderPath + FileNameL). Letzterer ist zwingend, wenn die
  // XML einen geräte-internen Pfad enthält (z. B. file://localhost//contents_…)
  // oder die XML-Location nicht (mehr) existiert.
  const originalCandidates = [];
  const pushCandidate = (value, source) => {
    const resolved = toLocalPath(value);
    if (!resolved) return;
    const normalized = resolved.replace(/\\/g, '/').toLowerCase();
    if (originalCandidates.some((candidate) => candidate.normalized === normalized)) return;
    originalCandidates.push({ path: resolved, source, normalized });
  };
  if (requestedMedia) pushCandidate(requestedMedia, 'XML_LOCATION');
  const dbOriginal = joinWindowsPath(folderPath, fileName);
  if (dbOriginal) pushCandidate(dbOriginal, 'MASTER_DB');
  if (scan.ppthPath) pushCandidate(scan.ppthPath, 'ANLZ_PPTH');

  // Die Waveform wurde für die PPTH-Quelldatei berechnet; wenn XML und
  // master.db auseinanderfallen (z. B. umgezogene Bibliothek, veraltete
  // Export-Location), bekommt der mit PPTH übereinstimmende Kandidat Vorrang.
  if (scan.ppthPath) {
    const resolvedPpth = toLocalPath(scan.ppthPath);
    if (resolvedPpth) {
      const ppthNorm = resolvedPpth.replace(/\\/g, '/').toLowerCase();
      originalCandidates.sort(
        (a, b) => Number(b.normalized === ppthNorm) - Number(a.normalized === ppthNorm)
      );
    }
  }

  if (originalCandidates.length === 0) {
    return fail(
      'ORIGINAL_AUDIO_NOT_FOUND',
      'Weder XML-Location noch FolderPath/FileNameL ergeben einen Original-Audiopfad.',
      { ...dbContext, content }
    );
  }

  let originalPath = null;
  let originalSource = null;
  let originalStat = null;
  const originalErrors = [];
  for (const candidate of originalCandidates) {
    try {
      const candidateStat = await stat(candidate.path);
      if (candidateStat && candidateStat.isFile()) {
        originalPath = candidate.path;
        originalSource = candidate.source;
        originalStat = candidateStat;
        break;
      }
      originalErrors.push(`${candidate.path}: verweist nicht auf eine Datei`);
    } catch (error) {
      originalErrors.push(`${candidate.path}: ${error.message || error}`);
    }
  }
  if (!originalPath) {
    return fail(
      'ORIGINAL_AUDIO_NOT_FOUND',
      `Original-Audio nicht gefunden: ${originalErrors.join(' | ')}`,
      { ...dbContext, content }
    );
  }

  return {
    ok: true,
    code: 'OK',
    ...dbContext,
    content: { ...content, originalPath },
    analysis: {
      path: analysisPath,
      size: analysisStat.size,
      modifiedAt: analysisStat.mtimeMs,
      tags: scan.tags,
      hasWaveform: true,
      truncated: Boolean(scan.truncated),
    },
    original: {
      path: originalPath,
      source: originalSource,
      xmlLocation: requestedMedia || undefined,
      databasePath: dbOriginal || undefined,
      size: originalStat.size,
      modifiedAt: originalStat.mtimeMs,
    },
    cues: Array.isArray(result.cues) ? result.cues : [],
  };
}

module.exports = {
  GATE_CODES,
  WAVEFORM_TAGS,
  ANLZ_EXTENSIONS,
  resolveTrackFromMasterDb,
  scanAnlzSections,
  toLocalPath,
  joinWindowsPath,
};
