/**
 * @license
 * Verifies the rekordboxAgent options.json discovery used by the Electron
 * main process (electron/dbReader.cjs).
 *
 * A moved Rekordbox library (Preferences → Advanced → Database → Database
 * management) keeps its database and analysis OUTSIDE %APPDATA%:
 *   options.json "db-path"               → D:\PIONEER\Master\master.db
 *   options.json "analysis-data-root-path" → D:\PIONEER\Master\share
 *     (ANLZ containers below <root>\PIONEER\USBANLZ\...)
 *
 * options.json lives at the Pioneer ROOT level
 * (%APPDATA%\Pioneer\rekordboxAgent\storage\options.json) – a sibling of
 * the rekordbox{7,6,} folders, not nested inside them. Nested copies are
 * honored as a legacy fallback. The fixture mirrors the real structure of
 * a Rekordbox 7.2.16 options.json (paths anonymized, secrets redacted).
 *
 * Run with: node tests/options-json.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  scanAnlzForPaths,
  findAnlzFolders,
  findOptionsJsonFiles,
  candidateFromOptions,
  getOptionValue,
} = require('../electron/dbReader.cjs');

function buildPpthFile(targetPath) {
  const body = Buffer.alloc(targetPath.length * 2);
  for (let i = 0; i < targetPath.length; i++) body.writeUInt16BE(targetPath.charCodeAt(i), i * 2);
  const buf = Buffer.alloc(0x10 + body.length);
  buf.write('PPTH', 0, 'ascii');
  buf.writeUInt32BE(0x10 + body.length, 4);
  buf.writeUInt32BE(0x10 + body.length, 8);
  buf.writeUInt32BE(body.length, 0x0c);
  body.copy(buf, 0x10);
  return buf;
}

function rb7OptionsDoc({ dbPath, analysisRoot, settingsRoot }) {
  return {
    // Real Rekordbox 7.2.16 shape (field order kept); values are fakes.
    options: [
      ['db-path', dbPath],
      ['dp', 'REDACTED-PLACEHOLDER-NOT-A-REAL-KEY'],
      ['port', '30001'],
      ['analysis-data-root-path', analysisRoot],
      ['settings-root-path', settingsRoot],
      ['lang-path', 'C:\\Program Files\\rekordbox\\rekordbox 7.2.16\\locale\\german.lang'],
      ['lang', 'de'],
      ['app_ver', '7.2.16'],
    ],
    defaults: { mode: 'standalone' },
  };
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'options-json-'));
try {
  // ─── Fake Pioneer root: correct root-level options.json ───────────────
  const pioneer = path.join(base, 'Pioneer');
  const agentStorage = path.join(pioneer, 'rekordboxAgent', 'storage');
  fs.mkdirSync(agentStorage, { recursive: true });
  const masterDir = path.join(base, 'Master'); // stands in for D:\PIONEER\Master
  const shareDir = path.join(masterDir, 'share');
  const movedAnlz = path.join(shareDir, 'PIONEER', 'USBANLZ', 'P016', '00001234');
  fs.mkdirSync(movedAnlz, { recursive: true });
  fs.writeFileSync(
    path.join(agentStorage, 'options.json'),
    JSON.stringify(
      rb7OptionsDoc({
        dbPath: path.join(masterDir, 'master.db'),
        analysisRoot: shareDir,
        settingsRoot: path.join(pioneer, 'rekordbox6'),
      })
    )
  );
  // Legacy nested copy with DIFFERENT values (must lose against root-level).
  const nestedStorage = path.join(pioneer, 'rekordbox6', 'rekordboxAgent', 'storage');
  fs.mkdirSync(nestedStorage, { recursive: true });
  fs.writeFileSync(
    path.join(nestedStorage, 'options.json'),
    JSON.stringify(
      rb7OptionsDoc({
        dbPath: path.join(base, 'elsewhere.db'),
        analysisRoot: path.join(base, 'nowhere'),
        settingsRoot: path.join(pioneer, 'rekordbox6'),
      })
    )
  );

  // ─── Pure parsing (real RB 7.2.16 shape) ──────────────────────────────
  const doc = rb7OptionsDoc({ dbPath: 'X', analysisRoot: 'Y', settingsRoot: 'Z' });
  assert.strictEqual(getOptionValue(doc, 'db-path'), 'X', 'db-path parsed');
  assert.strictEqual(getOptionValue(doc, 'analysis-data-root-path'), 'Y', 'analysis root parsed');
  assert.strictEqual(getOptionValue(doc, 'app_ver'), '7.2.16', 'plain value parsed');
  assert.strictEqual(getOptionValue(doc, 'missing'), null, 'missing key → null');
  assert.strictEqual(getOptionValue(null, 'db-path'), null, 'null doc → null');
  assert.strictEqual(getOptionValue({}, 'db-path'), null, 'empty doc → null');
  assert.strictEqual(getOptionValue({ options: 'nope' }, 'db-path'), null, 'malformed options → null');
  assert.strictEqual(
    getOptionValue({ options: [['db-path', '  '], 'junk', ['db-path', 42]] }, 'db-path'),
    null,
    'blank/non-string/junk entries ignored'
  );

  // ─── Discovery order: root-level first, nested legacy second ──────────
  const found = findOptionsJsonFiles(pioneer, [path.join(pioneer, 'rekordbox6')]);
  assert.strictEqual(found.length, 2, 'both options.json files found');
  assert.ok(found[0].endsWith(path.join('rekordboxAgent', 'storage', 'options.json')), 'root-level listed');
  assert.ok(!found[0].includes('rekordbox6'), 'root-level ranks first');
  assert.deepStrictEqual(findOptionsJsonFiles(path.join(base, 'absent'), []), [], 'absent root → []');

  // ─── db-path of the moved library wins ────────────────────────────────
  const dbPath = candidateFromOptions(path.join(pioneer, 'rekordbox6'));
  assert.strictEqual(dbPath, path.join(masterDir, 'master.db'), 'moved db-path resolved via root-level options.json');
  assert.strictEqual(
    candidateFromOptions(path.join(base, 'no-such-appdir')),
    null,
    'no options.json anywhere → null (no throw)'
  );

  // ─── Analysis root of the moved library is scanned ────────────────────
  const audioG = 'G:\\Export\\DJ\\Moved.wav';
  fs.writeFileSync(path.join(movedAnlz, 'ANLZ6000.DAT'), buildPpthFile(audioG));
  fs.writeFileSync(path.join(movedAnlz, 'ANLZ6000.EXT'), buildPpthFile(audioG));
  const folders = findAnlzFolders(pioneer);
  const expected = path.join(shareDir, 'PIONEER', 'USBANLZ');
  assert.ok(folders.includes(expected), 'moved-library USBANLZ folder discovered via analysis-data-root-path');
  assert.ok(!folders.some((f) => f.includes('nowhere')), 'losing nested fallback not used');

  // ─── End-to-end: Tier-1 match from the moved tree ─────────────────────
  const rMoved = scanAnlzForPaths(['file://localhost/G:/Export/DJ/Moved.wav'], folders);
  assert.strictEqual(rMoved.scanned, 2, 'moved tree containers scanned');
  assert.strictEqual(rMoved.matches.length, 1, 'one exact match from the moved tree');
  assert.strictEqual(rMoved.matches[0].matchTier, 1, 'moved match stays tier-1 (exact path)');
  assert.ok(/ANLZ6000\.DAT$/i.test(rMoved.matches[0].datPath || ''), 'moved match resolves the DAT');
  assert.ok(/ANLZ6000\.EXT$/i.test(rMoved.matches[0].extPath || ''), 'moved match resolves the EXT sibling');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('rekordboxAgent options.json discovery (moved libraries): OK');
