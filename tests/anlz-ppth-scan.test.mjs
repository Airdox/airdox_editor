/**
 * @license
 * Verifies the SQLCipher-independent ANLZ PPTH index used by the Electron
 * main process (electron/dbReader.cjs, scanAnlzForPaths).
 *
 * Each ANLZ container (ANLZnnnn.DAT / .EXT) records the exact audio path in
 * its PPTH header. The scan must:
 *   - read only the file headers (never the full file, never write),
 *   - decode UTF-16BE and UTF-16LE PPTH paths,
 *   - pair DAT + EXT siblings by basename,
 *   - match targets case-insensitively (Windows drive-letter folding),
 *   - ignore non-ANLZ files and files without a readable PPTH.
 *
 * Run with: node tests/anlz-ppth-scan.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanAnlzForPaths } = require('../electron/dbReader.cjs');

// ---------------------------------------------------------------------------
// Build a fake %APPDATA%-like tree:
//   base/rekordbox7/share/PIONEER/USBANLZ/ANLZ0001.DAT  (PPTH → C:\Music\A.wav)
//   base/rekordbox7/share/PIONEER/USBANLZ/ANLZ0001.EXT  (PPTH → C:\Music\A.wav)
//   base/rekordbox7/share/PIONEER/USBANLZ/ANLZ0002.DAT  (PPTH → C:\Music\B.wav, UTF-16LE)
//   base/rekordbox7/share/PIONEER/USBANLZ/ANLZ0003.DAT  (garbage header)
//   base/rekordbox7/share/PIONEER/USBANLZ/notes.txt     (not an ANLZ file)
// ---------------------------------------------------------------------------

function buildPpthFile(targetPath, encoding) {
  let body;
  if (encoding === 'utf16be') {
    body = Buffer.alloc(targetPath.length * 2);
    for (let i = 0; i < targetPath.length; i++) {
      body.writeUInt16BE(targetPath.charCodeAt(i), i * 2);
    }
  } else if (encoding === 'utf16le') {
    body = Buffer.alloc(targetPath.length * 2);
    for (let i = 0; i < targetPath.length; i++) {
      body.writeUInt16LE(targetPath.charCodeAt(i), i * 2);
    }
  } else {
    body = Buffer.from(targetPath, 'ascii');
  }
  const buf = Buffer.alloc(0x10 + body.length);
  buf.write('PPTH', 0, 'ascii');
  buf.writeUInt32BE(0x10 + body.length, 4); // len_header
  buf.writeUInt32BE(0x10 + body.length, 8); // len_tag
  buf.writeUInt32BE(body.length, 0x0c); // len_path
  body.copy(buf, 0x10);
  return buf;
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'anlz-ppth-scan-'));
try {
  const anlzDir = path.join(base, 'rekordbox7', 'share', 'PIONEER', 'USBANLZ');
  fs.mkdirSync(anlzDir, { recursive: true });

  const audioA = 'C:\\Music\\DJ\\Alpha.wav';
  const audioB = 'C:\\Music\\DJ\\Beta.mp3';
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0001.DAT'), buildPpthFile(audioA, 'utf16be'));
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0001.EXT'), buildPpthFile(audioA, 'utf16be'));
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0002.DAT'), buildPpthFile(audioB, 'utf16le'));
  // Garbage: no PPTH tag
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0003.DAT'), Buffer.from('PQTZgarbagegarbagegarbage'));
  // Non-ANLZ file: ignored by the scan
  fs.writeFileSync(path.join(anlzDir, 'notes.txt'), Buffer.from('not an anl'));

  const result = scanAnlzForPaths(
    [audioA, 'c:/music/dj/BETA.mp3', 'C:\\Music\\DJ\\Gamma.wav'],
    [anlzDir]
  );

  // 4 ANLZ files scanned (notes.txt excluded)
  assert.strictEqual(result.scanned, 4, 'scanned file count');

  assert.strictEqual(result.matches.length, 2, 'two exact matches (A + B, no Gamma)');

  const matchA = result.matches.find((m) => /alpha\.wav$/i.test(m.path));
  assert.ok(matchA, 'match A (DAT+EXT pair)');
  assert.ok(/ANLZ0001\.DAT$/i.test(matchA.datPath || ''), 'match A resolves the DAT');
  assert.ok(/ANLZ0001\.EXT$/i.test(matchA.extPath || ''), 'match A resolves the EXT sibling');

  const matchB = result.matches.find((m) => /beta\.mp3$/i.test(m.path));
  assert.ok(matchB, 'match B via UTF-16LE PPTH + case-insensitive target');
  assert.ok(/ANLZ0002\.DAT$/i.test(matchB.datPath || ''), 'match B resolves the DAT');
  assert.strictEqual(matchB.extPath, null, 'match B has no EXT sibling');

  // Gamma: no ANLZ recorded → no match, must not throw
  assert.ok(!result.matches.some((m) => /gamma/i.test(m.path)), 'no phantom match for Gamma');
  assert.ok(Array.isArray(result.folders) && result.folders.includes(anlzDir), 'folders reported');
  assert.ok(result.elapsedMs >= 0, 'elapsedMs reported');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('ANLZ PPTH scan (SQLCipher-independent): OK');
