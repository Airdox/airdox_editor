/**
 * @license
 * Rekordbox DetailWaveform Component
 * High-performance 60fps Canvas renderer implementing the strict visual lock
 * from screenshots 01, 02, and 03:
 * - 3 Waveform Modes: BLUE, RGB, 3BAND
 * - Beatgrid bar numbers (1, 9, 17... / 105, 113, 121)
 * - Exact blue selection frame with diagonal corner handles & stats box
 * - Left BPM & Zoom control column
 * - Context menu with real editing actions
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  TrackModel,
  WaveformMode,
  SelectionRange,
  CuePoint,
} from '../types/rekordbox';
import {
  Plus,
  Minus,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  UploadCloud,
  FolderOpen,
  FileAudio,
  ShieldCheck,
  ZoomIn,
} from 'lucide-react';

interface DetailWaveformProps {
  track: TrackModel | null;
  currentTime: number;
  viewOffset: number;
  viewDuration: number;
  waveformMode: WaveformMode;
  selection: SelectionRange | null;
  quantize: boolean;
  onSeek: (time: number) => void;
  onSelect: (sel: SelectionRange | null) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onSelectZoomPreset?: (preset: '2_BARS' | '4_BARS' | '8_BARS' | '16_BARS' | '32_BARS' | '64_BARS' | 'FULL_TRACK') => void;
  onPanView: (newOffset: number) => void;
  onAddToPalette: (start: number, end: number) => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onInsert: () => void;
  onReplace: () => void;
  onOverdub: () => void;
  onDelete: () => void;
  onClear: () => void;
  onAddCue: (pos: number) => void;
  onPrevMemoryCue?: () => void;
  onNextMemoryCue?: () => void;
  onAddMemoryCue?: () => void;
  onOpenDatabaseInspector?: () => void;
  onShiftBeatgrid?: (deltaSeconds: number) => void;
  onSetFirstBeatHere?: () => void;
  onAutoAlignBeatgrid?: () => void;
  onAdjustBpm?: (deltaOrMultiplier: number) => void;
  onImportXmlClick?: () => void;
  onLoadAudioClick?: () => void;
  onDropFile?: (file: File) => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  timeAtClick: number;
}

export const DetailWaveform: React.FC<DetailWaveformProps> = ({
  track,
  currentTime,
  viewOffset,
  viewDuration,
  waveformMode,
  selection,
  quantize,
  onSeek,
  onSelect,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onSelectZoomPreset,
  onPanView,
  onAddToPalette,
  onCopy,
  onCut,
  onPaste,
  onInsert,
  onReplace,
  onOverdub,
  onDelete,
  onClear,
  onAddCue,
  onPrevMemoryCue,
  onNextMemoryCue,
  onAddMemoryCue,
  onOpenDatabaseInspector,
  onShiftBeatgrid,
  onSetFirstBeatHere,
  onAutoAlignBeatgrid,
  onAdjustBpm,
  onImportXmlClick,
  onLoadAudioClick,
  onDropFile,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [dragStartSec, setDragStartSec] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const [hoveredPos, setHoveredPos] = useState<{ x: number; y: number } | null>(null);
  const [showLeftTools, setShowLeftTools] = useState(false);

  // Dynamic canvas sizing to respond to panel collapse/expand and container layout changes
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const updateCanvasSize = () => {
      const rect = container.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w > 10 && h > 10 && canvasRef.current) {
        if (canvasRef.current.width !== w || canvasRef.current.height !== h) {
          canvasRef.current.width = w;
          canvasRef.current.height = h;
        }
      }
    };

    updateCanvasSize();
    const ro = new ResizeObserver(() => {
      updateCanvasSize();
    });
    ro.observe(container);

    window.addEventListener('resize', updateCanvasSize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateCanvasSize);
    };
  }, []);

  // Time to pixel / pixel to time conversions
  const timeToPixel = useCallback(
    (t: number, width: number) => {
      return ((t - viewOffset) / viewDuration) * width;
    },
    [viewOffset, viewDuration]
  );

  const pixelToTime = useCallback(
    (px: number, width: number) => {
      return viewOffset + (px / width) * viewDuration;
    },
    [viewOffset, viewDuration]
  );

  // Helper to snap time to nearest beat
  const snapTime = useCallback(
    (t: number) => {
      if (!quantize || !track) return t;
      const bg = track.beatGrid;
      const spb = 60.0 / bg.bpm;
      const beatIndex = Math.round((t - bg.firstBeat) / spb);
      return Math.max(0, bg.firstBeat + beatIndex * spb);
    },
    [quantize, track]
  );

  // Render detail waveform loop
  useEffect(() => {
    let animId: number;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      // 1. Dark background
      ctx.fillStyle = '#0b0c0f';
      ctx.fillRect(0, 0, width, height);

      // Subtle horizontal centerline and amplitude bounds
      const centerY = height / 2;
      ctx.strokeStyle = '#16171d';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.moveTo(0, centerY - (height * 0.4));
      ctx.lineTo(width, centerY - (height * 0.4));
      ctx.moveTo(0, centerY + (height * 0.4));
      ctx.lineTo(width, centerY + (height * 0.4));
      ctx.stroke();

      ctx.fillStyle = '#111216';
      ctx.fillRect(0, 0, width, 18); // top bar number strip
      ctx.strokeStyle = '#222530';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 18);
      ctx.lineTo(width, 18);
      ctx.stroke();

      if (!track) {
        // Subtle grid markings in empty state
        ctx.strokeStyle = '#151722';
        ctx.lineWidth = 1;
        const colW = width / 16;
        for (let x = 0; x < width; x += colW) {
          ctx.beginPath();
          ctx.moveTo(x, 18);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        animId = requestAnimationFrame(render);
        return;
      }

      // 2. Beatgrid lines & Bar Numbers (Top header strip)
      const bg = track.beatGrid;
      const secondsPerBeat = 60.0 / bg.bpm;
      const startBeat = Math.max(0, Math.floor((viewOffset - bg.firstBeat) / secondsPerBeat));
      const endBeat = Math.ceil((viewOffset + viewDuration - bg.firstBeat) / secondsPerBeat);

      for (let b = startBeat; b <= endBeat; b++) {
        const beatTime = bg.firstBeat + b * secondsPerBeat;
        const x = timeToPixel(beatTime, width);
        if (x < -20 || x > width + 20) continue;

        const isBar = b % bg.meter === 0;
        const barNumber = Math.floor(b / bg.meter) + 1;

        if (isBar) {
          // Rekordbox authentic solid white Bar vertical downbeat line
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();

          // Rekordbox Bar number in top ruler (e.g. 109, 113)
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 11px sans-serif';
          ctx.fillText(`${barNumber}`, x + 3, 14);
        } else {
          // Intermediate beat lines (beats 2, 3, 4)
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(x, 18);
          ctx.lineTo(x, height);
          ctx.stroke();

          // Top ruler tick
          ctx.strokeStyle = '#606578';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, 12);
          ctx.lineTo(x, 18);
          ctx.stroke();
        }
      }

      // 2b. Rekordbox Phrase Blocks (PSSI Song Structure)
      if (track.phrases && track.phrases.length > 0) {
        track.phrases.forEach((p) => {
          const px1 = timeToPixel(p.startTime, width);
          const px2 = timeToPixel(p.endTime, width);
          if (px2 < 0 || px1 > width) return;
          const left = Math.max(0, px1);
          const right = Math.min(width, px2);
          const pw = right - left;
          if (pw > 2) {
            ctx.fillStyle = p.color + '33';
            ctx.fillRect(left, 18, pw, 9);
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 1;
            ctx.strokeRect(left, 18, pw, 9);

            if (pw > 35) {
              ctx.fillStyle = '#ffffff';
              ctx.font = 'bold 8px sans-serif';
              ctx.fillText(p.name, left + 3, 25);
            }
          }
        });
      }

      // 3. Render Waveform (BLUE / RGB / 3BAND)
      const analysis = track.analysis;
      if (analysis && analysis.length > 0) {
        const buckets = analysis.length;
        const secPerBucket = analysis.secPerBucket || (track.duration / buckets);
        const startBucket = Math.max(0, Math.floor(viewOffset / secPerBucket) - 1);
        const endBucket = Math.min(buckets - 1, Math.ceil((viewOffset + viewDuration) / secPerBucket) + 1);

        const maxHalfH = height * 0.42;

        for (let b = startBucket; b <= endBucket; b++) {
          const t = b * secPerBucket;
          const centerT = t + secPerBucket * 0.5;
          const x = timeToPixel(centerT, width);
          const nextX = timeToPixel(centerT + secPerBucket, width);
          const colW = Math.max(1.2, nextX - x);

          const peak = analysis.peaks[b];
          const low = analysis.lowEnergy[b];
          const mid = analysis.midEnergy[b];
          const high = analysis.highEnergy[b];

          if (waveformMode === 'BLUE') {
            // High-contrast electric blue waveform
            const barH = Math.max(2, peak * maxHalfH);
            ctx.fillStyle = '#00a2ff';
            ctx.fillRect(x - colW * 0.5, centerY - barH, colW, barH * 2);
            ctx.fillStyle = '#b3e5fc';
            ctx.fillRect(x - colW * 0.5, centerY - barH * 0.35, colW, barH * 0.7);
          } else if (waveformMode === 'RGB') {
            // Pioneer Rekordbox RGB color mapping (Lows=Red, Mids=Cyan/Green, Highs=Blue/White)
            const barH = Math.max(2, peak * maxHalfH);
            const r = Math.min(255, Math.floor(low * 270 + mid * 35));
            const g = Math.min(255, Math.floor(mid * 240 + high * 60));
            const bCol = Math.min(255, Math.floor(high * 240 + low * 25));

            ctx.fillStyle = `rgb(${r}, ${g}, ${bCol})`;
            ctx.fillRect(x - colW * 0.5, centerY - barH, colW, barH * 2);

            // Bright center spine
            ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(0.8, high * 0.8 + 0.15)})`;
            ctx.fillRect(x - colW * 0.5, centerY - 2, colW, 4);
          } else {
            // 3BAND Mode: Separate layers
            const lowH = Math.max(1, low * maxHalfH * 0.85);
            const midH = Math.max(1, mid * maxHalfH * 0.7);
            const highH = Math.max(1, high * maxHalfH * 0.55);

            // Lows (Red)
            ctx.fillStyle = '#ff2b2b';
            ctx.fillRect(x - colW * 0.5, centerY - lowH, colW, lowH * 2);
            // Mids (Cyan/Green)
            ctx.fillStyle = '#00e5ff';
            ctx.fillRect(x - colW * 0.5, centerY - midH * 0.6, colW, midH * 1.2);
            // Highs (White/Ice Blue)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x - colW * 0.5, centerY - highH * 0.3, colW, highH * 0.6);
          }
        }
      } else {
        // Synthesize dynamic beat-synced DJ waveform in case analysis is temporarily resolving
        const maxHalfH = height * 0.42;
        const bpm = bg.bpm || 130.05;
        const secondsPerBeat = 60 / bpm;
        const numCols = Math.ceil(width / 2);
        for (let i = 0; i < numCols; i++) {
          const x = i * 2;
          const t = pixelToTime(x, width);
          const beatPos = (t - bg.firstBeat) / secondsPerBeat;
          const beatFract = ((beatPos % 1) + 1) % 1;
          const barIndex = Math.floor(beatPos / 4);
          // Match breakdown at bars 96-112 (seconds ~177s to ~206.69s)
          const isBreak = (barIndex >= 96 && barIndex < 112);
          const kickEnv = isBreak ? 0.05 : Math.exp(-beatFract * 12) * 0.88;
          const subBass = isBreak ? 0.08 : (0.2 + 0.15 * Math.sin(t * 18));
          const hiHat = Math.exp(-((beatFract * 4) % 1) * 20) * 0.28;
          const peak = Math.min(1.0, kickEnv + subBass + hiHat);

          const barH = Math.max(2, peak * maxHalfH);
          if (waveformMode === 'RGB') {
            const r = Math.min(255, Math.floor(kickEnv * 280));
            const g = Math.min(255, Math.floor(subBass * 260 + hiHat * 80));
            const bCol = Math.min(255, Math.floor(hiHat * 350 + 60));
            ctx.fillStyle = `rgb(${r}, ${g}, ${bCol})`;
            ctx.fillRect(x, centerY - barH, 2, barH * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.fillRect(x, centerY - 2, 2, 4);
          } else if (waveformMode === 'BLUE') {
            ctx.fillStyle = '#00a2ff';
            ctx.fillRect(x, centerY - barH, 2, barH * 2);
            ctx.fillStyle = '#b3e5fc';
            ctx.fillRect(x, centerY - barH * 0.35, 2, barH * 0.7);
          } else {
            // 3BAND
            ctx.fillStyle = '#ff2b2b';
            ctx.fillRect(x, centerY - barH * 0.8, 2, barH * 1.6);
            ctx.fillStyle = '#00e5ff';
            ctx.fillRect(x, centerY - barH * 0.45, 2, barH * 0.9);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x, centerY - barH * 0.2, 2, barH * 0.4);
          }
        }
      }

      // 3b. Beatgrid overlay lines over waveform (clean white downbeat lines, subtle beat lines)
      for (let b = startBeat; b <= endBeat; b++) {
        const beatTime = bg.firstBeat + b * secondsPerBeat;
        const x = timeToPixel(beatTime, width);
        if (x < -10 || x > width + 10) continue;
        const isBar = b % bg.meter === 0;

        if (isBar) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x, 18);
          ctx.lineTo(x, height);
          ctx.stroke();
        } else {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(x, 18);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
      }

      // 4. Draw Cues and Markers
      track.cues.forEach((c) => {
        const x = timeToPixel(c.position, width);
        if (x < -20 || x > width + 20) return;

        if (c.type === 'MEMORY') {
          // Authentic Rekordbox Red inverted triangle at top ruler
          ctx.fillStyle = '#ff2222';
          ctx.beginPath();
          ctx.moveTo(x - 6, 0);
          ctx.lineTo(x + 6, 0);
          ctx.lineTo(x, 11);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 0.8;
          ctx.stroke();

          // Memory Cue Label badge
          const labelText = c.name || `MEM ${c.cueIndex || ''}`;
          const labelW = Math.min(75, labelText.length * 6 + 8);
          ctx.fillStyle = '#ff2222';
          ctx.fillRect(x - 2, 11, labelW, 12);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 8.5px sans-serif';
          ctx.fillText(labelText, x + 2, 20);

          // Red vertical guide line spanning full waveform
          ctx.strokeStyle = 'rgba(255, 34, 34, 0.75)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, 23);
          ctx.lineTo(x, height);
          ctx.stroke();
        } else {
          // Hot Cue tag
          ctx.fillStyle = c.color || '#00a2ff';
          ctx.fillRect(x - 1, 18, 2, height - 18);

          // Top badge with letter (A, B, C...)
          ctx.fillStyle = c.color || '#00a2ff';
          ctx.fillRect(x - 6, 18, 12, 12);
          ctx.fillStyle = '#000000';
          ctx.font = 'bold 9px sans-serif';
          ctx.fillText(c.letter || 'C', x - 3, 27);
        }
      });

      // 5. Draw Loops
      track.loops.forEach((l) => {
        const lx1 = timeToPixel(l.start, width);
        const lx2 = timeToPixel(l.end, width);
        if (lx2 < 0 || lx1 > width) return;

        ctx.fillStyle = 'rgba(255, 149, 0, 0.15)';
        ctx.fillRect(Math.max(0, lx1), 18, Math.min(width, lx2) - Math.max(0, lx1), height - 18);

        ctx.strokeStyle = '#ff9500';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(lx1, 18, lx2 - lx1, height - 18);
      });

      // 6. Draw SELECTION BOX (Screenshots 01, 02, 03)
      if (selection && selection.duration > 0) {
        const selX1 = timeToPixel(selection.start, width);
        const selX2 = timeToPixel(selection.end, width);
        const selW = selX2 - selX1;

        if (selX2 > 0 && selX1 < width) {
          const clampedX1 = Math.max(0, selX1);
          const clampedX2 = Math.min(width, selX2);

          // Translucent selection tint
          ctx.fillStyle = 'rgba(0, 136, 255, 0.16)';
          ctx.fillRect(clampedX1, 18, clampedX2 - clampedX1, height - 18);

          // Vivid electric blue border
          ctx.strokeStyle = '#0088ff';
          ctx.lineWidth = 2;
          ctx.strokeRect(selX1, 18, selW, height - 20);

          // Distinctive corner diagonal handle tabs (top-left & bottom-right)
          const handleSize = 10;
          ctx.fillStyle = '#0088ff';

          // Top-Left corner handle
          ctx.beginPath();
          ctx.moveTo(selX1, 18);
          ctx.lineTo(selX1 + handleSize, 18);
          ctx.lineTo(selX1, 18 + handleSize);
          ctx.closePath();
          ctx.fill();

          // Bottom-Right corner handle
          ctx.beginPath();
          ctx.moveTo(selX2, height - 2);
          ctx.lineTo(selX2 - handleSize, height - 2);
          ctx.lineTo(selX2, height - 2 - handleSize);
          ctx.closePath();
          ctx.fill();

          // Floating Selection Info Box in top-right of selection (e.g. 9.0 Bars / 36 Beats / 00:16)
          const infoBoxX = Math.min(width - 90, Math.max(selX1 + 10, selX2 - 85));
          ctx.fillStyle = 'rgba(8, 10, 15, 0.85)';
          ctx.fillRect(infoBoxX - 4, 24, 86, 46);
          ctx.strokeStyle = '#0088ff';
          ctx.lineWidth = 1;
          ctx.strokeRect(infoBoxX - 4, 24, 86, 46);

          ctx.textAlign = 'right';
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 12px sans-serif';
          ctx.fillText(`${selection.barsCount.toFixed(1)} Bars`, infoBoxX + 76, 38);

          ctx.fillStyle = '#b0b5c5';
          ctx.font = '10px sans-serif';
          ctx.fillText(`${Math.round(selection.beatsCount)} Beats`, infoBoxX + 76, 52);

          const durSec = Math.floor(selection.duration);
          const durSub = Math.floor((selection.duration % 1) * 100);
          ctx.fillText(`00:${durSec.toString().padStart(2, '0')}`, infoBoxX + 76, 64);
          ctx.textAlign = 'left';
        }
      }

      // 7. Draw Snap-to-Beat Hover Guide & Target Highlight
      if (track && hoveredTime !== null) {
        const bg = track.beatGrid;
        const spb = 60.0 / bg.bpm;
        const snappedTime = snapTime(hoveredTime);
        const snappedX = timeToPixel(snappedTime, width);
        const rawX = timeToPixel(hoveredTime, width);

        if (snappedX >= 0 && snappedX <= width) {
          const beatIndex = Math.round((snappedTime - bg.firstBeat) / spb);
          const isBar = beatIndex % bg.meter === 0;
          const barNum = Math.floor(beatIndex / bg.meter) + 1;
          const beatInBar = ((beatIndex % bg.meter) + bg.meter) % bg.meter + 1;

          // Subtle glowing translucent beam along the snapped grid line
          const glowGrad = ctx.createLinearGradient(snappedX - 12, 0, snappedX + 12, 0);
          glowGrad.addColorStop(0, 'rgba(0, 229, 255, 0)');
          glowGrad.addColorStop(0.5, isBar ? 'rgba(0, 229, 255, 0.22)' : 'rgba(0, 229, 255, 0.12)');
          glowGrad.addColorStop(1, 'rgba(0, 229, 255, 0)');
          ctx.fillStyle = glowGrad;
          ctx.fillRect(snappedX - 12, 18, 24, height - 18);

          // Vivid snap vertical line
          ctx.strokeStyle = isBar ? '#00e5ff' : '#00b4d8';
          ctx.lineWidth = isBar ? 1.8 : 1.2;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(snappedX, 18);
          ctx.lineTo(snappedX, height);
          ctx.stroke();
          ctx.setLineDash([]);

          // Snap cursor indicator arrow at top insertion ruler
          ctx.fillStyle = '#00e5ff';
          ctx.beginPath();
          ctx.moveTo(snappedX - 4, 18);
          ctx.lineTo(snappedX + 4, 18);
          ctx.lineTo(snappedX, 23);
          ctx.closePath();
          ctx.fill();

          // If raw cursor differs from snapped line, show subtle connector
          if (Math.abs(rawX - snappedX) > 2) {
            ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(rawX, height - 12);
            ctx.lineTo(snappedX, height - 12);
            ctx.stroke();
          }

          // Floating Tooltip Badge above ruler or near cursor
          const badgeText = `${isBar ? `BAR ${barNum}` : `B${barNum}.${beatInBar}`} • ${snappedTime.toFixed(2)}s`;
          ctx.font = 'bold 9.5px monospace';
          const badgeW = ctx.measureText(badgeText).width + 12;
          const badgeX = Math.max(4, Math.min(width - badgeW - 4, snappedX - badgeW / 2));
          
          ctx.fillStyle = 'rgba(10, 15, 24, 0.92)';
          ctx.fillRect(badgeX, 3, badgeW, 14);
          ctx.strokeStyle = isBar ? '#00e5ff' : '#0096c7';
          ctx.lineWidth = 1;
          ctx.strokeRect(badgeX, 3, badgeW, 14);

          ctx.fillStyle = isBar ? '#ffffff' : '#90e0ef';
          ctx.fillText(badgeText, badgeX + 6, 13.5);
        }
      }

      // 8. Draw Playhead (White vertical hairline)
      const playX = timeToPixel(currentTime, width);
      if (playX >= 0 && playX <= width) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(playX, 0);
        ctx.lineTo(playX, height);
        ctx.stroke();

        // Top triangle pointer
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(playX - 4, 0);
        ctx.lineTo(playX + 4, 0);
        ctx.lineTo(playX, 6);
        ctx.closePath();
        ctx.fill();
      }

      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [
    track,
    currentTime,
    viewOffset,
    viewDuration,
    waveformMode,
    selection,
    hoveredTime,
    snapTime,
    timeToPixel,
  ]);

  // Mouse interaction: Scrubbing / Selecting / Snap-to-beat hover tracking
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!track) return;
    if (e.button === 2) {
      // Right click context menu
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Check if clicked near a Memory Cue or Cue Marker in the top 30px
    if (clickY <= 30) {
      const cueNear = track.cues.find(
        (c) => Math.abs(timeToPixel(c.position, rect.width) - clickX) < 14
      );
      if (cueNear) {
        onSeek(cueNear.position);
        setContextMenu(null);
        return;
      }
    }

    const rawTime = pixelToTime(clickX, rect.width);
    const clickedTime = snapTime(rawTime);

    if (e.shiftKey && selection) {
      // Extend selection
      const newStart = Math.min(selection.start, clickedTime);
      const newEnd = Math.max(selection.start, clickedTime);
      updateSelectionRange(newStart, newEnd);
    } else {
      setIsSelecting(true);
      setDragStartSec(clickedTime);
      onSeek(clickedTime);
      setContextMenu(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!track) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const currX = e.clientX - rect.left;
    const currY = e.clientY - rect.top;
    const rawTime = pixelToTime(currX, rect.width);

    // Track hover position for snap-to-beat guide
    setHoveredTime(rawTime);
    setHoveredPos({ x: currX, y: currY });

    if (!isSelecting || dragStartSec === null) return;
    const currTime = snapTime(rawTime);

    const start = Math.min(dragStartSec, currTime);
    const end = Math.max(dragStartSec, currTime);

    if (end - start > 0.05) {
      updateSelectionRange(start, end);
    }
  };

  const handleMouseLeave = () => {
    setHoveredTime(null);
    setHoveredPos(null);
    setIsSelecting(false);
    setDragStartSec(null);
  };

  const handleMouseUp = () => {
    setIsSelecting(false);
    setDragStartSec(null);
  };

  const updateSelectionRange = (start: number, end: number) => {
    if (!track) return;
    const bg = track.beatGrid;
    const spb = 60.0 / bg.bpm;
    const startBeat = Math.max(0, (start - bg.firstBeat) / spb);
    const endBeat = Math.max(0, (end - bg.firstBeat) / spb);
    const beatsCount = Math.max(0, endBeat - startBeat);
    const barsCount = beatsCount / bg.meter;

    onSelect({
      start,
      end,
      startBeat,
      endBeat,
      beatsCount,
      barsCount,
      duration: end - start,
    });
  };

  // Right-click context menu
  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!track) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const timeAtClick = pixelToTime(clickX, rect.width);

    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      timeAtClick,
    });
  };

  // Zoom via mouse wheel
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      onZoomIn();
    } else {
      onZoomOut();
    }
  };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isDraggingOver) setIsDraggingOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingOver(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          onDropFile?.(e.dataTransfer.files[0]);
        }
      }}
      className={`relative flex-1 bg-[#0b0c0f] flex overflow-hidden select-none transition-all ${
        isDraggingOver ? 'ring-2 ring-[#00a2ff] ring-inset bg-[#0d1525]' : ''
      }`}
    >
      {/* Left side column: Collapsible Pioneer DJ Memory Cue & Beatgrid Fine Adjustment tools */}
      {track && (
        <>
          {showLeftTools ? (
            <div className="w-11 bg-[#0d0e12] border-r border-[#181a22] flex flex-col justify-between py-1.5 px-1 z-20 flex-shrink-0 select-none">
              {/* Top: BPM display tag + Collapse button */}
              <div className="flex flex-col space-y-1">
                <div className="flex items-center justify-between">
                  <div className="bg-[#16171e] border border-[#262835] rounded-xs px-1 py-0.5 text-center flex-1">
                    <span className="text-[9px] font-mono font-bold text-white tracking-tighter">
                      {track.bpm.toFixed(1)}
                    </span>
                  </div>
                  <button
                    onClick={() => setShowLeftTools(false)}
                    className="p-0.5 ml-0.5 text-neutral-500 hover:text-white"
                    title="Werkzeuge einklappen"
                  >
                    <ChevronLeft size={10} />
                  </button>
                </div>
              </div>

              {/* Middle: Pioneer Memory Cue Navigation (MEM <, +MEM, MEM >) */}
              <div className="flex flex-col space-y-1 items-center border-y border-[#1a1b24] py-1.5 my-1">
                <div className="text-[7.5px] text-[#ff3b30] font-bold tracking-tighter">
                  MEM CUE
                </div>
                <div className="flex space-x-0.5 w-full">
                  <button
                    onClick={onPrevMemoryCue}
                    className="flex-1 h-5 bg-[#1f1618] border border-[#4a1c20] hover:bg-[#ff2222] text-[#ff6666] hover:text-white rounded-xs flex items-center justify-center text-[8px] font-bold transition-colors"
                    title="Previous Memory Cue (CDJ Memory Call <)"
                  >
                    &lt;
                  </button>
                  <button
                    onClick={onNextMemoryCue}
                    className="flex-1 h-5 bg-[#1f1618] border border-[#4a1c20] hover:bg-[#ff2222] text-[#ff6666] hover:text-white rounded-xs flex items-center justify-center text-[8px] font-bold transition-colors"
                    title="Next Memory Cue (CDJ Memory Call >)"
                  >
                    &gt;
                  </button>
                </div>
                <button
                  onClick={onAddMemoryCue}
                  className="w-full h-4 bg-[#261618] border border-[#521c22] hover:bg-[#ff2222] text-[#ff8888] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors"
                  title="Set Memory Cue at Current Position (MEM)"
                >
                  +MEM
                </button>
              </div>

              {/* Rekordbox Beatgrid Adjustments (GRID <, >, 1.1, AUTO) */}
              <div className="flex flex-col space-y-1 items-center w-full">
                <div className="text-[7.5px] text-[#00a2ff] font-bold tracking-wider">
                  GRID
                </div>
                <div className="flex space-x-0.5 w-full">
                  <button
                    onClick={(e) => onShiftBeatgrid?.(e.shiftKey ? -0.01 : -0.001)}
                    className="flex-1 h-4 bg-[#141822] border border-[#23304a] hover:bg-[#0088ff] text-[#70b0ff] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors"
                    title="Grid feinjustieren: 1ms nach links (Shift: 10ms)"
                  >
                    ◀
                  </button>
                  <button
                    onClick={(e) => onShiftBeatgrid?.(e.shiftKey ? 0.01 : 0.001)}
                    className="flex-1 h-4 bg-[#141822] border border-[#23304a] hover:bg-[#0088ff] text-[#70b0ff] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors"
                    title="Grid feinjustieren: 1ms nach rechts (Shift: 10ms)"
                  >
                    ▶
                  </button>
                </div>
                <button
                  onClick={onSetFirstBeatHere}
                  className="w-full h-4 bg-[#1e2330] border border-[#2e3b55] hover:bg-[#2563eb] text-[#8cb4ff] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors"
                  title="Takt 1.1 an aktuellen Playhead setzen"
                >
                  1.1
                </button>
                <button
                  onClick={onAutoAlignBeatgrid}
                  className="w-full h-4 bg-[#12241c] border border-[#1d4634] hover:bg-[#10b981] text-[#6ee7b7] hover:text-white rounded-xs flex items-center justify-center text-[7px] font-bold transition-colors"
                  title="Auto-Align: Grid an Transienten ausrichten"
                >
                  AUTO
                </button>
              </div>
            </div>
          ) : (
            /* Collapsed mini-tab to open Beatgrid/Cue tools only when needed */
            <button
              onClick={() => setShowLeftTools(true)}
              className="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-12 bg-[#141620]/90 hover:bg-[#222638] border-r border-y border-[#2d3248] rounded-r-xs text-neutral-400 hover:text-white flex items-center justify-center z-30 transition-colors shadow-md"
              title="Cue- & Beatgrid-Werkzeuge einblenden"
            >
              <ChevronRight size={10} />
            </button>
          )}
        </>
      )}

      {/* Center Waveform Canvas */}
      <div ref={canvasContainerRef} className="flex-1 h-full relative overflow-hidden bg-[#0a0b0d]">
        <canvas
          ref={canvasRef}
          width={1200}
          height={320}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onContextMenu={handleContextMenu}
          className={`w-full h-full block ${track ? 'cursor-crosshair' : 'cursor-default'}`}
        />

        {/* Top Header Bar: BPM Badge + Predefined Zoom Levels Dropdown */}
        {track && (
          <div className="absolute top-1 left-2 z-10 select-none flex items-center space-x-2">
            <span className="text-[12px] font-mono font-bold text-white/95 bg-[#12141a]/90 border border-[#2d3142]/80 px-2 py-0.5 rounded-xs tracking-wider shadow-md">
              {track.bpm.toFixed(2)} BPM
            </span>

            {/* Predefined Zoom Dropdown */}
            <div className="flex items-center space-x-1.5 bg-[#12141a]/90 backdrop-blur-sm border border-[#2d3142]/80 px-2 py-0.5 rounded-xs shadow-md">
              <ZoomIn size={11} className="text-[#00a2ff]" />
              <label htmlFor="zoom-preset-select" className="text-[9.5px] font-mono font-bold text-neutral-400 uppercase tracking-wider">
                Zoom:
              </label>
              <select
                id="zoom-preset-select"
                value={
                  Math.abs(viewDuration - track.duration) < 1.0
                    ? 'FULL_TRACK'
                    : Math.abs(viewDuration - (60 / track.bpm) * 4 * 2) < 0.6
                    ? '2_BARS'
                    : Math.abs(viewDuration - (60 / track.bpm) * 4 * 4) < 1.0
                    ? '4_BARS'
                    : Math.abs(viewDuration - (60 / track.bpm) * 4 * 8) < 1.8
                    ? '8_BARS'
                    : Math.abs(viewDuration - (60 / track.bpm) * 4 * 16) < 3.5
                    ? '16_BARS'
                    : Math.abs(viewDuration - (60 / track.bpm) * 4 * 32) < 7.0
                    ? '32_BARS'
                    : Math.abs(viewDuration - (60 / track.bpm) * 4 * 64) < 14.0
                    ? '64_BARS'
                    : 'CUSTOM'
                }
                onChange={(e) => {
                  const val = e.target.value;
                  if (val !== 'CUSTOM' && onSelectZoomPreset) {
                    onSelectZoomPreset(val as any);
                  }
                }}
                className="bg-[#181a24] text-[#00a2ff] font-mono font-semibold text-[10.5px] px-1.5 py-0.5 rounded border border-[#2c3144] focus:outline-none focus:border-[#0088ff] cursor-pointer hover:border-[#3d4560] transition-colors"
                title="Vordefinierte Zoom-Stufe auswählen (8 Bars, 16 Bars, Full Track)"
              >
                <option value="2_BARS">2 Bars (Takt 1-2)</option>
                <option value="4_BARS">4 Bars (16 Beats)</option>
                <option value="8_BARS">8 Bars (32 Beats)</option>
                <option value="16_BARS">16 Bars (Phrasen)</option>
                <option value="32_BARS">32 Bars (Sektion)</option>
                <option value="64_BARS">64 Bars (Block)</option>
                <option value="FULL_TRACK">Full Track (Gesamt)</option>
                <option value="CUSTOM" disabled>
                  {`Custom (${viewDuration.toFixed(1)}s)`}
                </option>
              </select>
            </div>
          </div>
        )}

        {/* Empty State Overlay */}
        {!track && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-auto bg-[#0b0c10]/85 p-6 z-10 select-none backdrop-blur-[2px]">
            <div className="max-w-md w-full flex flex-col items-center text-center p-6 border border-dashed border-[#2b3040] rounded-lg bg-[#0e1017]/90 shadow-2xl">
              <div className="w-12 h-12 rounded-full bg-[#0088ff]/10 border border-[#0088ff]/30 flex items-center justify-center mb-3 text-[#00a2ff]">
                <UploadCloud size={24} />
              </div>
              <h3 className="text-sm font-bold text-white tracking-wide uppercase mb-1 font-mono">
                Kein Track geladen (Bereit für Import)
              </h3>
              <p className="text-xs text-neutral-400 mb-4 max-w-xs">
                Ziehe eine <span className="text-[#00a2ff] font-mono font-medium">Rekordbox XML</span> oder <span className="text-white font-mono font-medium">Audiodatei</span> direkt hierher:
              </p>

              <div className="flex flex-wrap gap-2 justify-center mb-4">
                {onImportXmlClick && (
                  <button
                    onClick={onImportXmlClick}
                    className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#0088ff] hover:bg-[#0077ee] text-white rounded text-xs font-semibold shadow transition-colors"
                  >
                    <FolderOpen size={13} />
                    <span>Rekordbox XML importieren</span>
                  </button>
                )}
                {onLoadAudioClick && (
                  <button
                    onClick={onLoadAudioClick}
                    className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#1e2230] hover:bg-[#272d40] border border-[#343b52] text-neutral-200 rounded text-xs font-medium transition-colors"
                  >
                    <FileAudio size={13} />
                    <span>Audiodatei öffnen</span>
                  </button>
                )}
              </div>

              <div className="flex items-center space-x-1.5 text-[10px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2.5 py-1 rounded">
                <ShieldCheck size={12} className="text-emerald-400" />
                <span>ORIGINALSCHUTZ: Originaldateien verbleiben strikt unverändert</span>
              </div>
            </div>
          </div>
        )}

        {/* Track loaded from XML/DB but audio file not yet linked */}
        {track && !track.audioBuffer && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-auto bg-[#0b0c10]/75 p-6 z-10 select-none backdrop-blur-[1.5px]">
            <div className="max-w-md w-full flex flex-col items-center text-center p-5 border border-amber-500/40 rounded-lg bg-[#10121a]/95 shadow-2xl">
              <div className="w-11 h-11 rounded-full bg-amber-500/15 border border-amber-500/40 flex items-center justify-center mb-2.5 text-amber-400">
                <FileAudio size={22} />
              </div>
              <h3 className="text-sm font-bold text-white tracking-wide uppercase mb-1 font-mono">
                Keine Audiodatei für &quot;{track.title}&quot; verknüpft
              </h3>
              <p className="text-xs text-neutral-300 mb-3 max-w-sm">
                Rekordbox-Metadaten (Beatgrid, Cues, Phrases) sind aktiv. Wähle die Original-Audiodatei (WAV, MP3, FLAC, AIFF) aus, um echte Musik abzuspielen:
              </p>

              <div className="flex items-center gap-2 mb-3">
                {onLoadAudioClick && (
                  <button
                    onClick={onLoadAudioClick}
                    className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#0088ff] hover:bg-[#0077ee] text-white rounded text-xs font-semibold shadow transition-colors cursor-pointer"
                  >
                    <FolderOpen size={13} />
                    <span>Audiodatei auswählen (WAV, MP3, FLAC)...</span>
                  </button>
                )}
              </div>

              <span className="text-[10.5px] text-neutral-400 font-mono">
                Oder ziehe die MP3/WAV-Datei einfach per Drag &amp; Drop hierher
              </span>
            </div>
          </div>
        )}

        {/* Subtle Database Extraction & Memory Cue Status Overlay */}
        {track && (
          <div className="absolute bottom-1.5 left-2 pointer-events-none flex items-center space-x-2 text-[9.5px] font-mono select-none">
            <span className="px-1.5 py-0.5 rounded-xs bg-[#0088ff]/20 border border-[#0088ff]/40 text-[#00a2ff] font-semibold">
              {track.databaseRecord?.databaseSource || track.origin}
            </span>
            <span className="text-[#ff5555] font-semibold">
              {track.cues.filter((c) => c.type === 'MEMORY').length} MEMORY CUES
            </span>
            <span className="text-neutral-600">•</span>
            <span className="text-neutral-400">
              {track.analysis?.length || 0} WAVEFORM BUCKETS
            </span>
            {track.phrases && track.phrases.length > 0 && (
              <>
                <span className="text-neutral-600">•</span>
                <span className="text-[#f59e0b]">
                  {track.phrases.length} PHRASES (PSSI)
                </span>
              </>
            )}
          </div>
        )}

        {/* Context Menu */}
        {contextMenu && (
          <div
            style={{ top: Math.min(contextMenu.y - 40, window.innerHeight - 300), left: Math.min(contextMenu.x, window.innerWidth - 220) }}
            className="fixed w-52 bg-[#161820] border border-[#2d303c] rounded shadow-2xl py-1 z-50 text-xs text-neutral-200"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                onSeek(contextMenu.timeAtClick);
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white flex justify-between"
            >
              <span>Play from here</span>
              <span className="text-neutral-500 font-mono text-[10px]">Space</span>
            </button>

            <button
              onClick={() => {
                onAddCue(contextMenu.timeAtClick);
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white"
            >
              Set Memory Cue
            </button>

            <button
              onClick={() => {
                onSeek(contextMenu.timeAtClick);
                onSetFirstBeatHere?.();
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[#2563eb] text-[#8cb4ff] hover:text-white flex items-center justify-between"
            >
              <span>Set 1.1 (Bar 1) here</span>
              <span className="text-[10px] font-mono text-[#60a5fa]">1.1</span>
            </button>

            <button
              onClick={() => {
                onAutoAlignBeatgrid?.();
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[#059669] text-[#6ee7b7] hover:text-white flex items-center justify-between"
            >
              <span>Auto-Align Beatgrid</span>
              <span className="text-[10px] font-mono text-[#34d399]">AUTO</span>
            </button>

            <div className="h-px bg-[#262832] my-1" />

            {selection && (
              <>
                <button
                  onClick={() => {
                    onAddToPalette(selection.start, selection.end);
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white font-medium text-[#00a2ff]"
                >
                  Add to Palette (Clip)
                </button>
                <button
                  onClick={() => { onCopy(); setContextMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white"
                >
                  Copy Selection
                </button>
                <button
                  onClick={() => { onCut(); setContextMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white"
                >
                  Cut Selection
                </button>
                <button
                  onClick={() => { onReplace(); setContextMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white text-[#ff9500]"
                >
                  Replace with Clip
                </button>
                <button
                  onClick={() => { onOverdub(); setContextMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white text-[#00c853]"
                >
                  Overdub with Clip
                </button>
                <button
                  onClick={() => { onDelete(); setContextMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#ff3b30] hover:text-white text-[#ff453a]"
                >
                  Delete Selection
                </button>
                <button
                  onClick={() => { onClear(); setContextMenu(null); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white"
                >
                  Clear Selection
                </button>
              </>
            )}

            {!selection && (
              <button
                onClick={() => { onPaste(); setContextMenu(null); }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#0088ff] hover:text-white"
              >
                Paste at Playhead
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
