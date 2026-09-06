/**
 * Regression tests for the waveform time base.
 *
 * Symptom this guards against: the waveform lines up with the audio and the
 * beat grid at the start of a track and drifts further and further apart
 * towards the end.
 *
 * Cause: `samplesPerBucket` was floored before the time base was derived from
 * it. The renderer places bucket b at `b * secPerBucket`, so a stride that is
 * a fraction of a sample too short accumulates across tens of thousands of
 * buckets. At 44.1 kHz the exact stride is 220.5 samples; flooring to 220
 * loses half a sample per bucket, roughly 0.8 s by the end of a six minute
 * track. At 48 kHz the stride is a whole number, so the bug is invisible —
 * which is why it can survive a long time unnoticed.
 */

import { analyzeAudioBuffer } from '../src/waveform/analyzer';
import { DataOrigin } from '../src/types/rekordbox';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

/** Minimal AudioBuffer stand-in; the analyzer only reads these members. */
function fakeBuffer(sampleRate: number, seconds: number, channels = 2): any {
  const length = Math.floor(sampleRate * seconds);
  const data = new Float32Array(length);
  // A click every second gives us known landmarks to locate afterwards.
  for (let s = 0; s < seconds; s++) {
    const idx = Math.floor(s * sampleRate);
    if (idx < length) data[idx] = 1.0;
  }
  return {
    sampleRate,
    length,
    numberOfChannels: channels,
    duration: length / sampleRate,
    getChannelData: () => data,
  };
}

console.log('Testing waveform time base...');

// ---------------------------------------------------------------------------
// 1. The time base must span the whole track, at any sample rate
// ---------------------------------------------------------------------------
for (const sampleRate of [44100, 48000, 32000, 22050, 96000]) {
  const seconds = 360; // six minutes
  const buffer = fakeBuffer(sampleRate, seconds);
  const analysis = analyzeAudioBuffer(buffer, DataOrigin.LOCAL_ANALYSIS);

  assert(analysis.secPerBucket !== undefined, 'secPerBucket must be reported');

  // Where the renderer draws the final bucket vs. where it really sits.
  const drawnEnd = (analysis.length - 1) * analysis.secPerBucket!;
  const trueEnd = buffer.duration * ((analysis.length - 1) / analysis.length);
  const drift = Math.abs(trueEnd - drawnEnd);

  assert(
    drift < 0.001,
    `${sampleRate} Hz: waveform end drifts by ${drift.toFixed(4)}s (must stay below 1 ms)`
  );

  // The covered span must match the track duration.
  const covered = analysis.length * analysis.secPerBucket!;
  assert(
    Math.abs(covered - buffer.duration) < 0.001,
    `${sampleRate} Hz: buckets cover ${covered.toFixed(3)}s of a ${buffer.duration}s track`
  );
}

// ---------------------------------------------------------------------------
// 2. 44.1 kHz specifically — this is the case that used to break
// ---------------------------------------------------------------------------
{
  const buffer = fakeBuffer(44100, 360);
  const analysis = analyzeAudioBuffer(buffer, DataOrigin.LOCAL_ANALYSIS);

  // The old implementation produced exactly 220/44100 here.
  const flooredTimeBase = 220 / 44100;
  assert(
    Math.abs(analysis.secPerBucket! - flooredTimeBase) > 1e-9,
    'time base must not be the floored 220-sample stride'
  );

  const exact = 220.5 / 44100;
  assert(
    Math.abs(analysis.secPerBucket! - exact) < 1e-9,
    `expected the exact 220.5-sample stride, got ${analysis.secPerBucket! * 44100} samples`
  );

  // Demonstrate the magnitude of the old error for the record.
  const oldDrift = (analysis.length - 1) * (exact - flooredTimeBase);
  console.log(`  legacy floored stride would drift ${oldDrift.toFixed(3)}s over 6 minutes`);
  assert(oldDrift > 0.5, 'sanity: the old bug really was this large');
}

// ---------------------------------------------------------------------------
// 3. Landmarks must land in the bucket the renderer draws them in
// ---------------------------------------------------------------------------
{
  const sampleRate = 44100;
  const seconds = 300;
  const buffer = fakeBuffer(sampleRate, seconds);
  const analysis = analyzeAudioBuffer(buffer, DataOrigin.LOCAL_ANALYSIS);

  // Check clicks late in the track, where any drift is largest.
  for (const second of [60, 150, 240, 299]) {
    const bucket = Math.floor(second / analysis.secPerBucket!);

    // The click must be in that bucket or an immediate neighbour.
    let found = -1;
    for (let b = bucket - 2; b <= bucket + 2; b++) {
      if (b >= 0 && b < analysis.length && analysis.peaks[b] > 0.5) {
        found = b;
        break;
      }
    }

    assert(
      found >= 0,
      `click at ${second}s not found near bucket ${bucket} (drift in the time base)`
    );
    const offBy = Math.abs(found - bucket) * analysis.secPerBucket!;
    assert(
      offBy < 0.02,
      `click at ${second}s is ${offBy.toFixed(4)}s away from where it is drawn`
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Buckets must tile the audio without gaps or overlap
// ---------------------------------------------------------------------------
{
  const buffer = fakeBuffer(44100, 30);
  const analysis = analyzeAudioBuffer(buffer, DataOrigin.LOCAL_ANALYSIS);

  assert(analysis.length > 0, 'analysis must produce buckets');
  assert(
    analysis.peaks.length === analysis.length &&
      analysis.lowEnergy.length === analysis.length,
    'all band arrays must have the same length'
  );

  // Every one-second click must be represented somewhere.
  let clicks = 0;
  for (let b = 0; b < analysis.length; b++) {
    if (analysis.peaks[b] > 0.5) clicks += 1;
  }
  assert(clicks >= 29, `expected ~30 clicks to survive bucketing, found ${clicks}`);
}

console.log('✓ waveform time base tests passed');
