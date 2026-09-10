/**
 * @license
 * Mix Lab preview model tests (Stage 2 vertical slice):
 *
 * M1 – Crossfade curves: endpoints, monotonicity, continuity, equal-power
 *      identity, envelope sampling.
 * M2 – Beat-synchronized anchor: snaps to EXACT verbatim ANLZ beat times
 *      (BEAT / BAR), OFF keeps the position, tail-extended anchors are
 *      disclosed, uniform fallback only for node-less grids.
 * M3 – Drop target: B offset from B's first bar start, ghost region from
 *      verbatim B bar times, BPM drift note.
 * M4 – No synthesis: missing ANLZ waveform stays null + honest issue.
 * M5 – Immutability: inputs are never mutated by the preview model.
 * M6 – Clip range: sync offset outside a palette clip's span is clamped and
 *      disclosed.
 *
 * The preview model has no write path at all — these tests additionally
 * verify that no input is touched.
 *
 * Run with: npx tsx tests/mix-preview.test.ts
 */

import {
  BeatNode,
  DataOrigin,
  PaletteClip,
  TrackModel,
  WaveformAnalysisData,
} from '../src/types/rekordbox';
import {
  MixCurve,
  MixPreviewSettings,
  MixSlotRef,
  computeMixPreview,
  crossfadeGainsAt,
  describeDropTarget,
  sampleCrossfadeEnvelope,
} from '../src/mixlab/mixPreviewModel';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

function runTest(suite: string, name: string, testFn: () => void) {
  const t0 = performance.now();
  try {
    testFn();
    results.push({ suite, name, passed: true, durationMs: Math.round((performance.now() - t0) * 100) / 100 });
  } catch (err: any) {
    results.push({
      suite,
      name,
      passed: false,
      error: err?.message || String(err),
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
    });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

function assertClose(actual: number, expected: number, eps: number, message: string) {
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`Assertion Failed [${message}]: expected ${expected} ± ${eps}, got ${actual}`);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────
function node(time: number, beatInBar: number, barNumber: number, tailExtended = false): BeatNode {
  return { index: 0, time, isBarStart: beatInBar === 1, barNumber, beatInBar, tailExtended };
}

function waveform(len: number, sourceTag?: string): WaveformAnalysisData {
  const peaks = new Float32Array(len);
  for (let i = 0; i < len; i++) peaks[i] = 0.5 + 0.4 * Math.sin(i / 7);
  return {
    length: len,
    peaks,
    peaksL: peaks.slice(),
    peaksR: peaks.slice(),
    lowEnergy: new Float32Array(len),
    midEnergy: new Float32Array(len),
    highEnergy: new Float32Array(len),
    origin: DataOrigin.REKORDBOX_ANLZ,
    sourceTag,
  };
}

function makeTrack(overrides: Partial<TrackModel> = {}): TrackModel {
  return {
    id: 't1',
    title: 'Test Track',
    artist: 'Test Artist',
    album: '—',
    bpm: 130,
    key: '8A',
    duration: 10,
    sampleRate: 44100,
    channels: 2,
    originalSha256: 'test',
    isOriginalUntouched: true,
    audioBuffer: null,
    beatGrid: {
      firstBeat: 0.0,
      bpm: 130,
      meter: 4,
      origin: DataOrigin.REKORDBOX_ANLZ,
      beats: [],
    },
    cues: [],
    loops: [],
    analysis: null,
    origin: DataOrigin.REKORDBOX_ANLZ,
    workingSegments: [],
    ...overrides,
  };
}

/** A: non-uniform verbatim grid (firstBeat+bpm would NOT reproduce these times). */
const GRID_A: BeatNode[] = [
  node(0.0, 1, 1),
  node(0.44, 2, 1),
  node(0.96, 3, 1),
  node(1.41, 4, 1),
  node(1.85, 1, 2),
  node(2.3, 2, 2),
  node(2.77, 3, 2),
  node(3.22, 4, 2),
];

/** B: first node is NOT a bar start; bar starts at 1.48 (2.0 s offset case). */
const GRID_B_OFFSET: BeatNode[] = [
  { ...node(0.52, 2, 1), isBarStart: false },
  { ...node(1.0, 3, 1), isBarStart: false },
  { ...node(1.48, 1, 2), isBarStart: true },
  { ...node(1.96, 2, 2), isBarStart: false },
];

/** B: bar starts at 0 with verbatim spacing (for ghost region math). */
const GRID_B_FROM_ZERO: BeatNode[] = [
  node(0.0, 1, 1),
  node(0.4839, 2, 1),
  node(0.9677, 3, 1),
  node(1.4516, 4, 1),
  node(1.9355, 1, 2),
  node(2.4194, 2, 2),
  node(2.9032, 3, 2),
  node(3.3871, 4, 2),
  node(3.871, 1, 3),
  node(5.8065, 1, 4),
  node(7.742, 1, 5),
];

function trackA(withWaveform = true): TrackModel {
  return makeTrack({
    id: 'track-a',
    bpm: 130,
    duration: 10,
    beatGrid: { firstBeat: 0, bpm: 130, meter: 4, origin: DataOrigin.REKORDBOX_ANLZ, beats: GRID_A },
    analysis: withWaveform ? waveform(900, 'PWV5') : null,
    analysisVariants: withWaveform ? [waveform(900, 'PWV5')] : undefined,
  });
}

function trackB(beats: BeatNode[], withWaveform = true, overrides: Partial<TrackModel> = {}): TrackModel {
  return makeTrack({
    id: 'track-b',
    bpm: 124,
    key: '9A',
    duration: 30,
    beatGrid: { firstBeat: 0, bpm: 124, meter: 4, origin: DataOrigin.REKORDBOX_ANLZ, beats },
    analysis: withWaveform ? waveform(600, 'PWV3') : null,
    analysisVariants: withWaveform ? [waveform(600, 'PWV3')] : undefined,
    ...overrides,
  });
}

function makeClip(sourceTrackId: string, sourceStart: number, sourceEnd: number): PaletteClip {
  return {
    id: 'clip-1',
    name: 'Clip 1',
    sourceTrackId,
    sourceTrackName: 'Test Track B',
    sourceStart,
    sourceEnd,
    duration: sourceEnd - sourceStart,
    beats: 8,
    bars: 2,
    bpm: 124,
    key: '9A',
    color: '#ff0000',
    origin: DataOrigin.PROJECT,
  };
}

function settings(overrides: Partial<MixPreviewSettings> = {}): MixPreviewSettings {
  return {
    slotA: { kind: 'TRACK', trackId: 'track-a' } as MixSlotRef,
    slotB: { kind: 'TRACK', trackId: 'track-b' } as MixSlotRef,
    curve: 'EQUAL_POWER',
    crossfadeBeats: 4,
    beatSnap: 'BAR',
    transitionPosition: 1.0,
    ...overrides,
  };
}

const TRACKS = [trackA(), trackB(GRID_B_FROM_ZERO)];

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  MIX LAB PREVIEW MODEL TEST SUITE (M1–M6)                     ');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ─── M1: Crossfade curves ───────────────────────────────────────────────────
const ALL_CURVES: MixCurve[] = ['LINEAR', 'EQUAL_POWER', 'SLOW_IN_FAST_OUT', 'FAST_IN_SLOW_OUT'];

runTest('M1 curves', 'All curves satisfy the endpoint contract', () => {
  for (const curve of ALL_CURVES) {
    const g0 = crossfadeGainsAt(curve, 0);
    const g1 = crossfadeGainsAt(curve, 1);
    assertClose(g0.a, 1, 1e-12, `${curve} a(0)`);
    assertClose(g0.b, 0, 1e-12, `${curve} b(0)`);
    assertClose(g1.a, 0, 1e-12, `${curve} a(1)`);
    assertClose(g1.b, 1, 1e-12, `${curve} b(1)`);
  }
});

runTest('M1 curves', 'Gains stay in [0,1] and move monotonically', () => {
  for (const curve of ALL_CURVES) {
    let prevA = Infinity;
    let prevB = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const { a, b } = crossfadeGainsAt(curve, i / 200);
      assert(a >= 0 && a <= 1, `${curve} a in [0,1] at ${i}`);
      assert(b >= 0 && b <= 1, `${curve} b in [0,1] at ${i}`);
      assert(a <= prevA + 1e-12, `${curve} a non-increasing`);
      assert(b >= prevB - 1e-12, `${curve} b non-decreasing`);
      prevA = a;
      prevB = b;
    }
  }
});

runTest('M1 curves', 'Equal power keeps constant energy (a²+b² = 1)', () => {
  for (let i = 0; i <= 100; i++) {
    const { a, b } = crossfadeGainsAt('EQUAL_POWER', i / 100);
    assertClose(a * a + b * b, 1, 1e-9, `equal-power identity at ${i}`);
  }
});

runTest('M1 curves', 'Envelope sampling has stable endpoints and length', () => {
  const { a, b } = sampleCrossfadeEnvelope('EQUAL_POWER', 96);
  assertEqual(a.length, 97, 'Samples + 1 points');
  assertClose(a[0], 1, 1e-12, 'First A gain');
  assertClose(b[96], 1, 1e-12, 'Last B gain');
});

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`Assertion Failed [${message}]: expected ${expected}, got ${actual}`);
}

// ─── M2: Beat-synchronized anchor (verbatim times) ──────────────────────────
runTest('M2 snap', 'BAR snap lands exactly on the stored bar-start time', () => {
  const result = computeMixPreview(settings({ transitionPosition: 1.0, beatSnap: 'BAR' }), TRACKS, []);
  assert(result !== null, 'Preview computed');
  assertClose(result!.anchor.time, 1.85, 1e-9, 'Verbatim bar time 1.85 (not 1.84615… from bpm)');
  assertEqual(result!.anchor.barNumber, 2, 'Bar number from the node');
  assertEqual(result!.anchor.beatInBar, 1, 'Beat-in-bar from the node');
  assert(result!.anchor.snapped, 'Position was moved');
});

runTest('M2 snap', 'BEAT snap lands exactly on the stored beat time', () => {
  const result = computeMixPreview(settings({ transitionPosition: 1.0, beatSnap: 'BEAT' }), TRACKS, []);
  assertClose(result!.anchor.time, 1.41, 1e-9, 'Verbatim beat time 1.41');
  assertEqual(result!.anchor.barNumber, 1, 'Bar of the beat');
  assertEqual(result!.anchor.beatInBar, 4, 'Beat in bar');
});

runTest('M2 snap', 'OFF keeps the requested position', () => {
  const result = computeMixPreview(settings({ transitionPosition: 1.0, beatSnap: 'OFF' }), TRACKS, []);
  assertClose(result!.anchor.time, 1.0, 1e-9, 'Requested position unchanged');
  assert(!result!.anchor.snapped, 'Not flagged as snapped');
});

runTest('M2 snap', 'Anchor never leaves the track bounds', () => {
  const result = computeMixPreview(settings({ transitionPosition: 999, beatSnap: 'OFF' }), TRACKS, []);
  assert(result!.anchor.time <= trackA().duration, 'Clamped inside the track');
  assert(result!.anchor.time > 0, 'Positive');
});

runTest('M2 snap', 'Tail-extended anchors are disclosed, not hidden', () => {
  const tailGrid = [...GRID_A, { ...node(3.7, 1, 3), tailExtended: true }];
  const tracks = [trackA(), trackB(GRID_B_FROM_ZERO), trackA()];
  const tracksWithTail = tracks.map((t) =>
    t.id === 'track-a' ? { ...t, beatGrid: { ...t.beatGrid, beats: tailGrid } } : t
  );
  const result = computeMixPreview(settings({ transitionPosition: 3.4, beatSnap: 'BEAT' }), tracksWithTail, []);
  assert(result!.anchor.tailExtended, 'Tail flag reported');
  assert(result!.issues.some((i) => i.includes('Uniform-Fortsetzung')), 'Tail disclosed in issues');
});

runTest('M2 snap', 'Node-less grid uses the documented uniform fallback with disclosure', () => {
  const tracks = [
    { ...trackA(), beatGrid: { firstBeat: 0.1, bpm: 130, meter: 4, origin: DataOrigin.REKORDBOX_XML, beats: [] } },
    trackB(GRID_B_FROM_ZERO),
  ];
  const result = computeMixPreview(settings({ transitionPosition: 1.0, beatSnap: 'BAR' }), tracks, []);
  assert(result!.anchor.uniformFallback, 'Fallback reported');
  assert(result!.issues.some((i) => i.includes('Uniform-Grid')), 'Fallback disclosed in issues');
  const spb = 60 / 130;
  assertClose(result!.anchor.time, 0.1 + 4 * spb, 1e-9, 'First bar start at or after 1.0 s (bar 2, beat 4)');
});

// ─── M3: Drop target ────────────────────────────────────────────────────────
runTest('M3 drop', 'B offset = B first bar start; ghost uses verbatim B bars', () => {
  // B grid: first bar start at 1.48 → B starts 1.48 s before the anchor.
  const result = computeMixPreview(
    settings({ transitionPosition: 1.0, beatSnap: 'BAR', slotB: { kind: 'TRACK', trackId: 'track-b' } }),
    [trackA(), trackB(GRID_B_OFFSET)],
    []
  );
  assertClose(result!.drop.offsetIntoB, 1.48, 1e-9, 'Offset into B');
  assertClose(result!.drop.startOnMix, 1.85 - 1.48, 1e-9, 'B starts before the anchor');
  assertEqual(result!.drop.landsOnA?.barNumber, 2, 'Lands on A bar 2');
  assertEqual(result!.drop.ghostOnMix?.start, 1.85, 'Ghost starts at the anchor');
  assert(!result!.drop.clamped, 'No clamping for full tracks');
});

runTest('M3 drop', 'Ghost region spans 4 verbatim B bars (bar starts 0→7.742)', () => {
  const result = computeMixPreview(settings({ transitionPosition: 1.0 }), TRACKS, []);
  assertClose(result!.drop.offsetIntoB, 0.0, 1e-9, 'B grid starts with a bar start');
  assertClose(result!.drop.ghostOnMix?.end ?? 0, 1.85 + 7.742, 1e-9, 'Verbatim 4-bar span');
});

runTest('M3 drop', 'BPM drift is computed and disclosed only when meaningful', () => {
  const drift = computeMixPreview(settings({ transitionPosition: 1.0 }), TRACKS, []);
  assert(drift!.bpmDriftNote !== null, '128-ish vs 124: drift note present');
  assert(drift!.bpmDriftNote!.includes('Drift'), 'Note mentions drift');
  assert(drift!.bpmDriftNote!.includes('ohne Tempo-Anpassung'), 'Note states preview does not retime');

  const equal = computeMixPreview(
    settings({ transitionPosition: 1.0 }),
    [trackA(), trackB(GRID_B_FROM_ZERO, true, { bpm: 130 })],
    []
  );
  assertEqual(equal!.bpmDriftNote, null, 'No drift note when BPMs match');
});

runTest('M3 drop', 'Drop description is human readable and complete', () => {
  const result = computeMixPreview(settings({ transitionPosition: 1.0 }), TRACKS, []);
  const text = describeDropTarget(result!);
  assert(text.includes('B startet:'), 'Start line');
  assert(text.includes('Landung:'), 'Landing line');
  assert(text.includes('Crossfade:'), 'Crossfade line');
  assert(text.includes('BPM:'), 'BPM line');
});

// ─── M4: No synthesis ────────────────────────────────────────────────────────
runTest('M4 no-synth', 'Missing ANLZ waveform stays null with an honest issue', () => {
  const result = computeMixPreview(
    settings({ transitionPosition: 1.0 }),
    [trackA(false), trackB(GRID_B_FROM_ZERO, false)],
    []
  );
  assertEqual(result!.aWaveform, null, 'No waveform invented for A');
  assertEqual(result!.bWaveform, null, 'No waveform invented for B');
  assert(result!.issues.some((i) => i.includes('A: keine ANLZ-Waveform')), 'A issue present');
  assert(result!.issues.some((i) => i.includes('B: keine ANLZ-Waveform')), 'B issue present');
  assertEqual(result!.aProvenance.sourceTag, null, 'No fake provenance');
});

runTest('M4 no-synth', 'Genuine ANLZ variants are used with real provenance', () => {
  const result = computeMixPreview(settings({ transitionPosition: 1.0 }), TRACKS, []);
  assertEqual(result!.aProvenance.sourceTag, 'PWV5', 'A tag from the ANLZ variant');
  assertEqual(result!.bProvenance.sourceTag, 'PWV3', 'B tag from the ANLZ variant');
  assertEqual(result!.aProvenance.origin, DataOrigin.REKORDBOX_ANLZ, 'A origin');
});

// ─── M5: Immutability (no data is ever touched) ─────────────────────────────
runTest('M5 immutable', 'computeMixPreview never mutates tracks, clips, or settings', () => {
  const tracks = [trackA(), trackB(GRID_B_FROM_ZERO)];
  const clip = makeClip('track-b', 10, 30);
  const s = settings({ slotB: { kind: 'CLIP', trackId: 'track-b', clipId: 'clip-1' } });
  const before = JSON.stringify({ tracks, clips: [clip], s });
  const result = computeMixPreview(s, tracks, [clip]);
  assert(result !== null, 'Preview computed');
  const after = JSON.stringify({ tracks, clips: [clip], s });
  assertEqual(after, before, 'Inputs byte-identical after the preview run');
});

runTest('M5 immutable', 'Beat node objects keep their identity', () => {
  const track = trackA();
  const firstNode = track.beatGrid.beats[0];
  computeMixPreview(settings({ transitionPosition: 1.0 }), [track, trackB(GRID_B_FROM_ZERO)], []);
  assert(track.beatGrid.beats[0] === firstNode, 'Same object, untouched');
});

runTest('M5 immutable', 'Unknown slot references yield null, not a guess', () => {
  const result = computeMixPreview(settings({ slotA: { kind: 'TRACK', trackId: 'ghost' } }), TRACKS, []);
  assertEqual(result, null, 'No preview without both sources');
});

// ─── M6: Clip range ─────────────────────────────────────────────────────────
runTest('M6 clip', 'Sync offset outside the clip span is clamped and disclosed', () => {
  const clip = makeClip('track-b', 10, 30);
  const result = computeMixPreview(
    settings({
      transitionPosition: 1.0,
      beatSnap: 'BAR',
      slotB: { kind: 'CLIP', trackId: 'track-b', clipId: 'clip-1' },
    }),
    [trackA(), trackB(GRID_B_OFFSET)],
    [clip]
  );
  assertClose(result!.drop.offsetIntoB, 10, 1e-9, 'Clamped to the clip start');
  assert(result!.drop.clamped, 'Clamping flagged');
  assert(result!.issues.some((i) => i.includes('Clip') && i.includes('geclampt')), 'Clamping disclosed');
  assert(result!.issues.some((i) => i.includes('Palette-Clip')), 'Clip source disclosed');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────
console.log('Test Results:\n');
let passedCount = 0;
let failedCount = 0;

results.forEach((r, idx) => {
  const icon = r.passed ? ' PASS ' : ' FAIL ';
  const status = r.passed ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  console.log(`${status}[${icon}]${reset} #${idx + 1} [${r.suite}] ${r.name} (${r.durationMs}ms)`);
  if (!r.passed) {
    console.error(`       Error: ${r.error}`);
    failedCount++;
  } else {
    passedCount++;
  }
});

console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Total: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

if (failedCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
