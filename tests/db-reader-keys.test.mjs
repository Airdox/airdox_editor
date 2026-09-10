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
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { getMasterDbKey, getOneLibraryKey, detectDbType, classifyDbOpenError } = require('../electron/dbReader.cjs');

const expectedMaster = '402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497';
const expectedOneLibrary = 'r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls';

assert.strictEqual(getMasterDbKey(), expectedMaster, 'master.db SQLCipher key');
assert.strictEqual(getOneLibraryKey(), expectedOneLibrary, 'exportLibrary.db SQLCipher key');

assert.strictEqual(detectDbType('C:\\Users\\x\\AppData\\Roaming\\Pioneer\\rekordbox7\\master.db'), 'MASTER_DB');
assert.strictEqual(detectDbType('/media/USB/PIONEER/rekordbox/exportLibrary.db'), 'ONE_LIBRARY');
assert.strictEqual(detectDbType('/tmp/other.db'), null);

// ─── Fehlerklassifikation (verträgliche Meldungen, z. B. Rekordbox läuft) ──
assert.strictEqual(classifyDbOpenError(new Error('database is locked')), 'LOCKED');
assert.strictEqual(classifyDbOpenError(new Error('SQLITE_BUSY: database is locked (5)')), 'LOCKED');
assert.strictEqual(classifyDbOpenError(new Error('file is not a database')), 'ENCRYPTED_OR_CORRUPT');
assert.strictEqual(classifyDbOpenError(new Error('unable to open database file')), 'UNREADABLE');
assert.strictEqual(classifyDbOpenError(new Error('EACCES: permission denied')), 'UNREADABLE');
assert.strictEqual(classifyDbOpenError(new Error('sonstiger Fehler')), 'UNKNOWN');

// ─── Source-Contract: Read-Only + busy-Timeout (SQLite-Best-Practice) ──────
const dbReaderSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'dbReader.cjs'), 'utf8');
const openStart = dbReaderSrc.indexOf('function openRekordboxDb');
const openEnd = dbReaderSrc.indexOf('function normalizeRow');
assert.ok(openStart >= 0 && openEnd > openStart, 'openRekordboxDb-Sektion gefunden');
const openSection = dbReaderSrc.slice(openStart, openEnd);
assert.ok(
  /readonly:\s*true/.test(openSection) && /timeout:\s*\d+/.test(openSection),
  'DB wird read-only geöffnet mit explizitem Lock-Timeout (busy-Timeout auf jeder Verbindung)',
);
assert.ok(
  /query_only\s*=\s*ON/.test(openSection),
  'query_only=ON als zweite Verteidigungsebene der Read-Only-Garantie',
);

console.log('dbReader key derivation & DB type detection: OK');
