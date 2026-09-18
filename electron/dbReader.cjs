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
 * The SQLCipher binding (better-sqlite3-multiple-ciphers) is an optional
 * native dependency. When it is not installed (e.g. during development
 * without a matching ABI), this module reports `available: false` and the
 * application keeps using the officially supported Rekordbox XML export.
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
// SQLCipher binding (optional native dependency)
// ---------------------------------------------------------------------------

let cipherModule = undefined;
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
      return { db, dbType };
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

/** Quote only identifiers learned from sqlite_master/PRAGMA, never user input. */
function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

/**
 * Read the actual encrypted database schema after SQLCipher has been opened.
 * This is intentionally built entirely from SELECT/PRAGMA statements.
 */
function inspectDbSchema(db) {
  const schema = { tables: [], columns: {}, indexes: {}, properties: {}, missingRequired: [] };
  try {
    const objects = db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY type, name").all();
    for (const object of objects) {
      if (object.type === 'table') schema.tables.push(object.name);
      else if (object.type === 'index') {
        const key = object.tbl_name || '(unknown)';
        if (!schema.indexes[key]) schema.indexes[key] = [];
        schema.indexes[key].push(object.name);
      }
    }
    for (const table of schema.tables) {
      try {
        schema.columns[table] = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
          .map((row) => row.name);
      } catch {
        schema.columns[table] = [];
      }
    }
    const propertyTable = schema.tables.find((name) => name.toLowerCase() === 'djmdproperty');
    if (propertyTable) {
      // The exact property columns vary across Rekordbox versions. A small
      // read-only sample records DBVersion/DBID when the version exposes them.
      const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(propertyTable)} LIMIT 128`).all();
      for (const row of rows) {
        const normalized = {};
        for (const [key, value] of Object.entries(row)) normalized[String(key).toLowerCase()] = value;
        const propertyName = normalized.property ?? normalized.name ?? normalized.key;
        const propertyValue = normalized.value ?? normalized.val ?? normalized.text;
        if (typeof propertyName === 'string' && /^(dbversion|dbid)$/i.test(propertyName)) {
          schema.properties[propertyName] = propertyValue == null ? null : propertyValue;
        }
        for (const [key, value] of Object.entries(row)) {
          if (/^(dbversion|dbid)$/i.test(key)) schema.properties[key] = value == null ? null : value;
        }
      }
    }
  } catch (error) {
    schema.error = error.message || String(error);
  }
  return schema;
}

function schemaTable(schema, wanted) {
  return schema.tables.find((name) => name.toLowerCase() === wanted.toLowerCase());
}

function selectKnownColumns(schema, table, wantedColumns) {
  const actualTable = schemaTable(schema, table);
  if (!actualTable) return '*';
  const available = schema.columns[actualTable] || [];
  const selected = wantedColumns
    .map((wanted) => available.find((actual) => actual.toLowerCase() === wanted.toLowerCase()))
    .filter(Boolean);
  return selected.length ? selected.map(quoteIdentifier).join(', ') : '*';
}

function readMasterDb(db, schema) {
  const contentColumns = [
    'ID', 'FolderPath', 'FileNameL', 'FileNameS', 'Title', 'ArtistID', 'AlbumID', 'GenreID', 'BPM',
    'Length', 'TrackNo', 'BitRate', 'BitDepth', 'Commnt', 'FileType', 'Rating',
    'ReleaseYear', 'RemixerID', 'LabelID', 'KeyID', 'StockDate', 'ColorID',
    'DJPlayCount', 'AnalysisDataPath', 'FileSize', 'SampleRate', 'DateCreated',
    'ReleaseDate', 'ISRC', 'Subtitle', 'ComposerID',
  ];
  const cueColumns = [
    'ID', 'ContentID', 'InMsec', 'InFrame', 'InMpegFrame', 'InMpegAbs',
    'OutMsec', 'OutFrame', 'OutMpegFrame', 'OutMpegAbs', 'Kind', 'Color',
    'ColorTableIndex', 'ActiveLoop', 'Comment', 'BeatLoopSize',
  ];
  const content = fetchRows(db, 'djmdContent', selectKnownColumns(schema, 'djmdContent', contentColumns), 'ID');
  const cues = fetchRows(db, 'djmdCue', selectKnownColumns(schema, 'djmdCue', cueColumns), 'ID');
  const artists = fetchRows(db, 'djmdArtist', selectKnownColumns(schema, 'djmdArtist', ['ID', 'Name']), 'Name');
  const albums = fetchRows(db, 'djmdAlbum', selectKnownColumns(schema, 'djmdAlbum', ['ID', 'Name']), 'Name');
  const genres = fetchRows(db, 'djmdGenre', selectKnownColumns(schema, 'djmdGenre', ['ID', 'Name']), 'Name');
  const keys = fetchRows(db, 'djmdKey', selectKnownColumns(schema, 'djmdKey', ['ID', 'ScaleName', 'Seq']), 'Seq');
  const labels = fetchRows(db, 'djmdLabel', selectKnownColumns(schema, 'djmdLabel', ['ID', 'Name']), 'Name');
  const playlists = fetchRows(db, 'djmdPlaylist', selectKnownColumns(schema, 'djmdPlaylist', ['ID', 'Name', 'ParentID', 'Attribute']), 'ID');
  const songPlaylists = fetchRows(db, 'djmdSongPlaylist', selectKnownColumns(schema, 'djmdSongPlaylist', ['ID', 'PlaylistID', 'ContentID', 'TrackNo']), 'ID');
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
  const songPlaylists = fetchRows(db, 'playlist_content', 'playlist_content_id, playlist_id, content_id, sequenceNo');
  return { content, cues, artists, albums, genres, keys, labels, playlists, songPlaylists };
}

/**
 * Opens and reads a Rekordbox database (read-only).
 * @returns {{available:boolean, reason?:string, dbType?:string, filePath?:string,
 *   stats?:object, rows?:object, warnings?:string[]}}
 */
function readRekordboxDatabase(filePath) {
  const opened = openRekordboxDb(filePath);
  if (!opened.available) return opened;

  const { db, dbType } = opened;
  try {
    const schema = inspectDbSchema(db);
    const rows = dbType === 'MASTER_DB' ? readMasterDb(db, schema) : readOneLibraryDb(db);
    const contentRows = Array.isArray(rows.content) ? rows.content : [];
    const warnings = [];
    const requiredTable = dbType === 'MASTER_DB' ? 'djmdContent' : 'content';
    const actualContentTable = schemaTable(schema, requiredTable);
    const contentColumns = actualContentTable ? schema.columns[actualContentTable] || [] : [];
    if (!actualContentTable) schema.missingRequired.push(requiredTable);
    if (dbType === 'MASTER_DB') {
      for (const required of ['ID', 'AnalysisDataPath']) {
        if (!contentColumns.some((column) => column.toLowerCase() === required.toLowerCase())) {
          schema.missingRequired.push(`${requiredTable}.${required}`);
        }
      }
    }
    if (schema.missingRequired.length) warnings.push(`Schema unvollständig: ${schema.missingRequired.join(', ')}.`);
    if (!Array.isArray(rows.content)) warnings.push('Tabelle djmdContent/content fehlt.');
    if (!Array.isArray(rows.cues)) warnings.push('Cue-Tabelle fehlt – Cues werden nicht importiert.');

    // Safety bound so that a pathological library cannot blow up IPC.
    if (contentRows.length > 100_000) {
      warnings.push(`Die Bibliothek enthält ${contentRows.length} Tracks; nur die ersten 100.000 werden geladen.`);
    }

    return {
      available: true,
      dbType,
      filePath,
      fileName: path.basename(filePath),
      schema,
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

// ---------------------------------------------------------------------------
// Selected master.db record → exact ANLZ sibling reader (read-only)
// ---------------------------------------------------------------------------

/** The repair/test contract deliberately accepts only the configured D: root. */
const REKORDBOX_ROOT = 'D:\\';
const ANLZ_EXTENSIONS = ['DAT', 'EXT', '2EX'];

function normalizeWinAbsolute(input) {
  let value = String(input || '').trim().replace(/\//g, '\\');
  value = value.replace(/^\\\\\?\\/, '');
  const match = value.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return null;
  const parts = [];
  for (const part of match[2].split(/\\+/)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${match[1].toUpperCase()}:\\${parts.join('\\')}`;
}

function isWithinRekordboxRoot(candidate) {
  const normalized = normalizeWinAbsolute(candidate);
  return Boolean(normalized && (normalized === REKORDBOX_ROOT || normalized.toLowerCase().startsWith(REKORDBOX_ROOT.toLowerCase())));
}

function joinDbAudioPath(folderPath, fileName) {
  const folder = typeof folderPath === 'string' ? folderPath.trim() : '';
  const file = typeof fileName === 'string' ? fileName.trim() : '';
  if (!folder) return file;
  if (!file) return folder;
  const stripped = folder.replace(/[\\/]+$/, '');
  if (stripped.toLowerCase().endsWith(file.toLowerCase())) return stripped;
  return `${stripped}${folder.includes('\\') ? '\\' : '/'}${file}`;
}

/**
 * Derive exactly one analysis file from `djmdContent.AnalysisDataPath`.
 * Device-relative values are anchored to the selected master.db sibling
 * `share` tree; absolute values must stay below D:\.  No recursive scan and
 * no filename/hash reconstruction is performed.
 */
function resolveAnalysisDataPathOnD(masterDbPath, analysisDataPath) {
  let raw = typeof analysisDataPath === 'string' ? analysisDataPath.trim() : '';
  if (!raw) return { path: null, reason: 'djmdContent.AnalysisDataPath ist leer.' };
  const fileUrl = raw.match(/^file:\/\/(localhost)?\/?/i);
  if (fileUrl) {
    raw = raw.slice(fileUrl[0].length);
    try { raw = decodeURIComponent(raw); } catch { /* preserve the DB value */ }
  }

  if (raw.split(/[\\/]+/).some((part) => part === '..')) {
    return { path: null, reason: 'AnalysisDataPath enthält unzulässige ..-Segmente.' };
  }

  let candidate;
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    candidate = raw;
  } else {
    let relative = raw.replace(/^[\\/]+/, '').replace(/^share[\\/]+/i, '');
    if (!/^PIONEER[\\/]USBANLZ[\\/]/i.test(relative)) {
      return { path: null, reason: 'AnalysisDataPath ist weder absolut noch ein PIONEER/USBANLZ-Pfad.' };
    }
    const dbAbsolute = normalizeWinAbsolute(masterDbPath);
    if (!dbAbsolute || !isWithinRekordboxRoot(dbAbsolute)) {
      return { path: null, reason: `master.db liegt nicht unter dem verbindlichen Rekordbox-Root ${REKORDBOX_ROOT}.` };
    }
    candidate = path.win32.join(path.win32.dirname(dbAbsolute), 'share', relative);
  }

  const normalized = normalizeWinAbsolute(candidate);
  if (!normalized || !isWithinRekordboxRoot(normalized)) {
    return { path: null, reason: `AnalysisDataPath verlässt den verbindlichen Rekordbox-Root ${REKORDBOX_ROOT}.` };
  }
  if (!/\.((dat)|(ext)|(2ex))$/i.test(normalized)) {
    return { path: null, reason: 'AnalysisDataPath verweist nicht auf eine DAT-, EXT- oder 2EX-Datei.' };
  }
  return { path: normalized, reason: null };
}

function siblingAnlzPath(filePath, extension) {
  const ext = String(extension).replace(/^\./, '');
  const current = path.win32.extname(filePath);
  return current ? `${filePath.slice(0, -current.length)}.${ext}` : null;
}

function readAnlzFileSnapshot(filePath, kind) {
  if (!filePath) return { kind, status: 'NOT_REQUESTED' };
  try {
    if (!isWithinRekordboxRoot(filePath)) {
      return { kind, path: filePath, status: 'READ_ERROR', reason: `Datei liegt außerhalb von ${REKORDBOX_ROOT}.` };
    }
    const details = fs.statSync(filePath);
    if (!details.isFile()) return { kind, path: filePath, status: 'NOT_FOUND', reason: 'Kein regulärer Datei-Eintrag.' };
    if (details.size > 1024 * 1024 * 1024) {
      return { kind, path: filePath, status: 'READ_ERROR', reason: 'ANLZ-Datei ist größer als 1 GB.' };
    }
    const data = fs.readFileSync(filePath);
    return {
      kind,
      path: filePath,
      status: 'FOUND',
      size: details.size,
      modifiedAt: details.mtimeMs,
      // Copy the Buffer view so the IPC payload cannot include unrelated slab bytes.
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    };
  } catch (error) {
    const code = error && error.code;
    return {
      kind,
      path: filePath,
      status: code === 'ENOENT' ? 'NOT_FOUND' : 'READ_ERROR',
      reason: error && error.message ? error.message : String(error),
    };
  }
}

/**
 * Follow one selected master.db row all the way to its immutable ANLZ sibling
 * snapshots. Each failure stage is explicit; callers must not present it as a
 * successful Rekordbox-analysis import.
 */
function readRekordboxTrackAnalysis(masterDbPath, contentId) {
  const base = {
    available: false,
    stage: 'MASTER_DB',
    root: REKORDBOX_ROOT,
    masterDbPath: String(masterDbPath || ''),
    contentId: String(contentId || ''),
    files: [],
    warnings: [],
  };
  if (!contentId && contentId !== 0) {
    return { ...base, code: 'TRACK_NOT_FOUND_IN_MASTER_DB', reason: 'Keine djmdContent.ID übergeben.' };
  }
  if (!isWithinRekordboxRoot(masterDbPath)) {
    return {
      ...base,
      code: 'MASTER_DB_NOT_FOUND',
      reason: `master.db muss unter dem verbindlichen Rekordbox-Root ${REKORDBOX_ROOT} liegen.`,
    };
  }
  if (!fs.existsSync(masterDbPath)) {
    return { ...base, code: 'MASTER_DB_NOT_FOUND', reason: 'Die angegebene master.db wurde nicht gefunden.' };
  }

  const opened = openRekordboxDb(masterDbPath);
  if (!opened.available) {
    const code = /SQLCipher-Modul/i.test(String(opened.reason))
      ? 'SQLCIPHER_UNAVAILABLE'
      : 'MASTER_DB_OPEN_FAILED';
    return { ...base, code, reason: opened.reason };
  }
  const { db, dbType } = opened;
  try {
    if (dbType !== 'MASTER_DB') {
      return {
        ...base,
        code: 'MASTER_DB_SCHEMA_INVALID',
        reason: 'Die automatische ANLZ-Kette ist für Rekordbox master.db vorgesehen.',
      };
    }
    const schema = inspectDbSchema(db);
    const table = schemaTable(schema, 'djmdContent');
    const columns = table ? schema.columns[table] || [] : [];
    const required = ['ID', 'AnalysisDataPath'];
    const missing = required.filter((wanted) => !columns.some((column) => column.toLowerCase() === wanted.toLowerCase()));
    if (!table || missing.length) {
      return {
        ...base,
        code: 'MASTER_DB_SCHEMA_INVALID',
        stage: 'SCHEMA',
        schema: { ...schema, missingRequired: missing.map((column) => `djmdContent.${column}`) },
        reason: `Unbekanntes/unvollständiges master.db-Schema: ${missing.map((column) => `djmdContent.${column}`).join(', ') || 'djmdContent fehlt'}.`,
      };
    }
    const wanted = ['ID', 'AnalysisDataPath', 'FolderPath', 'FileNameL'];
    const selected = selectKnownColumns(schema, 'djmdContent', wanted);
    const idColumn = columns.find((column) => column.toLowerCase() === 'id') || 'ID';
    const row = db.prepare(`SELECT ${selected} FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(idColumn)} = ?`).get(contentId);
    if (!row) {
      return {
        ...base,
        code: 'TRACK_NOT_FOUND_IN_MASTER_DB',
        stage: 'TRACK',
        schema,
        reason: `djmdContent.ID ${contentId} wurde nicht gefunden.`,
      };
    }
    const normalizedRow = normalizeRow(row);
    const analysisDataPath = normalizedRow.AnalysisDataPath ?? normalizedRow.analysisdatapath;
    const audioPath = joinDbAudioPath(normalizedRow.FolderPath ?? normalizedRow.folderpath, normalizedRow.FileNameL ?? normalizedRow.filenamel);
    const resolved = resolveAnalysisDataPathOnD(masterDbPath, analysisDataPath);
    if (!resolved.path) {
      return {
        ...base,
        code: 'ANALYSIS_DATA_PATH_INVALID',
        stage: 'ANALYSIS_DATA_PATH',
        schema,
        analysisDataPath: analysisDataPath == null ? '' : String(analysisDataPath),
        audioPath: audioPath || undefined,
        reason: resolved.reason,
      };
    }

    const files = ANLZ_EXTENSIONS.map((kind) => {
      const requested = siblingAnlzPath(resolved.path, kind);
      return readAnlzFileSnapshot(requested, kind);
    });
    const found = files.filter((file) => file.status === 'FOUND');
    if (!found.length) {
      return {
        ...base,
        code: 'ANLZ_FILES_NOT_FOUND',
        stage: 'ANLZ_FILES',
        schema,
        analysisDataPath: String(analysisDataPath),
        resolvedAnalysisFile: resolved.path,
        resolvedAnalysisDirectory: path.win32.dirname(resolved.path),
        audioPath: audioPath || undefined,
        files,
        reason: 'Keine der exakt abgeleiteten ANLZ-Dateien (DAT/EXT/2EX) wurde gefunden.',
      };
    }
    return {
      available: true,
      stage: 'COMPLETE',
      root: REKORDBOX_ROOT,
      masterDbPath,
      contentId: String(contentId),
      schema,
      analysisDataPath: String(analysisDataPath),
      resolvedAnalysisFile: resolved.path,
      resolvedAnalysisDirectory: path.win32.dirname(resolved.path),
      audioPath: audioPath || undefined,
      files,
      warnings: files.filter((file) => file.status !== 'FOUND' && file.status !== 'NOT_FOUND').map((file) => `${file.kind}: ${file.reason || file.status}`),
    };
  } catch (error) {
    return {
      ...base,
      code: 'MASTER_DB_OPEN_FAILED',
      stage: 'MASTER_DB',
      reason: error && error.message ? error.message : String(error),
    };
  } finally {
    db.close();
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
 * master.db / exportLibrary.db (read-only).
 */
function locateRekordboxDatabases() {
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    for (const dirName of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
      candidates.push(...findDatabaseFiles(path.join(appData, 'Pioneer', dirName)));
    }
    // Data-partition installations (documented case: rekordbox lives on `D:`,
    // e.g. `D:\Pioneer\rekordbox7\master.db`) are searched in addition.
    for (const volume of ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\']) {
      candidates.push(...findDatabaseFilesOnWindowsVolume(volume));
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

// ---------------------------------------------------------------------------
// ANLZ folder discovery + PPTH path index (SQLCipher-independent, read-only)
// ---------------------------------------------------------------------------

/**
 * Windows-volume database discovery: checks the versioned Rekordbox folders
 * (`rekordbox7` / `rekordbox6` / `rekordbox`) directly under a volume's
 * `Pioneer` directory. Covers installations on data partitions — the
 * documented real-machine case is `D:\Pioneer\rekordbox7` — including
 * databases that options.json (`db-path`) points to elsewhere. Read-only.
 */
function findDatabaseFilesOnWindowsVolume(volumeRoot) {
  const results = [];
  if (!volumeRoot || typeof volumeRoot !== 'string' || !fs.existsSync(volumeRoot)) return results;
  for (const dirName of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
    results.push(...findDatabaseFiles(path.join(volumeRoot, 'Pioneer', dirName)));
  }
  return results;
}

/** Directory names that mark a Rekordbox analysis tree (…/PIONEER/USBANLZ). */
function isAnlzFolderName(name) {
  return /^(usb)?anlz$/i.test(name);
}

/** Folders that are never descended into during discovery (audio library …). */
const NON_ANLZ_DIRS = new Set(['music', 'video', 'photos', 'node_modules', '.git', '$recycle.bin']);

/**
 * Recursively discovers ANLZ folders (…/PIONEER/USBANLZ, …/PIONEER/ANLZ)
 * under a base directory — including custom library layouts such as
 * `D:\PIONEER\Master\share\PIONEER\USBANLZ`. Read-only, depth-limited walk;
 * the audio library itself (Music/…) is never descended into.
 */
function findAnlzFolders(baseDir) {
  const found = [];
  const root =
    baseDir ||
    (process.env.APPDATA ? path.join(process.env.APPDATA, 'Pioneer') : null);
  if (!root || typeof root !== 'string' || !fs.existsSync(root)) return found;

  // Rekordbox trees are shallow; the walk stops after six levels.
  const maxDepth = 6;

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions) — stay read-only and silent
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (NON_ANLZ_DIRS.has(entry.name.toLowerCase())) continue;
      const child = path.join(dir, entry.name);
      if (isAnlzFolderName(entry.name)) {
        found.push(child);
        continue;
      }
      walk(child, depth + 1);
    }
  };

  walk(path.resolve(root), 0);
  return found;
}

/**
 * Win32 media-drive probe: real installations keep their analyses on target
 * media or data drives (documented case: `D:\PIONEER\Master\share\PIONEER\USBANLZ\…`).
 * Existing `<drive>\PIONEER` roots on the common drive letters are walked
 * read-only for ANLZ folders.
 */
function findTargetDriveAnlzFolders() {
  const found = [];
  if (process.platform !== 'win32') return found;
  for (const letter of ['C', 'D', 'E', 'F', 'G', 'H']) {
    const pioneerRoot = path.join(`${letter}:\\`, 'PIONEER');
    if (!fs.existsSync(pioneerRoot)) continue;
    found.push(...findAnlzFolders(pioneerRoot));
  }
  return found;
}

/** Normalizes a path for case-insensitive ANLZ matching (compare only). */
function normalizeAnlzPath(p) {
  let s = String(p);
  if (s.startsWith('\\\\?\\')) s = s.slice(4); // Windows long-path prefix
  return s.replace(/\\/g, '/').toLowerCase();
}

/** Decodes a PPTH path body (UTF-16BE, UTF-16LE or plain ASCII). */
function decodePpthBody(buf) {
  if (buf.length === 0) return null;
  let text;
  if (buf.length >= 2 && buf[0] === 0x00 && buf[1] !== 0x00) {
    // UTF-16BE (Rekordbox default): byte-swap into LE for Node decoding.
    const swapped = Buffer.from(buf);
    swapped.swap16();
    text = swapped.toString('utf16le');
  } else if (buf.length >= 2 && buf[0] !== 0x00 && buf[1] === 0x00) {
    text = buf.toString('utf16le');
  } else if (!buf.includes(0)) {
    text = buf.toString('latin1');
  } else {
    return null; // unreadable byte mix
  }
  const trimmed = text.replace(/\0+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/** ANLZ container file names (ANLZnnnn.DAT / .EXT). */
const ANLZ_FILE_PATTERN = /^anlz.+\.(dat|ext|2ex)$/i;

/**
 * Reads the PPTH source path from an ANLZ container header. Only the file
 * header is read (never the full payload, never a write); an optional PMAI
 * file header in front of the first section is skipped.
 */
function readPpthFromHeader(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    try {
      let offset = 0;
      const tag = Buffer.alloc(4);
      if (fs.readSync(fd, tag, 0, 4, 0) < 4) return null;
      if (tag.toString('latin1') === 'PMAI') {
        const lenBuf = Buffer.alloc(4);
        if (fs.readSync(fd, lenBuf, 0, 4, 4) < 4) return null;
        offset = lenBuf.readUInt32BE(0);
        if (offset < 4 || offset > 0x1000) return null; // implausible header
      }
      const section = Buffer.alloc(0x10);
      if (fs.readSync(fd, section, 0, 0x10, offset) < 0x10) return null;
      if (section.toString('latin1', 0, 4) !== 'PPTH') return null;
      const lenPath = section.readUInt32BE(0x0c);
      if (lenPath === 0 || lenPath > 4096) return null;
      const body = Buffer.alloc(lenPath);
      if (fs.readSync(fd, body, 0, lenPath, offset + 0x10) < lenPath) return null;
      return decodePpthBody(body);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * SQLCipher-independent ANLZ PPTH index: scans ANLZ folders for containers
 * whose PPTH header records one of the target audio paths.
 *  - pairs DAT + EXT siblings by basename,
 *  - matches targets case-insensitively (Windows drive-letter folding) and
 *    strips the `\\?\` long-path prefix (tier 1: exact path),
 *  - falls back to a tier-2 basename match only when the basename is unique
 *    in the whole index (file moved after analysis) and flags it with a
 *    verification note; ambiguous basenames never match.
 */
async function scanAnlzForPaths(targetPaths, anlzFolders) {
  const startedAt = Date.now();
  const folders = (Array.isArray(anlzFolders) ? anlzFolders : [])
    .filter((f) => typeof f === 'string' && f.trim() !== '')
    .map((f) => path.resolve(f));
  const targets = (Array.isArray(targetPaths) ? targetPaths : [])
    .filter((t) => typeof t === 'string' && t.trim() !== '')
    .map((t) => {
      const key = normalizeAnlzPath(t);
      return { original: t, key, base: path.posix.basename(key) };
    });

  // ppth key → { datPath, extPath, ex2Path }; basename → distinct ppth keys.
  const byPath = new Map();
  const basenameKeys = new Map();
  let scanned = 0;
  const ppthSample = [];

  for (const folder of folders) {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !ANLZ_FILE_PATTERN.test(entry.name)) continue;
      const filePath = path.join(folder, entry.name);
      scanned += 1;
      const ppth = readPpthFromHeader(filePath);
      if (!ppth) continue;
      if (ppthSample.length < 8) ppthSample.push(ppth);
      const key = normalizeAnlzPath(ppth);
      const record = byPath.get(key) || { datPath: null, extPath: null, ex2Path: null };
      if (/\.dat$/i.test(entry.name) && !record.datPath) record.datPath = filePath;
      if (/\.ext$/i.test(entry.name) && !record.extPath) record.extPath = filePath;
      if (/\.2ex$/i.test(entry.name) && !record.ex2Path) record.ex2Path = filePath;
      byPath.set(key, record);
      const base = path.posix.basename(key);
      if (!basenameKeys.has(base)) basenameKeys.set(base, new Set());
      basenameKeys.get(base).add(key);
    }
  }

  const matches = [];
  for (const target of targets) {
    // Tier 1: exact path (case- and separator-insensitive).
    const exact = byPath.get(target.key);
    if (exact && (exact.datPath || exact.extPath || exact.ex2Path)) {
      matches.push({
        path: target.original,
        datPath: exact.datPath,
        extPath: exact.extPath,
        ex2Path: exact.ex2Path,
        matchTier: 1,
        note: null,
      });
      continue;
    }
    // Tier 2: file moved after analysis — basename unique in the index.
    const candidates = basenameKeys.get(target.base);
    if (candidates && candidates.size === 1) {
      const [key] = candidates;
      const record = byPath.get(key);
      if (record && (record.datPath || record.extPath || record.ex2Path)) {
        matches.push({
          path: target.original,
          datPath: record.datPath,
          extPath: record.extPath,
          ex2Path: record.ex2Path,
          matchTier: 2,
          note: 'PPTH verweist auf den alten Speicherort (Basisname eindeutig) – Zuordnung bitte verifizieren.',
        });
      }
    }
    // Unknown or ambiguous → no match (honest, never throws).
  }

  return {
    scanned,
    matches,
    folders,
    elapsedMs: Date.now() - startedAt,
    ppthSample,
  };
}

module.exports = {
  getMasterDbKey,
  getOneLibraryKey,
  detectDbType,
  readRekordboxDatabase,
  readRekordboxTrackAnalysis,
  inspectDbSchema,
  resolveAnalysisDataPathOnD,
  locateRekordboxDatabases,
  findAnlzFolders,
  findTargetDriveAnlzFolders,
  scanAnlzForPaths,
  isCipherAvailable: () => getCipherModule() !== null,
};
