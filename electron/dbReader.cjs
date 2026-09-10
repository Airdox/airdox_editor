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
      // NOTE: `available: true` is part of the contract. Both callers
      // (readRekordboxDatabase and scripts/masterdb-probe.mjs) branch on it;
      // without the flag a successfully decrypted database was reported as
      // "not available" and the handle leaked (never closed).
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
 * Bounded discovery for installations whose Rekordbox library/database is on
 * another Windows partition. The normal AppData/options.json path remains the
 * first choice; D: is included because users commonly place the library on a
 * dedicated data volume. Only folders with Rekordbox/Pioneer-like names are
 * traversed and database filenames are matched exactly.
 */
function findDatabaseFilesOnWindowsVolume(volumeRoot) {
  const results = [];
  const seen = new Set();
  const allowedDirectory = (name) => /^(pioneer|rekordbox|rekordbox[0-9]+|database|databases|library|share|storage|export)$/i.test(name);
  const visit = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /^(master|exportLibrary)\.db$/i.test(entry.name)) {
        const resolved = path.resolve(full);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        const kind = entry.name.toLowerCase() === 'exportlibrary.db' ? 'ONE_LIBRARY' : 'MASTER_DB';
        results.push({ path: resolved, kind, label: `${entry.name} (Datenpartition)` });
      } else if (entry.isDirectory() && allowedDirectory(entry.name)) {
        visit(full, depth + 1);
      }
    }
  };
  if (volumeRoot && fs.existsSync(volumeRoot)) visit(volumeRoot, 0);
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
    const pioneerRoot = path.join(appData, 'Pioneer');
    // Rekordbox keeps the library location in the global
    // Pioneer/rekordboxAgent/options.json even when master.db itself lives on
    // another partition (for example D:). Read that pointer before scanning
    // the conventional per-version folders.
    candidates.push(...findDatabaseFiles(pioneerRoot));
    for (const dirName of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
      candidates.push(...findDatabaseFiles(path.join(pioneerRoot, dirName)));
    }
  } else if (process.platform === 'darwin') {
    const base = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Pioneer');
    for (const dirName of ['rekordbox7', 'rekordbox6', 'rekordbox']) {
      candidates.push(...findDatabaseFiles(path.join(base, dirName)));
    }
  }

  if (process.platform === 'win32') {
    const configuredRoot = process.env.AIRDOX_REKORDBOX_ROOT;
    const volumeRoots = [
      configuredRoot,
      'D:\\Pioneer', 'D:\\rekordbox', 'D:\\Rekordbox',
      'D:\\rekordbox7', 'D:\\rekordbox6',
    ].filter(Boolean);
    for (const root of volumeRoots) candidates.push(...findDatabaseFilesOnWindowsVolume(root));
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

/**
 * Bounded, read-only discovery of *ANLZ* folders under a root directory.
 * Only Rekordbox-structural folder names are descended into (rekordbox*,
 * pioneer, share, master, datasources, databases), so a custom library root
 * like D:\PIONEER\Master\share\PIONEER\USBANLZ is found without ever
 * walking the audio library. Max depth 4, max 8 folders per root.
 */
function walkAnlzFolders(root, maxDepth = 4, maxFound = 8) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length >= maxFound) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const lower = ent.name.toLowerCase();
      if (lower === 'usbanlz' || lower === 'anlz') {
        found.push(path.join(dir, ent.name));
      } else if (lower.startsWith('rekordbox') || lower === 'pioneer' || lower === 'share'
        || lower === 'master' || lower === 'datasources' || lower === 'databases') {
        walk(path.join(dir, ent.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

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
    // The user's Rekordbox library and analysis data live on D:. Do not
    // inspect AppData, the audio volume, or any other partition here: source
    // selection must be deterministic and privacy-friendly.
    const dRoots = [
      'D:\\Pioneer', 'D:\\rekordbox', 'D:\\Rekordbox',
      'D:\\rekordbox7', 'D:\\rekordbox6',
    ];
    for (const base of dRoots) {
      for (const dirName of ['', 'rekordbox7', 'rekordbox6', 'rekordbox']) {
        roots.push(dirName ? path.join(base, dirName, 'share', 'PIONEER') : path.join(base, 'share', 'PIONEER'));
      }
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

  // Robust fallback: discover any *ANLZ* folder under every known Pioneer
  // root (rekordbox6/7/custom layouts differ — the real collection on the
  // user's machine lives in a custom layout such as
  // D:\PIONEER\Master\share\PIONEER\USBANLZ). Bounded depth, read-only:
  // only folders named like Pioneer/Rekordbox/Share/Master/DataSources are
  // descended into, never the audio library.
  const fallbackRoots = [];
  if (baseOverride) {
    fallbackRoots.push(baseOverride);
  } else if (process.platform === 'win32') {
    fallbackRoots.push(path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'Pioneer'));
    for (const base of ['D:\\Pioneer', 'D:\\rekordbox', 'D:\\Rekordbox', 'D:\\rekordbox7', 'D:\\rekordbox6']) {
      fallbackRoots.push(base);
    }
  } else {
    fallbackRoots.push(path.join(process.env.HOME || '', 'Library', 'Application Support', 'Pioneer'));
  }
  for (const root of fallbackRoots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const f of walkAnlzFolders(root)) push(f);
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
    let ppthOffset = 0;
    if (buf.toString('ascii', 0, 4) === 'PMAI') {
      const headerLength = buf.readUInt32BE(4);
      if (headerLength < 12 || headerLength + 0x10 > read) return null;
      ppthOffset = headerLength;
    }
    if (buf.toString('ascii', ppthOffset, ppthOffset + 4) !== 'PPTH') return null;
    const lenPath = buf.readUInt32BE(ppthOffset + 0x0c);
    if (lenPath <= 0 || ppthOffset + 0x10 + lenPath > read) return null;
    return decodePpthPath(buf, ppthOffset + 0x10, lenPath);
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch { /* ignore */ }
    }
  }
}

async function readPpthFromFileAsync(filePath) {
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    const size = stat.size;
    const len = Math.min(ANLZ_HEADER_BYTES, size);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, 0);
    if (bytesRead < 0x10) return null;
    let ppthOffset = 0;
    if (buf.toString('ascii', 0, 4) === 'PMAI') {
      const headerLength = buf.readUInt32BE(4);
      if (headerLength < 12 || headerLength + 0x10 > bytesRead) return null;
      ppthOffset = headerLength;
    }
    if (buf.toString('ascii', ppthOffset, ppthOffset + 4) !== 'PPTH') return null;
    const lenPath = buf.readUInt32BE(ppthOffset + 0x0c);
    if (lenPath <= 0 || ppthOffset + 0x10 + lenPath > bytesRead) return null;
    return decodePpthPath(buf, ppthOffset + 0x10, lenPath);
  } catch {
    return null;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
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

/**
 * Async, non-blocking ANLZ PPTH index builder.
 * Reads only 1 KB headers per file, yields to event loop every 50 files
 * so the Electron main process stays responsive even with 20k+ containers.
 * Every step is logged via optional onProgress callback (every 500 files).
 */
async function buildAnlzPpthIndex(folders, onProgress) {
  const index = new Map();
  let scanned = 0;
  let processedDirs = 0;
  const maxDepth = 6;
  const maxFiles = 250000;

  const visit = async (folder, depth) => {
    if (depth > maxDepth || scanned >= maxFiles) return;
    let entries = [];
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    processedDirs++;
    if (processedDirs % 20 === 0) {
      await new Promise((r) => setImmediate(r));
    }
    for (const entryInfo of entries) {
      if (scanned >= maxFiles) return;
      const full = path.join(folder, entryInfo.name);
      if (entryInfo.isDirectory()) {
        await visit(full, depth + 1);
        continue;
      }
      const lower = entryInfo.name.toLowerCase();
      if (!lower.startsWith('anlz')) continue;
      if (!lower.endsWith('.dat') && !lower.endsWith('.ext')) continue;
      scanned += 1;
      if (onProgress && scanned % 500 === 0) {
        try { onProgress(scanned, index.size); } catch {}
      }
      if (scanned % 50 === 0) {
        await new Promise((r) => setImmediate(r));
      }
      let ppth = null;
      try {
        ppth = await readPpthFromFileAsync(full);
      } catch {
        ppth = null;
      }
      if (!ppth) continue;
      const key = normalizeAnlzPathKey(ppth);
      if (!key) continue;
      const isDat = lower.endsWith('.dat');
      const existing = index.get(key) || { ppth, datPath: null, extPath: null };
      if (isDat) existing.datPath = full;
      else if (!existing.extPath) existing.extPath = full;
      index.set(key, existing);
    }
  };

  for (const folder of folders) {
    await visit(folder, 0);
  }
  return { index, scanned };
}

/**
 * Matches the given audio paths against the PPTH headers of all ANLZ
 * containers in the standard Rekordbox analysis folders. Read-only.
 * @param {string[]} targetPaths audio paths (any form; normalized internally)
 * @param {string[]} [folderOverride] explicit ANLZ folders (tests)
 */
function findTargetDriveAnlzFolders(targetPaths) {
  const folders = [];
  const seen = new Set();
  const push = (dir) => {
    if (seen.has(dir)) return;
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        seen.add(dir);
        folders.push(dir);
      }
    } catch { /* inaccessible removable drive */ }
  };
  // Analysis lookup is intentionally restricted to D: on Windows.
  if (process.platform === 'win32') {
    for (const candidate of [
      'D:\\Pioneer\\USBANLZ', 'D:\\Pioneer\\ANLZ',
      'D:\\rekordbox\\share\\PIONEER\\USBANLZ',
      'D:\\Rekordbox\\share\\PIONEER\\USBANLZ',
    ]) push(candidate);
    return folders;
  }
  for (const raw of Array.isArray(targetPaths) ? targetPaths : []) {
    let value = String(raw || '').trim();
    try { value = decodeURIComponent(value); } catch { /* keep raw */ }
    value = value.replace(/^file:\/\/(localhost)?\/?/i, '');
    const drive = value.match(/^([a-zA-Z]):[\\/]/);
    if (!drive) continue;
    const root = `${drive[1].toUpperCase()}:\\`;
    // Rekordbox USB exports commonly keep analysis beside PIONEER on the
    // removable drive. Include the local-library layouts too, but never scan
    // the whole drive.
    for (const candidate of [
      path.join(root, 'PIONEER', 'USBANLZ'),
      path.join(root, 'PIONEER', 'ANLZ'),
      path.join(root, 'PIONEER', 'share', 'PIONEER', 'USBANLZ'),
    ]) push(candidate);
  }
  return folders;
}

async function scanAnlzForPaths(targetPaths, folderOverride, onProgress) {
  const started = Date.now();
  const folders = folderOverride || [
    ...findAnlzFolders(),
    ...findTargetDriveAnlzFolders(targetPaths),
  ];
  const { index, scanned } = await buildAnlzPpthIndex(folders, onProgress);
  const wanted = new Map();
  for (const tp of Array.isArray(targetPaths) ? targetPaths : []) {
    const key = normalizeAnlzPathKey(tp);
    if (key && !wanted.has(key)) wanted.set(key, String(tp));
  }
  const matches = [];
  const matchedKeys = new Set();

  // Tier 1: exakter normalisierter Pfadtrenffer (PPTH == Audio-Pfad).
  for (const [key, entry] of index) {
    if (!wanted.has(key)) continue;
    if (!entry.datPath && !entry.extPath) continue;
    matches.push({
      path: wanted.get(key),
      datPath: entry.datPath,
      extPath: entry.extPath,
      matchTier: 1,
    });
    matchedKeys.add(key);
  }

  // Tier 2: Audio-Datei wurde nach der Analyse verschoben/umbenannt?
  // Dann stimmt nur der Dateiname ueberein. Ein Treffer gilt nur, wenn der
  // Basename in der gesamten ANLZ-Index eindeutig ist (ansonsten ambig).
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

  // Diagnostik: erste PPTH-Pfade (Console/Log), ohne Vollindex zu senden.
  const ppthSample = [];
  for (const entry of index.values()) {
    ppthSample.push(entry.ppth);
    if (ppthSample.length >= 3) break;
  }

  return { matches, scanned, folders, elapsedMs: Date.now() - started, ppthSample };
}

module.exports = {
  getMasterDbKey,
  getOneLibraryKey,
  detectDbType,
  // Read-only ANLZ folder discovery (bounded walk under known Pioneer roots).
  // Exported for tests + diagnostics; the main process uses it internally.
  findAnlzFolders,
  walkAnlzFolders,
  // Low-level, read-only handle (SQLCipher key + SQLite readonly). Exported for
  // the diagnostics CLI (scripts/masterdb-probe.mjs) so the key derivation has
  // exactly one implementation. Callers MUST close the returned `db`.
  openRekordboxDb,
  readRekordboxDatabase,
  locateRekordboxDatabases,
  scanAnlzForPaths,
  readPpthFromFile,
  isCipherAvailable: () => getCipherModule() !== null,
};
