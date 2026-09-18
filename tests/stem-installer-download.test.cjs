// @requires: python
'use strict';
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');

// Offline fault-injection tests: no real model/PyTorch or network required.
const script = String.raw`
import hashlib, importlib.util, io, tempfile, sys
sys.dont_write_bytecode = True
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('installer', __import__('sys').argv[1])
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    payload = b'trained-checkpoint-fixture'
    ref = {'file': 'model.ckpt', 'url': 'https://example.invalid/model', 'sha256': hashlib.sha256(payload).hexdigest()}
    target = root / ref['file']
    with patch.object(installer.urllib.request, 'urlopen', return_value=io.BytesIO(payload)) as request:
        assert installer.download(ref, root).read_bytes() == payload
        assert request.call_count == 1
    with patch.object(installer.urllib.request, 'urlopen', side_effect=AssertionError('must reuse verified checkpoint')):
        assert installer.download(ref, root) == target
    target.write_bytes(b'old broken checkpoint')
    with patch.object(installer.urllib.request, 'urlopen', return_value=io.BytesIO(b'corrupt download')):
        try:
            installer.download(ref, root)
            raise AssertionError('hash mismatch accepted')
        except ValueError as error:
            assert 'SHA256' in str(error)
    assert target.read_bytes() == b'old broken checkpoint'
    assert not (root / 'model.ckpt.part').exists()
    with patch.object(installer.urllib.request, 'urlopen', side_effect=OSError('offline')):
        try:
            installer.download(ref, root)
            raise AssertionError('offline download accepted')
        except OSError:
            pass
    assert not (root / 'model.ckpt.part').exists()
    with patch.object(installer.urllib.request, 'urlopen', return_value=io.BytesIO(payload)):
        assert installer.download(ref, root).read_bytes() == payload
    for name in ['../escape', 'dir/model', r'dir\model']:
        try:
            installer.download({**ref, 'file': name}, root)
            raise AssertionError('path traversal accepted')
        except ValueError:
            pass
print('PASS: atomic downloads, SHA256, retry, offline failure, path traversal')
`;
const python = process.env.AIRODOX_STEM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, ['-c', script, path.join(__dirname, '../python/install_bsroformer.py')], { encoding: 'utf8', timeout: 30000 });
assert.equal(result.status, 0, result.stderr || result.error?.message);
console.log(result.stdout.trim());
