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
const { scanAnlzForPaths, findAnlzFolders } = require('../electron/dbReader.cjs');

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

// Echte ANLZ-Container beginnen mit einem PMAI-Dateikopf (0x1c Bytes),
// danach folgt PPTH als erste Sektion – genau wie in tests/fixtures/testDatasets.
function wrapWithPmai(ppthBuffer) {
  const headerLen = 0x1c;
  const out = Buffer.alloc(headerLen + ppthBuffer.length);
  out.write('PMAI', 0, 'ascii');
  out.writeUInt32BE(headerLen, 4);
  out.writeUInt32BE(out.length, 8);
  out.writeUInt32BE(1, 12);
  out.writeUInt32BE(0x10000, 16);
  out.writeUInt32BE(0x10000, 20);
  out.writeUInt32BE(0, 24);
  ppthBuffer.copy(out, headerLen);
  return out;
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
  // Real layout: PMAI file header before PPTH – must be skipped by the scan
  const audioD = 'C:\\Music\\DJ\\Delta.flac';
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0004.DAT'), wrapWithPmai(buildPpthFile(audioD, 'utf16be')));
  // Non-ANLZ file: ignored by the scan
  fs.writeFileSync(path.join(anlzDir, 'notes.txt'), Buffer.from('not an anl'));

  // Second folder for tier-2 (basename) scenarios
  const anlzDir2 = path.join(base, 'rekordbox6', 'share', 'PIONEER', 'ANLZ');
  fs.mkdirSync(anlzDir2, { recursive: true });
  // "Moved.wav": unique basename, PPTH points to the OLD location
  fs.writeFileSync(path.join(anlzDir2, 'ANLZ0100.DAT'), buildPpthFile('C:\\Old\\Location\\Moved.wav', 'utf16be'));
  // "Twin.wav": two different ANLZ containers share the basename → ambiguous
  fs.writeFileSync(path.join(anlzDir2, 'ANLZ0101.DAT'), buildPpthFile('C:\\A\\Twin.wav', 'utf16be'));
  fs.writeFileSync(path.join(anlzDir2, 'ANLZ0102.DAT'), buildPpthFile('C:\\B\\Twin.wav', 'utf16be'));

  const result = scanAnlzForPaths(
    [audioA, 'c:/music/dj/BETA.mp3', 'C:\\Music\\DJ\\Gamma.wav', audioD],
    [anlzDir]
  );

  // 5 ANLZ files scanned (notes.txt excluded)
  assert.strictEqual(result.scanned, 5, 'scanned file count');

  assert.strictEqual(result.matches.length, 3, 'three exact matches (A + B + D, no Gamma)');

  const matchA = result.matches.find((m) => /alpha\.wav$/i.test(m.path));
  assert.ok(matchA, 'match A (DAT+EXT pair)');
  assert.ok(/ANLZ0001\.DAT$/i.test(matchA.datPath || ''), 'match A resolves the DAT');
  assert.ok(/ANLZ0001\.EXT$/i.test(matchA.extPath || ''), 'match A resolves the EXT sibling');

  const matchB = result.matches.find((m) => /beta\.mp3$/i.test(m.path));
  assert.ok(matchB, 'match B via UTF-16LE PPTH + case-insensitive target');
  assert.ok(/ANLZ0002\.DAT$/i.test(matchB.datPath || ''), 'match B resolves the DAT');
  assert.strictEqual(matchB.extPath, null, 'match B has no EXT sibling');

  const matchD = result.matches.find((m) => /delta\.flac$/i.test(m.path));
  assert.ok(matchD, 'match D behind PMAI file header');
  assert.strictEqual(matchD.matchTier, 1, 'PMAI-prefixed PPTH stays tier-1');
  assert.ok(/ANLZ0004\.DAT$/i.test(matchD.datPath || ''), 'match D resolves the DAT');

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

  // ─── Windows long-path prefix normalization ─────────────────────────────
  const r3 = scanAnlzForPaths(['\\\\?\\c:\\music\\dj\\alpha.wav'], [anlzDir]);
  const prefixed = r3.matches.find((m) => /alpha\.wav$/i.test(m.path));
  assert.ok(prefixed, '\\\\?\\ long-path prefix normalizes to a match');
  assert.strictEqual(prefixed.matchTier, 1, 'long-path prefix stays tier-1');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

// ─── Custom-layout folder discovery (real machine: D:\PIONEER\Master\…) ──
// findAnlzFolders(baseOverride) must find *ANLZ* folders in custom library
// layouts (Master/DataSources subfolders), never descend into the audio
// library, and stay read-only. This mirrors the production win32 fallback
// walk that covers D:\Pioneer-style roots.
{
  const disc = fs.mkdtempSync(path.join(os.tmpdir(), 'anlz-discover-'));
  try {
    fs.mkdirSync(path.join(disc, 'PIONEER', 'Master', 'share', 'PIONEER', 'USBANLZ'), { recursive: true });
    fs.mkdirSync(path.join(disc, 'rekordbox7', 'share', 'PIONEER', 'USBANLZ'), { recursive: true });
    fs.mkdirSync(path.join(disc, 'PIONEER', 'Master', 'Music', 'BigFolder', 'USBANLZ'), { recursive: true });
    const found = findAnlzFolders(disc).map((f) => path.relative(disc, f).split(path.sep).join('/'));
    assert.ok(
      found.includes('PIONEER/Master/share/PIONEER/USBANLZ'),
      'custom Master/share/PIONEER/USBANLZ layout discovered'
    );
    assert.ok(
      found.includes('rekordbox7/share/PIONEER/USBANLZ'),
      'standard rekordbox7 layout discovered'
    );
    assert.ok(
      !found.some((f) => f.includes('Music')),
      'audio library (Music/…) is never descended into'
    );
  } finally {
    fs.rmSync(disc, { recursive: true, force: true });
  }
}

console.log('ANLZ PPTH scan (SQLCipher-independent): OK');
