#!/usr/bin/env node
/**
 * Waveform Gatekeeper
 *
 * A small, deterministic orchestration layer for the waveform verification
 * agents. Each agent owns one contract and reports a concrete failure. The
 * gatekeeper stops the pipeline on a failed gate and prints the next action;
 * it never hides a missing ANLZ source behind a generated waveform.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];

function runAgent(name, command, args) {
  process.stdout.write(`\n[WAVEFORM AGENT] ${name}\n$ ${command} ${args.join(' ')}\n`);
  try {
    execFileSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
    console.log(`[GATE PASS] ${name}`);
  } catch (error) {
    const code = error.status ?? 1;
    failures.push({ name, reason: `Command failed with exit code ${code}`, next: 'Fix the failing test or source contract, then rerun npm run verify:waveform.' });
    console.error(`[GATE FAIL] ${name}: exit ${code}`);
  }
}

function sourceContractAgent() {
  const app = readFileSync(resolve(root, 'src/App.tsx'), 'utf8');
  const detail = readFileSync(resolve(root, 'src/components/DetailWaveform.tsx'), 'utf8');
  const overview = readFileSync(resolve(root, 'src/components/TrackOverview.tsx'), 'utf8');
  const palette = readFileSync(resolve(root, 'src/components/PalettePanel.tsx'), 'utf8');
  const dbReader = readFileSync(resolve(root, 'electron/dbReader.cjs'), 'utf8');
  const checks = [
    ['renderer selects original analysis', /selectTrackWaveform\(track/.test(detail) && /selectTrackWaveform\(track/.test(overview)],
    ['no edit-time analysis replacement', !/activeTrack\.analysis\s*=\s*analyzeAudioBuffer/.test(app) && !/analysisVariants\s*=\s*undefined/.test(app)],
    ['palette consumes source waveform payload', /clip\.waveform/.test(palette) && /extractPaletteWaveform/.test(app)],
    ['ANLZ scan walks nested folders', /maxDepth\s*=\s*6/.test(dbReader) && /isDirectory\(\)/.test(dbReader)],
    ['ANLZ scan checks target media drives', /findTargetDriveAnlzFolders/.test(dbReader) && /PIONEER.*USBANLZ/.test(dbReader)],
    ['database discovery checks D partition', /findDatabaseFilesOnWindowsVolume/.test(dbReader) && /D:/.test(dbReader)],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
  if (failed.length) {
    failures.push({ name: 'Source provenance gate', reason: failed.join(', '), next: 'Restore the original ANLZ-only render path; do not add a local analysis fallback for Rekordbox tracks.' });
    console.error(`[GATE FAIL] Source provenance gate: ${failed.join('; ')}`);
  } else {
    console.log('[GATE PASS] Source provenance gate');
  }
}

// The agents are intentionally sequential: a parser failure makes renderer
// evidence meaningless, and a renderer failure makes the integration gate
// unsafe to publish.
sourceContractAgent();
runAgent('Resolver + nested ANLZ scan agent', 'npm', ['exec', '--', 'tsx', 'tests/analysis-resolver.test.ts']);
runAgent('Binary ANLZ/PQTZ/EXT provenance agent', 'npm', ['exec', '--', 'tsx', 'tests/anlz-real-format.test.ts']);
runAgent('Waveform variants + renderer agent', 'npm', ['exec', '--', 'tsx', 'tests/waveform-variants.test.ts']);
runAgent('Renderer no-synthesis + palette contract agent', 'npm', ['exec', '--', 'tsx', 'tests/renderer-original-data.test.ts']);
runAgent('XML/DB integration agent', 'npm', ['exec', '--', 'tsx', 'tests/xml-exclusive-import.test.ts']);
runAgent('TypeScript gatekeeper', 'npm', ['run', 'lint']);
runAgent('Production build gatekeeper', 'npm', ['run', 'build']);

if (failures.length) {
  console.error('\n[WAVEFORM GATEKEEPER] BLOCKED');
  for (const failure of failures) {
    console.error(`- ${failure.name}: ${failure.reason}`);
    console.error(`  Next agent action: ${failure.next}`);
  }
  process.exit(1);
}

console.log('\n[WAVEFORM GATEKEEPER] ALL GATES PASSED');
console.log('Evidence chain: ANLZ path → PPTH match → parser → source-tagged variants → renderer → palette payload.');
