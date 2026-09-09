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
const { scanAnlzForPaths, scanAnlzForPathsAsync, collectAnlzFiles } = require('../electron/dbReader.cjs');

// ---------------------------------------------------------------------------
// Build a fake %APPDATA%-like tree:
//   base/rekordbox7/share/PIONEER/USBANLZ/ANLZ0001.DAT  (PMAI, PPTH → Alpha.wav, UTF-16BE)
//   base/rekordbox7/share/PIONEER/USBANLZ/ANLZ0001.EXT  (DECOY PPTH – skipped, DAT sibling wins)
//   base/rekordbox7/share/PIONEER/USBANLZ/ANLZ0002.DAT  (PMAI, PPTH → Beta.mp3, UTF-16LE)
//   base/rekordbox7/share/PIONEER/USBANLZ/ANLZ0004.DAT  (legacy offset-0 PPTH → Legacy.wav)
//   base/rekordbox7/share/PIONEER/USBANLZ/ANLZ0003.DAT  (garbage header)
//   base/rekordbox7/share/PIONEER/USBANLZ/notes.txt     (not an ANLZ file)
//   .../USBANLZ/P016/0000875E/ANLZ1000.DAT+EXT          (nested pair → Delta.wav)
//   .../USBANLZ/0e8/<uuid>/ANLZ1001.DAT                (nested → Epsilon.mp3, UTF-16LE)
//   .../USBANLZ/0e8/<uuid>/ANLZ1002.EXT                (EXT-only → Golf.wav)
//   .../USBANLZ/0e8/<uuid>/ANLZ1003.DAT                (ASCII PPTH → Hotel.mp3)
//   .../USBANLZ/0e8/<uuid>/readme.txt                 (nested junk, ignored)
// Real Rekordbox trees nest every container below USBANLZ/ – the scan must
// recurse (a top-level-only read finds 0 files on real machines).
//   base/fakeG/PIONEER/USBANLZ/P016/00009999/ANLZ2000.DAT+EXT (export drive → G:\Export\DJ\Foxtrot.wav)
// Tracks on export media are analyzed on the same drive (<drive>:\PIONEER\USBANLZ).
// ---------------------------------------------------------------------------

// Realistic PMAI container: file magic + first-tag PPTH with a length pair
// (type + lenHeader + lenTag), then the NUL-terminated path in the given
// encoding. Genuine Rekordbox files never start with PPTH at offset 0.
function buildPmaiFile(targetPath, encoding) {
  let body;
  if (encoding === 'utf16be') {
    body = Buffer.alloc(targetPath.length * 2 + 2);
    for (let i = 0; i < targetPath.length; i++) body.writeUInt16BE(targetPath.charCodeAt(i), i * 2);
  } else if (encoding === 'utf16le') {
    body = Buffer.alloc(targetPath.length * 2 + 2);
    for (let i = 0; i < targetPath.length; i++) body.writeUInt16LE(targetPath.charCodeAt(i), i * 2);
  } else {
    body = Buffer.concat([Buffer.from(targetPath, 'ascii'), Buffer.alloc(1)]);
  }
  const head = Buffer.alloc(16);
  head.write('PMAI', 0, 'ascii');
  const tag = Buffer.alloc(12 + body.length);
  tag.write('PPTH', 0, 'ascii');
  tag.writeUInt32BE(12, 4); // lenHeader: type + lengths
  tag.writeUInt32BE(12 + body.length, 8); // lenTag
  body.copy(tag, 12);
  return Buffer.concat([head, tag]);
}

// Legacy layout: PPTH envelope directly at offset 0 (kept for back-compat).
function buildLegacyPpthFile(targetPath, encoding) {
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
  const audioLegacy = 'C:\\Music\\DJ\\Legacy.wav';
  const decoyPath = 'C:\\Decoy\\ShouldBeIgnored.wav';
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0001.DAT'), buildPmaiFile(audioA, 'utf16be'));
  // EXT sibling with a DECOY path: never read (DAT sibling exists) – the
  // decoy key must stay absent from the index while extPath still attaches.
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0001.EXT'), buildPmaiFile(decoyPath, 'utf16be'));
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0002.DAT'), buildPmaiFile(audioB, 'utf16le'));
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0004.DAT'), buildLegacyPpthFile(audioLegacy, 'utf16be'));
  // Garbage: no PPTH tag
  fs.writeFileSync(path.join(anlzDir, 'ANLZ0003.DAT'), Buffer.from('PQTZgarbagegarbagegarbage'));
  // Non-ANLZ file: ignored by the scan
  fs.writeFileSync(path.join(anlzDir, 'notes.txt'), Buffer.from('not an anl'));

  // Nested layout (real Rekordbox tree: USBANLZ/<bucket>/<id>/ANLZnnnn.*)
  const nestedDir = path.join(anlzDir, 'P016', '0000875E');
  fs.mkdirSync(nestedDir, { recursive: true });
  const audioD = 'C:\\Music\\DJ\\Delta.wav';
  fs.writeFileSync(path.join(nestedDir, 'ANLZ1000.DAT'), buildPmaiFile(audioD, 'utf16be'));
  fs.writeFileSync(path.join(nestedDir, 'ANLZ1000.EXT'), buildPmaiFile(audioD, 'utf16be'));
  const nestedDir2 = path.join(anlzDir, '0e8', 'f47ac10b58cc4372a5670e02b2c3d479');
  fs.mkdirSync(nestedDir2, { recursive: true });
  const audioE = 'C:\\Music\\DJ\\Epsilon.mp3';
  const audioG = 'C:\\Music\\DJ\\Golf.wav';
  const audioH = 'C:\\Music\\DJ\\Hotel.mp3';
  fs.writeFileSync(path.join(nestedDir2, 'ANLZ1001.DAT'), buildPmaiFile(audioE, 'utf16le'));
  // EXT without a DAT sibling: read normally (EXT-only analysis).
  fs.writeFileSync(path.join(nestedDir2, 'ANLZ1002.EXT'), buildPmaiFile(audioG, 'utf16be'));
  // ASCII path (exotic exports).
  fs.writeFileSync(path.join(nestedDir2, 'ANLZ1003.DAT'), buildPmaiFile(audioH, 'ascii'));
  // Nested junk: ignored by the scan
  fs.writeFileSync(path.join(nestedDir2, 'readme.txt'), Buffer.from('ignore me'));

  // Fake export drive: G:\PIONEER\USBANLZ\<bucket>\<id>\ANLZnnnn.DAT
  // (mapped via driveRootResolver so the test runs on any platform).
  const fakeG = path.join(base, 'fakeG');
  const driveAnlz = path.join(fakeG, 'PIONEER', 'USBANLZ', 'P016', '00009999');
  fs.mkdirSync(driveAnlz, { recursive: true });
  const audioF = 'G:\\Export\\DJ\\Foxtrot.wav';
  fs.writeFileSync(path.join(driveAnlz, 'ANLZ2000.DAT'), buildPmaiFile(audioF, 'utf16be'));
  fs.writeFileSync(path.join(driveAnlz, 'ANLZ2000.EXT'), buildPmaiFile(audioF, 'utf16be'));

  // Second folder for tier-2 (basename) scenarios
  const anlzDir2 = path.join(base, 'rekordbox6', 'share', 'PIONEER', 'ANLZ');
  fs.mkdirSync(anlzDir2, { recursive: true });
  // "Moved.wav": unique basename, PPTH points to the OLD location
  fs.writeFileSync(path.join(anlzDir2, 'ANLZ0100.DAT'), buildPmaiFile('C:\\Old\\Location\\Moved.wav', 'utf16be'));
  // "Twin.wav": two different ANLZ containers share the basename → ambiguous
  fs.writeFileSync(path.join(anlzDir2, 'ANLZ0101.DAT'), buildPmaiFile('C:\\A\\Twin.wav', 'utf16be'));
  fs.writeFileSync(path.join(anlzDir2, 'ANLZ0102.DAT'), buildPmaiFile('C:\\B\\Twin.wav', 'utf16be'));

  const result = scanAnlzForPaths(
    [audioA, 'c:/music/dj/BETA.mp3', 'C:\\Music\\DJ\\Gamma.wav'],
    [anlzDir]
  );

  // 10 ANLZ files scanned (flat + nested; notes.txt/readme.txt excluded)
  assert.strictEqual(result.scanned, 10, 'scanned file count');
  // 7 yield a PPTH: 2 EXT siblings attach without re-reading, 1 is garbage.
  assert.strictEqual(result.extracted, 7, 'extracted PPTH count');

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

  // ─── Layouts: legacy offset-0, EXT-only, ASCII, decoy-skip ────────────
  const rNew = scanAnlzForPaths([audioLegacy, audioG, audioH, decoyPath], [anlzDir]);
  assert.strictEqual(rNew.matches.length, 3, 'legacy + EXT-only + ASCII match, decoy does not');
  const matchLegacy = rNew.matches.find((m) => /legacy\.wav$/i.test(m.path));
  assert.ok(matchLegacy && matchLegacy.matchTier === 1, 'legacy offset-0 PPTH still resolves');
  const matchG = rNew.matches.find((m) => /golf\.wav$/i.test(m.path));
  assert.ok(matchG, 'EXT without DAT sibling is read');
  assert.strictEqual(matchG.datPath, null, 'EXT-only match has no DAT');
  assert.ok(/ANLZ1002\.EXT$/i.test(matchG.extPath || ''), 'EXT-only match resolves the EXT');
  const matchH = rNew.matches.find((m) => /hotel\.mp3$/i.test(m.path));
  assert.ok(matchH && matchH.matchTier === 1, 'ASCII PPTH resolves');
  assert.ok(!rNew.matches.some((m) => /shouldbeignored/i.test(m.path)), 'decoy EXT (DAT sibling exists) is never read');

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
  assert.strictEqual(rNested.scanned, 10, 'nested scan counts flat + nested containers');
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

  // ─── Audio-drive export folders (G:\PIONEER\USBANLZ) ───────────────────
  // Tracks on export media are analyzed on the same drive. The drive letter
  // is derived from the target path (file:// URL or plain path).
  const rDrive = scanAnlzForPaths(
    ['file://localhost/G:/Export/DJ/Foxtrot.wav'],
    undefined,
    (letter) => (letter === 'G' ? fakeG : null)
  );
  const matchF = rDrive.matches.find((m) => /foxtrot\.wav$/i.test(m.path));
  assert.ok(matchF, 'export-drive ANLZ found via audio drive letter');
  assert.strictEqual(matchF.matchTier, 1, 'drive match stays tier-1 (exact path)');
  assert.ok(/ANLZ2000\.DAT$/i.test(matchF.datPath || ''), 'drive match resolves the DAT');
  assert.ok(/ANLZ2000\.EXT$/i.test(matchF.extPath || ''), 'drive match resolves the EXT sibling');
  assert.ok(
    rDrive.folders.some((f) => /PIONEER.+USBANLZ/.test(f)),
    'drive folder reported'
  );
  // Unknown drive letters resolve to null and are skipped silently.
  const rDriveMiss = scanAnlzForPaths(['file://localhost/Z:/Nope/X.wav'], undefined, () => null);
  assert.ok(!rDriveMiss.matches.some((m) => /x\.wav$/i.test(m.path)), 'no phantom match for unknown drive');

  // ─── Windows long-path prefix normalization ─────────────────────────────
  const r3 = scanAnlzForPaths(['\\\\?\\c:\\music\\dj\\alpha.wav'], [anlzDir]);
  const prefixed = r3.matches.find((m) => /alpha\.wav$/i.test(m.path));
  assert.ok(prefixed, '\\\\?\\ long-path prefix normalizes to a match');
  assert.strictEqual(prefixed.matchTier, 1, 'long-path prefix stays tier-1');

  // ─── Async parity + progress ──────────────────────────────────────────
  const progressEvents = [];
  const rAsync = await scanAnlzForPathsAsync(
    [audioA, 'c:/music/dj/BETA.mp3', 'C:\\Music\\DJ\\Gamma.wav'],
    [anlzDir],
    undefined,
    (p) => progressEvents.push(p)
  );
  assert.strictEqual(rAsync.scanned, result.scanned, 'async scanned matches sync');
  assert.strictEqual(rAsync.extracted, result.extracted, 'async extracted matches sync');
  assert.deepStrictEqual(
    rAsync.matches.map((m) => [m.path, m.matchTier]).sort(),
    result.matches.map((m) => [m.path, m.matchTier]).sort(),
    'async matches equal sync matches'
  );
  assert.ok(progressEvents.length > 0, 'progress events emitted');
  const lastProgress = progressEvents[progressEvents.length - 1];
  assert.strictEqual(lastProgress.scanned, lastProgress.total, 'final progress reaches total');
  assert.strictEqual(lastProgress.total, rAsync.scanned, 'progress total equals scanned');
  for (let i = 1; i < progressEvents.length; i++) {
    assert.ok(progressEvents[i].scanned >= progressEvents[i - 1].scanned, 'progress is monotonic');
  }
  const collected = collectAnlzFiles([anlzDir]);
  assert.strictEqual(collected.files.length, 10, 'collect finds all ANLZ files');
  assert.strictEqual(collected.truncated, false, 'small tree is not truncated');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('ANLZ PPTH scan (SQLCipher-independent): OK');
