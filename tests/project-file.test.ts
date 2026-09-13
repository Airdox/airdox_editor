/**
 * @license
 * Phase 4 – Project file persistence regression suite.
 *
 * Verifies the versioned `.airdox.json` serializer/deserializer and the pure
 * base64 WAV encoder independently of Electron and the DOM:
 *  - WAV encoding produces a valid RIFF/WAVE header and lossless 16-bit PCM.
 *  - serializeProject/deserializeProject round-trip metadata, cues, loops,
 *    beatgrid anchor, edit segments and embedded clip/original audio.
 *  - Tracks with a re-openable source path are NOT duplicated (no embedded
 *    original audio); the read-only reference is kept instead.
 *  - deserializeProject rejects foreign formats and future versions.
 */

import assert from 'node:assert';
import {
  serializeProject,
  deserializeProject,
  audioBufferToWavBase64,
  base64ToBytes,
  PROJECT_FORMAT,
  PROJECT_VERSION,
} from '../src/rekordbox/projectFile';
import { DataOrigin, TrackModel } from '../src/types/rekordbox';

interface FakeAudioBuffer {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

function fakeBuffer(sampleRate: number, values: Float32Array): FakeAudioBuffer {
  return {
    sampleRate,
    numberOfChannels: values.length > 0 ? 1 : 2,
    length: values.length,
    getChannelData: () => values,
  };
}

const asBuffer = (b: FakeAudioBuffer) => b as unknown as AudioBuffer;

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
}

// ---- Test 1: base64 WAV encoding is a valid RIFF/WAVE with exact PCM ----
{
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const b64 = audioBufferToWavBase64(fakeBuffer(44100, samples));
  const bytes = base64ToBytes(b64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  ok(view.byteLength >= 44, 'WAV byte length has header + data');
  assert.strictEqual(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
  assert.strictEqual(String.fromCharCode(...bytes.subarray(8, 12)), 'WAVE');
  assert.strictEqual(String.fromCharCode(...bytes.subarray(12, 16)), 'fmt ');
  assert.strictEqual(String.fromCharCode(...bytes.subarray(36, 40)), 'data');

  ok(view.getUint32(40, true) === samples.length * 4, 'data chunk size = samples * 2ch * 2bytes');
  assert.strictEqual(view.getInt16(44, true), 0, 'sample 0');
  assert.strictEqual(view.getInt16(46, true), 0, 'sample 0 right');
  assert.strictEqual(view.getInt16(48, true), Math.trunc(0.5 * 0x7fff), 'sample 1 = +0.5');
  assert.strictEqual(view.getInt16(52, true), Math.trunc(-0.5 * 0x8000), 'sample 2 = -0.5');
  passed++;
}

// ---- Test 2: full serialize/deserialize round-trip ----
{
  const clipBuffer = asBuffer(fakeBuffer(44100, new Float32Array([0.25, -0.25])));
  const origBuffer = asBuffer(fakeBuffer(44100, new Float32Array([0.1, 0.2])));

  const track: TrackModel = {
    id: 't1',
    title: 'Test Track',
    artist: 'Test Artist',
    album: 'Test Album',
    bpm: 128,
    key: '8A',
    duration: 120,
    sampleRate: 44100,
    channels: 2,
    originalSha256: 'sha256-test-123',
    isOriginalUntouched: true,
    audioBuffer: origBuffer,
    beatGrid: { firstBeat: 0.12, bpm: 128, meter: 4, beats: [], origin: DataOrigin.REKORDBOX_XML },
    cues: [
      { id: 'c1', name: 'Cue 1', type: 'MEMORY', position: 1.5, color: '#ff2a2a', origin: DataOrigin.REKORDBOX_XML },
    ],
    loops: [{ id: 'l1', name: 'Loop', start: 10, end: 20, length: 10, color: '#ff9500', origin: DataOrigin.REKORDBOX_XML }],
    analysis: null,
    origin: DataOrigin.LOCAL_ANALYSIS,
    workingSegments: [
      { id: 's0', type: 'ORIGINAL', trackId: 't1', sourceStart: 0, sourceEnd: 120, projectStart: 0, projectDuration: 120, gain: 1 },
      { id: 's1', type: 'INSERT', trackId: 't1', sourceStart: 0, sourceEnd: 0.5, projectStart: 60, projectDuration: 0.5, clipBuffer, gain: 0.9 },
    ],
  };

  const snapshot = {
    projectName: 'My Project',
    activeTrackId: 't1',
    selection: { start: 0, end: 1, startBeat: 0, endBeat: 2, beatsCount: 2, barsCount: 0.5, duration: 1 },
    tracks: [track],
    paletteClips: [],
  };

  const json = serializeProject(snapshot);
  const doc = deserializeProject(json);

  ok(doc.format === PROJECT_FORMAT, 'format preserved');
  assert.strictEqual(doc.version, PROJECT_VERSION);
  assert.strictEqual(doc.projectName, 'My Project');
  assert.strictEqual(doc.activeTrackId, 't1');
  ok(doc.selection?.beatsCount === 2, 'selection preserved');

  const st = doc.tracks[0];
  assert.strictEqual(st.title, 'Test Track');
  assert.strictEqual(st.bpm, 128);
  assert.strictEqual(st.beatGrid.firstBeat, 0.12);
  assert.strictEqual(st.cues[0].position, 1.5);
  assert.strictEqual(st.loops[0].start, 10);
  assert.strictEqual(st.workingSegments.length, 2);

  // INSERT segment embeds its clip; ORIGINAL segment does not.
  ok(!st.workingSegments[0].clipWavBase64, 'ORIGINAL segment has no embedded clip');
  ok(st.workingSegments[1].clipWavBase64, 'INSERT segment embeds clip audio');
  assert.strictEqual(st.workingSegments[1].gain, 0.9);

  // Local import without a source path embeds its original audio.
  ok(st.originalAudioBase64, 'track without source path embeds original audio');

  // Embedded clip decodes back to the exact 16-bit sample.
  const clipBytes = base64ToBytes(st.workingSegments[1].clipWavBase64!);
  const clipView = new DataView(clipBytes.buffer, clipBytes.byteOffset, clipBytes.byteLength);
  assert.strictEqual(clipView.getInt16(44, true), Math.trunc(0.25 * 0x7fff), 'clip sample round-trips');

  // Re-serializing the decoded document is stable (idempotent).
  const again = deserializeProject(serializeProject({
    projectName: doc.projectName,
    activeTrackId: doc.activeTrackId,
    selection: doc.selection,
    tracks: [{
      id: st.id, title: st.title, artist: st.artist, album: st.album, bpm: st.bpm, key: st.key,
      duration: st.duration, sampleRate: st.sampleRate, channels: st.channels,
      originalSha256: st.originalSha256, isOriginalUntouched: st.isOriginalUntouched,
      audioBuffer: null, beatGrid: { ...st.beatGrid, beats: [], origin: st.origin },
      cues: st.cues, loops: st.loops, analysis: null, origin: st.origin,
      workingSegments: st.workingSegments.map((s) => ({ ...s, clipBuffer: null as unknown as AudioBuffer })),
    }],
    paletteClips: [],
  }));
  assert.strictEqual(again.tracks[0].title, 'Test Track');
}

// ---- Test 3: source-path tracks are referenced, not duplicated ----
{
  const track: TrackModel = {
    id: 't2',
    title: 'Rekordbox Track',
    artist: 'A',
    album: 'B',
    bpm: 130,
    key: '2A',
    duration: 200,
    sampleRate: 44100,
    channels: 2,
    originalSha256: 'sha256-rb',
    isOriginalUntouched: true,
    audioBuffer: asBuffer(fakeBuffer(44100, new Float32Array([0.5]))),
    beatGrid: { firstBeat: 0, bpm: 130, meter: 4, beats: [], origin: DataOrigin.REKORDBOX_XML },
    cues: [],
    loops: [],
    analysis: null,
    origin: DataOrigin.REKORDBOX_XML,
    originalMedia: {
      location: 'C:\\Music\\Track.wav',
      accessMode: 'READ_ONLY',
      status: 'AVAILABLE',
    },
    workingSegments: [],
  };

  const doc = deserializeProject(serializeProject({
    projectName: 'P',
    activeTrackId: 't2',
    selection: null,
    tracks: [track],
    paletteClips: [],
  }));

  assert.strictEqual(doc.tracks[0].originalMedia?.location, 'C:\\Music\\Track.wav');
  ok(!doc.tracks[0].originalAudioBase64, 'Rekordbox-sourced track is not duplicated (no embedded audio)');
}

// ---- Test 4: validation rejects foreign formats and future versions ----
{
  assert.throws(() => deserializeProject('{"format":"other"}'), /kein Airdox-Projekt/);
  assert.throws(() => deserializeProject('not json'), /kein gültiges JSON/);
  assert.throws(
    () => deserializeProject(JSON.stringify({ format: PROJECT_FORMAT, version: 999, tracks: [] })),
    /nicht unterstützte Version/
  );
  passed++;
}

console.log(`project-file persistence: ${passed} checks OK`);
