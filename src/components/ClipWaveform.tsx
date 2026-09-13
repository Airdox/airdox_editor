/**
 * @license
 * Rekordbox ClipWaveform Component
 * Renders the DETAILED waveform of a palette clip as a dense, continuous
 * canvas silhouette — the same visual language as the main DetailWaveform
 * renderer (BLUE / RGB / 3BAND).
 *
 * Data source priority:
 *  1. Native Rekordbox analysis buckets carried by the clip (ANLZ slice)
 *  2. Per-sample analysis computed once from the clip's AudioBuffer (cached)
 *
 * Unlike the old coarse 48/64 peak-bar preview, every pixel column resolves
 * the true max amplitude / band energy of its time span, so kicks, hats and
 * breaks stay visible even in a small palette tile.
 */

import React, { useRef, useEffect } from 'react';
import { PaletteClip, WaveformMode, WaveformAnalysisData } from '../types/rekordbox';
import { analyzeAudioBuffer } from '../waveform/analyzer';
import { spectralRgb, spectralRgbCore } from '../waveform/spectralColor';

// Cache for clips that do not carry native analysis (WeakMap = no leak)
const computedAnalysisCache = new WeakMap<AudioBuffer, WaveformAnalysisData>();

function resolveAnalysis(clip: PaletteClip): WaveformAnalysisData | null {
  if (clip.analysis && clip.analysis.length > 0) return clip.analysis;
  if (clip.audioBuffer) {
    let analysis = computedAnalysisCache.get(clip.audioBuffer);
    if (!analysis) {
      analysis = analyzeAudioBuffer(clip.audioBuffer);
      computedAnalysisCache.set(clip.audioBuffer, analysis);
    }
    return analysis;
  }
  return null;
}

/**
 * Core pixel renderer. Exported so other clip surfaces (deck carousel etc.)
 * can reuse the identical detailed drawing.
 */
export function drawDetailedClipWaveform(
  canvas: HTMLCanvasElement,
  clip: PaletteClip,
  waveformMode: WaveformMode,
  showBeatgrid: boolean,
  view?: { start: number; end: number } | null
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  const centerY = height / 2;
  const maxHalf = height * 0.46;

  // 1. Dark background + subtle centerline (matches DetailWaveform)
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b0c0f';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#16171d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();

  const analysis = resolveAnalysis(clip);
  if (!analysis) {
    ctx.fillStyle = '#3f4350';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Keine Wellenformdaten', width / 2, centerY + 3);
    ctx.textAlign = 'left';
    return;
  }

  const buckets = analysis.length;
  const clipDuration = clip.duration || buckets * (analysis.secPerBucket || 1 / 150);
  const secPerBucket = analysis.secPerBucket || clipDuration / buckets;

  // Optional zoom window (deck view); palette tiles render the full clip
  const viewStart = view ? Math.max(0, Math.min(view.start, clipDuration)) : 0;
  const viewEnd = view ? Math.max(viewStart + 0.01, Math.min(view.end, clipDuration)) : clipDuration;
  const viewDuration = viewEnd - viewStart;

  // Per-pixel-column max aggregation keeps transients visible at any size
  const columnRange = (x: number): [number, number] => {
    const t0 = viewStart + (x / width) * viewDuration;
    const t1 = viewStart + ((x + 1) / width) * viewDuration;
    const b0 = Math.max(0, Math.floor(t0 / secPerBucket));
    const b1 = Math.min(buckets - 1, Math.floor(t1 / secPerBucket));
    return [b0, Math.max(b0, b1)];
  };

  const maxOver = (band: Float32Array, b0: number, b1: number): number => {
    let m = 0;
    for (let b = b0; b <= b1; b++) {
      const v = band[b];
      if (v > m) m = v;
    }
    return m;
  };

  const drawColumns = (
    amplitudeAt: (b0: number, b1: number) => number,
    scale: number,
    fill: string | CanvasGradient,
    coreFill?: string
  ) => {
    ctx.fillStyle = fill;
    for (let x = 0; x < width; x++) {
      const [b0, b1] = columnRange(x);
      const amp = Math.min(1, amplitudeAt(b0, b1) * scale);
      if (amp <= 0.004) continue;
      const h = amp * maxHalf;
      ctx.fillRect(x, centerY - h, 1, h * 2);
    }
    if (coreFill) {
      // Bright inner core, mirrors the DetailWaveform BLUE highlight pass
      ctx.fillStyle = coreFill;
      for (let x = 0; x < width; x++) {
        const [b0, b1] = columnRange(x);
        const amp = Math.min(1, amplitudeAt(b0, b1) * scale);
        if (amp <= 0.02) continue;
        const h = amp * maxHalf * 0.38;
        ctx.fillRect(x, centerY - h, 1, h * 2);
      }
    }
  };

  if (waveformMode === '3BAND') {
    // Overlapping band layers exactly like the main 3BAND renderer
    drawColumns((b0, b1) => maxOver(analysis.lowEnergy, b0, b1), 0.85, 'rgba(255, 59, 69, 0.72)');
    drawColumns((b0, b1) => maxOver(analysis.midEnergy, b0, b1), 0.7, 'rgba(24, 216, 223, 0.48)');
    drawColumns((b0, b1) => maxOver(analysis.highEnergy, b0, b1), 0.55, 'rgba(239, 252, 255, 0.30)');
  } else if (waveformMode === 'BLUE') {
    drawColumns((b0, b1) => maxOver(analysis.peaks, b0, b1), 1.0, '#159fe8', 'rgba(184, 233, 255, 0.34)');
  } else {
    // RGB: rekordbox-authentic per-column spectral colouring — bass-heavy
    // drops render red/orange, breaks and vocal sections blue/green, exactly
    // like the main DetailWaveform renderer.
    const avgOver = (band: Float32Array, b0: number, b1: number): number => {
      let sum = 0;
      let n = 0;
      for (let b = b0; b <= b1; b++) {
        sum += band[b] || 0;
        n++;
      }
      return n > 0 ? sum / n : 0;
    };
    for (let x = 0; x < width; x++) {
      const [b0, b1] = columnRange(x);
      const amp = Math.min(1, maxOver(analysis.peaks, b0, b1));
      if (amp <= 0.004) continue;
      const low = avgOver(analysis.lowEnergy, b0, b1);
      const mid = avgOver(analysis.midEnergy, b0, b1);
      const high = avgOver(analysis.highEnergy, b0, b1);
      const h = amp * maxHalf;
      ctx.fillStyle = spectralRgb(low, mid, high);
      ctx.fillRect(x, centerY - h, 1, h * 2);
      const coreH = h * 0.45;
      if (coreH >= 0.5) {
        ctx.fillStyle = spectralRgbCore(low, mid, high);
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x, centerY - coreH, 1, coreH * 2);
        ctx.globalAlpha = 1;
      }
    }
  }

  // Beatgrid overlay (bars brighter, beats only when spacing allows)
  if (showBeatgrid) {
    const beats: number[] =
      clip.beatOffsets && clip.beatOffsets.length > 0
        ? clip.beatOffsets
        : clip.bpm > 0
        ? (() => {
            const spb = 60 / clip.bpm;
            const out: number[] = [];
            for (let t = 0; t < clipDuration; t += spb) out.push(t);
            return out;
          })()
        : [];

    const pxPerBeat = beats.length > 1 ? ((beats[1] - beats[0]) / viewDuration) * width : width;

    beats.forEach((beatTime, index) => {
      if (beatTime < viewStart - 0.001 || beatTime > viewEnd + 0.001) return;
      const x = Math.round(((beatTime - viewStart) / viewDuration) * width);
      if (x < 0 || x >= width) return;
      const isBar = index % 4 === 0;
      if (!isBar && pxPerBeat < 6) return;
      ctx.strokeStyle = isBar ? 'rgba(255, 255, 255, 0.30)' : 'rgba(255, 255, 255, 0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    });
  }
}

interface ClipWaveformProps {
  clip: PaletteClip;
  waveformMode?: WaveformMode;
  showBeatgrid?: boolean;
  className?: string;
}

export const ClipWaveform: React.FC<ClipWaveformProps> = ({
  clip,
  waveformMode = 'RGB',
  showBeatgrid = true,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const render = () => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(10, Math.floor(rect.width));
      const h = Math.max(10, Math.floor(rect.height));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      drawDetailedClipWaveform(canvas, clip, waveformMode, showBeatgrid);
    };

    render();
    const ro = new ResizeObserver(render);
    ro.observe(container);
    return () => ro.disconnect();
  }, [clip, waveformMode, showBeatgrid]);

  return (
    <div ref={containerRef} className={className ?? 'w-full h-full'}>
      <canvas ref={canvasRef} className="w-full h-full block" />
    </div>
  );
};
