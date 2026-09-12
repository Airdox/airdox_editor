/**
 * @license
 * Additive waveform projection tests (Phase 6).
 *
 * The claim under test is the answer to "must the whole file be re-analysed
 * after an edit?" — no: stored ANLZ columns are copied verbatim through the
 * edit projection, only genuinely new material gets computed columns, and every
 * column states where its numbers came from. Nothing is interpolated, averaged,
 * smoothed or invented; a region without a source stays empty.
 *
 * Run with: npx tsx tests/edit-waveform.test.ts
 */

import { DataOrigin, WaveformAnalysisData } from '../src/types/rekordbox';
import { projectEditTimeline, type ProjectedTimeline } from '../src/edit/editTimeline';
import {
  ColumnSource,
  buildEditWaveformVariants,
  countProvenance,
  describeEditWaveform,
  type ClipColumnSource,
  type RangeAnalyzer,
} from '../src/edit/editWaveform';
import { analyzeRangeBuckets } from '../src/waveform/analyzer';

import { runTest, assert, near, report } from './helpers/microTest.mjs';
/** Uniform, fully deterministic "ANLZ" variant: every column has its own value. */
function makeVariant(columns: number, durationSec: number, sourceTag: string): WaveformAnalysisData {
  const peaks = new Float32Array(columns);
  const peaksL = new Float32Array(columns);
  const peaksR = new Float32Array(columns);
  const low = new Float32Array(columns);
  const mid = new Float32Array(columns);
  const high = new Float32Array(columns);
  for (let i = 0; i < columns; i++) {
    peaks[i] = (i + 1) / (columns + 1);
    peaksL[i] = peaks[i] * 0.5;
    peaksR[i] = peaks[i] * 0.75;
    low[i] = (i % 7) / 7;
    mid[i] = (i % 5) / 5;
    high[i] = (i % 3) / 3;
  }
  return {
    length: columns,
    peaks,
    peaksL,
    peaksR,
    lowEnergy: low,
    midEnergy: mid,
    highEnergy: high,
    origin: DataOrigin.REKORDBOX_ANLZ,
    secPerBucket: durationSec / columns,
    sourceTag,
  };
}

/** Fixed stand-in for the real analyzer: value identifies the source columns. */
const stubAnalyzer: RangeAnalyzer = (channels, startSec, endSec, bucketSeconds) => {
  const n = Math.max(1, Math.ceil((endSec - startSec) / bucketSeconds - 1e-9));
  const peaks = new Float32Array(n);
  const peaksL = new Float32Array(n);
  const peaksR = new Float32Array(n);
  const low = new Float32Array(n);
  const mid = new Float32Array(n);
  const high = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = 0.25 + i * 0.01;
    peaks[i] = v;
    peaksL[i] = v;
    peaksR[i] = v;
    low[i] = 0.1;
    mid[i] = 0.2;
    high[i] = 0.3;
  }
  return { peaks, peaksL, peaksR, lowEnergy: low, midEnergy: mid, highEnergy: high };
};

const SOURCE_DURATION = 10;
const base = makeVariant(100, SOURCE_DURATION, 'PWV5');
const coarser = makeVariant(20, SOURCE_DURATION, 'PWAV');

function identityTimeline(duration = SOURCE_DURATION): ProjectedTimeline {
  return projectEditTimeline({
    segments: [
      {
        id: 'orig',
        type: 'ORIGINAL',
        trackId: 'deck',
        sourceStart: 0,
        sourceEnd: duration,
        projectStart: 0,
        projectDuration: duration,
        gain: 1,
      },
    ],
    sourceDuration: duration,
  });
}

const noClip: ClipColumnSource = { sourceVariants: [], sourceDuration: 0, playChannels: null };

function channelsOf(lengthSamples: number, sampleRate = 44100) {
  const left = new Float32Array(lengthSamples);
  const right = new Float32Array(lengthSamples);
  for (let i = 0; i < lengthSamples; i++) {
    left[i] = Math.sin(i * 0.25) * 0.5;
    right[i] = left[i];
  }
  return { left, right, sampleRate };
}

// ─── W: composited columns ─────────────────────────────────────────────────

runTest('waveform', 'W1 unedited project reproduces the ANLZ columns byte-exactly', () => {
  const out = buildEditWaveformVariants({
    timeline: identityTimeline(),
    baseVariants: [base],
    baseSourceDuration: SOURCE_DURATION,
    clipResolver: () => noClip,
    analyzeRange: stubAnalyzer,
  });
  const v = out.variants[0];
  assert(v.length === base.length, 'same column count as the source variant');
  let identical = true;
  for (let i = 0; i < v.length; i++) {
    if (v.peaks[i] !== base.peaks[i] || v.lowEnergy[i] !== base.lowEnergy[i]) identical = false;
  }
  assert(identical, 'every copied column is the exact stored value (no re-quantization)');
  assert(
    v.provenance!.every((p) => p === ColumnSource.ANLZ),
    'all columns are flagged as verbatim ANLZ'
  );
  assert(out.stats.computedColumns === 0, 'nothing was computed');
  assert(v.isEditComposite === true && v.origin === DataOrigin.USER_EDIT, 'composite is labelled as an edit product');
});

runTest('waveform', 'W2 inserted clip re-times ANLZ columns instead of re-analysing them', () => {
  // 2s clip inserted at 4s of a 10s track (bd 0.1s → shift by 20 columns).
  const timeline = projectEditTimeline({
    segments: [
      { id: 'o', type: 'ORIGINAL', trackId: 'deck', sourceStart: 0, sourceEnd: 10, projectStart: 0, projectDuration: 10, gain: 1 },
      {
        id: 'ins',
        type: 'INSERT',
        trackId: 'deck',
        sourceStart: 0,
        sourceEnd: 2,
        projectStart: 4,
        projectDuration: 2,
        gain: 1,
        clipId: 'c1',
        sourceTrackId: 'other',
        sourceClipStart: 1,
        tempoRatio: 1,
        pitchShift: 0,
      },
    ],
    sourceDuration: 10,
  });
  // The clip came from a second loaded track which has its own ANLZ variant.
  const otherTrackVariant = makeVariant(50, 5, 'PWV5');
  const resolver = (span: any): ClipColumnSource =>
    span.kind === 'clip'
      ? { sourceVariants: [otherTrackVariant], sourceDuration: 5, playChannels: channelsOf(44100) }
      : noClip;

  const out = buildEditWaveformVariants({
    timeline,
    baseVariants: [base],
    baseSourceDuration: SOURCE_DURATION,
    clipResolver: resolver,
    analyzeRange: stubAnalyzer,
  });
  const v = out.variants[0];
  near(v.length * v.secPerBucket!, 12, 'composite spans the project duration', 1e-3);

  // Head: columns 0..39 identical to the source.
  for (let i = 0; i < 40; i++) assert(v.peaks[i] === base.peaks[i], `head column ${i} unchanged`);
  assert(v.provenance![0] === ColumnSource.ANLZ, 'head keeps its ANLZ provenance');

  // Tail: base column (i - 20) re-timed to column i, values byte-identical.
  let tailExact = true;
  let tailTagged = true;
  for (let i = 60; i < v.length; i++) {
    if (v.peaks[i] !== base.peaks[i - 20]) tailExact = false;
    if (v.provenance![i] !== ColumnSource.ANLZ_RETIMED) tailTagged = false;
  }
  assert(tailExact, 'untouched material after the insert is copied, not recomputed');
  assert(tailTagged, 're-timed columns are flagged as re-timed ANLZ');

  // Clip region: verbatim columns of the SOURCE track (no analysis at all).
  const clipCols = Array.from(v.provenance!).filter((p) => p === ColumnSource.CLIP_ANLZ);
  assert(clipCols.length > 0, 'clip region carries CLIP_ANLZ columns');
  assert(out.stats.computedColumns === 0, 'nothing computed because the clip source had ANLZ data');
  assert(out.stats.spansVerbatimClip === 1, 'one span reused stored columns');
  const counts = countProvenance(v.provenance);
  assert(Object.values(counts).reduce((a, b) => a + b, 0) === v.length, 'every column has exactly one provenance');
});

runTest('waveform', 'W3 only genuinely new material is computed (and stays marked)', () => {
  const timeline = projectEditTimeline({
    segments: [
      { id: 'o', type: 'ORIGINAL', trackId: 'deck', sourceStart: 0, sourceEnd: 10, projectStart: 0, projectDuration: 10, gain: 1 },
      { id: 'ins', type: 'INSERT', trackId: 'deck', sourceStart: 0, sourceEnd: 2, projectStart: 4, projectDuration: 2, gain: 1, clipId: 'c1', tempoRatio: 1.5, pitchShift: 0 },
    ],
    sourceDuration: 10,
  });
  const resolver = (span: any): ClipColumnSource =>
    span.kind === 'clip'
      ? { sourceVariants: [makeVariant(50, 5, 'PWV5')], sourceDuration: 5, playChannels: channelsOf(44100) }
      : noClip;
  const out = buildEditWaveformVariants({
    timeline,
    baseVariants: [base],
    baseSourceDuration: SOURCE_DURATION,
    clipResolver: resolver,
    analyzeRange: stubAnalyzer,
  });
  const v = out.variants[0];
  assert(out.stats.computedColumns > 0, 'the stretched clip got computed columns');
  const computedIdx = Array.from(v.provenance!).findIndex((p) => p === ColumnSource.COMPUTED);
  assert(computedIdx > 0, 'computed columns exist inside the project');
  near(v.peaks[computedIdx], 0.25, 'computed value comes from the (stub) analyzer, not from ANLZ');
  let untouchedExact = true;
  for (let i = 0; i < 40; i++) if (v.peaks[i] !== base.peaks[i]) untouchedExact = false;
  for (let i = 60; i < v.length; i++) if (v.peaks[i] !== base.peaks[i - 20]) untouchedExact = false;
  assert(untouchedExact, 'the 2s of new material never invalidate the stored columns around it');
  assert(describeEditWaveform(out.stats, 12).includes('berechnet'), 'status text names the computed share');
});

runTest('waveform', 'W4 a deck without ANLZ stays honestly empty where no data exists', () => {
  const timeline = projectEditTimeline({
    segments: [
      { id: 'o', type: 'ORIGINAL', trackId: 'deck', sourceStart: 0, sourceEnd: 10, projectStart: 0, projectDuration: 10, gain: 1 },
      { id: 'ins', type: 'INSERT', trackId: 'deck', sourceStart: 0, sourceEnd: 1, projectStart: 2, projectDuration: 1, gain: 1, clipId: 'c9', tempoRatio: 1 },
    ],
    sourceDuration: 10,
  });
  const resolver = (span: any): ClipColumnSource =>
    span.kind === 'clip' ? { sourceVariants: [], sourceDuration: 0, playChannels: channelsOf(44100) } : noClip;
  const out = buildEditWaveformVariants({
    timeline,
    baseVariants: [],
    baseSourceDuration: SOURCE_DURATION,
    clipResolver: resolver,
    analyzeRange: stubAnalyzer,
    fallbackBucketSeconds: 0.1,
  });
  const v = out.variants[0];
  assert(out.stats.missingColumns > 0, 'the original regions are reported as missing');
  let invented = 0;
  for (let i = 0; i < v.length; i++) {
    if (v.provenance![i] === ColumnSource.MISSING && (v.peaks[i] !== 0 || v.lowEnergy[i] !== 0)) invented += 1;
  }
  assert(invented === 0, 'no amplitude is invented for a Rekordbox region without ANLZ');
  assert(v.label === 'BERECHNET (EDIT)', 'a computed-only composite is labelled as such');
});

runTest('waveform', 'W5 Clear produces real silence columns, not stale audio', () => {
  const timeline = projectEditTimeline({
    segments: [
      { id: 'o', type: 'ORIGINAL', trackId: 'deck', sourceStart: 0, sourceEnd: 10, projectStart: 0, projectDuration: 10, gain: 1 },
      { id: 'c', type: 'CLEAR', trackId: 'deck', sourceStart: 0, sourceEnd: 0, projectStart: 3, projectDuration: 1, gain: 1 },
    ],
    sourceDuration: 10,
  });
  const out = buildEditWaveformVariants({
    timeline,
    baseVariants: [base],
    baseSourceDuration: SOURCE_DURATION,
    clipResolver: () => noClip,
    analyzeRange: stubAnalyzer,
  });
  const v = out.variants[0];
  const silence = Array.from(v.provenance!).map((p, i) => (p === ColumnSource.SILENCE ? i : -1)).filter((i) => i >= 0);
  assert(silence.length >= 10, `at least one cleared column (got ${silence.length})`);
  assert(
    silence.every((i) => v.peaks[i] === 0),
    'cleared columns hold silence'
  );
  assert(out.stats.silenceColumns === silence.length, 'stats count the silenced columns');
  assert(v.peaks[0] === base.peaks[0], 'material outside the cleared window keeps its stored columns');
});

runTest('waveform', 'W6 Overdub mixes column maxima and marks the region as MIX', () => {
  const timeline = projectEditTimeline({
    segments: [
      { id: 'o', type: 'ORIGINAL', trackId: 'deck', sourceStart: 0, sourceEnd: 10, projectStart: 0, projectDuration: 10, gain: 1 },
      { id: 'ov', type: 'OVERDUB', trackId: 'deck', sourceStart: 0, sourceEnd: 2, projectStart: 2, projectDuration: 1, gain: 1, clipId: 'c7' },
    ],
    sourceDuration: 10,
  });
  const loud = { left: new Float32Array(44100 * 1).fill(0.9), right: new Float32Array(44100 * 1).fill(0.9), sampleRate: 44100 };
  const out = buildEditWaveformVariants({
    timeline,
    baseVariants: [base],
    baseSourceDuration: SOURCE_DURATION,
    clipResolver: (span) => ({ sourceVariants: [], sourceDuration: 0, playChannels: span.kind === 'clip' ? loud : null }),
    analyzeRange: (_c, _s, _e, bd) => {
      const n = Math.max(1, Math.ceil(1 / bd - 1e-9));
      const v = new Float32Array(n).fill(0.9);
      return { peaks: v, peaksL: v, peaksR: v, lowEnergy: v, midEnergy: v, highEnergy: v };
    },
  });
  const v = out.variants[0];
  const mixIdx = Array.from(v.provenance!).findIndex((p) => p === ColumnSource.MIX);
  assert(mixIdx >= 0, 'overdub region is flagged MIX');
  assert(v.peaks[mixIdx] >= base.peaks[mixIdx], 'mix takes the louder of the two column values');
  assert(timeline.isIdentity === false, 'an overdub is an edit');
});

runTest('waveform', 'W7 every ANLZ variant is projected, keeping its own resolution', () => {
  const out = buildEditWaveformVariants({
    timeline: projectEditTimeline({
      segments: [
        { id: 'o', type: 'ORIGINAL', trackId: 'deck', sourceStart: 0, sourceEnd: 10, projectStart: 0, projectDuration: 10, gain: 1 },
        { id: 'd', type: 'CUT', trackId: 'deck', sourceStart: 0, sourceEnd: 0, projectStart: 2, projectDuration: 2, gain: 1 },
      ],
      sourceDuration: 10,
    }),
    baseVariants: [base, coarser],
    baseSourceDuration: SOURCE_DURATION,
    clipResolver: () => noClip,
    analyzeRange: stubAnalyzer,
  });
  assert(out.variants.length === 2, 'detail and preview variants both projected');
  const [detail, preview] = out.variants;
  near(detail.secPerBucket!, 0.1, 'detail keeps the ANLZ column duration');
  near(preview.secPerBucket!, 0.5, 'preview keeps its coarser column duration');
  near(detail.length * detail.secPerBucket!, 8, 'detail spans the shortened project', 0.15);
  assert(preview.length === 16, `preview has 16 columns for 8s (got ${preview.length})`);
  assert(detail.sourceTag === 'PWV5' && preview.sourceTag === 'PWAV', 'source tags survive for the color rules');
  assert(out.stats.sourceTags.join(',') === 'PWV5,PWAV', 'stats report the source variants');
  let same = true;
  for (let i = 0; i < Math.min(preview.length, 4); i++) if (preview.peaks[i] !== coarser.peaks[i]) same = false;
  assert(same, 'preview columns are copied from the preview variant (no cross-variant mixing)');
});

runTest('waveform', 'W8 re-deriving from the pristine base is idempotent (no drift)', () => {
  const timeline = projectEditTimeline({
    segments: [
      { id: 'o', type: 'ORIGINAL', trackId: 'deck', sourceStart: 0, sourceEnd: 10, projectStart: 0, projectDuration: 10, gain: 1 },
      { id: 'ins', type: 'INSERT', trackId: 'deck', sourceStart: 0, sourceEnd: 1, projectStart: 4, projectDuration: 1, gain: 1, clipId: 'c1', tempoRatio: 2 },
    ],
    sourceDuration: 10,
  });
  const resolver = (span: any): ClipColumnSource =>
    span.kind === 'clip' ? { sourceVariants: [], sourceDuration: 0, playChannels: channelsOf(44100) } : noClip;
  const args = {
    timeline,
    baseVariants: [base],
    baseSourceDuration: SOURCE_DURATION,
    clipResolver: resolver,
    analyzeRange: stubAnalyzer,
  };
  const first = buildEditWaveformVariants(args).variants[0];
  const second = buildEditWaveformVariants(args).variants[0];
  const third = buildEditWaveformVariants(args).variants[0];
  let equal = first.length === second.length && second.length === third.length;
  for (let i = 0; i < first.length && equal; i++) {
    if (first.peaks[i] !== second.peaks[i] || second.peaks[i] !== third.peaks[i]) equal = false;
    if (first.provenance![i] !== third.provenance![i]) equal = false;
  }
  assert(equal, 'repeated projection yields identical columns (base arrays are never consumed)');
  near(base.peaks[40], 41 / 101, 'the pristine base variant stayed untouched', 1e-7);
});

// ─── A: range analyzer primitive ───────────────────────────────────────────

runTest('analyzer', 'A1 analyzeRangeBuckets returns exactly one column per bucket duration', () => {
  const sampleRate = 1000;
  const left = new Float32Array(2000);
  // Single loud sample at 1.25s → must land in the bucket that covers it.
  left[1250] = 0.8;
  const res = analyzeRangeBuckets({ left, right: left, sampleRate }, 1.0, 1.5, 0.05);
  assert(res.length === 10, `10 columns for 0.5s at 0.05s (got ${res.length})`);
  const idx = Math.floor((1.25 - 1.0) / 0.05);
  near(res.peaks[idx], 0.8, 'peak found in the right column');
  assert(
    res.peaks.every((p, i) => (i === idx ? p > 0.7 : p === 0)),
    'no energy leaks into neighbouring columns'
  );
  near(res.secPerBucket, 0.05, 'column duration reported');
});

runTest('analyzer', 'A2 analyzer clamps to available audio and never wraps around', () => {
  const left = new Float32Array(500).fill(0.5);
  const res = analyzeRangeBuckets({ left, sampleRate: 1000 }, 0.2, 10, 0.1);
  assert(res.length === 3, `only the existing 0.3s produce columns (got ${res.length})`);
  near(res.peaks[0], 0.5, 'first column inside the range');
  const empty = analyzeRangeBuckets({ left: new Float32Array(100), sampleRate: 1000 }, 0, 0.1, 0.01);
  assert(empty.length >= 1 && empty.peaks.every((p) => p <= 0.001), 'digital silence stays silence');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────

report('EDIT-WAVEFORM SUITE');
