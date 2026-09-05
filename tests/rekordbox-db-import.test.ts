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

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

function runTest(suite: string, name: string, testFn: () => void) {
  const t0 = performance.now();
  try {
    testFn();
    results.push({ suite, name, passed: true, durationMs: Math.round((performance.now() - t0) * 100) / 100 });
  } catch (err: any) {
    results.push({
      suite,
      name,
      passed: false,
      error: err?.message || String(err),
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
    });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`Assertion Failed [${message}]: expected ${expected}, got ${actual}`);
  }
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  REKORDBOX 6/7 DATABASE IMPORT MAPPING TEST SUITE              ');
console.log('═══════════════════════════════════════════════════════════════════\n');

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
  assertEqual(mapped.tracks.length, 2, 'Track count');
  const track = mapped.tracks[0]!;

  assertEqual(track.title, 'Obsidian Voltage (Club Mix)', 'Title');
  assertEqual(track.artist, 'Klangfeld', 'Artist join');
  assertEqual(track.album, 'Subterranean Records', 'Album join');
  assertEqual(track.genre, 'Techno', 'Genre join');
  assertEqual(track.key, '6A', 'Key join');
  assertEqual(track.bpm, 128, 'BPM /100');
  assertEqual(Math.round(track.duration! * 1000), 240000, 'Duration from ms');
  assertEqual(track.rating, 5, 'Rating 255 -> 5');
  assertEqual(track.playCount, 18, 'Play count');
  assert(track.originalMedia?.location === 'C:\\Music\\Obsidian Voltage.wav', 'File location');
  assertEqual(track.origin, DataOrigin.REKORDBOX_DB, 'DB origin');
});

runTest('master.db mapping', 'Decodes memory cues, hot cues and loops with beat alignment', () => {
  const mapped = mapRekordboxDatabaseRows(masterRows, 'MASTER_DB');
  const track = mapped.tracks[0]!;
  const cues = track.cues || [];
  const loops = track.loops || [];

  assertEqual(cues.filter((c) => c.type === 'MEMORY').length, 2, 'Memory cues');
  assertEqual(cues.filter((c) => c.type === 'HOT_CUE').length, 2, 'Hot cues');
  const hotA = cues.find((c) => c.type === 'HOT_CUE' && c.hotCueNum === 0);
  assert(hotA !== undefined, 'Hot A exists');
  assertEqual(hotA!.letter, 'A', 'Hot A letter');
  assertEqual(hotA!.comment, 'Hot A', 'Hot A comment');
  assertEqual(loops.length, 1, 'Loop count');
  assertEqual(Math.round(loops[0].start * 1000), 75000, 'Loop start');
  assertEqual(Math.round(loops[0].end * 1000), 90000, 'Loop end');
  // Stats are global across all tracks (incl. the second fixture track).
  assertEqual(mapped.stats.memoryCues, 3, 'Stats memory cues');
  assertEqual(mapped.stats.hotCues, 2, 'Stats hot cues');
  assertEqual(mapped.stats.loops, 1, 'Stats loops');
});

runTest('master.db mapping', 'Missing path remains a metadata-only track', () => {
  const mapped = mapRekordboxDatabaseRows(masterRows, 'MASTER_DB');
  const track = mapped.tracks[1]!;
  assertEqual(track.originalMedia, undefined, 'No original media reference');
  assertEqual(track.duration, 210, 'Duration preserved');
});

// ─── SUITE 2: OneLibrary mapping ────────────────────────────────────────────
runTest('OneLibrary mapping', 'Maps camelCase OneLibrary rows to the shared contract', () => {
  const mapped = mapRekordboxDatabaseRows(oneLibraryRows, 'ONE_LIBRARY');
  assertEqual(mapped.tracks.length, 1, 'Track count');
  const track = mapped.tracks[0]!;

  assertEqual(track.id, '55', 'Content id');
  assertEqual(track.title, 'Quantum Velocity (VIP Roller)', 'Title');
  assertEqual(track.artist, 'Subsonic Pulse', 'Artist join');
  assertEqual(track.album, 'Neurofunk Archives', 'Album join');
  assertEqual(track.genre, 'Drum & Bass', 'Genre join');
  assertEqual(track.key, '4A', 'Key join');
  assertEqual(track.bpm, 174, 'BPM');
  assertEqual(track.sampleRate, 48000, 'Sample rate');
  assertEqual(track.duration, 190, 'Duration');
  assertEqual(track.rating, 5, 'Rating stays 0..5');
  assert(track.originalMedia?.location.includes('Quantum Velocity.flac'), 'Location');
});

runTest('OneLibrary mapping', 'Decodes microsecond cue positions', () => {
  const mapped = mapRekordboxDatabaseRows(oneLibraryRows, 'ONE_LIBRARY');
  const cues = mapped.tracks[0]!.cues || [];
  assertEqual(cues.length, 2, 'Cue count');
  assertEqual(Math.round(cues[0].position * 1000), 0, 'Memory cue position');
  assertEqual(Math.round(cues[1].position * 1000), 44138, 'Hot cue position (us -> ms)');
  assertEqual(cues[1].type, 'HOT_CUE', 'Hot cue type');
});

// ─── SUITE 3: Deck expansion ────────────────────────────────────────────────
runTest('Deck expansion', 'Builds a playable-format TrackModel without synthetic audio', () => {
  const mapped = mapRekordboxDatabaseRows(masterRows, 'MASTER_DB');
  const deck = buildDeckTrackFromDatabase(mapped.tracks[0]!);
  assertEqual(deck.audioBuffer, null, 'No synthetic audio');
  assertEqual(deck.beatGrid.bpm, 128, 'Beat grid bpm');
  assert(deck.beatGrid.beats.length > 0, 'Dense grid generated on load');
  assertEqual(deck.beatGrid.origin, DataOrigin.REKORDBOX_DB, 'Beat grid DB origin');
  assertEqual(deck.origin, DataOrigin.REKORDBOX_DB, 'Track DB origin');
  assertEqual(deck.originalSha256, 'NOT_COMPUTED_READ_ONLY_SOURCE', 'Read-only checksum marker');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────
console.log('Test Results:\n');
let passedCount = 0;
let failedCount = 0;

results.forEach((r, idx) => {
  const icon = r.passed ? ' PASS ' : ' FAIL ';
  const status = r.passed ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  console.log(`${status}[${icon}]${reset} #${idx + 1} [${r.suite}] ${r.name} (${r.durationMs}ms)`);
  if (!r.passed) {
    console.error(`       Error: ${r.error}`);
    failedCount++;
  } else {
    passedCount++;
  }
});

console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Total: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

if (failedCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
