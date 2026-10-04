import assert from 'node:assert/strict';
import { createEditHistoryEntry, restoreEditHistoryEntry } from '../src/audio/editHistory';
import { editHistoryReducer, EMPTY_EDIT_HISTORY, MAX_EDIT_HISTORY_STEPS } from '../src/audio/editHistoryState';
import { DataOrigin, type EditHistoryEntry, type SelectionRange, type TrackModel, type WaveformAnalysisData } from '../src/types/rekordbox';
import { makeAudioBuffer } from './support/editingHarness';

const makeAnalysis = (peak: number) => ({
  peaks: new Float32Array([peak]),
  lowEnergy: new Float32Array([peak / 2]),
  secPerBucket: 1,
  length: 1,
  origin: DataOrigin.PROJECT,
}) as WaveformAnalysisData;

const sourceBuffer = makeAudioBuffer(new Float32Array([0, 0.25, 0.5, 0.75]), 4);
const workingBuffer = makeAudioBuffer(new Float32Array([0.5, 0.25, 0, -0.25]), 4);
const track = {
  id: 'history-track',
  duration: 1,
  audioBuffer: sourceBuffer,
  workingSegments: [{ id: 'segment-a', type: 'ORIGINAL' }],
  cues: [{ id: 'cue-a', position: 0.25 }],
  loops: [{ id: 'loop-a', start: 0, end: 0.5 }],
  beatGrid: { bpm: 120, firstBeat: 0, beats: [{ index: 0, time: 0 }] },
  phrases: [{ id: 'phrase-a', start: 0, end: 1 }],
  analysis: makeAnalysis(0.2),
} as unknown as TrackModel;
const selection = { start: 0.25, end: 0.5, startBeat: 1, endBeat: 2, beatsCount: 1, barsCount: 0.25, duration: 0.25 } as SelectionRange;

const entry = createEditHistoryEntry(track, selection, workingBuffer, 'test edit', 123);
assert.equal(entry.audioBuffer, workingBuffer, 'history retains immutable PCM by reference instead of cloning it');
assert.notEqual(entry.cues, track.cues, 'small cue metadata is snapshotted by value');
assert.notEqual(entry.segments, track.workingSegments);
assert.notEqual(entry.beatGrid, track.beatGrid);
assert.notEqual(entry.loops, track.loops);
assert.notEqual(entry.phrases, track.phrases);
assert.equal(entry.timestamp, 123);

const restored = restoreEditHistoryEntry(track, entry, {
  renderWorkingAudio: () => { throw new Error('stored buffer should be preferred'); },
  analyzeAudioBuffer: () => makeAnalysis(1),
});
assert.notEqual(restored.track, track, 'undo creates a new TrackModel');
assert.equal(restored.audioBuffer, workingBuffer);
assert.equal(restored.track.cues, entry.cues);
assert.equal(restored.track.loops, entry.loops);
assert.equal(restored.track.beatGrid, entry.beatGrid);
assert.equal(track.cues[0].id, 'cue-a', 'the current TrackModel remains unchanged');

const noBufferEntry: EditHistoryEntry = { ...entry, audioBuffer: undefined, analysis: undefined };
let renderCalls = 0;
let analyzeCalls = 0;
const fallback = restoreEditHistoryEntry(track, noBufferEntry, {
  renderWorkingAudio: () => {
    renderCalls++;
    return workingBuffer;
  },
  analyzeAudioBuffer: () => {
    analyzeCalls++;
    return makeAnalysis(0.9);
  },
});
assert.equal(renderCalls, 1, 'missing PCM snapshot is re-rendered from immutable source plus segments');
assert.equal(analyzeCalls, 1, 're-rendered audio is analyzed once');
assert.equal(fallback.audioBuffer, workingBuffer);
assert.equal(fallback.track.duration, workingBuffer.duration);

let history = EMPTY_EDIT_HISTORY;
for (let index = 0; index < MAX_EDIT_HISTORY_STEPS + 5; index++) {
  history = editHistoryReducer(history, { type: 'PUSH', entry: { ...entry, description: `edit-${index}` } });
}
assert.equal(history.undoStack.length, MAX_EDIT_HISTORY_STEPS, 'undo depth is exactly bounded');
assert.equal(history.redoStack.length, 0, 'new edits clear redo history');
const undoTarget = history.undoStack.at(-1)!;
history = editHistoryReducer(history, { type: 'UNDO', trackId: entry.trackId, current: { ...entry, description: 'current-before-undo' } });
assert.equal(history.undoStack.length, MAX_EDIT_HISTORY_STEPS - 1);
assert.equal(history.redoStack.at(-1)?.description, 'current-before-undo');
history = editHistoryReducer(history, { type: 'REDO', trackId: entry.trackId, current: { ...entry, description: 'current-before-redo' } });
assert.equal(history.undoStack.at(-1)?.description, 'current-before-redo');
assert.equal(history.redoStack.length, 0);
assert.ok(undoTarget.description.startsWith('edit-'));

let perTrackHistory = EMPTY_EDIT_HISTORY;
const otherTrackEntry = { ...entry, trackId: 'other-track', description: 'other-track edit' };
perTrackHistory = editHistoryReducer(perTrackHistory, { type: 'PUSH', entry });
perTrackHistory = editHistoryReducer(perTrackHistory, {
  type: 'UNDO',
  trackId: entry.trackId,
  current: { ...entry, description: 'track-before-undo' },
});
perTrackHistory = editHistoryReducer(perTrackHistory, { type: 'PUSH', entry: otherTrackEntry });
assert.equal(perTrackHistory.redoStack.at(-1)?.trackId, entry.trackId, 'editing another track does not clear this track’s redo');
assert.equal(perTrackHistory.undoStack.at(-1)?.trackId, otherTrackEntry.trackId);
assert.equal(editHistoryReducer(history, { type: 'CLEAR' }), EMPTY_EDIT_HISTORY);

console.log('edit history: bounded stacks, metadata snapshots, shared immutable PCM, causal restore ✔');
