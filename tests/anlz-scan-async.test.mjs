/**
 * @license
 * Async ANLZ PPTH scan + cache contract (A1–A6).
 *
 * Der PPTH-Scan großer Bibliotheken (20k+ Header) lieferte bisher einen
 * synchrone Blockade des Main-Prozesses (UI-Freeze bis zu 3,5 Minuten).
 * Der neue asynchrone Scan (fs.promises + setImmediate-Yields) muss:
 *   A1  dieselben Index-Ergebnisse wie der synchrone Build liefern,
 *   A2  ohne Cache-Verzeichnis Treffer finden,
 *   A3  beim ersten Lauf mit userDataDir den Cache schreiben (headerReads>0),
 *   A4  beim zweiten Lauf den Cache NUTZEN (headerReads=0, gleiche Treffer),
 *   A5  bei veränderter Datei (mtime) neu scannen (Invalidation),
 *   A6  Fortschritt melden (onProgress).
 *
 * Run with: node tests/anlz-scan-async.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildAnlzPpthIndexAsync, scanAnlzForPathsAsync, anlzCachePath } =
  require('../electron/dbReader.cjs');

function buildPpthFile(targetPath, encoding = 'utf16be') {
  let body;
  if (encoding === 'utf16be') {
    body = Buffer.alloc(targetPath.length * 2);
    for (let i = 0; i < targetPath.length; i++) {
      body.writeUInt16BE(targetPath.charCodeAt(i), i * 2);
    }
  } else {
    body = Buffer.alloc(targetPath.length * 2);
    for (let i = 0; i < targetPath.length; i++) {
      body.writeUInt16LE(targetPath.charCodeAt(i), i * 2);
    }
  }
  const buf = Buffer.alloc(0x10 + body.length);
  buf.write('PPTH', 0, 'ascii');
  buf.writeUInt32BE(0x10 + body.length, 4);
  buf.writeUInt32BE(0x10 + body.length, 8);
  buf.writeUInt32BE(body.length, 0x0c);
  body.copy(buf, 0x10);
  return buf;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'anlz-scan-async-'));
const userDir = path.join(base, 'userData');
fs.mkdirSync(userDir, { recursive: true });

// ANLZ-Baum: <base>/lib/USBANLZ/aa/ANLZ0000.DAT/.EXT + ANLZ0001.DAT (LE)
const usbanlz = path.join(base, 'lib', 'USBANLZ', 'aa');
fs.mkdirSync(usbanlz, { recursive: true });
fs.writeFileSync(path.join(usbanlz, 'ANLZ0000.DAT'), buildPpthFile('C:\\Music\\A.wav', 'utf16be'));
fs.writeFileSync(path.join(usbanlz, 'ANLZ0000.EXT'), buildPpthFile('C:\\Music\\A.wav', 'utf16be'));
fs.writeFileSync(path.join(usbanlz, 'ANLZ0001.DAT'), buildPpthFile('C:\\Music\\B.wav', 'utf16le'));
fs.writeFileSync(path.join(usbanlz, 'notes.txt'), 'kein ANLZ');

const FOLDERS = [path.join(base, 'lib', 'USBANLZ')];
const TARGETS = ['C:\\Music\\A.wav', 'C:\\Music\\B.wav', 'C:\\Music\\C-unknown.wav'];

let passed = 0;
let failed = 0;
async function check(id, label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${id} ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${id} ${label}`);
    console.error(`    ${err.message}`);
  }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  ASYNC ANLZ SCAN + CACHE (A1–A6)                            ');
console.log('═══════════════════════════════════════════════════════════════\n');

await check('A1', 'Async-Index == erwartet (DAT+EXT-Paare, scanned=3)', async () => {
  const { index, scanned } = await buildAnlzPpthIndexAsync(FOLDERS, () => {});
  assert.strictEqual(scanned, 3, 'drei ANLZ-Dateien (notes.txt ignoriert)');
  const aKey = 'c:/music/a.wav';
  assert.ok(index.has(aKey), `Index-Key ${aKey} vorhanden (Keys: ${[...index.keys()]})`);
  assert.ok(index.get(aKey).datPath && index.get(aKey).extPath, 'DAT+EXT gepaart');
  assert.ok(index.has('c:/music/b.wav'), 'UTF-16LE-Pfad dekodiert');
});

await check('A2', 'scanAnlzForPathsAsync ohne Cache-Verzeichnis findet Treffer', async () => {
  const result = await scanAnlzForPathsAsync(TARGETS, { folderOverride: FOLDERS });
  assert.strictEqual(result.matches.length, 2, 'zwei Treffer (C-unknown fehlt)');
  assert.ok(result.matches.every((m) => m.matchTier === 1), 'alle exakte Pfadtreffer');
  assert.strictEqual(result.cacheUsed, false);
  assert.strictEqual(result.headerReads, 3);
});

await check('A3', 'Erster Lauf mit userDataDir schreibt Cache (headerReads>0)', async () => {
  const result = await scanAnlzForPathsAsync(TARGETS, { folderOverride: FOLDERS, userDataDir: userDir });
  assert.strictEqual(result.cacheUsed, false, 'noch kein Cache');
  assert.ok(result.headerReads > 0, 'Header gelesen');
  assert.ok(fs.existsSync(anlzCachePath(userDir)), 'Cache-Datei vorhanden');
});

await check('A4', 'Zweiter Lauf nutzt den Cache (headerReads=0, gleiche Treffer)', async () => {
  const result = await scanAnlzForPathsAsync(TARGETS, { folderOverride: FOLDERS, userDataDir: userDir });
  assert.strictEqual(result.cacheUsed, true, 'Cache genutzt');
  assert.strictEqual(result.headerReads, 0, 'keine Header-Neulesung');
  assert.strictEqual(result.matches.length, 2, 'gleiche Treffer wie ohne Cache');
  assert.strictEqual(result.scanned, 3);
});

await check('A5', 'Veränderte Datei (mtime) invalidiert den Cache', async () => {
  const f = path.join(usbanlz, 'ANLZ0001.DAT');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(f, future, future);
  const result = await scanAnlzForPathsAsync(TARGETS, { folderOverride: FOLDERS, userDataDir: userDir });
  assert.strictEqual(result.cacheUsed, false, 'neu gescannt wegen mtime-Änderung');
  assert.ok(result.headerReads > 0, 'Header neu gelesen');
  assert.strictEqual(result.matches.length, 2, 'Ergebnis bleibt korrekt');
});

await check('A6', 'onProgress meldet Fortschritt (scanning + Endwert)', async () => {
  const events = [];
  await scanAnlzForPathsAsync(TARGETS, {
    folderOverride: FOLDERS,
    onProgress: (p) => events.push(p),
  });
  assert.ok(events.length > 0, 'mindestens ein Progress-Event');
  assert.ok(events.every((e) => e.phase === 'scanning' && Number.isInteger(e.scanned)), 'gültige Events');
  assert.strictEqual(events[events.length - 1].scanned, 3, 'Endstand = 3 Dateien');
});

console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
fs.rmSync(base, { recursive: true, force: true });
if (failed > 0) process.exit(1);
