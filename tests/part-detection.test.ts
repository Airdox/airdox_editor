/** Standalone Track-Part-Detection regression check (dependency-free for tsx). */

import assert from 'node:assert/strict';
import { detectTrackParts } from '../src/audio/phraseDetection';
import { generateAutoCuesForTrack } from '../src/audio/mixAnalysis';
import { TrackModel, DataOrigin, WaveformAnalysisData } from '../src/types/rekordbox';

// ---------------------------------------------------------------------------
// Build a synthetic 128 BPM track (secPerBar = 1.875s) with a classic club
// arrangement encoded directly in the analysis buckets:
//   Bars  1-16 : quiet intro           (low bass, low energy)
//   Bars 17-32 : build-up              (rising energy & highs)
//   Bars 33-64 : drop                  (full bass, full energy)
//   Bars 65-80 : breakdown             (bass drops out)
//   Bars 81-112: second drop           (full bass again)
//   Bars 113-128: outro                (fading energy)
// ---------------------------------------------------------------------------

const BPM = 128;
const SEC_PER_BAR = (60 / BPM) * 4; // 1.875 s
const TOTAL_BARS = 128;
const DURATION = TOTAL_BARS * SEC_PER_BAR; // 240 s
const BUCKETS_PER_SEC = 40;
const BUCKETS = Math.floor(DURATION * BUCKETS_PER_SEC);

const peaks = new Float32Array(BUCKETS);
const lowEnergy = new Float32Array(BUCKETS);
const midEnergy = new Float32Array(BUCKETS);
const highEnergy = new Float32Array(BUCKETS);

for (let k = 0; k < BUCKETS; k++) {
  const t = k / BUCKETS_PER_SEC;
  const bar = Math.floor(t / SEC_PER_BAR) + 1;

  let peak = 0.2;
  let low = 0.1;
  let mid = 0.3;
  let high = 0.2;

  if (bar <= 16) {
    peak = 0.25; low = 0.08; mid = 0.3; high = 0.15; // Intro
  } else if (bar <= 32) {
    const p = (bar - 17) / 15; // Build-up: rising
    peak = 0.4 + p * 0.3; low = 0.3; mid = 0.5; high = 0.3 + p * 0.6;
  } else if (bar <= 64) {
    peak = 0.95; low = 0.95; mid = 0.7; high = 0.6; // Drop
  } else if (bar <= 80) {
    peak = 0.45; low = 0.08; mid = 0.6; high = 0.4; // Breakdown (no bass)
  } else if (bar <= 112) {
    peak = 0.95; low = 0.95; mid = 0.7; high = 0.6; // Drop 2
  } else {
    peak = 0.3; low = 0.2; mid = 0.3; high = 0.2; // Outro
  }

  peaks[k] = peak;
  lowEnergy[k] = low;
  midEnergy[k] = mid;
  highEnergy[k] = high;
}

const analysis: WaveformAnalysisData = {
  length: BUCKETS,
  peaks,
  peaksL: peaks,
  peaksR: peaks,
  lowEnergy,
  midEnergy,
  highEnergy,
  origin: DataOrigin.LOCAL_ANALYSIS,
  secPerBucket: 1 / BUCKETS_PER_SEC,
};

const track = {
  id: 'part-test',
  title: 'Part Detection Fixture',
  duration: DURATION,
  bpm: BPM,
  beatGrid: { firstBeat: 0, bpm: BPM, meter: 4, beats: [], origin: DataOrigin.LOCAL_ANALYSIS },
  analysis,
  cues: [],
  loops: [],
} as unknown as TrackModel;

// 1. Detection returns sections covering the full track
const parts = detectTrackParts(track);
assert.ok(parts && parts.length >= 4, 'at least intro/build/drop/break sections are detected');
assert.equal(parts![0].startBar, 1, 'first part starts at bar 1');
assert.ok(Math.abs(parts![parts!.length - 1].endTime - DURATION) < 0.001, 'last part ends at track end');

// 2. Section boundaries sit on the beatgrid (bar starts)
parts!.forEach((p) => {
  const barTime = (p.startBar - 1) * SEC_PER_BAR;
  assert.ok(Math.abs(p.startTime - barTime) < 0.001, `part ${p.name} starts exactly on a bar line`);
});

// 3. Musical roles are recognised from the energy profile
const names = parts!.map((p) => p.name);
assert.equal(names[0], 'INTRO', 'quiet opening is classified as INTRO');
assert.ok(names.includes('DROP'), 'high-bass/high-energy region is classified as DROP');
assert.ok(names.includes('BREAKDOWN'), 'bass-less mid-track region is classified as BREAKDOWN');
assert.ok(names.includes('UP'), 'rising-energy region before the drop is classified as UP (build)');

// The detected drop must start near bar 33 (block granularity = 4 bars)
const drop = parts!.find((p) => p.name === 'DROP')!;
assert.ok(Math.abs(drop.startBar - 33) <= 4, `drop starts near bar 33 (got ${drop.startBar})`);

// 4. Detected parts carry LOCAL_ANALYSIS origin (never invented fallback)
parts!.forEach((p) => assert.equal(p.origin, DataOrigin.LOCAL_ANALYSIS, 'parts are labeled LOCAL_ANALYSIS'));

// 5. Auto-cues land on the prominent part boundaries
const cues = generateAutoCuesForTrack({ ...track, phrases: parts! } as TrackModel);
assert.ok(cues.length >= 2, 'cue points are generated for prominent sections');
const dropCue = cues.find((c) => c.name.startsWith('DROP') && c.type === 'HOT_CUE');
assert.ok(dropCue, 'a hot cue is placed at the drop');
assert.ok(Math.abs(dropCue!.position - drop.startTime) < 0.001, 'drop cue sits exactly on the part boundary');

// 6. No analysis data -> no invented parts
const noAnalysis = detectTrackParts({ ...track, analysis: null } as TrackModel);
assert.equal(noAnalysis, null, 'without waveform analysis no parts are invented');

console.log(`part detection: ${parts!.length} parts [${names.join(', ')}], ${cues.length} auto-cues – all checks OK`);
