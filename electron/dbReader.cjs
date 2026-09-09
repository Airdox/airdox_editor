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

// Validates that a keyed database exposes the expected content table.
// Pure probe (takes any db-like { prepare }) so it stays unit-testable
// without the native SQLCipher module.
function probeDbTables(db, dbType) {
  const need = dbType === 'MASTER_DB' ? 'djmdContent' : 'content';
  let names;
  try {
    names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row && row.name);
  } catch (error) {
    return { ok: false, reason: `Tabellenliste nicht lesbar (${error.message || error})` };
  }
  if (!names.includes(need)) {
    return { ok: false, reason: `erwartete Tabelle fehlt: ${need}` };
  }
  return { ok: true };
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
      // Key-/schema-tripwire against silent corruption: with a wrong key or
      // a changed schema the expected tables are missing – then the DB
      // counts as unreadable (loud per-track PPTH fallback) instead of
      // delivering garbage rows after a Rekordbox update.
      const probe = probeDbTables(db, dbType);
      if (!probe.ok) {
        try {
          db.close();
        } catch {
          // ignore
        }
        return {
          available: false,
          reason:
            `Integritätsprüfung fehlgeschlagen (${probe.reason}) – ggf. Key-/Schema-Drift nach Rekordbox-Update. ` +
            'Tracks fallen automatisch auf den PPTH-Fallback zurück.',
        };
      }
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

function getOptionValue(optionsDoc, name) {
  if (!optionsDoc || !Array.isArray(optionsDoc.options)) return null;
  for (const entry of optionsDoc.options) {
    if (Array.isArray(entry) && entry[0] === name && typeof entry[1] === 'string' && entry[1].trim()) {
      return entry[1];
    }
  }
  return null;
}

// options.json lives at the Pioneer ROOT level:
//   %APPDATA%\Pioneer\rekordboxAgent\storage\options.json
// (a SIBLING of the rekordbox{7,6,} version folders – NOT nested inside
// them). Copies nested inside a version folder are honored as a legacy
// fallback. Returns absolute paths of files that actually exist.
function findOptionsJsonFiles(pioneerRoot, appDirs) {
  const files = [];
  const consider = (p) => {
    if (!p) return;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile() && !files.includes(p)) files.push(p);
    } catch {
      // Unreadable – ignore.
    }
  };
  if (pioneerRoot) consider(path.join(pioneerRoot, 'rekordboxAgent', 'storage', 'options.json'));
  for (const appDir of Array.isArray(appDirs) ? appDirs : []) {
    if (!appDir) continue;
    consider(path.join(appDir, 'rekordboxAgent', 'storage', 'options.json'));
  }
  return files;
}

function candidateFromOptions(appDir) {
  // The agent folder is a sibling of the version folders
  // (Pioneer\rekordboxAgent); the nested path is legacy fallback only.
  const pioneerRoot = appDir ? path.dirname(appDir) : null;
  for (const optionsPath of findOptionsJsonFiles(pioneerRoot, appDir ? [appDir] : [])) {
    const value = getOptionValue(readJsonIfExists(optionsPath), 'db-path');
    if (value) return value;
  }
  return null;
}

// options.json "app_ver" (e.g. 7.2.16): captured as diagnostic context with
// every database read, so a future key/schema drift can be attributed to the
// Rekordbox version that wrote the library.
function appVerFromOptions(appDir) {
  const pioneerRoot = appDir ? path.dirname(appDir) : null;
  for (const optionsPath of findOptionsJsonFiles(pioneerRoot, appDir ? [appDir] : [])) {
    const value = getOptionValue(readJsonIfExists(optionsPath), 'app_ver');
    if (value) return value;
  }
  return null;
}

// Custom analysis location of a moved library
// (Rekordbox: Erweitert → Datenbank → Datenbankverwaltung):
// options.json "analysis-data-root-path", e.g. D:\PIONEER\Master\share.
function analysisRootsFromOptions(pioneerRoot, appDirs) {
  const roots = [];
  for (const optionsPath of findOptionsJsonFiles(pioneerRoot, appDirs)) {
    const value = getOptionValue(readJsonIfExists(optionsPath), 'analysis-data-root-path');
    if (value && !roots.includes(value)) roots.push(value);
  }
  return roots;
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
      if (kind) results.push({ path: p, kind, label: `${base} (aus rekordboxAgent/options.json)`, appVer: appVerFromOptions(appDir) });
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

const ANLZ_HEADER_BYTES = 4096;

// Rekordbox stores ANLZ containers in NESTED subdirectories below USBANLZ/
// (e.g. USBANLZ/P016/0000875E/ANLZ0000.DAT locally and on export media –
// rekordcrate documents "nested subdirectories", and AnalysisDataPath values
// such as /PIONEER/USBANLZ/0e8/<uuid>/ANLZ0000.DAT confirm it). A top-level
// only read therefore finds 0 files on real machines. The index walk below
// recurses with hard safety bounds and still reads headers only
// (read-only, max 1 KiB per file, symlinks skipped to avoid cycles).
const ANLZ_SCAN_MAX_DEPTH = 8;
const ANLZ_SCAN_MAX_FILES = 100_000;

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

  // Robust fallback: discover any *ANLZ* folder under the Pioneer root
  // (rekordbox6/7/custom layouts differ), limited depth, read-only.
  const pioneerRoot = baseOverride
    ? baseOverride
    : (process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'Pioneer')
        : path.join(process.env.HOME || '', 'Library', 'Application Support', 'Pioneer'));
  if (!baseOverride && fs.existsSync(pioneerRoot)) {
    const found = [];
    const walk = (dir, depth) => {
      if (depth > 4 || found.length >= 8) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const lower = ent.name.toLowerCase();
        if (lower === 'usbanlz' || lower === 'anlz') {
          found.push(path.join(dir, ent.name));
        } else if (lower.startsWith('rekordbox') || lower === 'pioneer' || lower === 'share') {
          walk(path.join(dir, ent.name), depth + 1);
        }
      }
    };
    walk(pioneerRoot, 0);
    for (const f of found) push(f);
  }
  // Moved libraries (Rekordbox: Erweitert → Datenbank → Datenbankverwaltung):
  // options.json records the custom analysis root ("analysis-data-root-path",
  // e.g. D:\PIONEER\Master\share). Its PIONEER\USBANLZ subtree holds the real
  // containers – without it a moved library stays invisible to the scan.
  const optionAppDirs = pioneerRoot
    ? ['rekordbox7', 'rekordbox6', 'rekordbox'].map((d) => path.join(pioneerRoot, d))
    : [];
  for (const root of analysisRootsFromOptions(pioneerRoot, optionAppDirs)) {
    push(path.join(root, 'PIONEER', 'USBANLZ'));
    push(path.join(root, 'PIONEER', 'ANLZ'));
  }
  return folders;
}

// A decoded string only counts as an ANLZ path when it looks like one:
// Windows drive (either slash direction), file:// URL, or /Drive/... path.
function looksLikeAudioPath(s) {
  if (!s || s.length < 4 || s.length > 4096) return false;
  if (/[a-zA-Z]:[\\/]/.test(s)) return true;
  if (s.startsWith('file://')) return true;
  if (s.startsWith('/')) return true;
  return false;
}

// Scans a buffer window for a plausible path string in one encoding.
// encoding: 'be' (UTF-16BE), 'le' (UTF-16LE), 'ascii' (Latin-1).
// Stops at the first NUL; leading header bytes (length prefixes, padding)
// before the path marker are trimmed.
function scanWindowForPath(buffer, start, end, encoding) {
  const chars = [];
  if (encoding === 'ascii') {
    for (let pPos = start; pPos < end && pPos < buffer.length; pPos++) {
      const byte = buffer[pPos];
      if (byte === 0) break;
      if (byte < 0x20 || (byte > 0x7e && byte < 0xa0)) return null;
      chars.push(byte);
    }
  } else {
    const highFirst = encoding === 'be';
    for (let pPos = start; pPos + 1 < end && pPos + 1 < buffer.length; pPos += 2) {
      const code = highFirst ? (buffer[pPos] << 8) | buffer[pPos + 1] : (buffer[pPos + 1] << 8) | buffer[pPos];
      if (code === 0) break;
      if (code === 0xfeff && chars.length === 0) continue; // BOM
      if (code < 0x20 || code > 0x024f) return null;
      chars.push(code);
    }
  }
  if (chars.length === 0) return null;
  const s = String.fromCharCode(...chars);
  const marker = s.search(/[a-zA-Z]:[\\/]|file:\/\/|\/(?=[A-Za-z])/);
  if (marker < 0) return null;
  const trimmed = s.slice(marker).replace(/[\s ]+$/, '');
  return looksLikeAudioPath(trimmed) ? trimmed : null;
}

// Decodes the PPTH path from a tag-content window. The content layout
// varies (optional length prefix, BOM, padding), so several start offsets
// and all three encodings are attempted – the first plausible path wins.
function decodePpthContent(buffer, contentStart, contentEnd) {
  const starts = [contentStart, contentStart + 1, contentStart + 2, contentStart + 4];
  const encodings = ['be', 'le', 'ascii'];
  for (const start of starts) {
    if (start < 0 || start >= contentEnd || start >= buffer.length) continue;
    for (const encoding of encodings) {
      const hit = scanWindowForPath(buffer, start, contentEnd, encoding);
      if (hit) return hit;
    }
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
    // Legacy layout: PPTH envelope directly at offset 0.
    if (buf.toString('ascii', 0, 4) === 'PPTH') {
      const lenPath = buf.readUInt32BE(0x0c);
      if (lenPath > 0 && 0x10 + lenPath <= read) {
        const legacy = decodePpthContent(buf, 0x10, 0x10 + lenPath);
        if (legacy) return legacy;
      }
    }
    // Genuine layout: PMAI container with tagged sections – find PPTH.
    const tagPos = buf.indexOf('PPTH', 0, 'ascii');
    if (tagPos < 0 || tagPos + 12 > read) return null;
    const lenHeader = buf.readUInt32BE(tagPos + 4);
    const lenTag = buf.readUInt32BE(tagPos + 8);
    let contentStart = tagPos + 12;
    let contentEnd = Math.min(read, tagPos + 12 + 2048);
    if (lenHeader >= 12 && lenHeader <= 64 && lenTag > lenHeader && lenTag - lenHeader <= 4096) {
      contentStart = tagPos + lenHeader;
      contentEnd = Math.min(read, tagPos + lenTag);
    }
    if (contentEnd <= contentStart) return null;
    return decodePpthContent(buf, contentStart, contentEnd);
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
  // Windows long-path prefix (\\?\C:\...) -> plain drive path
  s = s.replace(/^\\\\\?\\([a-zA-Z]:)/, '$1').replace(/^\\\?\\([a-zA-Z]:)/, '$1');
  if (s.includes('%')) {
    try { s = decodeURIComponent(s); } catch { /* roh behalten */ }
  }
  s = s.replace(/\\/g, '/');
  s = s.replace(/^\/([a-zA-Z]:\/)/, '$1');
  s = s.replace(/\/{2,}/g, '/');
  return s.toLowerCase();
}

// Export-device analysis: when the audio lives on a Rekordbox export drive
// (e.g. file://localhost/G:/Music/...), its analysis usually sits on the
// SAME drive at <drive>:\PIONEER\USBANLZ (device-library layout) instead of
// the local %APPDATA% tree. These candidates are derived from the scan
// targets (read-only existence checks only, same recursion bounds apply).
function extractAudioDriveLetters(targetPaths) {
  const letters = [];
  const seen = new Set();
  for (const tp of Array.isArray(targetPaths) ? targetPaths : []) {
    if (typeof tp !== 'string') continue;
    // Strip a Windows long-path prefix (\\?\G:\...) before matching.
    const s = tp.replace(/^\\\\\?\\/, '');
    const m = s.match(/^(?:file:\/\/[^/]*\/)?([a-zA-Z]):[\\/]/);
    if (!m) continue;
    const letter = m[1].toUpperCase();
    if (seen.has(letter)) continue;
    seen.add(letter);
    letters.push(letter);
  }
  return letters;
}

function findAudioDriveAnlzFolders(targetPaths, toDriveRoot) {
  const folders = [];
  for (const letter of extractAudioDriveLetters(targetPaths)) {
    const driveRoot = toDriveRoot ? toDriveRoot(letter) : `${letter}:\\`;
    if (!driveRoot) continue;
    for (const sub of [path.join('PIONEER', 'USBANLZ'), path.join('PIONEER', 'ANLZ')]) {
      const dir = path.join(driveRoot, sub);
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory() && !folders.includes(dir)) {
          folders.push(dir);
        }
      } catch {
        // Unreadable drive (ejected media, permissions) – skip silently.
      }
    }
  }
  return folders;
}

// Two-phase PPTH index: collect (readdir-only, fast) then index (header
// reads, chunkable). Both phases share bounds and filters, so sync and
// async scans always agree.
function collectAnlzFiles(folders) {
  const files = [];
  let truncated = false;
  const walk = (dir, depth) => {
    if (truncated) return;
    if (depth > ANLZ_SCAN_MAX_DEPTH) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (truncated) return;
      const name = ent.name;
      if (!name || name.startsWith('.')) continue;
      // Never follow symlinks: analysis trees must not escape into cycles.
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const lower = name.toLowerCase();
      if (!lower.startsWith('anlz')) continue;
      if (!lower.endsWith('.dat') && !lower.endsWith('.ext')) continue;
      if (files.length >= ANLZ_SCAN_MAX_FILES) {
        truncated = true;
        return;
      }
      files.push({ full, isDat: lower.endsWith('.dat') });
    }
  };
  for (const folder of folders) {
    if (truncated) break;
    walk(folder, 0);
  }
  return { files, truncated };
}

// Indexes one collected file. DAT and EXT siblings share the same analysis,
// so an EXT with a collected DAT sibling attaches without re-reading
// (halves header reads on real libraries); an EXT without a readable DAT
// sibling is read normally. state: { index, datPathToKey, extracted }.
function indexCollectedFile(state, file, datSiblings) {
  const { full, isDat } = file;
  if (!isDat) {
    const siblingKey = full.toLowerCase().replace(/\.ext$/, '.dat');
    if (datSiblings.has(siblingKey)) {
      const key = state.datPathToKey.get(siblingKey);
      if (key) {
        const entry = state.index.get(key);
        if (entry && !entry.extPath) entry.extPath = full;
        return;
      }
      // DAT sibling collected but unreadable (no PPTH) – fall through and
      // try the EXT itself so EXT-only analyses still resolve.
    }
  }
  const ppth = readPpthFromFile(full);
  if (!ppth) return;
  const key = normalizeAnlzPathKey(ppth);
  if (!key) return;
  state.extracted += 1;
  const entry = state.index.get(key) || { ppth, datPath: null, extPath: null };
  if (isDat) {
    entry.datPath = full;
    state.datPathToKey.set(full.toLowerCase(), key);
  } else if (!entry.extPath) {
    entry.extPath = full;
  }
  state.index.set(key, entry);
}

function createAnlzIndexState() {
  return { index: new Map(), datPathToKey: new Map(), extracted: 0 };
}

// Tier 1: exact normalized path hit (PPTH == audio path).
// Tier 2: basename-only hit, valid only when the basename is unique across
// the whole index (moved/renamed file – user must verify).
function matchAnlzTargets(index, targetPaths) {
  const wanted = new Map();
  for (const tp of Array.isArray(targetPaths) ? targetPaths : []) {
    const key = normalizeAnlzPathKey(tp);
    if (key && !wanted.has(key)) wanted.set(key, String(tp));
  }
  const matches = [];
  const matchedKeys = new Set();
  for (const [key, entry] of index) {
    if (!wanted.has(key)) continue;
    if (!entry.datPath && !entry.extPath) continue;
    matches.push({ path: wanted.get(key), datPath: entry.datPath, extPath: entry.extPath, matchTier: 1 });
    matchedKeys.add(key);
  }
  if (matchedKeys.size < wanted.size) {
    const byBasename = new Map();
    for (const [key, entry] of index) {
      if (!entry.datPath && !entry.extPath) continue;
      const bn = key.split('/').pop();
      if (!byBasename.has(bn)) byBasename.set(bn, []);
      byBasename.get(bn).push(key);
    }
    for (const [key, original] of wanted) {
      if (matchedKeys.has(key)) continue;
      const bn = key.split('/').pop();
      const candidates = byBasename.get(bn);
      if (!candidates || candidates.length !== 1) continue;
      const entry = index.get(candidates[0]);
      matches.push({
        path: original,
        datPath: entry.datPath,
        extPath: entry.extPath,
        matchTier: 2,
        note: 'ANLZ per Dateiname zugeordnet (PPTH-Pfad weicht ab – vermutlich verschobene Datei). Zuordnung pruefen.',
      });
      matchedKeys.add(key);
    }
  }
  return { matches, wantedCount: wanted.size, matchedCount: matchedKeys.size };
}

// Diagnostics: first PPTH paths (console/log), without sending the full index.
function ppthSampleFromIndex(index, limit = 3) {
  const sample = [];
  for (const entry of index.values()) {
    sample.push(entry.ppth);
    if (sample.length >= limit) break;
  }
  return sample;
}

function resolveScanFolders(targetPaths, folderOverride, driveRootResolver) {
  if (folderOverride) return folderOverride;
  return [
    ...findAnlzFolders(),
    ...findAudioDriveAnlzFolders(targetPaths, driveRootResolver),
  ];
}

/**
 * Matches the given audio paths against the PPTH headers of all ANLZ
 * containers in the standard Rekordbox analysis folders. Read-only.
 * The folders are searched RECURSIVELY because Rekordbox keeps ANLZ
 * containers in nested subdirectories below USBANLZ/ (flat top-level
 * layouts keep working as before).
 * In addition to the local %APPDATA% tree, the audio drives referenced by
 * the targets are checked for export-device analysis folders
 * (<drive>:\PIONEER\USBANLZ) – tracks on export media are analyzed there.
 * @param {string[]} targetPaths audio paths (any form; normalized internally)
 * @param {string[]} [folderOverride] explicit ANLZ folders (tests)
 * @param {Function} [driveRootResolver] maps a drive letter to a directory (tests)
 */
function scanAnlzForPaths(targetPaths, folderOverride, driveRootResolver) {
  const started = Date.now();
  const folders = resolveScanFolders(targetPaths, folderOverride, driveRootResolver);
  const collectStarted = Date.now();
  const { files, truncated } = collectAnlzFiles(folders);
  const collectMs = Date.now() - collectStarted;
  const state = createAnlzIndexState();
  const datSiblings = new Set(files.filter((f) => f.isDat).map((f) => f.full.toLowerCase()));
  // DATs first so EXT siblings attach without re-reading.
  const ordered = [...files.filter((f) => f.isDat), ...files.filter((f) => !f.isDat)];
  for (const file of ordered) indexCollectedFile(state, file, datSiblings);
  const { matches } = matchAnlzTargets(state.index, targetPaths);
  return {
    matches,
    scanned: files.length,
    extracted: state.extracted,
    folders,
    elapsedMs: Date.now() - started,
    collectMs,
    ppthSample: ppthSampleFromIndex(state.index),
    truncated,
  };
}

/**
 * Async variant: same result, but yields to the event loop while indexing
 * so a 20k-file library no longer freezes the app. onProgress receives
 * { scanned, total } throttled (~150 ms) plus a final event.
 */
async function scanAnlzForPathsAsync(targetPaths, folderOverride, driveRootResolver, onProgress) {
  const started = Date.now();
  const folders = resolveScanFolders(targetPaths, folderOverride, driveRootResolver);
  const collectStarted = Date.now();
  const { files, truncated } = collectAnlzFiles(folders);
  const collectMs = Date.now() - collectStarted;
  const state = createAnlzIndexState();
  const datSiblings = new Set(files.filter((f) => f.isDat).map((f) => f.full.toLowerCase()));
  const ordered = [...files.filter((f) => f.isDat), ...files.filter((f) => !f.isDat)];
  const total = ordered.length;
  let lastEmit = 0;
  const emit = (scanned, force = false) => {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (!force && now - lastEmit < 150 && scanned < total) return;
    lastEmit = now;
    try {
      onProgress({ scanned, total });
    } catch {
      // Progress listener failed – the scan continues regardless.
    }
  };
  emit(0, total === 0);
  for (let i = 0; i < ordered.length; i++) {
    indexCollectedFile(state, ordered[i], datSiblings);
    if ((i + 1) % 50 === 0 || i + 1 === total) {
      emit(i + 1);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  emit(total, true);
  const { matches } = matchAnlzTargets(state.index, targetPaths);
  return {
    matches,
    scanned: files.length,
    extracted: state.extracted,
    folders,
    elapsedMs: Date.now() - started,
    collectMs,
    ppthSample: ppthSampleFromIndex(state.index),
    truncated,
  };
}

module.exports = {
  getMasterDbKey,
  getOneLibraryKey,
  detectDbType,
  readRekordboxDatabase,
  locateRekordboxDatabases,
  scanAnlzForPaths,
  scanAnlzForPathsAsync,
  collectAnlzFiles,
  isCipherAvailable: () => getCipherModule() !== null,
  // Read-only discovery helpers (exported as test seams):
  getOptionValue,
  findOptionsJsonFiles,
  candidateFromOptions,
  findAnlzFolders,
  probeDbTables,
  appVerFromOptions,
};
