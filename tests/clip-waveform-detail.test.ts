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
import { makeAudioBuffer } from './support/editingHarness';
import { DataOrigin, PaletteClip } from '../src/types/rekordbox';

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

// #2: native analysis buckets are honoured and RGB gradient is applied
{
  const buffer = makeAudioBuffer(makeClipSignal(), SAMPLE_RATE);
  const clip = makeClip({
    audioBuffer: buffer,
    analysis: analyzeAudioBuffer(buffer as AudioBuffer, DataOrigin.REKORDBOX_ANLZ),
  });
  const { canvas, rec } = makeStubCanvas(260, 36);
  drawDetailedClipWaveform(canvas, clip, 'RGB', false);

  const columns = new Set(rec.fills.filter((f) => f.h > 0).map((f) => f.x));
  assert.ok(columns.size >= 260 * 0.8, 'dense RGB waveform');
  assert.ok(rec.styles.has('gradient(rgb)'), 'RGB vertical gradient used');
  console.log('[ PASS ] #2 Native analysis buckets render with RGB gradient');
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

console.log('clip waveform detail: 6 checks OK');
