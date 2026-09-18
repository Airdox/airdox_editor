/** Standalone Auto-Cue regression check (kept dependency-free for tsx). */

import assert from 'node:assert/strict';
import { generateAutoCuesForTrack } from '../src/audio/mixAnalysis';
import { TrackModel, DataOrigin } from '../src/types/rekordbox';

const mockTrack = {
  id: 'test',
  title: 'Test',
  duration: 300,
  bpm: 128,
  phrases: [
    { name: 'INTRO', startBar: 1, endBar: 17, startTime: 0, endTime: 30, color: '#000', origin: DataOrigin.USER_EDIT },
    { name: 'UP', startBar: 17, endBar: 33, startTime: 30, endTime: 60, color: '#000', origin: DataOrigin.USER_EDIT },
    { name: 'DROP', startBar: 33, endBar: 65, startTime: 60, endTime: 120, color: '#000', origin: DataOrigin.USER_EDIT },
    { name: 'BREAKDOWN', startBar: 65, endBar: 81, startTime: 120, endTime: 150, color: '#000', origin: DataOrigin.USER_EDIT },
  ],
} as unknown as TrackModel;

const cues = generateAutoCuesForTrack(mockTrack);
assert.equal(cues.length, 6, 'UP, DROP and BREAKDOWN generate one hot + one memory cue each');
const hotCues = cues.filter((cue) => cue.type === 'HOT_CUE');
assert.equal(hotCues.length, 3, 'three hot cues are generated');
assert.deepEqual(hotCues.map((cue) => cue.letter), ['A', 'B', 'C'], 'hot-cue letters remain sequential');
console.log('auto-cue generation: 3 checks OK');
