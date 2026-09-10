/**
 * @license
 * Original Protection Agent tests (renderer layer):
 *
 * P1 – Path normalization (browser-safe mirror of the main-process rule):
 *      case-folded, slash-unified, '.'/'..' resolved.
 * P2 – Risk classification: READ allowed on originals; every risky
 *      operation on a registered original is blocked; working copies and
 *      unknown paths are allowed.
 * P3 – collectOriginals: gathers track media, clip source media, ANLZ /
 *      database / XML paths, deduplicated.
 * P4 – Intervention explanation: plain German text a layperson can act on
 *      (what / why / consequence / safe alternative).
 * P5 – Agent behavior: guardOperation blocks + notifies exactly once,
 *      syncOriginals updates the protected set, and main-process guard
 *      rejections (ORIGINAL_GUARD_BLOCKED marker) become interventions.
 *
 * The agent is pure monitoring — these tests verify it never mutates its
 * inputs and only produces verdicts and explanations.
 *
 * Run with: npx tsx tests/original-protection-agent.test.ts
 */

import { DataOrigin, TrackModel } from '../src/types/rekordbox';
import {
  OriginalProtectionAgent,
  GuardIntervention,
  buildIntervention,
  classifyRisk,
  collectOriginals,
  normalizeComparablePath,
  OriginalEntry,
} from '../src/agent/originalProtectionAgent';

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
  if (actual !== expected) throw new Error(`Assertion Failed [${message}]: expected ${expected}, got ${actual}`);
}

const AUDIO = 'D:\\Music\\Rekordbox\\Track01.wav';
const COPY = 'D:\\Music\\Rekordbox\\Track01 - Mix.wav';

function makeTrack(id: string, location?: string, resolved?: string): TrackModel {
  return {
    id,
    title: `Track ${id}`,
    artist: 'Artist',
    album: '—',
    bpm: 128,
    key: '8A',
    duration: 60,
    sampleRate: 44100,
    channels: 2,
    originalSha256: 'x',
    isOriginalUntouched: true,
    audioBuffer: null,
    beatGrid: { firstBeat: 0, bpm: 128, meter: 4, origin: DataOrigin.REKORDBOX_ANLZ, beats: [] },
    cues: [],
    loops: [],
    analysis: null,
    origin: DataOrigin.REKORDBOX_XML,
    workingSegments: [],
    originalMedia: location || resolved
      ? { location: location ?? resolved, resolvedPath: resolved, accessMode: 'READ_ONLY', status: 'AVAILABLE' }
      : undefined,
  };
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  ORIGINAL PROTECTION AGENT TEST SUITE (P1–P5)                  ');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ─── P1: Path normalization ─────────────────────────────────────────────────
runTest('P1 normalize', 'Folds case and unifies slash style', () => {
  assertEqual(normalizeComparablePath('D:\\Music\\TRACK01.WAV'), 'd:/music/track01.wav', 'Backslashes + case');
  assertEqual(normalizeComparablePath('d:/music/track01.wav'), 'd:/music/track01.wav', 'Already normalized');
});

runTest('P1 normalize', 'Resolves dot segments', () => {
  assertEqual(
    normalizeComparablePath('D:/Music/Other/../Rekordbox/Track01.wav'),
    'd:/music/rekordbox/track01.wav',
    'Dot segments resolved'
  );
});

// ─── P2: Risk classification ────────────────────────────────────────────────
runTest('P2 classify', 'READ of an original is allowed (originals exist to be read)', () => {
  const v = classifyRisk('READ', AUDIO, [{ path: AUDIO, kind: 'AUDIO' }]);
  assertEqual(v.allowed, true, 'Read allowed');
});

runTest('P2 classify', 'Every risky operation on an original is blocked', () => {
  const originals: OriginalEntry[] = [{ path: AUDIO, kind: 'AUDIO' }];
  for (const op of ['WRITE', 'APPEND', 'OVERWRITE', 'RENAME', 'MOVE', 'DELETE', 'TRUNCATE'] as const) {
    const v = classifyRisk(op, AUDIO, originals);
    assertEqual(v.allowed, false, `${op} blocked`);
    assertEqual(v.verdict, 'BLOCKED_ORIGINAL', `${op} verdict`);
    assertEqual(v.originalPath, AUDIO, `${op} names the original`);
  }
});

runTest('P2 classify', 'Case/slash variants cannot bypass the block', () => {
  const originals: OriginalEntry[] = [{ path: AUDIO, kind: 'AUDIO' }];
  const v = classifyRisk('WRITE', 'd:/music/rekordbox/track01.WAV', originals);
  assertEqual(v.allowed, false, 'Normalized block');
});

runTest('P2 classify', 'Working copies and unknown paths are allowed', () => {
  const originals: OriginalEntry[] = [{ path: AUDIO, kind: 'AUDIO' }];
  assertEqual(classifyRisk('WRITE', COPY, originals).allowed, true, 'Working copy allowed');
  assertEqual(classifyRisk('WRITE', 'D:/Other/brand-new.wav', originals).allowed, true, 'New file allowed');
  assertEqual(classifyRisk('WRITE', '', originals).allowed, true, 'Empty path allowed (nothing to protect)');
});

// ─── P3: collectOriginals ───────────────────────────────────────────────────
runTest('P3 collect', 'Gathers track media, clip sources, ANLZ/DB/XML paths, deduplicated', () => {
  const t1 = makeTrack('t1', AUDIO, 'D:\\Music\\Rekordbox\\Track01.wav');
  const t2 = makeTrack('t2', 'G:\\Library\\Track02.flac');
  const tracks = [t1, t2];
  const clip = {
    id: 'c1',
    name: 'Clip',
    sourceTrackId: 't1',
    sourceTrackName: 'Track t1',
    sourceStart: 0,
    sourceEnd: 8,
    duration: 8,
    beats: 8,
    bars: 2,
    bpm: 128,
    key: '8A',
    color: '#fff',
    origin: DataOrigin.PROJECT,
  };
  const originals = collectOriginals(tracks, [clip], {
    anlzPaths: ['D:\\PIONEER\\USBANLZ\\ANLZ0042.DAT', 'D:\\PIONEER\\USBANLZ\\ANLZ0042.EXT'],
    databasePaths: ['G:\\PIONEER\\rekordbox7\\master.db'],
    xmlPaths: ['C:\\rekordbox.xml'],
  });
  const paths = originals.map((o) => o.path);
  assert(paths.includes(AUDIO), 'Track audio collected');
  assert(paths.includes('G:\\Library\\Track02.flac'), 'Second track collected');
  assert(paths.includes('D:\\PIONEER\\USBANLZ\\ANLZ0042.DAT'), 'ANLZ DAT collected');
  assert(paths.includes('D:\\PIONEER\\USBANLZ\\ANLZ0042.EXT'), 'ANLZ EXT collected');
  assert(paths.includes('G:\\PIONEER\\rekordbox7\\master.db'), 'Database collected');
  assert(paths.includes('C:\\rekordbox.xml'), 'XML collected');
  // Deduplicated by normalized path (location + resolved + clip source overlap).
  assertEqual(originals.length, new Set(originals.map((o) => normalizeComparablePath(o.path))).size, 'No duplicates');
  const kinds = new Map(originals.map((o) => [normalizeComparablePath(o.path), o.kind]));
  assertEqual(kinds.get(normalizeComparablePath(AUDIO)), 'AUDIO', 'Audio kind');
  assertEqual(kinds.get(normalizeComparablePath('D:\\PIONEER\\USBANLZ\\ANLZ0042.DAT')), 'ANLZ', 'ANLZ kind');
  assertEqual(kinds.get(normalizeComparablePath('G:\\PIONEER\\rekordbox7\\master.db')), 'DATABASE', 'DB kind');
});

runTest('P3 collect', 'Tracks without original media contribute nothing', () => {
  const originals = collectOriginals([makeTrack('t1')], []);
  assertEqual(originals.length, 0, 'Nothing collected');
});

// ─── P4: Intervention explanation (layperson-readable) ──────────────────────
runTest('P4 explain', 'Explanation covers what / why / consequence / safe alternative', () => {
  const verdict = classifyRisk('DELETE', AUDIO, [{ path: AUDIO, kind: 'AUDIO' }]);
  const i = buildIntervention(verdict, 'Export');
  assert(i !== null, 'Intervention built');
  const e = i!.explanation;
  assert(e.title.includes('geschützt'), 'Title says protected');
  assert(e.what.includes('Original-Audiodatei'), 'Names the original kind in plain words');
  assert(e.what.includes('löschen'), 'Names the operation in plain words');
  assert(e.what.includes(AUDIO), 'Shows the path');
  assert(e.why.toLowerCase().includes('endgültig'), 'Explains irreversibility');
  assert(e.why.includes('Lesezugriff'), 'Explains the read-only rule');
  assert(e.consequence.includes('irreversibel'), 'Consequence is unambiguous');
  assert(e.safeAlternative.includes('ARBEITSKOPIE'), 'Safe alternative names the working copy');
  assert(e.safeAlternative.includes('NEUE Datei'), 'Safe alternative names the new file');
  assertEqual(i!.originalPath, AUDIO, 'Original carried');
});

runTest('P4 explain', 'Allowed verdicts never produce an intervention', () => {
  const v = classifyRisk('READ', AUDIO, [{ path: AUDIO, kind: 'AUDIO' }]);
  assertEqual(buildIntervention(v), null, 'Read → no intervention');
  const v2 = classifyRisk('WRITE', COPY, [{ path: AUDIO, kind: 'AUDIO' }]);
  assertEqual(buildIntervention(v2), null, 'Working copy → no intervention');
});

// ─── P5: Agent behavior ─────────────────────────────────────────────────────
runTest('P5 agent', 'guardOperation blocks originals and notifies exactly once', () => {
  const agent = new OriginalProtectionAgent();
  const seen: GuardIntervention[] = [];
  const logs: string[] = [];
  agent.setHandler((i) => seen.push(i));
  agent.setLogger((m) => logs.push(m));

  assertEqual(agent.syncOriginals([{ path: AUDIO, kind: 'AUDIO' }]), 1, 'One original protected');
  assertEqual(agent.getProtectedCount(), 1, 'Count visible');

  assertEqual(agent.guardOperation('READ', AUDIO, 'load'), true, 'Read continues');
  assertEqual(agent.guardOperation('WRITE', COPY, 'export'), true, 'Working copy continues');
  assertEqual(agent.guardOperation('DELETE', AUDIO, 'export'), false, 'Original delete blocked');
  assertEqual(seen.length, 1, 'Popup opened exactly once');
  assert(seen[0].explanation.what.includes('löschen'), 'Popup explains the operation');
  assert(logs.length >= 1, 'Intervention logged');
});

runTest('P5 agent', 'Inputs are never mutated by the agent', () => {
  const agent = new OriginalProtectionAgent();
  agent.setHandler(() => {});
  const entry = { path: AUDIO, kind: 'AUDIO' as const };
  const entries = [entry];
  const before = JSON.stringify(entries);
  agent.syncOriginals(entries);
  agent.guardOperation('WRITE', AUDIO, 'x');
  assertEqual(JSON.stringify(entries), before, 'Entries byte-identical');
});

runTest('P5 agent', 'Main-process guard rejection becomes an intervention', () => {
  const agent = new OriginalProtectionAgent();
  const seen: GuardIntervention[] = [];
  agent.setHandler((i) => seen.push(i));

  const guardError = new Error(`ORIGINAL_GUARD_BLOCKED|${COPY}|${AUDIO}|AUDIO`);
  const i = agent.reportMainGuardRejection(guardError, 'Export (WAV/XML/JSON)');
  assert(i !== null, 'Intervention from guard rejection');
  assertEqual(i!.originalPath, AUDIO, 'Original parsed');
  assertEqual(i!.kind, 'AUDIO', 'Kind parsed');
  assert(i!.explanation.safeAlternative.includes('ARBEITSKOPIE'), 'Safe alternative present');
});

runTest('P5 agent', 'Non-guard errors do NOT produce an intervention', () => {
  const agent = new OriginalProtectionAgent();
  assertEqual(agent.reportMainGuardRejection(new Error('Disk voll')), null, 'Unrelated error → null');
  assertEqual(agent.reportMainGuardRejection('plain string'), null, 'String → null');
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
