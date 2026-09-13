/**
 * @license
 * Test suite for AI Copilot Pop-up Window & Harmonic Mix-In Intelligence
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCamelotInfo, analyzeTrackForMixIn } from '../src/audio/mixAnalysis';
import { TrackModel, DataOrigin } from '../src/types/rekordbox';

describe('AI Copilot Pop-up Intelligence & Camelot Matrix', () => {
  it('resolves Camelot harmonic key and calculates 5 harmonic transitions', () => {
    // Test 8A (A minor)
    const info8A = getCamelotInfo('8A');
    assert.equal(info8A.code, '8A');
    assert.equal(info8A.isMinor, true);
    assert.equal(info8A.matches.length, 5);

    const exact = info8A.matches.find((m) => m.type === 'EXACT');
    assert.ok(exact);
    assert.equal(exact.code, '8A');

    const relative = info8A.matches.find((m) => m.type === 'RELATIVE');
    assert.ok(relative);
    assert.equal(relative.code, '8B'); // C Major

    const energyUp = info8A.matches.find((m) => m.type === 'ENERGY_UP');
    assert.ok(energyUp);
    assert.equal(energyUp.code, '9A'); // E minor (+1)

    const energyDown = info8A.matches.find((m) => m.type === 'ENERGY_DOWN');
    assert.ok(energyDown);
    assert.equal(energyDown.code, '7A'); // D minor (-1)

    const powerBoost = info8A.matches.find((m) => m.type === 'POWER_BOOST');
    assert.ok(powerBoost);
    assert.equal(powerBoost.code, '10A'); // B minor (+2)
  });

  it('handles standard musical keys like "Am" and maps to Camelot 8A', () => {
    const infoAm = getCamelotInfo('Am');
    assert.equal(infoAm.code, '8A');
    assert.equal(infoAm.isMinor, true);

    const infoC = getCamelotInfo('C');
    assert.equal(infoC.code, '8B');
    assert.equal(infoC.isMinor, false);
  });

  it('analyzes track and extracts optimal mix-in candidates with phrase energy', () => {
    const mockTrack: TrackModel = {
      id: 'test-track-1',
      title: 'Festival Banger',
      artist: 'DJ Producer',
      album: 'Club Hits Vol. 1',
      bpm: 128.0,
      duration: 240.0,
      sampleRate: 44100,
      channels: 2,
      originalSha256: 'test-mock-sha256',
      isOriginalUntouched: true,
      audioBuffer: null,
      loops: [],
      analysis: null,
      key: '8A',
      beatGrid: {
        firstBeat: 0.0,
        bpm: 128.0,
        meter: 4,
        beats: [],
        origin: DataOrigin.REKORDBOX_XML,
      },
      cues: [],
      workingSegments: [],
      origin: DataOrigin.REKORDBOX_XML,
    };

    const report = analyzeTrackForMixIn(mockTrack);
    assert.equal(report.trackId, 'test-track-1');
    assert.equal(report.bpm, 128.0);
    assert.ok(report.optimalPoint, 'Should contain an optimal point candidate');
    assert.ok(report.allCandidates.length >= 1, 'Should contain multiple mix-in candidates');
    assert.ok(report.phraseEnergies.length > 0, 'Should contain phrase energy summaries');
    assert.ok(report.djStrategyAdvice.length > 0, 'Should contain DJ strategy guidance');

    // Primary point should have a high score
    assert.ok(report.optimalPoint.recommendationScore >= 80);
    assert.ok(report.optimalPoint.barNumber >= 1);
  });
});
