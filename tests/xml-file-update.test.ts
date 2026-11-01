import assert from 'node:assert/strict';
import {
  prepareXmlCollectionUpdate, readXmlCollectionUpdate, commitXmlCollectionUpdate, getXmlTrackIdentity,
} from '../src/features/import/xmlCollectionUpdate';
import { type TrackModel } from '../src/types/rekordbox';
import { selectTop200 } from '../src/stems/remote/top200Batch';

const track = (id: string, count: number, path = `${id}.mp3`) =>
  `<TRACK TrackID="${id}" Name="Track ${id}" PlayCount="${count}" Location="file://localhost/C:/Music/${path}" TotalTime="12" AverageBpm="120"/>`;
const xml = (...tracks: string[]) => `<DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="${tracks.length}">${tracks.join('')}</COLLECTION></DJ_PLAYLISTS>`;
const source = (data: string) => ({ data, path: 'C:\\exports\\collection.xml', modifiedAt: 123456 });
const initial = await prepareXmlCollectionUpdate(source(xml(track('1', 99), track('2', 20), track('3', 1))));
assert.equal(initial.tracks.length, 3);
assert.equal(initial.sourceLabel, source('').path);
assert.equal(initial.modifiedAt, 123456);
assert.equal(initial.tracks[0].playCount, 99);
assert.equal(initial.tracks[0].originalSha256, '', 'no fabricated index-based hash');
assert.equal(initial.tracks[0].origin, 'REKORDBOX_XML');

let active: TrackModel[] = initial.tracks;
let commits = 0;
const batch = { entries: initial.tracks.map(track => ({ track, status: 'RUNNING' })) };
const historical = JSON.stringify(batch);
const update = await prepareXmlCollectionUpdate(source(xml(track('2', 150), track('1', 2, 'moved.mp3'))));
await commitXmlCollectionUpdate(update, async (tracks, label) => {
  await Promise.resolve();
  assert.equal(label, source('').path);
  active = tracks;
  commits++;
});
assert.equal(commits, 1);
assert.deepEqual(active.map(t => t.id), ['2', '1'], 'full replacement in new XML order');
assert.ok(!active.some(t => t.id === '3'), 'removed track cannot remain active');
assert.deepEqual(selectTop200(active).map(t => t.id), ['2', '1'], 'Top200 uses updated PlayCounts and excludes removed tracks');
assert.ok(active[1].originalMedia?.location.endsWith('/moved.mp3'), 'path fully replaced');
assert.equal(JSON.stringify(batch), historical, 'running batch keeps historical snapshot');
assert.notEqual(active[1], batch.entries[0].track);
active[1].workingSegments[0].gain = 0.5;
assert.equal(JSON.stringify(batch), historical, 'nested snapshot data is independent');
assert.notEqual(getXmlTrackIdentity(active[1]), getXmlTrackIdentity(initial.tracks[0]), 'reused TrackID at different path is not the same media');
assert.equal(getXmlTrackIdentity(active[0]), getXmlTrackIdentity(initial.tracks[1]), 'same path survives reordering');
assert.equal(getXmlTrackIdentity({ originalSha256: 'sha256-rb-0' }), null, 'no ID or placeholder-only identity');
assert.equal(getXmlTrackIdentity({ originalSha256: 'A'.repeat(64) }), `sha256:${'a'.repeat(64)}`);
assert.equal(getXmlTrackIdentity({ originalSha256: '', originalMedia: { location: 'C:\\Music\\2.mp3' } as TrackModel['originalMedia'] }), getXmlTrackIdentity(active[0]));

const beforeFailure = JSON.stringify(active);
for (const invalid of ['', '<bad/>', '<COLLECTION/>', '<DJ_PLAYLISTS/>',
  '<DJ_PLAYLISTS><COLLECTION></DJ_PLAYLISTS>', xml('<TRACK/>'), xml('<TRACK TrackID=" "/>'),
  xml(track('1', 1), track('1', 2)), xml('<TRACK TrackID="1" Name="bad & value"/>'),
  xml('<TRACK TrackID="1" TrackID="2"/>'), `${xml()}${xml()}`,
  '<DJ_PLAYLISTS><WRAPPER><COLLECTION/></WRAPPER></DJ_PLAYLISTS>',
  '<DJ_PLAYLISTS><COLLECTION/><COLLECTION/></DJ_PLAYLISTS>',
]) {
  await assert.rejects(async () => {
    const result = await prepareXmlCollectionUpdate(source(invalid));
    await commitXmlCollectionUpdate(result, () => { commits++; });
  }, /XML/);
}
await assert.rejects(() => prepareXmlCollectionUpdate({ data: xml(), path: '' }), /Quelle/);
await assert.rejects(() => readXmlCollectionUpdate(undefined, {}), /Quelle/);
await assert.rejects(() => readXmlCollectionUpdate('missing.xml', {}), /gelesen/);
await assert.rejects(() => readXmlCollectionUpdate('missing.xml', { readXmlFile: async () => { throw new Error('ENOENT'); } }), /ENOENT/);
await assert.rejects(() => readXmlCollectionUpdate('a.xml', { readXmlFile: async () => ({ data: xml(), path: 'b.xml' }) }), /Quelle/);
assert.equal(commits, 1, 'validation/read failures never commit');
assert.equal(JSON.stringify(active), beforeFailure, 'failure retains active library atomically');
assert.equal(JSON.stringify(batch), historical);

let reads = 0;
const bridge = { readXmlFile: async (path: string) => ({ path, data: xml(track('2', ++reads)) }) };
assert.equal((await readXmlCollectionUpdate('known.xml', bridge)).tracks[0].playCount, 1);
assert.equal((await readXmlCollectionUpdate('known.xml', bridge)).tracks[0].playCount, 2, 'known source is freshly read');
let release!: () => void;
let finished = false;
const commit = commitXmlCollectionUpdate(update, () => new Promise<void>(resolve => { release = resolve; })).then(() => { finished = true; });
await Promise.resolve();
assert.equal(finished, false, 'await async parent cache invalidation/commit');
release();
await commit;
assert.equal(finished, true);
await assert.rejects(() => commitXmlCollectionUpdate(update, async () => { throw new Error('cache invalidation failed'); }), /cache invalidation failed/);
assert.equal((await prepareXmlCollectionUpdate(source(xml()))).tracks.length, 0, 'valid empty collection removes all active tracks');
console.log('XML file update: validation, fresh reads, full replacement, ranking, identity and independent snapshots passed');
