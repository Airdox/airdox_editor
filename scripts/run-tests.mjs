#!/usr/bin/env node
/**
 * Central test runner with file discovery, @requires, @manual, --fail-on-skip, --set-env for Windows-cmd safety, writes failure report.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const failOnSkip = args.includes('--fail-on-skip');
const setEnv = {};
let filter = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set-env' && i + 1 < args.length) {
    const kv = args[i + 1];
    const eq = kv.indexOf('=');
    if (eq > 0) {
      setEnv[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    i++;
  } else if (!args[i].startsWith('--')) {
    filter = args[i];
  }
}

async function discoverTests(dir = 'tests') {
  const entries = await readdir(dir, { withFileTypes: true });
  const tests = [];
  for (const ent of entries) {
    if (ent.isFile() && (ent.name.endsWith('.test.ts') || ent.name.endsWith('.test.mjs') || ent.name.endsWith('.test.js'))) {
      tests.push(path.join(dir, ent.name));
    } else if (ent.isDirectory()) {
      const sub = await discoverTests(path.join(dir, ent.name));
      tests.push(...sub);
    }
  }
  return tests;
}

function parseRequires(fileContent) {
  const requires = [];
  const manual = fileContent.includes('@manual');
  const lines = fileContent.split('\n');
  for (const line of lines) {
    const m = line.match(/@requires\s+([A-Z0-9_]+)/);
    if (m) requires.push(m[1]);
    const m2 = line.match(/@requires-env\s+([A-Z0-9_]+)/);
    if (m2) requires.push(m2[1]);
  }
  return { requires, manual };
}

async function runTest(filePath) {
  const content = await readFile(filePath, 'utf8').catch(() => '');
  const { requires, manual } = parseRequires(content);

  // Check env requirements
  for (const req of requires) {
    if (!(req in process.env) && !(req in setEnv)) {
      return { file: filePath, status: 'SKIPPED', reason: `Missing env ${req}` };
    }
  }
  if (manual) {
    return { file: filePath, status: 'SKIPPED', reason: '@manual' };
  }

  // Determine runner
  const isMjs = filePath.endsWith('.mjs') || filePath.endsWith('.js');
  const cmd = isMjs ? 'node' : 'npx';
  const cmdArgs = isMjs ? [filePath] : ['tsx', filePath];

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      env: { ...process.env, ...setEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve({ file: filePath, status: 'PASS', stdout, stderr });
      else resolve({ file: filePath, status: 'FAIL', stdout, stderr, code });
    });
    child.on('error', (err) => {
      resolve({ file: filePath, status: 'FAIL', stdout, stderr, error: err.message });
    });
  });
}

async function main() {
  let tests = await discoverTests('tests');
  if (filter) {
    tests = tests.filter((t) => t.includes(filter));
  }
  tests.sort();

  console.log(`Discovered ${tests.length} tests`);
  const results = [];
  const failures = [];

  // Grouping: run in parallel batches of 4
  const batchSize = 4;
  for (let i = 0; i < tests.length; i += batchSize) {
    const batch = tests.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(runTest));
    for (const r of batchResults) {
      results.push(r);
      if (r.status === 'PASS') {
        console.log(`✓ ${r.file}`);
      } else if (r.status === 'SKIPPED') {
        console.log(`- ${r.file} SKIPPED: ${r.reason}`);
      } else {
        console.log(`✘ ${r.file} FAIL`);
        console.log(r.stdout.slice(0, 2000));
        console.log(r.stderr.slice(0, 2000));
        failures.push(r);
      }
    }
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const skipped = results.filter((r) => r.status === 'SKIPPED').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  console.log(`\nResults: ${passed} passed, ${skipped} skipped, ${failed} failed out of ${results.length}`);

  // Write failure report
  const reportPath = 'test-runner-failure.txt';
  if (failures.length > 0) {
    const report = failures
      .map((f) => `FAIL: ${f.file}\nCode: ${f.code}\nSTDOUT:\n${f.stdout}\nSTDERR:\n${f.stderr}\n---\n`)
      .join('\n');
    await writeFile(reportPath, report);
    console.log(`Failure report written to ${reportPath}`);
  } else {
    if (existsSync(reportPath)) {
      await writeFile(reportPath, 'All tests passed\n');
    }
  }

  if (failOnSkip && skipped > 0) {
    console.error(`Failing due to ${skipped} skipped tests (--fail-on-skip)`);
    process.exit(1);
  }

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
