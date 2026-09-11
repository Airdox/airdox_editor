/**
 * @license
 * Regression suite for the reworked palette tool (PR #11 line, ported to the
 * unified pipeline branch):
 *
 *  P1 – PaletteWaveformData carries genuine analysis buckets, clipped to the
 *       clip range (verbatim ANLZ values, no re-analysis of rendered audio).
 *  P2 – Drag & drop contract: PalettePanel/ClipDeckView mark clips with the
 *       internal MIME type; DetailWaveform maps the pointer to deck time and
 *       never lets a clip drop fall through to the file importer.
 *  P3 – Project round-trip: the palette waveform survives save/load verbatim.
 *
 * Run with: npx tsx tests/palette-clip.test.ts
 */

import fs from 'node:fs';
import { DataOrigin, PaletteClip, PaletteWaveformData } from '../src/types/rekordbox';
import { serializeProject, deserializeProject } from '../src/rekordbox/projectFile';

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

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  PALETTE CLIP TOOL TEST SUITE (P1–P3)                            ');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ─── P1: source contracts in App.tsx ────────────────────────────────────────

const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

runTest('P1 waveform truth', 'extractPaletteWaveform clips genuine buckets, never re-analyzes', () => {
  const fnStart = appSource.indexOf('function extractPaletteWaveform');
  assert(fnStart >= 0, 'extractPaletteWaveform exists');
  const fnEnd = appSource.indexOf('\n}', fnStart);
  const fn = appSource.slice(fnStart, fnEnd);
  assert(fn.includes('track.analysisVariants'), 'reads genuine analysis variants');
  assert(!fn.includes('analyzeAudioBuffer'), 'no own audio analysis inside the extraction');
  assert(fn.includes('analysis.peaks[i]'), 'peaks come from stored analysis buckets');
  assert(fn.includes('analysis.origin'), 'origin is passed through verbatim');
});

runTest('P1 waveform truth', 'Palette clip creation attaches the genuine waveform', () => {
  const idx = appSource.indexOf('handleAddSelectionToPalette');
  assert(idx >= 0, 'palette add handler exists');
  const section = appSource.slice(idx, idx + 2200);
  assert(section.includes('extractPaletteWaveform(activeTrack, selection.start, selection.end)'),
    'clip receives ANLZ-derived waveform for its exact range');
});

runTest('P2 drag & drop', 'Insert supports a drop-time target clamped to the track', () => {
  assert(appSource.includes('handleInsertClipToDeckA = (clip: PaletteClip, dropTime: number = currentTime)'),
    'insert accepts an explicit drop time, defaulting to the playhead');
  assert(appSource.includes('Math.max(0, Math.min(activeTrack.duration, dropTime))'),
    'drop time is clamped to the track duration');
  assert(appSource.includes('onDropClip={(clipId, dropTime)'),
    'deck waveform is wired to the clip drop handler');
});

// ─── P2: drag sources & drop target ─────────────────────────────────────────

runTest('P2 drag & drop', 'PalettePanel clips are draggable with the internal MIME type', () => {
  const src = fs.readFileSync(new URL('../src/components/PalettePanel.tsx', import.meta.url), 'utf8');
  assert(src.includes('draggable'), 'clips are draggable');
  assert(src.includes("application/x-airdox-palette-clip"), 'internal MIME type set');
});

runTest('P2 drag & drop', 'ClipDeckView clips are draggable with the internal MIME type', () => {
  const src = fs.readFileSync(new URL('../src/components/ClipDeckView.tsx', import.meta.url), 'utf8');
  assert(src.includes('draggable'), 'clips are draggable');
  assert(src.includes("application/x-airdox-palette-clip"), 'internal MIME type set');
});

runTest('P2 drag & drop', 'DetailWaveform maps the pointer to deck time and shields the file importer', () => {
  const src = fs.readFileSync(new URL('../src/components/DetailWaveform.tsx', import.meta.url), 'utf8');
  assert(src.includes("getData('application/x-airdox-palette-clip')"), 'reads the clip MIME type first');
  const dropIdx = src.indexOf("getData('application/x-airdox-palette-clip')");
  const dropSection = src.slice(dropIdx, dropIdx + 900);
  assert(dropSection.includes('onDropClip(clipId, time)'), 'forwards clip id + pointer time');
  assert(dropSection.indexOf('return') < dropSection.indexOf('onDropFile'),
    'clip drops return before the file importer runs');
  assert(dropSection.includes('viewOffset + (x / waveformWidth) * viewDuration'),
    'pointer x is converted into deck time within the visible window');
});

// ─── P1b: verbatim rendering in the palette preview ─────────────────────────

runTest('P1 waveform truth', 'PalettePanel prefers the genuine waveform over legacy miniPeaks', () => {
  const src = fs.readFileSync(new URL('../src/components/PalettePanel.tsx', import.meta.url), 'utf8');
  assert(src.includes('clip.waveform && clip.waveform.peaks.length > 0'),
    'genuine waveform branch exists and wins');
  const genuineIdx = src.indexOf('clip.waveform && clip.waveform.peaks.length > 0');
  const legacyIdx = src.indexOf('clip.miniPeaks && clip.miniPeaks.length > 0');
  assert(genuineIdx >= 0 && legacyIdx > genuineIdx, 'legacy miniPeaks is only the fallback');
});

// ─── P3: project round-trip ─────────────────────────────────────────────────

function makeClip(): PaletteClip {
  const waveform: PaletteWaveformData = {
    peaks: [0.1, 0.5, 1, 0.25],
    lowEnergy: [0.9, 0.1, 0.2, 0.3],
    midEnergy: [0.2, 0.8, 0.1, 0.4],
    highEnergy: [0.05, 0.3, 0.9, 0.6],
    origin: DataOrigin.REKORDBOX_ANLZ,
  };
  return {
    id: 'clip-p3',
    name: 'Test Clip (2.0 Bars)',
    sourceTrackId: 'track-1',
    sourceTrackName: 'Test Track',
    sourceStart: 10,
    sourceEnd: 14,
    duration: 4,
    beats: 8,
    bars: 2,
    bpm: 128,
    key: '6A',
    color: '#00a2ff',
    miniPeaks: [0.2, 0.4],
    waveform,
    origin: DataOrigin.PROJECT,
  };
}

runTest('P3 round-trip', 'Palette waveform survives project save/load verbatim', () => {
  const json = serializeProject({
    projectName: 'Palette RT',
    activeTrackId: '',
    selection: null,
    tracks: [],
    paletteClips: [makeClip()],
  });
  const doc = deserializeProject(json);
  assertEqual(doc.paletteClips.length, 1, 'clip restored');
  const clip = doc.paletteClips[0];
  assert(!!clip.waveform, 'waveform restored');
  assertEqual(clip.waveform!.origin, DataOrigin.REKORDBOX_ANLZ, 'origin preserved');
  assertEqual(clip.waveform!.peaks.join(','), '0.1,0.5,1,0.25', 'peaks byte-identical');
  assertEqual(clip.waveform!.lowEnergy.join(','), '0.9,0.1,0.2,0.3', 'low band identical');
  assertEqual(clip.waveform!.midEnergy.join(','), '0.2,0.8,0.1,0.4', 'mid band identical');
  assertEqual(clip.waveform!.highEnergy.join(','), '0.05,0.3,0.9,0.6', 'high band identical');
});

runTest('P3 round-trip', 'Clips without waveform stay legacy-compatible', () => {
  const clip = makeClip();
  delete clip.waveform;
  const json = serializeProject({
    projectName: 'Palette Legacy',
    activeTrackId: '',
    selection: null,
    tracks: [],
    paletteClips: [clip],
  });
  const doc = deserializeProject(json);
  assertEqual(doc.paletteClips[0].waveform, undefined, 'no waveform invented on load');
  assertEqual(doc.paletteClips[0].miniPeaks?.join(','), '0.2,0.4', 'legacy miniPeaks preserved');
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

if (failedCount > 0) process.exit(1);
