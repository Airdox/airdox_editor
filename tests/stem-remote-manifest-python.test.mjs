/**
 * @requires: python
 *
 * Prüft dieselbe versionierte Fixture wie die TypeScript-Suite gegen den
 * Colab-Worker. Dadurch bleiben Schema-Version, Status, Job-ID und die
 * gemeinsamen Input-/Engine-Felder über beide Laufzeitgrenzen hinweg gleich.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.AIRODOX_STEM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const fixture = path.join(root, 'tests', 'fixtures', 'stem-remote-manifest-v1.json');
const checkFixture = String.raw`
import json
import sys
sys.path.insert(0, 'colab')
from remote_worker import SCHEMA_VERSION, validate_manifest
with open(sys.argv[1], encoding='utf-8') as handle:
    manifest = json.load(handle)
validated = validate_manifest(manifest, '00000000-0000-4000-8000-000000000001')
assert validated['schemaVersion'] == SCHEMA_VERSION
assert validated['status'] == 'PENDING'
assert validated['engine']['stems'] == ['drums', 'bass', 'other', 'vocals']
print('Gemeinsame v1-Fixture vom Colab-Worker akzeptiert')
`;

const result = spawnSync(python, ['-c', checkFixture, fixture], {
  cwd: root,
  encoding: 'utf8',
  timeout: 15_000,
  windowsHide: true,
});

assert.ifError(result.error);
assert.equal(result.status, 0, `${python} hat die gemeinsame Manifest-Fixture abgelehnt:\n${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /Gemeinsame v1-Fixture vom Colab-Worker akzeptiert/);
console.log('TypeScript/Python-Manifestvertrag: gemeinsame Fixture bestanden');
