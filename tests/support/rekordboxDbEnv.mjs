/**
 * @license
 * Kleine eigene Rekordbox-Datenbankumgebung (Test-/Nachweis-Fixture).
 *
 * Erzeugt echte, mit den bekannten Pioneer-Schlüsseln verschlüsselte
 * SQLCipher-Datenbanken im dokumentierten Aufbau:
 *
 *   master.db        – Rekordbox 6/7 (djmd*-Tabellen, SQLCipher 4, legacy = 4)
 *   exportLibrary.db – OneLibrary / Device Library Plus (content/cue/…-Tabellen)
 *
 * dazu passende ANLZ-Byteblöcke (.DAT: PMAI + getaggte Sektionen) und ein
 * winziges Original-WAV. Damit lässt sich die komplette Import-Pipeline
 *
 *   verschlüsselte Byteblöcke → SQL-Abfragen → Zeilen/Einträge → TrackModel
 *   → ANLZ-Sektionswalk → Waveform-Buckets
 *
 * ohne eine echte Benutzerbibliothek nachweisen. Aufbau und Einheiten folgen
 * der Community-Dokumentation (siehe docs/REKORDBOX_DATABASE_FORMAT.md):
 * BPM = ×100, Length = ganze Sekunden, Rating = 0..255 (master.db),
 * djmdCue InMsec/OutMsec in ms (OutMsec = -1 ohne Loop), Kind 0 = Memory Cue,
 * 1..8 = Hot Cue A..H; OneLibrary-Cues in µs (inUsec/outUsec).
 *
 * Die Dateien werden ausschließlich lesend benutzt – hier werden sie nur
 * einmalig erzeugt (Tests legen sie in temporäre Verzeichnisse).
 */

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** true, wenn das native SQLCipher-Modul geladen werden kann. */
export function isSqlCipherAvailable() {
  try {
    require('better-sqlite3-multiple-ciphers');
    return true;
  } catch {
    return false;
  }
}

function loadDatabaseConstructor() {
  try {
    return require('better-sqlite3-multiple-ciphers');
  } catch (error) {
    throw new Error(
      'better-sqlite3-multiple-ciphers ist nicht verfügbar – die Datenbankumgebung ' +
        `braucht das native Modul (${error.message || error}). ` +
        'Hinweis: npm run rekordbox:native:rebuild'
    );
  }
}

function loadDbReader() {
  return require('../../electron/dbReader.cjs');
}

// ─── Beispiel-Daten (dokumentierte Aufbewahrungseinheiten) ──────────────────

/** Pflicht-Einträge der Umgebung: zwei sichtbare Tracks + ein lokal gelöschter. */
export const SAMPLE_MASTER_CONTENT = [
  {
    ID: '101',
    FolderPath: 'C:\\Music\\Club',
    FileNameL: 'Obsidian Voltage (Club Mix).wav',
    Title: 'Obsidian Voltage (Club Mix)',
    ArtistID: '1',
    AlbumID: '2',
    GenreID: '3',
    BPM: 12800, // BPM * 100
    Length: 240, // GANZE SEKUNDEN (dokumentierte Einheit)
    TrackNo: 1,
    BitRate: 1411,
    BitDepth: 16,
    Commnt: 'Peak hour',
    FileType: 11, // wav
    Rating: 255, // 0..255 (≈ 5 Sterne)
    ReleaseYear: '2025',
    RemixerID: null,
    LabelID: '9',
    KeyID: '4',
    StockDate: '2025-01-15',
    ColorID: 1,
    DJPlayCount: 18,
    AnalysisDataPath: 'ANLZ\\PQT000001.DAT',
    FileSize: 42_336_044,
    SampleRate: 44100,
    DateCreated: '2025-01-15',
    ReleaseDate: '2025-01-10',
    ISRC: 'DEZ6S2500001',
    Subtitle: null,
    ComposerID: null,
    rb_local_deleted: 0,
  },
  {
    ID: '202',
    FolderPath: null,
    FileNameL: null,
    Title: 'Sunlight Shuffle',
    ArtistID: '5',
    AlbumID: '6',
    GenreID: '7',
    BPM: 12500,
    Length: 210,
    TrackNo: null,
    BitRate: 320,
    BitDepth: null,
    Commnt: null,
    FileType: 1, // mp3
    Rating: 102, // ≈ 2 Sterne
    ReleaseYear: '2024',
    RemixerID: null,
    LabelID: null,
    KeyID: '8',
    StockDate: null,
    ColorID: null,
    DJPlayCount: 0,
    AnalysisDataPath: null,
    FileSize: 8_400_000,
    SampleRate: 44100,
    DateCreated: '2024-11-02',
    ReleaseDate: null,
    ISRC: null,
    Subtitle: null,
    ComposerID: null,
    rb_local_deleted: 0,
  },
  {
    // Lokal gelöscht: rekordbox zeigt ihn nicht mehr (rb_local_deleted = 1).
    ID: '303',
    FolderPath: 'C:\\Music',
    FileNameL: 'Deleted Track.mp3',
    Title: 'Deleted Track',
    ArtistID: '5',
    AlbumID: null,
    GenreID: null,
    BPM: 12000,
    Length: 180,
    Rating: 0,
    DJPlayCount: 0,
    AnalysisDataPath: null,
    SampleRate: 44100,
    rb_local_deleted: 1,
  },
];

/** djmdCue-Einträge: Kind 0 = Memory Cue, 1..8 = Hot Cue A..H, OutMsec = -1 ohne Loop. */
export const SAMPLE_MASTER_CUES = [
  { ID: '900001', ContentID: '101', InMsec: 0, InFrame: 0, OutMsec: -1, OutFrame: 0, Kind: 0, Color: -1, ColorTableIndex: 0, ActiveLoop: 0, Comment: 'Intro Start', BeatLoopSize: 0 },
  { ID: '900002', ContentID: '101', InMsec: 15000, InFrame: 0, OutMsec: -1, OutFrame: 0, Kind: 1, Color: 3, ColorTableIndex: 3, ActiveLoop: 0, Comment: 'Hot A', BeatLoopSize: 0 },
  { ID: '900003', ContentID: '101', InMsec: 60000, InFrame: 0, OutMsec: -1, OutFrame: 0, Kind: 2, Color: 5, ColorTableIndex: 5, ActiveLoop: 0, Comment: 'Hot B', BeatLoopSize: 0 },
  { ID: '900004', ContentID: '101', InMsec: 75000, InFrame: 0, OutMsec: 90000, OutFrame: 0, Kind: 0, Color: -1, ColorTableIndex: 0, ActiveLoop: 1, Comment: '8-Bar Loop', BeatLoopSize: 8 },
  { ID: '900005', ContentID: '202', InMsec: 1234, InFrame: 0, OutMsec: -1, OutFrame: 0, Kind: 0, Color: -1, ColorTableIndex: 0, ActiveLoop: 0, Comment: 'Offbeat Cue', BeatLoopSize: 0 },
  { ID: '900006', ContentID: '101', InMsec: 30000, InFrame: 0, OutMsec: -1, OutFrame: 0, Kind: 0, Color: -1, ColorTableIndex: 0, ActiveLoop: 0, Comment: 'Break', BeatLoopSize: 0 },
];

export const SAMPLE_MASTER_REFS = {
  artists: [
    { ID: '1', Name: 'Klangfeld' },
    { ID: '5', Name: 'Marcos Delgado' },
  ],
  albums: [
    { ID: '2', Name: 'Subterranean Records' },
    { ID: '6', Name: 'Ibiza Sessions' },
  ],
  genres: [
    { ID: '3', Name: 'Techno' },
    { ID: '7', Name: 'Tech House' },
  ],
  keys: [
    { ID: '4', ScaleName: '6A', Seq: 1 },
    { ID: '8', ScaleName: '8A', Seq: 2 },
  ],
  labels: [{ ID: '9', Name: 'Subterranean' }],
  playlists: [{ ID: '10', Seq: 1, Name: 'Peak Time', ImagePath: null, Attribute: 0, ParentID: '0', SmartList: null }],
  songPlaylists: [{ ID: '11', PlaylistID: '10', ContentID: '101', TrackNo: 1 }],
};

// ─── master.db ──────────────────────────────────────────────────────────────

/**
 * Schreibt eine echte, verschlüsselte master.db im dokumentierten Aufbau.
 * @param {string} filePath Ziel-Pfad (wird überschrieben)
 * @param {object} [options] optionale Überschreibungen der Beispiel-Daten
 */
export function buildMasterDb(filePath, options = {}) {
  const Database = loadDatabaseConstructor();
  const { getMasterDbKey } = loadDbReader();
  const content = options.content ?? SAMPLE_MASTER_CONTENT;
  const cues = options.cues ?? SAMPLE_MASTER_CUES;
  const refs = { ...SAMPLE_MASTER_REFS, ...(options.refs ?? {}) };

  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    db.pragma('cipher = sqlcipher');
    db.pragma('legacy = 4');
    db.pragma(`key = '${getMasterDbKey()}'`);
    db.exec(`
      CREATE TABLE djmdContent (
        ID TEXT PRIMARY KEY, FolderPath TEXT, FileNameL TEXT, FileNameS TEXT, Title TEXT,
        ArtistID INTEGER, AlbumID INTEGER, GenreID INTEGER, BPM INTEGER, Length INTEGER,
        TrackNo INTEGER, BitRate INTEGER, BitDepth INTEGER, Commnt TEXT, FileType INTEGER,
        Rating INTEGER, ReleaseYear TEXT, RemixerID INTEGER, LabelID INTEGER, KeyID INTEGER,
        StockDate TEXT, ColorID INTEGER, DJPlayCount INTEGER, ImagePath TEXT,
        MasterDBID INTEGER, MasterSongID INTEGER, AnalysisDataPath TEXT, SearchStr TEXT,
        FileSize INTEGER, DiscNo INTEGER, ComposerID INTEGER, Subtitle TEXT, SampleRate INTEGER,
        DisableQuantize INTEGER, Analysed INTEGER, ReleaseDate TEXT, DateCreated TEXT,
        ISRC TEXT, rb_local_deleted INTEGER DEFAULT 0
      );
      CREATE TABLE djmdCue (
        ID TEXT PRIMARY KEY, ContentID TEXT, InMsec INTEGER, InFrame INTEGER,
        InMpegFrame INTEGER, InMpegAbs INTEGER, OutMsec INTEGER, OutFrame INTEGER,
        OutMpegFrame INTEGER, OutMpegAbs INTEGER, Kind INTEGER, Color INTEGER,
        ColorTableIndex INTEGER, ActiveLoop INTEGER, Comment TEXT, BeatLoopSize INTEGER
      );
      CREATE TABLE djmdArtist (ID TEXT PRIMARY KEY, Name TEXT, SearchStr TEXT);
      CREATE TABLE djmdAlbum (ID TEXT PRIMARY KEY, Name TEXT, AlbumArtistID INTEGER, ImagePath TEXT, Compilation INTEGER, SearchStr TEXT);
      CREATE TABLE djmdGenre (ID TEXT PRIMARY KEY, Name TEXT);
      CREATE TABLE djmdKey (ID TEXT PRIMARY KEY, ScaleName TEXT, Seq INTEGER);
      CREATE TABLE djmdLabel (ID TEXT PRIMARY KEY, Name TEXT);
      CREATE TABLE djmdPlaylist (ID TEXT PRIMARY KEY, Seq INTEGER, Name TEXT, ImagePath TEXT, Attribute INTEGER, ParentID TEXT, SmartList TEXT);
      CREATE TABLE djmdSongPlaylist (ID TEXT PRIMARY KEY, PlaylistID TEXT, ContentID TEXT, TrackNo INTEGER);
    `);

    const insert = (table, columns, rows) => {
      const stmt = db.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      );
      for (const row of rows) stmt.run(...columns.map((c) => (row[c] === undefined ? null : row[c])));
    };

    insert('djmdContent', [
      'ID', 'FolderPath', 'FileNameL', 'Title', 'ArtistID', 'AlbumID', 'GenreID', 'BPM',
      'Length', 'TrackNo', 'BitRate', 'BitDepth', 'Commnt', 'FileType', 'Rating',
      'ReleaseYear', 'RemixerID', 'LabelID', 'KeyID', 'StockDate', 'ColorID',
      'DJPlayCount', 'AnalysisDataPath', 'FileSize', 'SampleRate', 'DateCreated',
      'ReleaseDate', 'ISRC', 'Subtitle', 'ComposerID', 'rb_local_deleted',
    ], content.map((row) => ({ ...row, ISRC: row.ISRC ?? null })));
    insert('djmdCue', [
      'ID', 'ContentID', 'InMsec', 'InFrame', 'OutMsec', 'OutFrame', 'Kind', 'Color',
      'ColorTableIndex', 'ActiveLoop', 'Comment', 'BeatLoopSize',
    ], cues);
    insert('djmdArtist', ['ID', 'Name'], refs.artists);
    insert('djmdAlbum', ['ID', 'Name'], refs.albums);
    insert('djmdGenre', ['ID', 'Name'], refs.genres);
    insert('djmdKey', ['ID', 'ScaleName', 'Seq'], refs.keys);
    insert('djmdLabel', ['ID', 'Name'], refs.labels);
    insert('djmdPlaylist', ['ID', 'Seq', 'Name', 'ImagePath', 'Attribute', 'ParentID', 'SmartList'], refs.playlists);
    insert('djmdSongPlaylist', ['ID', 'PlaylistID', 'ContentID', 'TrackNo'], refs.songPlaylists);
  } finally {
    db.close();
  }
  return filePath;
}

// ─── exportLibrary.db (OneLibrary / Device Library Plus) ────────────────────

export const SAMPLE_ONE_LIBRARY_CONTENT = [
  {
    content_id: 55,
    title: 'Quantum Velocity (VIP Roller)',
    subtitle: null,
    bpmx100: 17400, // BPM * 100
    length: 190, // GANZE SEKUNDEN (reale Exporte: 195/390/297 – dokumentierte Einheit)
    trackNo: 1,
    discNo: 1,
    artist_id_artist: 7,
    artist_id_remixer: null,
    artist_id_originalArtist: null,
    artist_id_composer: null,
    artist_id_lyricist: null,
    album_id: 8,
    genre_id: 9,
    label_id: 11,
    key_id: 10,
    djComment: 'Roller',
    rating: 5, // OneLibrary: 0..5
    releaseYear: 2025,
    releaseDate: '2025-02-01',
    dateCreated: '2025-02-02',
    dateAdded: '2025-02-03',
    path: '/Volumes/USB/Music',
    fileName: 'Quantum Velocity.flac',
    fileSize: 51_000_000,
    fileType: 5,
    bitrate: 1000,
    bitDepth: 24,
    samplingRate: 48000,
    isrc: null,
    djPlayCount: 65,
    analysisDataFilePath: '/PIONEER/USBANLZ/PQT000055.DAT',
  },
];

/** OneLibrary-Cues: Zeitpunkte in Mikrosekunden (inUsec/outUsec), kind wie master.db. */
export const SAMPLE_ONE_LIBRARY_CUES = [
  { cue_id: 1, content_id: 55, kind: 0, colorTableIndex: 0, cueComment: 'Intro', isActiveLoop: 0, beatLoopNumerator: 0, beatLoopDenominator: 4, inUsec: 0, outUsec: -1, in150FramePerSec: 0, out150FramePerSec: -1, inMpegFrameNumber: 0, outMpegFrameNumber: -1, inMpegAbs: 0, outMpegAbs: -1, inDecodingStartFramePosition: 0, outDecodingStartFramePosition: -1, inFileOffsetInBlock: 0, outFileOffsetInBlock: -1, inNumberOfSampleInBlock: 0, outNumberOfSampleInBlock: -1 },
  { cue_id: 2, content_id: 55, kind: 1, colorTableIndex: 3, cueComment: 'A', isActiveLoop: 0, beatLoopNumerator: 0, beatLoopDenominator: 4, inUsec: 44_138_000, outUsec: -1, in150FramePerSec: 6621, out150FramePerSec: -1, inMpegFrameNumber: 0, outMpegFrameNumber: -1, inMpegAbs: 0, outMpegAbs: -1, inDecodingStartFramePosition: 0, outDecodingStartFramePosition: -1, inFileOffsetInBlock: 0, outFileOffsetInBlock: -1, inNumberOfSampleInBlock: 0, outNumberOfSampleInBlock: -1 },
];

export const SAMPLE_ONE_LIBRARY_REFS = {
  artists: [{ artist_id: 7, name: 'Subsonic Pulse' }],
  albums: [{ album_id: 8, name: 'Neurofunk Archives' }],
  genres: [{ genre_id: 9, name: 'Drum & Bass' }],
  keys: [{ key_id: 10, name: '4A' }],
  labels: [{ label_id: 11, name: 'Viper Recordings' }],
  playlists: [{ playlist_id: 1, sequenceNo: 1, name: 'USB Set', image_id: null, attribute: 0, playlist_id_parent: 0 }],
  // playlist_content hat KEINE eigene ID-Spalte – zusammengesetzter Schlüssel.
  playlist_contents: [{ playlist_id: 1, content_id: 55, sequenceNo: 1 }],
};

/**
 * Schreibt eine echte, verschlüsselte exportLibrary.db (OneLibrary) im
 * dokumentierten Aufbau der Device Library Plus.
 */
export function buildOneLibraryDb(filePath, options = {}) {
  const Database = loadDatabaseConstructor();
  const { getOneLibraryKey } = loadDbReader();
  const content = options.content ?? SAMPLE_ONE_LIBRARY_CONTENT;
  const cues = options.cues ?? SAMPLE_ONE_LIBRARY_CUES;
  const refs = { ...SAMPLE_ONE_LIBRARY_REFS, ...(options.refs ?? {}) };

  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    db.pragma('cipher = sqlcipher');
    db.pragma('legacy = 4');
    db.pragma(`key = '${getOneLibraryKey()}'`);
    db.exec(`
      CREATE TABLE content (
        content_id INTEGER PRIMARY KEY, title TEXT, titleForSearch TEXT, subtitle TEXT,
        bpmx100 INTEGER, length INTEGER, trackNo INTEGER, discNo INTEGER,
        artist_id_artist INTEGER, artist_id_remixer INTEGER, artist_id_originalArtist INTEGER,
        artist_id_composer INTEGER, artist_id_lyricist INTEGER, album_id INTEGER,
        genre_id INTEGER, label_id INTEGER, key_id INTEGER, color_id INTEGER, image_id INTEGER,
        djComment TEXT, rating INTEGER, releaseYear INTEGER, releaseDate TEXT,
        dateCreated TEXT, dateAdded TEXT, path TEXT, fileName TEXT, fileSize INTEGER,
        fileType INTEGER, bitrate INTEGER, bitDepth INTEGER, samplingRate INTEGER, isrc TEXT,
        djPlayCount INTEGER, isHotCueAutoLoadOn INTEGER, analysisDataFilePath TEXT,
        analysedBits INTEGER
      );
      CREATE TABLE cue (
        cue_id INTEGER PRIMARY KEY, content_id INTEGER, kind INTEGER, colorTableIndex INTEGER,
        cueComment TEXT, isActiveLoop INTEGER, beatLoopNumerator INTEGER, beatLoopDenominator INTEGER,
        inUsec INTEGER, outUsec INTEGER, in150FramePerSec INTEGER, out150FramePerSec INTEGER,
        inMpegFrameNumber INTEGER, outMpegFrameNumber INTEGER, inMpegAbs INTEGER, outMpegAbs INTEGER,
        inDecodingStartFramePosition INTEGER, outDecodingStartFramePosition INTEGER,
        inFileOffsetInBlock INTEGER, outFileOffsetInBlock INTEGER,
        inNumberOfSampleInBlock INTEGER, outNumberOfSampleInBlock INTEGER
      );
      CREATE TABLE artist (artist_id INTEGER PRIMARY KEY, name TEXT, nameForSearch TEXT);
      CREATE TABLE album (album_id INTEGER PRIMARY KEY, name TEXT, artist_id INTEGER, image_id INTEGER, isComplation INTEGER, nameForSearch TEXT);
      CREATE TABLE genre (genre_id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE key (key_id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE label (label_id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE playlist (playlist_id INTEGER PRIMARY KEY, sequenceNo INTEGER, name TEXT, image_id INTEGER, attribute INTEGER, playlist_id_parent INTEGER);
      CREATE TABLE playlist_content (playlist_id INTEGER, content_id INTEGER, sequenceNo INTEGER, PRIMARY KEY (playlist_id, content_id));
    `);

    const insert = (table, columns, rows) => {
      const stmt = db.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      );
      for (const row of rows) stmt.run(...columns.map((c) => (row[c] === undefined ? null : row[c])));
    };

    insert('content', [
      'content_id', 'title', 'subtitle', 'bpmx100', 'length', 'trackNo', 'discNo',
      'artist_id_artist', 'artist_id_remixer', 'artist_id_originalArtist',
      'artist_id_composer', 'artist_id_lyricist', 'album_id', 'genre_id', 'label_id',
      'key_id', 'djComment', 'rating', 'releaseYear', 'releaseDate', 'dateCreated',
      'dateAdded', 'path', 'fileName', 'fileSize', 'fileType', 'bitrate', 'bitDepth',
      'samplingRate', 'isrc', 'djPlayCount', 'analysisDataFilePath',
    ], content);
    insert('cue', [
      'cue_id', 'content_id', 'kind', 'colorTableIndex', 'cueComment', 'isActiveLoop',
      'beatLoopNumerator', 'beatLoopDenominator', 'inUsec', 'outUsec',
      'in150FramePerSec', 'out150FramePerSec', 'inMpegFrameNumber', 'outMpegFrameNumber',
      'inMpegAbs', 'outMpegAbs', 'inDecodingStartFramePosition', 'outDecodingStartFramePosition',
      'inFileOffsetInBlock', 'outFileOffsetInBlock', 'inNumberOfSampleInBlock', 'outNumberOfSampleInBlock',
    ], cues);
    insert('artist', ['artist_id', 'name'], refs.artists);
    insert('album', ['album_id', 'name'], refs.albums);
    insert('genre', ['genre_id', 'name'], refs.genres);
    insert('key', ['key_id', 'name'], refs.keys);
    insert('label', ['label_id', 'name'], refs.labels);
    insert('playlist', ['playlist_id', 'sequenceNo', 'name', 'image_id', 'attribute', 'playlist_id_parent'], refs.playlists);
    insert('playlist_content', ['playlist_id', 'content_id', 'sequenceNo'], refs.playlist_contents);
  } finally {
    db.close();
  }
  return filePath;
}

// ─── ANLZ-Byteblöcke + winziges Original-Audio ──────────────────────────────

/** Ein ANLZ-Sektionsblock: 4 Byte Typ + 4 Byte Kennung + 4 Byte Länge + Body. */
export function anlzSection(tag, body = Buffer.alloc(0), headerValue = 0x18) {
  const total = 12 + body.length;
  const buffer = Buffer.alloc(total);
  buffer.write(tag, 0, 'ascii');
  buffer.writeUInt32BE(headerValue, 4);
  buffer.writeUInt32BE(total, 8);
  body.copy(buffer, 12);
  return buffer;
}

function pmaiHeader(headerLen = 32) {
  const buffer = Buffer.alloc(headerLen);
  buffer.write('PMAI', 0, 'ascii');
  buffer.writeUInt32BE(headerLen, 4);
  buffer.writeUInt32BE(0, 8);
  return buffer;
}

function ppthSection(pathValue) {
  const encoded = Buffer.from(
    [...pathValue].flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff]).concat([0, 0])
  );
  const body = Buffer.alloc(4 + encoded.length);
  body.writeUInt32BE(encoded.length, 0);
  encoded.copy(body, 4);
  return anlzSection('PPTH', body, 0x10);
}

/** Body-Felder über Sektionsoffset: body[X - 12] == Sektionsoffset X. */
const at = (sectionOffset) => sectionOffset - 12;

function pqtzSection(beatCount, bpmx100 = 12800) {
  const body = Buffer.alloc(0x18 + beatCount * 8, 0x00);
  body.writeUInt32BE(beatCount, at(0x14));
  for (let i = 0; i < beatCount; i++) {
    const entry = at(0x18 + i * 8);
    body.writeUInt16BE((i % 4) + 1, entry);
    body.writeUInt16BE(bpmx100, entry + 2);
    body.writeUInt32BE(i * 469, entry + 4);
  }
  return anlzSection('PQTZ', body, 0x18);
}

function pwv5Section(bucketCount = 480) {
  const body = Buffer.alloc(0x18 + bucketCount * 2, 0x00);
  body.writeUInt32BE(2, at(0x0c)); // len_entry_bytes
  body.writeUInt32BE(bucketCount, at(0x10)); // len_entries
  body.writeUInt32BE(0, at(0x14)); // unknown
  for (let i = 0; i < bucketCount; i++) {
    const level = Math.min(0x1f, 4 + Math.round(20 * Math.abs(Math.sin(i / 18))));
    body.writeUInt16BE((level << 2) | (3 << 7) | (5 << 10) | (6 << 13), at(0x18) + i * 2);
  }
  return anlzSection('PWV5', body, 0x18);
}

/** Winzige, aber echte RIFF/WAVE-Datei (mono, 16 Bit, 44.1 kHz). */
export function minimalWav(sampleCount = 441) {
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(88200, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount; i++) {
    buffer.writeInt16LE(Math.round(Math.sin(i / 12) * 12000), 44 + i * 2);
  }
  return buffer;
}

/**
 * Baut eine ANLZ-.DAT mit dokumentierten Sektionen (PMAI + PPTH/PQTZ/PWV5)
 * und legt das referenzierte Original-WAV daneben.
 * @returns {{ anlzPath: string, originalPath: string, bucketCount: number }}
 */
export function buildAnlzPair(rootDir, options = {}) {
  const bucketCount = options.bucketCount ?? 480;
  const beatCount = options.beatCount ?? 96;
  const originalName = options.originalName ?? 'Obsidian Voltage (Club Mix).wav';
  const musicDir = path.join(rootDir, 'Music');
  const analysisDir = path.join(rootDir, 'analysis');
  mkdirSync(musicDir, { recursive: true });
  mkdirSync(analysisDir, { recursive: true });

  const originalPath = path.join(musicDir, originalName);
  const anlzPath = path.join(analysisDir, options.anlzName ?? 'PQT000001.DAT');
  writeFileSync(originalPath, minimalWav());
  const anlzBytes = Buffer.concat([
    pmaiHeader(),
    ppthSection(originalPath),
    pqtzSection(beatCount, options.bpmx100 ?? 12800),
    pwv5Section(bucketCount),
  ]);
  writeFileSync(anlzPath, anlzBytes);
  return { anlzPath, originalPath, bucketCount, beatCount };
}

// ─── Komplette Umgebung ─────────────────────────────────────────────────────

/**
 * Legt die vollständige kleine Datenbankumgebung unter `rootDir` an:
 *
 *   rootDir/master.db            verschlüsselte Rekordbox-6/7-Bibliothek
 *   rootDir/exportLibrary.db     verschlüsselte OneLibrary-Bibliothek
 *   rootDir/analysis/PQT000001.DAT   ANLZ-Byteblöcke (PMAI+PPTH+PQTZ+PWV5)
 *   rootDir/Music/*.wav          winziges Original-Audio (read-only genutzt)
 *
 * @returns {{ rootDir: string, masterDbPath: string, oneLibraryPath: string,
 *   anlzPath: string, originalPath: string, bucketCount: number }}
 */
export function buildDbEnvironment(rootDir, options = {}) {
  mkdirSync(rootDir, { recursive: true });
  const masterDbPath = buildMasterDb(path.join(rootDir, 'master.db'), options);
  const oneLibraryPath = buildOneLibraryDb(path.join(rootDir, 'exportLibrary.db'), options);
  const { anlzPath, originalPath, bucketCount } = buildAnlzPair(rootDir, options);
  return { rootDir, masterDbPath, oneLibraryPath, anlzPath, originalPath, bucketCount };
}
