/**
 * @license
 * EXACT-PATHS END-TO-END (E1–E5) — reproduziert den Diagnosebericht 1:1.
 *
 * Szenario (Diagnosebericht v0.5.6, rekordbox_export.xml, 18:07):
 *   master.db auf D:\PIONEER\Master (Rekordbox 7, Library-Medien unter
 *   contents_4136090260/…), XML-Collection mit LOCATIONs in der
 *   Export-Form file://localhost//contents_4136090260/… und file://
 *   localhost/G:/… — die App muss die exakten Pfade aus der DB bekommen
 *   OHNE Dateisystem-Suche.
 *
 * Kette (exakt die Produktionsfunktionen):
 *   mapRekordboxDatabaseRows → buildDbAnalysisIndex → queryDbForExactPaths
 *   → seedAnlzIndexFromDb
 *
 * Run with: npx tsx tests/exact-paths-e2e.test.ts
 */

import { mapRekordboxDatabaseRows } from '../src/rekordbox/dbParser';
import {
  buildDbAnalysisIndex,
  normalizeAudioKey,
  queryDbForExactPaths,
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

// ─── Das reale Datenbild aus dem Diagnosebericht ────────────────────────────
const DB_DIR = 'D:\\PIONEER\\Master';
const LIB = 'D:\\PIONEER\\Master\\contents_4136090260\\unknownartist\\unknownalbum';

// djmdContent-Rows wie in der master.db (Spaltennamen der echten Schema-Abfrage).
const masterRows = {
  content: [
    {
      ID: '1001',
      Title: 'skirmish (Original Mix)',
      ArtistID: '1',
      FileNameL: 'andreas henneberg  skirmish original mix.mp3',
      FolderPath: LIB,
      AnalysisDataPath: '/PIONEER/USBANLZ/0e8/aaa1/ANLZ0000.DAT',
      BPM: 12800,
      Length: 340000,
      SamplingRate: 44100,
      Rating: 0,
      DJPlayCount: 3,
    },
    {
      ID: '1002',
      Title: 'Homeless',
      ArtistID: '2',
      FileNameL: 'ben dust  homeless.mp3',
      FolderPath: LIB,
      AnalysisDataPath: '/PIONEER/USBANLZ/0e8/aaa2/ANLZ0000.DAT',
      BPM: 12600,
      Length: 300000,
      SamplingRate: 44100,
      Rating: 0,
      DJPlayCount: 0,
    },
    {
      ID: '1003',
      Title: 'Quicksand (Boy 8 Bit mix)',
      ArtistID: '3',
      FileNameL: 'La Roux - Quicksand (Boy 8 Bit mix).mp3',
      FolderPath: 'G:\\mp3 traktor\\neu 2015',
      AnalysisDataPath: '/PIONEER/USBANLZ/0e8/aaa3/ANLZ0000.DAT',
      BPM: 13005,
      Length: 357000,
      SamplingRate: 44100,
      Rating: 0,
      DJPlayCount: 1,
    },
    {
      ID: '1004',
      Title: 'No Analysis',
      ArtistID: '1',
      FileNameL: 'no anlz track.mp3',
      FolderPath: LIB,
      AnalysisDataPath: null,
      BPM: 12800,
      Length: 200000,
      SamplingRate: 44100,
      Rating: 0,
      DJPlayCount: 0,
    },
  ],
  cues: [],
  artists: [
    { ID: '1', Name: 'Andreas Henneberg' },
    { ID: '2', Name: 'Ben Dust' },
    { ID: '3', Name: 'La Roux' },
  ],
  albums: [],
  genres: [],
  keys: [],
  labels: [],
  playlists: [],
  songPlaylists: [],
};

// XML-LOCATIONs in der EXAKTEN Form des Exports (bericht: %20-encodiert,
// file://localhost//contents_… relativ, file://localhost/G:/… absolut).
const xmlLocations: (string | null | undefined)[] = [
  'file://localhost//contents_4136090260/unknownartist/unknownalbum/andreas%20henneberg%20%20skirmish%20original%20mix.mp3',
  'file://localhost//contents_4136090260/unknownartist/unknownalbum/ben%20dust%20%20homeless.mp3',
  'file://localhost/G:/mp3%20traktor/neu%202015/La%20Roux%20-%20Quicksand%20(Boy%208%20Bit%20mix).mp3',
  'file://localhost//contents_4136090260/unknownartist/unknownalbum/no%20anlz%20track.mp3',
  'file://localhost/H:/nicht%20in%20der%20db/old%20track.mp3',
];

console.log('═══════════════════════════════════════════════════════════════');
console.log('  EXACT-PATHS E2E — Diagnosebericht-Szenario 1:1 (E1–E5)       ');
console.log('═══════════════════════════════════════════════════════════════\n');

// E1: Die DB-Rows mappen auf die richtigen Audio-Pfade (joinWindowsPath).
const mapped = mapRekordboxDatabaseRows(masterRows, 'MASTER_DB');
const byId = new Map(mapped.tracks.map((t) => [t.id, t]));

runTest('e2e', 'E1: DB-Rows → Audio-Pfade (Library + G: Media)', () => {
  assertEqual(byId.get('1001')!.originalMedia?.location, LIB + '\\andreas henneberg  skirmish original mix.mp3', 'Library-Pfad absolut');
  assertEqual(byId.get('1003')!.originalMedia?.location, 'G:\\mp3 traktor\\neu 2015\\La Roux - Quicksand (Boy 8 Bit mix).mp3', 'G:-Pfad absolut');
});

// E2: Der DB-Index trägt die exakten Ziele — full + relative Keys.
const toIndexInput = (t: (typeof mapped.tracks)[number]) => ({
  id: t.id ?? 'db-track',
  originalMedia: t.originalMedia,
  rawXmlAttributes: { ...(t.rawXmlAttributes ?? {}), sourceDbDir: DB_DIR },
});
const dbIndex = buildDbAnalysisIndex(
  mapped.tracks.map(toIndexInput),
  DB_DIR
);

runTest('e2e', 'E2: DB-Index mit exakten Zielen (full + relative Keys), leere AnalysisDataPath wird nicht gelinkt', () => {
  assert(dbIndex.size > 0, 'Index nicht leer (dbLinks > 0 — das v0.5.6-Problem „dbLinks: 0“)');
  const rel = 'contents_4136090260/unknownartist/unknownalbum/andreas henneberg  skirmish original mix.mp3';
  assert(dbIndex.has('d:/pioneer/master/' + rel), 'Full-Key (DB-Absolute Form)');
  assert(dbIndex.has('/' + rel), 'Relative Key (XML-Export-Form mit führendem Slash)');
  assert(dbIndex.has('g:/mp3 traktor/neu 2015/la roux - quicksand (boy 8 bit mix).mp3'), 'G:-Track per absolutem Pfad');
  assert(!dbIndex.has('/contents_4136090260/unknownartist/unknownalbum/no anlz track.mp3'), 'Track ohne AnalysisDataPath: kein Ziel');
});

// E3: Die Abfrage der Datenbank (Schritt 1) beantwortet die XML-Collection.
const query = queryDbForExactPaths(xmlLocations, dbIndex);

runTest('e2e', 'E3: DB-Abfrage — 3 exakte Pfade, 2 ehrlich als unbekannt gemeldet', () => {
  assertEqual(query.total, 5, 'Alle 5 XML-Tracks abgefragt');
  assertEqual(query.relativeHits, 2, '2 Library-Relative exakte Pfade (contents_…)');
  assertEqual(query.absoluteHits, 1, '1 absoluter exakter Pfad (G:)');
  assertEqual(query.missingCount, 2, '2 Tracks ohne exaktes DB-Ziel (kein AnalysisDataPath / nicht in DB)');
  assert(query.missing.some((m) => m.includes('old track.mp3')), 'Fehlender Track wird namentlich gemeldet');
  assertEqual(query.withoutLocation, 0, 'Alle haben Locations');
});

// E4: Aus den exakten Zielen werden die konkreten ANLZ-Dateien — 0 Dateiscans.
const { entries, unresolved } = seedAnlzIndexFromDb(xmlLocations, dbIndex);

runTest('e2e', 'E4: Exakte Ziele → konkrete DAT/EXT-Pfade, nur die 2 Rest-Treffer brauchen den Fallback-Scan', () => {
  assertEqual(entries.size, 3, '3 Tracks vollständig aus der DB aufgelöst');
  assertEqual(unresolved.length, 2, 'Nur 2 Rest-Treffer (statt 11110) brauchen den Dateiscan');
  const andreas = entries.get(normalizeAudioKey(xmlLocations[0]!))!;
  assertEqual(andreas.datPath, 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\0e8\\aaa1\\ANLZ0000.DAT', 'Exakte DAT-Datei');
  assertEqual(andreas.extPath, 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\0e8\\aaa1\\ANLZ0000.EXT', 'EXT-Schwesterdatei');
  const laroux = entries.get(normalizeAudioKey(xmlLocations[2]!))!;
  assertEqual(laroux.datPath, 'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\0e8\\aaa3\\ANLZ0000.DAT', 'G:-Track bekommt sein exaktes DB-Ziel (La Roux-Fall aus dem Bericht)');
  // Deterministische Auflösung ohne Dateisystem: resolveAnalysisFilePath stimmt überein.
  assertEqual(
    resolveAnalysisFilePath(DB_DIR, '/PIONEER/USBANLZ/0e8/aaa1/ANLZ0000.DAT'),
    'D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\0e8\\aaa1\\ANLZ0000.DAT',
    'Resolver konsistent'
  );
});

// E5: Verkleinerte Simulation des realen Maßstabs: 11110-Zeilen-Szenario —
// jeder DB-bekannte Track wird exakt gelinkt, der Scan betrifft nur den Rest.
runTest('e2e', 'E5: Maßstab — bei 11110 Tracks bleibt der Scan auf den Rest beschränkt', () => {
  const bigRows = { ...masterRows, content: [] as Record<string, any>[] };
  for (let i = 0; i < 11110; i++) {
    const inLib = i % 10 !== 9; // 90% Library-Medien, 10% G:-Media
    const missingAnalysis = i % 10 === 3; // ~10% ohne AnalysisDataPath
    bigRows.content.push({
      ID: String(10000 + i),
      Title: `Track ${i}`,
      ArtistID: '1',
      FileNameL: `track ${i} final mix.mp3`,
      FolderPath: inLib ? LIB : 'G:\\mp3 traktor\\neu 2015',
      AnalysisDataPath: missingAnalysis ? null : `/PIONEER/USBANLZ/0e8/h${i}/ANLZ0000.DAT`,
      BPM: 12800,
      Length: 300000,
      SamplingRate: 44100,
      Rating: 0,
      DJPlayCount: 0,
    });
  }
  const bigMapped = mapRekordboxDatabaseRows(bigRows, 'MASTER_DB');
  const bigIndex = buildDbAnalysisIndex(
    bigMapped.tracks.map(toIndexInput),
    DB_DIR
  );
  const bigLocations = bigMapped.tracks.map((t) => {
    const loc = t.originalMedia?.location ?? '';
    // Library-Medien: wie der echte Export RELATIV (file://localhost//contents_…)
    const dbDirPrefix = 'D:\\PIONEER\\Master\\';
    if (loc.toLowerCase().startsWith(dbDirPrefix.toLowerCase())) {
      return 'file://localhost//' + loc.slice(dbDirPrefix.length).replace(/\\/g, '/');
    }
    // G:-Media: absolut (file://localhost/G:/…)
    return 'file://localhost/' + loc.replace(/\\/g, '/');
  });
  const bigQuery = queryDbForExactPaths(bigLocations, bigIndex);
  const bigSeed = seedAnlzIndexFromDb(bigLocations, bigIndex);
  // 11110 - 1111 (ohne AnalysisDataPath) = 9999 exakte Pfade aus der DB.
  assertEqual(bigQuery.absoluteHits + bigQuery.relativeHits, 9999, '9999 exakte DB-Pfade');
  assertEqual(bigQuery.missingCount, 1111, '1111 ehrlich als unbekannt gemeldet');
  assertEqual(bigSeed.unresolved.length, 1111, 'Scan betrifft nur 10% statt 11110 (v0.5.6: 11110)');
  assert(bigSeed.unresolved.length < bigLocations.length / 9, 'Kein Vollscan mehr über die gesamte Collection');
});

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
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(failedCount > 0 ? 1 : 0);
