// @requires: python
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['tests/top200_batch_test.py'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stdout + result.stderr);
console.log(result.stdout);
