/**
 * @license
 * Visual-lock tests: the renderers must apply ONLY the documented ANLZ
 * visualizations (Deep Symmetry / crate-digger) to the stored values —
 * nothing recombined, nothing invented.
 *
 *  R1 – PWV5: stored 3-bit red/green/blue ARE the column color, stored
 *       5-bit value the height (rgbColumnColor pass-through).
 *  R2 – Blue waveform: stored whiteness maps darkest blue → near white.
 *  R3 – PWV4: two-tone columns, back = rgb·luminance, front = boosted.
 *  R4 – 3-band: lows dark blue, mids amber (translucent), highs white,
 *       drawn low → mid → high on the same axis.
 *  R5 – Comb geometry + alternate bar shading (reference 01/02).
 *  R6 – End-to-end PWV5 pass-through via parseAnlzBinary.
 *  (No-ANLZ case: the renderers draw an empty pane like the original —
 *   nothing to compute, nothing to test in the pure model.)
 *
 * Run with: npx tsx tests/render-look.test.ts
 */

import {
  MONO_BLUE_DARK,
  MONO_BLUE_WHITE,
  monoBlueColor,
  BAR_SHADE_FILL,
  columnDrawWidth,
  isBarShaded,
  pwv4BackColor,
  pwv4FrontColor,
  PWV4_FRONT_BOOST,
  rgbColumnColor,
  THREE_BAND_HIGH,
  THREE_BAND_LOW,
  THREE_BAND_MID,
  THREE_BAND_MID_ALPHA,
  threeBandLayers,
} from '../src/waveform/renderModel';
import { parseAnlzBinary } from '../src/rekordbox/databaseExtractor';

import { runTest, assert, same, report } from './helpers/microTest.mjs';

// ─── R1: PWV5 stored RGB is the column color ────────────────────────────────
runTest('R1 PWV5 color', 'Components pass through verbatim', () => {
  const red = rgbColumnColor(1, 0, 0);
  same(red.r, 255, 'red full');
  same(red.g, 0, 'no invented green');
  same(red.b, 0, 'no invented blue');
  const half = rgbColumnColor(0.5, 0.25, 1);
  same(half.r, 128, '0.5 → 128');
  same(half.g, 64, '0.25 → 64');
  same(half.b, 255, '1 → 255');
  const clamped = rgbColumnColor(2, -1, 0.5);
  same(clamped.r, 255, 'clamp high');
  same(clamped.g, 0, 'clamp low');
});

// ─── R2: blue waveform whiteness ramp ────────────────────────────────────────
runTest('R2 blue ramp', '0 = darkest blue, 1 = near white, monotonic', () => {
  const dark = monoBlueColor(0);
  same(dark.r, MONO_BLUE_DARK.r, 'dark red');
  same(dark.b, MONO_BLUE_DARK.b, 'dark blue');
  const white = monoBlueColor(1);
  same(white.r, MONO_BLUE_WHITE.r, 'white red');
  same(white.b, MONO_BLUE_WHITE.b, 'white blue');
  const mid = monoBlueColor(0.5);
  assert(mid.b > dark.b && white.b >= mid.b, 'blue monotonic');
  assert(mid.r > dark.r, 'whiter with whiteness');
  same(monoBlueColor(-0.2).r, MONO_BLUE_DARK.r, 'clamped below');
  same(monoBlueColor(1.4).r, MONO_BLUE_WHITE.r, 'clamped above');
});

// ─── R3: PWV4 two-tone formulas ──────────────────────────────────────────────
runTest('R3 PWV4', 'back = rgb·luminance, front = rgb·luminance + boost', () => {
  const back = pwv4BackColor(1, 0.5, 0, 0.5);
  same(back.r, 128, 'red scaled by luminance');
  same(back.g, 64, 'green scaled by luminance');
  same(back.b, 0, 'blue stays 0');
  const front = pwv4FrontColor(1, 0.5, 0, 0.5);
  const boostPx = Math.round(PWV4_FRONT_BOOST * 255);
  same(front.r, Math.min(255, 128 + boostPx), 'front boosted, clipped at 1');
  same(front.b, boostPx, 'front blue from boost alone');
  assert(front.r > back.r, 'front brighter than back');
});

// ─── R4: documented 3-band look ──────────────────────────────────────────────
runTest('R4 3-band', 'dark blue / amber / white on the same axis, high last', () => {
  const layers = threeBandLayers(1, 0.5, 0.25, 100);
  same(layers.length, 3, 'three layers');
  same(layers[0].color.b, THREE_BAND_LOW.b, 'low dark blue');
  same(layers[0].color.r, 0, 'low no red');
  same(layers[1].color.r, THREE_BAND_MID.r, 'mid amber red');
  same(layers[1].color.g, THREE_BAND_MID.g, 'mid amber green');
  same(layers[2].color.r, THREE_BAND_HIGH.r, 'high white');
  same(layers[0].alpha, 1, 'low opaque');
  same(layers[1].alpha, THREE_BAND_MID_ALPHA, 'mid translucent (brown overlap)');
  same(layers[2].alpha, 1, 'high opaque, drawn last');
  same(layers[0].halfHeight, 100, 'low verbatim');
  same(layers[1].halfHeight, 50, 'mid verbatim');
  same(layers[2].halfHeight, 25, 'high verbatim');
  const silent = threeBandLayers(0, 0, 0, 100);
  assert(silent.every((l) => l.halfHeight === 0), 'silent bands draw nothing');
});

// ─── R5: comb + shading ──────────────────────────────────────────────────────
runTest('R5 comb/shading', '1 px gap above 2 px slots, even bars shaded', () => {
  same(columnDrawWidth(2), 2, 'solid below 2 px');
  same(columnDrawWidth(3), 2, 'gap at 3 px');
  same(columnDrawWidth(0), 1, 'degenerate fallback');
  same(isBarShaded(2), true, 'even shaded');
  same(isBarShaded(3), false, 'odd plain');
  same(BAR_SHADE_FILL, '#101117', 'shade tone pinned');
});

// ─── R6: PWV5 end-to-end pass-through ────────────────────────────────────────
function packRgb5(low: number, mid: number, high: number, peak: number): number {
  return ((low & 0x07) << 13) | ((mid & 0x07) << 10) | ((high & 0x07) << 7) | ((peak & 0x1f) << 2);
}

function buildPwv5Buffer(entries: number[]): ArrayBuffer {
  const section = new Uint8Array(0x18 + entries.length * 2);
  const view = new DataView(section.buffer);
  for (let i = 0; i < 4; i++) view.setUint8(i, 'PWV5'.charCodeAt(i));
  view.setUint32(4, 0x18, false);
  view.setUint32(8, section.length, false);
  view.setUint32(0x0c, 2, false);
  view.setUint32(0x10, entries.length, false);
  view.setUint32(0x14, 0x00960000, false);
  entries.forEach((v, i) => view.setUint16(0x18 + i * 2, v, false));
  return section.buffer;
}

runTest('R6 pass-through', 'Decoded PWV5 columns stay pure red/green/blue', () => {
  const extraction = parseAnlzBinary(
    buildPwv5Buffer([
      packRgb5(7, 0, 0, 31),
      packRgb5(0, 7, 0, 31),
      packRgb5(0, 0, 7, 31),
    ])
  );
  same(extraction.waveformVariants.length, 1, 'PWV5 variant decoded');
  const v = extraction.waveformVariants[0];
  same(v.sourceTag, 'PWV5', 'tag kept');
  const red = rgbColumnColor(v.lowEnergy[0], v.midEnergy[0], v.highEnergy[0]);
  same(red.r, 255, 'red column pure');
  same(red.g + red.b, 0, 'no invented components');
  const green = rgbColumnColor(v.lowEnergy[1], v.midEnergy[1], v.highEnergy[1]);
  same(green.g, 255, 'green column pure');
  const blue = rgbColumnColor(v.lowEnergy[2], v.midEnergy[2], v.highEnergy[2]);
  same(blue.b, 255, 'blue column pure');
  same(v.peaks[0], 1, 'stored height decoded');
  same(v.whiteness, undefined, 'no whiteness invented for PWV5');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────

report('RENDER LOOK / DOCUMENTED VISUALIZATION TEST SUITE (R1–R6)');
