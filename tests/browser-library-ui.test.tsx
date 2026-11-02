import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrowserMultiTrackBar } from '../src/components/BrowserMultiTrackBar';
import { BrowserLibraryFilters } from '../src/components/BrowserLibraryFilters';
import { RekordboxXmlImportModal } from '../src/components/Modals/RekordboxXmlImportModal';
import { DEFAULT_LIBRARY_FILTERS, filterLibraryTracks, getLibraryFilterOptions, type LibraryFilters, type LibraryStemSnapshot } from '../src/features/library';
import type { TrackModel } from '../src/types/rekordbox';

const track = (id: string, extra: Partial<TrackModel> = {}): TrackModel => ({
  id, title: `Track ${id}`, artist: 'Artist', album: '', bpm: 128, key: 'Fm', genre: 'House', duration: 120,
  cues: [], loops: [], origin: 'REKORDBOX_XML', audioBuffer: null,
  originalMedia: { location: `C:/audio/${id}.wav`, accessMode: 'READ_ONLY', status: 'UNVERIFIED' },
  ...extra,
} as TrackModel);
const first = track('1', { libraryDates: {
  created: { value: '2026-10-01', source: 'REKORDBOX_DB', field: 'created_at', precision: 'day' },
  modified: { value: '2026-11-02T12:00:00Z', source: 'AUDIO_FILE', field: 'mtime', precision: 'instant' },
} });
const snapshot = (present: boolean): LibraryStemSnapshot => ({ '1': {
  sourcePath: 'C:/audio/1.wav', status: 'checked', checkedAt: Date.now(), requiredStems: ['vocals', 'instrumental'],
  artifacts: present ? ['vocals', 'instrumental'].map(id => ({ id, path: `C:/stems/${id}.wav`, bytes: 10000, frames: 44100, sampleRate: 44100, channels: 2, verified: true })) : [],
} });
const noop = () => {};
function browser(collection = [first], libraryStems?: LibraryStemSnapshot) {
  return renderToStaticMarkup(<BrowserMultiTrackBar isOpen onToggle={noop} tracks={[]} collectionTracks={collection}
    libraryStems={libraryStems} activeTrackId="1" onSelectTrack={noop} onImportTracks={noop} onImportAudio={noop} />);
}
function modal(collection = [first], libraryStems?: LibraryStemSnapshot) {
  return renderToStaticMarkup(<RekordboxXmlImportModal isOpen onClose={noop} xmlTracks={collection} libraryStems={libraryStems} onSelectTrack={noop} />);
}

for (const render of [browser, modal]) {
  const unknown = render();
  for (const text of ['STEMS', 'ERSTELLT', 'GEÄNDERT', 'GENRE', 'Tonart (Tonhöhe)', 'Erstellungsdatum von', 'Erstellungsdatum bis', 'Änderungsdatum von', 'Änderungsdatum bis', 'Alle Filter zurücksetzen', 'Ungeprüft', 'Rekordbox-Datenbank', 'created_at', 'Audiodatei', 'mtime', '2026-10-01', '2026-11-02']) {
    assert.ok(unknown.includes(text), `Both lists must expose ${text}`);
  }
  assert.ok(render([first], snapshot(false)).includes('>Nicht vorhanden</td>'));
  assert.ok(render([first], snapshot(true)).includes('>Vorhanden</td>'), 'fresh successful separation snapshot updates status without reimport');
  const absent = render([track('2', { key: '', genre: '', dateAdded: '2026-11-02' })]);
  assert.ok(absent.includes('Unbekannt'));
  assert.ok(!absent.includes('>2A<'), 'missing key must not invent a key');
  assert.ok(!absent.includes('>2026-11-02</span>'), 'dateAdded is not a creation date');
  assert.ok(unknown.includes('In Deck') || unknown.includes('Geladen'), 'existing load action remains');
}

// The controlled UI must preserve every other filter when a single control changes.
type Element = React.ReactElement<Record<string, any>>;
function find(node: React.ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement(child)) continue;
    const element = child as Element;
    if (predicate(element)) return element;
    const found = find(element.props.children, predicate);
    if (found) return found;
  }
}
let filters: LibraryFilters = { ...DEFAULT_LIBRARY_FILTERS };
let resetCount = 0;
const options = getLibraryFilterOptions([first, track('2', { genre: 'Techno', key: 'Am' })]);
const tree = () => BrowserLibraryFilters({ filters, ...options, active: true, onChange: next => { filters = next; }, onReset: () => { filters = { ...DEFAULT_LIBRARY_FILTERS }; resetCount++; } });
for (const [label, value] of [
  ['Stems', 'present'], ['Tonart (Tonhöhe)', 'Fm'], ['Genre', 'House'],
  ['Erstellungsdatum von', '2026-10-01'], ['Erstellungsdatum bis', '2026-10-01'],
  ['Änderungsdatum von', '2026-11-02'], ['Änderungsdatum bis', '2026-11-02'],
]) {
  find(tree(), element => element.props['aria-label'] === label)!.props.onChange({ target: { value } });
}
assert.equal(Object.values(filters).filter(Boolean).length, 7, 'all controls combine without discarding previous values');
assert.deepEqual(filterLibraryTracks([first, track('2')], filters, snapshot(true)).map(t => t.id), ['1']);
assert.deepEqual(filterLibraryTracks([first], filters, snapshot(false)), [], 'active availability filter updates after snapshot replacement');
find(tree(), element => element.type === 'button')!.props.onClick();
assert.equal(resetCount, 1);
assert.deepEqual(filters, DEFAULT_LIBRARY_FILTERS);
const invalid = renderToStaticMarkup(<BrowserLibraryFilters filters={{ createdFrom: '2026-11-02', createdTo: '2026-10-01' }} {...options} active onChange={noop} onReset={noop} />);
assert.ok(invalid.includes('role="alert"'));

// Options derive from the whole collection even when the table renders its first page.
const large = Array.from({ length: 201 }, (_, i) => track(String(i + 1), i === 200 ? { genre: 'Beyond first page', title: 'Hidden paged row' } : {}));
for (const render of [browser, modal]) {
  const html = render(large);
  assert.ok(html.includes('Beyond first page'), 'filter options include metadata past first page');
  assert.ok(!html.includes('Hidden paged row'), 'initial DOM stays bounded');
  assert.ok(html.includes('201'), 'counts include full collection');
}
assert.ok(browser().includes('Track 1'), 'full collection renders even when loaded tracks is empty');
console.log('Library UI: both lists, metadata honesty, controlled combined filters, reset, pagination and fresh stem snapshots passed.');
