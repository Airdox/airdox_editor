'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  FT_WEIGHT_FILES,
  defaultPythonCandidates,
  inspectDemucsEnvironment,
  probePython,
  resolvePython,
  separateWav,
} = require('../electron/demucsRunner.cjs');

const result = (payload, overrides = {}) => ({
  ok: true, code: 0, stdout: JSON.stringify(payload) + '\n', stderr: '', ...overrides,
});
const good = { version: [3, 12, 8], executable: 'C:\\Python312\\python.exe', demucs: true, torch: '2.7', torchaudio: '2.7' };

async function run() {
  let passed = 0;

  // 1. Installed, compatible Python + all imports.
  let probe = await probePython('python-good', async () => result(good));
  assert.equal(probe.usable, true); passed++;

  // 2. Python executable not found / spawn error.
  probe = await probePython('python-missing', async () => ({ ok: false, code: null, stdout: '', stderr: '', error: 'ENOENT' }));
  assert.equal(probe.usable, false); assert.match(probe.reason, /ENOENT/); passed++;

  // 3. Python exists but Demucs is not installed (the screenshot failure).
  probe = await probePython('C:\\Python314\\python.exe', async () => result({
    version: [3, 14, 0], executable: 'C:\\Python314\\python.exe', demucs: false,
    importError: "No module named 'demucs'",
  }));
  assert.equal(probe.usable, false); assert.match(probe.reason, /3\.14.*nicht unterstützt/); passed++;

  // 4. Supported Python but missing Demucs module.
  probe = await probePython('python-no-demucs', async () => result({
    version: [3, 12, 4], executable: 'python-no-demucs', demucs: false,
    importError: "No module named 'demucs'",
  }));
  assert.equal(probe.usable, false); assert.match(probe.reason, /Demucs-Import fehlgeschlagen/); passed++;

  // 5. Broken torch/torchaudio binary import is reported like any import failure.
  probe = await probePython('python-broken-torch', async () => result({
    version: [3, 11, 9], executable: 'python-broken-torch', demucs: false,
    importError: 'DLL load failed while importing torch',
  }));
  assert.equal(probe.usable, false); assert.match(probe.reason, /DLL load failed/); passed++;

  // 6. Truncated/non-JSON subprocess output cannot be mistaken for readiness.
  probe = await probePython('python-garbage', async () => ({ ok: true, code: 0, stdout: 'not-json', stderr: '' }));
  assert.equal(probe.usable, false); assert.match(probe.reason, /Ungültige/); passed++;

  // 7. Candidate search skips bad system Python and selects the valid venv.
  const attempts = [];
  const status = await inspectDemucsEnvironment('/repo', ['system-python', 'venv-python'], async (command) => {
    attempts.push(command);
    return command === 'venv-python'
      ? { command, usable: true, details: good }
      : { command, usable: false, reason: "No module named 'demucs'" };
  });
  assert.equal(status.available, true); assert.equal(status.python, 'venv-python');
  assert.deepEqual(attempts, ['system-python', 'venv-python']); passed++;

  // 8. No candidate usable -> aggregated, actionable diagnosis.
  const unavailable = await inspectDemucsEnvironment('/repo', ['py-a', 'py-b'], async (command) => ({
    command, usable: false, reason: command === 'py-a' ? 'ENOENT' : "No module named 'demucs'",
  }));
  assert.equal(unavailable.available, false); assert.match(unavailable.reason, /py-a: ENOENT/);
  assert.match(unavailable.reason, /py-b: No module/); passed++;

  // 9. Resolution fails before inference with setup guidance.
  await assert.rejects(
    resolvePython('/definitely/missing', ['/definitely/missing/python']),
    /Keine verwendbare Demucs-Installation|Windows Python/
  ); passed++;

  // 10. Invalid audio is rejected before any Python/model work.
  await assert.rejects(separateWav(Buffer.alloc(12)), /gültige WAV/); passed++;

  // 11. Candidate lists prioritize the project-owned venv over system Python.
  const candidates = defaultPythonCandidates(path.resolve('/repo'));
  assert.match(candidates[0], /\.venv/); passed++;

  // 12. Fine-tuned ensemble readiness requires all four known checkpoints.
  assert.deepEqual(FT_WEIGHT_FILES.sort(), [
    '04573f0d-f3cf25b2.th', '92cfc3b6-ef3bcb9c.th',
    'd12395a8-e57c48e6.th', 'f7e0c4bc-ba3fe64a.th',
  ].sort()); passed++;

  console.log(`Demucs/Python environment preflight: ${passed} installation and failure scenarios passed`);
}

run().catch((error) => { console.error(error); process.exit(1); });
