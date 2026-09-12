/**
 * @license
 * Edit model orchestration tests (Phase 6): one derivation, every follow-up state.
 *
 * M1–M3 – audio follows the projection: an insert MOVES the material behind it,
 *         a delete closes the gap, a replace pads a short clip with silence.
 * M4–M6 – the imported ANLZ arrays stay pristine, the projection is idempotent,
 *         and the project duration is derived (never hand-patched).
 * M7–M9 – provenance and status text tell the truth about which columns are
 *         stored data and which are computed.
 *
 * Run with: npx tsx tests/edit-model.test.ts
 */

import { DataOrigin, EditSegment, PaletteClip, TrackModel, WaveformAnalysisData } from '../src/types/rekordbox';
import { projectTrackEdits, waveformOriginAfterEdit, describeProjection, withEditBase } from '../src/edit/editModel';
import type { RangeAnalyzer } from '../src/edit/editWaveform';
import { ColumnSource } from '../src/edit/editWaveform';

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
    results.push({ suite, name, passed: false, error: err?.message || String(err), durationMs: 0 });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

function near(a: number, b: number, message: string, tol = 1e-6) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Assertion Failed: ${message} (got ${a}, want ${b})`);
}

const SR = 1000;

/** AudioBuffer stand-in whose sample VALUE is its index in the source channel. */
function indexedBuffer(values: Float32Array, channels = 2): AudioBuffer {
  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) data.push(ch === 0 ? values : values.map((v) => v * 0.5));
  return {
    sampleRate: SR,
    numberOfChannels: channels,
    length: values.length,
    duration: values.length / SR,
    getChannelData: (ch: number) => data[Math.min(ch, channels - 1)],
  } as unknown as AudioBuffer;
}

function emptyBufferFactory(channels: number, length: number, sampleRate: number): AudioBuffer {
  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) data.push(new Float32Array(length));
  return {
    sampleRate,
    numberOfChannels: channels,
    length,
    duration: length / sampleRate,
    getChannelData: (ch: number) => data[Math.min(ch, channels - 1)],
  } as unknown as AudioBuffer;
}

function makeVariant(columns: number, durationSec: number, tag: string, seed = 1): WaveformAnalysisData {
  const peaks = new Float32Array(columns);
  for (let i = 0; i < columns; i++) peaks[i] = seed + i / 100;
  const half = new Float32Array(columns);
  for (let i = 0; i < columns; i++) half[i] = (i % 5) / 5;
  return {
    length: columns,
    peaks,
    peaksL: peaks,
    peaksR: peaks,
    lowEnergy: half,
    midEnergy: half,
    highEnergy: half,
    origin: DataOrigin.REKORDBOX_ANLZ,
    secPerBucket: durationSec / columns,
    sourceTag: tag,
  };
}

const stubAnalyzer: RangeAnalyzer = (_c, _s, _e, bd) => {
  const n = Math.max(1, Math.ceil(0.5 / bd - 1e-9));
  const v = new Float32Array(n).fill(0.42);
  return { peaks: v, peaksL: v, peaksR: v, lowEnergy: v, midEnergy: v, highEnergy: v };
};

function makeTrack(segments: EditSegment[], overrides: Partial<TrackModel> = {}): TrackModel {
  const original = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) original[i] = i;
  const variant = makeVariant(100, 1, 'PWV5');
  return {
    id: 'deck',
    title: 'Deck Track',
    artist: 'Artist',
    album: 'Album',
    bpm: 120,
    key: '1A',
    duration: 1,
    sampleRate: SR,
    channels: 2,
    originalSha256: 'sha256-test',
    isOriginalUntouched: true,
    audioBuffer: indexedBuffer(original),
    beatGrid: { firstBeat: 0, bpm: 120, meter: 4, beats: [], origin: DataOrigin.REKORDBOX_ANLZ },
    cues: [],
    loops: [],
    analysis: variant,
    analysisVariants: [variant],
    origin: DataOrigin.REKORDBOX_ANLZ,
    phrases: [],
    workingSegments: segments,
    ...overrides,
  } as TrackModel;
}

const originalSeg = (duration = 1): EditSegment => ({
  id: 'orig',
  type: 'ORIGINAL',
  trackId: 'deck',
  sourceStart: 0,
  sourceEnd: duration,
  projectStart: 0,
  projectDuration: duration,
  gain: 1,
});

function clipOf(values: Float32Array, overrides: Partial<PaletteClip> = {}): PaletteClip {
  return {
    id: 'clip-1',
    name: 'Clip',
    sourceTrackId: 'deck',
    sourceTrackName: 'Deck Track',
    sourceStart: 0,
    sourceEnd: values.length / SR,
    duration: values.length / SR,
    beats: 4,
    bars: 1,
    bpm: 120,
    key: '1A',
    color: '#00a2ff',
    audioBuffer: indexedBuffer(values),
    origin: DataOrigin.PROJECT,
    ...overrides,
  } as PaletteClip;
}

// ─── M1–M4: audio follows the projection ───────────────────────────────────

runTest('model', 'M1 unedited deck keeps the pristine ANLZ variant and duration', () => {
  const track = makeTrack([originalSeg()]);
  const out = projectTrackEdits(track, [], [track], { createBuffer: emptyBufferFactory, analyzeRange: stubAnalyzer });
  assert(out.identity, 'unedited project is identity');
  assert(out.track.analysis === out.track.baseAnalysis, 'the imported variant is rendered untouched');
  assert(out.track.analysisVariants?.length === 1, 'single pristine variant');
  assert(out.track.editInfo === undefined, 'no edit telemetry for an unedited deck');
  near(out.track.duration, 1, 'duration unchanged');
  near(out.workingBuffer!.length, 1000, 'working audio is the original length');
});

runTest('model', 'M2 insert moves the material behind it (audio, not just the marker)', () => {
  const clipValues = new Float32Array(200);
  for (let i = 0; i < 200; i++) clipValues[i] = 100000 + i;
  const clip = clipOf(clipValues);
  const segments: EditSegment[] = [
    originalSeg(),
    {
      id: 'ins',
      type: 'INSERT',
      trackId: 'deck',
      sourceStart: 0,
      sourceEnd: 0.2,
      projectStart: 0.5,
      projectDuration: 0.2,
      clipId: clip.id,
      clipBuffer: indexedBuffer(clipValues),
      gain: 1,
      sourceTrackId: 'unknown-track',
      sourceClipStart: 0,
      tempoRatio: 1,
      pitchShift: 0,
    },
  ];
  const track = makeTrack(segments);
  const out = projectTrackEdits(track, [clip], [track], { createBuffer: emptyBufferFactory, analyzeRange: stubAnalyzer });
  const left = out.workingBuffer!.getChannelData(0);
  near(out.workingBuffer!.length, 1200, 'project grew by the clip length');
  near(out.track.duration, 1.2, 'track duration follows the projection');
  assert(out.track.sourceDuration === 1, 'media duration stays frozen');
  for (let i = 0; i < 500; i++) assert(left[i] === i, `audio before the insert unchanged at ${i}`);
  for (let i = 0; i < 200; i++) assert(left[500 + i] === 100000 + i, `clip audio at ${i}`);
  assert(left[700] === 500, 'material after the insert was shifted, not overwritten');
  assert(left[1199] === 999, 'the tail reaches the original end');
  const right = out.workingBuffer!.getChannelData(1);
  near(right[500], (100000) * 0.5, 'second channel follows the same projection');
});

runTest('model', 'M3 delete closes the gap in the audio and shortens the project', () => {
  const segments: EditSegment[] = [
    originalSeg(),
    { id: 'cut', type: 'CUT', trackId: 'deck', sourceStart: 0, sourceEnd: 0, projectStart: 0.2, projectDuration: 0.1, gain: 1 },
  ];
  const track = makeTrack(segments);
  const out = projectTrackEdits(track, [], [track], { createBuffer: emptyBufferFactory, analyzeRange: stubAnalyzer });
  const left = out.workingBuffer!.getChannelData(0);
  near(out.workingBuffer!.length, 900, 'project shortened by 100 samples');
  for (let i = 0; i < 200; i++) assert(left[i] === i, 'head intact');
  assert(left[200] === 300, 'the hole is closed: sample 300 now sits at 200');
  assert(left[899] === 999, 'tail preserved');
});

runTest('model', 'M4 clear and replace are represented in the edit list (undo-safe)', () => {
  const clipValues = new Float32Array(50).fill(7);
  const clip = clipOf(clipValues, { id: 'clip-2' });
  const segments: EditSegment[] = [
    originalSeg(),
    { id: 'clr', type: 'CLEAR', trackId: 'deck', sourceStart: 0, sourceEnd: 0, projectStart: 0.1, projectDuration: 0.05, gain: 1 },
    {
      id: 'rep',
      type: 'REPLACE',
      trackId: 'deck',
      sourceStart: 0,
      sourceEnd: 0.05,
      projectStart: 0.4,
      projectDuration: 0.1,
      clipId: clip.id,
      clipBuffer: indexedBuffer(clipValues),
      gain: 1,
      tempoRatio: 1,
      pitchShift: 0,
      sourceTrackId: 'unknown',
      sourceClipStart: 0,
    },
  ];
  const track = makeTrack(segments);
  const out = projectTrackEdits(track, [clip], [track], { createBuffer: emptyBufferFactory, analyzeRange: stubAnalyzer });
  const left = out.workingBuffer!.getChannelData(0);
  near(out.workingBuffer!.length, 1000, 'length preserved (clear + same-length replace)');
  assert(left[100] === 0 && left[149] === 0, 'cleared window is silence');
  assert(left[150] === 150, 'audio right after the cleared window survives');
  assert(left[400] === 7, 'clip material replaced the window');
  assert(left[449] === 7, 'clip fills its 50 samples');
  assert(left[450] === 0 && left[499] === 0, 'the rest of the window is explicit silence');
  assert(left[500] === 500, 'material after the replace window is untouched');
});

// ─── M5–M7: waveform derivation stays pristine, honest and stable ──────────

runTest('model', 'M5 composite replaces the displayed variant while the base stays pristine', () => {
  const clipValues = new Float32Array(100).fill(5);
  const clip = clipOf(clipValues, { id: 'clip-3' });
  const segments: EditSegment[] = [
    originalSeg(),
    {
      id: 'ins',
      type: 'INSERT',
      trackId: 'deck',
      sourceStart: 0,
      sourceEnd: 0.1,
      projectStart: 0.5,
      projectDuration: 0.1,
      clipId: clip.id,
      clipBuffer: indexedBuffer(clipValues),
      gain: 1,
      // No source analysis available for this clip → its columns must be computed.
      sourceTrackId: 'missing-track',
      sourceClipStart: 0,
      tempoRatio: 1.25,
      pitchShift: 1,
    },
  ];
  const track = makeTrack(segments);
  const out = projectTrackEdits(track, [clip], [track], { createBuffer: emptyBufferFactory, analyzeRange: stubAnalyzer });
  const composite = out.track.analysis!;
  assert(composite.isEditComposite === true, 'displayed variant is the projected composite');
  assert(composite.origin === DataOrigin.USER_EDIT, 'composite provenance is USER_EDIT');
  assert(!!composite.provenance && composite.provenance.length === composite.length, 'per-column provenance present');
  assert(out.track.baseAnalysis === track.analysis, 'the pristine variant is kept for re-derivation');
  for (let i = 0; i < 50; i++) {
    near(composite.peaks[i], 1 + i / 100, `stored column ${i} copied verbatim`, 1e-6);
    assert(composite.provenance![i] === ColumnSource.ANLZ, `column ${i} is stored data`);
  }
  let computed = 0;
  for (let i = 0; i < composite.length; i++) if (composite.provenance![i] === ColumnSource.COMPUTED) computed++;
  assert(computed > 0, 'the inserted clip got computed columns');
  assert(out.stats!.verbatimColumns > 0 && out.stats!.computedColumns === computed, 'stats agree with the composite');
  assert(
    waveformOriginAfterEdit(out) === DataOrigin.USER_EDIT,
    'the UI is told that the current waveform is an edit product, not ANLZ'
  );
});

runTest('model', 'M6 repeated derivation is idempotent (Undo/Redo cannot drift)', () => {
  const segments: EditSegment[] = [
    originalSeg(),
    { id: 'cut', type: 'CUT', trackId: 'deck', sourceStart: 0, sourceEnd: 0, projectStart: 0.25, projectDuration: 0.05, gain: 1 },
  ];
  const track = makeTrack(segments);
  const args = { createBuffer: emptyBufferFactory, analyzeRange: stubAnalyzer } as const;
  const first = projectTrackEdits(track, [], [track], args);
  // Feeding the derived track back in (as Undo/Redo and project re-open do) must
  // not change anything: the derivation always reads the frozen base arrays.
  const second = projectTrackEdits(first.track, [], [first.track], args);
  const third = projectTrackEdits(second.track, [], [second.track], args);
  near(second.track.duration, first.track.duration, 'duration stable');
  let equal = true;
  for (let i = 0; i < first.track.analysis!.length; i++) {
    if (first.track.analysis!.peaks[i] !== third.track.analysis!.peaks[i]) equal = false;
  }
  assert(equal, 'columns identical after re-derivation');
  assert(third.track.baseAnalysis === track.analysis, 'base analysis survives any number of re-derivations');
});

runTest('model', 'M7 a deck without ANLZ stays empty for original material and computes only clips', () => {
  const clipValues = new Float32Array(100).fill(3);
  const clip = clipOf(clipValues, { id: 'clip-4' });
  const track = makeTrack(
    [
      originalSeg(),
      {
        id: 'ins',
        type: 'INSERT',
        trackId: 'deck',
        sourceStart: 0,
        sourceEnd: 0.1,
        projectStart: 0.2,
        projectDuration: 0.1,
        clipId: clip.id,
        clipBuffer: indexedBuffer(clipValues),
        gain: 1,
        tempoRatio: 1,
        pitchShift: 0,
      },
    ],
    { analysis: null, analysisVariants: [] }
  );
  const out = projectTrackEdits(track, [clip], [track], { createBuffer: emptyBufferFactory, analyzeRange: stubAnalyzer });
  const v = out.track.analysis!;
  assert(out.stats!.missingColumns > 0, 'the original regions are reported as missing');
  let invented = 0;
  for (let i = 0; i < v.length; i++) {
    if (v.provenance![i] === ColumnSource.MISSING && v.peaks[i] !== 0) invented++;
  }
  assert(invented === 0, 'no pseudo-waveform for a Rekordbox deck without ANLZ');
  assert(
    Array.from(v.provenance!).some((p) => p === ColumnSource.COMPUTED),
    'the inserted clip audio is still visualized (marked as computed)'
  );
});

runTest('model', 'M8 status text and origin describe the actual mix of sources', () => {
  const track = makeTrack([originalSeg()]);
  const untouched = projectTrackEdits(track, [], [track], { analyzeRange: stubAnalyzer });
  assert(untouched.identity && describeProjection(untouched).startsWith('Unbearbeitet'), 'unedited status is explicit');
  assert(
    waveformOriginAfterEdit(untouched) === DataOrigin.REKORDBOX_ANLZ,
    'unedited origin stays the imported ANLZ'
  );

  const clipValues = new Float32Array(50).fill(9);
  const clip = clipOf(clipValues, { id: 'clip-5' });
  const edited = projectTrackEdits(
    makeTrack([
      originalSeg(),
      { id: 'i', type: 'INSERT', trackId: 'deck', sourceStart: 0, sourceEnd: 0.05, projectStart: 0.3, projectDuration: 0.05, clipId: clip.id, clipBuffer: indexedBuffer(clipValues), gain: 1, tempoRatio: 2 },
    ]),
    [clip],
    [track],
    { analyzeRange: stubAnalyzer }
  );
  const text = describeProjection(edited);
  assert(text.includes('Spalten ANLZ übernommen'), 'stored share named');
  assert(text.includes('berechnet'), 'computed share named');
  assert(text.includes('Projekt'), 'project duration reported');
});

runTest('model', 'M9 withEditBase freezes the pristine analysis exactly once', () => {
  const variant = makeVariant(50, 1, 'PWV5');
  const track = makeTrack([originalSeg()], { analysis: variant, analysisVariants: [variant] });
  const frozen = withEditBase(track);
  const replaced: TrackModel = {
    ...frozen,
    analysis: makeVariant(10, 1, 'PWV5'),
    analysisVariants: [makeVariant(10, 1, 'PWV5')],
  };
  const again = withEditBase(replaced);
  assert(again.baseAnalysis === variant, 'first call stores the imported variant');
  assert(again.baseAnalysis === frozen.baseAnalysis, 'second call never overwrites the frozen base');
  near(again.sourceDuration!, 1, 'source duration captured at load');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────
const RESET = '\x1b[0m';
console.log('Test Results:\n');
let passedCount = 0;
let failedCount = 0;
results.forEach((r, idx) => {
  const icon = r.passed ? ' PASS ' : ' FAIL ';
  const status = r.passed ? '\x1b[32m' : '\x1b[31m';
  console.log(`${status}[${icon}]${RESET} #${idx + 1} [${r.suite}] ${r.name} (${r.durationMs}ms)`);
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
if (failedCount > 0) process.exit(1);
