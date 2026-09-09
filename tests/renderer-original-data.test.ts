/**
 * @license
 * Renderer original-data contract tests (implementation steps 3 & 4).
 *
 * Verifies that the canvas renderers consume the original stored data instead
 * of recomputing uniform geometry or synthesizing waveforms:
 *  - beat lines are drawn at the verbatim beatGrid.beats[] times; a uniform
 *    firstBeat+bpm reconstruction may only run for grids WITHOUT stored nodes
 *    and must report itself (documented single fallback);
 *  - waveform rendering resolves genuine Rekordbox ANLZ variants only; tracks
 *    without a waveform get null (honest empty state) and a clear status text
 *    — never synthesized columns;
 *  - the XML deck-load path never calls analyzeAudioBuffer;
 *  - the production renderer sources contain no synthetic-waveform code.
 *
 * Run with: npx tsx tests/renderer-original-data.test.ts
 */

import fs from 'node:fs';
import {
  BeatGrid,
  BeatNode,
  DataOrigin,
  WaveformAnalysisData,
} from '../src/types/rekordbox';
import {
  selectGridRenderBeats,
  selectTrackWaveform,
  waveformMissingNotice,
} from '../src/waveform/renderModel';

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

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`Assertion Failed [${message}]: expected ${expected}, got ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function node(time: number, beatInBar: number, barNumber: number): BeatNode {
  return {
    index: 0,
    time,
    isBarStart: beatInBar === 1,
    barNumber,
    beatInBar,
  };
}

function waveform(len: number, sourceTag?: string): WaveformAnalysisData {
  return {
    length: len,
    peaks: new Float32Array(len),
    peaksL: new Float32Array(len),
    peaksR: new Float32Array(len),
    lowEnergy: new Float32Array(len),
    midEnergy: new Float32Array(len),
    highEnergy: new Float32Array(len),
    origin: DataOrigin.REKORDBOX_ANLZ,
    sourceTag,
  };
}

// ─── SUITE 1: Renderer reads beatGrid.beats[] verbatim ──────────────────────
runTest('beats[] verbatim', 'Grid lines use exact original PQTZ times (non-uniform)', () => {
  // Times chosen so that firstBeat + n*60/bpm would NOT reproduce them:
  // spb at 130 BPM = 0.461538...; the stored times deliberately deviate.
  const times = [0.000, 0.440, 0.960, 1.410, 1.850];
  const grid: BeatGrid = {
    firstBeat: 0.0,
    bpm: 130.0,
    meter: 4,
    origin: DataOrigin.REKORDBOX_ANLZ,
    beats: times.map((time, i) => node(time, (i % 4) + 1, Math.floor(i / 4) + 1)),
  };

  const selection = selectGridRenderBeats(grid, -0.5, 1.5);
  assertEqual(selection.uniformFallback, false, 'Nodes exist → no uniform fallback');
  const visibleTimes = selection.beats.map((b) => b.time);
  assert(
    visibleTimes.length === 4 &&
      Math.abs(visibleTimes[0] - 0.0) < 1e-9 &&
      Math.abs(visibleTimes[1] - 0.44) < 1e-9 &&
      Math.abs(visibleTimes[2] - 0.96) < 1e-9 &&
      Math.abs(visibleTimes[3] - 1.41) < 1e-9,
    'Visible beats keep the original times within the window'
  );
});

runTest('beats[] verbatim', 'Tail-extended nodes keep their provenance through rendering', () => {
  const grid: BeatGrid = {
    firstBeat: 1.0,
    bpm: 120.0,
    meter: 4,
    origin: DataOrigin.REKORDBOX_ANLZ,
    beats: [
      { ...node(1.0, 1, 1), tailExtended: false },
      { ...node(1.6, 2, 1), tailExtended: true }, // unusual spacing, flagged tail
    ],
  };
  const selection = selectGridRenderBeats(grid, 0, 3);
  assertEqual(selection.uniformFallback, false, 'No uniform rebuild');
  assertEqual(selection.beats[1].time, 1.6, 'Exact recorded time kept');
  assertEqual(selection.beats[1].tail, true, 'Tail flag survives to the view');
});

runTest('uniform fallback', 'Reconstruction runs ONLY for grids without nodes (documented case)', () => {
  const grid: BeatGrid = {
    firstBeat: 0.25,
    bpm: 128.0,
    meter: 4,
    beats: [],
    origin: DataOrigin.REKORDBOX_XML,
  };
  const selection = selectGridRenderBeats(grid, 0, 1.0);
  assertEqual(selection.uniformFallback, true, 'Fallback reports itself');
  const spb = 60.0 / 128.0;
  assertEqual(selection.beats[0].time, 0.25, 'First beat anchored at firstBeat');
  assertEqual(selection.beats[1].time, 0.25 + spb, 'Uniform spacing only in fallback');
  assertEqual(selection.beats[0].barNumber, 1, 'Bar numbering starts at 1');
});

// ─── SUITE 2: Waveform rendering uses genuine ANLZ variants only ────────────
runTest('waveform source', 'Multiple ANLZ variants resolve per zoom', () => {
  const coarse = waveform(100, 'PWV3');
  const fine = waveform(900, 'PWV7');
  const result = selectTrackWaveform(
    {
      duration: 240,
      analysisVariants: [coarse, fine],
      analysis: fine,
    },
    12,
    1200
  );
  assert(result !== null, 'Variant resolved');
  assertEqual(result!.length, 900, 'Deep zoom uses the finest genuine variant');
});

runTest('waveform source', 'No analysis data → null (renderer draws honest empty state)', () => {
  const result = selectTrackWaveform(
    { duration: 240, analysis: null, analysisVariants: [] },
    12,
    1200
  );
  assertEqual(result, null, 'No invented waveform');
});

runTest('waveform source', 'PQTZ-only ANLZ (grid without waveform) renders nothing', () => {
  // A track that only ever received a beat grid — no PWAV/PWV variant exists.
  const result = selectTrackWaveform(
    {
      duration: 240,
      analysis: undefined,
      analysisVariants: [],
      // origin/beatGrid are not part of the selector: no data is data.
    },
    12,
    1200
  );
  assertEqual(result, null, 'Grid alone never becomes a waveform');
});

runTest('waveform source', 'Merge result (DAT+EXT variants) is what the renderer sees', () => {
  const preview = waveform(600, 'PWV5');
  const fullRes = waveform(900, 'PWV7');
  const merged = [preview, fullRes]; // merged analysisVariants order from parser
  // Full-track overview on a 400px-wide canvas: both variants resolve every
  // column, so the coarsest sufficient one (PWV5) must win.
  const wide = selectTrackWaveform({ duration: 240, analysisVariants: merged }, 240, 400);
  assertEqual(wide!.sourceTag, 'PWV5', 'Wide zoom picks the coarsest sufficient variant');
});

runTest('missing status', 'RB tracks get the transparent Rekordbox missing message', () => {
  const notice = waveformMissingNotice({ origin: DataOrigin.REKORDBOX_XML });
  assert(notice.title.includes('Keine Rekordbox-Waveformdaten vorhanden.'), 'Clear RB message');
  assert(notice.hint.includes('Keine Rekordbox-Analysedaten gefunden'), 'Transparent hint');
});

runTest('missing status', 'Non-Rekordbox tracks get the generic missing message', () => {
  const notice = waveformMissingNotice({ origin: DataOrigin.LOCAL_ANALYSIS });
  assert(notice.title.includes('Keine Waveformdaten vorhanden.'), 'Generic message');
});

// ─── SUITE 3: Production renderers contain no synthetic waveform code ───────
const SRC = {
  detail: fs.readFileSync(new URL('../src/components/DetailWaveform.tsx', import.meta.url), 'utf8'),
  overview: fs.readFileSync(new URL('../src/components/TrackOverview.tsx', import.meta.url), 'utf8'),
  app: fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'),
};

const BANNED_TOKENS = [
  'Math.exp(-beatFract',
  'kickEnv',
  'hiHat',
  'subBass',
  'VORSCHAU-Wellenform',
  'Beatgrid-synthetisierte Vorschau',
  'Vorschau-Kontur',
  'sin(t *',
  'sin(t*',
];

runTest('no synthetic fallback', 'DetailWaveform contains no waveform synthesis code', () => {
  for (const token of BANNED_TOKENS) {
    assert(!SRC.detail.includes(token), `DetailWaveform must not contain "${token}"`);
  }
});

runTest('no synthetic fallback', 'TrackOverview contains no waveform synthesis code', () => {
  for (const token of BANNED_TOKENS) {
    assert(!SRC.overview.includes(token), `TrackOverview must not contain "${token}"`);
  }
});

runTest('no synthetic fallback', 'Renderers route through the original-data helpers', () => {
  assert(SRC.detail.includes('selectGridRenderBeats('), 'Detail beat source helper used');
  assert(SRC.detail.includes('selectTrackWaveform('), 'Detail waveform source helper used');
  assert(SRC.overview.includes('selectTrackWaveform('), 'Overview waveform source helper used');
  assert(SRC.detail.includes('waveformMissingNotice('), 'Detail honest state helper used');
  assert(SRC.overview.includes('waveformMissingNotice('), 'Overview honest state helper used');
});

runTest('no own analysis', 'XML deck-load path never calls analyzeAudioBuffer', () => {
  const startMarker = 'const handleSelectTrackFromXml = async';
  const endMarker = '// ---- Phase 4: Project persistence & desktop write path';
  const start = SRC.app.indexOf(startMarker);
  const end = SRC.app.indexOf(endMarker, start);
  assert(start >= 0, 'Deck-load function found');
  assert(end > start, 'Deck-load function end marker found');
  const deckLoadSource = SRC.app.slice(start, end);
  assert(!deckLoadSource.includes('analyzeAudioBuffer('), 'No own analysis in the Rekordbox deck path');
});

// ---------------------------------------------------------------------------
console.log('═══════════════════════════════════════════════════════════════════');
console.log('  RENDERER ORIGINAL-DATA & NO-SYNTHESIS TEST SUITE              ');
console.log('═══════════════════════════════════════════════════════════════════\n');

const bySuite = new Map<string, TestResult[]>();
for (const r of results) {
  if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
  bySuite.get(r.suite)!.push(r);
}

for (const [suite, suiteResults] of bySuite) {
  console.log(`─── ${suite} ───`);
  suiteResults.forEach((r, i) => {
    const status = r.passed ? 'PASS' : 'FAIL';
    console.log(`[ ${status} ] #${i + 1} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  });
  console.log('');
}

const failed = results.filter((r) => !r.passed);
console.log('───────────────────────────────────────────────────────────────────');
console.log(`Total: ${results.length} | Passed: ${results.length - failed.length} | Failed: ${failed.length}`);
console.log('═══════════════════════════════════════════════════════════════════\n');
if (failed.length > 0) process.exit(1);
