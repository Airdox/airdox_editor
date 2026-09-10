/**
 * @license
 * Original Protection Guard tests (main process, permanent layer):
 *
 * G1 – Registration: idempotent, keeps kind, counts new entries.
 * G2 – Block semantics: EVERY risky operation (write, append, overwrite,
 *      rename, move, delete, truncate) on a registered original is blocked
 *      and logged as an intervention; READ is always allowed.
 * G3 – Working copies: a NEW file (even in the same folder) is allowed —
 *      the app must always be able to save results without touching
 *      originals.
 * G4 – Comparison robustness: case-insensitive, backslash/slash, '.' and
 *      '..' segments (fail-closed on case-sensitive filesystems).
 *
 * The guard is pure Node (no Electron) and only decides — it never reads,
 * writes, or modifies files itself.
 *
 * Run with: node tests/original-guard.test.mjs
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOriginalGuard, RISKY_OPERATIONS } = require('../electron/originalGuard.cjs');

/** @typedef {{suite: string, name: string, passed: boolean, error?: string, durationMs: number}} TestResult */

const results = [];

function runTest(suite, name, testFn) {
  const t0 = performance.now();
  try {
    testFn();
    results.push({ suite, name, passed: true, durationMs: Math.round((performance.now() - t0) * 100) / 100 });
  } catch (err) {
    results.push({
      suite,
      name,
      passed: false,
      error: err?.message || String(err),
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
    });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`Assertion Failed [${message}]: expected ${expected}, got ${actual}`);
}

const ORIGINAL_AUDIO = 'D:\\Music\\Rekordbox\\Track01.wav';
const ORIGINAL_ANLZ = 'D:\\PIONEER\\USBANLZ\\ANLZ0042.DAT';
const ORIGINAL_DB = 'G:\\PIONEER\\rekordbox7\\master.db';
const ORIGINAL_XML = 'C:\\Users\\dj\\rekordbox_collection.xml';
const WORKING_COPY = 'D:\\Music\\Rekordbox\\Track01 - Mix.wav';

function seededGuard() {
  const guard = createOriginalGuard();
  guard.registerOriginals([
    { path: ORIGINAL_AUDIO, kind: 'AUDIO' },
    { path: ORIGINAL_ANLZ, kind: 'ANLZ' },
    { path: ORIGINAL_DB, kind: 'DATABASE' },
    ORIGINAL_XML, // plain-string entry → kind UNKNOWN
  ]);
  return guard;
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  ORIGINAL PROTECTION GUARD TEST SUITE (G1–G4)                 ');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ─── G1: Registration ───────────────────────────────────────────────────────
runTest('G1 register', 'Registers originals with kind, idempotently', () => {
  const guard = createOriginalGuard();
  const first = guard.registerOriginals([{ path: ORIGINAL_AUDIO, kind: 'AUDIO' }]);
  assertEqual(first.added, 1, 'First registration adds 1');
  assertEqual(first.total, 1, 'Total 1');
  const second = guard.registerOriginals([{ path: ORIGINAL_AUDIO, kind: 'AUDIO' }]);
  assertEqual(second.added, 0, 'Duplicate adds 0');
  assertEqual(second.total, 1, 'Still 1');
  const list = guard.listOriginals();
  assertEqual(list.length, 1, 'List has 1');
  assertEqual(list[0].kind, 'AUDIO', 'Kind kept');
});

runTest('G1 register', 'Accepts string entries and ignores garbage', () => {
  const guard = createOriginalGuard();
  const res = guard.registerOriginals([ORIGINAL_AUDIO, '', null, 42, { kind: 'ANLZ' }]);
  assertEqual(res.added, 1, 'Only the string entry registered');
  assertEqual(res.total, 1, 'Total 1');
});

// ─── G2: Block semantics (fail-closed on originals) ─────────────────────────
runTest('G2 block', 'Every risky operation on an original is blocked', () => {
  const guard = seededGuard();
  for (const op of RISKY_OPERATIONS) {
    const verdict = guard.checkOperation(op, ORIGINAL_AUDIO, 'test');
    assertEqual(verdict.allowed, false, `${op} blocked`);
    assertEqual(verdict.verdict, 'BLOCKED_ORIGINAL', `${op} verdict`);
    assertEqual(verdict.originalPath, ORIGINAL_AUDIO, `${op} names the original`);
  }
});

runTest('G2 block', 'Interventions are logged for each blocked operation', () => {
  const guard = seededGuard();
  guard.checkOperation('WRITE', ORIGINAL_AUDIO, 'save-export-file');
  guard.checkOperation('DELETE', ORIGINAL_DB, null);
  const log = guard.interventionsLog();
  assertEqual(log.length, 2, 'Two interventions recorded');
  assertEqual(log[0].operation, 'WRITE', 'First operation');
  assertEqual(log[0].original, ORIGINAL_AUDIO, 'First original');
  assertEqual(log[0].context, 'save-export-file', 'Context kept');
  assertEqual(log[1].operation, 'DELETE', 'Second operation');
  assertEqual(log[1].kind, 'DATABASE', 'Kind from the registry');
});

runTest('G2 block', 'READ of an original is always allowed', () => {
  const guard = seededGuard();
  const verdict = guard.checkOperation('READ', ORIGINAL_ANLZ);
  assertEqual(verdict.allowed, true, 'Read allowed');
  assertEqual(guard.interventionsLog().length, 0, 'Read is not an intervention');
});

runTest('G2 block', 'Unknown operations are treated as read-only (not risky)', () => {
  const guard = seededGuard();
  const verdict = guard.checkOperation('SNAPSHOT', ORIGINAL_AUDIO);
  assertEqual(verdict.allowed, true, 'Unknown op allowed');
  assert(typeof verdict.note === 'string', 'Disclosed as read-only treatment');
});

// ─── G3: Working copies are always allowed ──────────────────────────────────
runTest('G3 working copy', 'Writing a NEW file next to the original is allowed', () => {
  const guard = seededGuard();
  const verdict = guard.checkOperation('WRITE', WORKING_COPY, { via: 'save-export-file' });
  assertEqual(verdict.allowed, true, 'Working copy write allowed');
  assertEqual(verdict.verdict, 'ALLOWED_WORKING_COPY', 'Verdict names the working copy');
  assertEqual(guard.interventionsLog().length, 0, 'No intervention');
});

runTest('G3 working copy', 'Empty registry never blocks (nothing registered yet)', () => {
  const guard = createOriginalGuard();
  const verdict = guard.checkOperation('WRITE', 'D:\\Whatever\\new.wav');
  assertEqual(verdict.allowed, true, 'Allowed with empty registry');
});

// ─── G4: Comparison robustness (fail-closed) ────────────────────────────────
runTest('G4 compare', 'Case difference cannot bypass the guard', () => {
  const guard = seededGuard();
  const verdict = guard.checkOperation('WRITE', 'd:\\music\\rekordbox\\track01.WAV');
  assertEqual(verdict.allowed, false, 'Case-folded block');
});

runTest('G4 compare', 'Slash style difference cannot bypass the guard', () => {
  const guard = seededGuard();
  const verdict = guard.checkOperation('DELETE', 'D:/Music/Rekordbox/Track01.wav');
  assertEqual(verdict.allowed, false, 'Slash-normalized block');
});

runTest('G4 compare', 'Dot segments resolve to the original (fail-closed)', () => {
  const guard = createOriginalGuard();
  guard.registerOriginals([{ path: 'D:/Music/Rekordbox/Track01.wav', kind: 'AUDIO' }]);
  const sneaky = 'D:/Music/Other/../Rekordbox/Track01.wav';
  const verdict = guard.checkOperation('OVERWRITE', sneaky);
  assertEqual(verdict.allowed, false, 'Dot-segment path blocked');
});

runTest('G4 compare', 'Non-path inputs are safe (no throw, no block)', () => {
  const guard = seededGuard();
  assertEqual(guard.isOriginal(null), false, 'null is not an original');
  assertEqual(guard.isOriginal(42), false, 'number is not an original');
  assertEqual(guard.checkOperation('WRITE', undefined).allowed, true, 'No target → nothing to block');
});

runTest('G4 compare', 'reset clears the registry (test helper only)', () => {
  const guard = seededGuard();
  guard.reset();
  assertEqual(guard.listOriginals().length, 0, 'Registry cleared');
  assertEqual(guard.checkOperation('WRITE', ORIGINAL_AUDIO).allowed, true, 'No longer protected');
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
