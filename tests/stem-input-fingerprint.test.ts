import assert from 'node:assert/strict';
import { prepareStemInput } from '../src/audio/stemInput';
import { stemEngine, type TrackStems } from '../src/audio/stemEngine';
import { makeAudioBuffer } from './support/editingHarness';

function sampleBuffer(left: number[], right: number[]): AudioBuffer {
  return makeAudioBuffer(Float32Array.from(left), 48_000, Float32Array.from(right));
}

const firstLeft = [0.125, -0.25, 0.5, -0.75, 0.875];
const firstRight = [-0.125, 0.25, -0.5, 0.75, -0.875];
const original = await prepareStemInput(sampleBuffer(firstLeft, firstRight));

assert.match(original.fingerprint, /^stem-pcm-wav-v1:sha256:[a-f0-9]{64}$/);
assert.equal(original.wav.byteLength, 44 + firstLeft.length * 2 * 4);
assert.equal(new TextDecoder().decode(original.wav.subarray(0, 4)), 'RIFF');
assert.equal(new TextDecoder().decode(original.wav.subarray(8, 12)), 'WAVE');
assert.equal(new TextDecoder().decode(original.wav.subarray(36, 40)), 'data');

const view = new DataView(original.wav.buffer, original.wav.byteOffset, original.wav.byteLength);
assert.equal(view.getFloat32(44, true), firstLeft[0]);
assert.equal(view.getFloat32(48, true), firstRight[0]);
assert.equal(view.getFloat32(44 + (firstLeft.length - 1) * 8, true), firstLeft.at(-1));
assert.equal(view.getFloat32(48 + (firstRight.length - 1) * 8, true), firstRight.at(-1));

const identical = await prepareStemInput(sampleBuffer([...firstLeft], [...firstRight]));
assert.equal(identical.fingerprint, original.fingerprint, 'identical canonical PCM must have a stable fingerprint');

const changedRight = [...firstRight];
changedRight[2] = 0.375;
const rightOnlyEdit = await prepareStemInput(sampleBuffer(firstLeft, changedRight));
assert.notEqual(rightOnlyEdit.fingerprint, original.fingerprint, 'right-channel-only edits must invalidate the cache');

const changedMiddle = [...firstLeft];
changedMiddle[2] = 0.375;
const middleEdit = await prepareStemInput(sampleBuffer(changedMiddle, firstRight));
assert.notEqual(middleEdit.fingerprint, original.fingerprint, 'non-sampled middle frames must participate in the fingerprint');

const nonFinite = await prepareStemInput(sampleBuffer([0.25, Number.NaN], [Number.POSITIVE_INFINITY, -0.5]));
const nonFiniteView = new DataView(nonFinite.wav.buffer, nonFinite.wav.byteOffset, nonFinite.wav.byteLength);
assert.equal(nonFiniteView.getFloat32(48, true), 0, 'non-finite left samples are canonicalized to silence');
assert.equal(nonFiniteView.getFloat32(52, true), 0, 'non-finite right samples are canonicalized to silence');

const trackId = 'working-copy-cache-contract';
const localVariant = 'stem-cache-v2:{"origin":"local","profile":"BALANCED"}';
const cachedStems = {
  trackId,
  originalSha256: 'source-file-hash-a',
  inputFingerprint: original.fingerprint,
} as TrackStems;
stemEngine.clearCache();
stemEngine.cacheStems(trackId, cachedStems, localVariant);
assert.equal(stemEngine.getCachedStems(trackId, original.fingerprint, localVariant), cachedStems);
assert.equal(stemEngine.getCachedStems(trackId, rightOnlyEdit.fingerprint, localVariant), undefined, 'edited PCM must not hit the old result');
assert.equal(stemEngine.getCachedStems(trackId, original.fingerprint, 'stem-cache-v2:{"origin":"remote"}'), undefined, 'local and remote jobs must not cross-hit');
const rebound = stemEngine.getCachedStems(trackId, original.fingerprint, localVariant, 'source-file-hash-b');
assert.equal(rebound?.originalSha256, 'source-file-hash-b', 'cache reuse preserves current source-file provenance');
assert.equal(rebound?.inputFingerprint, original.fingerprint, 'source digest rebinding does not change PCM identity');
stemEngine.clearCache();

// The result cache is LRU-bounded by estimated PCM memory; model results remain
// usable by the active caller but old cached buffers are evicted under pressure.
const budgetBuffer = { length: 80_000_000, numberOfChannels: 1 } as AudioBuffer;
const budgetResult = (id: string, inputFingerprint: string) => ({
  trackId: id,
  originalSha256: `source-${id}`,
  inputFingerprint,
  vocals: budgetBuffer,
  drums: budgetBuffer,
  bass: budgetBuffer,
  other: budgetBuffer,
} as TrackStems);
const budgetVariant = 'stem-cache-v2:budget-test';
stemEngine.cacheStems('budget-track-a', budgetResult('budget-track-a', original.fingerprint), budgetVariant);
stemEngine.cacheStems('budget-track-b', budgetResult('budget-track-b', rightOnlyEdit.fingerprint), budgetVariant);
assert.equal(stemEngine.getCachedStems('budget-track-a', original.fingerprint, budgetVariant), undefined, 'least-recent result is evicted over the 512 MiB budget');
assert.ok(stemEngine.getCachedStems('budget-track-b', rightOnlyEdit.fingerprint, budgetVariant), 'newest result remains cached');
stemEngine.clearCache();

console.log('Stem input fingerprint: exact full stereo PCM WAV, versioned SHA-256, edit/profile-safe bounded cache ✔');
