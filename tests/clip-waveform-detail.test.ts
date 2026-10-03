/**
 * Regression suite for the detailed palette clip waveform renderer.
 *
 * The palette must no longer show coarse 48/64 peak bars: every clip tile is
 * rendered from real analysis data (native ANLZ buckets or per-sample
 * computation) with the same BLUE / RGB / 3BAND visual language as the main
 * DetailWaveform. These checks run on a stubbed 2D context in Node.
 */

import assert from 'node:assert/strict';
import { drawDetailedClipWaveform } from '../src/components/ClipWaveform';
import { analyzeAudioBuffer } from '../src/waveform/analyzer';
import {
  REKORDBOX_BASELINE_HEX,
  REKORDBOX_CORE_CYAN_HEX,
  REKORDBOX_PEAK_WHITE_HEX,
  renderRekordboxWaveformColumn,
  sampleWaveformColumn,
  spectralRgb,
} from '../src/waveform/spectralColor';
import { makeAudioBuffer } from './support/editingHarness';
import { DataOrigin, PaletteClip, WaveformAnalysisData } from '../src/types/rekordbox';

const SAMPLE_RATE = 1000;

/** 10s synthetic clip: 2Hz kick envelope + alternating hi-hat energy. */
function makeClipSignal(): Float32Array {
  const seconds = 10;
  const n = seconds * SAMPLE_RATE;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const beatPhase = (t * 2) % 1; // 120 BPM kicks
    const kick = Math.exp(-beatPhase * 6) * 0.7 * Math.sin(2 * Math.PI * 55 * t);
    const hat = (i % 2 === 0 ? 0.22 : -0.22) * (0.4 + 0.6 * Math.abs(Math.sin(t * 7)));
    data[i] = kick + hat;
  }
  return data;
}

function makeClip(overrides: Partial<PaletteClip> = {}): PaletteClip {
  const signal = makeClipSignal();
  return {
    id: 'clip-test',
    name: 'Test Clip',
    sourceTrackId: 'track-1',
    sourceTrackName: 'Test Track',
    sourceStart: 0,
    sourceEnd: 10,
    duration: 10,
    beats: 20,
    bars: 5,
    bpm: 120,
    key: '3A',
    color: '#00a2ff',
    audioBuffer: makeAudioBuffer(signal, SAMPLE_RATE),
    origin: DataOrigin.LOCAL_ANALYSIS,
    ...overrides,
  };
}

interface FillCall {
  x: number;
  style: string;
  h: number;
}

interface StubContext {
  fills: FillCall[];
  strokes: number;
  texts: string[];
  styles: Set<string>;
}

function makeStubCanvas(width: number, height: number): { canvas: HTMLCanvasElement; rec: StubContext } {
  const rec: StubContext = { fills: [], strokes: 0, texts: [], styles: new Set() };
  let currentStyle = '';

  const ctx = {
    clearRect() {},
    fillRect(x: number, _y: number, w: number, h: number) {
      if (w === 1) rec.fills.push({ x, style: currentStyle, h });
      rec.styles.add(currentStyle);
    },
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    stroke() {
      rec.strokes++;
      rec.styles.add(currentStyle);
    },
    fillText(text: string) {
      rec.texts.push(text);
    },
    createLinearGradient() {
      const id = 'gradient(rgb)';
      return {
        addColorStop() {},
        __id: id,
      };
    },
    set fillStyle(v: string | CanvasGradient) {
      currentStyle = typeof v === 'string' ? v : (v as unknown as { __id: string }).__id;
    },
    get fillStyle() {
      return currentStyle;
    },
    set strokeStyle(v: string) {
      currentStyle = v;
    },
    get strokeStyle() {
      return currentStyle;
    },
    lineWidth: 1,
    font: '',
    textAlign: '',
  };

  const canvas = {
    width,
    height,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;

  return { canvas, rec };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  PALETTE CLIP WAVEFORM DETAIL SUITE');
console.log('═══════════════════════════════════════════════════════════════');

// #1: clip without native analysis still renders a dense detailed waveform
{
  const clip = makeClip();
  const { canvas, rec } = makeStubCanvas(260, 36);
  drawDetailedClipWaveform(canvas, clip, 'BLUE', false);

  const columns = new Set(rec.fills.filter((f) => f.h > 0).map((f) => f.x));
  assert.ok(
    columns.size >= 260 * 0.8,
    `expected dense waveform (>=80% of 260 columns), got ${columns.size}`
  );
  assert.ok(rec.styles.has('#159fe8'), 'BLUE base colour used');
  console.log('[ PASS ] #1 Clip without ANLZ analysis renders dense detailed waveform (BLUE)');
}

// #2: native analysis buckets are honoured and RGB columns are coloured from
// their real spectral content (rekordbox-authentic): a bass-heavy drop half
// must render red-dominant, a hat/air-heavy break half blue-dominant.
{
  const seconds = 10;
  const n = seconds * SAMPLE_RATE;
  const sectioned = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    if (t < 5) {
      // Drop: loud low-frequency content (smooth transitions, high amplitude)
      sectioned[i] = 0.85 * Math.sin(2 * Math.PI * 8 * t);
    } else {
      // Break: hats/air only (large sample-to-sample deltas, lower amplitude)
      sectioned[i] = (i % 2 === 0 ? 0.35 : -0.35);
    }
  }
  const buffer = makeAudioBuffer(sectioned, SAMPLE_RATE);
  const clip = makeClip({
    audioBuffer: buffer,
    analysis: analyzeAudioBuffer(buffer as AudioBuffer, DataOrigin.REKORDBOX_ANLZ),
  });
  const { canvas, rec } = makeStubCanvas(260, 36);
  drawDetailedClipWaveform(canvas, clip, 'RGB', false);

  const columns = new Set(rec.fills.filter((f) => f.h > 0).map((f) => f.x));
  assert.ok(columns.size >= 260 * 0.8, 'dense RGB waveform');
  assert.ok(!rec.styles.has('gradient(rgb)'), 'static vertical gradient must no longer be used');

  const parseRgb = (style: string): [number, number, number] | null => {
    const m = style.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const dominant = (xFrom: number, xTo: number): [number, number, number] => {
    let r = 0, g = 0, b = 0, count = 0;
    for (const f of rec.fills) {
      if (f.x < xFrom || f.x >= xTo || f.h <= 0) continue;
      const rgb = parseRgb(f.style);
      if (!rgb) continue;
      r += rgb[0]; g += rgb[1]; b += rgb[2]; count++;
    }
    assert.ok(count > 0, `coloured columns exist in ${xFrom}-${xTo}`);
    return [r / count, g / count, b / count];
  };

  const [dropR, , dropB] = dominant(0, 130);
  const [breakR, , breakB] = dominant(130, 260);
  assert.ok(dropR > dropB, `drop half must be red-dominant (r=${dropR.toFixed(0)} b=${dropB.toFixed(0)})`);
  assert.ok(breakB > breakR, `break half must be blue-dominant (r=${breakR.toFixed(0)} b=${breakB.toFixed(0)})`);
  assert.ok(dropR > breakR, 'red energy concentrates in the drop');
  console.log('[ PASS ] #2 RGB columns are spectrally coloured: drop=red, break=blue (rekordbox-authentic)');
}

// #3: 3BAND mode draws the three band layers (red low / cyan mid / white high)
{
  const clip = makeClip();
  const { canvas, rec } = makeStubCanvas(260, 36);
  drawDetailedClipWaveform(canvas, clip, '3BAND', false);

  assert.ok(rec.styles.has('rgba(255, 59, 69, 0.72)'), 'low band layer');
  assert.ok(rec.styles.has('rgba(24, 216, 223, 0.48)'), 'mid band layer');
  assert.ok(rec.styles.has('rgba(239, 252, 255, 0.30)'), 'high band layer');
  console.log('[ PASS ] #3 3BAND mode renders low/mid/high band layers');
}

// #4: beatgrid overlay is drawn from clip beat offsets
{
  const beatOffsets = Array.from({ length: 20 }, (_, i) => i * 0.5);
  const clip = makeClip({ beatOffsets });
  const { canvas, rec } = makeStubCanvas(260, 36);
  drawDetailedClipWaveform(canvas, clip, 'BLUE', true);

  const barLines = rec.fills.length >= 0 && rec.strokes > 0;
  assert.ok(barLines, 'beat/bar overlay strokes drawn');
  assert.ok(rec.strokes >= 5, `expected bar lines for 5 bars, got ${rec.strokes} strokes`);
  console.log('[ PASS ] #4 Beatgrid overlay rendered from beat offsets');
}

// #5: silent / data-less clip shows an honest placeholder, no invented audio
{
  const clip = makeClip({ audioBuffer: undefined, analysis: undefined });
  const { canvas, rec } = makeStubCanvas(260, 36);
  drawDetailedClipWaveform(canvas, clip, 'BLUE', false);

  assert.equal(rec.fills.filter((f) => f.h > 0).length, 0, 'no waveform invented');
  assert.ok(rec.texts.some((t) => t.includes('Keine Wellenformdaten')), 'placeholder shown');
  console.log('[ PASS ] #5 Missing data shows placeholder instead of invented waveform');
}

// #6: quiet ranges stay honest (zero buckets are not bridged)
{
  const signal = makeClipSignal();
  signal.fill(0, 4000, 6000); // 2s of digital silence in the middle
  const clip = makeClip({ audioBuffer: makeAudioBuffer(signal, SAMPLE_RATE) });
  const { canvas, rec } = makeStubCanvas(260, 36);
  drawDetailedClipWaveform(canvas, clip, 'BLUE', false);

  // The hard cut to silence produces a real click transient in the boundary
  // buckets (as in any honest waveform), so only the inner region must be empty.
  const silentColumns = rec.fills.filter((f) => f.h > 0 && f.x >= 108 && f.x <= 152);
  assert.equal(silentColumns.length, 0, 'silent region must stay empty');
  console.log('[ PASS ] #6 Silent clip region renders empty (no invented floor)');
}

// #7: Rekordbox EDIT-mode 1px vertical column lock (DetailWaveform & TrackOverview)
{
  // 7a. Monochrome ANLZ buckets (low === mid === high) never bleach to white/beige
  assert.equal(
    spectralRgb(0.85, 0.85, 0.85),
    'rgb(229, 28, 36)',
    'monochrome peak maps to Rekordbox kick red #E51C24, never white/beige'
  );
  assert.equal(
    spectralRgb(0.45, 0.45, 0.45),
    'rgb(0, 240, 255)',
    'monochrome mid maps to Rekordbox cyan #00F0FF'
  );
  assert.equal(
    spectralRgb(0.28, 0.28, 0.28),
    'rgb(160, 51, 255)',
    'monochrome overtone maps to Rekordbox violet #A033FF'
  );

  // 7b. Silent column (< 0.01) draws ONLY 1px #00A2E8 baseline at centerY
  const { canvas: cSilent, rec: rSilent } = makeStubCanvas(10, 100);
  const ctxSilent = cSilent.getContext('2d')!;
  renderRekordboxWaveformColumn(
    ctxSilent,
    4,
    50,
    44,
    { totalAmp: 0.002, low: 0, mid: 0, high: 0 },
    'RGB'
  );
  assert.equal(rSilent.fills.length, 1, 'silent column emits only 1px baseline');
  assert.equal(rSilent.fills[0].style, REKORDBOX_BASELINE_HEX);
  assert.equal(rSilent.fills[0].h, 1);

  // 7c. High-peak column (> 0.7) emits outer edge, #E51C24 body, #00F0FF cyan core, and #FFFFFF peak highlight
  const { canvas: cPeak, rec: rPeak } = makeStubCanvas(10, 100);
  const ctxPeak = cPeak.getContext('2d')!;
  renderRekordboxWaveformColumn(
    ctxPeak,
    5,
    50,
    44,
    { totalAmp: 0.9, low: 0.9, mid: 0.5, high: 0.2 },
    'RGB'
  );
  assert.equal(rPeak.fills.length, 4, 'high-peak RGB column emits 4 concentric 1px vertical layers');
  assert.ok(rPeak.fills.every((f) => f.x === 5), 'every layer is aligned on column x=5');
  assert.ok(rPeak.fills.some((f) => f.style === 'rgb(229, 28, 36)'), 'includes #E51C24 bass body');
  assert.ok(rPeak.fills.some((f) => f.style === REKORDBOX_CORE_CYAN_HEX), 'includes #00F0FF cyan core');
  assert.ok(rPeak.fills.some((f) => f.style === REKORDBOX_PEAK_WHITE_HEX), 'includes #FFFFFF peak center highlight');

  // 7d. Coarse 100-bucket container across a 1300px overview/detail canvas renders continuous
  //     1px columns (no 100-line barcode gaps and no 80px wide uniform flat blocks)
  const coarseBuckets = 100;
  const duration = 356.9;
  const coarsePeaks = new Float32Array(coarseBuckets).fill(0.8);
  coarsePeaks[0] = 0; // leading silence stays 0
  const coarseAnalysis: WaveformAnalysisData = {
    peaks: coarsePeaks,
    peaksL: coarsePeaks,
    peaksR: coarsePeaks,
    lowEnergy: new Float32Array(coarseBuckets).fill(0.8),
    midEnergy: new Float32Array(coarseBuckets).fill(0.8),
    highEnergy: new Float32Array(coarseBuckets).fill(0.8),
    length: coarseBuckets,
    secPerBucket: duration / coarseBuckets,
    origin: DataOrigin.REKORDBOX_ANLZ,
  };
  const beatGrid = { bpm: 127.5, firstBeat: 0.05 };
  const viewStart = 10.0;
  const viewDur = 15.0;
  const width = 600;
  const heights: number[] = [];
  for (let x = 0; x < width; x++) {
    const t0 = viewStart + (x / width) * viewDur;
    const t1 = viewStart + ((x + 1) / width) * viewDur;
    const s = sampleWaveformColumn(coarseAnalysis, t0, t1, duration, beatGrid);
    heights.push(Math.round(s.totalAmp * 1000));
  }
  assert.ok(heights.every((h) => h > 0), 'no empty barcode gaps in active region');
  const uniqueHeights = new Set(heights);
  assert.ok(uniqueHeights.size > 40, `expected fine 1px column profile, got ${uniqueHeights.size} distinct heights`);
  const silentSample = sampleWaveformColumn(coarseAnalysis, 0.1, 0.2, duration, beatGrid);
  assert.equal(silentSample.totalAmp, 0, 'silent bucket #0 stays strictly 0');
  console.log('[ PASS ] #7 Rekordbox EDIT-mode 1px vertical column lock verified');
}

console.log('clip waveform detail: 7 checks OK');
