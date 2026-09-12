/**
 * @license
 * Rekordbox 6/7 database row mapping tests (master.db & OneLibrary).
 *
 * The SQLCipher decryption itself lives in the Electron main process
 * (electron/dbReader.cjs) and requires the native better-sqlite3
 * binding; this suite covers the shared, renderer-side mapping of the
 * row payloads for both database shapes, matching the documented
 * djmdContent / djmdCue (master.db) and content / cue (OneLibrary)
 * schemas.
 *
 * Run with: npx tsx tests/rekordbox-db-import.test.ts
 */

import {
  mapRekordboxDatabaseRows,
  buildDeckTrackFromDatabase,
} from '../src/rekordbox/dbParser';
import { DataOrigin } from '../src/types/rekordbox';

import { runTest, assert, same, report } from './helpers/microTest.mjs';

// ─── FIXTURES (documented master.db column names) ───────────────────────────
const masterRows = {
  content: [
    {
      ID: '101',
      Title: 'Obsidian Voltage (Club Mix)',
      ArtistID: '1',
      AlbumID: '2',
      GenreID: '3',
      BPM: 12800, // BPM * 100
      Length: 240000,
      Rating: 255,
      DJPlayCount: '18',
      ReleaseYear: 2025,
      KeyID: '4',
      FolderPath: 'C:\\Music',
      FileNameL: 'Obsidian Voltage.wav',
      SampleRate: 44100,
      AnalysisDataPath: 'C:\\Rekordbox\\ANLZ0000.DAT',
      Commnt: 'Peak hour',
    },
    {
      ID: '202',
      Title: 'Sunlight Shuffle',
      ArtistID: '5',
      AlbumID: '6',
      GenreID: '7',
      BPM: 12500,
      Length: 210000,
      Rating: 4,
      KeyID: '8',
      FolderPath: null,
      FileNameL: null,
    },
  ],
  cues: [
    { ID: '1', ContentID: '101', Kind: 0, InMsec: 0, OutMsec: -1, Comment: 'Intro Start' },
    { ID: '2', ContentID: '101', Kind: 0, InMsec: 15000, OutMsec: -1, Comment: 'Kick In' },
    { ID: '3', ContentID: '101', Kind: 1, InMsec: 15000, OutMsec: -1, Comment: 'Hot A' },
    { ID: '4', ContentID: '101', Kind: 2, InMsec: 60000, OutMsec: -1, Comment: 'Hot B' },
    { ID: '5', ContentID: '101', Kind: 0, InMsec: 75000, OutMsec: 90000, Comment: '8-Bar Loop' },
    { ID: '6', ContentID: '202', Kind: 0, InMsec: 1234, OutMsec: -1, Comment: 'Offbeat Cue' },
  ],
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
  playlists: [{ ID: '10', Name: 'Peak Time', ParentID: null, Attribute: 0 }],
  songPlaylists: [{ ID: '11', PlaylistID: '10', ContentID: '101', TrackNo: 1 }],
};

const oneLibraryRows = {
  content: [
    {
      content_id: 55,
      title: 'Quantum Velocity (VIP Roller)',
      artist_id_artist: 7,
      album_id: 8,
      genre_id: 9,
      bpmx100: 17400,
      length: 190000,
      rating: 5,
      releaseYear: 2025,
      key_id: 10,
      path: '/Volumes/USB/Music',
      fileName: 'Quantum Velocity.flac',
      samplingRate: 48000,
      analysisDataFilePath: null,
      djComment: 'Roller',
      djPlayCount: 65,
    },
  ],
  cues: [
    { cue_id: 1, content_id: 55, kind: 0, cueComment: 'Intro', inUsec: 0, outUsec: null },
    { cue_id: 2, content_id: 55, kind: 1, cueComment: 'A', inUsec: 44138000, outUsec: null },
  ],
  artists: [{ artist_id: 7, name: 'Subsonic Pulse' }],
  albums: [{ album_id: 8, name: 'Neurofunk Archives' }],
  genres: [{ genre_id: 9, name: 'Drum & Bass' }],
  keys: [{ key_id: 10, name: '4A' }],
  labels: [],
  playlists: [{ playlist_id: 1, name: 'USB Set', playlist_id_parent: null, attribute: 0 }],
  songPlaylists: [{ playlist_content_id: 1, playlist_id: 1, content_id: 55, sequenceNo: 1 }],
};

// ─── SUITE 1: master.db mapping ─────────────────────────────────────────────
runTest('master.db mapping', 'Normalizes BPM, rating, joins and metadata', () => {
  const mapped = mapRekordboxDatabaseRows(masterRows, 'MASTER_DB');
  same(mapped.tracks.length, 2, 'Track count');
  const track = mapped.tracks[0]!;

  same(track.title, 'Obsidian Voltage (Club Mix)', 'Title');
  same(track.artist, 'Klangfeld', 'Artist join');
  same(track.album, 'Subterranean Records', 'Album join');
  same(track.genre, 'Techno', 'Genre join');
  same(track.key, '6A', 'Key join');
  same(track.bpm, 128, 'BPM /100');
  same(Math.round(track.duration! * 1000), 240000, 'Duration from ms');
  same(track.rating, 5, 'Rating 255 -> 5');
  same(track.playCount, 18, 'Play count');
  assert(track.originalMedia?.location === 'C:\\Music\\Obsidian Voltage.wav', 'File location');
  same(track.origin, DataOrigin.REKORDBOX_DB, 'DB origin');
});

runTest('master.db mapping', 'Decodes memory cues, hot cues and loops with beat alignment', () => {
  const mapped = mapRekordboxDatabaseRows(masterRows, 'MASTER_DB');
  const track = mapped.tracks[0]!;
  const cues = track.cues || [];
  const loops = track.loops || [];

  same(cues.filter((c) => c.type === 'MEMORY').length, 2, 'Memory cues');
  same(cues.filter((c) => c.type === 'HOT_CUE').length, 2, 'Hot cues');
  const hotA = cues.find((c) => c.type === 'HOT_CUE' && c.hotCueNum === 0);
  assert(hotA !== undefined, 'Hot A exists');
  same(hotA!.letter, 'A', 'Hot A letter');
  same(hotA!.comment, 'Hot A', 'Hot A comment');
  same(loops.length, 1, 'Loop count');
  same(Math.round(loops[0].start * 1000), 75000, 'Loop start');
  same(Math.round(loops[0].end * 1000), 90000, 'Loop end');
  // Stats are global across all tracks (incl. the second fixture track).
  same(mapped.stats.memoryCues, 3, 'Stats memory cues');
  same(mapped.stats.hotCues, 2, 'Stats hot cues');
  same(mapped.stats.loops, 1, 'Stats loops');
});

runTest('master.db mapping', 'Missing path remains a metadata-only track', () => {
  const mapped = mapRekordboxDatabaseRows(masterRows, 'MASTER_DB');
  const track = mapped.tracks[1]!;
  same(track.originalMedia, undefined, 'No original media reference');
  same(track.duration, 210, 'Duration preserved');
});

// ─── SUITE 2: OneLibrary mapping ────────────────────────────────────────────
runTest('OneLibrary mapping', 'Maps camelCase OneLibrary rows to the shared contract', () => {
  const mapped = mapRekordboxDatabaseRows(oneLibraryRows, 'ONE_LIBRARY');
  same(mapped.tracks.length, 1, 'Track count');
  const track = mapped.tracks[0]!;

  same(track.id, '55', 'Content id');
  same(track.title, 'Quantum Velocity (VIP Roller)', 'Title');
  same(track.artist, 'Subsonic Pulse', 'Artist join');
  same(track.album, 'Neurofunk Archives', 'Album join');
  same(track.genre, 'Drum & Bass', 'Genre join');
  same(track.key, '4A', 'Key join');
  same(track.bpm, 174, 'BPM');
  same(track.sampleRate, 48000, 'Sample rate');
  same(track.duration, 190, 'Duration');
  same(track.rating, 5, 'Rating stays 0..5');
  assert(track.originalMedia?.location.includes('Quantum Velocity.flac'), 'Location');
});

runTest('OneLibrary mapping', 'Decodes microsecond cue positions', () => {
  const mapped = mapRekordboxDatabaseRows(oneLibraryRows, 'ONE_LIBRARY');
  const cues = mapped.tracks[0]!.cues || [];
  same(cues.length, 2, 'Cue count');
  same(Math.round(cues[0].position * 1000), 0, 'Memory cue position');
  same(Math.round(cues[1].position * 1000), 44138, 'Hot cue position (us -> ms)');
  same(cues[1].type, 'HOT_CUE', 'Hot cue type');
});

// ─── SUITE 3: Deck expansion ────────────────────────────────────────────────
runTest('Deck expansion', 'Builds a playable-format TrackModel without synthetic audio', () => {
  const mapped = mapRekordboxDatabaseRows(masterRows, 'MASTER_DB');
  const deck = buildDeckTrackFromDatabase(mapped.tracks[0]!);
  same(deck.audioBuffer, null, 'No synthetic audio');
  same(deck.beatGrid.bpm, 128, 'Beat grid bpm');
  same(deck.beatGrid.beats.length, 0, 'No grid invented before PQTZ is loaded');
  same(deck.beatGrid.origin, DataOrigin.REKORDBOX_DB, 'Beat grid DB origin');
  same(deck.origin, DataOrigin.REKORDBOX_DB, 'Track DB origin');
  same(deck.originalSha256, 'NOT_COMPUTED_READ_ONLY_SOURCE', 'Read-only checksum marker');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────

report('REKORDBOX 6/7 DATABASE IMPORT MAPPING TEST SUITE');
