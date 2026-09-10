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
  dirOfPath,
  normalizeAudioKey,
  resolveAnalysisFilePath,
  seedAnlzIndexFromDb,
} from '../src/rekordbox/analysisResolver';

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
console.log('  ANALYSISDATAPATH RESOLVER & XML↔DB LINK TEST SUITE            ');
console.log('═══════════════════════════════════════════════════════════════════\n');

const WIN_DB_DIR = 'C:\\Users\\dj\\AppData\\Roaming\\Pioneer\\rekordbox7';
const POSIX_DB_DIR = '/media/usb-device';
const UUID = '9f3c1a2b-4d5e-6f70-8899-aabbccddeeff';

// ─── SUITE 1: Device-relative resolution against <dbDir>/share ──────────────
runTest('share resolution', 'Leading-slash PIONEER form resolves under Windows dbDir', () => {
  const resolved = resolveAnalysisFilePath(
    WIN_DB_DIR,
    `/PIONEER/USBANLZ/0e8/${UUID}/ANLZ0000.DAT`
  );
  assertEqual(
    resolved,
    `${WIN_DB_DIR}\\share\\PIONEER\\USBANLZ\\0e8\\${UUID}\\ANLZ0000.DAT`,
    'Windows share path'
  );
});

runTest('share resolution', 'Slash-less PIONEER form resolves under POSIX dbDir', () => {
  const resolved = resolveAnalysisFilePath(POSIX_DB_DIR, `PIONEER/USBANLZ/0e8/${UUID}/ANLZ0000.DAT`);
  assertEqual(resolved, `${POSIX_DB_DIR}/share/PIONEER/USBANLZ/0e8/${UUID}/ANLZ0000.DAT`, 'POSIX share path');
});

runTest('share resolution', 'Explicit share/ prefix is not duplicated', () => {
  const resolved = resolveAnalysisFilePath(WIN_DB_DIR, `share/PIONEER/USBANLZ/0e8/${UUID}/ANLZ0000.DAT`);
  assertEqual(
    resolved,
    `${WIN_DB_DIR}\\share\\PIONEER\\USBANLZ\\0e8\\${UUID}\\ANLZ0000.DAT`,
    'No doubled share segment'
  );
});

runTest('share resolution', 'Tag casing is preserved, matching is case-insensitive', () => {
  const resolved = resolveAnalysisFilePath(POSIX_DB_DIR, '/pioneer/usbanlz/0e8/abc/ANLZ0000.DAT');
  assertEqual(resolved, `${POSIX_DB_DIR}/share/pioneer/usbanlz/0e8/abc/ANLZ0000.DAT`, 'Tail case preserved');
});

// ─── SUITE 2: Absolute paths pass through verbatim ──────────────────────────
runTest('absolute paths', 'Windows drive path is used verbatim', () => {
  const abs = 'E:\\PIONEER\\USBANLZ\\0e8\\abc\\ANLZ0000.DAT';
  assertEqual(resolveAnalysisFilePath(WIN_DB_DIR, abs), abs, 'Verbatim drive path');
  assertEqual(resolveAnalysisFilePath(undefined, abs), abs, 'No dbDir needed');
});

runTest('absolute paths', 'UNC path is used verbatim', () => {
  const unc = '\\\\NAS\\rekordbox\\PIONEER\\USBANLZ\\ANLZ0000.DAT';
  assertEqual(resolveAnalysisFilePath(undefined, unc), unc, 'Verbatim UNC path');
});

// ─── SUITE 3: No guessing ───────────────────────────────────────────────────
runTest('no guessing', 'Unknown relative forms resolve to null', () => {
  assertEqual(resolveAnalysisFilePath(WIN_DB_DIR, 'Music/track.dat'), null, 'Bare relative path');
  assertEqual(resolveAnalysisFilePath(WIN_DB_DIR, 'ANLZ0000.DAT'), null, 'Bare file name');
  assertEqual(resolveAnalysisFilePath(WIN_DB_DIR, '/tmp/ANLZ0000.DAT'), null, 'Foreign absolute path');
  assertEqual(resolveAnalysisFilePath(WIN_DB_DIR, ''), null, 'Empty value');
  assertEqual(resolveAnalysisFilePath(WIN_DB_DIR, null), null, 'Null value');
});

runTest('no guessing', 'Relative PIONEER form without dbDir resolves to null', () => {
  assertEqual(resolveAnalysisFilePath(undefined, '/PIONEER/USBANLZ/0e8/abc/ANLZ0000.DAT'), null, 'No anchor');
  assertEqual(resolveAnalysisFilePath('', '/PIONEER/USBANLZ/0e8/abc/ANLZ0000.DAT'), null, 'Empty anchor');
});

// ─── SUITE 4: dirOfPath ─────────────────────────────────────────────────────
runTest('dirOfPath', 'Extracts parent directories on both separator styles', () => {
  assertEqual(dirOfPath('C:\\Users\\dj\\master.db'), 'C:\\Users\\dj', 'Windows parent');
  assertEqual(dirOfPath('/media/usb/exportLibrary.db'), '/media/usb', 'POSIX parent');
  assertEqual(dirOfPath('C:\\Users\\dj\\'), 'C:\\Users', 'dirname semantics on trailing separator');
});

// ─── SUITE 5: XML↔DB exact audio-path link ──────────────────────────────────
runTest('audio key', 'XML file:// LOCATION and DB Windows path produce equal keys', () => {
  const xmlLocation = 'file://localhost/C:/Music/Ref%20Mix.wav';
  const dbLocation = 'C:\\Music\\Ref Mix.wav';
  assertEqual(normalizeAudioKey(xmlLocation), normalizeAudioKey(dbLocation), 'Key equality');
  assertEqual(normalizeAudioKey(dbLocation), 'c:/music/ref mix.wav', 'Canonical key form');
});

runTest('audio key', 'Different files never collide', () => {
  assert(
    normalizeAudioKey('C:\\Music\\A.wav') !== normalizeAudioKey('C:\\Music\\B.wav'),
    'Distinct keys'
  );
  assertEqual(normalizeAudioKey(''), '', 'Empty input');
  assertEqual(normalizeAudioKey(null), '', 'Null input');
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
  assertEqual(index.size, 1, 'Only complete rows indexed');
  const hit = index.get(normalizeAudioKey('file://localhost/C:/Music/Ref%20Mix.wav'));
  assert(hit !== undefined, 'Exact XML location hits');
  assertEqual(hit!.trackId, 'db-1', 'Linked DB track');
  assertEqual(hit!.analysisDataPath, '/PIONEER/USBANLZ/0e8/u1/ANLZ0000.DAT', 'Linked AnalysisDataPath');
  assertEqual(hit!.sourceDbDir, WIN_DB_DIR, 'Linked source dir');
  assertEqual(index.get(normalizeAudioKey('C:\\Music\\Other.wav')), undefined, 'No fuzzy match');
});

// ─── SUITE 6: DB-first seeding (exact targets from master.db, no scanning) ──
// master.db stores the EXACT AnalysisDataPath per track. The resolver must
// seed the ANLZ index from those exact targets (deterministic, zero
// filesystem access) and leave ONLY genuinely unknown targets as fallback.
const D_DRIVE_DB_DIR = 'D:\\PIONEER\\Master';

runTest('db-first', 'Relative AnalysisDataPath resolves to exact <dbDir>/share/PIONEER/USBANLZ path', () => {
  const dbIndex = buildDbAnalysisIndex(
    [
      {
        id: 'db-1',
        originalMedia: { location: 'D:\\Music\\Ref Mix.wav' },
        rawXmlAttributes: { analysisDataPath: '/PIONEER/USBANLZ/0e8/u1/ANLZ0000.DAT' },
      },
    ],
    D_DRIVE_DB_DIR
  );
  const { entries, unresolved } = seedAnlzIndexFromDb(['D:\\Music\\Ref Mix.wav'], dbIndex);
  assertEqual(unresolved.length, 0, 'No fallback needed — exact DB target');
  const hit = entries.get(normalizeAudioKey('D:\\Music\\Ref Mix.wav'));
  assert(hit !== undefined, 'Entry seeded');
  assertEqual(
    hit!.datPath,
    'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\0e8\\u1\\ANLZ0000.DAT',
    'DAT resolved against the database directory (exact target)'
  );
  assertEqual(
    hit!.extPath,
    'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\0e8\\u1\\ANLZ0000.EXT',
    'EXT sibling derived deterministically'
  );
  assertEqual(hit!.matchTier, 1, 'Exact match tier');
});

runTest('db-first', 'Absolute AnalysisDataPath is used verbatim (DAT and EXT both honored)', () => {
  const dbIndex = buildDbAnalysisIndex(
    [
      {
        id: 'db-1',
        originalMedia: { location: 'D:\\Music\\A.wav' },
        rawXmlAttributes: { analysisDataPath: 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\aa\\ANLZ0001.EXT' },
      },
    ],
    D_DRIVE_DB_DIR
  );
  const { entries, unresolved } = seedAnlzIndexFromDb(['D:\\Music\\A.wav'], dbIndex);
  assertEqual(unresolved.length, 0, 'No fallback needed');
  const hit = entries.get(normalizeAudioKey('D:\\Music\\A.wav'));
  assert(hit !== undefined, 'Entry seeded');
  assertEqual(hit!.extPath, 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\aa\\ANLZ0001.EXT', 'EXT verbatim');
  assertEqual(hit!.datPath, 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\aa\\ANLZ0001.DAT', 'DAT sibling derived');
});

runTest('db-first', 'Targets absent from the DB are the ONLY fallback (unresolved)', () => {
  const dbIndex = buildDbAnalysisIndex(
    [
      {
        id: 'db-1',
        originalMedia: { location: 'D:\\Music\\InDb.wav' },
        rawXmlAttributes: { analysisDataPath: '/PIONEER/USBANLZ/0e8/u1/ANLZ0000.DAT' },
      },
    ],
    D_DRIVE_DB_DIR
  );
  const { entries, unresolved } = seedAnlzIndexFromDb(
    ['D:\\Music\\InDb.wav', 'D:\\Music\\NotInDb.wav', 'E:\\Other\\Volume.wav'],
    dbIndex
  );
  assertEqual(entries.size, 1, 'Only the DB-known target seeded');
  assertEqual(unresolved.length, 2, 'Exactly the two unknown targets left for fallback');
  assert(unresolved.includes('D:\\Music\\NotInDb.wav'), 'Unknown drive-D target');
  assert(unresolved.includes('E:\\Other\\Volume.wav'), 'Other-volume target');
});

runTest('db-first', 'Unresolvable relative form is NOT guessed — stays in fallback', () => {
  const dbIndex = buildDbAnalysisIndex(
    [
      {
        id: 'db-1',
        originalMedia: { location: 'D:\\Music\\Weird.wav' },
        rawXmlAttributes: { analysisDataPath: 'some/random/relative.DAT' },
      },
    ],
    D_DRIVE_DB_DIR
  );
  const { entries, unresolved } = seedAnlzIndexFromDb(['D:\\Music\\Weird.wav'], dbIndex);
  assertEqual(entries.size, 0, 'No guess — nothing seeded');
  assertEqual(unresolved.length, 1, 'Left to the PPTH fallback, never a fabricated path');
});

runTest('db-first', 'Empty targets → nothing seeded, nothing unresolved (zero file scans)', () => {
  const dbIndex = buildDbAnalysisIndex([], D_DRIVE_DB_DIR);
  const { entries, unresolved } = seedAnlzIndexFromDb([], dbIndex);
  assertEqual(entries.size, 0, 'No entries');
  assertEqual(unresolved.length, 0, 'No fallback → no scan');
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
