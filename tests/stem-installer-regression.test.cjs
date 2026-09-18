'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installStemEngine, installationPaths, unpackedPath, probeVersion, runStreaming } = require('../electron/stemInstaller.cjs');
const { resolveEnginePaths, registerStemEngineIpc, CHANNELS } = require('../electron/stemEngineBridge.cjs');
const runtime = require('../electron/stemRuntime.cjs');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-installer-'));
  const env = { ...process.env };
  try {
    for (const key of ['AIRODOX_STEM_PYTHON', 'DEMUCS_PYTHON', 'AIRODOX_STEM_MODEL_DIR', 'AIRODOX_STEM_CHECKPOINT_DIR']) delete process.env[key];
    const repo = path.join(temp, 'portable', 'resources', 'app.asar');
    const stemsRoot = path.join(temp, 'App Data', 'airdox_SMART_Editor', 'stems');
    const paths = installationPaths(repo, { stemsRoot });
    assert.ok(!paths.python.includes('app.asar'));
    assert.ok(paths.script.includes('app.asar.unpacked'));
    assert.equal(unpackedPath('C:\\Temp\\resources\\app.asar\\python\\x.py'), 'C:\\Temp\\resources\\app.asar.unpacked\\python\\x.py');
    assert.equal(unpackedPath('/resources/app.asar.unpacked/python/x.py'), '/resources/app.asar.unpacked/python/x.py');
    assert.throws(() => installationPaths(repo, { stemsRoot: path.join(repo, 'stems') }), /ASAR/);
    fs.mkdirSync(path.dirname(paths.catalog), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../src/stems/modelCatalog.json'), paths.catalog);
    const calls = [];
    const progress = [];
    const run = async (command, args) => {
      calls.push({ command, args });
      if (args.includes('-c')) return { ok: true, output: '3.11\n' };
      if (args.includes('venv')) {
        fs.mkdirSync(path.dirname(paths.python), { recursive: true });
        fs.writeFileSync(paths.python, 'test double');
      }
      return { ok: true, output: args.includes('6') ? 'BSROFORMER_VERIFIED\n' : '' };
    };
    const result = await installStemEngine(repo, p => progress.push(p), { stemsRoot, run });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.python, paths.python);
    assert.equal(result.model, runtime.PRIMARY_MODEL_ID);
    assert.equal(result.modelDir, paths.modelDir);
    assert.equal(progress.at(-1).percent, 100);
    assert.ok(calls.some(c => c.args.includes('venv') && c.args.includes(paths.runtimeDir)));
    assert.deepEqual(calls.filter(c => c.args.includes('--step')).map(c => c.args[c.args.indexOf('--step') + 1]), ['3', '4', '5', '6']);
    assert.ok(!JSON.stringify(calls).includes('demucs'));
    assert.ok(calls.filter(c => c.args.includes('--step')).every(c => c.args[0] === paths.script));
    const retryCalls = [];
    const failed = await installStemEngine(repo, undefined, { stemsRoot, run: async (c, a) => {
      retryCalls.push(a);
      if (a.includes('5')) return { ok: false, output: 'SHA256 mismatch' };
      return run(c, a);
    } });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /SHA256 mismatch/);
    assert.ok(!retryCalls.some(a => a.includes('venv') || a.includes('6')));
    const noVerification = await installStemEngine(repo, undefined, { stemsRoot, run: async (c, a) => a.includes('6') ? { ok: true, output: 'not verified' } : run(c, a) });
    assert.equal(noVerification.ok, false, 'Exit 0 alone is not proof of test inference');
    for (const v of ['3.9', '3.13', '3.14', '2.7']) assert.equal(await probeVersion('python', [], async () => ({ ok: true, output: v })), null);
    assert.ok(await probeVersion('python', [], async () => ({ ok: true, output: '3.11' })));
    const missingPython = await installStemEngine(repo, undefined, { stemsRoot, run: async () => ({ ok: false, output: 'not found' }) });
    assert.equal(missingPython.ok, false);
    assert.match(missingPython.error, /Python 3.11/);
    assert.equal((await runStreaming('airdox-no-such-python-command', [], null, 1000)).ok, false);

    // A shipped README-only models directory must never mask user models.
    fs.mkdirSync(path.join(repo, 'resources', 'models'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'resources', 'models', 'README.md'), 'placeholder');
    fs.writeFileSync(path.join(paths.modelDir, runtime.PRIMARY_CHECKPOINT), 'fixture');
    fs.writeFileSync(path.join(paths.modelDir, runtime.PRIMARY_CONFIG), 'fixture');
    process.env.AIRDOX_STEMS_ROOT = stemsRoot;
    assert.equal(resolveEnginePaths(repo, stemsRoot).modelStoreDir, paths.modelDir);
    assert.equal(resolveEnginePaths(repo, stemsRoot).backend.pythonCommand, paths.python);
    assert.equal(resolveEnginePaths(repo, stemsRoot).backend.adapterScript, paths.adapter);
    assert.ok(runtime.getPythonCandidates(repo, null).includes(paths.python));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const windowsPaths = installationPaths(repo, { stemsRoot });
      assert.equal(windowsPaths.python, path.join(stemsRoot, 'stem-runtime', 'Scripts', 'python.exe'));
      assert.ok(runtime.getPythonCandidates(repo, null).includes(windowsPaths.python));
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    assert.ok(!runtime.getPythonCandidates(repo, null).some(p => /app\.asar[\\/]/.test(p)));
    const hashFile = path.join(temp, 'hash-test');
    fs.writeFileSync(hashFile, Buffer.alloc(2048));
    assert.equal((await runtime.verifyCheckpoint(hashFile, undefined)).verified, false);
    assert.equal((await runtime.verifyCheckpoint(hashFile, await runtime.computeSha256(hashFile))).verified, true);

    // Real bridge handlers must read the replacement bridge after installation.
    // Use an isolated real bundle so the test works on a clean checkout too.
    const bundle = path.join(temp, 'bridge.cjs');
    await require('esbuild').build({ entryPoints: [path.join(__dirname, '../src/stems/nodeBridge.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
    process.env.AIRDOX_STEMS_BRIDGE = bundle;
    const handlers = new Map();
    const host = registerStemEngineIpc({ repoRoot: path.join(__dirname, '..'), userDataDir: path.join(temp, 'host'), ipcMain: { handle: (key, fn) => handlers.set(key, fn) } });
    assert.equal(host.available, true, 'Build the stem bridge before this test');
    const original = host.bridge;
    assert.equal(host.refreshRuntime(), true);
    assert.notEqual(host.bridge, original);
    host.bridge.status = async () => ({ ok: true, refreshed: true });
    assert.equal((await handlers.get(CHANNELS.status)()).refreshed, true);
    host.bridge.jobs = () => ({ ok: true, data: [{ status: 'RUNNING' }] });
    assert.equal(host.refreshRuntime(), false, 'Do not discard existing jobs');
    host.bridge.close();
    console.log('PASS: packaged BS-RoFormer installer, retries, verification, paths, bridge refresh');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
