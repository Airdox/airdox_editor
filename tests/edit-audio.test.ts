/**
 * @license
 * Projected audio rendering tests (Phase 6): the working buffer always follows
 * the SAME span list that the waveform compositor uses.
 *
 * Run with: npx tsx tests/edit-audio.test.ts
 */

import { EditSegment } from '../src/types/rekordbox';
import { projectEditTimeline } from '../src/edit/editTimeline';
import { ChannelSource, renderProjectedChannels } from '../src/edit/projectedAudio';

import { runTest, assert, near, report } from './helpers/microTest.mjs';
const SR = 1000;

function buf(values: Float32Array, channels = 2): ChannelSource {
  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) data.push(ch === 0 ? values : values.map((v) => v));
  return {
    sampleRate: SR,
    numberOfChannels: channels,
    length: values.length,
    getChannelData: (ch: number) => data[Math.min(ch, channels - 1)],
  };
}

function seg(partial: Partial<EditSegment> & { id: string; type: EditSegment['type'] }): EditSegment {
  return {
    trackId: 'deck',
    sourceStart: 0,
    sourceEnd: 0,
    projectStart: 0,
    projectDuration: 0,
    gain: 1,
    ...partial,
  } as EditSegment;
}

const baseSeg = seg({ id: 'orig', type: 'ORIGINAL', sourceEnd: 1, projectDuration: 1 });

runTest('audio', 'A1 clip material is played from its buffer with the segment gain', () => {
  const clip = buf(new Float32Array(100).fill(0.2));
  const timeline = projectEditTimeline({
    segments: [baseSeg, seg({ id: 'i', type: 'INSERT', projectStart: 0.2, projectDuration: 0.1, clipId: 'c', gain: 0.5 })],
    sourceDuration: 1,
  });
  const original = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) original[i] = i / 1000;
  const out = renderProjectedChannels({
    timeline,
    sampleRate: SR,
    channels: 2,
    original: buf(original),
    clipOf: () => clip,
  });
  near(out.channelData[0][200], 0.1, 'clip sample scaled by the 0.5 gain');
  near(out.channelData[0][100], 0.1, 'original material before the insert keeps its position');
  near(out.channelData[0][300], 0.2, 'material after the insert kept ITS content and moved right');
  near(out.channelData[0][199], 0.199, 'the last sample before the insert keeps its position');
  assert(out.clipSpans === 1 && out.originalSpans === 2, 'one clip span, original split in two');
});

runTest('audio', 'A2 overdub mixes on top without replacing the base', () => {
  const clip = buf(new Float32Array(100).fill(0.4));
  const timeline = projectEditTimeline({
    segments: [baseSeg, seg({ id: 'o', type: 'OVERDUB', projectStart: 0.1, projectDuration: 0.1, clipId: 'c', gain: 1 })],
    sourceDuration: 1,
  });
  const out = renderProjectedChannels({
    timeline,
    sampleRate: SR,
    channels: 1,
    original: buf(new Float32Array(1000).fill(0.3), 1),
    clipOf: () => clip,
  });
  assert(out.overlaysMixed === 1, 'overlay counted');
  assert(out.channelData[0][100] > 0.3, 'the mix is louder than the base alone');
  near(out.channelData[0][0], 0.3, 'outside the overlay nothing changed');
});

runTest('audio', 'A3 missing clip audio leaves silence and is reported, never faked', () => {
  const timeline = projectEditTimeline({
    segments: [baseSeg, seg({ id: 'i', type: 'INSERT', projectStart: 0.5, projectDuration: 0.2, clipId: 'gone' })],
    sourceDuration: 1,
  });
  const out = renderProjectedChannels({
    timeline,
    sampleRate: SR,
    channels: 1,
    original: buf(new Float32Array(1000).fill(0.7), 1),
    clipOf: () => null,
  });
  assert(out.unresolvedSpans === 1, 'the span without audio is counted as unresolved');
  assert(out.channelData[0][600] === 0, 'unresolved material is silence, not leftover audio');
  near(out.channelData[0][800], 0.7, 'the following original material still plays (shifted)');
  near(out.length, 1200, 'project length grew by the inserted clip');
});

runTest('audio', 'A4 a missing original leaves the original spans silent', () => {
  const timeline = projectEditTimeline({ segments: [baseSeg], sourceDuration: 1 });
  const out = renderProjectedChannels({ timeline, sampleRate: SR, channels: 2, original: null, clipOf: () => null });
  assert(out.unresolvedSpans === 1, 'unresolved original span reported');
  assert(out.channelData[0].every((v) => v === 0), 'no audio, no invented waveform either');
});

runTest('audio', 'A5 clear keeps length but zeroes the window', () => {
  const timeline = projectEditTimeline({
    segments: [baseSeg, seg({ id: 'c', type: 'CLEAR', projectStart: 0.25, projectDuration: 0.1 })],
    sourceDuration: 1,
  });
  const out = renderProjectedChannels({
    timeline,
    sampleRate: SR,
    channels: 1,
    original: buf(new Float32Array(1000).fill(0.9), 1),
    clipOf: () => null,
  });
  near(out.length, 1000, 'length preserved');
  assert(out.channelData[0][250] === 0 && out.channelData[0][349] === 0, 'window silenced exactly');
  near(out.channelData[0][350], 0.9, 'audio continues right after the window');
  assert(out.silenceSpans === 1, 'silence span counted');
});

runTest('audio', 'A6 pasting a sub-range reads the clip buffer at its offset', () => {
  const values = new Float32Array(300);
  for (let i = 0; i < 300; i++) values[i] = i;
  const timeline = projectEditTimeline({
    segments: [baseSeg, seg({ id: 'p', type: 'INSERT', projectStart: 0, projectDuration: 0.1, sourceStart: 0.2, clipId: 'c' })],
    sourceDuration: 1,
  });
  const out = renderProjectedChannels({
    timeline,
    sampleRate: SR,
    channels: 1,
    original: buf(new Float32Array(1000).fill(-1), 1),
    clipOf: () => buf(values, 1),
  });
  near(out.channelData[0][0], 200, 'clip playback starts at its sourceStart');
  near(out.channelData[0][99], 299, 'and covers exactly the pasted length');
  near(out.channelData[0][100], -1, 'the original material follows the pasted clip');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────

report('EDIT-AUDIO SUITE');
