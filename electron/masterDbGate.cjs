/**
 * @license
 * Rekordbox Master-Database Pipeline-Gate (read-only).
 *
 * Verbindlicher Pfad jeder Rekordbox-Trackauflösung:
 *
 *   Rekordbox → master.db → SQLCipher → DB geöffnet → Schema erkannt →
 *   Track gefunden → Trackdaten gelesen → normalisierte Trackdaten
 *
 * Jede Stufe ist ein hartes Gate. Schlägt eine Stufe fehl, liefert dieses
 * Modul ein Fehlerergebnis mit eindeutigem Code – NIEMALS einen stillen
 * Fallback auf XML, Defaults oder erfundene Werte. Der Aufrufer darf die
 * Daten dann nicht als "Rekordbox-Daten" ausgeben.
 *
 * Die Datei wird ausschließlich lesend geöffnet (readonly + fileMustExist);
 * es wird kein einziges Byte geschrieben. SQLCipher-Schlüssel werden nie
 * geloggt.
 */

const fs = require('node:fs');
const path = require('node:path');

const { getMasterDbKey, getOneLibraryKey, detectDbType } = require('./dbReader.cjs');

/** Eindeutige Gate-Fehlercodes (Vertrag für Renderer & Tests). */
const MasterDbGateError = Object.freeze({
  MASTER_DB_NOT_FOUND: 'MASTER_DB_NOT_FOUND',
  SQLCIPHER_UNAVAILABLE: 'SQLCIPHER_UNAVAILABLE',
  MASTER_DB_OPEN_FAILED: 'MASTER_DB_OPEN_FAILED',
  MASTER_DB_SCHEMA_INVALID: 'MASTER_DB_SCHEMA_INVALID',
  TRACK_NOT_FOUND_IN_MASTER_DB: 'TRACK_NOT_FOUND_IN_MASTER_DB',
  MASTER_DB_QUERY_FAILED: 'MASTER_DB_QUERY_FAILED',
});

/** Pflichttabellen eines gültigen master.db-Schemas. */
const MASTER_DB_REQUIRED_TABLES = ['djmdContent'];
/** Pflichttabellen eines gültigen OneLibrary-Schemas. */
const ONE_LIBRARY_REQUIRED_TABLES = ['content'];

function log(message) {
  // Keine Schlüssel, keine Passwörter – nur Pipeline-Zustände.
  console.info(`[RekordboxDB] ${message}`);
}

function emptyFlags() {
  return {
    masterDbFound: false,
    sqlcipherAvailable: false,
    databaseOpened: false,
    schemaValidated: false,
    trackQueryExecuted: false,
    trackFound: false,
  };
}

function failure(code, reason, flags, extra = {}) {
  console.warn(`[Pipeline] MASTER_DB_GATE_FAILED: ${code}`);
  return {
    ok: false,
    source: 'rekordbox-master-db',
    errorCode: code,
    reason,
    ...flags,
    ...extra,
  };
}

/**
 * Lädt das SQLCipher-Binding. Optional injizierbar, damit die Gate-Logik
 * ohne natives Binding deterministisch getestet werden kann. Der injizierte
 * Treiber muss dieselbe Minimal-API bieten: `new Driver(path, options)` mit
 * `pragma()`, `prepare().get()/all()` und `close()`.
 */
function loadDriver(injectedDriver) {
  if (injectedDriver) return { driver: injectedDriver, error: null };
  try {
    // eslint-disable-next-line global-require
    return { driver: require('better-sqlite3-multiple-ciphers'), error: null };
  } catch (error) {
    return { driver: null, error: error.message || String(error) };
  }
}

function listTables(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  return rows.map((row) => String(row.name));
}

/** Normalisiert einen Audiopfad für den Vergleich (case-insensitiv). */
function normalizeAudioKey(input) {
  if (!input) return '';
  let s = String(input).trim();
  const fileMatch = s.match(/^file:\/\/(localhost)?\/?/i);
  if (fileMatch) s = s.slice(fileMatch[0].length);
  s = s.replace(/^\\\\\?\\([a-zA-Z]:)/, '$1');
  if (s.includes('%')) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* Rohwert behalten */
    }
  }
  s = s.replace(/\\/g, '/').replace(/^\/([a-zA-Z]:\/)/, '$1').replace(/\/{2,}/g, '/');
  return s.toLowerCase();
}

function basenameKey(key) {
  return key.split('/').pop() || '';
}

function normalizeBpm(raw) {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1000 ? value / 100 : value;
}

function joinAudioPath(folder, fileName) {
  const dir = (folder ?? '').trim();
  const file = (fileName ?? '').trim();
  if (!file) return dir || null;
  if (!dir) return file;
  const stripped = dir.replace(/[\\/]+$/, '');
  if (stripped.toLowerCase().endsWith(file.toLowerCase())) return stripped;
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${stripped}${sep}${file}`;
}

function scalar(db, sql, params = []) {
  try {
    const row = db.prepare(sql).get(...params);
    return row || null;
  } catch {
    return null;
  }
}

/**
 * Liest die eigentlichen Trackdaten aus der geöffneten Datenbank.
 * Führt echte Queries aus (djmdContent + djmdCue + Lookup-Tabellen bzw. die
 * OneLibrary-Äquivalente). Werte, die die DB nicht liefert, bleiben null –
 * es werden keine Defaults erfunden.
 */
function readMasterTrack(db, contentRow, tables, dbType, dbPath) {
  const has = (name) => tables.includes(name);
  const isMaster = dbType === 'MASTER_DB';

  const lookupName = (table, idColumn, nameColumn, id) => {
    if (id === null || id === undefined || id === '' || !has(table)) return null;
    const row = scalar(db, `SELECT ${nameColumn} AS name FROM ${table} WHERE ${idColumn} = ?`, [id]);
    return row && row.name !== null && row.name !== undefined ? String(row.name) : null;
  };

  const trackId = String(isMaster ? contentRow.ID : contentRow.content_id);
  const cueTable = isMaster ? 'djmdCue' : 'cue';
  const cueContentColumn = isMaster ? 'ContentID' : 'content_id';

  let cues = [];
  if (has(cueTable)) {
    try {
      cues = db
        .prepare(`SELECT * FROM ${cueTable} WHERE ${cueContentColumn} = ?`)
        .all(trackId)
        .map((row) => {
          const inMsec = row.InMsec ?? (row.inUsec !== undefined && row.inUsec !== null ? Number(row.inUsec) / 1000 : null);
          const outMsecRaw = row.OutMsec ?? (row.outUsec !== undefined && row.outUsec !== null ? Number(row.outUsec) / 1000 : null);
          const outMsec = outMsecRaw !== null && Number(outMsecRaw) >= 0 ? Number(outMsecRaw) : null;
          return {
            id: String(row.ID ?? row.cue_id ?? ''),
            kind: row.Kind ?? row.kind ?? 0,
            inMsec: inMsec === null || inMsec === undefined ? null : Number(inMsec),
            outMsec,
            comment: row.Comment ?? row.cueComment ?? null,
            color: row.Color ?? row.ColorTableIndex ?? null,
            activeLoop: Boolean(row.ActiveLoop ?? row.isActiveLoop ?? 0),
          };
        });
    } catch (error) {
      cues = [];
    }
  }

  const bpm = normalizeBpm(isMaster ? contentRow.BPM : contentRow.bpmx100 ?? contentRow.bpm);
  const lengthRaw = isMaster ? contentRow.Length : contentRow.length;
  // master.db speichert Length in Sekunden (ältere Builds) oder ms (neuere).
  let duration = null;
  const lengthValue = lengthRaw === null || lengthRaw === undefined ? null : Number(lengthRaw);
  if (lengthValue !== null && Number.isFinite(lengthValue) && lengthValue > 0) {
    duration = lengthValue > 3000 ? lengthValue / 1000 : lengthValue;
  }

  const folderPath = isMaster ? contentRow.FolderPath : contentRow.path;
  const fileName = isMaster ? contentRow.FileNameL : contentRow.fileName;

  return {
    trackId,
    title: (isMaster ? contentRow.Title : contentRow.title) ?? null,
    artist: lookupName(
      isMaster ? 'djmdArtist' : 'artist',
      isMaster ? 'ID' : 'artist_id',
      isMaster ? 'Name' : 'name',
      isMaster ? contentRow.ArtistID : contentRow.artist_id
    ),
    album: lookupName(
      isMaster ? 'djmdAlbum' : 'album',
      isMaster ? 'ID' : 'album_id',
      isMaster ? 'Name' : 'name',
      isMaster ? contentRow.AlbumID : contentRow.album_id
    ),
    genre: lookupName(
      isMaster ? 'djmdGenre' : 'genre',
      isMaster ? 'ID' : 'genre_id',
      isMaster ? 'Name' : 'name',
      isMaster ? contentRow.GenreID : contentRow.genre_id
    ),
    key: lookupName(
      isMaster ? 'djmdKey' : 'key',
      isMaster ? 'ID' : 'key_id',
      isMaster ? 'ScaleName' : 'name',
      isMaster ? contentRow.KeyID : contentRow.key_id
    ),
    label: lookupName(
      isMaster ? 'djmdLabel' : 'label',
      isMaster ? 'ID' : 'label_id',
      isMaster ? 'Name' : 'name',
      isMaster ? contentRow.LabelID : contentRow.label_id
    ),
    bpm,
    duration,
    sampleRate:
      (isMaster ? contentRow.SampleRate : contentRow.samplingRate) === null ||
      (isMaster ? contentRow.SampleRate : contentRow.samplingRate) === undefined
        ? null
        : Number(isMaster ? contentRow.SampleRate : contentRow.samplingRate),
    fileSize:
      (isMaster ? contentRow.FileSize : contentRow.fileSize) === null ||
      (isMaster ? contentRow.FileSize : contentRow.fileSize) === undefined
        ? null
        : Number(isMaster ? contentRow.FileSize : contentRow.fileSize),
    comment: (isMaster ? contentRow.Commnt : contentRow.djComment) ?? null,
    rating: (isMaster ? contentRow.Rating : contentRow.rating) ?? null,
    playCount: (isMaster ? contentRow.DJPlayCount : contentRow.djPlayCount) ?? null,
    year: (isMaster ? contentRow.ReleaseYear : contentRow.releaseYear) ?? null,
    analysisDataPath: (isMaster ? contentRow.AnalysisDataPath : contentRow.analysisDataFilePath) ?? null,
    folderPath: folderPath ?? null,
    fileName: fileName ?? null,
    audioPath: joinAudioPath(folderPath, fileName),
    dbDir: path.dirname(dbPath),
    cues,
  };
}

/**
 * Sucht den Track anhand der verfügbaren Identifikatoren.
 * Reihenfolge: DB-interne ID → exakter Audiopfad → eindeutiger Basisname.
 * Kein Fuzzy-Matching, kein Raten über Titel/Artist.
 */
function findContentRow(db, dbType, identifiers) {
  const isMaster = dbType === 'MASTER_DB';
  const table = isMaster ? 'djmdContent' : 'content';
  const idColumn = isMaster ? 'ID' : 'content_id';

  if (identifiers.trackId !== undefined && identifiers.trackId !== null && `${identifiers.trackId}` !== '') {
    const row = scalar(db, `SELECT * FROM ${table} WHERE ${idColumn} = ?`, [String(identifiers.trackId)]);
    if (row) return { row, matchedBy: 'TRACK_ID' };
  }

  const wantedKey = normalizeAudioKey(identifiers.audioPath || identifiers.location);
  if (wantedKey) {
    const folderColumn = isMaster ? 'FolderPath' : 'path';
    const fileColumn = isMaster ? 'FileNameL' : 'fileName';
    let rows = [];
    try {
      rows = db.prepare(`SELECT * FROM ${table}`).all();
    } catch (error) {
      return { row: null, matchedBy: null, queryError: error.message || String(error) };
    }
    const wantedBase = basenameKey(wantedKey);
    let uniqueBaseMatch = null;
    let baseMatchCount = 0;
    for (const row of rows) {
      const rowPath = joinAudioPath(row[folderColumn], row[fileColumn]);
      const rowKey = normalizeAudioKey(rowPath);
      if (!rowKey) continue;
      if (rowKey === wantedKey) return { row, matchedBy: 'AUDIO_PATH' };
      if (wantedBase && basenameKey(rowKey) === wantedBase) {
        baseMatchCount += 1;
        uniqueBaseMatch = row;
      }
    }
    if (baseMatchCount === 1 && uniqueBaseMatch) {
      return { row: uniqueBaseMatch, matchedBy: 'UNIQUE_FILENAME' };
    }
  }

  return { row: null, matchedBy: null };
}

/**
 * Führt die komplette Gate-Kette aus und liefert ein strukturiertes,
 * überprüfbares Ergebnis.
 *
 * @param {{dbPath?:string, trackId?:string|number, audioPath?:string, location?:string}} request
 * @param {{driver?:Function, locate?:Function}} [deps] Injektion für Tests.
 */
function resolveTrackFromMasterDb(request = {}, deps = {}) {
  const flags = emptyFlags();
  const identifiers = {
    trackId: request.trackId ?? null,
    audioPath: request.audioPath ?? null,
    location: request.location ?? null,
  };

  // ---- Gate 1: Master-DB-Datei gefunden? --------------------------------
  log('locating master database');
  let dbPath = typeof request.dbPath === 'string' ? request.dbPath.trim() : '';
  if (!dbPath && typeof deps.locate === 'function') {
    const candidates = deps.locate() || [];
    const master = candidates.find((c) => c && c.kind === 'MASTER_DB') || candidates[0];
    if (master) dbPath = master.path;
  }
  if (!dbPath || !fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
    return failure(
      MasterDbGateError.MASTER_DB_NOT_FOUND,
      'Die Rekordbox Master Database (master.db / exportLibrary.db) wurde nicht gefunden.',
      flags,
      { dbPath: dbPath || null }
    );
  }
  flags.masterDbFound = true;
  log('master database found');

  const dbType = detectDbType(dbPath) || 'MASTER_DB';

  // ---- Gate 2: SQLCipher verfügbar? -------------------------------------
  log('initializing SQLCipher');
  const { driver: Driver, error: driverError } = loadDriver(deps.driver);
  if (!Driver) {
    return failure(
      MasterDbGateError.SQLCIPHER_UNAVAILABLE,
      `SQLCipher-Unterstützung (better-sqlite3-multiple-ciphers) ist nicht verfügbar: ${driverError || 'Modul fehlt'}`,
      flags,
      { dbPath, dbType }
    );
  }
  flags.sqlcipherAvailable = true;

  // ---- Gate 3: DB mit SQLCipher öffnen ----------------------------------
  let db = null;
  try {
    db = new Driver(dbPath, { readonly: true, fileMustExist: true });
    const key = dbType === 'ONE_LIBRARY' ? getOneLibraryKey() : getMasterDbKey();
    db.pragma('cipher = sqlcipher');
    db.pragma('legacy = 4');
    db.pragma(`key = '${key}'`); // Schlüssel wird niemals geloggt.
    // Erzwingt die Entschlüsselung.
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    return failure(
      MasterDbGateError.MASTER_DB_OPEN_FAILED,
      `Die Master Database konnte mit SQLCipher nicht geöffnet/entschlüsselt werden: ${error.message || error}`,
      flags,
      { dbPath, dbType }
    );
  }
  flags.databaseOpened = true;
  log('SQLCipher database opened');

  try {
    // ---- Gate 4: Schema erkannt? ----------------------------------------
    let tables = [];
    try {
      tables = listTables(db);
    } catch (error) {
      return failure(
        MasterDbGateError.MASTER_DB_SCHEMA_INVALID,
        `Das Datenbankschema konnte nicht gelesen werden: ${error.message || error}`,
        flags,
        { dbPath, dbType }
      );
    }
    const required = dbType === 'ONE_LIBRARY' ? ONE_LIBRARY_REQUIRED_TABLES : MASTER_DB_REQUIRED_TABLES;
    const missing = required.filter((t) => !tables.includes(t));
    if (missing.length > 0) {
      return failure(
        MasterDbGateError.MASTER_DB_SCHEMA_INVALID,
        `Inkompatibles Rekordbox-Schema – fehlende Tabellen: ${missing.join(', ')}.`,
        flags,
        { dbPath, dbType, tables }
      );
    }
    flags.schemaValidated = true;
    log('schema validated');

    // ---- Gate 5: Track gefunden? ----------------------------------------
    log('querying track');
    let found;
    try {
      found = findContentRow(db, dbType, identifiers);
      flags.trackQueryExecuted = true;
    } catch (error) {
      flags.trackQueryExecuted = true;
      return failure(
        MasterDbGateError.MASTER_DB_QUERY_FAILED,
        `Die Track-Abfrage ist fehlgeschlagen: ${error.message || error}`,
        flags,
        { dbPath, dbType }
      );
    }
    if (found.queryError) {
      return failure(
        MasterDbGateError.MASTER_DB_QUERY_FAILED,
        `Die Track-Abfrage ist fehlgeschlagen: ${found.queryError}`,
        flags,
        { dbPath, dbType }
      );
    }
    if (!found.row) {
      return failure(
        MasterDbGateError.TRACK_NOT_FOUND_IN_MASTER_DB,
        'Der Track konnte in der Master Database nicht gefunden werden.',
        flags,
        { dbPath, dbType, identifiers }
      );
    }
    flags.trackFound = true;
    log('track found');

    const track = readMasterTrack(db, found.row, tables, dbType, dbPath);
    log('metadata loaded');

    return {
      ok: true,
      source: 'rekordbox-master-db',
      sqlcipher: true,
      ...flags,
      dbPath,
      dbType,
      matchedBy: found.matchedBy,
      trackId: track.trackId,
      track,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  MasterDbGateError,
  resolveTrackFromMasterDb,
  normalizeAudioKey,
  joinAudioPath,
};
