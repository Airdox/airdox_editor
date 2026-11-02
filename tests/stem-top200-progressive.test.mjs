// @requires: python
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  ['tests/test_top200_progressive.py'], { encoding: 'utf8', timeout: 120_000 });
assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ''));
console.log(result.stdout + result.stderr);
