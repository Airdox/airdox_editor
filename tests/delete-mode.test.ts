import assert from 'node:assert/strict';
import { executeClear, executeRippleDelete } from '../src/audio/editingEngine';
import {
  assertAudioEquals,
  audioBufferFactory,
  channelSamples,
  makeAudioBuffer,
  positionEncodedSamples,
  selectionFromSamples,
  spliceReference,
} from './support/editingHarness';

const samples = positionEncodedSamples(4);
const original = makeAudioBuffer(samples);
const originalBefore = channelSamples(original);
const selection = selectionFromSamples(original, 1_000, 2_000);
const cue = { id: 'after', name: 'After', type: 'MEMORY' as const, position: 3, color: '#fff' };

// Normal Delete is duration-preserving: selected PCM becomes silence and all
// timeline metadata keeps its absolute position.
const normal = executeClear(makeAudioBuffer(samples), selection, [cue], [], audioBufferFactory, {
  trackId: 'delete-mode-track',
});
const normalExpected = new Float32Array(samples);
normalExpected.fill(0, 1_000, 2_000);
assert.equal(normal.newBuffer.length, samples.length, 'Normal Delete preserves track length');
assertAudioEquals(normal.newBuffer, normalExpected, 'Normal Delete silence result');
assert.equal(normal.newCues[0].position, 3, 'Normal Delete does not shift following cues');

// Ripple Delete closes the gap and shifts metadata by the removed duration.
const ripple = executeRippleDelete(
  { originalBuffer: original, workingBuffer: makeAudioBuffer(samples) },
  selection,
  [cue],
  [],
  audioBufferFactory,
  { trackId: 'delete-mode-track' }
);
assert.equal(ripple.newBuffer.length, 3_000, 'Ripple Delete shortens the working timeline');
assertAudioEquals(ripple.newBuffer, spliceReference(samples, 1_000, 2_000), 'Ripple Delete closes gap');
assert.equal(ripple.newCues[0].position, 2, 'Ripple Delete shifts following cues');

// Neither choice may affect the immutable original.
assertAudioEquals(original, originalBefore, 'delete mode choices preserve original');

console.log('delete modes: normal silence and ripple timeline closure OK');
