/**
 * @license
 * Rekordbox TrackOverview Component
 * Thin horizontal track overview waveform with cue markers, memory cue triangles,
 * and draggable detail window frame.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { TrackModel } from '../types/rekordbox';
import {
  collectVisibleBeats,
  monoBlueColor,
  pwv4BackColor,
  pwv4FrontColor,
  rgbColumnColor,
  rgbCss,
  selectWaveformVariant,
} from '../waveform/renderModel';

interface TrackOverviewProps {
  track: TrackModel | null;
  currentTime: number;
  viewOffset: number;
  viewDuration: number;
  onSeek: (time: number) => void;
  onPanView: (newOffset: number) => void;
}

export const TrackOverview: React.FC<TrackOverviewProps> = ({
  track,
  currentTime,
  viewOffset,
  viewDuration,
  onSeek,
  onPanView,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [fitTick, setFitTick] = useState(0);

  // Crisp canvas: back the CSS box with devicePixelRatio-scaled pixels.
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        setFitTick((t) => t + 1);
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Draw overview canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Dark container background
    ctx.fillStyle = '#0f1013';
    ctx.fillRect(0, 0, width, height);

    // Subtle horizontal center baseline
    ctx.strokeStyle = '#1d1f26';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    if (!track) {
      return;
    }

    const duration = Math.max(1, track.duration);

    const targetCols = width;

    // Zoom-matched variant (the overview shows the full track): genuine ANLZ
    // data only — the selector just picks the fitting resolution.
    const candidates =
      track.analysisVariants && track.analysisVariants.length > 0
        ? track.analysisVariants
        : track.analysis
          ? [track.analysis]
          : [];
    const variantIdx = selectWaveformVariant(
      candidates.map((c) => c.length),
      duration,
      track.duration,
      targetCols
    );
    const analysis = variantIdx >= 0 ? candidates[variantIdx] : null;

    if (analysis && analysis.length > 0) {
      const buckets = analysis.length;
      // DAT-only preview variants carry one mono channel → authentic
      // Rekordbox preview blue; band variants use the spectral palette.
      const isMonoPreview =
        analysis.sourceTag === 'PWAV' ||
        analysis.sourceTag === 'PWV2' ||
        analysis.sourceTag === 'PWV3';
      const centerY = height / 2;
      const maxHalf = (height - 4) / 2;

      // Draw every Rekordbox source column directly. Multiple source columns
      // may land on the same display pixel at overview zoom, but Airdox does
      // not combine them into a new maximum/average/smoothed value.
      for (let bucket = 0; bucket < buckets; bucket++) {
        const x = ((bucket + 0.5) / buckets) * width;
        const nextX = ((bucket + 1.5) / buckets) * width;
        const drawWidth = Math.max(0.25, nextX - x);
        const peak = analysis.peaks[bucket] || 0;
        const low = analysis.lowEnergy[bucket] || 0;
        const mid = analysis.midEnergy[bucket] || 0;
        const high = analysis.highEnergy[bucket] || 0;

        if (analysis.frontPeaks && analysis.luminance && analysis.backPeaks) {
          const lum = analysis.luminance[bucket] || 0;
          const backH = Math.max(1, (analysis.backPeaks[bucket] || 0) * maxHalf);
          ctx.fillStyle = rgbCss(pwv4BackColor(low, mid, high, lum));
          ctx.fillRect(x - drawWidth / 2, centerY - backH, drawWidth, backH * 2);
          const frontH = Math.max(1, (analysis.frontPeaks[bucket] || 0) * maxHalf);
          ctx.fillStyle = rgbCss(pwv4FrontColor(low, mid, high, lum));
          ctx.fillRect(x - drawWidth / 2, centerY - frontH, drawWidth, frontH * 2);
        } else if (isMonoPreview) {
          const barH = Math.max(1, peak * maxHalf);
          const whiteness = analysis.whiteness?.[bucket] ?? peak;
          ctx.fillStyle = rgbCss(monoBlueColor(whiteness));
          ctx.fillRect(x - drawWidth / 2, centerY - barH, drawWidth, barH * 2);
        } else {
          const barH = Math.max(1, peak * maxHalf);
          ctx.fillStyle = rgbCss(rgbColumnColor(low, mid, high));
          ctx.fillRect(x - drawWidth / 2, centerY - barH, drawWidth, barH * 2);
        }
      }
    }

    // Authentic per-bar separators (reference 01: dark ticks on the strip) —
    // pure grid data, drawn with or without analysis.
    if (track.beatGrid.beats && track.beatGrid.beats.length > 0) {
      const barTicks = collectVisibleBeats(track.beatGrid.beats, 0, duration, 4000).filter(
        (v) => v.isBar
      );
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      for (const vbar of barTicks) {
        const bx = Math.round((vbar.time / duration) * width);
        ctx.fillRect(bx, 0, 1, height);
      }
    }

    // Without ANLZ there is no waveform data — like the original, the strip
    // stays empty (no invented contour); only the grid ticks above remain.

    // Draw Rekordbox Phrase Blocks (PSSI) along the bottom edge of overview
    if (track.phrases && track.phrases.length > 0) {
      track.phrases.forEach((p) => {
        const px1 = (p.startTime / duration) * width;
        const px2 = (p.endTime / duration) * width;
        const pw = Math.max(1, px2 - px1);
        ctx.fillStyle = p.color;
        ctx.fillRect(px1, height - 3, pw, 3);
      });
    }

    // Draw Cues and Memory Markers
    track.cues.forEach((c) => {
      const cueX = (c.position / duration) * width;

      if (c.type === 'MEMORY') {
        // Red downward triangle flag at top with crisp white outline
        ctx.fillStyle = '#ff2222';
        ctx.beginPath();
        ctx.moveTo(cueX - 4.5, 0);
        ctx.lineTo(cueX + 4.5, 0);
        ctx.lineTo(cueX, 9);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 0.75;
        ctx.stroke();

        // Subtle vertical red guide line
        ctx.strokeStyle = 'rgba(255, 34, 34, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cueX, 9);
        ctx.lineTo(cueX, height - 3);
        ctx.stroke();
      } else {
        // Hot cue marker
        ctx.fillStyle = c.color || '#00a2ff';
        ctx.fillRect(cueX - 1, 0, 2, height - 3);
      }
    });

    // Draw First Beat "E" marker (Orange box with 'E')
    ctx.fillStyle = '#ff8800';
    ctx.fillRect(1, 1, 9, 9);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 8px sans-serif';
    ctx.fillText('E', 3, 8);

    // Draw Visible Detail Viewport (Blue rectangular frame)
    const viewLeft = (viewOffset / duration) * width;
    const viewWidth = Math.max(14, (viewDuration / duration) * width);

    ctx.strokeStyle = '#0099ff';
    ctx.lineWidth = 1.5;
    ctx.fillStyle = 'rgba(0, 153, 255, 0.18)';
    ctx.fillRect(viewLeft, 1, viewWidth, height - 2);
    ctx.strokeRect(viewLeft, 1, viewWidth, height - 2);

    // Draw Playhead line in overview
    const playheadX = (currentTime / duration) * width;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
  }, [track, currentTime, viewOffset, viewDuration, fitTick]);

  // Handle click or drag on overview to seek / pan
  const handlePointerInteraction = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!track) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const targetTime = (clickX / rect.width) * track.duration;

      onSeek(targetTime);
      // Center view on clicked point
      const newOffset = Math.max(0, targetTime - viewDuration / 2);
      onPanView(Math.min(newOffset, Math.max(0, track.duration - viewDuration)));
    },
    [track, viewDuration, onSeek, onPanView]
  );

  return (
    <div
      ref={containerRef}
      onMouseDown={(e) => {
        setIsDragging(true);
        handlePointerInteraction(e);
      }}
      onMouseMove={(e) => {
        if (isDragging) {
          handlePointerInteraction(e);
        }
      }}
      onMouseUp={() => setIsDragging(false)}
      onMouseLeave={() => setIsDragging(false)}
      className="relative w-full h-8 bg-[#0a0b0d] border border-[#1f2129] rounded-xs cursor-pointer overflow-hidden shadow-inner"
    >
      <canvas
        ref={canvasRef}
        width={900}
        height={32}
        className="w-full h-full block"
      />
    </div>
  );
};
