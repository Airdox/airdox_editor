#!/usr/bin/env node
/**
 * Reproducible native SQLCipher verification.
 *
 * This script deliberately does not inject a driver into masterDbGate.cjs.
 * It loads the production better-sqlite3-multiple-ciphers binding, proves its
 * encryption semantics with a temporary database, and then runs the existing
 * production Master-DB gate through its normal native-driver loader.
 *
 * Without --db a synthetic Rekordbox-shaped master.db is created in /tmp.
 * With --db an existing master.db is opened read-only; this is intended for a
 * manually supplied, non-public test database and never writes beside it.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let Database;
const dbReader = require('../electron/dbReader.cjs');
const { resolveTrackFromMasterDb } = require('../electron/masterDbGate.cjs');

const MODULE_NAME = 'better-sqlite3-multiple-ciphers';
const MASTER_DB_KEY = dbReader.getMasterDbKey();
const WRONG_KEY = 'airdox-ci-definitely-not-the-master-db-key';

function parseArgs(argv) {
  const options = { db: null, track: null, report: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') options.db = argv[++i] || null;
    else if (arg === '--track') options.track = argv[++i] || null;
    else if (arg === '--report') options.report = argv[++i] || null;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

const HELP = `Native SQLCipher + production Master-DB gate

  node scripts/sqlcipher-native-gate.mjs
  node scripts/sqlcipher-native-gate.mjs --db /secure/path/master.db [--track ID]
  node scripts/sqlcipher-native-gate.mjs --report ci-artifacts/report.json

The default mode creates only a temporary synthetic master.db. --db is
read-only and is for a privately supplied Rekordbox test database.
`;

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fileFingerprint(filePath) {
  const stat = fs.statSync(filePath);
  return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs), sha256: sha256(filePath) };
}

function cipherPragmas(db, key) {
  // This is the documented better-sqlite3-multiple-ciphers API already used
  // by electron/dbReader.cjs and electron/masterDbGate.cjs.
  db.pragma('cipher = sqlcipher');
  db.pragma('legacy = 4');
  db.pragma(`key = '${key}'`);
}

function readCipherVersion(db) {
  try {
    return db.pragma('cipher_version', { simple: true }) || null;
  } catch {
    // The encrypted-file and wrong-key checks below are the authoritative
    // checks. Some builds do not expose cipher_version as a scalar pragma.
    return null;
  }
}

function createSyntheticMasterDb(root) {
  const dbPath = path.join(root, 'master.db');
  const db = new Database(dbPath);
  try {
    cipherPragmas(db, MASTER_DB_KEY);
    db.exec(`
      CREATE TABLE djmdProperty (
        ID INTEGER PRIMARY KEY,
        Name TEXT NOT NULL,
        Value TEXT
      );
      CREATE TABLE djmdContent (
        ID INTEGER PRIMARY KEY,
        FolderPath TEXT,
        FileNameL TEXT,
        Title TEXT,
        ArtistID INTEGER,
        BPM INTEGER,
        Length INTEGER,
        SampleRate INTEGER,
        FileSize INTEGER,
        Rating INTEGER,
        DJPlayCount INTEGER,
        ReleaseYear INTEGER,
        Commnt TEXT,
        AnalysisDataPath TEXT
      );
      CREATE TABLE djmdCue (
        ID INTEGER PRIMARY KEY,
        ContentID INTEGER,
        Kind INTEGER,
        InMsec INTEGER,
        OutMsec INTEGER,
        Comment TEXT,
        Color INTEGER,
        ActiveLoop INTEGER
      );
      INSERT INTO djmdProperty (ID, Name, Value)
        VALUES (1, 'airdox-ci-fixture', 'synthetic-sqlcipher-master-db');
      INSERT INTO djmdContent (
        ID, FolderPath, FileNameL, Title, ArtistID, BPM, Length, SampleRate,
        FileSize, Rating, DJPlayCount, ReleaseYear, Commnt, AnalysisDataPath
      ) VALUES (
        101, '/tmp/airdox-ci-audio', 'native-sqlcipher-fixture.wav',
        'Airdox CI SQLCipher Fixture', 7, 12800, 240000, 44100,
        9876543, 255, 3, 2026, 'Synthetic CI data',
        '/PIONEER/USBANLZ/ci/ANLZ0000.DAT'
      );
      INSERT INTO djmdCue (ID, ContentID, Kind, InMsec, OutMsec, Comment, Color, ActiveLoop)
        VALUES (1, 101, 0, 0, -1, 'Synthetic intro', 0, 0);
    `);
  } finally {
    db.close();
  }
  return { dbPath, trackId: '101', synthetic: true };
}

function loadReport(reportPath, report) {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}${os.EOL}`, 'utf8');
  console.log(`CI report written: ${path.resolve(reportPath)}`);
}

function main(options) {
  const report = {
    result: 'FAIL',
    realNativeSqlcipher: false,
    driver: MODULE_NAME,
    modulePath: null,
    moduleVersion: null,
    sqliteVersion: null,
    cipherVersion: null,
    databaseMode: options.db ? 'private-real-master-db' : 'synthetic-sqlcipher-master-db',
    steps: [],
    gate: null,
  };
  const temporaryRoot = options.db ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-sqlcipher-ci-'));
  let dbPath = options.db ? path.resolve(options.db) : null;
  let before = null;

  const pass = (name, detail) => {
    report.steps.push({ name, status: 'PASS', detail });
    console.log(`[PASS] ${name}: ${detail}`);
  };
  const fail = (name, error) => {
    const detail = error?.message || String(error);
    report.steps.push({ name, status: 'FAIL', detail });
    console.error(`[FAIL] ${name}: ${detail}`);
  };

  try {
    report.modulePath = require.resolve(MODULE_NAME);
    report.moduleVersion = require(`${MODULE_NAME}/package.json`).version;
    Database = require(MODULE_NAME);
    assert.equal(typeof Database, 'function', `${MODULE_NAME} did not export a Database constructor`);
    pass('NATIVE_BINDING_LOAD', `loaded ${MODULE_NAME}@${report.moduleVersion}`);

    // A real native module instance, not a test double.
    const memoryDb = new Database(':memory:');
    try {
      cipherPragmas(memoryDb, MASTER_DB_KEY);
      report.sqliteVersion = memoryDb.prepare('SELECT sqlite_version() AS version').get().version;
      report.cipherVersion = readCipherVersion(memoryDb);
    } finally {
      memoryDb.close();
    }
    pass(
      'NATIVE_SQLITE_INSTANCE',
      `native binding executed SQL (SQLite ${report.sqliteVersion}${report.cipherVersion ? `, cipher ${report.cipherVersion}` : ''})`
    );

    if (!dbPath) {
      const fixture = createSyntheticMasterDb(temporaryRoot);
      dbPath = fixture.dbPath;
      options.track = options.track || fixture.trackId;
      pass('SYNTHETIC_MASTER_DB', 'created temporary Rekordbox-shaped SQLCipher database');
    } else {
      if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
        throw new Error(`--db does not point to a file: ${dbPath}`);
      }
      if (path.basename(dbPath).toLowerCase() !== 'master.db') {
        console.warn(`WARNING: --db basename is ${path.basename(dbPath)}; production gate will still treat it as MASTER_DB.`);
      }
      pass('REAL_MASTER_DB_INPUT', 'private database selected; all opens use readonly mode');
    }

    before = fileFingerprint(dbPath);
    const header = fs.readFileSync(dbPath).subarray(0, 16).toString('latin1');
    assert(!header.startsWith('SQLite format 3'), 'database has a plaintext SQLite header, not an encrypted SQLCipher header');
    pass('ENCRYPTED_FILE_HEADER', 'database does not expose the plaintext SQLite header');

    // Correct key: schema and data must be readable after reopening.
    const correct = new Database(dbPath, { readonly: true, fileMustExist: true });
    let selectedTrackId = options.track;
    try {
      cipherPragmas(correct, MASTER_DB_KEY);
      const count = correct.prepare('SELECT count(*) AS n FROM sqlite_master').get().n;
      assert(Number(count) > 0, 'decrypted database schema is empty');
      if (!selectedTrackId) {
        const first = correct.prepare('SELECT ID FROM djmdContent ORDER BY ID LIMIT 1').get();
        selectedTrackId = first && first.ID !== undefined ? String(first.ID) : null;
      }
    } finally {
      correct.close();
    }
    assert(selectedTrackId, 'no track ID supplied and djmdContent has no rows');
    pass('CORRECT_KEY_REOPEN', `encrypted database reopened and schema queried (track ID ${selectedTrackId})`);

    // Wrong key: opening a native connection may be lazy, so force a schema
    // query. A successful query here would mean this is not an encryption test.
    let wrongKeyRejected = false;
    const wrong = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      cipherPragmas(wrong, WRONG_KEY);
      try {
        wrong.prepare('SELECT count(*) AS n FROM sqlite_master').get();
      } catch {
        wrongKeyRejected = true;
      }
    } finally {
      wrong.close();
    }
    assert(wrongKeyRejected, 'wrong SQLCipher key unexpectedly queried the encrypted database successfully');
    pass('WRONG_KEY_NEGATIVE_TEST', 'wrong key was rejected when the encrypted schema was queried');

    // This is intentionally the production loader path: no deps.driver is
    // passed. The existing injectable regression path remains separate.
    console.log('MASTER DB TEST DRIVER: REAL SQLCIPHER NATIVE');
    const gate = resolveTrackFromMasterDb({ dbPath, trackId: selectedTrackId });
    report.gate = {
      ok: gate.ok,
      errorCode: gate.errorCode || null,
      source: gate.source,
      dbType: gate.dbType || null,
      matchedBy: gate.matchedBy || null,
      masterDbFound: gate.masterDbFound,
      sqlcipherAvailable: gate.sqlcipherAvailable,
      databaseOpened: gate.databaseOpened,
      schemaValidated: gate.schemaValidated,
      trackQueryExecuted: gate.trackQueryExecuted,
      trackFound: gate.trackFound,
      driver: 'REAL SQLCIPHER NATIVE (production loader; no injected driver)',
    };
    assert.equal(gate.ok, true, `MASTER_DB_GATE_FAILED: ${gate.errorCode || gate.reason}`);
    assert.equal(gate.sqlcipher, true, 'production gate did not report sqlcipher=true');
    assert.equal(gate.sqlcipherAvailable, true);
    assert.equal(gate.databaseOpened, true);
    assert.equal(gate.schemaValidated, true);
    assert.equal(gate.trackQueryExecuted, true);
    assert.equal(gate.trackFound, true);
    pass('MASTER_DB_GATE_REAL_NATIVE', 'existing production masterDbGate passed with the native driver');

    const after = fileFingerprint(dbPath);
    report.inputFingerprint = { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) };
    assert(report.inputFingerprint.unchanged, 'master.db changed during the read-only gate');
    pass('READ_ONLY_SOURCE_CHECK', 'master.db fingerprint is unchanged after all native reads');

    report.realNativeSqlcipher = true;
    report.result = 'PASS';
    console.log('REAL_NATIVE_SQLCIPHER = true');
    console.log('SQLCIPHER NATIVE + MASTER DB GATE: PASS');
    return report;
  } catch (error) {
    fail('NATIVE_SQLCIPHER_GATE', error);
    console.error('REAL_NATIVE_SQLCIPHER = false');
    console.error('SQLCIPHER NATIVE + MASTER DB GATE: FAIL');
    throw Object.assign(new Error(error?.message || String(error)), { report });
  } finally {
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

let finalReport;
try {
  finalReport = main(options);
} catch (error) {
  finalReport = error.report || { result: 'FAIL', realNativeSqlcipher: false, error: error.message || String(error) };
  loadReport(options.report, finalReport);
  process.exitCode = 1;
}

if (!process.exitCode) loadReport(options.report, finalReport);
