/**
 * @license
 * Test suite for Rekordbox Track Matching & Harmonic Compatibility Engine
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  areTracksMatched,
  toggleTrackMatch,
  getMatchedTrackIds,
  setMatchNote,
  getMatchNote,
  calculateHarmonicCompatibility,
  isBpmCompatible,
  hasTrackMatches,
  filterTracksWithMatches,
  filterTracksMatchedWith,
  saveStoredMatches,
} from '../src/rekordbox/trackMatching';
import { TrackModel, DataOrigin } from '../src/types/rekordbox';

describe('Rekordbox Track Matching & Harmonic Engine', () => {
  beforeEach(() => {
    saveStoredMatches({});
  });

  it('correctly manages bidirectional track matching', () => {
    assert.equal(areTracksMatched('101', '202'), false);

    // Link 101 <-> 202
    const linked = toggleTrackMatch('101', '202', 'Cue B Drop Transition');
    assert.equal(linked, true);

    // Both directions should be recognized
    assert.equal(areTracksMatched('101', '202'), true);
    assert.equal(areTracksMatched('202', '101'), true);

    assert.ok(getMatchedTrackIds('101').includes('202'));
    assert.ok(getMatchedTrackIds('202').includes('101'));

    // Check transition note
    assert.equal(getMatchNote('101', '202'), 'Cue B Drop Transition');
    assert.equal(getMatchNote('202', '101'), 'Cue B Drop Transition');

    // Update note
    setMatchNote('101', '202', 'Updated Note: 16 Bars Mix');
    assert.equal(getMatchNote('101', '202'), 'Updated Note: 16 Bars Mix');

    // Toggle off (unlink)
    const unlinked = toggleTrackMatch('101', '202');
    assert.equal(unlinked, false);
    assert.equal(areTracksMatched('101', '202'), false);
    assert.equal(areTracksMatched('202', '101'), false);
  });

  it('calculates harmonic compatibility with Camelot traffic light accurately', () => {
    // Exact match (8A <-> 8A)
    const exact = calculateHarmonicCompatibility('8A', '8A');
    assert.equal(exact.compatible, true);
    assert.equal(exact.type, 'EXACT');
    assert.equal(exact.score, 100);

    // Relative Major/Minor (8A <-> 8B)
    const relative = calculateHarmonicCompatibility('8A', '8B');
    assert.equal(relative.compatible, true);
    assert.equal(relative.type, 'RELATIVE');
    assert.ok(relative.score >= 90);

    // Adjacent (+1: 8A <-> 9A)
    const adjacentUp = calculateHarmonicCompatibility('8A', '9A');
    assert.equal(adjacentUp.compatible, true);
    assert.equal(adjacentUp.type, 'ADJACENT');

    // Adjacent (-1: 8A <-> 7A)
    const adjacentDown = calculateHarmonicCompatibility('8A', '7A');
    assert.equal(adjacentDown.compatible, true);
    assert.equal(adjacentDown.type, 'ADJACENT');

    // Wrap around (12A <-> 1A)
    const wrap = calculateHarmonicCompatibility('12A', '1A');
    assert.equal(wrap.compatible, true);
    assert.equal(wrap.type, 'ADJACENT');

    // Energy Boost (+2: 8A <-> 10A)
    const boost = calculateHarmonicCompatibility('8A', '10A');
    assert.equal(boost.compatible, true);
    assert.equal(boost.type, 'ENERGY_BOOST');

    // Dissonant clash (e.g. 8A <-> 4A)
    const dissonant = calculateHarmonicCompatibility('8A', '4A');
    assert.equal(dissonant.compatible, false);
    assert.equal(dissonant.type, 'DISSONANT');
  });

  it('evaluates BPM compatibility including half-time and double-time', () => {
    // Exact BPM
    const exact = isBpmCompatible(128.0, 128.0);
    assert.equal(exact.compatible, true);
    assert.equal(exact.relation, 'EXACT');

    // Near BPM (128 vs 130 is within 2%)
    const near = isBpmCompatible(128.0, 130.0, 6);
    assert.equal(near.compatible, true);
    assert.equal(near.relation, 'NEAR');

    // Half-time (e.g. 140 BPM Dubstep vs 70 BPM Trap)
    const half = isBpmCompatible(140.0, 70.0, 6);
    assert.equal(half.compatible, true);
    assert.equal(half.relation, 'HALF_TIME');

    // Double-time (e.g. 87 BPM Half-time vs 174 BPM Drum & Bass)
    const doubleTime = isBpmCompatible(87.0, 174.0, 6);
    assert.equal(doubleTime.compatible, true);
    assert.equal(doubleTime.relation, 'DOUBLE_TIME');

    // Far off BPM (120 vs 150)
    const off = isBpmCompatible(120.0, 150.0, 6);
    assert.equal(off.compatible, false);
    assert.equal(off.relation, 'OFF');
  });

  it('filters collections based on Rekordbox track matches', () => {
    const mockTracks: TrackModel[] = [
      {
        id: '1',
        title: 'Track A',
        artist: 'Artist A',
        album: 'Album',
        bpm: 128,
        key: '8A',
        duration: 300,
        sampleRate: 44100,
        channels: 2,
        originalSha256: 'sha1',
        isOriginalUntouched: true,
        audioBuffer: null,
        beatGrid: { firstBeat: 0, bpm: 128, meter: 4, origin: DataOrigin.REKORDBOX_XML, beats: [] },
        cues: [],
        loops: [],
        analysis: null,
        origin: DataOrigin.REKORDBOX_XML,
        workingSegments: [],
      },
      {
        id: '2',
        title: 'Track B',
        artist: 'Artist B',
        album: 'Album',
        bpm: 128,
        key: '8A',
        duration: 300,
        sampleRate: 44100,
        channels: 2,
        originalSha256: 'sha2',
        isOriginalUntouched: true,
        audioBuffer: null,
        beatGrid: { firstBeat: 0, bpm: 128, meter: 4, origin: DataOrigin.REKORDBOX_XML, beats: [] },
        cues: [],
        loops: [],
        analysis: null,
        origin: DataOrigin.REKORDBOX_XML,
        workingSegments: [],
      },
      {
        id: '3',
        title: 'Track C',
        artist: 'Artist C',
        album: 'Album',
        bpm: 130,
        key: '9A',
        duration: 300,
        sampleRate: 44100,
        channels: 2,
        originalSha256: 'sha3',
        isOriginalUntouched: true,
        audioBuffer: null,
        beatGrid: { firstBeat: 0, bpm: 130, meter: 4, origin: DataOrigin.REKORDBOX_XML, beats: [] },
        cues: [],
        loops: [],
        analysis: null,
        origin: DataOrigin.REKORDBOX_XML,
        workingSegments: [],
      },
    ];

    // Initially no matches
    assert.equal(filterTracksWithMatches(mockTracks).length, 0);

    // Link Track 1 and Track 3
    toggleTrackMatch('1', '3');

    const matched = filterTracksWithMatches(mockTracks);
    assert.equal(matched.length, 2);
    const ids = matched.map((t) => t.id);
    assert.ok(ids.includes('1'));
    assert.ok(ids.includes('3'));

    // Filter matches specifically for Track 1
    const matchesForTrack1 = filterTracksMatchedWith('1', mockTracks);
    assert.equal(matchesForTrack1.length, 1);
    assert.equal(matchesForTrack1[0].id, '3');

    // Check hasTrackMatches
    assert.equal(hasTrackMatches(mockTracks[0]), true);
    assert.equal(hasTrackMatches(mockTracks[1]), false);
  });
});
