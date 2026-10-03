/**
 * Rekordbox-authentic RGB spectral colouring and 1-px vertical column renderer
 * (Pioneer Rekordbox v6/v7 EDIT Mode Reference Lock — calibrated against
 * `rekordbox_edit.png` and `reference/01_rekordbox_edit_main_palette.png`).
 *
 * Reference colours measured from original Rekordbox EDIT mode:
 *   - Dominant Kick / Bass peak:   #E51C24 -> rgb(229, 28, 36) / core #F70402 -> rgb(247, 4, 2)
 *   - Outer Bass contour / decay:  #AA0B0A -> rgb(170, 11, 10) / #880015 -> rgb(136, 0, 21)
 *   - Kick attack transient spike: #91853C -> rgb(145, 133, 60) / #A5712B -> rgb(165, 113, 43)
 *   - Transient / Mid core:        #00F0FF -> rgb(0, 240, 255) / #3DB45A -> rgb(61, 180, 90)
 *   - Offbeat Hi-Hat / Synth:      #3776C4 -> rgb(55, 118, 196) / #A07BAF -> rgb(160, 123, 175)
 *   - Silence / Baseline:          #00A2E8 -> rgb(0, 162, 232)
 *   - Peak Center Highlight:       #FFFFFF -> rgb(255, 255, 255)
 */

import type { BeatGrid, WaveformAnalysisData, WaveformMode } from '../types/rekordbox';

export const REKORDBOX_BASELINE_HEX = '#00A2E8';
export const REKORDBOX_BASS_RED_HEX = '#E51C24';
export const REKORDBOX_BASS_EDGE_HEX = '#CC1010';
export const REKORDBOX_CORE_CYAN_HEX = '#00F0FF';
export const REKORDBOX_HIGH_VIOLET_HEX = '#A033FF';
export const REKORDBOX_PEAK_WHITE_HEX = '#FFFFFF';

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function computeSpectralChannels(low: number, mid: number, high: number): [number, number, number] {
  const l = Math.max(0, Math.min(1, low || 0));
  const m = Math.max(0, Math.min(1, mid || 0));
  const h = Math.max(0, Math.min(1, high || 0));

  const maxBand = Math.max(l, m, h);
  const minBand = Math.min(l, m, h);

  if (maxBand <= 0.01) {
    return [0, 162, 232];
  }

  // Monochrome ANLZ containers (PWV2 / PWV3 / PWAV) set low = mid = high = peak.
  // Never allow uniform bands to mix into white/beige (#FFFFFF / #FDF6E2); map
  // amplitude to Rekordbox's dynamic RGB palette instead.
  if (maxBand - minBand < 0.035 * maxBand) {
    if (maxBand >= 0.55) return [229, 28, 36];   // #E51C24 (Kick / Bass peak)
    if (maxBand >= 0.38) return [0, 240, 255];   // #00F0FF (Transient / Mid)
    if (maxBand >= 0.24) return [160, 51, 255];  // #A033FF (Hi-Hat / Overtone)
    if (maxBand >= 0.14) return maxBand >= 0.19 ? [204, 16, 16] : [136, 0, 21]; // #CC1010 / #880015
    return [0, 162, 232];                        // #00A2E8 (Quiet floor)
  }

  // Dominant kick/bass peak -> Pioneer Rekordbox #E51C24 -> rgb(229, 28, 36)
  if (l >= 0.55 && l >= m * 1.45 && l >= h * 1.75) {
    return [229, 28, 36];
  }

  // 3-band spectral mapping calibrated against Pioneer Rekordbox EDIT mode
  // (rekordbox_edit.png & 01_rekordbox_edit_main_palette.png):
  //   - r3=7,g3=0,b3=0 (kick)     -> (229..247, 4..28, 2..36)
  //   - r3=2,g3=3,b3=6 (offbeat)  -> (55, 118, 196) #3776c4
  //   - r3=5,g3=3,b3=5 (snare)    -> (160, 123, 175) #a07baf
  //   - r3=2,g3=5,b3=3 (mid/arp)  -> (61, 180, 90)  #3db45a
  const nl = l / maxBand;
  const nm = m / maxBand;
  const nh = h / maxBand;
  const floor = Math.min(nl, nm, nh) * 0.42;
  const denom = Math.max(0.001, 1 - floor);

  const cl = Math.max(0, (nl - floor) / denom);
  const cm = Math.max(0, (nm - floor) / denom);
  const ch = Math.max(0, (nh - floor) / denom);

  const sl = Math.pow(cl, 1.2);
  const sm = Math.pow(cm, 1.15);
  const sh = Math.pow(ch, 1.2);

  const lum = 0.72 + 0.28 * Math.pow(maxBand, 0.5);

  const r = clampByte(lum * (242 * sl + 28 * sm * (1 - sl) + 18 * sh * (1 - sl)));
  const g = clampByte(lum * (228 * sm + 72 * sh * (1 - sl * 0.55) + 12 * sl * (1 - sm)));
  const b = clampByte(lum * (242 * sh + 65 * sm * (1 - sl * 0.55) + 12 * sl * (1 - sm)));

  return [r, g, b];
}

/**
 * Computes the primary Rekordbox RGB body colour for a 1-px waveform column.
 * Always returns `rgb(r, g, b)` for direct Canvas and test-suite consumption.
 */
export function spectralRgb(low: number, mid: number, high: number): string {
  const [r, g, b] = computeSpectralChannels(low, mid, high);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Darker outer contour colour (#AA0B0A / #CC1010 for bass peaks) used at the
 * outer tips of each 1-px column to produce the Rekordbox vertical depth profile.
 */
export function spectralRgbEdge(low: number, mid: number, high: number): string {
  const [r, g, b] = computeSpectralChannels(low, mid, high);
  return `rgb(${clampByte(r * 0.68)}, ${clampByte(g * 0.62)}, ${clampByte(b * 0.65)})`;
}

/**
 * Brighter core tone of the same spectral mix, used for the inner highlight
 * pass that gives the rekordbox waveform its glowing centre while preserving
 * each column's dominant spectral channel.
 */
export function spectralRgbCore(low: number, mid: number, high: number): string {
  const [r, g, b] = computeSpectralChannels(low, mid, high);
  const rCore = clampByte(r + (255 - r) * 0.38);
  const gCore = clampByte(g + (240 - g) * 0.52);
  const bCore = clampByte(b + (255 - b) * 0.45);
  return `rgb(${rCore}, ${gCore}, ${bCore})`;
}

export interface WaveformColumnSample {
  totalAmp: number;
  low: number;
  mid: number;
  high: number;
}

/**
 * Samples or interpolates a single 1-px horizontal column `[t0, t1]` from
 * `WaveformAnalysisData`.
 *
 * - For high-resolution 150 Hz / 200 Hz data (`PWV5`, `PWV7`, `PWV3`, audio
 *   analyzer), aggregates all buckets intersecting `[t0, t1]` using peak-max
 *   so transients are never lost.
 * - When a single bucket spans multiple horizontal pixels (either deep zoom or
 *   a legacy `.DAT`-only preview container without `.EXT`), shapes sub-bucket
 *   columns along the beatgrid using the 4-phase Rekordbox EDIT beat profile
 *   measured from `rekordbox_edit.png`:
 *     1. Leading transient click spike right on the beat (`#91853c` olive-amber)
 *     2. Teardrop red kick body (`#a80b0a` -> `#f70402`)
 *     3. Slender offbeat hi-hat/snare/synth tail (`#3776c4` blue / `#a07baf` lavender / `#3db45a` green)
 *     4. Pre-beat pinch right before the next beat attack
 */
export function sampleWaveformColumn(
  analysis: WaveformAnalysisData,
  t0: number,
  t1: number,
  duration: number,
  beatGrid?: Pick<BeatGrid, 'bpm' | 'firstBeat'> | null
): WaveformColumnSample {
  const buckets = analysis.length;
  if (buckets <= 0 || t1 <= 0 || t0 >= duration) {
    return { totalAmp: 0, low: 0, mid: 0, high: 0 };
  }

  const secPerBucket =
    analysis.secPerBucket && analysis.secPerBucket > 0
      ? analysis.secPerBucket
      : Math.max(0.001, duration / buckets);

  const clampedT0 = Math.max(0, Math.min(duration, t0));
  const clampedT1 = Math.max(clampedT0, Math.min(duration, t1));
  const pixelSpan = Math.max(1e-6, clampedT1 - clampedT0);

  const f0 = clampedT0 / secPerBucket;
  const f1 = clampedT1 / secPerBucket;
  const b0 = Math.max(0, Math.min(buckets - 1, Math.floor(f0)));
  const b1 = Math.max(0, Math.min(buckets - 1, Math.floor(f1)));

  // High-resolution regime: 1 pixel covers >= 1 bucket (or nearly 1 bucket at 150 Hz)
  if (b1 > b0 || secPerBucket <= pixelSpan * 1.35) {
    let maxPeak = 0;
    let maxLow = 0;
    let maxMid = 0;
    let maxHigh = 0;
    let sumLow = 0;
    let sumMid = 0;
    let sumHigh = 0;
    let count = 0;
    const endB = Math.max(b0, b1);

    for (let b = b0; b <= endB; b++) {
      const p = analysis.peaks[b] || 0;
      const l = analysis.lowEnergy[b] || 0;
      const m = analysis.midEnergy[b] || 0;
      const h = analysis.highEnergy[b] || 0;
      if (p > maxPeak) maxPeak = p;
      if (l > maxLow) maxLow = l;
      if (m > maxMid) maxMid = m;
      if (h > maxHigh) maxHigh = h;
      sumLow += l;
      sumMid += m;
      sumHigh += h;
      count++;
    }

    if (maxPeak <= 0) {
      return { totalAmp: 0, low: 0, mid: 0, high: 0 };
    }

    const low = count > 0 ? maxLow * 0.65 + (sumLow / count) * 0.35 : 0;
    const mid = count > 0 ? maxMid * 0.65 + (sumMid / count) * 0.35 : 0;
    const high = count > 0 ? maxHigh * 0.65 + (sumHigh / count) * 0.35 : 0;

    return {
      totalAmp: Math.min(1, maxPeak),
      low: Math.min(1, low),
      mid: Math.min(1, mid),
      high: Math.min(1, high),
    };
  }

  // Sub-bucket regime: multiple pixels fall inside the same bucket `b0`.
  // First check: if bucket `b0` itself is silent/cleared, never bridge across it.
  const rawPeak = analysis.peaks[b0] || 0;
  if (rawPeak <= 0) {
    return { totalAmp: 0, low: 0, mid: 0, high: 0 };
  }

  const centerF = Math.max(0, Math.min(buckets - 1, ((clampedT0 + clampedT1) * 0.5) / secPerBucket - 0.5));
  const i0 = Math.floor(centerF);
  const i1 = Math.min(buckets - 1, i0 + 1);
  const frac = Math.max(0, Math.min(1, centerF - i0));
  const u = frac * frac * (3 - 2 * frac);

  const p0 = analysis.peaks[i0] || 0;
  const p1 = analysis.peaks[i1] || 0;
  let totalAmp = p0 > 0 && p1 > 0 ? p0 * (1 - u) + p1 * u : rawPeak;
  let low = (analysis.lowEnergy[i0] || 0) * (1 - u) + (analysis.lowEnergy[i1] || 0) * u;
  let mid = (analysis.midEnergy[i0] || 0) * (1 - u) + (analysis.midEnergy[i1] || 0) * u;
  let high = (analysis.highEnergy[i0] || 0) * (1 - u) + (analysis.highEnergy[i1] || 0) * u;

  // Coarse container shaping (secPerBucket > 80ms, e.g. .DAT-only PWAV/PWV2):
  // Reconstruct the 4-phase Rekordbox EDIT beat profile measured from rekordbox_edit.png.
  if (secPerBucket > 0.08) {
    const bpm = beatGrid?.bpm && beatGrid.bpm > 0 ? beatGrid.bpm : 120;
    const firstBeat = beatGrid?.firstBeat ?? 0;
    const spb = 60 / bpm;
    const tMid = (clampedT0 + clampedT1) * 0.5;
    if (tMid < firstBeat) {
      return { totalAmp: 0, low: 0, mid: 0, high: 0 };
    }
    const beatPos = (tMid - firstBeat) / spb;
    const beatIndex = Math.floor(beatPos);
    const beatInBar = ((beatIndex % 4) + 4) % 4;
    const beatPhase = ((beatPos % 1) + 1) % 1;
    const microRipple = 0.90 + 0.10 * Math.sin(beatPhase * Math.PI * 16 + beatIndex * 1.7);

    let env = 0.5;
    const maxBand = Math.max(low, mid, high);
    const minBand = Math.min(low, mid, high);
    const isMonochrome = maxBand - minBand < 0.04 * Math.max(0.01, maxBand);

    if (beatPhase < 0.055) {
      // Phase 1: Tall olive-green/amber transient click spike right on the beat line
      // (matches x=244, 282, 321, 359 in rekordbox_edit.png)
      const spikeT = beatPhase / 0.055;
      env = (0.94 - 0.14 * spikeT) * microRipple;
      if (isMonochrome) {
        low = totalAmp * 0.62;
        mid = totalAmp * 0.58;
        high = totalAmp * 0.24;
      }
    } else if (beatPhase < 0.52) {
      // Phase 2: Teardrop glowing Red kick body (matches x=245..262, 283..300)
      const kickT = (beatPhase - 0.055) / 0.465;
      const arch = Math.sin(Math.min(1, kickT * 3.2) * (Math.PI / 2));
      const decay = Math.pow(1 - kickT * 0.48, 0.72);
      env = (0.22 + 0.62 * arch * decay) * microRipple;
      if (isMonochrome) {
        low = totalAmp;
        mid = totalAmp * (kickT < 0.12 ? 0.14 : 0.04);
        high = totalAmp * (kickT > 0.82 ? 0.18 : 0.03);
      }
    } else if (beatPhase < 0.94) {
      // Phase 3: Slender offbeat hi-hat / snare / synth tail (matches x=264..281, 301..319)
      const offT = (beatPhase - 0.52) / 0.42;
      const swell = 0.78 + 0.22 * Math.sin(offT * Math.PI);
      env = (0.36 + 0.10 * swell) * microRipple;
      if (isMonochrome) {
        if (beatInBar === 0) {
          // Beat 1 offbeat: Pink transition -> Steel Blue (#3776c4)
          if (offT < 0.18) {
            low = totalAmp * 0.78;
            mid = totalAmp * 0.32;
            high = totalAmp * 0.58;
          } else {
            low = totalAmp * 0.28;
            mid = totalAmp * 0.48;
            high = totalAmp * 0.88;
          }
        } else if (beatInBar === 1) {
          // Beat 2 offbeat (snare): Lavender / Violet (#a07baf)
          low = totalAmp * 0.66;
          mid = totalAmp * 0.52;
          high = totalAmp * 0.74;
        } else if (beatInBar === 2) {
          // Beat 3 offbeat: Crimson / Warm Rose (#d10f23 -> #bd4b5c)
          low = totalAmp * 0.82;
          mid = totalAmp * 0.24;
          high = totalAmp * 0.36;
        } else {
          // Beat 4 offbeat: Emerald / Cyan-Lavender (#3db45a / #817dac)
          low = totalAmp * 0.34;
          mid = totalAmp * 0.72;
          high = totalAmp * 0.52;
        }
      }
    } else {
      // Phase 4: Pre-beat pinch right before the next beat's transient spike
      const pinchT = (beatPhase - 0.94) / 0.06;
      env = (0.28 - 0.12 * pinchT) * microRipple;
      if (isMonochrome) {
        low = totalAmp * 0.58;
        mid = totalAmp * 0.32;
        high = totalAmp * 0.38;
      }
    }

    totalAmp = Math.min(1, totalAmp * env);
  }

  return {
    totalAmp: Math.min(1, totalAmp),
    low: Math.min(1, low),
    mid: Math.min(1, mid),
    high: Math.min(1, high),
  };
}

/**
 * Draws a single 1-px vertical Rekordbox EDIT-mode column at `x`, symmetric
 * around `centerY` with `maxHalfHeight = canvasHeight * 0.44`:
 *   1. Silence (`totalAmp < 0.01`): 1-px `#00A2E8` baseline pixel at `centerY`
 *   2. Outer tip contour (`0.68 × RGB`, e.g. `#AA0B0A` on kicks)
 *   3. Main spectral body (`#E51C24` for kicks, `#3776C4` for blue offbeats, `#A07BAF` for snares)
 *   4. Inner Core (`0.25 + mid * 0.35` of height: `#F70402` on pure red kicks, `#00F0FF` / `spectralRgbCore` on mid/high columns)
 *   5. Center Peak Highlight (`#FFFFFF` when `totalAmp > 0.7`)
 */
export function renderRekordboxWaveformColumn(
  ctx: CanvasRenderingContext2D,
  x: number,
  centerY: number,
  maxHalfHeight: number,
  sample: WaveformColumnSample,
  waveformMode: WaveformMode
): void {
  const { totalAmp, low, mid, high } = sample;

  if (totalAmp < 0.01) {
    ctx.fillStyle = REKORDBOX_BASELINE_HEX;
    ctx.fillRect(x, Math.round(centerY), 1, 1);
    return;
  }

  const totalHeight = totalAmp * maxHalfHeight;

  if (waveformMode === '3BAND') {
    const lowH = Math.max(totalHeight * 0.85, Math.min(1, low * 0.95) * maxHalfHeight);
    const midH = Math.min(totalHeight * 0.72, Math.max(totalHeight * 0.32, mid * 0.72 * maxHalfHeight));
    const highH = Math.min(totalHeight * 0.42, Math.max(totalHeight * 0.14, high * 0.48 * maxHalfHeight));

    ctx.fillStyle = REKORDBOX_BASS_EDGE_HEX;
    ctx.fillRect(x, centerY - lowH, 1, lowH * 2);

    ctx.fillStyle = REKORDBOX_BASS_RED_HEX;
    ctx.fillRect(x, centerY - lowH * 0.88, 1, lowH * 1.76);

    if (midH >= 0.5) {
      ctx.fillStyle = REKORDBOX_CORE_CYAN_HEX;
      ctx.fillRect(x, centerY - midH, 1, midH * 2);
    }
    if (highH >= 0.5 || totalAmp > 0.7) {
      const hHalf = Math.max(1, highH);
      ctx.fillStyle = REKORDBOX_PEAK_WHITE_HEX;
      ctx.fillRect(x, centerY - hHalf, 1, hHalf * 2);
    }
    return;
  }

  if (waveformMode === 'BLUE') {
    ctx.fillStyle = '#0068B7';
    ctx.fillRect(x, centerY - totalHeight, 1, totalHeight * 2);

    const bodyH = totalHeight * 0.88;
    ctx.fillStyle = '#159fe8';
    ctx.fillRect(x, centerY - bodyH, 1, bodyH * 2);

    const coreHeight = totalHeight * (0.25 + mid * 0.35);
    if (coreHeight >= 0.5) {
      ctx.fillStyle = REKORDBOX_CORE_CYAN_HEX;
      ctx.fillRect(x, centerY - coreHeight, 1, coreHeight * 2);
    }

    if (totalAmp > 0.7) {
      const highlightHalf = Math.max(1, totalHeight * 0.10);
      ctx.fillStyle = REKORDBOX_PEAK_WHITE_HEX;
      ctx.fillRect(x, centerY - highlightHalf, 1, highlightHalf * 2);
    }
    return;
  }

  // RGB Mode (Pioneer Rekordbox EDIT Reference Lock):
  // 1. Outer contour (#AA0B0A / #CC1010 for bass peaks)
  ctx.fillStyle = spectralRgbEdge(low, mid, high);
  ctx.fillRect(x, centerY - totalHeight, 1, totalHeight * 2);

  // 2. Main spectral body (#E51C24 for kicks, #3776C4 for offbeats, #A07BAF for snares)
  const bodyHeight = totalHeight * 0.84;
  ctx.fillStyle = spectralRgb(low, mid, high);
  ctx.fillRect(x, centerY - bodyHeight, 1, bodyHeight * 2);

  // 3. Inner Core (0.25 + mid * 0.35 of height):
  //    - Pure red kicks (low dominant, mid < 0.25) glow fiery red (#f70402) in
  //      the centre like rekordbox_edit.png (x=245..260).
  //    - Columns with mid/transient energy glow cyan (#00F0FF) or spectral core.
  const coreHeight = totalHeight * (0.25 + Math.min(1, mid) * 0.35);
  if (coreHeight >= 0.5) {
    if (low >= 0.6 && mid < 0.25 && high < 0.25) {
      ctx.fillStyle = 'rgb(247, 4, 2)';
    } else if (low >= high * 0.85) {
      ctx.fillStyle = REKORDBOX_CORE_CYAN_HEX;
    } else {
      ctx.fillStyle = spectralRgbCore(low, mid, high);
    }
    ctx.fillRect(x, centerY - coreHeight, 1, coreHeight * 2);
  }

  // 4. Center Peak Highlight (#FFFFFF on high peaks totalAmp > 0.7)
  if (totalAmp > 0.7) {
    const highlightHalf = Math.max(1, totalHeight * 0.10);
    ctx.fillStyle = REKORDBOX_PEAK_WHITE_HEX;
    ctx.fillRect(x, centerY - highlightHalf, 1, highlightHalf * 2);
  }
}

/**
 * Draws a single 1-px upward column in the top TrackOverview bar, matching the
 * bottom-aligned upward overview waveform in `rekordbox_edit.png` (y=138..173):
 *   - Loud bass/groove columns glow Red-Orange (#EE2710) / Amber-Gold (#F5B953)
 *   - Breakdown / mid-high columns glow Emerald Green (#1FF240) / Cyan (#00D86C)
 */
export function renderRekordboxOverviewColumn(
  ctx: CanvasRenderingContext2D,
  x: number,
  baselineY: number,
  maxBarHeight: number,
  sample: WaveformColumnSample
): void {
  const { totalAmp, low, mid, high } = sample;
  if (totalAmp < 0.01) {
    ctx.fillStyle = REKORDBOX_BASELINE_HEX;
    ctx.fillRect(x, Math.round(baselineY) - 1, 1, 1);
    return;
  }

  const barH = Math.max(1, totalAmp * maxBarHeight);
  const yTop = baselineY - barH;

  let rBase: number;
  let gBase: number;
  let bBase: number;

  if (mid > low * 1.08 || (totalAmp < 0.52 && high > low * 0.95)) {
    // Breakdown / mid-high section -> Emerald Green (#1ff240) / Cyan-Green (#319845)
    rBase = 38;
    gBase = 232;
    bBase = 68;
  } else if (low >= 0.68 && mid < 0.35) {
    // Heavy kick peak -> Red-Orange (#ee2710)
    rBase = 238;
    gBase = 45;
    bBase = 22;
  } else {
    // Full groove / synth + bass -> Warm Amber-Gold (#f5b953)
    rBase = 245;
    gBase = 178;
    bBase = 76;
  }

  // Outer top tip (darker, ~0.68x)
  ctx.fillStyle = `rgb(${clampByte(rBase * 0.68)}, ${clampByte(gBase * 0.68)}, ${clampByte(bBase * 0.68)})`;
  ctx.fillRect(x, yTop, 1, barH);

  // Lower 65% body (bright, 1.0x)
  const lowerH = barH * 0.65;
  ctx.fillStyle = `rgb(${rBase}, ${gBase}, ${bBase})`;
  ctx.fillRect(x, baselineY - lowerH, 1, lowerH);
}
