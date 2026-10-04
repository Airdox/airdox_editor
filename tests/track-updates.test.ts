import assert from 'node:assert/strict';
import { applyExecutionToTrack, type EditExecutionResult } from '../src/audio/editingEngine';
import { updateTrackById } from '../src/state/trackUpdates';
import { DataOrigin, type TrackModel, type WaveformAnalysisData } from '../src/types/rekordbox';
import { makeAudioBuffer } from './support/editingHarness';

const analysis = (value: number) => ({
  peaks: new Float32Array([value]),
  lowEnergy: new Float32Array([value / 2]),
  secPerBucket: 1,
  length: 1,
  origin: DataOrigin.LOCAL_ANALYSIS,
}) as WaveformAnalysisData;

const oldCues = [{ id: 'cue-old', position: 0.25 }] as TrackModel['cues'];
const oldSegments = [{ id: 'segment-old', type: 'ORIGINAL' }] as TrackModel['workingSegments'];
const oldAnalysis = analysis(0.2);
const track = {
  id: 'track-a',
  duration: 1,
  cues: oldCues,
  workingSegments: oldSegments,
  analysis: oldAnalysis,
  loops: [],
  phrases: [],
  beatGrid: { bpm: 120, firstBeat: 0, beats: [] },
} as unknown as TrackModel;
const otherTrack = { ...track, id: 'track-b' };
const tracks = [track, otherTrack];

const newCues = [{ id: 'cue-new', position: 0.5 }] as TrackModel['cues'];
const newSegments = [{ id: 'segment-new', type: 'ORIGINAL' }] as TrackModel['workingSegments'];
const newAnalysis = analysis(0.8);
const newBuffer = makeAudioBuffer(new Float32Array([0, 1]), 2);
const execution: EditExecutionResult = {
  newBuffer,
  newCues,
  newSegments,
  newDuration: 1,
  newAnalysis,
  newLoops: [{ id: 'loop-new' }] as TrackModel['loops'],
  newPhrases: [{ id: 'phrase-new' }] as TrackModel['phrases'],
};

const updatedTrack = applyExecutionToTrack(track, execution);
assert.notEqual(updatedTrack, track, 'edit application creates a new TrackModel');
assert.equal(track.cues, oldCues, 'original cue array is unchanged');
assert.equal(track.workingSegments, oldSegments, 'original segment array is unchanged');
assert.equal(track.analysis, oldAnalysis, 'original analysis is unchanged');
assert.equal(track.duration, 1, 'original duration is unchanged');
assert.equal(updatedTrack.cues, newCues);
assert.equal(updatedTrack.workingSegments, newSegments);
assert.equal(updatedTrack.analysis, newAnalysis);
assert.equal(updatedTrack.duration, 1);
assert.equal(updatedTrack.loops, execution.newLoops);
assert.equal(updatedTrack.phrases, execution.newPhrases);

const updatedTracks = updateTrackById(tracks, 'track-a', () => updatedTrack);
assert.notEqual(updatedTracks, tracks, 'collection is copied on a changed track');
assert.equal(updatedTracks[0], updatedTrack, 'the selected track is replaced');
assert.equal(updatedTracks[1], otherTrack, 'unrelated track identity is preserved');
assert.equal(tracks[0], track, 'old collection remains unchanged');
assert.equal(updateTrackById(tracks, 'missing', () => updatedTrack), tracks, 'missing IDs preserve collection identity');
assert.equal(updateTrackById(tracks, 'track-a', (current) => current), tracks, 'no-op updates preserve collection identity');

console.log('track updates: edit commits are immutable and preserve unrelated track references ✔');
