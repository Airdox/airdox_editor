/**
 * @license
 * Verifies the Rekordbox SQLCipher key derivation used by the Electron
 * main process (electron/dbReader.cjs).
 *
 * The community-deobfuscated keys and the documented OneLibrary / master.db
 * key strings are asserted, so a wrong base85/rot/inflate implementation is
 * caught immediately. No user data is touched.
 *
 * Run with: node tests/db-reader-keys.test.mjs
 */

import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getMasterDbKey, getOneLibraryKey, detectDbType, probeDbTables } = require('../electron/dbReader.cjs');

const expectedMaster = '402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497';
const expectedOneLibrary = 'r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls';

assert.strictEqual(getMasterDbKey(), expectedMaster, 'master.db SQLCipher key');
assert.strictEqual(getOneLibraryKey(), expectedOneLibrary, 'exportLibrary.db SQLCipher key');

assert.strictEqual(detectDbType('C:\\Users\\x\\AppData\\Roaming\\Pioneer\\rekordbox7\\master.db'), 'MASTER_DB');
assert.strictEqual(detectDbType('/media/USB/PIONEER/rekordbox/exportLibrary.db'), 'ONE_LIBRARY');
assert.strictEqual(detectDbType('/tmp/other.db'), null);

// probeDbTables guards against silent corruption after a Rekordbox update:
// a wrong key or changed schema must fail LOUDLY (per-track PPTH fallback),
// never deliver garbage rows. Pure probe – no native module needed.
const fakeDb = (names, throws) => ({
  prepare: () => ({
    all: () => {
      if (throws) throw new Error('file is not a database');
      return names.map((name) => ({ name }));
    },
  }),
});
assert.deepStrictEqual(
  probeDbTables(fakeDb(['djmdContent', 'djmdCue', 'sqlite_sequence'], false), 'MASTER_DB'),
  { ok: true },
  'master.db with expected tables validates'
);
assert.deepStrictEqual(
  probeDbTables(fakeDb(['content', 'cue'], false), 'ONE_LIBRARY'),
  { ok: true },
  'exportLibrary.db with expected tables validates'
);
const wrongKey = probeDbTables(fakeDb([], true), 'MASTER_DB');
assert.strictEqual(wrongKey.ok, false, 'unreadable schema fails loudly');
assert.ok(/Tabellenliste nicht lesbar/.test(wrongKey.reason), 'reason names the cause');
const drifted = probeDbTables(fakeDb(['content', 'cue'], false), 'MASTER_DB');
assert.strictEqual(drifted.ok, false, 'schema drift fails loudly');
assert.ok(/djmdContent/.test(drifted.reason), 'reason names the missing table');

console.log('dbReader key derivation & DB type detection: OK');
