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

/**
 * Klassifiziert DB-Fehler für verständliche Nutzer-Meldungen:
 *  - LOCKED: Rekordbox läuft und hält die Schreib-Sperre (SQLITE_BUSY) —
 *    Standard-Behandelung laut SQLite-Best-Practice: read-only öffnen
 *    (wirft nie eine Schreib-Sperre) + busy_timeout; trotzdem gesperrt →
 *    Nutzer soll Rekordbox schließen.
 *  - ENCRYPTED_OR_CORRUPT: falsche Datei / falscher Key.
 *  - UNREADABLE: Datei nicht vorhanden / nicht lesbar.
 */
function classifyDbOpenError(error) {
  const message = String((error && error.message) || error || '');
  if (/database is locked|SQLITE_BUSY|database file is locked/i.test(message)) return 'LOCKED';
  if (/file is not a database|wrong key|not a database|decrypt/i.test(message)) return 'ENCRYPTED_OR_CORRUPT';
  if (/cannot open|unable to open|no such file|EACCES|EPERM/i.test(message)) return 'UNREADABLE';
  return 'UNKNOWN';
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
    // Read-only (wirft nie eine Schreib-Sperre) + timeout: bei Sperren durch
    // laufendes Rekordbox wartet SQLite bis zu 10 s statt sofort zu scheitern
    // (SQLite-Best-Practice: busy-Timeout auf jeder Verbindung).
    const db = new Database(filePath, { readonly: true, fileMustExist: true, timeout: 10000 });
    try {
      db.pragma('cipher = sqlcipher');
      db.pragma('legacy = 4');
      db.pragma(`key = '${key}'`);
      // Force decryption by touching the schema.
      db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
      // Zweite Verteidigungsebene zur Read-Only-Garantie: selbst ein
      // versehentliches Schreiben scheitert auf Engine-Ebene.
      db.pragma('query_only = ON');
      return { db, dbType };
    } catch (openError) {
      try {
        db.close();
      } catch {
        // ignore
      }
      const kind = classifyDbOpenError(openError);
      const detail = openError.message || openError;
      if (kind === 'LOCKED') {
        return {
          available: false,
          reason:
            'Die Datenbank ist gesperrt — Rekordbox läuft vermutlich und hält die Sperre. ' +
            'Bitte Rekordbox schließen und die Datenbank-Suche erneut ausführen. (' + detail + ')',
        };
      }
      return {
        available: false,
        reason:
          'Die Datenbank konnte nicht entschlüsselt werden. Bitte prüfe, ob die Datei eine ' +
          `${dbType === 'MASTER_DB' ? 'Rekordbox-6/7-master.db' : 'OneLibrary-exportLibrary.db'} ist. (${detail})`,
      };
    }
  } catch (error) {
    const kind = classifyDbOpenError(error);
    const detail = error.message || error;
    if (kind === 'LOCKED') {
      return {
        available: false,
        reason:
          'Die Datenbank ist gesperrt — Rekordbox läuft vermutlich und hält die Sperre. ' +
          'Bitte Rekordbox schließen und die Datenbank-Suche erneut ausführen. (' + detail + ')',
      };
    }
    return { available: false, reason: `Die Datenbankdatei kann nicht geöffnet werden: ${detail}` };
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
  // Rekordbox 7 benennt den Datenordner frei (hier: „Master“) — deshalb
  // auch master/database/library/share/storage/export, nie mehr.
  const allowedDirectory = (name) => /^(pioneer|rekordbox|rekordbox[0-9]+|master|database|databases|library|share|storage|export)$/i.test(name);
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
 * Suche nach der Rekordbox-Datenbank (master.db / exportLibrary.db).
 *
 * Ständige Nutzer-Vorgabe: Die Rekordbox-Datenbank liegt auf Partition D:.
 * Auf Windows wird daher NUR D: durchsucht — AppData (C:) und alle anderen
 * Laufwerke werden bewusst NICHT angefasst, damit die Quellenauswahl
 * deterministisch bleibt. Ein abweichender Root ist nur als explizite,
 * dokumentierte Ausnahme über AIRDOX_REKORDBOX_ROOT möglich (Default: aus).
 */
function getDatabaseSearchRoots(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [
      'D:\\Pioneer', 'D:\\rekordbox', 'D:\\Rekordbox',
      'D:\\rekordbox7', 'D:\\rekordbox6',
    ];
    const override = (env.AIRDOX_REKORDBOX_ROOT || '').trim();
    if (override) roots.unshift(override);
    return roots;
  }
  if (platform === 'darwin') {
    const base = path.join(env.HOME || '', 'Library', 'Application Support', 'Pioneer');
    return ['rekordbox7', 'rekordbox6', 'rekordbox'].map((dirName) => path.join(base, dirName));
  }
  return [];
}

/**
 * Ein Rekordbox-DB-Pointer (options.json db-path / XML LOCATION) ist nur
 * gültig, wenn das ZIEL auf D: liegt — die Nutzer-Datenbank liegt auf D:.
 * Pointer auf C:, G: & Co. werden verworfen (kein Suchen auf anderen
 * Laufwerken, keine AppData-DB).
 */
function isOnDriveD(p) {
  return typeof p === 'string' && /^[dD]:[\\/]/.test(p.trim());
}

/**
 * Windows-DB-Suche, ausschließlich auf D: —
 *  (1) Rekordboxs eigener Pointer (rekordboxAgent/options.json, eine einzige
 *      Config-Datei — KEIN Verzeichnis-Scan) wird gelesen, aber NUR
 *      akzeptiert, wenn das Ziel auf D: liegt;
 *  (2) die D:-Roots aus getDatabaseSearchRoots werden durchwandert
 *      (inkl. Rekordbox-7-Datenordner „Master“).
 * KEIN AppData-Verzeichnis-Scan, KEINE anderen Laufwerke.
 */
function locateRekordboxDatabasesOnD() {
  const candidates = [];
  // (1) Rekordbox erklärt in options.json, wo die DB liegt — nur D:-Ziele.
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const pointer = candidateFromOptions(path.join(appData, 'Pioneer'));
  if (pointer) {
    const p = pointer.replace(/^file:\/\/(localhost)?\/?/i, '').replace(/^\/([A-Za-z]:)/, '$1').trim();
    if (isOnDriveD(p) && fs.existsSync(p) && fs.statSync(p).isFile()) {
      const base = path.basename(p).toLowerCase();
      const kind = base === 'exportlibrary.db' ? 'ONE_LIBRARY' : base === 'master.db' ? 'MASTER_DB' : null;
      if (kind) candidates.push({ path: p, kind, label: `${base} (aus rekordboxAgent/options.json, Ziel D:)` });
    }
  }
  // (2) D:-Roots durchwandern (nur Rekordbox-typische Ordner, begrenzt).
  for (const root of getDatabaseSearchRoots()) {
    candidates.push(...findDatabaseFilesOnWindowsVolume(root));
  }
  return candidates;
}

/**
 * Scans the standard Rekordbox application data directories for
 * master.db / exportLibrary.db (read-only).
 *
 * Windows: ausschließlich locateRekordboxDatabasesOnD() (siehe dort).
 */
function locateRekordboxDatabases() {
  const candidates =
    process.platform === 'win32'
      ? locateRekordboxDatabasesOnD()
      : getDatabaseSearchRoots().flatMap((dir) => findDatabaseFiles(dir));

  // Deduplicate by resolved path.
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
    // Windows-Pfade sind case-insensitiv: „D:\Pioneer\master\...“ (konstruiert)
    // und „D:\Pioneer\Master\...“ (gefunden) sind derselbe Ordner — doppelte
    // Einträge ließen den Scan denselben Baum zweimal durchlaufen.
    const isDup = process.platform === 'win32'
      ? folders.some((f) => f.toLowerCase() === dir.toLowerCase())
      : folders.includes(dir);
    if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory() && !isDup) {
      folders.push(dir);
    }
  };
  const roots = [];
  // Rekordbox 7 benennt den Datenordner frei — „master“ ist der bei diesem
  // Nutzer übliche Name (D:\PIONEER\Master\share\PIONEER\USBANLZ).
  const dirNames = ['rekordbox7', 'rekordbox6', 'rekordbox', 'master'];
  if (baseOverride) {
    for (const dirName of dirNames) {
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
      for (const dirName of ['', ...dirNames]) {
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

  // Robust fallback: discover any *ANLZ* folder under the Pioneer root
  // (rekordbox6/7/custom layouts differ), limited depth, read-only.
  // Windows: NUR D: durchsuchen — AppData (C:) wird nicht angefasst
  // (ständige Nutzer-Vorgabe, siehe getDatabaseSearchRoots).
  if (!baseOverride) {
    const fallbackRoots = process.platform === 'win32'
      ? ['D:\\Pioneer', 'D:\\rekordbox', 'D:\\Rekordbox']
      : [path.join(process.env.HOME || '', 'Library', 'Application Support', 'Pioneer')];
    for (const pioneerRoot of fallbackRoots) {
      if (!fs.existsSync(pioneerRoot)) continue;
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
          } else if (lower.startsWith('rekordbox') || lower === 'pioneer' || lower === 'share' || lower === 'master') {
            walk(path.join(dir, ent.name), depth + 1);
          }
        }
      };
      walk(pioneerRoot, 0);
      for (const f of found) push(f);
    }
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

function buildAnlzPpthIndex(folders) {
  const index = new Map();
  let scanned = 0;
  // USBANLZ is normally a hash/UUID directory tree, not a flat folder.
  // The previous implementation only inspected the root and therefore
  // reported "0 Dateien" on valid Rekordbox exports. Walk only the analysis
  // roots, with a depth/file guard so a malformed path cannot become a full
  // disk scan.
  const maxDepth = 6;
  const maxFiles = 250000;
  const visit = (folder, depth) => {
    if (depth > maxDepth || scanned >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entryInfo of entries) {
      if (scanned >= maxFiles) return;
      const full = path.join(folder, entryInfo.name);
      if (entryInfo.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      const lower = entryInfo.name.toLowerCase();
      if (!lower.startsWith('anlz')) continue;
      if (!lower.endsWith('.dat') && !lower.endsWith('.ext')) continue;
      scanned += 1;
      const ppth = readPpthFromFile(full);
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
  for (const folder of folders) visit(folder, 0);
  return { index, scanned };
}

// ---------------------------------------------------------------------------
// Async version of the PPTH index — runs WITHOUT blocking the main process
// (the synchronous walk froze the whole UI on large libraries: 20k+ headers
// took up to 3.5 minutes). Chunked with setImmediate yields so the UI stays
// responsive; a persistent cache (userData) skips header reads when the
// ANLZ tree is unchanged.
// ---------------------------------------------------------------------------

const ANLZ_CACHE_VERSION = 1;
const ANLZ_SCAN_BATCH = 250;

function anlzCachePath(userDataDir) {
  return path.join(userDataDir, 'anlz-ppth-index.json');
}

async function readAnlzCache(userDataDir) {
  try {
    const raw = await fs.promises.readFile(anlzCachePath(userDataDir), 'utf8');
    const data = JSON.parse(raw);
    if (
      data &&
      data.version === ANLZ_CACHE_VERSION &&
      Array.isArray(data.folders) &&
      data.files &&
      Array.isArray(data.index)
    ) {
      return data;
    }
  } catch {
    // No cache / unreadable — fall back to a full scan.
  }
  return null;
}

async function writeAnlzCache(userDataDir, folders, fileMtimes, index) {
  try {
    const payload = {
      version: ANLZ_CACHE_VERSION,
      savedAt: Date.now(),
      folders,
      files: Object.fromEntries(fileMtimes),
      index: [...index.entries()].map(([k, v]) => [k, v]),
    };
    await fs.promises.writeFile(anlzCachePath(userDataDir), JSON.stringify(payload), 'utf8');
  } catch {
    // Cache is an optimization only — never fail the scan because of it.
  }
}

function sameFolderSet(a, b) {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((x) => setA.has(x));
}

/** Async walk that collects mtimeMs of every ANLZ file (no header reads). */
async function currentAnlzFileMtimes(folders) {
  const fileMtimes = new Map();
  const maxDepth = 6;
  const maxFiles = 250000;
  const queue = folders.map((f) => [f, 0]);
  let guard = 0;
  while (queue.length > 0 && guard < maxFiles * 4) {
    const [folder, depth] = queue.shift();
    let entries = [];
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entryInfo of entries) {
      guard += 1;
      const full = path.join(folder, entryInfo.name);
      if (entryInfo.isDirectory()) {
        if (depth + 1 <= maxDepth) queue.push([full, depth + 1]);
        continue;
      }
      const lower = entryInfo.name.toLowerCase();
      if (!lower.startsWith('anlz') || (!lower.endsWith('.dat') && !lower.endsWith('.ext'))) continue;
      try {
        const st = await fs.promises.stat(full);
        fileMtimes.set(full, st.mtimeMs);
      } catch {
        // Vanished file — simply not part of the map.
      }
    }
  }
  return fileMtimes;
}

/**
 * Async PPTH index build: same semantics as buildAnlzPpthIndex, but non-
 * blocking (fs.promises + setImmediate yields). onProgress receives
 * { phase: 'scanning', scanned, matched } per batch.
 */
async function buildAnlzPpthIndexAsync(folders, onProgress) {
  const index = new Map();
  const fileMtimes = new Map();
  let scanned = 0;
  const maxDepth = 6;
  const maxFiles = 250000;
  const queue = folders.map((f) => [f, 0]);

  const readHeader = async (full) => {
    let handle = null;
    try {
      handle = await fs.promises.open(full, 'r');
      const stat = await handle.stat();
      const len = Math.min(ANLZ_HEADER_BYTES, stat.size);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await handle.read(buf, 0, len, 0);
      if (bytesRead < 0x10) return null;
      if (buf.toString('ascii', 0, 4) !== 'PPTH') return null;
      const lenPath = buf.readUInt32BE(0x0c);
      if (lenPath <= 0 || 0x10 + lenPath > bytesRead) return null;
      return decodePpthPath(buf, 0x10, lenPath);
    } catch {
      return null;
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // ignore
        }
      }
    }
  };

  const notify = () => {
    if (onProgress) {
      try {
        onProgress({ phase: 'scanning', scanned, matched: index.size });
      } catch {
        // Progress is best-effort.
      }
    }
  };

  while (queue.length > 0 && scanned < maxFiles) {
    let batch = 0;
    while (batch < ANLZ_SCAN_BATCH && queue.length > 0 && scanned < maxFiles) {
      batch += 1;
      const [folder, depth] = queue.shift();
      let entries = [];
      try {
        entries = await fs.promises.readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entryInfo of entries) {
        if (scanned >= maxFiles) break;
        const full = path.join(folder, entryInfo.name);
        if (entryInfo.isDirectory()) {
          if (depth + 1 <= maxDepth) queue.push([full, depth + 1]);
          continue;
        }
        const lower = entryInfo.name.toLowerCase();
        if (!lower.startsWith('anlz') || (!lower.endsWith('.dat') && !lower.endsWith('.ext'))) continue;
        scanned += 1;
        const ppth = await readHeader(full);
        try {
          const st = await fs.promises.stat(full);
          fileMtimes.set(full, st.mtimeMs);
        } catch {
          // ignore
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
    }
    notify();
    if (queue.length > 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return { index, scanned, fileMtimes };
}

/**
 * Shared matching logic (Tier 1 exact path, Tier 2 unique basename) used by
 * the sync and async scan so both behave identically.
 */
function matchTargetsAgainstIndex(index, targetPaths) {
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
  return { matches, ppthSample };
}

/**
 * Async scan (non-blocking main process) with persistent cache:
 *  - unchanged ANLZ tree  → reuse cached index (no header reads),
 *  - changed/new files    → full async rebuild + cache refresh.
 * options: { folderOverride, userDataDir, onProgress }
 */
async function scanAnlzForPathsAsync(targetPaths, options = {}) {
  const started = Date.now();
  const { folderOverride, userDataDir, onProgress } = options;
  const folders = folderOverride || [
    ...findAnlzFolders(),
    ...findTargetDriveAnlzFolders(targetPaths),
  ];
  if (folders.length === 0) {
    return {
      matches: [],
      scanned: 0,
      folders,
      elapsedMs: Date.now() - started,
      ppthSample: [],
      cacheUsed: false,
      headerReads: 0,
    };
  }

  let index = null;
  let scanned = 0;
  let cacheUsed = false;

  if (userDataDir) {
    const cached = await readAnlzCache(userDataDir);
    if (cached && sameFolderSet(cached.folders, folders)) {
      const current = await currentAnlzFileMtimes(folders);
      const cacheFiles = cached.files;
      if (current.size === Object.keys(cacheFiles).length && [...current.entries()].every(([k, v]) => cacheFiles[k] === v)) {
        index = new Map(cached.index);
        scanned = current.size;
        cacheUsed = true;
        if (onProgress) {
          try {
            onProgress({ phase: 'cache', scanned, matched: index.size });
          } catch {
            // best-effort
          }
        }
      }
    }
  }

  if (!index) {
    const built = await buildAnlzPpthIndexAsync(folders, onProgress);
    index = built.index;
    scanned = built.scanned;
    if (userDataDir) {
      // Fire-and-forget: the cache is an optimization, not a requirement.
      writeAnlzCache(userDataDir, folders, built.fileMtimes, index);
    }
  }

  const { matches, ppthSample } = matchTargetsAgainstIndex(index, targetPaths);
  return {
    matches,
    scanned,
    folders,
    elapsedMs: Date.now() - started,
    ppthSample,
    cacheUsed,
    headerReads: cacheUsed ? 0 : scanned,
  };
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

function scanAnlzForPaths(targetPaths, folderOverride) {
  const started = Date.now();
  const folders = folderOverride || [
    ...findAnlzFolders(),
    ...findTargetDriveAnlzFolders(targetPaths),
  ];
  const { index, scanned } = buildAnlzPpthIndex(folders);
  const { matches, ppthSample } = matchTargetsAgainstIndex(index, targetPaths);
  return { matches, scanned, folders, elapsedMs: Date.now() - started, ppthSample };
}

module.exports = {
  getMasterDbKey,
  getOneLibraryKey,
  detectDbType,
  classifyDbOpenError,
  readRekordboxDatabase,
  getDatabaseSearchRoots,
  isOnDriveD,
  findDatabaseFilesOnWindowsVolume,
  findAnlzFolders,
  locateRekordboxDatabases,
  scanAnlzForPaths,
  scanAnlzForPathsAsync,
  buildAnlzPpthIndexAsync,
  anlzCachePath,
  isCipherAvailable: () => getCipherModule() !== null,
};
