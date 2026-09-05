/**
 * @license
 * Rekordbox TrackOverview Component
 * Thin horizontal track overview waveform with cue markers, memory cue triangles,
 * and draggable detail window frame.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { TrackModel, WaveformMode } from '../types/rekordbox';
import { AMBER_HOT, DEEP_AMBER, WAVEFORM_BACKGROUNDS, amberColorCss, waveformPalette } from '../waveform/colors';

interface TrackOverviewProps {
  track: TrackModel | null;
  currentTime: number;
  viewOffset: number;
  viewDuration: number;
  onSeek: (time: number) => void;
  onPanView: (newOffset: number) => void;
  /** Wellenform-Farbmodus – Standard: AMBER (warm). */
  mode?: WaveformMode;
}

export const TrackOverview: React.FC<TrackOverviewProps> = ({
  track,
  currentTime,
  viewOffset,
  viewDuration,
  onSeek,
  onPanView,
  mode = 'AMBER',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

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

    const analysis = track.analysis;
    const duration = Math.max(1, track.duration);

    if (analysis && analysis.length > 0) {
      const buckets = analysis.length;
      const stepX = width / buckets;

      for (let b = 0; b < buckets; b++) {
        const x = b * stepX;
        const peak = analysis.peaks[b];
        const low = analysis.lowEnergy[b];
        const mid = analysis.midEnergy[b];
        const high = analysis.highEnergy[b];

        const barH = Math.max(2, peak * (height - 4));
        const yTop = (height - barH) / 2;

        // Farbe folgt dem gewählten Modus; AMBER ist der warme Standard.
        let fill: string;
        if (mode === 'AMBER') {
          fill = amberColorCss(peak, low, high);
        } else if (mode === 'BLUE' || mode === '3BAND') {
          fill = waveformPalette(mode).body;
        } else {
          const r = Math.min(255, Math.floor(low * 255 + mid * 70));
          const g = Math.min(255, Math.floor(mid * 240 + high * 60));
          const bCol = Math.min(255, Math.floor(high * 255 + low * 30));
          fill = `rgb(${r}, ${g}, ${bCol})`;
        }

        ctx.fillStyle = fill;
        ctx.fillRect(x, yTop, Math.max(1, stepX * 0.9), barH);

        // Heiße Spitze bei den lautesten Balken – gibt der Übersicht Kontur,
        // ohne die ganze Kurve aufzuhellen.
        if (mode === 'AMBER' && peak >= 0.86) {
          ctx.fillStyle = AMBER_HOT;
          ctx.fillRect(x, yTop, Math.max(1, stepX * 0.9), 1.5);
          ctx.fillRect(x, yTop + barH - 1.5, Math.max(1, stepX * 0.9), 1.5);
        }
      }
    } else {
      // Fallback synthetic overview bars
      const numBars = 180;
      for (let i = 0; i < numBars; i++) {
        const x = (i / numBars) * width;
        const amp = 0.3 + 0.6 * Math.sin((i / numBars) * Math.PI) * (0.8 + 0.2 * Math.cos(i * 0.5));
        const barH = amp * (height - 6);
        ctx.fillStyle = i % 2 === 0 ? '#ff9500' : DEEP_AMBER;
        ctx.fillRect(x, (height - barH) / 2, width / numBars - 1, barH);
      }
    }

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
  }, [track, currentTime, viewOffset, viewDuration]);

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
      className="relative w-full h-8 border border-[#1f2129] rounded-xs cursor-pointer overflow-hidden shadow-inner"
      style={{ backgroundColor: WAVEFORM_BACKGROUNDS[mode] ?? WAVEFORM_BACKGROUNDS.AMBER }}
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
