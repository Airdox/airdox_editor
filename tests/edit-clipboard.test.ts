/**
 * @license
 * Copy / paste / clone provenance — the "where does this material come from" tests.
 *
 * Why this suite exists: a user selected a range, pressed COPY, clicked somewhere
 * else, pressed PASTE — and got material that was neither from the selected place
 * nor drawn with the waveform of that place. The cause class is a *silently
 * guessed source window*: when a timeline window cannot be mapped back to the
 * original source, the app must say so (and compute honestly), instead of
 * reinterpreting a project position as a source position.
 *
 * S-series — the pure mapper `mapWindowToSourceWindow` (what may be claimed).
 * P-series — the projection that consumes those claims (what is drawn and heard).
 *
 * Run with: npx tsx tests/edit-clipboard.test.ts
 */

import { DataOrigin, EditSegment, PaletteClip, TrackModel, WaveformAnalysisData } from '../src/types/rekordbox';
import {
  mapWindowToSourceWindow,
  projectEditTimeline,
  spanAllowsVerbatimClipColumns,
  type ProjectedTimeline,
} from '../src/edit/editTimeline';
import { ColumnSource, type RangeAnalyzer } from '../src/edit/editWaveform';
import { projectTrackEdits } from '../src/edit/editModel';
import { miniPeaksFromStoredColumns, clipPreviewProfile } from '../src/waveform/preview';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function runTest(suite: string, name: string, testFn: () => void) {
  try {
    testFn();
    results.push({ suite, name, passed: true });
  } catch (err: any) {
    results.push({ suite, name, passed: false, error: err?.message || String(err) });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

function near(a: number, b: number, message: string, tol = 1e-6) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Assertion Failed: ${message} (got ${a}, want ${b})`);
}

const SR = 1000;
const DURATION = 1; // seconds of the source track
const COLUMNS = 100; // 10 ms buckets
const BD = DURATION / COLUMNS;

/** Stored variant whose column i has the unmistakable value 0.10 + i * 0.005. */
function storedVariant(): WaveformAnalysisData {
  const peaks = new Float32Array(COLUMNS);
  for (let i = 0; i < COLUMNS; i++) peaks[i] = 0.1 + i * 0.005;
  return {
    length: COLUMNS,
    peaks,
    peaksL: peaks,
    peaksR: peaks,
    lowEnergy: peaks,
    midEnergy: peaks,
    highEnergy: peaks,
    origin: DataOrigin.REKORDBOX_ANLZ,
    secPerBucket: BD,
    sourceTag: 'PWV7',
  };
}

/** Audio buffer whose sample value is its index (so copies are provable). */
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

function makeTrack(segments: EditSegment[], overrides: Partial<TrackModel> = {}): TrackModel {
  const original = new Float32Array(SR);
  for (let i = 0; i < SR; i++) original[i] = i;
  const variant = storedVariant();
  return {
    id: 'deck',
    title: 'Deck Track',
    artist: 'Artist',
    album: 'Album',
    bpm: 120,
    key: '1A',
    duration: DURATION,
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

const baseSegment = (): EditSegment => ({
  id: 'orig',
  type: 'ORIGINAL',
  trackId: 'deck',
  sourceStart: 0,
  sourceEnd: DURATION,
  projectStart: 0,
  projectDuration: DURATION,
  gain: 1,
});

const cutSegment = (start: number, end: number): EditSegment => ({
  id: `cut-${start}`,
  type: 'CUT',
  trackId: 'deck',
  sourceStart: start,
  sourceEnd: end,
  projectStart: start,
  projectDuration: end - start,
  gain: 1,
});

const insertSegment = (
  projectStart: number,
  duration: number,
  source: Partial<EditSegment> = {},
  type: EditSegment['type'] = 'INSERT'
): EditSegment => {
  const values = new Float32Array(Math.round(duration * SR));
  for (let i = 0; i < values.length; i++) values[i] = 100000 + i;
  return {
    id: `${type.toLowerCase()}-${projectStart}`,
    type,
    trackId: 'deck',
    sourceStart: 0,
    sourceEnd: duration,
    projectStart,
    projectDuration: duration,
    gain: 1,
    clipBuffer: indexedBuffer(values),
    ...source,
  };
};

function timelineOf(segments: EditSegment[]): ProjectedTimeline {
  return projectEditTimeline({ segments, sourceDuration: DURATION }, (seg) => ({
    playDuration: seg.clipBuffer ? (seg.clipBuffer as AudioBuffer).duration : seg.projectDuration,
  }));
}

// ─── S-series: what may be claimed as a source window ───────────────────────

runTest('source-map', 'S1 unedited window maps to the same position in the source', () => {
  const tl = timelineOf([baseSegment()]);
  const mapped = mapWindowToSourceWindow(tl, 'deck', 0.2, 0.5);
  assert(mapped !== null, 'an untouched deck is mappable');
  near(mapped!.sourceStart, 0.2, 'project time == source time while nothing was edited');
  near(mapped!.duration, 0.3, 'duration preserved');
  assert(mapped!.via === 'original', 'claimed as original material');
  assert(mapped!.trackId === 'deck', 'owns the deck track');
});

runTest('source-map', 'S2 window after a cut follows the REMOVED length (not the play position)', () => {
  const tl = timelineOf([baseSegment(), cutSegment(0.3, 0.5)]);
  // Project 0.4 s now plays source 0.6 s — the mapper must know that.
  const mapped = mapWindowToSourceWindow(tl, 'deck', 0.4, 0.6);
  assert(mapped !== null, 'window lies inside one original span');
  near(mapped!.sourceStart, 0.6, 'shifted by the cut length instead of taken as a source position');
});

runTest('source-map', 'S3 a window across the cut join has NO single source window', () => {
  const tl = timelineOf([baseSegment(), cutSegment(0.3, 0.5)]);
  assert(mapWindowToSourceWindow(tl, 'deck', 0.25, 0.35) === null, 'the join is not contiguous in the source — refuse');
});

runTest('source-map', 'S4 pasted material keeps its origin (transitive mapping)', () => {
  const tl = timelineOf([
    baseSegment(),
    insertSegment(0.2, 0.3, { sourceTrackId: 'deck', sourceClipStart: 0.7 }),
  ]);
  const mapped = mapWindowToSourceWindow(tl, 'deck', 0.25, 0.3);
  assert(mapped !== null, 'an untransformed clip span maps through itself');
  near(mapped!.sourceStart, 0.75, '0.7 (clip origin) + 0.05 inside the clip');
  assert(mapped!.via === 'clip', 'labelled as transitive');
});

runTest('source-map', 'S5 retuned clip material is NOT mapped (its source time no longer runs 1:1)', () => {
  const tl = timelineOf([
    baseSegment(),
    insertSegment(0.2, 0.3, { sourceTrackId: 'deck', sourceClipStart: 0.7, tempoRatio: 0.9 }),
  ]);
  const span = tl.spans.find((s) => s.kind === 'clip')!;
  assert(!spanAllowsVerbatimClipColumns(span), 'a retuned span must refuse verbatim reuse');
  assert(mapWindowToSourceWindow(tl, 'deck', 0.25, 0.3) === null, 'and therefore has no source window');
});

runTest('source-map', 'S6 cleared material (silence) has no source, even though the timeline is longer', () => {
  const clear: EditSegment = {
    id: 'clear-1',
    type: 'CLEAR',
    trackId: 'deck',
    sourceStart: 0.4,
    sourceEnd: 0.6,
    projectStart: 0.4,
    projectDuration: 0.2,
    gain: 0,
  };
  const tl = timelineOf([baseSegment(), clear]);
  assert(mapWindowToSourceWindow(tl, 'deck', 0.42, 0.5) === null, 'silence must never claim source material');
});

runTest('source-map', 'S7 degenerate inputs are refused, not guessed', () => {
  const tl = timelineOf([baseSegment()]);
  assert(mapWindowToSourceWindow(tl, 'deck', 0.5, 0.5) === null, 'empty window');
  assert(mapWindowToSourceWindow(tl, 'deck', 0.6, 0.4) === null, 'end before start');
  assert(mapWindowToSourceWindow(tl, 'deck', 0.9, 1.4) === null, 'past the timeline end');
  assert(mapWindowToSourceWindow(tl, '', 0.1, 0.2) === null, 'without a track id');
  assert(mapWindowToSourceWindow(null, 'deck', 0.1, 0.2) === null, 'without a timeline');
});

// ─── P-series: what the projection then draws and plays ──────────────────────

const stubAnalyzer = (calls: { n: number }): RangeAnalyzer => (_c, _s, _e, bd) => {
  calls.n += 1;
  const n = Math.max(1, Math.ceil(0.5 / bd - 1e-9));
  const v = new Float32Array(n).fill(0.42);
  return { peaks: v, peaksL: v, peaksR: v, lowEnergy: v, midEnergy: v, highEnergy: v };
};

function project(segments: EditSegment[], analyzeCalls?: { n: number }) {
  const track = makeTrack(segments);
  const calls = analyzeCalls ?? { n: 0 };
  const out = projectTrackEdits(track, [], [track], {
    createBuffer: emptyBufferFactory,
    analyzeRange: stubAnalyzer(calls),
  });
  return { out, calls };
}

function variantOf(out: ReturnType<typeof projectTrackEdits>) {
  const variant = (out.variants && out.variants.length > 0 ? out.variants[0] : out.track.analysis) as WaveformAnalysisData;
  assert(!!variant, 'the projection produced a waveform variant');
  return variant;
}

runTest('projection', 'P1 pasted material reuses the STORED columns of its source window', () => {
  const { out } = project([baseSegment(), insertSegment(0.2, 0.3, { sourceTrackId: 'deck', sourceClipStart: 0.7 })]);
  const variant = variantOf(out);
  const stored = storedVariant().peaks;
  const startIdx = Math.round(0.2 / BD);
  let checked = 0;
  let matchesSource = 0;
  let matchesWrongGuess = 0;
  for (let i = startIdx; i < startIdx + 25; i++) {
    const prov = variant.provenance?.[i];
    if (prov !== ColumnSource.CLIP_ANLZ) continue;
    checked += 1;
    if (Math.abs(variant.peaks[i] - stored[i]) < 1e-9) matchesWrongGuess += 1; // project index = the bug
    const srcIdx = Math.floor((0.7 + (i - startIdx) * BD) / BD + 1e-9);
    if (Math.abs(variant.peaks[i] - stored[srcIdx]) < 1e-9) matchesSource += 1;
  }
  assert(checked > 10, `clip columns present (checked ${checked})`);
  assert(matchesSource === checked, 'every pasted column is the stored column of the SOURCE window');
  assert(matchesWrongGuess === 0, 'no column may be taken from the project position instead');
  assert((out.stats?.computedColumns ?? 0) === 0, 'nothing was re-analyzed for verbatim source material');
});

runTest('projection', 'P2 unmapped clip material is COMPUTED and never a borrowed source position', () => {
  const calls = { n: 0 };
  const { out } = project([baseSegment(), insertSegment(0.2, 0.3, { sourceTrackId: 'deck', sourceClipStart: 0.7 })], calls);
  const mapped = project([baseSegment(), insertSegment(0.2, 0.3, {})], { n: 0 });
  const variant = variantOf(mapped.out);
  const stored = storedVariant().peaks;
  const startIdx = Math.round(0.2 / BD);
  let borrowed = 0;
  let computed = 0;
  for (let i = startIdx; i < startIdx + 25; i++) {
    if (variant.provenance?.[i] === ColumnSource.COMPUTED) computed += 1;
    if (Math.abs(variant.peaks[i] - stored[i]) < 1e-9 && variant.provenance?.[i] === ColumnSource.ANLZ) borrowed += 1;
  }
  assert(computed > 10, `unmapped material is labelled COMPUTED (got ${computed})`);
  assert(borrowed === 0, 'no column may silently be taken from the original at the project position');
  assert(mapped.calls.n > 0, 'and it really was measured from the clip audio');
  assert(calls.n === 0, 'while the mapped case needed no own analysis at all');
});

runTest('projection', 'P3 old project without sourceMapped keeps its audio but claims no source', () => {
  const clip: PaletteClip = {
    id: 'clip-old',
    name: 'Alt',
    sourceTrackId: 'deck',
    sourceTrackName: 'Deck Track',
    sourceStart: 0.55, // a PROJECT position from an old version — not a source window
    sourceEnd: 0.75,
    duration: 0.2,
    beats: 4,
    bars: 1,
    bpm: 120,
    key: '1A',
    color: '#00a2ff',
    origin: DataOrigin.PROJECT,
    // sourceMapped deliberately absent
  } as PaletteClip;
  assert(clip.sourceMapped !== true, 'an unverified clip must not be treated as source material');
  const tl = timelineOf([baseSegment(), insertSegment(0.2, 0.2, { sourceTrackId: clip.sourceTrackId })]);
  const span = tl.spans.find((s) => s.kind === 'clip')!;
  // The app only hands over source ids for verified clips; with the guard in place
  // the span above has no sourceClipStart, so the projection cannot borrow columns.
  assert(span.sourceClipStart === undefined, 'no source window is attached for an unverified clip');
});

runTest('projection', 'P4 overdub over stored columns ADDS both layers (no per-column maximum, no own analysis)', () => {
  const calls = { n: 0 };
  const withOverdub = project(
    [
      baseSegment(),
      insertSegment(0.4, 0.2, { sourceTrackId: 'deck', sourceClipStart: 0.1, type: 'OVERDUB' } as Partial<EditSegment>, 'OVERDUB'),
    ],
    calls
  );
  const without = project([baseSegment()]);
  const mixed = variantOf(withOverdub.out);
  const plain = variantOf(without.out);
  const stored = storedVariant().peaks;
  const startIdx = Math.round(0.4 / BD);
  let aboveBase = 0;
  let clamped = 0;
  let mixMarked = 0;
  for (let i = startIdx; i < startIdx + 15; i++) {
    if (mixed.provenance?.[i] === ColumnSource.MIX) mixMarked += 1;
    if (mixed.peaks[i] > plain.peaks[i] + 1e-9) aboveBase += 1;
    if (mixed.peaks[i] > 1) clamped += 1;
    // the overlay is the stored column of the clip source (0.1 + k*BD bucket row)
    const overlayIdx = Math.floor((0.1 + (i - startIdx) * BD) / BD + 1e-9);
    const expected = Math.min(1, stored[i] + stored[overlayIdx]);
    near(mixed.peaks[i], expected, `column ${i} is the sum of the two stored layers`);
  }
  assert(mixMarked > 8, `overlay columns are labelled MIX (got ${mixMarked})`);
  assert(aboveBase > 8, 'the quieter layer is no longer thrown away by a maximum');
  assert(clamped === 0, 'nothing exceeds the normalized range');
  assert(calls.n === 0, 'the overlay came from stored columns — no re-analysis of audio');
  assert((withOverdub.out.stats?.mixStoredColumns ?? 0) > 0, 'stats count the stored overlay');
  assert((withOverdub.out.stats?.mixComputedColumns ?? 1) === 0, 'and nothing was measured');
});

runTest('projection', 'P5 overdub WITHOUT stored columns measures the overlay and says so', () => {
  const calls = { n: 0 };
  const { out } = project(
    [baseSegment(), insertSegment(0.4, 0.2, { sourceTrackId: 'foreign' }, 'OVERDUB')],
    calls
  );
  const variant = variantOf(out);
  const startIdx = Math.round(0.4 / BD);
  let mixedMarked = 0;
  for (let i = startIdx; i < startIdx + 10; i++) {
    if (variant.provenance?.[i] === ColumnSource.MIX) mixedMarked += 1;
    assert(variant.peaks[i] <= 1 + 1e-9, `column ${i} stays inside 0..1`);
    assert(variant.peaks[i] >= 0.42 - 1e-9, `column ${i} carries the measured overlay`);
  }
  assert(mixedMarked > 5, 'the overlay columns are still labelled MIX');
  assert(calls.n > 0, 'and they really came from the analyzer because no stored columns exist');
  assert((out.stats?.mixComputedColumns ?? 0) > 0, 'stats report the measured overlay honestly');
});

runTest('projection', 'P6 inserting verified material does not disturb the neighbours', () => {
  const { out } = project([baseSegment(), insertSegment(0.2, 0.3, { sourceTrackId: 'deck', sourceClipStart: 0.7 })]);
  const variant = variantOf(out);
  const stored = storedVariant().peaks;
  const before = Math.round(0.1 / BD);
  near(variant.peaks[before], stored[before], 'columns before the insert stay verbatim');
  assert(variant.provenance?.[before] === ColumnSource.ANLZ, 'and stay labelled ANLZ');
});

// ─── V-series: the palette preview must not invent a contour ────────────────

runTest('preview', 'V1 preview peaks are SELECTED stored columns, byte-exact', () => {
  const variant = storedVariant();
  const peaks = miniPeaksFromStoredColumns(variant, 0.7, 0.3, 12)!;
  assert(peaks.length === 12, 'one value per pixel');
  for (let k = 0; k < 12; k++) {
    const at = 0.7 + (k + 0.5) * (0.3 / 12);
    const idx = Math.floor(at / BD + 1e-9);
    near(peaks[k], variant.peaks[idx], `pixel ${k} shows stored column ${idx} unchanged`);
  }
});

runTest('preview', 'V2 no averaging: a wider card repeats columns instead of blending them', () => {
  const variant = storedVariant();
  const peaks = miniPeaksFromStoredColumns(variant, 0, 0.02, 4)!; // 2 columns -> 4 pixels
  const unique = new Set(Array.from(peaks));
  assert(unique.size <= 2, `only real column values appear (got ${Array.from(unique).length} distinct)`);
  for (const p of peaks) {
    assert(
      Array.from(variant.peaks).some((v) => Math.abs(v - p) < 1e-9),
      'every preview value exists verbatim in the stored columns'
    );
  }
});

runTest('preview', 'V3 a window outside the stored analysis yields nothing, not a guess', () => {
  const variant = storedVariant();
  assert(miniPeaksFromStoredColumns(variant, 0.95, 0.2, 12) === null, 'beyond coverage');
  assert(miniPeaksFromStoredColumns(null, 0, 0.2, 12) === null, 'without analysis');
  assert(miniPeaksFromStoredColumns(variant, 0, 0, 12) === null, 'empty window');
});

runTest('preview', 'V4 profile labels its origin, and falls back only when nothing is stored', () => {
  const variant = storedVariant();
  const stored = clipPreviewProfile(variant, 0.1, 0.2, 8, () => [9, 9, 9, 9, 9, 9, 9, 9]);
  assert(stored.origin === 'ANLZ' && stored.columns === COLUMNS, 'stored columns preferred');
  const fallback = clipPreviewProfile(null, 0.1, 0.2, 8, () => [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  assert(fallback.origin === 'EDIT', 'own audio only when there is no stored analysis');
  assert(fallback.peaks[0] === 0.5, 'and then the caller supplies the measured profile');
});

const failed = results.filter((r) => !r.passed);
console.log('\n' + '═'.repeat(74));
console.log('  CLIPBOARD / PROVENANCE SUITE');
console.log('═'.repeat(74));
for (const r of results) {
  console.log(`  ${r.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} [${r.suite}] ${r.name}${r.error ? `\n      ${r.error}` : ''}`);
}
console.log(`\n  ${results.length - failed.length}/${results.length} Tests bestanden`);
console.log('─'.repeat(74) + '\n');
if (failed.length) process.exit(1);
