// @requires: python
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { verifyColabPackage, saveNotebook } = require('../electron/colabPackage.cjs');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'airdox-evidence-test-'));
const hash = value => createHash('sha256').update(value).digest('hex');
try {
  // Failure and successful commands must be distinguishable. Captured secrets stay out of logs.
  for (const code of [0, 7]) {
    const stage = `command-${code}`;
    const child = spawnSync(process.execPath, ['scripts/evidence-run.mjs', stage, '--', process.execPath, '-e',
      `console.log(process.env.TEST_SECRET);console.error('Bearer abcde-secret-token');process.exit(${code})`],
      { encoding: 'utf8', env: { ...process.env, AIRDOX_EVIDENCE_DIR: temporary, TEST_SECRET: 'private-test-value-not-a-real-credential' } });
    assert.equal(child.status, code);
    const report = JSON.parse(await readFile(path.join(temporary, `${stage}.json`), 'utf8'));
    const log = await readFile(path.join(temporary, `${stage}.log`), 'utf8');
    assert.equal(report.result, code ? 'FAIL' : 'PASS');
    assert.equal(report.log.sha256, hash(log));
    assert.ok(!log.includes('private-test-value') && !log.includes('abcde-secret-token'));
    assert.match(report.sourceCommit, /^[a-f0-9]{40}$/);
  }
  const kit = path.join(temporary, 'kit');
  await mkdir(path.join(kit, 'nachweise'), { recursive: true });
  const sourceCommit = 'a'.repeat(40);
  const contents = {
    'bundle.json': JSON.stringify({ sourceRevision: sourceCommit, appVersion: 'test' }),
    'airdox-stem-remote-worker.ipynb': '{"cells":[]}',
    'ABNAHME.md': 'test documentation',
    'airdox-colab-worker.zip': 'test payload',
  };
  for (const stage of ['model-preflight', 'model-live', 'notebook-preauth']) contents[`nachweise/${stage}.json`] = JSON.stringify({ result: 'PASS', exitCode: 0, sourceCommit });
  contents['nachweise/notebook-execution.json'] = JSON.stringify({ notebookSha256: hash(contents['airdox-stem-remote-worker.ipynb']) });
  for (const [name, text] of Object.entries(contents)) await writeFile(path.join(kit, name), text);
  const proof = { schemaVersion: 1, sourceCommit, result: 'PASS', state: 'AUTH_REQUIRED', files:
    Object.fromEntries(Object.entries(contents).map(([name, text]) => [name, { bytes: Buffer.byteLength(text), sha256: hash(text) }])) };
  const writeProof = () => writeFile(path.join(kit, 'PREAUTH_NACHWEIS.json'), JSON.stringify(proof));
  await writeProof();
  assert.equal((await verifyColabPackage(kit)).result, 'PASS');
  const target = path.join(temporary, 'new.ipynb');
  await saveNotebook(kit, target);
  await assert.rejects(saveNotebook(kit, target), /EEXIST/);
  assert.equal(await readFile(target, 'utf8'), contents['airdox-stem-remote-worker.ipynb']);
  await assert.rejects(saveNotebook(kit, path.join(temporary, 'original.wav')), /ipynb/);
  await assert.rejects(saveNotebook(kit, path.join(temporary, 'protected.ipynb'), () => true), /Original/);
  await writeFile(path.join(kit, 'airdox-stem-remote-worker.ipynb'), 'changed');
  await assert.rejects(verifyColabPackage(kit), /verändert/);
  await writeFile(path.join(kit, 'airdox-stem-remote-worker.ipynb'), contents['airdox-stem-remote-worker.ipynb']);
  proof.files['../outside'] = { bytes: 0, sha256: hash('') };
  await writeProof();
  await assert.rejects(verifyColabPackage(kit), /Unsicherer/);
  delete proof.files['../outside'];
  proof.result = 'NOT_VERIFIED';
  await writeProof();
  await assert.rejects(saveNotebook(kit, path.join(temporary, 'unverified.ipynb')), /nicht verifiziert/);
  const python = process.env.AIRODOX_STEM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, ['tests/fixtures/remote/evidence_tests.py'], { encoding: 'utf8', timeout: 60000 });
  console.log(result.stdout); console.error(result.stderr);
  assert.equal(result.status, 0);
  console.log('PASS: command evidence, redaction, resource tamper detection, no-overwrite notebook export, Python gate tests');
} finally { await rm(temporary, { recursive: true, force: true }); }
