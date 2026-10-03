/**
 * @license
 * Rekordbox TrackOverview Component
 * Thin horizontal track overview waveform with cue markers, memory cue triangles,
 * and draggable detail window frame.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { TrackModel } from '../types/rekordbox';
import {
  REKORDBOX_BASELINE_HEX,
  renderRekordboxOverviewColumn,
  sampleWaveformColumn,
} from '../waveform/spectralColor';

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

  // Draw overview canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Rekordbox EDIT Overview container background (#4b4b4b with 16-bar grid divisions & #6b6b6b bottom ruler)
    const baselineY = height - 4;
    ctx.fillStyle = '#4b4b4b';
    ctx.fillRect(0, 0, width, baselineY);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, baselineY, width, 1);
    ctx.fillStyle = '#6b6b6b';
    ctx.fillRect(0, baselineY + 1, width, 3);

    if (!track) {
      ctx.fillStyle = REKORDBOX_BASELINE_HEX;
      ctx.fillRect(0, baselineY - 1, width, 1);
      return;
    }

    const analysis = track.analysis;
    const duration = Math.max(1, track.duration);

    // 16-bar vertical grid divisions inside the overview box (matching rekordbox_edit.png)
    const spb = 60.0 / (track.beatGrid?.bpm || 120);
    const sixteenBarSec = spb * (track.beatGrid?.meter || 4) * 16;
    if (sixteenBarSec > 1) {
      ctx.fillStyle = '#2d2d2d';
      for (let t = track.beatGrid?.firstBeat || 0; t < duration; t += sixteenBarSec) {
        const gx = Math.round((t / duration) * width);
        ctx.fillRect(gx, 0, 1, baselineY);
        ctx.fillStyle = '#d0d0d0';
        ctx.fillRect(gx, baselineY + 1, 1, 2);
        ctx.fillStyle = '#2d2d2d';
      }
    }

    const targetCols = width;

    if (analysis && analysis.length > 0) {
      const maxBarHeight = Math.max(6, baselineY - 5);
      for (let col = 0; col < targetCols; col++) {
        const t0 = (col / targetCols) * duration;
        const t1 = ((col + 1) / targetCols) * duration;
        const sample = sampleWaveformColumn(
          analysis,
          t0,
          t1,
          duration,
          track.beatGrid
        );
        renderRekordboxOverviewColumn(
          ctx,
          col,
          baselineY,
          maxBarHeight,
          sample
        );
      }
    } else {
      // Intentionally leave the neutral baseline visible.
      ctx.fillStyle = REKORDBOX_BASELINE_HEX;
      ctx.fillRect(0, baselineY - 1, width, 1);
    }

    // Iconic orange 'E' badge at top-left of overview (matching rekordbox_edit.png)
    ctx.fillStyle = '#ff8c00';
    ctx.fillRect(2, 2, 7, 8);
    ctx.fillStyle = '#191919';
    ctx.font = 'bold 7px sans-serif';
    ctx.fillText('E', 3, 9);

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
