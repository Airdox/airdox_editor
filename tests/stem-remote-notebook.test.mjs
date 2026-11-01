// @requires: python
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const venv = path.resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
const python = process.env.PYTHON || process.env.AIRODOX_PYTHON || (existsSync(venv) ? venv : 'python');
const code = String.raw`
import json, pathlib, sys, tempfile, types
notebook = json.load(open('colab/airdox-stem-remote-worker.ipynb', encoding='utf-8-sig'))
cells = [''.join(c['source']) for c in notebook['cells'] if c['cell_type'] == 'code']
torch = types.ModuleType('torch')
torch.__version__ = 'test'
torch.cuda = types.SimpleNamespace(is_available=lambda: True, get_device_name=lambda i: 'test GPU')
sys.modules['torch'] = torch
colab = types.ModuleType('google.colab')
mounts = []
colab.drive = types.SimpleNamespace(mount=lambda p: mounts.append(p))
sys.modules['google'] = types.ModuleType('google')
sys.modules['google.colab'] = colab

with tempfile.TemporaryDirectory(prefix='airdox-notebook-') as temp:
    root = pathlib.Path(temp)
    jobs = root / 'airdox-stem-jobs' / 'jobs'
    jobs.mkdir(parents=True)
    cell = cells[1].replace('"/content/drive/MyDrive"', repr(str(root)))
    state = {}
    exec(cells[0], state)
    assert state['FEHLGESCHLAGENE_WIEDERHOLEN'] is False
    def attempt(error=None):
        if error:
            try: exec(cell, state)
            except RuntimeError as exc: assert error in str(exc), str(exc)
            else: raise AssertionError('Expected failure: ' + error)
            assert state['SELECTED_JOB_ID'] is None
        else: exec(cell, state)

    torch.cuda.is_available = lambda: False
    attempt('Keine GPU')
    assert not mounts, 'GPU failure must precede Drive access/setup'
    torch.cuda.is_available = lambda: True
    attempt('0 offene')
    def job(name, status='RUNNING', upload=True):
        folder = jobs / name
        (folder / 'input').mkdir(parents=True, exist_ok=True)
        data = {'jobId': name, 'status': status, 'engine': {'modelId': 'model-test', 'profile': 'HIGH_QUALITY'},
                'input': {'fileName': 'mix.wav', 'bytes': 4}}
        (folder / 'manifest.json').write_text(json.dumps(data), encoding='utf-8')
        if upload: (folder / 'input' / 'mix.wav').write_bytes(b'test')
    job('job-a', upload=False)
    attempt('Audio-Upload')
    job('job-a')
    attempt()
    assert state['SELECTED_JOB_ID'] == 'job-a'
    job('job-b')
    attempt('2 offene')
    state['JOB_ID'] = 'job-b'
    attempt()
    assert state['SELECTED_JOB_ID'] == 'job-b'
    job('job-b', 'COMPLETED')
    attempt('Auftrag fehlt')
    job('job-b', 'FAILED')
    attempt('Auftrag fehlt')
    state['FEHLGESCHLAGENE_WIEDERHOLEN'] = True
    attempt()
    assert state['SELECTED_JOB_ID'] == 'job-b'
    state['PRAKTIKUM_SELBSTTEST'] = True
    state['JOB_ID'] = ''
    attempt()
    assert state['SELECTED_JOB_ID'].startswith('colab-selftest-')
    assert state['MODELL_ID'] == 'bsroformer-musdb18hq-4stem-zfturbo'
    assert state['PROFIL'] == 'HIGH_QUALITY'
    assert not (jobs / state['SELECTED_JOB_ID']).exists(), 'Selftest creates its manifest only after model verification'
    state['PRAKTIKUM_SELBSTTEST'] = False
    state['JOB_ID'] = 'job-b'
    attempt()
    # Execute the real launch cell with subprocess and time doubles. No Drive,
    # model download or real GPU is touched by this notebook contract test.
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        if '--once' in command: job('job-b', 'COMPLETED')
    state.update(WORKER='worker.py', ADAPTER='adapter.py', MODELL_DIR='models', READY_JOB_ID='job-b',
                 subprocess=types.SimpleNamespace(run=run), sys=sys)
    exec(cells[-1], state)
    command = next(c for c in calls if '--once' in c)
    assert command[command.index('--job-id') + 1] == 'job-b'
    assert command[command.index('--max-jobs') + 1] == '1'
    assert command[command.index('--device') + 1] == 'cuda'
    assert '--clean-finished' not in command
    assert len(calls) == 2, 'Exactly one diagnostic and one bounded run'
print('PASS notebook: no GPU, no job, incomplete upload, ambiguous selection, explicit retry, bounded launch')
`;
const result = spawnSync(python, ['-c', code], {
  encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
assert.equal(result.status, 0, result.error?.message || `${result.stdout}\n${result.stderr}`);
console.log(result.stdout.trim().split('\n').at(-1));
