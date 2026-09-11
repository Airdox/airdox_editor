/**
 * @license
 * Verifies the Rekordbox database read pipeline (electron/dbReader.cjs,
 * readRekordboxDatabase) with a fake cipher module – no native SQLCipher
 * binding needed.
 *
 * Regression guard for v0.4.19: openRekordboxDb returned { db, dbType }
 * without `available: true`, so readRekordboxDatabase mistook every
 * successful decrypt for a reason-less failure ("nicht lesbar").
 *
 * Run with: node tests/db-read-pipeline.test.mjs
 */

import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  readRekordboxDatabase,
  setCipherModuleForTests,
  getMasterDbKey,
  getOneLibraryKey,
} = require('../electron/dbReader.cjs');

// Minimal better-sqlite3 stand-in: records opens/pragmas, serves canned
// tables, tracks close(). Static state via post-class assignment (max
// parser compatibility).
class FakeDatabase {
  constructor(filePath, options) {
    this.filePath = filePath;
    this.options = options;
    this.closed = false;
    FakeDatabase.instances.push(this);
  }
  pragma(statement) {
    FakeDatabase.pragmas.push(String(statement));
  }
  prepare(sql) {
    const q = String(sql);
    if (/count\(\*\)/i.test(q)) return { get: () => ({ n: 9 }) };
    if (/FROM sqlite_master/i.test(q)) {
      return { all: () => FakeDatabase.masterTables.map((name) => ({ name })) };
    }
    const m = q.match(/FROM\s+(\w+)/i);
    const table = m ? m[1] : '';
    const rows = (FakeDatabase.rowsByTable[table] || []).map((r) => ({ ...r }));
    return { all: () => rows };
  }
  close() {
    this.closed = true;
  }
}
FakeDatabase.instances = [];
FakeDatabase.pragmas = [];
FakeDatabase.masterTables = [];
FakeDatabase.rowsByTable = {};

function resetFake() {
  FakeDatabase.instances = [];
  FakeDatabase.pragmas = [];
  FakeDatabase.masterTables = [];
  FakeDatabase.rowsByTable = {};
}

// ─── MASTER_DB success: open → key → probe → fetch → close ──────────────
setCipherModuleForTests(FakeDatabase);
resetFake();
FakeDatabase.masterTables = ['djmdContent', 'djmdCue', 'djmdArtist'];
FakeDatabase.rowsByTable = {
  djmdContent: [
    {
      ID: 7,
      FolderPath: 'G:\\Music',
      FileNameL: 'Test.mp3',
      Title: 'Test',
      BPM: 120,
      AnalysisDataPath: 'PIONEER/USBANLZ/xyz/ANLZ0000.DAT',
    },
  ],
  djmdCue: [],
};
const res = readRekordboxDatabase('D:\\PIONEER\\Master\\master.db');
assert.strictEqual(res.available, true, 'successful decrypt reports available:true');
assert.strictEqual(res.dbType, 'MASTER_DB', 'dbType passes through');
assert.ok(/master\.db$/.test(res.fileName), 'fileName reported (platform basename)');
assert.strictEqual(res.rows.content.length, 1, 'content rows pass through');
assert.strictEqual(
  res.rows.content[0].AnalysisDataPath,
  'PIONEER/USBANLZ/xyz/ANLZ0000.DAT',
  'AnalysisDataPath survives the pipeline'
);
assert.strictEqual(res.stats.tracks, 1, 'stats count content rows');
assert.deepStrictEqual(
  FakeDatabase.pragmas,
  ['cipher = sqlcipher', 'legacy = 4', `key = '${getMasterDbKey()}'`],
  'cipher profile + master key applied in order'
);
assert.strictEqual(FakeDatabase.instances.length, 1, 'exactly one open');
assert.deepStrictEqual(
  FakeDatabase.instances[0].options,
  { readonly: true, fileMustExist: true },
  'database opened read-only'
);
assert.strictEqual(FakeDatabase.instances[0].closed, true, 'database closed after read');

// ─── Probe failure: wrong schema for MASTER_DB ──────────────────────────
resetFake();
FakeDatabase.masterTables = ['content', 'cue']; // OneLibrary schema, wrong DB type
FakeDatabase.rowsByTable = { content: [{ content_id: 1 }] };
const drifted = readRekordboxDatabase('D:\\PIONEER\\Master\\master.db');
assert.strictEqual(drifted.available, false, 'schema drift fails');
assert.ok(drifted.reason && drifted.reason.length > 0, 'drift failure carries a reason');
assert.ok(/Integrit\u00e4tspr\u00fcfung/.test(drifted.reason), 'reason names the integrity check');
assert.strictEqual(FakeDatabase.instances[0].closed, true, 'database closed on probe failure');

// ─── ONE_LIBRARY success ────────────────────────────────────────────────
resetFake();
FakeDatabase.masterTables = ['content', 'cue'];
FakeDatabase.rowsByTable = {
  content: [{ content_id: 3, analysisDataFilePath: 'ANLZ/ANLZ0001.DAT' }],
  cue: [],
};
const oneLib = readRekordboxDatabase('E:\\PIONEER\\exportLibrary.db');
assert.strictEqual(oneLib.available, true, 'OneLibrary read succeeds');
assert.strictEqual(oneLib.dbType, 'ONE_LIBRARY', 'OneLibrary type detected');
assert.ok(
  FakeDatabase.pragmas[2] === `key = '${getOneLibraryKey()}'`,
  'OneLibrary key applied'
);

// ─── Unsupported file ───────────────────────────────────────────────────
const unsupported = readRekordboxDatabase('/tmp/other.db');
assert.strictEqual(unsupported.available, false, 'unsupported file fails');
assert.ok(unsupported.reason && unsupported.reason.length > 0, 'unsupported failure carries a reason');

// ─── Missing native module ──────────────────────────────────────────────
setCipherModuleForTests(null);
const noModule = readRekordboxDatabase('D:\\PIONEER\\Master\\master.db');
assert.strictEqual(noModule.available, false, 'missing module fails');
assert.ok(noModule.reason && noModule.reason.length > 0, 'missing-module failure carries a reason');
assert.ok(/SQLCipher-Modul/.test(noModule.reason), 'reason names the module');
setCipherModuleForTests(undefined);

console.log('Rekordbox DB read pipeline (fake cipher module): OK');
