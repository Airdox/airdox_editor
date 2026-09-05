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
 * constants that the community deobfuscated from the Rekordbox application
 * (see pyrekordbox / onelibrary-connect / Deep Symmetry analysis); they are not
 * license or machine dependent. Files are opened read-only, so not a single
 * byte is modified.
 *
 * Two engines are supported, in this order:
 *
 *  1. `better-sqlite3-multiple-ciphers` – optional native binding (fastest).
 *     Prebuilt binaries exist up to Electron ABI 146, so newer Electron
 *     versions would have to compile it with Visual Studio / node-gyp.
 *  2. Pure JavaScript – SQLCipher pages are decrypted with node:crypto and the
 *     plaintext copy is queried with sql.js (SQLite/WASM). No compiler, no
 *     native module, works in every packaged build. See sqlcipherCodec.cjs.
 */

const zlib = require('node:zlib');
const path = require('node:path');
const fs = require('node:fs');
const {
  decryptFileToPlainSqlite,
  openPlainDatabase,
  isAvailable: isJsEngineAvailable,
} = require('./sqlcipherJsReader.cjs');

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

function getDatabaseKey(dbType) {
  return dbType === 'ONE_LIBRARY' ? getOneLibraryKey() : getMasterDbKey();
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

// ---------------------------------------------------------------------------
// Table descriptions (both schemas map onto the same row contract)
// ---------------------------------------------------------------------------

const MASTER_DB_TABLES = [
  {
    alias: 'content',
    table: 'djmdContent',
    required: true,
    orderBy: 'ID',
    columns: [
      'ID', 'FolderPath', 'FileNameL', 'Title', 'ArtistID', 'AlbumID', 'GenreID', 'BPM',
      'Length', 'TrackNo', 'BitRate', 'BitDepth', 'Commnt', 'FileType', 'Rating',
      'ReleaseYear', 'RemixerID', 'LabelID', 'KeyID', 'StockDate', 'ColorID',
      'DJPlayCount', 'AnalysisDataPath', 'FileSize', 'SampleRate', 'DateCreated',
      'ReleaseDate', 'ISRC', 'Subtitle', 'ComposerID',
    ],
  },
  {
    alias: 'cues',
    table: 'djmdCue',
    orderBy: 'ID',
    columns: [
      'ID', 'ContentID', 'InMsec', 'InFrame', 'OutMsec', 'OutFrame', 'Kind', 'Color',
      'ColorTableIndex', 'ActiveLoop', 'Comment', 'BeatLoopSize',
    ],
  },
  { alias: 'artists', table: 'djmdArtist', orderBy: 'Name', columns: ['ID', 'Name'] },
  { alias: 'albums', table: 'djmdAlbum', orderBy: 'Name', columns: ['ID', 'Name'] },
  { alias: 'genres', table: 'djmdGenre', orderBy: 'Name', columns: ['ID', 'Name'] },
  { alias: 'keys', table: 'djmdKey', orderBy: 'Seq', columns: ['ID', 'ScaleName'] },
  { alias: 'labels', table: 'djmdLabel', orderBy: 'Name', columns: ['ID', 'Name'] },
  { alias: 'playlists', table: 'djmdPlaylist', orderBy: 'ID', columns: ['ID', 'Name', 'ParentID', 'Attribute'] },
  { alias: 'songPlaylists', table: 'djmdSongPlaylist', orderBy: 'ID', columns: ['ID', 'PlaylistID', 'ContentID', 'TrackNo'] },
];

const ONE_LIBRARY_TABLES = [
  { alias: 'content', table: 'content', required: true, orderBy: 'content_id', columns: null },
  { alias: 'cues', table: 'cue', orderBy: 'cue_id', columns: null },
  { alias: 'artists', table: 'artist', orderBy: 'name', columns: ['artist_id', 'name'] },
  { alias: 'albums', table: 'album', orderBy: 'name', columns: ['album_id', 'name'] },
  { alias: 'genres', table: 'genre', orderBy: 'name', columns: ['genre_id', 'name'] },
  { alias: 'keys', table: 'key', orderBy: 'key_id', columns: ['key_id', 'name'] },
  { alias: 'labels', table: 'label', orderBy: 'name', columns: ['label_id', 'name'] },
  {
    alias: 'playlists',
    table: 'playlist',
    orderBy: 'playlist_id',
    columns: ['playlist_id', 'name', 'playlist_id_parent', 'attribute'],
  },
  {
    alias: 'songPlaylists',
    table: 'playlist_content',
    orderBy: 'playlist_content_id',
    columns: ['playlist_content_id', 'playlist_id', 'content_id', 'sequenceNo'],
  },
];

// ---------------------------------------------------------------------------
// Query adapters (native binding / WebAssembly engine share one interface)
// ---------------------------------------------------------------------------

function normalizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (Buffer.isBuffer(value)) {
      out[key] = value.toString('base64');
    } else if (value instanceof Uint8Array) {
      out[key] = Buffer.from(value).toString('base64');
    } else if (typeof value === 'bigint') {
      out[key] = Number(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function createNativeQuery(db) {
  return (sql) => db.prepare(sql).all().map(normalizeRow);
}

function createSqlJsQuery(db) {
  return (sql) => {
    const statement = db.prepare(sql);
    try {
      const rows = [];
      while (statement.step()) rows.push(normalizeRow(statement.getAsObject()));
      return rows;
    } finally {
      statement.free();
    }
  };
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Column names of a table (empty list => the table does not exist). */
function tableColumns(query, table) {
  try {
    return query(`PRAGMA table_info(${quoteIdentifier(table)})`).map((row) => String(row.name ?? row.cid ?? ''));
  } catch {
    return [];
  }
}

/**
 * Reads one table while tolerating schema drift: unknown columns of a Rekordbox
 * version are dropped instead of failing the whole import.
 */
function fetchTable(query, spec, warnings) {
  const available = tableColumns(query, spec.table);
  if (available.length === 0) {
    if (spec.required) {
      return { __missing: true, table: spec.table, error: `Pflichttabelle ${spec.table} fehlt in der Datenbank.` };
    }
    return { __missing: true, table: spec.table };
  }
  const availableSet = new Set(available);
  const columns = spec.columns ? spec.columns.filter((name) => availableSet.has(name)) : null;
  if (spec.columns && columns.length === 0) {
    return { __missing: true, table: spec.table, error: `Keine der erwarteten Spalten von ${spec.table} ist vorhanden.` };
  }
  if (spec.columns) {
    const dropped = spec.columns.filter((name) => !availableSet.has(name));
    if (dropped.length) warnings.push(`${spec.table}: Spalte(n) ${dropped.join(', ')} fehlen in dieser Datenbankversion.`);
  }
  const orderBy = spec.orderBy && availableSet.has(spec.orderBy) ? ` ORDER BY ${quoteIdentifier(spec.orderBy)}` : '';
  const projection = columns ? columns.map(quoteIdentifier).join(', ') : '*';
  try {
    return query(`SELECT ${projection} FROM ${quoteIdentifier(spec.table)}${orderBy}`);
  } catch (error) {
    return { __missing: true, table: spec.table, error: error.message || String(error) };
  }
}

function readTables(query, specs, warnings) {
  const rows = {};
  for (const spec of specs) {
    rows[spec.alias] = fetchTable(query, spec, warnings);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Native SQLCipher binding (optional accelerator)
// ---------------------------------------------------------------------------

let cipherModule;
let cipherLoadError = null;

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

/** Node's module-not-found text contains a whole require stack; keep it short. */
function firstLine(message) {
  return String(message || '').split('\n')[0].trim();
}

function openRekordboxDbNative(filePath, dbType) {
  const Database = getCipherModule();
  if (!Database) {
    return {
      available: false,
      reason:
        'Das optionale SQLCipher-Modul (better-sqlite3-multiple-ciphers) ist nicht installiert – ' +
        `die Datenbank wird im reinen JavaScript-Pfad gelesen. (${firstLine(cipherLoadError) || 'Modul fehlt'})`,
    };
  }

  const key = getDatabaseKey(dbType);
  let db;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    db.pragma('cipher = sqlcipher');
    db.pragma('legacy = 4');
    db.pragma(`key = '${key.replace(/'/g, "''")}'`);
    // Force decryption by touching the schema.
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    return { available: true, db, dbType };
  } catch (openError) {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    return {
      available: false,
      reason:
        'Die Datenbank konnte mit dem nativen SQLCipher-Modul nicht geöffnet werden. Bitte prüfe, ob die Datei eine ' +
        `${dbType === 'MASTER_DB' ? 'Rekordbox-6/7-master.db' : 'OneLibrary-exportLibrary.db'} ist. (${openError.message || openError})`,
    };
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const MAX_ROWS = 100_000;

function summarizeRows(rows, warnings) {
  const arrays = {};
  for (const [alias, value] of Object.entries(rows)) {
    if (Array.isArray(value)) {
      if (alias === 'content' && value.length > MAX_ROWS) {
        warnings.push(`Die Bibliothek enthält ${value.length} Tracks; nur die ersten ${MAX_ROWS.toLocaleString('de-DE')} werden geladen.`);
        arrays[alias] = value.slice(0, MAX_ROWS);
      } else {
        arrays[alias] = value;
      }
    } else {
      arrays[alias] = [];
      if (value && value.__missing && value.error) warnings.push(value.error);
    }
  }
  return arrays;
}

async function readViaJavaScriptEngine(filePath, dbType, warnings) {
  if (!(await isJsEngineAvailable())) {
    return { available: false, reason: 'Das npm-Paket "sql.js" ist nicht installiert; der reine JavaScript-Lesepfad ist nicht verfügbar.' };
  }

  const decrypted = await decryptFileToPlainSqlite(filePath, getDatabaseKey(dbType));
  if (
    decrypted.physicalPageCount &&
    decrypted.pageCount &&
    decrypted.physicalPageCount > decrypted.pageCount
  ) {
    warnings.push(
      `Die Datenbankdatei enthält ${decrypted.physicalPageCount} Seiten, der Kopf beschreibt nur ${decrypted.pageCount}. ` +
        'Möglicherweise wurde die Datei unvollständig geschrieben – bitte Rekordbox schließen und die Bibliothek neu sichern.'
    );
  }
  const { db, driver } = await openPlainDatabase(decrypted.data);
  // The engine keeps its own copy; releasing ours lowers the peak on big libraries.
  const cipher = decrypted.config.id;
  decrypted.data = null;
  try {
    const specs = dbType === 'ONE_LIBRARY' ? ONE_LIBRARY_TABLES : MASTER_DB_TABLES;
    const rows = readTables(createSqlJsQuery(db), specs, warnings);
    return { available: true, rows, engine: 'JS_SQLCIPHER', driver, cipher };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Opens and reads a Rekordbox database (read-only), preferring the native
 * SQLCipher binding and falling back to the pure-JavaScript engine.
 *
 * @returns {Promise<{available:boolean, reason?:string, dbType?:string, filePath?:string,
 *   fileName?:string, engine?:string, driver?:string, cipher?:string, stats?:object,
 *   rows?:object, warnings?:string[]}>}
 */
async function readRekordboxDatabase(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { available: false, reason: 'Kein gültiger Datenbankpfad übergeben.' };
  }

  const dbType = detectDbType(filePath);
  if (!dbType) {
    return {
      available: false,
      reason:
        'Nur "master.db" (lokale Rekordbox 6/7-Bibliothek) oder "exportLibrary.db" (OneLibrary / Device Library Plus) werden unterstützt.',
    };
  }

  const warnings = [];
  try {
    if (!fs.existsSync(filePath)) {
      return { available: false, reason: `Die Datenbankdatei existiert nicht: ${filePath}` };
    }
    if (fs.existsSync(`${filePath}-wal`)) {
      warnings.push(
        'Es existiert eine -wal-Datei der Rekordbox-Datenbank. Nur lesender Snapshot der Hauptdatei – bitte Rekordbox schließen, falls Daten fehlen.'
      );
    }
  } catch (error) {
    return { available: false, reason: `Die Datenbankdatei kann nicht geprüft werden: ${error.message || error}` };
  }

  let nativeResult = null;
  const native = openRekordboxDbNative(filePath, dbType);
  if (native.available) {
    try {
      nativeResult = {
        ...readTables(createNativeQuery(native.db), dbType === 'ONE_LIBRARY' ? ONE_LIBRARY_TABLES : MASTER_DB_TABLES, warnings),
      };
    } catch (error) {
      warnings.push(`Native SQLCipher-Abfrage fehlgeschlagen (${error.message || error}); JavaScript-Fallback wird verwendet.`);
      nativeResult = null;
    } finally {
      try {
        native.db.close();
      } catch {
        // ignore
      }
    }
  } else if (native.reason) {
    warnings.push(native.reason);
  }

  let engine = null;
  let driver = null;
  let cipher = null;
  let rows = nativeResult;
  if (!rows) {
    try {
      const jsResult = await readViaJavaScriptEngine(filePath, dbType, warnings);
      if (!jsResult.available) {
        return { available: false, reason: jsResult.reason, warnings, dbType, filePath };
      }
      rows = jsResult.rows;
      engine = jsResult.engine;
      driver = jsResult.driver;
      cipher = jsResult.cipher;
    } catch (error) {
      return {
        available: false,
        reason: `Die Rekordbox-Datenbank konnte nicht gelesen werden: ${error.message || error}`,
        warnings,
        dbType,
        filePath,
      };
    }
  } else {
    engine = 'NATIVE_SQLCIPHER';
    driver = 'better-sqlite3-multiple-ciphers';
    cipher = 'SQLCipher v4 (PRAGMA legacy = 4)';
  }

  const safeRows = summarizeRows(rows, warnings);
  if (!Array.isArray(rows.content)) {
    warnings.push('Tabelle djmdContent/content fehlt – die Datenbank enthält keine lesbaren Tracks.');
  }

  return {
    available: true,
    dbType,
    filePath,
    fileName: path.basename(filePath),
    engine,
    driver,
    cipher,
    stats: {
      tracks: Math.min(Array.isArray(safeRows.content) ? safeRows.content.length : 0, MAX_ROWS),
      cues: Array.isArray(safeRows.cues) ? safeRows.cues.length : 0,
      playlists: Array.isArray(safeRows.playlists) ? safeRows.playlists.length : 0,
    },
    rows: {
      content: safeRows.content || [],
      cues: safeRows.cues || [],
      artists: safeRows.artists || [],
      albums: safeRows.albums || [],
      genres: safeRows.genres || [],
      keys: safeRows.keys || [],
      labels: safeRows.labels || [],
      playlists: safeRows.playlists || [],
      songPlaylists: safeRows.songPlaylists || [],
    },
    warnings,
  };
}

/**
 * Reports which read engines are usable in this installation. Shown in the UI
 * so a missing native module never looks like a broken import.
 */
async function describeEngines() {
  const native = getCipherModule();
  return {
    native: {
      available: Boolean(native),
      note: native
        ? 'Schnellster Pfad; benötigt ein für Electron gebautes natives Modul.'
        : 'Optional; ohne Compiler nicht vorhanden. Fehlt es, liest die App die Datenbank im reinen JavaScript-Pfad.',
      reason: native ? null : cipherLoadError || 'Modul fehlt',
    },
    javascript: {
      available: await isJsEngineAvailable(),
      note: 'SQLCipher-Entschlüsselung mit node:crypto + SQLite als WebAssembly (sql.js). Kein Build-Toolchain nötig.',
    },
  };
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
  const optionsPath = path.join(appDir, 'rekordboxAgent', 'storage', 'options.json');
  const options = readJsonIfExists(optionsPath);
  if (!options || !Array.isArray(options.options)) return null;
  for (const entry of options.options) {
    if (Array.isArray(entry) && entry[0] === 'db-path' && typeof entry[1] === 'string' && entry[1].trim()) {
      return entry[1];
    }
  }
  return null;
}

function findDatabaseFiles(appDir) {
  const results = [];
  if (!appDir || !fs.existsSync(appDir)) return results;

  const master = path.join(appDir, 'master.db');
  if (fs.existsSync(master) && fs.statSync(master).isFile()) {
    results.push({ path: master, kind: 'MASTER_DB', label: `master.db (${appDir})` });
  }

  // Rekordbox 6/7 keep the real database location in options.json.
  const fromOptions = candidateFromOptions(appDir);
  if (fromOptions) {
    const p = fromOptions.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1');
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const base = path.basename(p).toLowerCase();
      const kind = base === 'exportlibrary.db' ? 'ONE_LIBRARY' : base === 'master.db' ? 'MASTER_DB' : null;
      if (kind) results.push({ path: p, kind, label: `${base} (aus rekordboxAgent/options.json)` });
    }
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
 * Scans the standard Pioneer/Rekordbox application data directories for
 * master.db / exportLibrary.db (read-only) and for the ANLZ folders that
 * belong to them.
 */
function locateRekordboxDatabases() {
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    for (const dirName of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
      candidates.push(...findDatabaseFiles(path.join(appData, 'Pioneer', dirName)));
    }
  } else if (process.platform === 'darwin') {
    const base = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Pioneer');
    for (const dirName of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
      candidates.push(...findDatabaseFiles(path.join(base, dirName)));
    }
  }

  // Deduplicate by resolved path; options.json entries rank first.
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
  getDatabaseKey,
  detectDbType,
  readRekordboxDatabase,
  locateRekordboxDatabases,
  describeEngines,
  isCipherAvailable: () => getCipherModule() !== null,
};
