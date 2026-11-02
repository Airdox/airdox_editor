// @requires: python
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['tests/test_top200_recovery.py'], { encoding: 'utf8', timeout: 60000 });
assert.equal(result.status, 0, result.stdout + result.stderr);
console.log(result.stdout + result.stderr);
