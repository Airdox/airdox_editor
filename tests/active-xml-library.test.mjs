import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ActiveXmlLibrary } from '../electron/activeXmlLibrary.cjs';

const directory = mkdtempSync(path.join(tmpdir(), 'airdox-active-xml-'));
try {
  const snapshotPath = path.join(directory, 'app', 'active-library.json');
  const sourcePath = path.join(directory, 'collection.xml');
  const data = '\uFEFF<?xml version="1.0"?><DJ_PLAYLISTS><COLLECTION><TRACK TrackID="1" Name="Grüße 🎵"/></COLLECTION></DJ_PLAYLISTS>\r\n';
  writeFileSync(sourcePath, data, 'utf8');
  const original = readFileSync(sourcePath);
  const library = new ActiveXmlLibrary(snapshotPath);
  assert.equal(library.read(), null);
  const staged = library.stage({ path: sourcePath, data, modifiedAt: 1234 });
  assert.equal(library.read(), null, 'stage does not activate or persist');
  assert.equal(staged.sourceToken, createHash('sha256').update(original).digest('hex'), 'token hashes exact UTF-8 bytes including BOM/CRLF');
  assert.notEqual(library.stage({ path: sourcePath, data: data.replace('\r\n', '\n') }).sourceToken, staged.sourceToken);
  let clears = 0;
  assert.deepEqual(library.activate(sourcePath, staged.sourceToken, () => {
    assert.equal(library.read(), null, 'cache callback precedes persistence');
    clears++;
  }), staged);
  assert.equal(clears, 1);
  assert.deepEqual(new ActiveXmlLibrary(snapshotPath).read(), staged, 'restart restores sole active XML');
  const persisted = readFileSync(snapshotPath);
  assert.deepEqual(JSON.parse(persisted), { data, sourcePath, hash: staged.sourceToken, mtime: 1234 });

  const newerData = data.replace('TrackID="1"', 'TrackID="2"');
  const newer = library.stage({ path: sourcePath, data: newerData, modifiedAt: 2345 });
  assert.throws(() => library.activate(sourcePath, '0'.repeat(64), () => { clears++; }), /source|token/i);
  assert.throws(() => library.activate(`${sourcePath}.unknown`, newer.sourceToken, () => { clears++; }), /source|token/i);
  assert.throws(() => library.activate(sourcePath, 'invalid'), /token/i);
  assert.equal(clears, 1, 'unknown sources never clear cache');
  assert.deepEqual(readFileSync(snapshotPath), persisted, 'wrong source/token preserves snapshot bytes');
  assert.throws(() => library.activate(sourcePath, newer.sourceToken, () => { throw new Error('cache clear failed'); }), /cache clear failed/);
  assert.deepEqual(readFileSync(snapshotPath), persisted, 'beforeCommit failure preserves old active snapshot');
  assert.throws(() => library.activate(sourcePath, newer.sourceToken, async () => {}), /synchronous/);
  assert.throws(() => library.activate(sourcePath, newer.sourceToken, () => Promise.resolve()), /synchronous/);
  assert.deepEqual(readFileSync(snapshotPath), persisted);
  assert.deepEqual(readdirSync(path.dirname(snapshotPath)), ['active-library.json'], 'no leftover temp files');
  library.activate(sourcePath, newer.sourceToken);
  assert.deepEqual(new ActiveXmlLibrary(snapshotPath).read(), newer);
  assert.deepEqual(readFileSync(sourcePath), original, 'source XML is never written during staging/activation');
  rmSync(sourcePath);
  assert.deepEqual(new ActiveXmlLibrary(snapshotPath).read(), newer, 'restart depends on app snapshot, not live source availability');

  const concurrent = new ActiveXmlLibrary(path.join(directory, 'concurrent.json'));
  const first = concurrent.stage({ path: sourcePath, data: '<first/>', modifiedAt: 1 });
  const second = concurrent.stage({ path: sourcePath, data: '<second/>', modifiedAt: 2 });
  concurrent.activate(sourcePath, first.sourceToken);
  assert.deepEqual(concurrent.read(), first, 'later read of same path does not overwrite earlier token');
  concurrent.activate(sourcePath, second.sourceToken);
  assert.deepEqual(concurrent.read(), second);
  const sameBytesA = concurrent.stage({ path: sourcePath, data: '<same/>' });
  const sameBytesB = concurrent.stage({ path: `${sourcePath}.other`, data: '<same/>' });
  assert.equal(sameBytesA.sourceToken, sameBytesB.sourceToken);
  concurrent.activate(sameBytesA.path, sameBytesA.sourceToken);
  concurrent.activate(sameBytesB.path, sameBytesB.sourceToken);
  assert.deepEqual(concurrent.read(), sameBytesB, 'same hash at different paths retains both staged sources');
  const mutable = concurrent.stage({ path: sourcePath, data: '<immutable/>' });
  const immutableToken = mutable.sourceToken;
  mutable.data = '<changed/>';
  concurrent.activate(sourcePath, immutableToken);
  assert.equal(concurrent.read().data, '<immutable/>', 'returned objects cannot mutate staged bytes');

  const corruptPath = path.join(directory, 'corrupt.json');
  const corrupt = new ActiveXmlLibrary(corruptPath);
  for (const invalid of ['not JSON', 'null', '{}', JSON.stringify({ data: '<xml/>', sourcePath, hash: '0'.repeat(64), mtime: 0 }),
    JSON.stringify({ data: newer.data, sourcePath, hash: newer.sourceToken, mtime: -1 }),
    JSON.stringify({ data: newer.data, sourcePath, hash: newer.sourceToken }),
  ]) {
    writeFileSync(corruptPath, invalid);
    assert.throws(() => corrupt.read(), undefined, 'corrupt snapshot fails instead of bundled fallback/null');
  }
  writeFileSync(corruptPath, '');
  truncateSync(corruptPath, 6 * 100 * 1024 * 1024 + 64 * 1024 + 1);
  assert.throws(() => corrupt.read(), /size/);

  const bounded = new ActiveXmlLibrary(path.join(directory, 'bounded.json'));
  const baseline = bounded.stage({ path: sourcePath, data: '<active/>' });
  bounded.activate(sourcePath, baseline.sourceToken);
  const baselineBytes = readFileSync(path.join(directory, 'bounded.json'));
  writeFileSync(sourcePath, data, 'utf8');
  const pending = Array.from({ length: 8 }, (_, index) => bounded.stage({ path: sourcePath, data: `<invalid-for-import n="${index}"/>` }));
  const ninth = bounded.stage({ path: sourcePath, data: '<DJ_PLAYLISTS><COLLECTION/></DJ_PLAYLISTS>' });
  assert.throws(() => bounded.activate(sourcePath, pending[0].sourceToken, () => { throw new Error('must not clear cache'); }), /expired.*Re-read/);
  assert.deepEqual(readFileSync(path.join(directory, 'bounded.json')), baselineBytes, 'eviction/expired activation preserve active snapshot bytes');
  assert.deepEqual(readFileSync(sourcePath), original, 'eviction never writes original source');
  for (const available of [ninth, ...pending.slice(1).reverse()]) {
    bounded.activate(available.path, available.sourceToken);
    assert.deepEqual(bounded.read(), available, 'all eight newest exact tokens remain independently activatable');
  }
  bounded.activate(sourcePath, bounded.stage(ninth).sourceToken);
  assert.deepEqual(new ActiveXmlLibrary(path.join(directory, 'bounded.json')).read(), ninth, 'valid ninth source remains usable without restart');

  const ordered = new ActiveXmlLibrary(path.join(directory, 'ordered.json'));
  const orderedFirst = ordered.stage({ path: sourcePath, data: '<same/>' });
  const orderedSecond = ordered.stage({ path: sourcePath, data: '<different/>' });
  const orderedThird = ordered.stage({ path: `${sourcePath}.other`, data: '<same/>' });
  for (let index = 0; index < 7; index++) ordered.stage({ path: sourcePath, data: `<extra n="${index}"/>` });
  assert.throws(() => ordered.activate(orderedFirst.path, orderedFirst.sourceToken), /expired/);
  assert.throws(() => ordered.activate(orderedSecond.path, orderedSecond.sourceToken), /expired/);
  ordered.activate(orderedThird.path, orderedThird.sourceToken);
  assert.deepEqual(ordered.read(), orderedThird, 'FIFO order spans paths sharing a token');

  const refreshed = new ActiveXmlLibrary(path.join(directory, 'refreshed.json'));
  const refreshStages = Array.from({ length: 8 }, (_, index) => refreshed.stage({ path: sourcePath, data: `<refresh n="${index}"/>` }));
  refreshed.stage(refreshStages[0]);
  refreshed.stage({ path: sourcePath, data: '<extra/>' });
  assert.throws(() => refreshed.activate(sourcePath, refreshStages[1].sourceToken), /expired/);
  refreshed.activate(sourcePath, refreshStages[0].sourceToken);
  assert.deepEqual(refreshed.read(), refreshStages[0], 're-reading identical bytes refreshes stage age without occupying another slot');

  const byteBounded = new ActiveXmlLibrary(path.join(directory, 'byte-bounded.json'));
  const largeData = 'x'.repeat(100 * 1024 * 1024);
  const largeFirst = byteBounded.stage({ path: sourcePath, data: largeData });
  const largeSecond = byteBounded.stage({ path: `${sourcePath}.other`, data: largeData });
  const small = byteBounded.stage({ path: sourcePath, data: '<small/>' });
  assert.throws(() => byteBounded.activate(largeFirst.path, largeFirst.sourceToken), /expired/);
  assert.throws(() => byteBounded.activate(largeSecond.path, largeSecond.sourceToken, () => { throw new Error('surviving stage'); }), /surviving stage/);
  assert.equal(byteBounded.read(), null, 'aggregate-byte eviction never persists a snapshot');
  byteBounded.activate(small.path, small.sourceToken);
  assert.deepEqual(byteBounded.read(), small, 'aggregate-byte eviction admits the new source');
  assert.throws(() => bounded.stage({ path: sourcePath, data: 'x'.repeat(100 * 1024 * 1024 + 1) }), /100 MiB/);
  assert.throws(() => bounded.stage({ path: sourcePath, data: '' }), /data/);
  assert.throws(() => bounded.stage({ path: '', data: '<xml/>' }), /path/);
  assert.throws(() => bounded.stage({ path: sourcePath, data: '<xml/>', modifiedAt: NaN }), /time/);
  assert.throws(() => bounded.stage({ path: path.join(directory, 'bounded.json'), data: '<xml/>' }), /separate/);

  const blocked = path.join(directory, 'blocked.json');
  mkdirSync(blocked);
  const failing = new ActiveXmlLibrary(blocked);
  const retry = failing.stage({ path: sourcePath, data: '<retry/>' });
  assert.throws(() => failing.activate(sourcePath, retry.sourceToken), undefined, 'failed atomic rename throws');
  assert.equal(readdirSync(directory).filter(name => name.startsWith('blocked.json.') && name.endsWith('.tmp')).length, 0);
  rmSync(blocked, { recursive: true });
  failing.activate(sourcePath, retry.sourceToken);
  assert.deepEqual(failing.read(), retry, 'failed save retains staged source for retry');
  console.log('Active XML library: restart, exact tokens, atomic activation, corruption, bounded staging and source integrity passed');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
