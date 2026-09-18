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
const { getMasterDbKey, getOneLibraryKey, detectDbType } = require('../electron/dbReader.cjs');

const expectedMaster = '402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497';
const expectedOneLibrary = 'r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls';

assert.strictEqual(getMasterDbKey(), expectedMaster, 'master.db SQLCipher key');
assert.strictEqual(getOneLibraryKey(), expectedOneLibrary, 'exportLibrary.db SQLCipher key');

assert.strictEqual(detectDbType('C:\\Users\\x\\AppData\\Roaming\\Pioneer\\rekordbox7\\master.db'), 'MASTER_DB');
assert.strictEqual(detectDbType('/media/USB/PIONEER/rekordbox/exportLibrary.db'), 'ONE_LIBRARY');
assert.strictEqual(detectDbType('/tmp/other.db'), null);

console.log('dbReader key derivation & DB type detection: OK');
