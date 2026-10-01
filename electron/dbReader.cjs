/**
 * @license (MIT for the reverse-engineered format notes)
 * Rekordbox Database Reader (read-only)
 *
 * Opens Rekordbox SQLCipher databases without ever writing to them:
 *
 *  - master.db        (Rekordbox 6/7 local library, djmd* tables)
 *  - exportLibrary.db (Rekordbox 7 OneLibrary / Device Library Plus)
 *
 * Both formats use SQLCipher. The SQLCipher keys are fixed, well-known
 * constants that the community has deobfuscated from the Rekordbox
 * application (see pyrekordbox / onelibrary-connect / Deep Symmetry
 * analysis); they are not license or machine dependent. The files are
 * opened with SQLite's readonly mode, so not a single byte is modified.
 *
 * The SQLCipher binding (better-sqlite3-multiple-ciphers) is a required
 * native dependency. If its ABI binding cannot be loaded, this module reports
 * `available: false`; it never silently substitutes a writable SQLite reader.
 */

const zlib = require('node:zlib');
const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Key deobfuscation (Python b85 style: 5 chars -> 4 bytes)
// ---------------------------------------------------------------------------

const BLOB_KEY = Buffer.from('657f48f84c437cc1', 'ascii');

const MASTER_DB_BLOB =
  'PN_Pq^*N>(JYe*u^8;Yg76HuZ<mR13S?=>)b9;DpoTXV(6ItkU`}8*m6tx_I{Solh_N#dfe{v=';
const ONE_LIBRARY_BLOB =
  'PN_1dH8$oLJY)16j_RvM6qphWw`476>;C1cWmI#se(PG`j}~xAjlufj?`#0i{;=glh(SkW)y0>n?YEiD`l%t(';

const B85_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';

function base85Decode(input) {
  const charToValue = new Map();
  for (let i = 0; i < B85_ALPHABET.length; i++) charToValue.set(B85_ALPHABET[i], i);

  const result = [];
  for (let i = 0; i < input.length; i += 5) {
    const chunk = input.slice(i, i + 5);
    // Partial final groups (2..4 chars) are padded on the right with the last
    // alphabet character ('~', index 84); the high (chunk.length - 1) bytes
    // of the expanded 4-byte word form the output (matches Python's b85).
    const padded = chunk.padEnd(5, B85_ALPHABET[B85_ALPHABET.length - 1]);
    let value = 0;
    for (const char of padded) {
      const v = charToValue.get(char);
      if (v === undefined) throw new Error(`Ungültiges Base85-Zeichen: ${char}`);
      value = value * 85 + v;
    }
    const bytes = [
      (value >> 24) & 0xff,
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    ];
    const numBytes = chunk.length === 5 ? 4 : chunk.length - 1;
    result.push(...bytes.slice(0, numBytes));
  }
  return Buffer.from(result);
}

function deobfuscate(blob) {
  const decoded = base85Decode(blob);
  const xored = Buffer.alloc(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    xored[i] = decoded[i] ^ BLOB_KEY[i % BLOB_KEY.length];
  }
  return zlib.inflateSync(xored).toString('utf-8');
}

function getMasterDbKey() {
  return deobfuscate(MASTER_DB_BLOB);
}

function getOneLibraryKey() {
  return deobfuscate(ONE_LIBRARY_BLOB);
}

// ---------------------------------------------------------------------------
// SQLCipher binding (required native dependency)
// ---------------------------------------------------------------------------

let cipherModule = undefined;
let cipherLoadError = null;
let cipherRuntimeAvailable = undefined;

function getCipherModule() {
  if (cipherModule !== undefined) return cipherModule;
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    cipherModule = require('better-sqlite3-multiple-ciphers');
    cipherLoadError = null;
  } catch (error) {
    cipherModule = null;
    cipherLoadError = error.message || String(error);
  }
  return cipherModule;
}

/** Confirms the native binding is loadable without touching a Rekordbox file. */
function isCipherAvailable() {
  if (cipherRuntimeAvailable !== undefined) return cipherRuntimeAvailable;
  const Database = getCipherModule();
  if (!Database) {
    cipherRuntimeAvailable = false;
    return false;
  }

  let probe = null;
  try {
    // `:memory:` probes only native ABI loading. SQLCipher functionality itself
    // is verified by the dedicated runtime preflight on its own temp file.
    probe = new Database(':memory:');
    probe.close();
    probe = null;
    cipherRuntimeAvailable = true;
  } catch (error) {
    cipherRuntimeAvailable = false;
    cipherLoadError = error.message || String(error);
  } finally {
    try { probe?.close(); } catch { /* best-effort close of the scratch DB */ }
  }
  return cipherRuntimeAvailable;
}

function detectDbType(filePath) {
  // Robust on every platform: Windows paths carry backslashes even when the
  // reader runs inside the sandbox or a non-Windows CI environment.
  const normalized = String(filePath).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const base = normalized.toLowerCase();
  if (base === 'master.db') return 'MASTER_DB';
  if (base === 'exportlibrary.db') return 'ONE_LIBRARY';
  return null;
}

function openRekordboxDb(filePath) {
  const Database = getCipherModule();
  if (!Database) {
    const reason =
      'Das SQLCipher-Modul (better-sqlite3-multiple-ciphers) ist nicht verfügbar. ' +
      `Bitte installieren und ggf. mit "npm run rebuild:electron" für die Desktop-App neu bauen. (${cipherLoadError || 'Modul fehlt'})`;
    return { available: false, reason };
  }

  const dbType = detectDbType(filePath);
  if (!dbType) {
    return { available: false, reason: 'Nur "master.db" (lokale Rekordbox 6/7-Bibliothek) oder "exportLibrary.db" (OneLibrary) werden unterstützt.' };
  }

  try {
    const key = dbType === 'MASTER_DB' ? getMasterDbKey() : getOneLibraryKey();
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      db.pragma('cipher = sqlcipher');
      db.pragma('legacy = 4');
      db.pragma(`key = '${key}'`);
      // Force decryption by touching the schema.
      db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
      // `available: true` ist vertraglich erforderlich: beide Aufrufer
      // (readRekordboxDatabase, openContentRow) brechen bei fehlendem Flag ab.
      // Ohne natives Modul trat dieser Fall nie auf – die kleine Datenbank-
      // umgebung (tests/support/rekordboxDbEnv.mjs) hat ihn sichtbar gemacht.
      // `available: true` ist verbindlich: openRekordboxDb ist die innere
      // Funktion von openContentRow/readRekordboxDatabase, die beide über
      // `!opened.available` prüfen. Ohne das Flag galt auch ein erfolgreicher
      // Öffnungsvorgang als Fehlschlag (Grund: undefined) – der Master-DB-Gate
      // hätte auf jeder echten Installation MASTER_DB_OPEN_FAILED gemeldet.
      return { available: true, db, dbType };
    } catch (openError) {
      try {
        db.close();
      } catch {
        // ignore
      }
      return {
        available: false,
        reason:
          'Die Datenbank konnte nicht entschlüsselt werden. Bitte prüfe, ob die Datei eine ' +
          `${dbType === 'MASTER_DB' ? 'Rekordbox-6/7-master.db' : 'OneLibrary-exportLibrary.db'} ist. (${openError.message || openError})`,
      };
    }
  } catch (error) {
    return { available: false, reason: `Die Datenbankdatei kann nicht geöffnet werden: ${error.message || error}` };
  }
}

// ---------------------------------------------------------------------------
// Read-only queries
// ---------------------------------------------------------------------------

function fileFingerprint(filePath) {
  const details = fs.statSync(filePath);
  if (!details.isFile()) throw new Error('Die Rekordbox-Datenbank verweist nicht auf eine Datei.');
  return { size: details.size, mtimeMs: details.mtimeMs };
}

function sameFingerprint(before, after) {
  return Boolean(before && after && before.size === after.size && before.mtimeMs === after.mtimeMs);
}

function normalizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (Buffer.isBuffer(value)) {
      out[key] = value.toString('base64');
    } else if (typeof value === 'bigint') {
      out[key] = Number(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function fetchRows(db, table, columns = '*', orderBy = '') {
  try {
    const sql = `SELECT ${columns} FROM ${table}${orderBy ? ` ORDER BY ${orderBy}` : ''}`;
    const rows = db.prepare(sql).all();
    return rows.map(normalizeRow);
  } catch (error) {
    // Tables not present in all formats (e.g. older databases).
    return { __missing: true, table, error: error.message };
  }
}

/**
 * master.db markiert lokal gelöschte Einträge über `rb_local_deleted` (eine der
 * dokumentierten Default-Spalten der djmd*-Tabellen). Rekordbox selbst zeigt
 * solche Zeilen nicht mehr; real belegte Bibliotheken enthalten sie weiterhin.
 * Wir filtern sie deshalb aus den Ergebnissen. Die Spalte existiert erst in
 * neueren Datenbanken – ein Fehlschlag der Abfrage wird stillschweigend
 * ignoriert (dann bleibt das alte Verhalten erhalten).
 */
function fetchDeletedContentIds(db) {
  try {
    const rows = db
      .prepare('SELECT ID FROM djmdContent WHERE rb_local_deleted = 1')
      .all();
    return new Set(rows.map((row) => String(row.ID)));
  } catch {
    return new Set();
  }
}

function readMasterDb(db) {
  const contentRaw = fetchRows(db, 'djmdContent', [
    'ID', 'FolderPath', 'FileNameL', 'Title', 'ArtistID', 'AlbumID', 'GenreID', 'BPM',
    'Length', 'TrackNo', 'BitRate', 'BitDepth', 'Commnt', 'FileType', 'Rating',
    'ReleaseYear', 'RemixerID', 'LabelID', 'KeyID', 'StockDate', 'ColorID',
    'DJPlayCount', 'AnalysisDataPath', 'FileSize', 'SampleRate', 'DateCreated',
    'ReleaseDate', 'ISRC', 'Subtitle', 'ComposerID',
  ].join(', '), 'ID');
  const deletedIds = fetchDeletedContentIds(db);
  const content = Array.isArray(contentRaw)
    ? contentRaw.filter((row) => !deletedIds.has(String(row.ID)))
    : contentRaw;
  const cues = fetchRows(db, 'djmdCue', ['ID', 'ContentID', 'InMsec', 'InFrame', 'OutMsec', 'OutFrame', 'Kind', 'Color', 'ColorTableIndex', 'ActiveLoop', 'Comment', 'BeatLoopSize'], 'ID');
  const artists = fetchRows(db, 'djmdArtist', 'ID, Name', 'Name');
  const albums = fetchRows(db, 'djmdAlbum', 'ID, Name', 'Name');
  const genres = fetchRows(db, 'djmdGenre', 'ID, Name', 'Name');
  const keys = fetchRows(db, 'djmdKey', 'ID, ScaleName', 'Seq');
  const labels = fetchRows(db, 'djmdLabel', 'ID, Name', 'Name');
  const playlists = fetchRows(db, 'djmdPlaylist', 'ID, Name, ParentID, Attribute', 'ID');
  const songPlaylists = fetchRows(db, 'djmdSongPlaylist', 'ID, PlaylistID, ContentID, TrackNo', 'ID');
  return { content, cues, artists, albums, genres, keys, labels, playlists, songPlaylists };
}

function readOneLibraryDb(db) {
  const content = fetchRows(db, 'content');
  const cues = fetchRows(db, 'cue');
  const artists = fetchRows(db, 'artist', 'artist_id, name');
  const albums = fetchRows(db, 'album', 'album_id, name');
  const genres = fetchRows(db, 'genre', 'genre_id, name');
  const keys = fetchRows(db, 'key', 'key_id, name');
  const labels = fetchRows(db, 'label', 'label_id, name');
  const playlists = fetchRows(db, 'playlist', 'playlist_id, name, playlist_id_parent, attribute');
  // Dokumentierter Aufbau der playlist_content-Einträge (Device Library Plus):
  // zusammengesetzter Schlüssel (playlist_id, content_id) + sequenceNo – es gibt
  // KEINE eigene playlist_content_id-Spalte (pyrekordbox devicelib_plus.md).
  const songPlaylists = fetchRows(db, 'playlist_content', 'playlist_id, content_id, sequenceNo');
  return { content, cues, artists, albums, genres, keys, labels, playlists, songPlaylists };
}

/**
 * Opens and reads a Rekordbox database (read-only).
 * @returns {{available:boolean, reason?:string, dbType?:string, filePath?:string,
 *   stats?:object, rows?:object, warnings?:string[]}}
 */
function readRekordboxDatabase(filePath) {
  let before;
  try {
    before = fileFingerprint(filePath);
  } catch (error) {
    return { available: false, reason: `Datenbank-Fingerprint vor dem Read-only-Lesen fehlgeschlagen: ${error.message || error}` };
  }
  const opened = openRekordboxDb(filePath);
  if (!opened.available) return opened;

  const { db, dbType } = opened;
  try {
    const rows = dbType === 'MASTER_DB' ? readMasterDb(db) : readOneLibraryDb(db);
    const contentRows = Array.isArray(rows.content) ? rows.content : [];
    const warnings = [];
    if (!Array.isArray(rows.content)) warnings.push('Tabelle djmdContent/content fehlt.');
    if (!Array.isArray(rows.cues)) warnings.push('Cue-Tabelle fehlt – Cues werden nicht importiert.');

    // Safety bound so that a pathological library cannot blow up IPC.
    if (contentRows.length > 100_000) {
      warnings.push(`Die Bibliothek enthält ${contentRows.length} Tracks; nur die ersten 100.000 werden geladen.`);
    }

    const after = fileFingerprint(filePath);
    if (!sameFingerprint(before, after)) {
      return {
        available: false,
        dbType,
        reason: 'Größe oder mtime der Rekordbox-Datenbank änderte sich während des Read-only-Lesevorgangs.',
      };
    }

    return {
      available: true,
      dbType,
      filePath,
      fileName: path.basename(filePath),
      stats: {
        tracks: Math.min(contentRows.length, 100_000),
        cues: Array.isArray(rows.cues) ? rows.cues.length : 0,
        playlists: Array.isArray(rows.playlists) ? rows.playlists.length : 0,
      },
      rows: {
        content: contentRows.slice(0, 100_000),
        cues: Array.isArray(rows.cues) ? rows.cues : [],
        artists: Array.isArray(rows.artists) ? rows.artists : [],
        albums: Array.isArray(rows.albums) ? rows.albums : [],
        genres: Array.isArray(rows.genres) ? rows.genres : [],
        keys: Array.isArray(rows.keys) ? rows.keys : [],
        labels: Array.isArray(rows.labels) ? rows.labels : [],
        playlists: Array.isArray(rows.playlists) ? rows.playlists : [],
        songPlaylists: Array.isArray(rows.songPlaylists) ? rows.songPlaylists : [],
      },
      warnings,
    };
  } finally {
    db.close();
  }
}

/**
 * Targeted single-track read for the Master-DB-Gate (Phase 5).
 *
 * Opens the database read-only, validates the schema of the content table and
 * returns exactly ONE djmdContent/content row (plus its cue rows) instead of
 * shipping the whole library over IPC. The gate maps the returned flags to its
 * state machine:
 *
 *   { available:false, schemaInvalid:true } → MASTER_DB_SCHEMA_INVALID
 *   { available:false, reason }             → MASTER_DB_OPEN_FAILED
 *   { available:true,  row:null }           → TRACK_NOT_FOUND_IN_MASTER_DB
 *
 * @param {string} filePath master.db or exportLibrary.db
 * @param {string|number} trackId XML TrackID (= djmdContent.ID)
 * @returns {{available:boolean, schemaInvalid?:boolean, dbType?:string,
 *   reason?:string, row?:object|null, cues?:object[]}}
 */
function openContentRow(filePath, trackId) {
  let before;
  try {
    before = fileFingerprint(filePath);
  } catch (error) {
    return { available: false, reason: `Datenbank-Fingerprint vor dem Read-only-Lesen fehlgeschlagen: ${error.message || error}` };
  }
  const opened = openRekordboxDb(filePath);
  if (!opened.available) return { available: false, reason: opened.reason };

  const { db, dbType } = opened;
  try {
    const table = dbType === 'MASTER_DB' ? 'djmdContent' : 'content';
    let columns = [];
    try {
      columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
    } catch (error) {
      return {
        available: false,
        schemaInvalid: true,
        dbType,
        reason: `Schemaabfrage für ${table} fehlgeschlagen: ${error.message || error}`,
      };
    }
    if (columns.length === 0) {
      return { available: false, schemaInvalid: true, dbType, reason: `Tabelle ${table} fehlt.` };
    }

    let idColumn = null;
    if (dbType === 'MASTER_DB') {
      const required = ['ID', 'FolderPath', 'FileNameL', 'AnalysisDataPath'];
      const missing = required.filter((name) => !columns.includes(name));
      if (missing.length > 0) {
        return {
          available: false,
          schemaInvalid: true,
          dbType,
          reason: `Pflichtspalten in ${table} fehlen: ${missing.join(', ')}`,
        };
      }
      idColumn = 'ID';
    } else {
      idColumn = columns.includes('ID') ? 'ID' : columns.includes('content_id') ? 'content_id' : null;
      if (!idColumn) {
        return {
          available: false,
          schemaInvalid: true,
          dbType,
          reason: `Spalte ID/content_id in ${table} fehlt.`,
        };
      }
    }

    let row = null;
    try {
      const stmt = db.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ? LIMIT 1`);
      row = stmt.get(String(trackId)) || null;
      if (!row && /^\d+$/.test(String(trackId))) {
        row = stmt.get(Number(trackId)) || null;
      }
    } catch (error) {
      return { available: false, dbType, reason: `Abfrage von ${table} fehlgeschlagen: ${error.message || error}` };
    }

    // Lokal gelöschte Einträge (master.db: rb_local_deleted = 1) sind für den
    // Lade-Pfad nicht vorhanden – genau wie in rekordbox selbst.
    if (row && Number(row.rb_local_deleted) === 1) {
      row = null;
    }

    // Cue rows are optional context for the gate (best effort; missing cue
    // tables must not invalidate an otherwise usable content row).
    let cues = [];
    if (row) {
      const cueTable = dbType === 'MASTER_DB' ? 'djmdCue' : 'cue';
      const cueColumns = (() => {
        try {
          return db.prepare(`PRAGMA table_info(${cueTable})`).all().map((r) => r.name);
        } catch {
          return [];
        }
      })();
      const foreignKey = cueColumns.includes('ContentID')
        ? 'ContentID'
        : cueColumns.includes('content_id')
          ? 'content_id'
          : null;
      if (foreignKey) {
        try {
          cues = db
            .prepare(`SELECT * FROM ${cueTable} WHERE ${foreignKey} = ? LIMIT 512`)
            .all(String(row[idColumn] ?? trackId))
            .map(normalizeRow);
        } catch {
          cues = [];
        }
      }
    }

    let after;
    try {
      after = fileFingerprint(filePath);
    } catch (error) {
      return { available: false, dbType, reason: `Datenbank-Fingerprint nach dem Read-only-Lesen fehlgeschlagen: ${error.message || error}` };
    }
    if (!sameFingerprint(before, after)) {
      return {
        available: false,
        dbType,
        reason: 'Größe oder mtime der Rekordbox-Datenbank änderte sich während des Read-only-Lesevorgangs.',
      };
    }

    return {
      available: true,
      dbType,
      row: row ? normalizeRow(row) : null,
      cues,
    };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-location candidates (read-only directory inspection)
// ---------------------------------------------------------------------------

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function candidateFromOptions(appDir) {
  const pioneerRoot = path.dirname(appDir);
  // Rekordbox speichert den tatsächlichen Datenbankort in der options.json
  // des rekordboxAgent. Kanonisch liegt sie als Geschwister der Version-Ordner:
  //   %APPDATA%\Pioneer\rekordboxAgent\storage\options.json (Windows)
  //   ~/Library/Application Support/Pioneer/rekordboxAgent/storage/options.json (macOS)
  // Die alte Suche nur innerhalb des Version-Ordners
  // (rekordbox7\rekordboxAgent\…) hat diesen Ort übersehen – ein
  // benutzerdefinierter db-path wurde nie gefunden, der Gate suchte dann nur
  // in (oft alten/leeren) Standard-Ordnern.
  const optionsPaths = [
    path.join(pioneerRoot, 'rekordboxAgent', 'storage', 'options.json'),
    path.join(appDir, 'rekordboxAgent', 'storage', 'options.json'),
  ];
  for (const optionsPath of optionsPaths) {
    const options = readJsonIfExists(optionsPath);
    if (!options || !Array.isArray(options.options)) continue;
    for (const entry of options.options) {
      if (Array.isArray(entry) && entry[0] === 'db-path' && typeof entry[1] === 'string' && entry[1].trim()) {
        return entry[1];
      }
    }
  }
  return null;
}

/**
 * Resolves the `db-path` value to a concrete database file. rekordbox writes
 * the full file path on macOS, but configs have also been seen that point at
 * the containing folder – accept both (always read-only).
 */
function resolveDbPathValue(rawValue) {
  let p = String(rawValue).trim().replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1');
  try {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      const master = path.join(p, 'master.db');
      const oneLibrary = path.join(p, 'exportLibrary.db');
      p = fs.existsSync(master) && fs.statSync(master).isFile()
        ? master
        : fs.existsSync(oneLibrary) && fs.statSync(oneLibrary).isFile()
          ? oneLibrary
          : p;
    }
  } catch {
    // existence is re-checked by the caller
  }
  return p;
}

function findDatabaseFiles(appDir, { includeOptions = true } = {}) {
  const results = [];
  if (!appDir) return results;

  // Rekordbox 6/7 keep the real database location in options.json (sibling
  // of the version folders). Checked first so a custom db-path ranks ahead
  // of stale default files; works even when the version folder itself does
  // not exist.
  const fromOptions = includeOptions ? candidateFromOptions(appDir) : null;
  if (fromOptions) {
    const p = resolveDbPathValue(fromOptions);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const base = path.basename(p).toLowerCase();
        const kind = base === 'exportlibrary.db' ? 'ONE_LIBRARY' : base === 'master.db' ? 'MASTER_DB' : null;
        if (kind) results.push({ path: p, kind, label: `${base} (aus rekordboxAgent/options.json)` });
      }
    } catch {
      // ignore unreadable candidates
    }
  }

  if (!fs.existsSync(appDir)) return results;

  const master = path.join(appDir, 'master.db');
  if (fs.existsSync(master) && fs.statSync(master).isFile()) {
    results.push({ path: master, kind: 'MASTER_DB', label: `master.db (${appDir})` });
  }

  // OneLibrary exports live on prepared media; scan common subfolders lightly.
  const exportCandidates = [
    path.join(appDir, 'exportLibrary.db'),
    path.join(appDir, 'share', 'exportLibrary.db'),
  ];
  for (const candidate of exportCandidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      results.push({ path: candidate, kind: 'ONE_LIBRARY', label: `exportLibrary.db (${candidate})` });
    }
  }
  return results;
}

/**
 * Scans one Pioneer root folder for known database files in the root,
 * rekordbox7/rekordbox6/rekordbox subfolders, plus the sibling rekordboxAgent
 * options.json. Exported for tests; pure read-only fs reads.
 */
function collectPioneerRootCandidates(pioneerRoot) {
  const results = [];
  if (!pioneerRoot) return results;
  // Accept both a standard Rekordbox application-data root and an exported
  // PIONEER media root supplied by the user (for example D:\\PIONEER).
  // Only known database filenames are considered; all filesystem access stays
  // read-only.
  results.push(...findDatabaseFiles(pioneerRoot, { includeOptions: false }));
  for (const dirName of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
    results.push(...findDatabaseFiles(path.join(pioneerRoot, dirName)));
  }
  return results;
}

/**
 * Scans the standard Pioneer/Rekordbox application data directories for
 * master.db / exportLibrary.db (read-only).
 *
 * `AIRODOX_REKORDBOX_DB` (durch `;` getrennt) überschreibt die Suche für
 * Bibliotheken, die an einem ungewöhnlichen Ort liegen (externe Library,
 * Netzwerkpfad, Diagnose eines Fremdrechners). Auch dieser Pfad wird
 * ausschließlich lesend geöffnet.
 */
function locateRekordboxDatabases() {
  const candidates = [];
  const override = (process.env.AIRODOX_REKORDBOX_DB || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of override) {
    const cleaned = entry.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1');
    if (!fs.existsSync(cleaned) || !fs.statSync(cleaned).isFile()) continue;
    const base = path.basename(cleaned).toLowerCase();
    const kind = base === 'master.db' ? 'MASTER_DB' : base === 'exportlibrary.db' ? 'ONE_LIBRARY' : null;
    if (kind) candidates.push({ path: cleaned, kind, label: `${base} (AIRODOX_REKORDBOX_DB)` });
  }

  // An explicit path list is an exact selection, not merely an extra search
  // hint. This prevents an unrelated stale AppData master.db from silently
  // winning when the user intentionally points diagnostics at another library.
  if (override.length === 0 && process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    // Check the user-supplied export/database root before standard locations,
    // but still prefer MASTER_DB over OneLibrary in the gate's type ordering.
    candidates.push(...collectPioneerRootCandidates(path.win32.join('D:\\', 'PIONEER')));
    candidates.push(...collectPioneerRootCandidates(path.join(appData, 'Pioneer')));
  } else if (override.length === 0 && process.platform === 'darwin') {
    candidates.push(...collectPioneerRootCandidates(path.join(process.env.HOME || '', 'Library', 'Application Support', 'Pioneer')));
  }

  // Deduplicate by resolved path while preserving explicit-root search order.
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    unique.push({ ...candidate, path: resolved });
  }
  return unique;
}

module.exports = {
  getMasterDbKey,
  getOneLibraryKey,
  detectDbType,
  readRekordboxDatabase,
  openContentRow,
  locateRekordboxDatabases,
  collectPioneerRootCandidates,
  isCipherAvailable,
};
