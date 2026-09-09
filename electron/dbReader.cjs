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

function readMasterDb(db) {
  const content = fetchRows(db, 'djmdContent', [
    'ID', 'FolderPath', 'FileNameL', 'Title', 'ArtistID', 'AlbumID', 'GenreID', 'BPM',
    'Length', 'TrackNo', 'BitRate', 'BitDepth', 'Commnt', 'FileType', 'Rating',
    'ReleaseYear', 'RemixerID', 'LabelID', 'KeyID', 'StockDate', 'ColorID',
    'DJPlayCount', 'AnalysisDataPath', 'FileSize', 'SampleRate', 'DateCreated',
    'ReleaseDate', 'ISRC', 'Subtitle', 'ComposerID',
  ].join(', '), 'ID');
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
    const rows = dbType === 'MASTER_DB' ? readMasterDb(db) : readOneLibraryDb(db);
    const contentRows = Array.isArray(rows.content) ? rows.content : [];
    const warnings = [];
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
// ANLZ PPTH index – SQLCipher-unabhängige ANLZ-Zuordnung
// ---------------------------------------------------------------------------
// Jeder Rekordbox-ANLZ-Container (ANLZnnnn.DAT / .EXT) beginnt mit einer
// PPTH-Sektion, die den exakten Audio-Dateipfad enthält, den Rekordbox bei
// der Analyse gespeichert hat. Damit lässt sich eine ANLZ-Datei
// deterministisch (nur exakter Pfadtreffer, kein Fuzzy-Matching) einem
// Track zuordnen, indem lediglich die Datei-HEADER gelesen werden –
// ohne SQLCipher und ohne master.db. Read-only: es wird nie geschrieben.

const ANLZ_HEADER_BYTES = 1024;

function findAnlzFolders(baseOverride) {
  const folders = [];
  const push = (dir) => {
    if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory() && !folders.includes(dir)) {
      folders.push(dir);
    }
  };
  const roots = [];
  if (baseOverride) {
    for (const dirName of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
      roots.push(path.join(baseOverride, dirName, 'share', 'PIONEER'));
      roots.push(path.join(baseOverride, dirName));
    }
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    for (const dirName of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
      roots.push(path.join(appData, 'Pioneer', dirName, 'share', 'PIONEER'));
    }
  } else if (process.platform === 'darwin') {
    const base = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Pioneer');
    for (const dirName of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
      roots.push(path.join(base, dirName, 'share', 'PIONEER'));
    }
  }
  for (const root of roots) {
    push(path.join(root, 'USBANLZ'));
    push(path.join(root, 'ANLZ'));
  }
  return folders;
}

function decodePpthPath(buffer, offset, byteLength) {
  if (byteLength < 2) {
    // Ungleiche Kurzfassung: rohes ASCII (exotische Exporte)
    let out = '';
    for (let i = 0; i < byteLength && offset + i < buffer.length; i++) {
      out += String.fromCharCode(buffer[offset + i]);
    }
    return out.replace(/\0+$/, '') || null;
  }
  // Rekordbox schreibt PPTH-Pfade als UTF-16BE; ältere/exportierte
  // Container nutzen UTF-16LE. Beide werden versucht – ein Treffer muss
  // wie ein echter Dateipfad aussehen (Sonderzeichen ausschließen).
  const decoders = [
    (pPos) => (buffer[pPos] << 8) | buffer[pPos + 1],
    (pPos) => (buffer[pPos + 1] << 8) | buffer[pPos],
  ];
  for (const codeOf of decoders) {
    const chars = [];
    let valid = true;
    for (let pPos = offset; pPos + 1 < offset + byteLength && pPos + 1 <= buffer.length - 1; pPos += 2) {
      const code = codeOf(pPos);
      if (code === 0) break;
      if (code > 0x024f) {
        valid = false;
        break;
      }
      chars.push(code);
    }
    if (!valid || chars.length === 0) continue;
    const s = String.fromCharCode(...chars);
    // Ein echter Pfad enthält ein Laufwerk oder file:// – sonst verwirft.
    if (/[a-zA-Z]:\\/.test(s) || s.startsWith('file://') || s.startsWith('/')) return s;
  }
  return null;
}

function readPpthFromFile(filePath) {
  let handle = null;
  try {
    handle = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(handle).size;
    const len = Math.min(ANLZ_HEADER_BYTES, size);
    const buf = Buffer.alloc(len);
    const read = fs.readSync(handle, buf, 0, len, 0);
    if (read < 0x10) return null;
    if (buf.toString('ascii', 0, 4) !== 'PPTH') return null;
    // Envelope: PPTH, u32 lenHeader (BE), u32 lenTag (BE), u32 lenPath (BE @ +0x0c)
    const lenPath = buf.readUInt32BE(0x0c);
    if (lenPath <= 0 || 0x10 + lenPath > read) return null;
    return decodePpthPath(buf, 0x10, lenPath);
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch { /* ignore */ }
    }
  }
}

function normalizeAnlzPathKey(input) {
  if (!input) return '';
  let s = String(input).trim();
  const fileMatch = s.match(/^file:\/\/(localhost)?\/?/i);
  if (fileMatch) s = s.slice(fileMatch[0].length);
  if (s.includes('%')) {
    try { s = decodeURIComponent(s); } catch { /* roh behalten */ }
  }
  s = s.replace(/\\/g, '/');
  s = s.replace(/^\/([a-zA-Z]:\/)/, '$1');
  s = s.replace(/\/{2,}/g, '/');
  return s.toLowerCase();
}

function buildAnlzPpthIndex(folders) {
  const index = new Map();
  let scanned = 0;
  for (const folder of folders) {
    let entries = [];
    try { entries = fs.readdirSync(folder); } catch { continue; }
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (!lower.startsWith('anlz')) continue;
      if (!lower.endsWith('.dat') && !lower.endsWith('.ext')) continue;
      const full = path.join(folder, name);
      scanned += 1;
      const ppth = readPpthFromFile(full);
      if (!ppth) continue;
      const key = normalizeAnlzPathKey(ppth);
      if (!key) continue;
      const isDat = lower.endsWith('.dat');
      const entry = index.get(key) || { ppth, datPath: null, extPath: null };
      if (isDat) entry.datPath = full;
      else if (!entry.extPath) entry.extPath = full;
      index.set(key, entry);
    }
  }
  return { index, scanned };
}

/**
 * Matches the given audio paths against the PPTH headers of all ANLZ
 * containers in the standard Rekordbox analysis folders. Read-only.
 * @param {string[]} targetPaths audio paths (any form; normalized internally)
 * @param {string[]} [folderOverride] explicit ANLZ folders (tests)
 */
function scanAnlzForPaths(targetPaths, folderOverride) {
  const started = Date.now();
  const folders = folderOverride || findAnlzFolders();
  const { index, scanned } = buildAnlzPpthIndex(folders);
  const wanted = new Map();
  for (const tp of Array.isArray(targetPaths) ? targetPaths : []) {
    const key = normalizeAnlzPathKey(tp);
    if (key && !wanted.has(key)) wanted.set(key, String(tp));
  }
  const matches = [];
  for (const [key, entry] of index) {
    if (!wanted.has(key)) continue;
    if (!entry.datPath && !entry.extPath) continue;
    matches.push({ path: wanted.get(key), datPath: entry.datPath, extPath: entry.extPath });
  }
  return { matches, scanned, folders, elapsedMs: Date.now() - started };
}

module.exports = {
  getMasterDbKey,
  getOneLibraryKey,
  detectDbType,
  readRekordboxDatabase,
  locateRekordboxDatabases,
  scanAnlzForPaths,
  isCipherAvailable: () => getCipherModule() !== null,
};
