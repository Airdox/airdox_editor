/**
 * Exhaustive causal edit-command matrix.
 *
 * Every ordered triple of COPY, CUT, DELETE, CLEAR, INSERT, both PASTE modes,
 * REPLACE and OVERDUB is run against a sample-level reference timeline. This
 * catches the class of defect where a valid four-bar insertion is followed by
 * an unrequested silent gap only after an earlier workflow operation.
 */

import assert from 'node:assert/strict';
import {
  EditCommandContext,
  executeClear,
  executeCopy,
  executeCut,
  executeDelete,
  executeInsert,
  executeOverdub,
  isExactSameSourceSlotRoundTrip,
  executePaste,
  executeReplace,
  renderEditSegments,
} from '../src/audio/editingEngine';
import {
  BeatGrid,
  CuePoint,
  DataOrigin,
  EditSegment,
  LoopPoint,
  PhraseSection,
  SelectionRange,
  WaveformAnalysisData,
} from '../src/types/rekordbox';
import { composeWaveformFromEditSegments, sliceWaveformAnalysis } from '../src/waveform/analysisComposer';
import { analyzeAudioBuffer } from '../src/waveform/analyzer';

const RATE = 1_000;
const EPSILON = 2e-6;

type Command =
  | 'COPY'
  | 'CUT'
  | 'DELETE'
  | 'CLEAR'
  | 'INSERT'
  | 'PASTE_INSERT'
  | 'PASTE_REPLACE'
  | 'REPLACE'
  | 'OVERDUB';

const COMMANDS: Command[] = [
  'COPY', 'CUT', 'DELETE', 'CLEAR', 'INSERT',
  'PASTE_INSERT', 'PASTE_REPLACE', 'REPLACE', 'OVERDUB',
];

function makeBuffer(values: Float32Array, sampleRate = RATE): AudioBuffer {
  const channels = [new Float32Array(values), new Float32Array(values)];
  return {
    length: values.length,
    duration: values.length / sampleRate,
    sampleRate,
    numberOfChannels: 2,
    getChannelData(channel: number) {
      return channels[channel] || channels[0];
    },
    copyFromChannel() {},
    copyToChannel() {},
  } as unknown as AudioBuffer;
}

function factory(channels: number, length: number, sampleRate: number): AudioBuffer {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    length,
    duration: length / sampleRate,
    sampleRate,
    numberOfChannels: channels,
    getChannelData(channel: number) {
      return data[channel] || data[0];
    },
    copyFromChannel() {},
    copyToChannel() {},
  } as unknown as AudioBuffer;
}

function initialSamples(seconds = 12): Float32Array {
  const values = new Float32Array(seconds * RATE);
  for (let index = 0; index < values.length; index++) {
    // Always non-zero and recognizably position dependent.
    values[index] = 0.08 + ((index % 997) / 997) * 0.7;
  }
  return values;
}

function clipSamples(seconds = 0.75): Float32Array {
  const values = new Float32Array(Math.round(seconds * RATE));
  for (let index = 0; index < values.length; index++) values[index] = 0.92 - (index % 71) / 100;
  return values;
}

function selectionFor(buffer: AudioBuffer): SelectionRange {
  const startSample = Math.max(1, Math.floor(buffer.length * 0.23));
  const length = Math.max(1, Math.floor(buffer.length * 0.11));
  const endSample = Math.min(buffer.length - 1, startSample + length);
  return {
    start: startSample / RATE,
    end: endSample / RATE,
    duration: (endSample - startSample) / RATE,
    beatsCount: 4,
    barsCount: 1,
  };
}

function insertTimeFor(buffer: AudioBuffer): number {
  return Math.floor(buffer.length * 0.61) / RATE;
}

function arrayFromBuffer(buffer: AudioBuffer): Float32Array {
  return new Float32Array(buffer.getChannelData(0));
}

function spliceReference(source: Float32Array, start: number, end: number, replacement?: Float32Array): Float32Array {
  const insert = replacement || new Float32Array(0);
  const output = new Float32Array(start + insert.length + (source.length - end));
  output.set(source.subarray(0, start));
  output.set(insert, start);
  output.set(source.subarray(end), start + insert.length);
  return output;
}

function insertReference(source: Float32Array, at: number, inserted: Float32Array): Float32Array {
  return spliceReference(source, at, at, inserted);
}

function overdubReference(source: Float32Array, start: number, end: number, overdub: Float32Array, gain = 0.85): Float32Array {
  const output = new Float32Array(source);
  const count = Math.min(end - start, overdub.length);
  for (let index = 0; index < count; index++) {
    output[start + index] = Math.tanh(source[start + index] + overdub[index] * gain);
  }
  return output;
}

function assertAudioEquals(actual: AudioBuffer, expected: Float32Array, label: string): void {
  assert.equal(actual.length, expected.length, `${label}: exact causal sample count`);
  const values = actual.getChannelData(0);
  for (let index = 0; index < expected.length; index++) {
    if (Math.abs(values[index] - expected[index]) > EPSILON) {
      throw new Error(`${label}: sample ${index} expected ${expected[index]}, got ${values[index]}`);
    }
  }
}

function assertAnalysisMatchesBuffer(buffer: AudioBuffer, analysis: WaveformAnalysisData, label: string): void {
  const expected = analyzeAudioBuffer(buffer, DataOrigin.PROJECT);
  assert.equal(analysis.origin, DataOrigin.PROJECT, `${label}: non-native path is marked PROJECT`);
  assert.equal(analysis.length, expected.length, `${label}: waveform bucket count matches audio`);
  for (let index = 0; index < analysis.length; index++) {
    if (Math.abs(analysis.peaks[index] - expected.peaks[index]) > EPSILON) {
      throw new Error(`${label}: waveform peak ${index} is not synchronized to audio`);
    }
  }
}

function assertValuesClose(actual: Float32Array, expected: number[], label: string): void {
  assert.equal(actual.length, expected.length, `${label}: bucket count`);
  expected.forEach((value, index) => {
    assert.ok(Math.abs(actual[index] - value) <= EPSILON, `${label}: bucket ${index}`);
  });
}

interface MetadataState {
  cues: CuePoint[];
  loops: LoopPoint[];
  beatGrid: BeatGrid;
  phrases: PhraseSection[];
}

function mapDeletedPosition(position: number, start: number, end: number): number {
  if (position < start) return position;
  if (position >= end) return position - (end - start);
  return start;
}

function deleteMetadata(metadata: MetadataState, start: number, end: number): MetadataState {
  const duration = end - start;
  return {
    cues: metadata.cues
      .filter((cue) => cue.position < start || cue.position >= end)
      .map((cue) => ({ ...cue, position: cue.position >= end ? cue.position - duration : cue.position })),
    loops: metadata.loops.flatMap((loop) => {
      const loopStart = mapDeletedPosition(loop.start, start, end);
      const loopEnd = mapDeletedPosition(loop.end, start, end);
      return loopEnd > loopStart ? [{ ...loop, start: loopStart, end: loopEnd, length: loopEnd - loopStart }] : [];
    }),
    beatGrid: {
      ...metadata.beatGrid,
      beats: metadata.beatGrid.beats
        .filter((beat) => beat.time < start || beat.time >= end)
        .map((beat) => ({ ...beat, time: beat.time >= end ? beat.time - duration : beat.time }))
        .sort((a, b) => a.time - b.time),
    },
    phrases: metadata.phrases.flatMap((phrase) => {
      const phraseStart = mapDeletedPosition(phrase.startTime, start, end);
      const phraseEnd = mapDeletedPosition(phrase.endTime, start, end);
      return phraseEnd > phraseStart ? [{ ...phrase, startTime: phraseStart, endTime: phraseEnd }] : [];
    }),
  };
}

function insertMetadata(metadata: MetadataState, at: number, duration: number): MetadataState {
  const meter = metadata.beatGrid.meter || 4;
  const spb = 60 / metadata.beatGrid.bpm;
  const targetBeat = Math.round((at - metadata.beatGrid.firstBeat) / spb);
  const insertedBeats = Array.from({ length: Math.max(0, Math.ceil(duration / spb)) }, (_, index) => index * spb)
    .filter((offset) => offset < duration - EPSILON)
    .map((offset, index) => ({
      index: -1,
      time: at + offset,
      beatInBar: ((targetBeat + index) % meter + meter) % meter + 1,
      isBarStart: ((targetBeat + index) % meter + meter) % meter === 0,
      barNumber: 0,
    }));
  const allBeats = [...metadata.beatGrid.beats.map((beat) => ({
    ...beat,
    time: beat.time >= at ? beat.time + duration : beat.time,
  })), ...insertedBeats]
    .sort((a, b) => a.time - b.time)
    .filter((beat, index, all) => index === 0 || Math.abs(beat.time - all[index - 1].time) > EPSILON);
  return {
    cues: metadata.cues.map((cue) => ({ ...cue, position: cue.position >= at ? cue.position + duration : cue.position })),
    loops: metadata.loops.map((loop) => ({
      ...loop,
      start: loop.start >= at ? loop.start + duration : loop.start,
      end: loop.end >= at ? loop.end + duration : loop.end,
      length: (loop.end >= at ? loop.end + duration : loop.end) - (loop.start >= at ? loop.start + duration : loop.start),
    })),
    beatGrid: { ...metadata.beatGrid, beats: allBeats },
    phrases: metadata.phrases.map((phrase) => {
      if (phrase.startTime >= at) return { ...phrase, startTime: phrase.startTime + duration, endTime: phrase.endTime + duration };
      if (phrase.endTime > at) return { ...phrase, endTime: phrase.endTime + duration };
      return { ...phrase };
    }),
  };
}

function assertTimeArraysClose(actual: number[], expected: number[], label: string): void {
  assert.equal(actual.length, expected.length, `${label}: item count`);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= 1e-8, `${label}: item ${index}`);
  });
}

function assertMetadataEquals(actual: MetadataState, expected: MetadataState, label: string): void {
  assert.deepEqual(actual.cues.map((cue) => cue.id), expected.cues.map((cue) => cue.id), `${label}: cue identities`);
  assertTimeArraysClose(actual.cues.map((cue) => cue.position), expected.cues.map((cue) => cue.position), `${label}: cue positions move causally`);
  assert.deepEqual(actual.loops.map((loop) => loop.id), expected.loops.map((loop) => loop.id), `${label}: loop identities`);
  assertTimeArraysClose(actual.loops.flatMap((loop) => [loop.start, loop.end, loop.length]), expected.loops.flatMap((loop) => [loop.start, loop.end, loop.length]), `${label}: loop ranges move causally`);
  assertTimeArraysClose(
    actual.beatGrid.beats.map((beat) => beat.time),
    expected.beatGrid.beats.map((beat) => beat.time),
    `${label}: beatgrid times follow the timeline`
  );
  assert.deepEqual(actual.phrases.map((phrase) => phrase.id), expected.phrases.map((phrase) => phrase.id), `${label}: phrase identities`);
  assertTimeArraysClose(actual.phrases.flatMap((phrase) => [phrase.startTime, phrase.endTime]), expected.phrases.flatMap((phrase) => [phrase.startTime, phrase.endTime]), `${label}: phrase boundaries follow the timeline`);
}

interface MatrixState {
  buffer: AudioBuffer;
  reference: Float32Array;
  clipboard: AudioBuffer;
  clipboardReference: Float32Array;
  segments: EditSegment[];
  metadata: MetadataState;
}

function initialMetadata(): MetadataState {
  return {
    cues: [
      { id: 'cue-a', name: 'A', type: 'MEMORY', position: 0.5, color: '#f00', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'cue-b', name: 'B', type: 'MEMORY', position: 3.5, color: '#f00', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'cue-c', name: 'C', type: 'MEMORY', position: 7.5, color: '#f00', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'cue-d', name: 'D', type: 'MEMORY', position: 11, color: '#f00', origin: DataOrigin.REKORDBOX_ANLZ },
    ],
    loops: [
      { id: 'loop-a', name: 'before', start: 0.5, end: 1.5, length: 1, color: '#f90', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'loop-b', name: 'crossing', start: 1.5, end: 5.5, length: 4, color: '#f90', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'loop-c', name: 'after', start: 8, end: 10, length: 2, color: '#f90', origin: DataOrigin.REKORDBOX_ANLZ },
    ],
    beatGrid: {
      firstBeat: 0,
      bpm: 120,
      meter: 4,
      origin: DataOrigin.REKORDBOX_ANLZ,
      beats: Array.from({ length: 24 }, (_, index) => ({
        index,
        time: index * 0.5,
        beatInBar: (index % 4) + 1,
        isBarStart: index % 4 === 0,
        barNumber: Math.floor(index / 4) + 1,
      })),
    },
    phrases: [
      { id: 'phrase-a', name: 'INTRO', startBar: 1, endBar: 2, startTime: 0, endTime: 2, color: '#fff', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'phrase-b', name: 'DROP', startBar: 2, endBar: 4, startTime: 2, endTime: 6, color: '#fff', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'phrase-c', name: 'OUTRO', startBar: 4, endBar: 7, startTime: 6, endTime: 11.5, color: '#fff', origin: DataOrigin.REKORDBOX_ANLZ },
    ],
  };
}

function applyCommand(state: MatrixState, command: Command): void {
  const selection = selectionFor(state.buffer);
  const start = Math.floor(selection.start * RATE);
  const end = Math.floor(selection.end * RATE);
  const insertion = Math.floor(insertTimeFor(state.buffer) * RATE);
  const context: EditCommandContext = {
    trackId: 'matrix-track',
    loops: state.metadata.loops,
    beatGrid: state.metadata.beatGrid,
    phrases: state.metadata.phrases,
  };
  let result;
  let expectedMetadata = state.metadata;

  switch (command) {
    case 'COPY': {
      state.clipboard = executeCopy(state.buffer, selection, factory);
      state.clipboardReference = new Float32Array(state.reference.subarray(start, end));
      assertAudioEquals(state.clipboard, state.clipboardReference, 'COPY clipboard');
      return;
    }
    case 'CUT': {
      const cut = executeCut(state.buffer, selection, state.metadata.cues, state.segments, factory, context);
      state.clipboard = cut.clipboard;
      state.clipboardReference = new Float32Array(state.reference.subarray(start, end));
      result = cut.execution;
      state.reference = spliceReference(state.reference, start, end);
      expectedMetadata = deleteMetadata(state.metadata, selection.start, selection.end);
      break;
    }
    case 'DELETE':
      result = executeDelete(state.buffer, selection, state.metadata.cues, state.segments, factory, context);
      state.reference = spliceReference(state.reference, start, end);
      expectedMetadata = deleteMetadata(state.metadata, selection.start, selection.end);
      break;
    case 'CLEAR': {
      result = executeClear(state.buffer, selection, state.metadata.cues, state.segments, factory, context);
      const cleared = new Float32Array(state.reference);
      cleared.fill(0, start, end);
      state.reference = cleared;
      break;
    }
    case 'INSERT':
      result = executeInsert(state.buffer, state.clipboard, insertion / RATE, state.metadata.cues, state.segments, factory, context);
      state.reference = insertReference(state.reference, insertion, state.clipboardReference);
      expectedMetadata = insertMetadata(state.metadata, insertion / RATE, state.clipboard.duration);
      break;
    case 'PASTE_INSERT':
      result = executePaste(state.buffer, state.clipboard, insertion / RATE, null, state.metadata.cues, state.segments, factory, context);
      state.reference = insertReference(state.reference, insertion, state.clipboardReference);
      expectedMetadata = insertMetadata(state.metadata, insertion / RATE, state.clipboard.duration);
      break;
    case 'PASTE_REPLACE':
      result = executePaste(state.buffer, state.clipboard, selection.start, selection, state.metadata.cues, state.segments, factory, context);
      state.reference = spliceReference(state.reference, start, end, state.clipboardReference);
      expectedMetadata = insertMetadata(
        deleteMetadata(state.metadata, selection.start, selection.end),
        selection.start,
        state.clipboard.duration
      );
      break;
    case 'REPLACE':
      result = executeReplace(state.buffer, state.clipboard, selection, state.metadata.cues, state.segments, factory, context);
      state.reference = spliceReference(state.reference, start, end, state.clipboardReference);
      expectedMetadata = insertMetadata(
        deleteMetadata(state.metadata, selection.start, selection.end),
        selection.start,
        state.clipboard.duration
      );
      break;
    case 'OVERDUB':
      result = executeOverdub(state.buffer, state.clipboard, selection, state.metadata.cues, state.segments, 0.85, factory, context);
      state.reference = overdubReference(state.reference, start, end, state.clipboardReference);
      break;
  }

  state.buffer = result!.newBuffer;
  state.segments = result!.newSegments;
  const actualMetadata: MetadataState = {
    cues: result!.newCues,
    loops: result!.newLoops || [],
    beatGrid: result!.newBeatGrid || state.metadata.beatGrid,
    phrases: result!.newPhrases || [],
  };
  assertMetadataEquals(actualMetadata, expectedMetadata, command);
  state.metadata = actualMetadata;
  assertAudioEquals(state.buffer, state.reference, command);
  assertAnalysisMatchesBuffer(state.buffer, result!.newAnalysis, command);

  // The persisted edit decision list must replay to exactly the live state.
  const replayed = renderEditSegments(makeBuffer(initialSamples()), state.segments, factory);
  assertAudioEquals(replayed, state.reference, `${command} persisted replay`);
}

// ---------------------------------------------------------------------------
// 1) Exhaustive command triples: 9 × 9 × 9 = 729 workflows
// ---------------------------------------------------------------------------
let workflows = 0;
for (const first of COMMANDS) {
  for (const second of COMMANDS) {
    for (const third of COMMANDS) {
      const original = initialSamples();
      const initialClip = clipSamples();
      const state: MatrixState = {
        buffer: makeBuffer(original),
        reference: new Float32Array(original),
        clipboard: makeBuffer(initialClip),
        clipboardReference: new Float32Array(initialClip),
        segments: [],
        metadata: initialMetadata(),
      };
      applyCommand(state, first);
      applyCommand(state, second);
      applyCommand(state, third);
      workflows++;
    }
  }
}
assert.equal(workflows, Math.pow(COMMANDS.length, 3), 'all ordered command triples executed');

// ---------------------------------------------------------------------------
// 2) Metadata boundaries: cues/loops/beat grid/phrases follow audio causally
// ---------------------------------------------------------------------------
const metadataBuffer = makeBuffer(initialSamples(8));
const metadataRange: SelectionRange = { start: 2, end: 4, duration: 2, beatsCount: 4, barsCount: 1 };
const metadataContext: EditCommandContext = {
  trackId: 'native-track',
  loops: [
    { id: 'through', name: 'through', start: 1, end: 5, length: 4, color: '#f90', origin: DataOrigin.REKORDBOX_ANLZ },
    { id: 'inside', name: 'inside', start: 2.2, end: 3.8, length: 1.6, color: '#f90', origin: DataOrigin.REKORDBOX_ANLZ },
  ],
  beatGrid: {
    firstBeat: 0,
    bpm: 120,
    meter: 4,
    origin: DataOrigin.REKORDBOX_ANLZ,
    beats: Array.from({ length: 16 }, (_, index) => ({
      index,
      time: index * 0.5,
      beatInBar: (index % 4) + 1,
      isBarStart: index % 4 === 0,
      barNumber: Math.floor(index / 4) + 1,
    })),
  },
  phrases: [{ id: 'phrase', name: 'INTRO', startBar: 1, endBar: 3, startTime: 1, endTime: 5, color: '#fff', origin: DataOrigin.REKORDBOX_ANLZ }],
};
const metadataResult = executeDelete(
  metadataBuffer,
  metadataRange,
  [
    { id: 'before', name: 'before', type: 'MEMORY', position: 1, color: '#f00' },
    { id: 'inside', name: 'inside', type: 'MEMORY', position: 3, color: '#f00' },
    // The exclusive end boundary is meaningful: this cue survives and shifts.
    { id: 'end', name: 'end', type: 'MEMORY', position: 4, color: '#f00' },
  ],
  [],
  factory,
  metadataContext
);
assert.deepEqual(metadataResult.newCues.map((cue) => [cue.id, cue.position]), [['before', 1], ['end', 2]], 'cue end boundary survives deletion and shifts');
assert.deepEqual(metadataResult.newLoops?.map((loop) => [loop.id, loop.start, loop.end]), [['through', 1, 3]], 'crossing loop shrinks while an enclosed loop is removed');
assert.deepEqual(
  metadataResult.newBeatGrid?.beats.map((beat) => beat.time),
  Array.from({ length: 12 }, (_, index) => index * 0.5),
  'post-delete beat nodes shift into a continuous causal grid without a gap'
);
assert.equal(metadataResult.newPhrases?.[0].endTime, 3, 'crossing phrase contracts with deleted audio');

// ---------------------------------------------------------------------------
// 3) Four-bar palette round trip and native ANLZ waveform composition
// ---------------------------------------------------------------------------
const fourBarBuffer = makeBuffer(initialSamples(16));
const fourBarSelection: SelectionRange = { start: 4, end: 12, duration: 8, beatsCount: 16, barsCount: 4 };
const fourBarClip = executeCopy(fourBarBuffer, fourBarSelection, factory);
assert.equal(
  isExactSameSourceSlotRoundTrip({
    targetBuffer: fourBarBuffer,
    clipBuffer: fourBarClip,
    targetTrackId: 'roundtrip-track',
    sourceTrackId: 'roundtrip-track',
    sourceStart: 4,
    sourceEnd: 12,
    selection: fourBarSelection,
    insertTime: 4,
    tempoRatio: 1,
    semitonesShifted: 0,
  }),
  true,
  'four bars saved to the palette and placed in their unchanged selected slot are a no-op'
);
fourBarBuffer.getChannelData(0)[4 * RATE] += 0.01;
assert.equal(
  isExactSameSourceSlotRoundTrip({
    targetBuffer: fourBarBuffer,
    clipBuffer: fourBarClip,
    targetTrackId: 'roundtrip-track',
    sourceTrackId: 'roundtrip-track',
    sourceStart: 4,
    sourceEnd: 12,
    selection: fourBarSelection,
    insertTime: 4,
    tempoRatio: 1,
    semitonesShifted: 0,
  }),
  false,
  'the no-op guard never hides a legitimate reinsert after the selected source changed'
);

const nativeDuration = 8;
const native = (): WaveformAnalysisData => {
  const buckets = nativeDuration;
  const peaks = Float32Array.from({ length: buckets }, (_, index) => (index + 1) / 10);
  return {
    length: buckets,
    peaks,
    peaksL: new Float32Array(peaks),
    peaksR: new Float32Array(peaks),
    lowEnergy: Float32Array.from(peaks, (value) => value / 2),
    midEnergy: Float32Array.from(peaks, (value) => value / 3),
    highEnergy: Float32Array.from(peaks, (value) => value / 4),
    origin: DataOrigin.REKORDBOX_ANLZ,
    secPerBucket: 1,
  };
};
const nativeBuffer = makeBuffer(initialSamples(nativeDuration));
const nativeSelection: SelectionRange = { start: 2, end: 4, duration: 2, beatsCount: 4, barsCount: 1 };
const nativeClip = executeCopy(nativeBuffer, nativeSelection, factory);
const nativeClipAnalysis = sliceWaveformAnalysis(native(), nativeDuration, 2, 4)!;
const nativeSource = {
  path: 'C:/rekordbox/share/ANLZ0000.DAT',
  accessMode: 'READ_ONLY' as const,
  status: 'AVAILABLE' as const,
  sourceDuration: nativeDuration,
  format: 'DAT' as const,
};
const nativeContext: EditCommandContext = {
  trackId: 'native-track',
  analysis: native(),
  analysisSource: nativeSource,
  analysisSourceDuration: nativeDuration,
  insertedAnalysis: nativeClipAnalysis,
  insertedAnalysisDuration: nativeClip.duration,
  insertedAnalysisSource: nativeSource,
  insertedAnalysisSourceTrackId: 'native-track',
  insertedAnalysisSourceStart: 2,
  insertedAnalysisSourceEnd: 4,
  insertedBeatOffsets: [0, 0.5, 1, 1.5],
};
const identicalReplace = executeReplace(nativeBuffer, nativeClip, nativeSelection, [], [], factory, nativeContext);
assertAudioEquals(identicalReplace.newBuffer, initialSamples(nativeDuration), 'same-slot native replace');
assert.equal(identicalReplace.newAnalysis.origin, DataOrigin.REKORDBOX_ANLZ, 'same-source replacement retains native waveform origin');
for (let index = 0; index < nativeDuration; index++) {
  assert.equal(identicalReplace.newAnalysis.peaks[index], native().peaks[index], 'same-slot waveform bucket is unchanged');
}

const nativeInserted = executeInsert(nativeBuffer, nativeClip, 4, [], [], factory, nativeContext);
assert.equal(nativeInserted.newBuffer.duration, 10, 'two-second native clip adds exactly two seconds');
assert.equal(nativeInserted.newAnalysis.origin, DataOrigin.REKORDBOX_ANLZ, 'native-only splice remains native');
for (let index = 4 * RATE; index < 6 * RATE; index++) {
  assert.notEqual(nativeInserted.newBuffer.getChannelData(0)[index], 0, 'inserted native clip contains no phantom silent tail');
}
assert.equal(nativeInserted.newAnalysis.provenance?.nativeCoverage, 1, 'all inserted waveform buckets originate from ANLZ');

// Project reopen: the saved EDL is replayed against the original buffer and
// re-composed from the native source rather than globally re-analysed.
const reloadedDeleted = executeDelete(nativeBuffer, nativeSelection, [], [], factory, nativeContext);
const replayedDeleted = renderEditSegments(nativeBuffer, reloadedDeleted.newSegments, factory);
const reloadedDeletedAnalysis = composeWaveformFromEditSegments(
  replayedDeleted,
  native(),
  nativeDuration,
  reloadedDeleted.newSegments,
  { path: nativeSource.path, trackId: 'native-track' }
);
assertValuesClose(
  reloadedDeletedAnalysis.peaks,
  [0.1, 0.2, 0.5, 0.6, 0.7, 0.8],
  'project reload maps a deleted native timeline back to the original ANLZ buckets'
);
const replayedInserted = renderEditSegments(nativeBuffer, nativeInserted.newSegments, factory);
const reloadedInsertedAnalysis = composeWaveformFromEditSegments(
  replayedInserted,
  native(),
  nativeDuration,
  nativeInserted.newSegments,
  { path: nativeSource.path, trackId: 'native-track' }
);
assertValuesClose(
  reloadedInsertedAnalysis.peaks,
  [0.1, 0.2, 0.3, 0.4, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
  'a saved same-source insert retains its exact native clip buckets after reload'
);
const clearedNative = executeClear(nativeBuffer, nativeSelection, [], [], factory, nativeContext);
const reloadedClearAnalysis = composeWaveformFromEditSegments(
  renderEditSegments(nativeBuffer, clearedNative.newSegments, factory),
  native(),
  nativeDuration,
  clearedNative.newSegments,
  { path: nativeSource.path, trackId: 'native-track' }
);
assert.equal(reloadedClearAnalysis.peaks[2], 0, 'a saved CLEAR region remains genuinely empty after reload');
assert.equal(reloadedClearAnalysis.peaks[3], 0, 'the complete cleared range has no synthetic minimum waveform');
assert.equal(reloadedClearAnalysis.peaks[4], 0.5, 'native data resumes exactly after the cleared range');

const foreignRate = makeBuffer(new Float32Array(9_600).fill(0.4), 4_800); // 2 seconds @ 4.8 kHz
const sampleRateSafe = executeInsert(nativeBuffer, foreignRate, 4, [], [], factory);
assert.equal(sampleRateSafe.newBuffer.duration, 10, 'cross-rate insertion preserves clip time rather than raw sample count');
for (let index = 4 * RATE; index < 6 * RATE; index++) {
  assert.ok(sampleRateSafe.newBuffer.getChannelData(0)[index] > 0.39, 'resampled insertion has audio across its complete duration');
}

console.log(`edit-command matrix: ${workflows} command triples + metadata/native/rate regressions OK`);
