import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseRekordboxXmlAsync } from '../src/rekordbox/xmlParser';

const xmlPath = fileURLToPath(new URL('../rekordbox_export2.xml', import.meta.url));
const xml = await readFile(xmlPath, 'utf8');
const sha256 = createHash('sha256').update(xml).digest('hex');

assert.equal(
  sha256,
  '35506c196ddbb8c057153b3a102db4f8704e4596908211468611880d36a98390',
  'bundled collection remains byte-for-byte identical to the supplied Rekordbox export'
);

const parsed = await parseRekordboxXmlAsync(xml);
assert.equal(parsed.rawVersion, '1.0.0', 'the original Rekordbox XML schema is retained');
assert.equal(parsed.tracks.length, 10_767, 'all collection tracks are present; playlist key references are not misread as tracks');

const withMediaPath = parsed.tracks.filter((track) => Boolean(track.originalMedia?.location));
assert.equal(withMediaPath.length, 10_767, 'all original media references are preserved');
assert.ok(
  withMediaPath.every((track) => track.originalMedia?.location.startsWith('file://localhost')),
  'original media references remain Rekordbox file URLs'
);
assert.ok(
  parsed.tracks.some((track) => (track.cues?.length || 0) > 0),
  'original Rekordbox position markers are parsed'
);
assert.ok(
  parsed.tracks.some((track) => (track.beatGrid?.beats.length || 0) === 0 && track.bpm > 0),
  'collection parsing does not allocate dense beat grids for every row'
);
assert.ok(parsed.tracks.every((track) => !track.analysis && !track.audioBuffer),
  'XML metadata alone never creates audio or synthetic waveform data');

console.log('bundled Rekordbox XML: source hash and 10,767 original collection entries verified');
