import assert from 'node:assert/strict';
import { applyStemMixDuringPlayback, StemPlaybackController } from '../src/audio/stemPlayback';
import { DEFAULT_STEMS_MIXER_STATE, StemsMixerState, TrackStems } from '../src/audio/stemEngine';
import { audioBufferFactory } from './support/editingHarness';

const buffer = audioBufferFactory(2, 44100 * 10, 44100);
const stems = {
  trackId: 'real-song', originalSha256: 'mix-only', duration: 10, sampleRate: 44100, channels: 2,
  vocals: buffer, drums: buffer, bass: buffer, other: buffer, separatedAt: Date.now(),
} as TrackStems;
const acapella: StemsMixerState = {
  vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals, solo: true },
  drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
  bass: { ...DEFAULT_STEMS_MIXER_STATE.bass },
  other: { ...DEFAULT_STEMS_MIXER_STATE.other },
};

const calls: Array<{ type: string; position?: number; mixer?: StemsMixerState }> = [];
const engine: StemPlaybackController = {
  getIsPlaying: () => true,
  getCurrentTime: () => 6.375,
  playWithStems: (_stems, mixer, position) => calls.push({ type: 'STEMS', position, mixer }),
  play: (_buffer, position) => calls.push({ type: 'MASTER', position }),
  updateStemMixer: (mixer) => calls.push({ type: 'GAIN_ONLY', mixer }),
};

// Reproduces the reported workflow: full master is running at a vocal passage,
// then the user presses Acapella without stopping playback.
applyStemMixDuringPlayback(engine, stems, buffer, acapella);
assert.equal(calls.length, 1);
assert.equal(calls[0].type, 'STEMS', 'Acapella must replace the running master source immediately');
assert.equal(calls[0].position, 6.375, 'source switch must preserve the exact playhead position');
assert.equal(calls[0].mixer?.vocals.solo, true);
assert.equal(calls[0].mixer?.drums.solo, false);

calls.length = 0;
const reset: StemsMixerState = {
  vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals }, drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
  bass: { ...DEFAULT_STEMS_MIXER_STATE.bass }, other: { ...DEFAULT_STEMS_MIXER_STATE.other },
};
applyStemMixDuringPlayback(engine, stems, buffer, reset);
assert.equal(calls[0].type, 'MASTER', 'Reset must return to the original master source immediately');
assert.equal(calls[0].position, 6.375);

console.log('live Acapella workflow: running master -> position-preserving vocal stem switch OK');
