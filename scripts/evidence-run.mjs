#!/usr/bin/env node
/** Record actual commands and outputs. A successful command is not a Google test. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [stage, separator, command, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(stage ?? '') || separator !== '--' || !command) {
  throw new Error('Usage: node scripts/evidence-run.mjs STAGE -- COMMAND ARGS...');
}
const dir = path.resolve(process.env.AIRDOX_EVIDENCE_DIR || 'evidence');
await mkdir(dir, { recursive: true });
const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('No source revision');
const sensitiveValues = Object.entries(process.env)
  .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && value?.length > 10)
  .map(([, value]) => value);
const redact = (text) => sensitiveValues.reduce((out, secret) => out.split(secret).join('[REDACTED]'), text)
  .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]');
const startedAt = new Date().toISOString();
const started = Date.now();
let output = '';
const child = spawn(command, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32' && /^(npm|npx)(\.cmd)?$/.test(command),
  env: { ...process.env, AIRDOX_TEST_REPORT: path.join(dir, `${stage}-tests.json`) },
});
for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
  output += data.toString();
  if (output.length > 32 * 1024 * 1024) { output = output.slice(-32 * 1024 * 1024); child.kill(); }
});
let launchError;
const code = await new Promise(resolve => {
  child.once('error', error => { launchError = String(error); resolve(1); });
  child.once('close', code => resolve(code ?? 1));
});
output = redact(output + (launchError ? `\n${launchError}` : ''));
process.stdout.write(output);
const logName = `${stage}.log`;
await writeFile(path.join(dir, logName), output, 'utf8');
const result = {
  schemaVersion: 1, stage, sourceCommit,
  workflowRun: process.env.GITHUB_RUN_ID ?? null,
  platform: process.platform, arch: process.arch, node: process.version,
  command: [command, ...args].map(redact), startedAt, finishedAt: new Date().toISOString(),
  durationMs: Date.now() - started, exitCode: code, result: code === 0 ? 'PASS' : 'FAIL',
  log: { file: logName, sha256: createHash('sha256').update(output).digest('hex') },
};
await writeFile(path.join(dir, `${stage}.json`), JSON.stringify(result, null, 2) + '\n');
if (code !== 0 && process.env.GITHUB_ACTIONS) {
  const escape = value => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::error title=${stage}::${escape(output.split('\n').slice(-35).join('\n').slice(-6000))}`);
}
process.exitCode = code;
