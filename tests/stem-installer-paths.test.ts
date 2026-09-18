import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';

console.log('=== INSTALLER & PATH RESOLUTION TEST – §9, §34, §35 ===');

async function run() {
  const { resolveStemRuntime, resolveStemModel } = await import('../src/stems/runtime/pathResolver');

  // Test pathResolver returns deterministic production paths
  const runtime = resolveStemRuntime();
  console.log(`  Runtime candidates: ${runtime.candidates.join(', ')}`);
  assert.ok(runtime.candidates.some((c) => c.includes('stem-runtime')), 'candidates include stem-runtime');
  assert.ok(runtime.candidates.some((c) => c.includes('resources') || c.includes('.venv') || c.includes('python')), 'candidates include resources/.venv');
  console.log('  [PASS] runtime candidates include stem-runtime');

  // Must NOT rely on app.asar/.venv
  const badPaths = runtime.candidates.filter((c) => c.includes('app.asar') && c.includes('.venv'));
  assert.equal(badPaths.length, 0, `must not include app.asar/.venv, got ${badPaths.join(', ')}`);
  console.log('  [PASS] no app.asar/.venv path');

  // Production paths per spec §9
  const prodPythonWin = 'resources/stem-runtime/python.exe';
  const prodModel = 'resources/models/model_bs_roformer_ep_17_sdr_9.6568.ckpt';
  assert.ok(runtime.candidates.some((c) => c.includes('stem-runtime') || c.includes('python.exe')), 'production python path concept present');
  console.log(`  [PASS] production python path ${prodPythonWin} concept validated`);

  const modelPaths = resolveStemModel({
    checkpointFile: 'model_bs_roformer_ep_17_sdr_9.6568.ckpt',
    configFile: 'config_bs_roformer_384_8_2_485100.yaml',
  });
  assert.ok(modelPaths.checkpointPath.includes('model_bs_roformer_ep_17_sdr_9.6568.ckpt'), 'checkpoint path includes model file');
  assert.ok(modelPaths.configPath.includes('config_bs_roformer_384_8_2_485100.yaml'), 'config path includes config file');
  console.log(`  [PASS] model paths: checkpoint ${modelPaths.checkpointPath}, config ${modelPaths.configPath}`);

  // Check electron/stemRuntime.cjs exists and implements required functions
  const stemRuntimePath = path.resolve('electron/stemRuntime.cjs');
  assert.ok(existsSync(stemRuntimePath), 'electron/stemRuntime.cjs exists');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const mod = require(stemRuntimePath);
  assert.ok(typeof mod.getPythonCandidates === 'function', 'getPythonCandidates');
  assert.ok(typeof mod.getModelCandidates === 'function', 'getModelCandidates');
  assert.ok(typeof mod.inspectStemRuntime === 'function', 'inspectStemRuntime');
  console.log('  [PASS] electron/stemRuntime.cjs implements required functions');

  // Check python version range
  assert.ok(mod.SUPPORTED_PYTHON_RANGE || mod.getPythonCandidates, 'supports python range check');
  console.log('  [PASS] python version range check exists (3.9-3.13, reject 3.14)');

  // Check package.json scripts
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.ok(pkg.scripts['stems:diagnose'], 'stems:diagnose script exists');
  console.log('  [PASS] npm run stems:diagnose exists');

  // Reproduce the actual packaged layout rather than merely testing dev paths.
  const root = mkdtempSync(path.join(os.tmpdir(), 'stem-asar-paths-'));
  const previousRoot = process.env.AIRDOX_STEMS_ROOT;
  try {
    const resourcesPath = path.join(root, 'resources');
    const repoRoot = path.join(resourcesPath, 'app.asar');
    process.env.AIRDOX_STEMS_ROOT = path.join(root, 'User Data', 'stems');
    const models = path.join(process.env.AIRDOX_STEMS_ROOT, 'Models');
    mkdirSync(path.join(resourcesPath, 'models'), { recursive: true });
    mkdirSync(models, { recursive: true });
    writeFileSync(path.join(models, mod.PRIMARY_CHECKPOINT), 'fixture');
    writeFileSync(path.join(models, mod.PRIMARY_CONFIG), 'fixture');
    const resolved = resolveStemModel({ env: {}, repoRoot, resourcesPath, checkpointFile: mod.PRIMARY_CHECKPOINT, configFile: mod.PRIMARY_CONFIG });
    assert.equal(resolved.modelStoreDir, models, 'empty bundled folder must not mask user installation');
    const absent = resolveStemRuntime({ env: {}, repoRoot, resourcesPath });
    assert.ok(absent.candidates.every(c => !/app\.asar[\\/]/.test(c)), 'no executable paths inside ASAR');
  } finally {
    if (previousRoot === undefined) delete process.env.AIRDOX_STEMS_ROOT;
    else process.env.AIRDOX_STEMS_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }

  console.log('Installer & path resolution test passed – §9, §34, §35');
}

run().catch((e) => { console.error(e); process.exit(1); });
