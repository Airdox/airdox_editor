/**
 * Ripple Delete original-source integrity contracts.
 *
 * These tests intentionally keep the immutable source, app-owned working
 * buffer and physical source path separate. A future implementation must not
 * turn Ripple Delete into an in-place or filesystem write operation.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeRippleDelete,
  renderEditSegments,
} from '../src/audio/editingEngine';
import { OriginalMediaReference } from '../src/types/rekordbox';
import {
  assertAudioEquals,
  audioBufferFactory,
  channelSamples,
  makeAudioBuffer,
  positionEncodedSamples,
  selectionFromSamples,
  spliceReference,
} from './support/editingHarness';

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const sourceSamples = positionEncodedSamples(8);
const immutableOriginal = makeAudioBuffer(sourceSamples);
let working = makeAudioBuffer(sourceSamples);
let segments = [];
const originalBefore = channelSamples(immutableOriginal);
const media: OriginalMediaReference = {
  location: 'C:\\Music\\immutable-original.wav',
  resolvedPath: 'C:\\Music\\immutable-original.wav',
  accessMode: 'READ_ONLY',
  status: 'AVAILABLE',
  size: sourceSamples.byteLength,
  modifiedAt: 123456,
};
const mediaBefore = structuredClone(media);

// 1–3: the result is a fresh working buffer; original PCM and its reference do
// not change, while following audio closes the deleted gap.
const firstSelection = selectionFromSamples(working, 1_250, 2_750);
const first = executeRippleDelete(
  { originalBuffer: immutableOriginal, workingBuffer: working, originalMedia: media },
  firstSelection,
  [],
  segments,
  audioBufferFactory,
  { trackId: 'integrity-track' }
);
const firstExpected = spliceReference(sourceSamples, 1_250, 2_750);
assert.notStrictEqual(first.newBuffer, working, 'Ripple Delete allocates a new working buffer');
assert.notStrictEqual(first.newBuffer, immutableOriginal, 'Ripple Delete never returns the original as editable output');
assertAudioEquals(first.newBuffer, firstExpected, 'first Ripple Delete working result');
assertAudioEquals(immutableOriginal, originalBefore, 'original after first Ripple Delete');
assert.deepEqual(media, mediaBefore, 'read-only original reference is preserved exactly');
working = first.newBuffer;
segments = first.newSegments;

// 4: repeated edits remain confined to successive working representations and
// the EDL still replays from the unchanged original.
const secondSelection = selectionFromSamples(working, 3_000, 3_600);
const second = executeRippleDelete(
  { originalBuffer: immutableOriginal, workingBuffer: working, originalMedia: media },
  secondSelection,
  [],
  segments,
  audioBufferFactory,
  { trackId: 'integrity-track' }
);
const secondExpected = spliceReference(firstExpected, 3_000, 3_600);
assertAudioEquals(second.newBuffer, secondExpected, 'second Ripple Delete working result');
assertAudioEquals(immutableOriginal, originalBefore, 'original after repeated Ripple Delete');
assertAudioEquals(
  renderEditSegments(immutableOriginal, second.newSegments, audioBufferFactory),
  secondExpected,
  'EDL replay keeps original/working-copy relationship'
);

// 5: allocation/render failure is atomic from the caller's perspective. No
// source or current working data is modified before the exception escapes.
const workingBeforeFailure = channelSamples(second.newBuffer);
assert.throws(
  () => executeRippleDelete(
    { originalBuffer: immutableOriginal, workingBuffer: second.newBuffer, originalMedia: media },
    selectionFromSamples(second.newBuffer, 100, 300),
    [],
    second.newSegments,
    () => { throw new Error('simulated allocation abort'); },
    { trackId: 'integrity-track' }
  ),
  /simulated allocation abort/
);
assertAudioEquals(immutableOriginal, originalBefore, 'original after aborted Ripple Delete');
assertAudioEquals(second.newBuffer, workingBeforeFailure, 'working buffer after aborted Ripple Delete');

// Runtime input validation is fail-closed even if untyped external data tries
// to mark an original path writable.
assert.throws(
  () => executeRippleDelete(
    {
      originalBuffer: immutableOriginal,
      workingBuffer: second.newBuffer,
      originalMedia: { ...media, accessMode: 'WRITE' } as unknown as OriginalMediaReference,
    },
    selectionFromSamples(second.newBuffer, 100, 300),
    [],
    second.newSegments,
    audioBufferFactory
  ),
  /nicht schreibgeschützte Originalreferenz/
);

// 6–7: an actual read-only source file retains content, size and modification
// time. The engine receives decoded memory only and has no filesystem write API.
const tempRoot = await mkdtemp(join(tmpdir(), 'airdox-ripple-integrity-'));
const sourcePath = join(tempRoot, 'original.wav');
const sourceBytes = Buffer.from(sourceSamples.buffer, sourceSamples.byteOffset, sourceSamples.byteLength);
try {
  await writeFile(sourcePath, sourceBytes, { flag: 'wx' });
  const beforeStat = await stat(sourcePath);
  const beforeBytes = await readFile(sourcePath);
  await chmod(sourcePath, 0o444);

  const decodedOriginal = makeAudioBuffer(new Float32Array(
    beforeBytes.buffer.slice(beforeBytes.byteOffset, beforeBytes.byteOffset + beforeBytes.byteLength)
  ));
  executeRippleDelete(
    {
      originalBuffer: decodedOriginal,
      workingBuffer: makeAudioBuffer(channelSamples(decodedOriginal)),
      originalMedia: {
        location: sourcePath,
        resolvedPath: sourcePath,
        accessMode: 'READ_ONLY',
        status: 'AVAILABLE',
        size: beforeStat.size,
        modifiedAt: beforeStat.mtimeMs,
      },
    },
    selectionFromSamples(decodedOriginal, 500, 1_000),
    [],
    [],
    audioBufferFactory
  );

  const afterStat = await stat(sourcePath);
  const afterBytes = await readFile(sourcePath);
  assert.equal(digest(afterBytes), digest(beforeBytes), 'physical original SHA-256 remains identical');
  assert.equal(afterStat.size, beforeStat.size, 'physical original size remains identical');
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'physical original modification time remains identical');
} finally {
  await chmod(sourcePath, 0o644).catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('ripple-delete original integrity: 7 architecture contracts OK');
