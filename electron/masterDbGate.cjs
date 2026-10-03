
/**
 * Master-DB-Gate (Phase 5) – verbindliche Track-Lade-Kette.
 *
 * Der Gate ist die ausschlaggebende Entscheidung darüber, ob ein Track aus der
 * eingebetteten `rekordbox_export2.xml` in das Deck geladen werden darf:
 *
 *   TrackID (eingebettete XML)
 *        → master.db / exportLibrary.db   (read-only, SQLCipher)
 *        → djmdContent (ID, FolderPath, FileNameL, AnalysisDataPath)
 *        → Rekordbox-ANLZ                (read-only, Struktur- + Waveform-Dekoder)
 *        → Original-Audio                (read-only, PPTH-konsistent)
 *
 * Es gibt bewusst keinen Fallback. Fehlt ein Glied der Kette, liefert der
 * Gate einen harten Fehlercode – eine lokal berechnete Ersatz-Waveform ist
 * keine erlaubte Reaktion, weder hier noch im Renderer.
 *
 * Zustandsmaschine (GATE_CODES):
 *   OK
 *   MASTER_DB_NOT_FOUND          – keine master.db/exportLibrary.db auffindbar
 *   SQLCIPHER_UNAVAILABLE        – better-sqlite3-multiple-ciphers fehlt/ABI-Fehler
 *   MASTER_DB_OPEN_FAILED        – Datei nicht entschlüssel-/lesbar
 *   MASTER_DB_SCHEMA_INVALID     – Tabellen/Spalten djmdContent unbrauchbar
 *   TRACK_NOT_FOUND_IN_MASTER_DB – TrackID in keiner Datenbank enthalten
 *   ANLZ_NOT_FOUND               – (AnalysisDataPath-)Datei fehlt
 *   ANLZ_READ_FAILED             – ANLZ nicht lesbar / zu groß
 *   ANLZ_INVALID                 – keine gültige ANLZ-Sektionsstruktur
 *   REKORDBOX_WAVEFORM_MISSING   – gültige ANLZ ohne PWAV/PWV2..PWV7-Abschnitt
 *   ANLZ_WAVEFORM_UNREADABLE     – Waveform-Abschnitt vorhanden, aber nicht dekodierbar
 *   ANLZ_SOURCE_MISMATCH         – ANLZ-PPTH und der gewählte Originalpfad sind
 *                                  nicht dieselbe Datei (die Waveform gehörte zu
 *                                  einer anderen Datei)
 *   ORIGINAL_AUDIO_NOT_FOUND     – Originaldatei fehlt oder Pfad ungültig
 *
 * Die ANLZ-Struktur wird NICHT in diesem Modul definiert: Sektions-Walk,
 * PPTH-Decoder und Waveform-Layout stammen aus `src/rekordbox/anlzStructure.ts`
 * und liegen hier als generiertes CommonJS-Spiegelmodul vor
 * (`npm run build:anlz-structure`). Damit gilt für Gate und Renderer
 * wörtlich dasselbe: was der Gate als "Waveform akzeptiert", dekodiert der
 * Renderer exakt so – und umgekehrt.
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
const anlz = require('./generated/anlzStructure.cjs');

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
  'ANLZ_WAVEFORM_UNREADABLE',
  'ANLZ_SOURCE_MISMATCH',
  'ORIGINAL_AUDIO_NOT_FOUND',
]);

/** Waveform sections of the documented ANLZ format (Deep Symmetry). */
const WAVEFORM_TAGS = anlz.WAVEFORM_TAGS;
const ANLZ_EXTENSIONS = anlz.ANLZ_EXTENSIONS;
/** Same hard cap as the existing read-analysis-file IPC channel. */
const MAX_ANALYSIS_BYTES = 1024 * 1024 * 1024;

/**
 * Converts an XML `Location`, a Windows path or a file:// URL into a local
 * filesystem path. Returns null for anything that is not a local path.
 */
/** Laufwerksbuchstabe + ":\" eines Windows-Pfads, oder null. */
function driveRootOf(windowsPath) {
  const m = /^([a-z]:)[\\/]/i.exec(String(windowsPath || ''));
  return m ? `${m[1]}\\` : null;
}

/**
 * AnalysisDataPath steht in djmdContent typischerweise als geräte-relativer,
 * POSIX-artiger Pfad ("/PIONEER/USBANLZ/.../ANLZ0000.DAT"), nicht als
 * Windows-Pfad mit Laufwerksbuchstabe. Wandelt ihn in "PIONEER\...\..."
 * (Backslashes, ohne führenden Trenner) um – oder liefert null, wenn der
 * Pfad bereits laufwerksabsolut ist (dann übernimmt toLocalPath/literal).
 */
function posixDeviceSuffix(rawPath) {
  if (typeof rawPath !== 'string') return null;
  if (/^[a-z]:[\\/]/i.test(rawPath)) return null;
  const trimmed = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!trimmed) return null;
  return trimmed.split('/').join('\\');
}

/**
 * Leitet alle sinnvollen Kandidaten für die ANLZ-Datei her:
 *   1. der wörtliche Pfad aus der Datenbank (falls bereits laufwerksabsolut)
 *   2. deterministisch: Laufwerk der tatsächlich geöffneten Datenbank +
 *      geräte-relativer Rest aus AnalysisDataPath (zuverlässig, unabhängig
 *      vom Arbeitsverzeichnis des Prozesses)
 *   3. Ausweiche für Geräte-Exporte, die den PIONEER-Baum zusätzlich
 *      verschachteln (z. B. Rekordbox "Master"/Link-Export für CDJs:
 *      D:\PIONEER\Master\share\PIONEER\USBANLZ\... statt
 *      D:\PIONEER\USBANLZ\...) – abgeleitet von der echten Ordnerstruktur
 *      der gefundenen Datenbank, nicht fest auf ein Laufwerk verdrahtet.
 */
function deriveAnlzCandidates(rawAnalysisPath, dbPath) {
  const candidates = [];

  const literal = toLocalPath(rawAnalysisPath);
  if (literal) candidates.push(literal);

  const suffix = posixDeviceSuffix(rawAnalysisPath);
  if (suffix && dbPath) {
    const root = driveRootOf(dbPath);
    if (root) {
      const deterministic = root + suffix;
      if (!candidates.includes(deterministic)) candidates.push(deterministic);

      const dbNormalized = String(dbPath).replace(/\\/g, '/');
      const dbMarker = dbNormalized.toUpperCase().lastIndexOf('/PIONEER/');
      if (dbMarker !== -1) {
        const base = dbNormalized.slice(0, dbMarker + 1).split('/').join('\\');
        const nested = base + suffix;
        if (!candidates.includes(nested)) candidates.push(nested);
      }
    }
  }

  if (candidates.length === 0 && rawAnalysisPath) candidates.push(rawAnalysisPath);
  return candidates;
}

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
      // Geräte-URIs (file://localhost//contents_…) sind auf keinem
      // Plattform-Pfad; fileURLToPath wirft auf Windows (Pfad beginnt nicht
      // mit einem Laufwerk) und würde den Kandidaten als „kein lokaler Pfad"
      // verstecken. Deterministisch wie auf POSIX den URL-Pfad liefern – das
      // eigentliche Ablehnen übernimmt isDeviceInternalLocation.
      if (isDeviceInternalLocation(value)) return url.pathname;
      const resolved = fileURLToPath(url);
      return resolved || null;
    }
    return path.resolve(value);
  } catch {
    return null;
  }
}

/**
 * True for a Rekordbox device-internal location such as
 * `file://localhost//contents_4136090260/unknownartist/.../track.mp3`.
 * Those entries describe a library on a connected player/drive; they are not a
 * local file and must never be loaded as one.
 */
function isDeviceInternalLocation(location) {
  if (typeof location !== 'string' || !location) return false;
  const withoutScheme = location.replace(/^file:\/\/localhost/i, '').replace(/^file:/i, '');
  return /^\/+contents_\d+/i.test(withoutScheme.replace(/\\/g, '/'));
}

/** Mirrors dbParser.joinWindowsPath for FolderPath + FileNameL rows. */
function joinWindowsPath(folder, fileName) {
  if (!fileName) return folder || undefined;
  if (!folder) return fileName;
  const sep = folder.includes('\\') ? '\\' : '/';
  return folder.replace(/[\\/]+$/, '') + sep + fileName;
}

/**
 * Canonical comparison key for media paths. Mirrors
 * `normalizeMediaPathForComparison` in src/App.tsx so that the gate and the
 * renderer can never disagree about "is this the same file".
 */
function normalizeMediaPath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let normalized = value.trim();
  try {
    if (/^file:/i.test(normalized)) {
      const url = new URL(normalized);
      let pathname = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') {
        pathname = `//${url.hostname}${pathname}`;
      }
      normalized = pathname;
    }
  } catch {
    // A malformed URL cannot be a positive identity match.
  }
  normalized = normalized.replace(/^\/([A-Za-z]:\/)/, '$1');
  return normalized.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

function isSameMediaPath(left, right) {
  const a = normalizeMediaPath(left);
  const b = normalizeMediaPath(right);
  if (a && b && a === b) return true;
  // Rekordbox schreibt in ANLZ-PPTH manchmal "?/Dateiname.mp3" wenn das
  // Laufwerk zum Analysezeitpunkt keinen Buchstaben hatte. In diesem Fall
  // reicht der Dateiname als Identitätsbeweis – der Pfad-Prefix ist nicht
  // vertrauenswürdig und darf den Load nicht blockieren.
  const leftIsUnknownDrive = typeof left === 'string' && /^\?[/\\]/.test(left.trim());
  const rightIsUnknownDrive = typeof right === 'string' && /^\?[/\\]/.test(right.trim());
  if (leftIsUnknownDrive || rightIsUnknownDrive) {
    const nameOf = (p) => p ? p.replace(/\\/g, '/').split('/').pop().toLowerCase() : '';
    const la = nameOf(left);
    const ra = nameOf(right);
    return Boolean(la && ra && la === ra);
  }
  return false;
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
    // Ehrliche Diagnose: Der Banner muss nennen, WELCHE Datenbanken
    // durchsucht wurden – sonst ist „Track nicht gefunden“ nicht von
    // „falsche/veraltete Bibliothek gesucht“ zu unterscheiden.
    const searched = ordered
      .filter((candidate) => candidate && candidate.path)
      .map((candidate) => `${candidate.path} (${candidate.kind || 'unbekannt'})`)
      .join(' | ');
    return fail(
      'TRACK_NOT_FOUND_IN_MASTER_DB',
      `TrackID ${trackId} ist in keiner lokalen Rekordbox-Datenbank enthalten. ` +
        `Durchsucht: ${searched}. ` +
        'Ein benutzerdefinierter Datenbankort wird über Pioneer/rekordboxAgent/storage/options.json (db-path) aufgelöst.',
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
      path: row.path || row.location || (row.FolderPath ? row.FolderPath + row.FileName : null),
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

  const analysisCandidates = deriveAnlzCandidates(rawAnalysisPath, candidate.path);

  let analysisPath = null;
  let analysisStat = null;
  let readError = null;
  for (const candidatePath of analysisCandidates) {
    try {
      const s = await stat(candidatePath);
      if (s && s.isFile()) {
        analysisPath = candidatePath;
        analysisStat = s;
        break;
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') readError = { candidatePath, error };
      // ENOENT: einfach den nächsten Kandidaten versuchen.
    }
  }

  if (!analysisPath) {
    if (readError) {
      return fail(
        'ANLZ_READ_FAILED',
        `ANLZ-Datei nicht lesbar: ${readError.candidatePath} (${readError.error.message || readError.error})`,
        { ...dbContext, content }
      );
    }
    return fail(
      'ANLZ_NOT_FOUND',
      `ANLZ-Datei nicht gefunden. Geprüft: ${analysisCandidates.join(' | ')}`,
      { ...dbContext, content }
    );
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

  // Gemeinsamer Walk mit dem Renderer-Parser (electron/generated/anlzStructure.cjs
  // ist das Spiegelmodul von src/rekordbox/anlzStructure.ts).
  const { scan, columns, summary } = anlz.decodeAnlzWaveform(analysisBytes);
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
  // Der Gate akzeptiert nicht nur "irgendein PWV-Tag", sondern die Welleform,
  // die der Renderer später exakt so dekodieren wird.
  if (!columns || !summary) {
    return fail(
      'ANLZ_WAVEFORM_UNREADABLE',
      `Die ANLZ-Datei enthält einen Waveform-Abschnitt (${scan.tags.filter((t) => WAVEFORM_TAGS.includes(t)).join(', ')}), dessen Layout nicht lesbar ist: ${analysisPath}`,
      { ...dbContext, content }
    );
  }
  if (summary.length <= 0 || summary.nonZeroBuckets <= 0) {
    return fail(
      'ANLZ_WAVEFORM_UNREADABLE',
      `Der Waveform-Abschnitt ${scan.waveform.tag} enthält keine verwertbaren Amplitudenwerte (0 von ${summary.length} Buckets): ${analysisPath}`,
      { ...dbContext, content }
    );
  }

  const waveformInfo = {
    tag: scan.waveform.tag,
    buckets: summary.length,
    entryBytes: scan.waveform.entryBytes,
    style: scan.waveform.style,
    peakMax: Number(summary.peakMax.toFixed(6)),
  };

  // --- Original-Audio (read-only) ------------------------------------------
  // Kandidatenreihenfolge: XML-Location zuerst (Bibliothekspfad), dann der
  // master.db-Pfad (FolderPath + FileNameL), zuletzt die ANLZ-PPATH-Angabe.
  // Geräte-interne XML-Locations (`file://localhost//contents_…`) sind keine
  // lokale Datei und werden nie als Original-Audio geladen.
  const originalCandidates = [];
  const rejected = [];
  const pushCandidate = (value, source) => {
    if (isDeviceInternalLocation(value)) {
      rejected.push({
        path: String(value),
        source,
        reason: 'Rekordbox-Gerätepfad (file://localhost//contents_…); keine lokale Datei.',
      });
      return;
    }
    const resolved = toLocalPath(value);
    if (!resolved) {
      rejected.push({ path: String(value), source, reason: 'Kein lokaler Dateipfad.' });
      return;
    }
    const normalized = normalizeMediaPath(resolved);
    if (originalCandidates.some((candidate) => candidate.normalized === normalized)) return;
    originalCandidates.push({ path: resolved, source, normalized });
  };
  if (requestedMedia) pushCandidate(requestedMedia, 'XML_LOCATION');
  const dbOriginal = joinWindowsPath(folderPath, fileName);
  if (dbOriginal) pushCandidate(dbOriginal, 'MASTER_DB');
  if (scan.ppthPath) pushCandidate(scan.ppthPath, 'ANLZ_PPTH');

  // Die Waveform wurde für die PPTH-Quelldatei berechnet. Wenn XML und
  // master.db auseinanderfallen (umgezogene Bibliothek, veraltete
  // Export-Location), bekommt der mit PPTH übereinstimmende Kandidat Vorrang.
  if (scan.ppthPath) {
    const resolvedPpth = toLocalPath(scan.ppthPath);
    if (resolvedPpth && !isDeviceInternalLocation(scan.ppthPath)) {
      const ppthNorm = normalizeMediaPath(resolvedPpth);
      originalCandidates.sort(
        (a, b) => Number(b.normalized === ppthNorm) - Number(a.normalized === ppthNorm)
      );
    }
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
      rejected.push({ path: candidate.path, source: candidate.source, reason: 'Kein regulärer Dateieintrag.' });
    } catch (error) {
      originalErrors.push(`${candidate.path}: ${error.message || error}`);
      rejected.push({ path: candidate.path, source: candidate.source, reason: error.message || String(error) });
    }
  }

  // Konsistenzbeweis: die geladene Waveform gehört zu genau der Datei, für die
  // Rekordbox die ANLZ geschrieben hat. Ohne diesen Beweis würde der Editor die
  // Waveform eines anderen Tracks anzeigen.
  if (scan.ppthPath && !isDeviceInternalLocation(scan.ppthPath)) {
    if (!originalPath) {
      return fail(
        'ORIGINAL_AUDIO_NOT_FOUND',
        `Original-Audio nicht gefunden: ${originalErrors.join(' | ') || 'keine Kandidaten'}`,
        { ...dbContext, content, ppthPath: scan.ppthPath, rejected }
      );
    }
    if (!isSameMediaPath(originalPath, scan.ppthPath)) {
      return fail(
        'ANLZ_SOURCE_MISMATCH',
        `Die ANLZ-Datei wurde für "${scan.ppthPath}" erzeugt, der Gate hat aber "${originalPath}" gewählt. Eine Waveform eines anderen Tracks darf nicht geladen werden.`,
        { ...dbContext, content, ppthPath: scan.ppthPath, original: { path: originalPath, source: originalSource }, rejected }
      );
    }
  }

  if (!originalPath) {
    return fail(
      'ORIGINAL_AUDIO_NOT_FOUND',
      `Original-Audio nicht gefunden: ${originalErrors.join(' | ') || 'keine Kandidaten'}`,
      { ...dbContext, content, rejected }
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
      /** Proven waveform: exactly what the renderer decodes from this file. */
      waveform: waveformInfo,
      /** Source audio path recorded by Rekordbox inside the ANLZ. */
      ppthPath: scan.ppthPath,
    },
    original: {
      path: originalPath,
      source: originalSource,
      xmlLocation: requestedMedia || undefined,
      databasePath: dbOriginal || undefined,
      ppthPath: scan.ppthPath,
      size: originalStat.size,
      modifiedAt: originalStat.mtimeMs,
    },
    /** djmdCue is the *last* marker source: ANLZ PCO2/PCOB always wins. */
    cues: Array.isArray(result.cues) ? result.cues : [],
    cueSource: 'DJMD_CUE',
    /** Candidates the gate deliberately rejected (device path, wrong file). */
    rejected,
  };
}

module.exports = {
  GATE_CODES,
  WAVEFORM_TAGS,
  ANLZ_EXTENSIONS,
  resolveTrackFromMasterDb,
  /** Re-exported from the shared ANLZ structure module (renderer parity). */
  scanAnlzSections: anlz.scanAnlzSections,
  decodeAnlzWaveform: anlz.decodeAnlzWaveform,
  toLocalPath,
  normalizeMediaPath,
  isSameMediaPath,
  isDeviceInternalLocation,
  joinWindowsPath,
};
