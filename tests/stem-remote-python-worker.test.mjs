// @requires: python
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const python = process.env.AIRODOX_STEM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, ['tests/fixtures/remote/worker_tests.py'], { encoding: 'utf8', timeout: 60000 });
console.log(result.stdout);
console.error(result.stderr);
assert.equal(result.status, 0, result.error?.message || 'Python worker regression tests');
