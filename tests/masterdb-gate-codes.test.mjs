/** Gate failure classifications stay machine-readable for the persistent
 * renderer diagnostics. No database is opened or written by these checks. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readRekordboxTrackAnalysis } = require('../electron/dbReader.cjs');

const foreign = readRekordboxTrackAnalysis('C:\\Pioneer\\rekordbox7\\master.db', '4242');
assert.equal(foreign.available, false);
assert.equal(foreign.code, 'MASTER_DB_NOT_FOUND');
assert.equal(foreign.stage, 'MASTER_DB');

const absent = readRekordboxTrackAnalysis('D:\\Pioneer\\rekordbox7\\missing-master.db', '4242');
assert.equal(absent.available, false);
assert.equal(absent.code, 'MASTER_DB_NOT_FOUND');
assert.equal(absent.stage, 'MASTER_DB');

const noId = readRekordboxTrackAnalysis('D:\\Pioneer\\rekordbox7\\master.db', '');
assert.equal(noId.available, false);
assert.equal(noId.code, 'TRACK_NOT_FOUND_IN_MASTER_DB');
assert.equal(noId.stage, 'MASTER_DB');

console.log('master DB gate codes: OK');
