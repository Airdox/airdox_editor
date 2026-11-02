import assert from 'node:assert/strict';
import { filterLibraryTracks, getLibraryTrackDates, getLibraryFilterOptions, getLibraryStemStatus,
  sourceLibraryDate, type LibraryStemSnapshot } from '../src/features/library';
import { buildCollectionTrackModel } from '../src/features/import/collectionTrackModel';
import { prepareXmlCollectionUpdate } from '../src/features/import/xmlCollectionUpdate';
import { mapRekordboxDatabaseRows } from '../src/rekordbox/dbParser';
import { DataOrigin, type PartialTrackModel } from '../src/types/rekordbox';

const a: PartialTrackModel = { id: 'a', genre: 'House', key: '8A',
  originalMedia: { location: 'C:/Music/a.wav', accessMode: 'READ_ONLY', status: 'UNVERIFIED' },
  rawXmlAttributes: { DateCreated: '2025-03-01', DateModified: '2025-03-31T23:59:59Z' } };
const b: PartialTrackModel = { id: 'b', genre: 'Techno', key: '9A', dateAdded: '2025-03-02',
  originalMedia: { location: 'C:/Music/b.wav', accessMode: 'READ_ONLY', status: 'UNVERIFIED' } };
const c: PartialTrackModel = { ...a, id: 'c', rawXmlAttributes: { DateCreated: '2025-02-28', DateModified: '2025-04-01' } };
const tracks = [a,b,c];
const ids = (result: PartialTrackModel[]) => result.map(t => t.id);
assert.deepEqual(ids(filterLibraryTracks(tracks, {})), ['a','b','c']);
assert.deepEqual(ids(filterLibraryTracks(tracks, { createdFrom: '2025-03-01', createdTo: '2025-03-01' })), ['a']);
assert.deepEqual(ids(filterLibraryTracks(tracks, { modifiedFrom: '2025-03-31', modifiedTo: '2025-03-31' })), ['a']);
assert.deepEqual(ids(filterLibraryTracks(tracks, { createdTo: '2025-02-28' })), ['c']);
assert.deepEqual(ids(filterLibraryTracks(tracks, { createdFrom: '2025-03-02', createdTo: '2025-03-01' })), []);
assert.deepEqual(ids(filterLibraryTracks(tracks, { createdFrom: '2025-02-30' })), []);
assert.deepEqual(ids(filterLibraryTracks(tracks, { createdFrom: '2025-03-01', genre: ' house ', key: '8a' })), ['a']);
assert.deepEqual(ids(filterLibraryTracks(tracks, { genre: 'House', key: '9A' })), []);
assert.deepEqual(getLibraryTrackDates(b), { created: undefined, modified: undefined });
assert.equal(sourceLibraryDate('2025-02-29', 'REKORDBOX_XML', 'DateCreated'), undefined);
assert.equal(sourceLibraryDate('2024-02-29', 'REKORDBOX_XML', 'DateCreated')?.precision, 'day');
assert.equal(sourceLibraryDate('2025-03-01T25:00:00Z', 'REKORDBOX_XML', 'DateCreated'), undefined);
assert.equal(sourceLibraryDate('garbage', 'REKORDBOX_XML', 'DateCreated'), undefined);
assert.deepEqual(getLibraryFilterOptions([...tracks, { genre: ' house ', key: '8a' }, {}]), { genres: ['house','Techno'], keys: ['8a','9A'] });
const artifacts = ['vocals','instrumental'].map(id => ({ id, path: `C:/Stems/${id}.wav`, bytes: 800, frames: 100, sampleRate: 44100, channels: 2, verified: true }));
const stems: LibraryStemSnapshot = {
  a: { sourcePath: 'file://localhost/C:/Music/a.wav', status: 'checked', checkedAt: 1, requiredStems: ['vocals','instrumental'], artifacts },
  b: { sourcePath: 'C:/Music/b.wav', status: 'checked', checkedAt: 1, requiredStems: [], artifacts: [] },
};
assert.equal(getLibraryStemStatus(a, stems), 'available');
assert.equal(getLibraryStemStatus(b, stems), 'missing');
assert.equal(getLibraryStemStatus(c, stems), 'unknown');
assert.deepEqual(ids(filterLibraryTracks(tracks, { stems: 'present' }, stems)), ['a']);
assert.deepEqual(ids(filterLibraryTracks(tracks, { stems: 'missing' }, stems)), ['b']);
assert.deepEqual(ids(filterLibraryTracks(tracks, { stems: 'present', modifiedTo: '2025-03-31', genre: 'House', key: '8A' }, stems)), ['a']);
assert.deepEqual(ids(filterLibraryTracks(tracks, { stems: 'missing' })), []);
assert.equal(getLibraryStemStatus(a, { a: { ...stems.a, status: 'checking' } }), 'checking');
assert.equal(getLibraryStemStatus(a, { a: { ...stems.a, sourcePath: 'C:/Other/a.wav' } }), 'unknown');
for (const broken of [[], artifacts.slice(0,1), [artifacts[0], artifacts[0]], artifacts.map(x => ({...x, verified:false})),
  artifacts.map(x => ({...x, bytes:0})), [artifacts[0], {...artifacts[1], frames: 99}], [artifacts[0], {...artifacts[1], path: artifacts[0].path}]]) {
  assert.equal(getLibraryStemStatus(a, { a: { ...stems.a, artifacts: broken } }), 'missing');
}
const built = buildCollectionTrackModel({ ...a, dateAdded: '2030-01-01' }, 0, DataOrigin.REKORDBOX_XML);
assert.equal(built.libraryDates?.created?.value, '2025-03-01');
assert.equal(buildCollectionTrackModel({}, 0, DataOrigin.REKORDBOX_XML).key, '');
const xml = '<DJ_PLAYLISTS><COLLECTION Entries="1"><TRACK TrackID="1" Name="No invented metadata" DateAdded="2025-03-01" DateCreated="2024-01-01" DateModified="2024-02-01" /></COLLECTION></DJ_PLAYLISTS>';
const imported = await prepareXmlCollectionUpdate({ path: 'collection.xml', data: xml, modifiedAt: Date.now() });
assert.equal(imported.tracks[0].key, '');
assert.equal(imported.tracks[0].genre, '');
assert.equal(imported.tracks[0].libraryDates?.created?.source, 'REKORDBOX_XML');
assert.equal(imported.tracks[0].libraryDates?.created?.value, '2024-01-01');
const db = mapRekordboxDatabaseRows({ content: [{ ID: '7', created_at: '2024-02-03 10:11:12', updated_at: '2024-02-04 12:13:14', StockDate: '2023-01-01' }], cues: [] }, 'MASTER_DB');
const dates = getLibraryTrackDates(db.tracks[0]);
assert.equal(dates.created?.field, 'created_at');
assert.equal(dates.modified?.source, 'REKORDBOX_DB');
const audio = { ...b, originalMedia: { ...b.originalMedia!, status: 'AVAILABLE' as const, modifiedAt: Date.UTC(2024,0,2) } };
assert.equal(getLibraryTrackDates(audio).modified?.source, 'AUDIO_FILE');
assert.equal(getLibraryTrackDates(audio).created, undefined);
assert.equal(tracks[0], a); // helpers keep original entries and never mutate inputs
console.log('Library data: honest source dates, import metadata, inclusive AND filters and verified stem snapshots passed.');
