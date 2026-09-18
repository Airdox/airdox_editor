/**
 * @license
 * Deck waveform source tests — the guarantee that a track loaded into the deck
 * always shows a waveform, with honest provenance.
 *
 * Regression background: builds after v0.5.10 dropped the automatic ANLZ
 * assignment and every fallback, so a Rekordbox track loaded from an XML
 * export rendered an empty bar. These tests pin the priority chain
 * (ANLZ → collection analysis → own audio → tagged beatgrid preview).
 *
 * Run with: npx tsx tests/deck-waveform-source.test.ts
 */

import {
  describeDeckWaveformSource,
  resolveDeckWaveform,
} from '../src/waveform/deckWaveformSource';
import { selectTrackWaveform } from '../src/waveform/renderModel';
import { DataOrigin, TrackModel, WaveformAnalysisData } from '../src/types/rekordbox';

interface FakeAudioBuffer {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  duration: number;
  getChannelData(channel: number): Float32Array;
}

function fakeBuffer(durationSec: number, sampleRate = 44100): FakeAudioBuffer {
  const length = Math.floor(durationSec * sampleRate);
  const values = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    // Deterministic 4 Hz pulse — no randomness, so bucket counts stay stable.
    values[i] = Math.sin((2 * Math.PI * 4 * i) / sampleRate) * 0.5;
  }
  return {
    sampleRate,
    numberOfChannels: 2,
    length,
    duration: durationSec,
    getChannelData: () => values,
  };
}

const asBuffer = (b: FakeAudioBuffer) => b as unknown as AudioBuffer;

function analysis(origin: DataOrigin, length = 64, sourceTag?: string): WaveformAnalysisData {
  return {
    length,
    peaks: new Float32Array(length),
    peaksL: new Float32Array(length),
    peaksR: new Float32Array(length),
    lowEnergy: new Float32Array(length),
    midEnergy: new Float32Array(length),
    highEnergy: new Float32Array(length),
    origin,
    sourceTag,
  };
}

function makeTrack(overrides: Partial<TrackModel> = {}): TrackModel {
  return {
    id: 'track-1',
    title: 'Test Track',
    artist: 'Test Artist',
    album: 'Test Album',
    bpm: 128,
    key: '8A',
    duration: 300,
    sampleRate: 44100,
    channels: 2,
    originalSha256: 'TEST',
    isOriginalUntouched: true,
    audioBuffer: null,
    beatGrid: { firstBeat: 0.3, bpm: 128, meter: 4, beats: [], origin: DataOrigin.REKORDBOX_XML },
    cues: [],
    loops: [],
    analysis: null,
    origin: DataOrigin.REKORDBOX_XML,
    workingSegments: [],
    ...overrides,
  };
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

function runTest(name: string, fn: () => void) {
  const t0 = performance.now();
  try {
    fn();
    results.push({ name, passed: true, durationMs: Math.round((performance.now() - t0) * 100) / 100 });
  } catch (err: any) {
    results.push({ name, passed: false, error: err?.message || String(err), durationMs: 0 });
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

// ─── 1. ANLZ wins over everything ────────────────────────────────────────────
runTest('ANLZ variants are reported as ANLZ and keep the track untouched', () => {
  const track = makeTrack({
    analysis: analysis(DataOrigin.LOCAL_ANALYSIS, 100),
    analysisVariants: [analysis(DataOrigin.REKORDBOX_ANLZ, 150, 'PWV5')],
    audioBuffer: asBuffer(fakeBuffer(30)),
  });
  const { track: out, source } = resolveDeckWaveform(track);
  assertEqual(source, 'ANLZ', 'variants must win');
  assertEqual(out, track, 'track object must not be replaced');
});

runTest('A single ANLZ-origin analysis is reported as ANLZ', () => {
  const track = makeTrack({ analysis: analysis(DataOrigin.REKORDBOX_ANLZ, 200, 'PWV3') });
  const { source } = resolveDeckWaveform(track);
  assertEqual(source, 'ANLZ', 'ANLZ origin must be recognised');
});

// ─── 2. Collection analysis is kept, never overwritten ──────────────────────
runTest('Existing non-ANLZ analysis is kept as COLLECTION', () => {
  const existing = analysis(DataOrigin.PROJECT, 120);
  const track = makeTrack({ analysis: existing, audioBuffer: asBuffer(fakeBuffer(30)) });
  const { track: out, source } = resolveDeckWaveform(track);
  assertEqual(source, 'COLLECTION', 'existing analysis must be reported');
  assertEqual(out.analysis, existing, 'existing analysis must survive');
});

// ─── 3. Own audio is analysed when no ANLZ exists ───────────────────────────
runTest('Decoded audio without ANLZ yields a LOCAL_ANALYSIS waveform', () => {
  const track = makeTrack({ duration: 30, audioBuffer: asBuffer(fakeBuffer(30)) });
  const { track: out, source } = resolveDeckWaveform(track);
  assertEqual(source, 'LOCAL_AUDIO', 'own audio must be analysed');
  assert(!!out.analysis, 'analysis must exist');
  assertEqual(out.analysis!.origin, DataOrigin.LOCAL_ANALYSIS, 'origin must be LOCAL_ANALYSIS');
  assert(out.analysis!.length >= 100, 'analysis must have buckets');
  // The audio itself is not replaced.
  assertEqual(out.audioBuffer, track.audioBuffer, 'audio buffer must stay untouched');
});

// ─── 4. No audio at all → tagged beatgrid preview ───────────────────────────
runTest('Metadata-only track gets a tagged GENERATED_FALLBACK preview', () => {
  const track = makeTrack({ duration: 240, audioBuffer: null });
  const { track: out, source } = resolveDeckWaveform(track);
  assertEqual(source, 'METADATA_PREVIEW', 'preview must be produced');
  assert(!!out.analysis, 'analysis must exist');
  assertEqual(out.analysis!.origin, DataOrigin.GENERATED_FALLBACK, 'origin must be GENERATED_FALLBACK');
  assert(out.analysis!.length > 0, 'preview must span the track');
});

runTest('Zero-duration track without audio stays empty (nothing to draw)', () => {
  const track = makeTrack({ duration: 0, audioBuffer: null });
  const { track: out, source } = resolveDeckWaveform(track);
  assertEqual(source, 'NONE', 'no duration means no preview');
  assertEqual(out.analysis, null, 'no analysis must be invented');
});

// ─── 5. The deck is never an empty bar ──────────────────────────────────────
runTest('Every loadable track ends up with a drawable waveform', () => {
  const cases: Array<{ label: string; track: TrackModel }> = [
    {
      label: 'ANLZ variants only',
      track: makeTrack({ analysisVariants: [analysis(DataOrigin.REKORDBOX_ANLZ, 64, 'PWV5')] }),
    },
    {
      label: 'ANLZ analysis + variants (real merge result)',
      track: makeTrack({
        analysis: analysis(DataOrigin.REKORDBOX_ANLZ, 64, 'PWV5'),
        analysisVariants: [analysis(DataOrigin.REKORDBOX_ANLZ, 64, 'PWV5')],
      }),
    },
    { label: 'collection analysis', track: makeTrack({ analysis: analysis(DataOrigin.REKORDBOX_XML, 64) }) },
    {
      label: 'decoded audio',
      track: makeTrack({ duration: 60, audioBuffer: asBuffer(fakeBuffer(60)) }),
    },
    { label: 'metadata only', track: makeTrack({ duration: 60 }) },
  ];
  for (const { label, track } of cases) {
    const { track: out, source } = resolveDeckWaveform(track);
    assertNotEqual(source, 'NONE', `${label}: a track with duration must resolve a source`);
    // Assert against the renderer's own selector, not against `analysis`
    // alone: the detail view draws the zoom-appropriate ANLZ variant.
    const drawable = selectTrackWaveform(out, out.duration, 800);
    assert(!!drawable && drawable.length > 0, `${label}: renderer must have columns to draw`);
  }
});

// ─── 6. Provenance is always reported in words ──────────────────────────────
runTest('Every source has a human-readable provenance text', () => {
  for (const source of ['ANLZ', 'COLLECTION', 'LOCAL_AUDIO', 'METADATA_PREVIEW', 'NONE'] as const) {
    const text = describeDeckWaveformSource(source);
    assert(typeof text === 'string' && text.length > 10, `${source} must be described`);
  }
  assert(
    /ANLZ/.test(describeDeckWaveformSource('ANLZ')),
    'ANLZ text must name the Rekordbox source'
  );
  assert(
    /Vorschau/.test(describeDeckWaveformSource('METADATA_PREVIEW')),
    'preview text must say it is a preview'
  );
});

function assertNotEqual<T>(actual: T, unexpected: T, message: string) {
  if (actual === unexpected) throw new Error(`${message} — got ${JSON.stringify(actual)}`);
}

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  DECK WAVEFORM SOURCE TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════════\n');
console.log('Test Results:\n');
let passedCount = 0;
let failedCount = 0;
results.forEach((r, idx) => {
  const status = r.passed ? '\x1b[32m' : '\x1b[31m';
  console.log(`${status}[${r.passed ? ' PASS ' : ' FAIL '}]${'\x1b[0m'} #${idx + 1} ${r.name} (${r.durationMs}ms)`);
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
process.exit(failedCount > 0 ? 1 : 0);
