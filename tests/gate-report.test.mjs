/**
 * @license
 * Gate report core tests (gatekeeper upgrade, stage 1):
 *
 * R1 – Structured JSON report: stable schema, run metadata, per-gate
 *      GateResults, deterministic finalization.
 * R2 – Automatic retry: attempts/retried are recorded and survive
 *      finalization untouched.
 * R3 – Escalation: every finally-failed gate escalates with a non-empty
 *      reason AND a concrete next action; BLOCKED runs persist
 *      gate-report.json + gate-escalation.md, green runs remove a stale
 *      escalation file.
 *
 * The tests exercise the pure report core only — no Rekordbox data is
 * read, written, or transformed.
 *
 * Run with: node tests/gate-report.test.mjs
 */

import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_NEXT_ACTION,
  DEFAULT_REASON,
  ESCALATION_FILE_NAME,
  GATE_REPORT_SCHEMA,
  GATE_REPORT_VERSION,
  REPORT_FILE_NAME,
  addGate,
  createGateReport,
  escalationFor,
  finalizeGateReport,
  renderEscalationMarkdown,
  writeGateReport,
} from '../scripts/gate-report.mjs';

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

function passGate(overrides = {}) {
  return {
    agent: 'ANLZ',
    gate: 'Test gate',
    status: 'PASS',
    evidence: ['node tests/example.test.ts', 'attempt 1: exit 0', '42ms'],
    attempts: 1,
    retried: false,
    durationMs: 42,
    ...overrides,
  };
}

function failGate(overrides = {}) {
  return {
    agent: 'ANLZ',
    gate: 'Test gate',
    status: 'FAIL',
    evidence: ['node tests/example.test.ts', 'attempt 1: exit 1', 'attempt 2: exit 1', '90ms'],
    attempts: 2,
    retried: true,
    durationMs: 90,
    reason: 'Command failed with exit code 1 after 2 attempts.',
    nextAction: 'Fix the failing test, then rerun npm run verify:waveform.',
    ...overrides,
  };
}

function meta() {
  return {
    generatedAt: '2026-09-10T12:00:00.000Z',
    appVersion: '0.4.20',
    platform: 'linux',
    node: 'v22.0.0',
    commit: 'abc1234',
    root: '/repo',
  };
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  GATE REPORT CORE TEST SUITE (R1–R3)                         ');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ─── R1: structured JSON report ─────────────────────────────────────────────
runTest('R1 schema', 'Report has the stable schema and run metadata', () => {
  const report = createGateReport(meta());
  assert.strictEqual(report.schema, GATE_REPORT_SCHEMA, 'Schema identifier');
  assert.strictEqual(report.version, GATE_REPORT_VERSION, 'Schema version');
  assert.strictEqual(report.overall, 'RUNNING', 'Not finalized yet');
  assert.deepStrictEqual(report.gates, [], 'No gates yet');
  assert.deepStrictEqual(report.escalations, [], 'No escalations yet');
  assert.strictEqual(report.generatedAt, '2026-09-10T12:00:00.000Z', 'Timestamp kept');
  assert.strictEqual(report.appVersion, '0.4.20', 'App version kept');
  assert.strictEqual(report.commit, 'abc1234', 'Commit kept');
  const parsed = JSON.parse(JSON.stringify(report));
  assert.strictEqual(parsed.schema, GATE_REPORT_SCHEMA, 'Round-trips through JSON');
});

runTest('R1 schema', 'Missing commit falls back to null, not a guess', () => {
  const m = meta();
  delete m.commit;
  const fresh = createGateReport(m);
  assert.strictEqual(fresh.commit, null, 'Commit is null when unknown');
});

runTest('R1 finalization', 'All gates pass → overall PASS, no escalations', () => {
  const report = createGateReport(meta());
  addGate(report, passGate());
  addGate(report, passGate({ gate: 'Second gate', agent: 'Release' }));
  finalizeGateReport(report);
  assert.strictEqual(report.overall, 'PASS', 'Overall PASS');
  assert.strictEqual(report.escalations.length, 0, 'No escalations');
  assert.strictEqual(report.gates.length, 2, 'Both gates recorded');
});

runTest('R1 finalization', 'Evidence strings are preserved untouched', () => {
  const report = createGateReport(meta());
  const gate = passGate({ evidence: ['D:\\PIONEER\\USBANLZ', 'PPTH match: 0x1f4c (1:1)', '500ms'] });
  addGate(report, gate);
  finalizeGateReport(report);
  assert.deepStrictEqual(report.gates[0].evidence, gate.evidence, 'Evidence unchanged');
});

// ─── R2: automatic retry bookkeeping ────────────────────────────────────────
runTest('R2 retry', 'Retry outcome is recorded and survives finalization', () => {
  const report = createGateReport(meta());
  addGate(report, passGate({ attempts: 2, retried: true, durationMs: 130 }));
  finalizeGateReport(report);
  assert.strictEqual(report.gates[0].attempts, 2, 'Two attempts recorded');
  assert.strictEqual(report.gates[0].retried, true, 'Retry flagged');
  assert.strictEqual(report.gates[0].status, 'PASS', 'Final status PASS');
  assert.strictEqual(report.overall, 'PASS', 'Retried pass is still a pass');
});

runTest('R2 retry', 'Final failure keeps both attempts and is blocked', () => {
  const report = createGateReport(meta());
  addGate(report, failGate());
  finalizeGateReport(report);
  assert.strictEqual(report.gates[0].attempts, 2, 'Both attempts kept');
  assert.strictEqual(report.gates[0].retried, true, 'Retried once');
  assert.strictEqual(report.overall, 'BLOCKED', 'Overall BLOCKED');
});

// ─── R3: escalation on final failure ────────────────────────────────────────
runTest('R3 escalation', 'Every failed gate escalates with reason and next action', () => {
  const report = createGateReport(meta());
  addGate(report, failGate());
  addGate(report, failGate({
    gate: 'Second gate',
    agent: 'Importer',
    reason: 'XML exclusive import violated: D: discovery missing.',
    nextAction: 'Fix the D: partition discovery, then rerun npm run verify:waveform.',
  }));
  finalizeGateReport(report);
  assert.strictEqual(report.escalations.length, 2, 'One escalation per failed gate');
  for (const e of report.escalations) {
    assert.strictEqual(typeof e.gate, 'string', 'Escalation names the gate');
    assert.strictEqual(typeof e.agent, 'string', 'Escalation names the owning agent');
    assert(e.reason.trim().length > 0, 'Escalation carries a reason');
    assert(e.nextAction.trim().length > 0, 'Escalation carries a next action');
  }
  assert.strictEqual(report.escalations[1].agent, 'Importer', 'Owning agent kept');
});

runTest('R3 escalation', 'Missing reason/nextAction fall back to explicit defaults', () => {
  const e = escalationFor({ gate: 'G', agent: 'A', status: 'FAIL', evidence: [] });
  assert.strictEqual(e.reason, DEFAULT_REASON, 'Default reason used');
  assert.strictEqual(e.nextAction, DEFAULT_NEXT_ACTION, 'Default next action used');
});

runTest('R3 escalation', 'Escalation markdown contains reason and next action', () => {
  const report = createGateReport(meta());
  addGate(report, failGate({ reason: 'PWV bucket count mismatch.', nextAction: 'Recheck the PWV parser.' }));
  finalizeGateReport(report);
  const md = renderEscalationMarkdown(report);
  assert(md.includes('Test gate'), 'Gate name in markdown');
  assert(md.includes('PWV bucket count mismatch.'), 'Reason in markdown');
  assert(md.includes('Recheck the PWV parser.'), 'Next action in markdown');
  assert(md.includes('attempt 1: exit 1'), 'Evidence in markdown');
  assert(md.includes('BLOCKED'), 'Status in markdown');
});

runTest('R3 persistence', 'Blocked run writes JSON report + escalation file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdox-gate-'));
  try {
    const report = createGateReport(meta());
    addGate(report, passGate());
    addGate(report, failGate());
    finalizeGateReport(report);
    const paths = writeGateReport(report, dir);

    assert(existsSync(paths.report), 'Report file exists');
    assert.strictEqual(paths.report, join(dir, REPORT_FILE_NAME), 'Report file name');
    const parsed = JSON.parse(readFileSync(paths.report, 'utf8'));
    assert.deepStrictEqual(parsed, report, 'Report round-trips exactly');

    assert(existsSync(paths.escalation), 'Escalation file exists');
    assert.strictEqual(paths.escalation, join(dir, ESCALATION_FILE_NAME), 'Escalation file name');
    const md = readFileSync(paths.escalation, 'utf8');
    assert(md.includes('Test gate'), 'Escalation content written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest('R3 persistence', 'Green run does not create an escalation file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdox-gate-'));
  try {
    const report = createGateReport(meta());
    addGate(report, passGate());
    finalizeGateReport(report);
    const paths = writeGateReport(report, dir);
    assert.strictEqual(paths.escalation, undefined, 'No escalation path');
    assert(!existsSync(join(dir, ESCALATION_FILE_NAME)), 'No escalation file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

runTest('R3 persistence', 'Green run removes a stale escalation from a blocked run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdox-gate-'));
  try {
    const blocked = createGateReport(meta());
    addGate(blocked, failGate());
    finalizeGateReport(blocked);
    writeGateReport(blocked, dir);
    assert(existsSync(join(dir, ESCALATION_FILE_NAME)), 'Stale escalation exists');

    const green = createGateReport(meta());
    addGate(green, passGate());
    finalizeGateReport(green);
    writeGateReport(green, dir);
    assert(!existsSync(join(dir, ESCALATION_FILE_NAME)), 'Stale escalation removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
