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
//   .../USBANLZ/P016/0000875E/ANLZ1000.DAT+EXT          (nested pair → C:\Music\DJ\Delta.wav)
//   .../USBANLZ/0e8/<uuid>/ANLZ1001.DAT                (nested → C:\Music\DJ\Epsilon.mp3, UTF-16LE)
//   .../USBANLZ/0e8/<uuid>/readme.txt                 (nested junk, ignored)
// Real Rekordbox trees nest every container below USBANLZ/ – the scan must
// recurse (a top-level-only read finds 0 files on real machines).
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

  // Nested layout (real Rekordbox tree: USBANLZ/<bucket>/<id>/ANLZnnnn.*)
  const nestedDir = path.join(anlzDir, 'P016', '0000875E');
  fs.mkdirSync(nestedDir, { recursive: true });
  const audioD = 'C:\\Music\\DJ\\Delta.wav';
  fs.writeFileSync(path.join(nestedDir, 'ANLZ1000.DAT'), buildPpthFile(audioD, 'utf16be'));
  fs.writeFileSync(path.join(nestedDir, 'ANLZ1000.EXT'), buildPpthFile(audioD, 'utf16be'));
  const nestedDir2 = path.join(anlzDir, '0e8', 'f47ac10b58cc4372a5670e02b2c3d479');
  fs.mkdirSync(nestedDir2, { recursive: true });
  const audioE = 'C:\\Music\\DJ\\Epsilon.mp3';
  fs.writeFileSync(path.join(nestedDir2, 'ANLZ1001.DAT'), buildPpthFile(audioE, 'utf16le'));
  // Nested junk: ignored by the scan
  fs.writeFileSync(path.join(nestedDir2, 'readme.txt'), Buffer.from('ignore me'));

  // Second folder for tier-2 (basename) scenarios
  const anlzDir2 = path.join(base, 'rekordbox6', 'share', 'PIONEER', 'ANLZ');
  fs.mkdirSync(anlzDir2, { recursive: true });
  // "Moved.wav": unique basename, PPTH points to the OLD location
  fs.writeFileSync(path.join(anlzDir2, 'ANLZ0100.DAT'), buildPpthFile('C:\\Old\\Location\\Moved.wav', 'utf16be'));
  // "Twin.wav": two different ANLZ containers share the basename → ambiguous
  fs.writeFileSync(path.join(anlzDir2, 'ANLZ0101.DAT'), buildPpthFile('C:\\A\\Twin.wav', 'utf16be'));
  fs.writeFileSync(path.join(anlzDir2, 'ANLZ0102.DAT'), buildPpthFile('C:\\B\\Twin.wav', 'utf16be'));

  const result = scanAnlzForPaths(
    [audioA, 'c:/music/dj/BETA.mp3', 'C:\\Music\\DJ\\Gamma.wav'],
    [anlzDir]
  );

  // 7 ANLZ files scanned (flat + nested; notes.txt/readme.txt excluded)
  assert.strictEqual(result.scanned, 7, 'scanned file count');

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
  assert.ok(Array.isArray(result.ppthSample) && result.ppthSample.length > 0, 'ppthSample reported');
  assert.strictEqual(result.matches.every((m) => m.matchTier === 1), true, 'all tier-1 (exact path) matches');

  // ─── Tier 2: file moved after analysis (basename only) ─────────────────
  // The target path differs from the PPTH, but the basename "Moved.wav" is
  // unique in the whole index → tier-2 match with verification note.
  const r2 = scanAnlzForPaths(
    ['D:\\New\\Folder\\Moved.wav', 'E:\\Ambiguous\\Twin.wav'],
    [anlzDir2]
  );
  const moved = r2.matches.find((m) => /moved\.wav$/i.test(m.path));
  assert.ok(moved, 'tier-2 match for moved file (unique basename)');
  assert.strictEqual(moved.matchTier, 2, 'tier-2 flagged');
  assert.ok(moved.note, 'tier-2 carries a verification note');
  const twin = r2.matches.find((m) => /twin\.wav$/i.test(m.path));
  assert.ok(!twin, 'ambiguous basename (two candidates) must NOT match');

  // ─── Nested layout: recursion finds real Rekordbox trees ──────────────
  const rNested = scanAnlzForPaths(
    ['C:/Music/DJ/Delta.wav', 'C:/Music/DJ/Epsilon.mp3'],
    [anlzDir]
  );
  assert.strictEqual(rNested.scanned, 7, 'nested scan counts flat + nested containers');
  assert.strictEqual(rNested.truncated, false, 'small tree is not truncated');
  const matchD = rNested.matches.find((m) => /delta\.wav$/i.test(m.path));
  assert.ok(matchD, 'nested DAT+EXT pair found recursively');
  assert.strictEqual(matchD.matchTier, 1, 'nested match stays tier-1 (exact path)');
  assert.ok(/ANLZ1000\.DAT$/i.test(matchD.datPath || ''), 'nested match resolves the DAT in its subfolder');
  assert.ok(/ANLZ1000\.EXT$/i.test(matchD.extPath || ''), 'nested match resolves the EXT sibling in its subfolder');
  assert.ok(matchD.datPath && matchD.datPath.includes('P016'), 'nested DAT path keeps its subdirectory');
  const matchE = rNested.matches.find((m) => /epsilon\.mp3$/i.test(m.path));
  assert.ok(matchE, 'deeply nested UTF-16LE container found');
  assert.strictEqual(matchE.matchTier, 1, 'deep nested match stays tier-1 (exact path)');
  assert.ok(!rNested.matches.some((m) => /gamma/i.test(m.path)), 'no phantom match in nested scan');

  // ─── Windows long-path prefix normalization ─────────────────────────────
  const r3 = scanAnlzForPaths(['\\\\?\\c:\\music\\dj\\alpha.wav'], [anlzDir]);
  const prefixed = r3.matches.find((m) => /alpha\.wav$/i.test(m.path));
  assert.ok(prefixed, '\\\\?\\ long-path prefix normalizes to a match');
  assert.strictEqual(prefixed.matchTier, 1, 'long-path prefix stays tier-1');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('ANLZ PPTH scan (SQLCipher-independent): OK');
