/**
 * @license
 * AnalysisDataPath resolver & XML↔DB link tests (Step 1 of the implementation
 * order: Test 2 – AnalysisDataPath → share/PIONEER/USBANLZ → ANLZ file).
 *
 * Verifies deterministic resolution only: absolute paths verbatim,
 * device-relative PIONEER forms against <dbDir>/share, everything else → null
 * (no searching, no guessing, no track-name reconstruction). Plus the exact
 * audio-path match used to link XML tracks to database analysis references.
 *
 * Run with: npx tsx tests/analysis-resolver.test.ts
 */

import {
  buildDbAnalysisIndex,
  buildDbAnalysisIdIndex,
  dirOfPath,
  joinAudioPath,
  normalizeAudioKey,
  resolveAnalysisFilePath,
  resolveVerifiedDbIdentity,
} from '../src/rekordbox/analysisResolver';

import { runTest, assert, same, report } from './helpers/microTest.mjs';

const WIN_DB_DIR = 'C:\\Users\\dj\\AppData\\Roaming\\Pioneer\\rekordbox7';
const POSIX_DB_DIR = '/media/usb-device';
const UUID = '9f3c1a2b-4d5e-6f70-8899-aabbccddeeff';

// ─── SUITE 1: Device-relative resolution against <dbDir>/share ──────────────
runTest('share resolution', 'Leading-slash PIONEER form resolves under Windows dbDir', () => {
  const resolved = resolveAnalysisFilePath(
    WIN_DB_DIR,
    `/PIONEER/USBANLZ/0e8/${UUID}/ANLZ0000.DAT`
  );
  same(
    resolved,
    `${WIN_DB_DIR}\\share\\PIONEER\\USBANLZ\\0e8\\${UUID}\\ANLZ0000.DAT`,
    'Windows share path'
  );
});

runTest('share resolution', 'Slash-less PIONEER form resolves under POSIX dbDir', () => {
  const resolved = resolveAnalysisFilePath(POSIX_DB_DIR, `PIONEER/USBANLZ/0e8/${UUID}/ANLZ0000.DAT`);
  same(resolved, `${POSIX_DB_DIR}/share/PIONEER/USBANLZ/0e8/${UUID}/ANLZ0000.DAT`, 'POSIX share path');
});

runTest('share resolution', 'Explicit share/ prefix is not duplicated', () => {
  const resolved = resolveAnalysisFilePath(WIN_DB_DIR, `share/PIONEER/USBANLZ/0e8/${UUID}/ANLZ0000.DAT`);
  same(
    resolved,
    `${WIN_DB_DIR}\\share\\PIONEER\\USBANLZ\\0e8\\${UUID}\\ANLZ0000.DAT`,
    'No doubled share segment'
  );
});

runTest('share resolution', 'Tag casing is preserved, matching is case-insensitive', () => {
  const resolved = resolveAnalysisFilePath(POSIX_DB_DIR, '/pioneer/usbanlz/0e8/abc/ANLZ0000.DAT');
  same(resolved, `${POSIX_DB_DIR}/share/pioneer/usbanlz/0e8/abc/ANLZ0000.DAT`, 'Tail case preserved');
});

// ─── SUITE 2: Absolute paths pass through verbatim ──────────────────────────
runTest('absolute paths', 'Windows drive path is used verbatim', () => {
  const abs = 'E:\\PIONEER\\USBANLZ\\0e8\\abc\\ANLZ0000.DAT';
  same(resolveAnalysisFilePath(WIN_DB_DIR, abs), abs, 'Verbatim drive path');
  same(resolveAnalysisFilePath(undefined, abs), abs, 'No dbDir needed');
});

runTest('absolute paths', 'UNC path is used verbatim', () => {
  const unc = '\\\\NAS\\rekordbox\\PIONEER\\USBANLZ\\ANLZ0000.DAT';
  same(resolveAnalysisFilePath(undefined, unc), unc, 'Verbatim UNC path');
});

// ─── SUITE 3: No guessing ───────────────────────────────────────────────────
runTest('no guessing', 'Unknown relative forms resolve to null', () => {
  same(resolveAnalysisFilePath(WIN_DB_DIR, 'Music/track.dat'), null, 'Bare relative path');
  same(resolveAnalysisFilePath(WIN_DB_DIR, 'ANLZ0000.DAT'), null, 'Bare file name');
  same(resolveAnalysisFilePath(WIN_DB_DIR, '/tmp/ANLZ0000.DAT'), null, 'Foreign absolute path');
  same(resolveAnalysisFilePath(WIN_DB_DIR, ''), null, 'Empty value');
  same(resolveAnalysisFilePath(WIN_DB_DIR, null), null, 'Null value');
});

runTest('no guessing', 'Relative PIONEER form without dbDir resolves to null', () => {
  same(resolveAnalysisFilePath(undefined, '/PIONEER/USBANLZ/0e8/abc/ANLZ0000.DAT'), null, 'No anchor');
  same(resolveAnalysisFilePath('', '/PIONEER/USBANLZ/0e8/abc/ANLZ0000.DAT'), null, 'Empty anchor');
});

// ─── SUITE 4: dirOfPath ─────────────────────────────────────────────────────
runTest('dirOfPath', 'Extracts parent directories on both separator styles', () => {
  same(dirOfPath('C:\\Users\\dj\\master.db'), 'C:\\Users\\dj', 'Windows parent');
  same(dirOfPath('/media/usb/exportLibrary.db'), '/media/usb', 'POSIX parent');
  same(dirOfPath('C:\\Users\\dj\\'), 'C:\\Users', 'dirname semantics on trailing separator');
});

// ─── SUITE 5: XML↔DB exact audio-path link ──────────────────────────────────
runTest('audio key', 'XML file:// LOCATION and DB Windows path produce equal keys', () => {
  const xmlLocation = 'file://localhost/C:/Music/Ref%20Mix.wav';
  const dbLocation = 'C:\\Music\\Ref Mix.wav';
  same(normalizeAudioKey(xmlLocation), normalizeAudioKey(dbLocation), 'Key equality');
  same(normalizeAudioKey(dbLocation), 'c:/music/ref mix.wav', 'Canonical key form');
});

runTest('audio key', 'Different files never collide', () => {
  assert(
    normalizeAudioKey('C:\\Music\\A.wav') !== normalizeAudioKey('C:\\Music\\B.wav'),
    'Distinct keys'
  );
  same(normalizeAudioKey(''), '', 'Empty input');
  same(normalizeAudioKey(null), '', 'Null input');
});

runTest('db index', 'Index links exact matches and skips incomplete rows', () => {
  const index = buildDbAnalysisIndex(
    [
      {
        id: 'db-1',
        originalMedia: { location: 'C:\\Music\\Ref Mix.wav' },
        rawXmlAttributes: { analysisDataPath: '/PIONEER/USBANLZ/0e8/u1/ANLZ0000.DAT' },
      },
      {
        id: 'db-2',
        originalMedia: { location: 'C:\\Music\\NoAnlz.wav' },
        rawXmlAttributes: {},
      },
      { id: 'db-3', rawXmlAttributes: { analysisDataPath: '/PIONEER/USBANLZ/0e8/u3/ANLZ0000.DAT' } },
    ],
    WIN_DB_DIR
  );
  same(index.size, 1, 'Only complete rows indexed');
  const hit = index.get(normalizeAudioKey('file://localhost/C:/Music/Ref%20Mix.wav'));
  assert(hit !== undefined, 'Exact XML location hits');
  same(hit!.trackId, 'db-1', 'Linked DB track');
  same(hit!.analysisDataPath, '/PIONEER/USBANLZ/0e8/u1/ANLZ0000.DAT', 'Linked AnalysisDataPath');
  same(hit!.sourceDbDir, WIN_DB_DIR, 'Linked source dir');
  same(index.get(normalizeAudioKey('C:\\Music\\Other.wav')), undefined, 'No fuzzy match');
});

runTest('guarded identity', 'Rekordbox 7.2.16 requires matching ID and exact Location', () => {
  const idIndex = buildDbAnalysisIdIndex(
    [{
      id: '4711',
      originalMedia: { location: 'C:\\Music\\Exact.wav' },
      rawXmlAttributes: { analysisDataPath: '/PIONEER/USBANLZ/0e8/u1/ANLZ0000.DAT' },
    }],
    WIN_DB_DIR
  );
  assert(resolveVerifiedDbIdentity(idIndex, '4711', 'file://localhost/C:/Music/Exact.wav') !== null,
    'same XML TrackID/djmdContent.ID and path accepted');
  same(resolveVerifiedDbIdentity(idIndex, '9999', 'file://localhost/C:/Music/Exact.wav'), null,
    'path-only match rejected');
  same(resolveVerifiedDbIdentity(idIndex, '4711', 'file://localhost/C:/Music/Other.wav'), null,
    'ID-only match with wrong path rejected');
});

runTest('guarded identity', 'Separate DB rows sharing one audio file retain their own IDs', () => {
  const shared = 'C:\\Music\\Shared.wav';
  const idIndex = buildDbAnalysisIdIndex([
    { id: '100', originalMedia: { location: shared }, rawXmlAttributes: { analysisDataPath: '/PIONEER/USBANLZ/a/u1/ANLZ0000.DAT' } },
    { id: '101', originalMedia: { location: shared }, rawXmlAttributes: { analysisDataPath: '/PIONEER/USBANLZ/b/u2/ANLZ0000.DAT' } },
  ], WIN_DB_DIR);
  same(idIndex.size, 2, 'both content identities retained');
  same(resolveVerifiedDbIdentity(idIndex, '100', shared)?.trackId, '100', 'first exact row');
  same(resolveVerifiedDbIdentity(idIndex, '101', shared)?.trackId, '101', 'second exact row');
});

runTest('path safety', 'Traversal and non-USBANLZ paths are rejected', () => {
  same(resolveAnalysisFilePath(WIN_DB_DIR, '/PIONEER/USBANLZ/../secret/ANLZ0000.DAT'), null,
    'parent traversal rejected');
  same(resolveAnalysisFilePath(WIN_DB_DIR, '/PIONEER/ARTWORK/x/ANLZ0000.DAT'), null,
    'non-USBANLZ path rejected');
});

// ─── SUITE 6: exact Rekordbox 7 address forms ───────────────────────────────
runTest('DB media address', 'FolderPath already containing FileNameL is not duplicated', () => {
  same(
    joinAudioPath('G:\\Music\\Artist\\track.mp3', 'track.mp3'),
    'G:\\Music\\Artist\\track.mp3',
    'Full FolderPath remains the exact DB address'
  );
  same(
    joinAudioPath('G:\\Music\\Artist\\', 'track.mp3'),
    'G:\\Music\\Artist\\track.mp3',
    'Directory FolderPath receives the filename once'
  );
});

runTest('DB media address', 'XML contents_ path resolves to the same exact DB row', () => {
  const sourceDbDir = 'D:\\PIONEER\\Master';
  const analysisDataPath = '/PIONEER/USBANLZ/0e8/u9/ANLZ0000.DAT';
  const index = buildDbAnalysisIndex(
    [{
      id: 'db-rb7',
      originalMedia: {
        location: 'D:\\PIONEER\\Master\\contents_4136090260\\artist\\album\\track.mp3',
      },
      rawXmlAttributes: { analysisDataPath },
    }],
    sourceDbDir
  );
  const xmlLocation = 'file://localhost//contents_4136090260/artist/album/track.mp3';
  const hit = index.get(normalizeAudioKey(xmlLocation));
  assert(hit !== undefined, 'Relative XML address hits the exact absolute DB row');
  same(hit!.analysisDataPath, analysisDataPath, 'The DB AnalysisDataPath is retained verbatim');
  same(
    resolveAnalysisFilePath(hit!.sourceDbDir, hit!.analysisDataPath),
    'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\0e8\\u9\\ANLZ0000.DAT',
    'The final ANLZ address is derived directly from master.db'
  );
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────

report('ANALYSISDATAPATH RESOLVER & XML↔DB LINK TEST SUITE');
