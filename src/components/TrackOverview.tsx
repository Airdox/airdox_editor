/**
 * @license
 * Rekordbox TrackOverview Component
 * Thin horizontal track overview using original-data helpers:
 * - Waveform from selectTrackWaveform (genuine ANLZ variants only)
 * - Honest empty state via waveformMissingNotice
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { TrackModel } from '../types/rekordbox';
import { selectTrackWaveform, waveformMissingNotice } from '../waveform/renderModel';

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f1013';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#1d1f26';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    if (!track) return;

    const duration = Math.max(1, track.duration);
    const targetCols = width;

    const resolved = selectTrackWaveform(track, duration, width);

    if (resolved && resolved.length > 0) {
      const buckets = resolved.length;
      const bucketsPerCol = buckets / targetCols;
      for (let col = 0; col < targetCols; col++) {
        const startB = Math.floor(col * bucketsPerCol);
        const endB = Math.min(buckets, Math.floor((col + 1) * bucketsPerCol));
        let maxPeak = 0;
        let sumLow = 0;
        let sumMid = 0;
        let sumHigh = 0;
        let count = 0;
        for (let b = startB; b < endB; b++) {
          const p = resolved.peaks[b] || 0;
          if (p > maxPeak) maxPeak = p;
          sumLow += resolved.lowEnergy[b] || 0;
          sumMid += resolved.midEnergy[b] || 0;
          sumHigh += resolved.highEnergy[b] || 0;
          count++;
        }
        const low = count > 0 ? sumLow / count : 0;
        const mid = count > 0 ? sumMid / count : 0;
        const high = count > 0 ? sumHigh / count : 0;
        const barH = Math.max(2, maxPeak * (height - 4));
        const yTop = (height - barH) / 2;
        const r = Math.min(255, Math.floor(low * 255 + mid * 70));
        const g = Math.min(255, Math.floor(mid * 240 + high * 60));
        const bCol = Math.min(255, Math.floor(high * 255 + low * 30));
        ctx.fillStyle = `rgb(${r}, ${g}, ${bCol})`;
        ctx.fillRect(col, yTop, 1, barH);
      }
    } else {
      const notice = waveformMissingNotice(track);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(notice.title, width / 2, height / 2);
      ctx.textAlign = 'left';
    }

    if (track.phrases && track.phrases.length > 0) {
      track.phrases.forEach((p) => {
        const px1 = (p.startTime / duration) * width;
        const px2 = (p.endTime / duration) * width;
        const pw = Math.max(1, px2 - px1);
        ctx.fillStyle = p.color;
        ctx.fillRect(px1, height - 3, pw, 3);
      });
    }

    track.cues.forEach((c) => {
      const cueX = (c.position / duration) * width;
      if (c.type === 'MEMORY') {
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
        ctx.strokeStyle = 'rgba(255, 34, 34, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cueX, 9);
        ctx.lineTo(cueX, height - 3);
        ctx.stroke();
      } else {
        ctx.fillStyle = c.color || '#00a2ff';
        ctx.fillRect(cueX - 1, 0, 2, height - 3);
      }
    });

    ctx.fillStyle = '#ff8800';
    ctx.fillRect(1, 1, 9, 9);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 8px sans-serif';
    ctx.fillText('E', 3, 8);

    const viewLeft = (viewOffset / duration) * width;
    const viewWidth = Math.max(14, (viewDuration / duration) * width);
    ctx.strokeStyle = '#0099ff';
    ctx.lineWidth = 1.5;
    ctx.fillStyle = 'rgba(0, 153, 255, 0.18)';
    ctx.fillRect(viewLeft, 1, viewWidth, height - 2);
    ctx.strokeRect(viewLeft, 1, viewWidth, height - 2);

    const playheadX = (currentTime / duration) * width;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
  }, [track, currentTime, viewOffset, viewDuration]);

  const handlePointerInteraction = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!track) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const targetTime = (clickX / rect.width) * track.duration;
      onSeek(targetTime);
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
        if (isDragging) handlePointerInteraction(e);
      }}
      onMouseUp={() => setIsDragging(false)}
      onMouseLeave={() => setIsDragging(false)}
      className="relative w-full h-8 bg-[#0a0b0d] border border-[#1f2129] rounded-xs cursor-pointer overflow-hidden shadow-inner"
    >
      <canvas ref={canvasRef} width={900} height={32} className="w-full h-full block" />
    </div>
  );
};
