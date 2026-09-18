/**
 * Shared causal-edit test harness.
 *
 * This module is deliberately framework-free: the direct `tsx` regression
 * scripts and future test runners use the same independent reference model.
 * It verifies every mutating edit against five contracts after each command:
 *
 *   1. sample-exact PCM output and duration,
 *   2. replay of the persisted non-destructive EDL,
 *   3. waveform peaks calculated from the resulting PCM,
 *   4. cue / loop / phrase time mapping, and
 *   5. beat-grid time mapping.
 *
 * The oracle never calls the production edit helpers for its expected audio or
 * metadata transformations, so a shared implementation bug cannot make an
 * edit operation and its test agree accidentally.
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
  executePaste,
  executeReplace,
  renderEditSegments,
} from '../../src/audio/editingEngine';
import {
  BeatGrid,
  CuePoint,
  DataOrigin,
  EditSegment,
  LoopPoint,
  PhraseSection,
  SelectionRange,
  WaveformAnalysisData,
} from '../../src/types/rekordbox';
import { analyzeAudioBuffer } from '../../src/waveform/analyzer';

export const TEST_SAMPLE_RATE = 1_000;
export const AUDIO_EPSILON = 2e-6;
const TIME_EPSILON = 1e-8;
const SAMPLE_INDEX_EPSILON = 1e-6;

function timeToSampleFloor(seconds: number, sampleRate: number): number {
  return Math.floor(seconds * sampleRate + SAMPLE_INDEX_EPSILON);
}

export type EditCommand =
  | 'COPY'
  | 'CUT'
  | 'DELETE'
  | 'CLEAR'
  | 'INSERT'
  | 'PASTE_INSERT'
  | 'PASTE_REPLACE'
  | 'REPLACE'
  | 'OVERDUB';

export const EDIT_COMMANDS: readonly EditCommand[] = [
  'COPY',
  'CUT',
  'DELETE',
  'CLEAR',
  'INSERT',
  'PASTE_INSERT',
  'PASTE_REPLACE',
  'REPLACE',
  'OVERDUB',
];

/** Browser-independent AudioBuffer double with a real mutable Float32 backing store. */
export function makeAudioBuffer(
  left: Float32Array,
  sampleRate = TEST_SAMPLE_RATE,
  right?: Float32Array
): AudioBuffer {
  const channels = [new Float32Array(left), new Float32Array(right || left)];
  return {
    length: left.length,
    duration: left.length / sampleRate,
    sampleRate,
    numberOfChannels: 2,
    getChannelData(channel: number) {
      return channels[channel] || channels[0];
    },
    copyFromChannel(destination: Float32Array, channel: number, start = 0) {
      destination.set((channels[channel] || channels[0]).subarray(start, start + destination.length));
    },
    copyToChannel(source: Float32Array, channel: number, start = 0) {
      (channels[channel] || channels[0]).set(source, start);
    },
  } as unknown as AudioBuffer;
}

export function audioBufferFactory(channels: number, length: number, sampleRate: number): AudioBuffer {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    length,
    duration: length / sampleRate,
    sampleRate,
    numberOfChannels: channels,
    getChannelData(channel: number) {
      return data[channel] || data[0];
    },
    copyFromChannel(destination: Float32Array, channel: number, start = 0) {
      destination.set((data[channel] || data[0]).subarray(start, start + destination.length));
    },
    copyToChannel(source: Float32Array, channel: number, start = 0) {
      (data[channel] || data[0]).set(source, start);
    },
  } as unknown as AudioBuffer;
}

/** A non-zero, position-encoded signal makes accidental gaps detectable. */
export function positionEncodedSamples(seconds = 12, sampleRate = TEST_SAMPLE_RATE, seed = 0): Float32Array {
  const values = new Float32Array(Math.max(1, Math.round(seconds * sampleRate)));
  for (let index = 0; index < values.length; index++) {
    values[index] = 0.06 + (((index * 37 + seed * 101) % 997) / 997) * 0.76;
  }
  return values;
}

export function clipSamples(seconds = 0.75, sampleRate = TEST_SAMPLE_RATE, seed = 0): Float32Array {
  const values = new Float32Array(Math.max(1, Math.round(seconds * sampleRate)));
  for (let index = 0; index < values.length; index++) {
    values[index] = 0.94 - ((index * 17 + seed * 7) % 71) / 100;
  }
  return values;
}

export function selectionFromSamples(
  buffer: AudioBuffer,
  startSample: number,
  endSample: number
): SelectionRange {
  const start = Math.max(0, Math.min(buffer.length - 1, Math.floor(startSample)));
  const end = Math.max(start + 1, Math.min(buffer.length, Math.floor(endSample)));
  return {
    start: start / buffer.sampleRate,
    end: end / buffer.sampleRate,
    duration: (end - start) / buffer.sampleRate,
    beatsCount: 4,
    barsCount: 1,
  };
}

export function fractionalSelection(
  buffer: AudioBuffer,
  startFraction = 0.23,
  lengthFraction = 0.11
): SelectionRange {
  const start = Math.max(0, Math.min(buffer.length - 1, Math.floor(buffer.length * startFraction)));
  const length = Math.max(1, Math.floor(buffer.length * lengthFraction));
  return selectionFromSamples(buffer, start, Math.min(buffer.length, start + length));
}

export function fractionalInsertionTime(buffer: AudioBuffer, fraction = 0.61): number {
  return Math.max(0, Math.min(buffer.length, Math.floor(buffer.length * fraction))) / buffer.sampleRate;
}

export function channelSamples(buffer: AudioBuffer, channel = 0): Float32Array {
  return new Float32Array(buffer.getChannelData(channel));
}

export function spliceReference(
  source: Float32Array,
  start: number,
  end: number,
  replacement: Float32Array = new Float32Array(0)
): Float32Array {
  const output = new Float32Array(start + replacement.length + (source.length - end));
  output.set(source.subarray(0, start));
  output.set(replacement, start);
  output.set(source.subarray(end), start + replacement.length);
  return output;
}

export function insertReference(source: Float32Array, at: number, inserted: Float32Array): Float32Array {
  return spliceReference(source, at, at, inserted);
}

export function overdubReference(
  source: Float32Array,
  start: number,
  end: number,
  overdub: Float32Array,
  gain = 0.85
): Float32Array {
  const output = new Float32Array(source);
  const count = Math.min(end - start, overdub.length);
  for (let index = 0; index < count; index++) {
    output[start + index] = Math.tanh(source[start + index] + overdub[index] * gain);
  }
  return output;
}

export function assertAudioEquals(
  actual: AudioBuffer,
  expected: Float32Array,
  label: string,
  channel = 0
): void {
  assert.equal(actual.length, expected.length, `${label}: exact causal sample count`);
  const values = actual.getChannelData(channel);
  for (let index = 0; index < expected.length; index++) {
    if (Math.abs(values[index] - expected[index]) > AUDIO_EPSILON) {
      throw new Error(`${label}: channel ${channel}, sample ${index} expected ${expected[index]}, got ${values[index]}`);
    }
  }
}

export function assertProjectAnalysisMatchesAudio(
  buffer: AudioBuffer,
  analysis: WaveformAnalysisData,
  label: string
): void {
  const expected = analyzeAudioBuffer(buffer, DataOrigin.PROJECT);
  assert.equal(analysis.origin, DataOrigin.PROJECT, `${label}: local workflow is marked PROJECT`);
  assert.equal(analysis.length, expected.length, `${label}: waveform bucket count matches audio`);
  for (let index = 0; index < analysis.length; index++) {
    if (Math.abs(analysis.peaks[index] - expected.peaks[index]) > AUDIO_EPSILON) {
      throw new Error(`${label}: waveform peak ${index} is not synchronized to rendered audio`);
    }
  }
}

export interface MetadataState {
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

export function deleteMetadata(metadata: MetadataState, start: number, end: number): MetadataState {
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

export function insertMetadata(metadata: MetadataState, at: number, duration: number): MetadataState {
  const meter = metadata.beatGrid.meter || 4;
  const secondsPerBeat = 60 / metadata.beatGrid.bpm;
  const targetBeat = Math.round((at - metadata.beatGrid.firstBeat) / secondsPerBeat);
  const insertedBeats = Array.from({ length: Math.max(0, Math.ceil(duration / secondsPerBeat)) }, (_, index) => index * secondsPerBeat)
    .filter((offset) => offset < duration - TIME_EPSILON)
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
    .filter((beat, index, all) => index === 0 || Math.abs(beat.time - all[index - 1].time) > TIME_EPSILON);

  return {
    cues: metadata.cues.map((cue) => ({ ...cue, position: cue.position >= at ? cue.position + duration : cue.position })),
    loops: metadata.loops.map((loop) => {
      const start = loop.start >= at ? loop.start + duration : loop.start;
      const end = loop.end >= at ? loop.end + duration : loop.end;
      return { ...loop, start, end, length: end - start };
    }),
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
    assert.ok(
      Math.abs(value - expected[index]) <= TIME_EPSILON,
      `${label}: item ${index}; expected ${expected[index]}, got ${value}`
    );
  });
}

export function assertMetadataEquals(actual: MetadataState, expected: MetadataState, label: string): void {
  assert.deepEqual(actual.cues.map((cue) => cue.id), expected.cues.map((cue) => cue.id), `${label}: cue identities`);
  assertTimeArraysClose(actual.cues.map((cue) => cue.position), expected.cues.map((cue) => cue.position), `${label}: cue positions move causally`);
  assert.deepEqual(actual.loops.map((loop) => loop.id), expected.loops.map((loop) => loop.id), `${label}: loop identities`);
  assertTimeArraysClose(
    actual.loops.flatMap((loop) => [loop.start, loop.end, loop.length]),
    expected.loops.flatMap((loop) => [loop.start, loop.end, loop.length]),
    `${label}: loop ranges move causally`
  );
  assertTimeArraysClose(
    actual.beatGrid.beats.map((beat) => beat.time),
    expected.beatGrid.beats.map((beat) => beat.time),
    `${label}: beat-grid times follow the timeline`
  );
  assert.deepEqual(actual.phrases.map((phrase) => phrase.id), expected.phrases.map((phrase) => phrase.id), `${label}: phrase identities`);
  assertTimeArraysClose(
    actual.phrases.flatMap((phrase) => [phrase.startTime, phrase.endTime]),
    expected.phrases.flatMap((phrase) => [phrase.startTime, phrase.endTime]),
    `${label}: phrase boundaries follow the timeline`
  );
}

export function initialMetadata(duration = 12): MetadataState {
  const max = Math.max(1, duration);
  const clampTime = (time: number) => Math.min(time, Math.max(0.05, max - 0.05));
  const startA = clampTime(Math.min(0.5, max * 0.08));
  const startB = clampTime(Math.min(3.5, max * 0.29));
  const startC = clampTime(Math.min(7.5, max * 0.62));
  const startD = clampTime(Math.min(11, max * 0.91));
  const beats = Array.from({ length: Math.max(2, Math.floor(max / 0.5)) }, (_, index) => ({
    index,
    time: index * 0.5,
    beatInBar: (index % 4) + 1,
    isBarStart: index % 4 === 0,
    barNumber: Math.floor(index / 4) + 1,
  }));
  const phrases: PhraseSection[] = [
    { id: 'phrase-a', name: 'INTRO', startBar: 1, endBar: 2, startTime: 0, endTime: Math.min(max, 2), color: '#fff', origin: DataOrigin.REKORDBOX_ANLZ },
    { id: 'phrase-b', name: 'DROP', startBar: 2, endBar: 4, startTime: Math.min(max, 2), endTime: Math.min(max, 6), color: '#fff', origin: DataOrigin.REKORDBOX_ANLZ },
    { id: 'phrase-c', name: 'OUTRO', startBar: 4, endBar: 7, startTime: Math.min(max, 6), endTime: Math.min(max, 11.5), color: '#fff', origin: DataOrigin.REKORDBOX_ANLZ },
  ];
  return {
    cues: [
      { id: 'cue-a', name: 'A', type: 'MEMORY', position: startA, color: '#f00', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'cue-b', name: 'B', type: 'MEMORY', position: startB, color: '#f00', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'cue-c', name: 'C', type: 'MEMORY', position: startC, color: '#f00', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'cue-d', name: 'D', type: 'MEMORY', position: startD, color: '#f00', origin: DataOrigin.REKORDBOX_ANLZ },
    ],
    loops: [
      { id: 'loop-a', name: 'before', start: 0.1, end: Math.min(max, 1.1), length: Math.min(max, 1.1) - 0.1, color: '#f90', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'loop-b', name: 'crossing', start: Math.min(max * 0.12, 1.5), end: Math.min(max, Math.max(max * 0.46, 2.5)), length: Math.max(0, Math.min(max, Math.max(max * 0.46, 2.5)) - Math.min(max * 0.12, 1.5)), color: '#f90', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'loop-c', name: 'after', start: Math.min(max * 0.66, Math.max(0, max - 0.2)), end: Math.min(max, Math.max(max * 0.82, 0.2)), length: Math.max(0, Math.min(max, Math.max(max * 0.82, 0.2)) - Math.min(max * 0.66, Math.max(0, max - 0.2))), color: '#f90', origin: DataOrigin.REKORDBOX_ANLZ },
    ].filter((loop) => loop.length > 0),
    beatGrid: { firstBeat: 0, bpm: 120, meter: 4, beats, origin: DataOrigin.REKORDBOX_ANLZ },
    phrases: phrases.filter((phrase) => phrase.endTime > phrase.startTime),
  };
}

export interface CausalEditState {
  /** Unchanged original needed to validate serialized EDL replay. */
  original: AudioBuffer;
  buffer: AudioBuffer;
  reference: Float32Array;
  clipboard: AudioBuffer;
  clipboardReference: Float32Array;
  segments: EditSegment[];
  metadata: MetadataState;
}

export function createCausalEditState(options: {
  seconds?: number;
  original?: Float32Array;
  clipboard?: Float32Array;
  seed?: number;
} = {}): CausalEditState {
  const original = options.original || positionEncodedSamples(options.seconds ?? 12, TEST_SAMPLE_RATE, options.seed ?? 0);
  const clipboard = options.clipboard || clipSamples(0.75, TEST_SAMPLE_RATE, options.seed ?? 0);
  return {
    original: makeAudioBuffer(original),
    buffer: makeAudioBuffer(original),
    reference: new Float32Array(original),
    clipboard: makeAudioBuffer(clipboard),
    clipboardReference: new Float32Array(clipboard),
    segments: [],
    metadata: initialMetadata(original.length / TEST_SAMPLE_RATE),
  };
}

export interface ApplyEditOptions {
  selection?: SelectionRange;
  insertTime?: number;
  label?: string;
}

/**
 * Executes a production command and validates it immediately against the
 * independent PCM/metadata model. This is the core reusable test primitive.
 */
export function applyAndVerifyEdit(
  state: CausalEditState,
  command: EditCommand,
  options: ApplyEditOptions = {}
): void {
  const selection = options.selection || fractionalSelection(state.buffer);
  const start = timeToSampleFloor(Math.min(selection.start, selection.end), state.buffer.sampleRate);
  const end = timeToSampleFloor(Math.max(selection.start, selection.end), state.buffer.sampleRate);
  const insertionTime = options.insertTime ?? fractionalInsertionTime(state.buffer);
  const insertion = timeToSampleFloor(Math.max(0, Math.min(state.buffer.duration, insertionTime)), state.buffer.sampleRate);
  const actualInsertTime = insertion / state.buffer.sampleRate;
  const label = options.label || command;
  const context: EditCommandContext = {
    trackId: 'causal-harness-track',
    loops: state.metadata.loops,
    beatGrid: state.metadata.beatGrid,
    phrases: state.metadata.phrases,
  };
  let result;
  let expectedMetadata = state.metadata;

  switch (command) {
    case 'COPY': {
      state.clipboard = executeCopy(state.buffer, selection, audioBufferFactory);
      state.clipboardReference = new Float32Array(state.reference.subarray(start, end));
      assertAudioEquals(state.clipboard, state.clipboardReference, `${label} clipboard`);
      return;
    }
    case 'CUT': {
      const cut = executeCut(state.buffer, selection, state.metadata.cues, state.segments, audioBufferFactory, context);
      state.clipboard = cut.clipboard;
      state.clipboardReference = new Float32Array(state.reference.subarray(start, end));
      result = cut.execution;
      state.reference = spliceReference(state.reference, start, end);
      expectedMetadata = deleteMetadata(state.metadata, selection.start, selection.end);
      break;
    }
    case 'DELETE':
      result = executeDelete(state.buffer, selection, state.metadata.cues, state.segments, audioBufferFactory, context);
      state.reference = spliceReference(state.reference, start, end);
      expectedMetadata = deleteMetadata(state.metadata, selection.start, selection.end);
      break;
    case 'CLEAR': {
      result = executeClear(state.buffer, selection, state.metadata.cues, state.segments, audioBufferFactory, context);
      const cleared = new Float32Array(state.reference);
      cleared.fill(0, start, end);
      state.reference = cleared;
      break;
    }
    case 'INSERT':
      result = executeInsert(state.buffer, state.clipboard, actualInsertTime, state.metadata.cues, state.segments, audioBufferFactory, context);
      state.reference = insertReference(state.reference, insertion, state.clipboardReference);
      expectedMetadata = insertMetadata(state.metadata, actualInsertTime, state.clipboard.duration);
      break;
    case 'PASTE_INSERT':
      result = executePaste(state.buffer, state.clipboard, actualInsertTime, null, state.metadata.cues, state.segments, audioBufferFactory, context);
      state.reference = insertReference(state.reference, insertion, state.clipboardReference);
      expectedMetadata = insertMetadata(state.metadata, actualInsertTime, state.clipboard.duration);
      break;
    case 'PASTE_REPLACE':
      result = executePaste(state.buffer, state.clipboard, selection.start, selection, state.metadata.cues, state.segments, audioBufferFactory, context);
      state.reference = spliceReference(state.reference, start, end, state.clipboardReference);
      expectedMetadata = insertMetadata(
        deleteMetadata(state.metadata, selection.start, selection.end),
        selection.start,
        state.clipboard.duration
      );
      break;
    case 'REPLACE':
      result = executeReplace(state.buffer, state.clipboard, selection, state.metadata.cues, state.segments, audioBufferFactory, context);
      state.reference = spliceReference(state.reference, start, end, state.clipboardReference);
      expectedMetadata = insertMetadata(
        deleteMetadata(state.metadata, selection.start, selection.end),
        selection.start,
        state.clipboard.duration
      );
      break;
    case 'OVERDUB':
      result = executeOverdub(state.buffer, state.clipboard, selection, state.metadata.cues, state.segments, 0.85, audioBufferFactory, context);
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
  assertMetadataEquals(actualMetadata, expectedMetadata, label);
  state.metadata = actualMetadata;
  assertAudioEquals(state.buffer, state.reference, label);
  assertProjectAnalysisMatchesAudio(state.buffer, result!.newAnalysis, label);

  // The same renderer used by project reopen must reproduce the live command.
  const replayed = renderEditSegments(state.original, state.segments, audioBufferFactory);
  assertAudioEquals(replayed, state.reference, `${label} persisted EDL replay`);
}
