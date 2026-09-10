#!/usr/bin/env node
/**
 * @license
 * Waveform Gatekeeper
 *
 * A small, deterministic orchestration layer for the waveform verification
 * agents. Each agent owns one contract and reports a structured GateResult:
 *
 *   { agent, gate, status: 'PASS' | 'FAIL' | 'BLOCKED',
 *     evidence: string[], attempts, retried, durationMs,
 *     reason?, nextAction? }
 *
 * Behaviour (gatekeeper upgrade, stage 1):
 *  - Every run writes a structured JSON report to release/gate-report.json
 *    (schema airdox.waveform-gate-report v1). In CI it is uploaded as an
 *    artifact next to the Windows build.
 *  - A failed gate is retried exactly once before it is declared final
 *    (attempts: 2, retried: true).
 *  - Final failures are escalated: reason + concrete next action, printed to
 *    the console and persisted in the report (escalations[]) plus
 *    release/gate-escalation.md.
 *
 * Data-integrity contract: the gatekeeper only verifies and records. It never
 * reads or changes Rekordbox data (ANLZ/PPTH/PWV, DB, XML, audio), adds or
 * removes nothing from the source chain, and never hides a missing ANLZ
 * source behind a generated waveform. A failed gate stops the pipeline.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  addGate,
  createGateReport,
  finalizeGateReport,
  writeGateReport,
} from './gate-report.mjs';

const root = resolve(import.meta.dirname, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tsxCommand = process.execPath;
const tsxPrefix = [resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')];
const reportDir = resolve(root, 'release');

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const report = createGateReport({
  generatedAt: new Date().toISOString(),
  appVersion: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  platform: process.platform,
  node: process.version,
  commit: gitCommit(),
  root,
});

/**
 * Run a command-backed agent gate with exactly one automatic retry.
 * The gate passes when either attempt exits with code 0.
 */
function runCommandGate(agent, gate, command, args, nextAction) {
  const startedAt = Date.now();
  const attemptLog = [];
  let exitCode = 1;

  for (let attempt = 1; attempt <= 2; attempt++) {
    process.stdout.write(`\n[WAVEFORM AGENT] ${gate} (attempt ${attempt})\n$ ${command} ${args.join(' ')}\n`);
    try {
      execFileSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
        // Windows .cmd shims (npm/tsx) require a shell when spawned directly.
        shell: process.platform === 'win32',
      });
      exitCode = 0;
    } catch (error) {
      exitCode = error.status ?? 1;
    }
    attemptLog.push(`attempt ${attempt}: exit ${exitCode}`);
    if (exitCode === 0) break;
    if (attempt === 1) {
      console.error(`[GATE RETRY] ${gate} failed (exit ${exitCode}); retrying once.`);
    }
  }

  const attempts = attemptLog.length;
  const durationMs = Date.now() - startedAt;
  const evidence = [`${command} ${args.join(' ')}`, ...attemptLog, `${durationMs}ms`];

  if (exitCode === 0) {
    addGate(report, {
      agent,
      gate,
      status: 'PASS',
      evidence,
      attempts,
      retried: attempts > 1,
      durationMs,
    });
    console.log(`[GATE PASS] ${gate}${attempts > 1 ? ' (after retry)' : ''}`);
    return;
  }

  addGate(report, {
    agent,
    gate,
    status: 'FAIL',
    evidence,
    attempts,
    retried: attempts > 1,
    durationMs,
    reason: `Command failed with exit code ${exitCode} after ${attempts} attempt${attempts > 1 ? 's' : ''}.`,
    nextAction,
  });
  console.error(`[GATE FAIL] ${gate}: exit ${exitCode} after ${attempts} attempt${attempts > 1 ? 's' : ''}.`);
}

/**
 * Run the static source-provenance contract agent. The six checks are kept
 * byte-for-byte identical to the original gatekeeper contract — only the
 * reporting changed, not what is verified.
 */
function runSourceContractGate() {
  const agent = 'Model/Provenance';
  const gate = 'Source provenance gate';
  const nextAction =
    'Restore the original ANLZ-only render path; do not add a local analysis fallback for Rekordbox tracks.';
  const startedAt = Date.now();

  const evaluate = () => {
    const app = readFileSync(resolve(root, 'src/App.tsx'), 'utf8');
    const detail = readFileSync(resolve(root, 'src/components/DetailWaveform.tsx'), 'utf8');
    const overview = readFileSync(resolve(root, 'src/components/TrackOverview.tsx'), 'utf8');
    const palette = readFileSync(resolve(root, 'src/components/PalettePanel.tsx'), 'utf8');
    const dbReader = readFileSync(resolve(root, 'electron/dbReader.cjs'), 'utf8');
    const main = readFileSync(resolve(root, 'electron/main.cjs'), 'utf8');
    const checks = [
      ['renderer selects original analysis', /selectTrackWaveform\(track/.test(detail) && /selectTrackWaveform\(track/.test(overview)],
      ['no edit-time analysis replacement', !/activeTrack\.analysis\s*=\s*analyzeAudioBuffer/.test(app) && !/analysisVariants\s*=\s*undefined/.test(app)],
      ['palette consumes source waveform payload', /clip\.waveform/.test(palette) && /extractPaletteWaveform/.test(app)],
      ['ANLZ scan walks nested folders', /maxDepth\s*=\s*6/.test(dbReader) && /isDirectory\(\)/.test(dbReader)],
      ['ANLZ scan checks target media drives', /findTargetDriveAnlzFolders/.test(dbReader) && /PIONEER.*USBANLZ/.test(dbReader)],
      ['database discovery checks D partition', /findDatabaseFilesOnWindowsVolume/.test(dbReader) && /D:/.test(dbReader)],
      // Permanent Original Protection: the main-process write path always
      // consults the original guard registry (read-only originals).
      ['original guard wired into the main-process write path', /originalGuard\.checkOperation\('WRITE'/.test(main) && /original-guard:register/.test(main)],
    ];
    const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
    return {
      ok: failed.length === 0,
      failed,
      evidence: checks.map(([label, ok]) => `${ok ? 'OK' : 'VIOLATED'}: ${label}`),
    };
  };

  let outcome = evaluate();
  let attempts = 1;
  if (!outcome.ok) {
    console.error(`[GATE RETRY] ${gate} failed (${outcome.failed.join('; ')}); retrying once.`);
    outcome = evaluate();
    attempts = 2;
  }

  const durationMs = Date.now() - startedAt;
  if (outcome.ok) {
    addGate(report, {
      agent,
      gate,
      status: 'PASS',
      evidence: outcome.evidence,
      attempts,
      retried: attempts > 1,
      durationMs,
    });
    console.log(`[GATE PASS] ${gate}${attempts > 1 ? ' (after retry)' : ''}`);
    return;
  }

  addGate(report, {
    agent,
    gate,
    status: 'FAIL',
    evidence: outcome.evidence,
    attempts,
    retried: attempts > 1,
    durationMs,
    reason: `Source provenance contract violated: ${outcome.failed.join(', ')}.`,
    nextAction,
  });
  console.error(`[GATE FAIL] ${gate}: ${outcome.failed.join('; ')}`);
}

// The agents are intentionally sequential: a parser failure makes renderer
// evidence meaningless, and a renderer failure makes the integration gate
// unsafe to publish.
runSourceContractGate();
runCommandGate(
  'ANLZ',
  'Resolver + nested ANLZ scan agent',
  tsxCommand,
  [...tsxPrefix, resolve(root, 'tests', 'analysis-resolver.test.ts')],
  'Fix the failing ANLZ resolution / nested USBANLZ scan test, then rerun npm run verify:waveform.'
);
runCommandGate(
  'ANLZ',
  'Binary ANLZ/PQTZ/EXT provenance agent',
  tsxCommand,
  [...tsxPrefix, resolve(root, 'tests', 'anlz-real-format.test.ts')],
  'Fix the ANLZ/PPTH/PWV parser contract (never synthesize missing data), then rerun npm run verify:waveform.'
);
runCommandGate(
  'Renderer',
  'Waveform variants + renderer agent',
  tsxCommand,
  [...tsxPrefix, resolve(root, 'tests', 'waveform-variants.test.ts')],
  'Fix the variant/zoom render model (no invented detail), then rerun npm run verify:waveform.'
);
runCommandGate(
  'Palette',
  'Renderer no-synthesis + palette contract agent',
  tsxCommand,
  [...tsxPrefix, resolve(root, 'tests', 'renderer-original-data.test.ts')],
  'Restore the original-data render + palette payload contract, then rerun npm run verify:waveform.'
);
runCommandGate(
  'Importer',
  'XML/DB integration agent',
  tsxCommand,
  [...tsxPrefix, resolve(root, 'tests', 'xml-exclusive-import.test.ts')],
  'Fix the XML/DB import integration (exclusive import, D: discovery), then rerun npm run verify:waveform.'
);
runCommandGate(
  'Guard',
  'Original protection guard (main process) agent',
  tsxCommand,
  [resolve(root, 'tests', 'original-guard.test.mjs')],
  'Restore the permanent original guard (electron/originalGuard.cjs): originals are read-only, all work happens on working copies. Then rerun npm run verify:waveform.'
);
runCommandGate(
  'Guard',
  'Original protection agent (renderer) agent',
  tsxCommand,
  [...tsxPrefix, resolve(root, 'tests', 'original-protection-agent.test.ts')],
  'Restore the renderer Original Protection Agent (block + intervention popup for risky operations on originals), then rerun npm run verify:waveform.'
);
runCommandGate(
  'Versioning',
  'Version schema consistency (single source of truth)',
  tsxCommand,
  [resolve(root, 'tests', 'version-schema.test.mjs')],
  'Restore the unified versioning contract (docs/VERSIONIERUNG.md): strict semver in package.json, Vite __APP_VERSION__ injection, no hardcoded version in src/utils/appVersion.ts, no stale version numbers in README.md/BUILD_WINDOWS.md, ${version} in artifact names. Then rerun npm run verify:waveform.'
);
runCommandGate(
  'Release',
  'TypeScript gatekeeper',
  npmCommand,
  ['run', 'lint'],
  'Fix the TypeScript errors (npm run lint), then rerun npm run verify:waveform.'
);
runCommandGate(
  'Release',
  'Production build gatekeeper',
  npmCommand,
  ['run', 'build'],
  'Fix the production build (npm run build), then rerun npm run verify:waveform.'
);

// Finalize and always persist the report — a BLOCKED run must still ship its
// evidence. In CI the report is uploaded as an artifact next to the Windows
// build, even when the build itself did not run.
finalizeGateReport(report);
let paths = null;
try {
  paths = writeGateReport(report, reportDir);
} catch (error) {
  console.error(`[GATE REPORT] could not write report: ${error?.message || error}`);
}
if (paths) {
  console.log(`\n[GATE REPORT] ${paths.report}`);
  if (paths.escalation) console.log(`[ESCALATION] ${paths.escalation}`);
}

if (report.overall === 'BLOCKED') {
  console.error('\n[WAVEFORM GATEKEEPER] BLOCKED');
  for (const escalation of report.escalations) {
    console.error(`- ${escalation.gate} [${escalation.agent}]`);
    console.error(`  Reason: ${escalation.reason}`);
    console.error(`  Next agent action: ${escalation.nextAction}`);
  }
  process.exit(1);
}

console.log('\n[WAVEFORM GATEKEEPER] ALL GATES PASSED');
console.log('Evidence chain: ANLZ path → PPTH match → parser → source-tagged variants → renderer → palette payload.');
