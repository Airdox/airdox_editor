/**
 * @license
 * Rekordbox DetailWaveform Component
 * High-performance 60fps Canvas renderer implementing the strict visual lock
 * from screenshots 01, 02, and 03:
 * - Wellenform-Modi: AMBER (Standard, warm), BLUE, RGB, 3BAND
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
import { analysisSourceLabel } from '../waveform/analyzer';
import { recomputedBucketCount } from '../waveform/editAnalysis';
import {
  AMBER_ACCENT,
  AMBER_ACCENT_LINE,
  AMBER_HOT,
  AMBER_LOOP_TINT,
  WAVEFORM_BACKGROUNDS,
  amberColorCss,
  amberCoreAlpha,
  amberCoreColor,
} from '../waveform/colors';
import {
  CLIP_DND_MIME,
  CLIP_DROP_LABELS,
  dropModeFor,
  readClipDragPayload,
  resolveClipTargetTime,
  type ClipDropMode,
} from '../audio/clipLibrary';
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
  /** Ein Clip aus der Clip-Bibliothek wurde auf die Zeitachse gezogen. */
  onDropClip?: (
    clipId: string,
    timeSeconds: number,
    modifiers: { altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }
  ) => void;
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
  onDropClip,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [dragStartSec, setDragStartSec] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [clipDrag, setClipDrag] = useState<{ x: number; seconds: number; mode: ClipDropMode } | null>(null);

  /** Clip-Angebot erkennen, ohne fremde Drag-Inhalte zu schlucken. */
  const carriesClip = (transfer: DataTransfer) =>
    Array.from(transfer.types || []).some((type) => type === CLIP_DND_MIME);

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

      // 1. Dark background – warm und fast schwarz, damit die Kurve satt wirkt
      ctx.fillStyle = WAVEFORM_BACKGROUNDS[waveformMode] ?? WAVEFORM_BACKGROUNDS.AMBER;
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
          // Prominent Bar vertical downbeat line
          ctx.strokeStyle = 'rgba(235, 50, 50, 0.7)';
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.moveTo(x, 18);
          ctx.lineTo(x, height);
          ctx.stroke();

          // Rekordbox authentic Bar badge in top ruler
          ctx.fillStyle = '#b91c1c';
          ctx.fillRect(x - 1, 2, 20, 14);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px monospace';
          ctx.fillText(`${barNumber}`, x + 2.5, 12.5);

          // Red triangle pointing down from ruler
          ctx.beginPath();
          ctx.moveTo(x - 3, 16);
          ctx.lineTo(x + 3, 16);
          ctx.lineTo(x, 20);
          ctx.closePath();
          ctx.fillStyle = '#b91c1c';
          ctx.fill();
        } else {
          // Intermediate beat lines
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(x, 18);
          ctx.lineTo(x, height);
          ctx.stroke();

          // Top ruler tick
          ctx.strokeStyle = '#606578';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, 11);
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
        const secPerBucket = track.duration / buckets;
        const startBucket = Math.max(0, Math.floor(viewOffset / secPerBucket));
        const endBucket = Math.min(buckets - 1, Math.ceil((viewOffset + viewDuration) / secPerBucket));

        const maxHalfH = height * 0.42;

        for (let b = startBucket; b <= endBucket; b++) {
          const t = b * secPerBucket;
          const x = timeToPixel(t, width);
          const nextX = timeToPixel(t + secPerBucket, width);
          const colW = Math.max(1.2, nextX - x);

          const peak = analysis.peaks[b];
          const low = analysis.lowEnergy[b];
          const mid = analysis.midEnergy[b];
          const high = analysis.highEnergy[b];

          if (waveformMode === 'AMBER') {
            // Gesättigtes Bernstein: die Rampe hält die Sättigung, leise Balken
            // bleiben tiefes Brandorange, laute werden heißes Gold. Dieselbe
            // Farbmathematik wie in der Übersichtsspur, in den Clips und in den Tests.
            const barH = Math.max(2, peak * maxHalfH);
            ctx.fillStyle = amberColorCss(peak, low, high);
            ctx.fillRect(x, centerY - barH, colW, barH * 2);
            // Heiße Spitze: nur die lautesten Balken bekommen einen goldglühenden
            // Abschluss – statt des früheren weißen Streifens quer durch die Kurve.
            if (peak >= 0.82) {
              ctx.fillStyle = AMBER_HOT;
              ctx.fillRect(x, centerY - barH, colW, Math.min(3, barH * 0.34));
              ctx.fillRect(x, centerY + barH - Math.min(3, barH * 0.34), colW, Math.min(3, barH * 0.34));
            }
            const coreA = amberCoreAlpha(peak, high);
            if (coreA > 0) {
              ctx.globalAlpha = coreA;
              ctx.fillStyle = amberCoreColor(peak, high);
              ctx.fillRect(x, centerY - 1, colW, 2);
              ctx.globalAlpha = 1;
            }
          } else if (waveformMode === 'BLUE') {
            // High-contrast electric blue waveform
            const barH = Math.max(2, peak * maxHalfH);
            // Core transient
            ctx.fillStyle = '#0a9dff';
            ctx.fillRect(x, centerY - barH, colW, barH * 2);
            // Highlight-Spikes: gesättigter und dünner als früher, damit die
            // Kurve nicht zur blassen Fläche wird.
            ctx.fillStyle = '#8fe9ff';
            ctx.fillRect(x, centerY - barH * 0.22, colW, barH * 0.44);
          } else if (waveformMode === 'RGB') {
            // Frequency color mapping (Lows=Red, Mids=Cyan/Green, Highs=Blue/White)
            const barH = Math.max(2, peak * maxHalfH);
            const r = Math.min(255, Math.floor(low * 255 + mid * 70));
            const g = Math.min(255, Math.floor(mid * 240 + high * 60));
            const bCol = Math.min(255, Math.floor(high * 255 + low * 30));

            ctx.fillStyle = `rgb(${r}, ${g}, ${bCol})`;
            ctx.fillRect(x, centerY - barH, colW, barH * 2);

            // Bright center spine – nur bei deutlichen Höhen, nicht als Dauergrau
            if (high > 0.45) {
              ctx.fillStyle = `rgba(255, 248, 220, ${Math.min(0.34, (high - 0.45) * 0.62)})`;
              ctx.fillRect(x, centerY - 1, colW, 2);
            }
          } else {
            // 3BAND Mode: Separate layers
            const lowH = Math.max(1, low * maxHalfH * 0.8);
            const midH = Math.max(1, mid * maxHalfH * 0.7);
            const highH = Math.max(1, high * maxHalfH * 0.6);

            // Lows (Red)
            ctx.fillStyle = '#ff2b2b';
            ctx.fillRect(x, centerY - lowH, colW, lowH * 2);
            // Mids (Cyan/Green)
            ctx.fillStyle = '#00e5ff';
            ctx.fillRect(x, centerY - midH * 0.6, colW, midH * 1.2);
            // Highs (warmes Gold statt Reinweiss – Reissweiss wirkt auf dunklem
            // Grund ausgewaschen)
            ctx.fillStyle = '#ffe9a8';
            ctx.fillRect(x, centerY - highH * 0.3, colW, highH * 0.6);
          }
        }
      }

      // 3b. Beatgrid overlay lines over waveform (ensures beatgrid lines cut cleanly through loud transients)
      for (let b = startBeat; b <= endBeat; b++) {
        const beatTime = bg.firstBeat + b * secondsPerBeat;
        const x = timeToPixel(beatTime, width);
        if (x < -10 || x > width + 10) continue;
        const isBar = b % bg.meter === 0;

        if (isBar) {
          ctx.strokeStyle = 'rgba(255, 60, 60, 0.65)';
          ctx.lineWidth = 1.0;
          ctx.beginPath();
          ctx.moveTo(x, 18);
          ctx.lineTo(x, height);
          ctx.stroke();
        } else {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
          ctx.lineWidth = 0.6;
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

        // Dünner Amber-Ton: früher 0.15 – das hat die Wellenform unter dem Loop
        // zusätzlich blass gemacht.
        ctx.fillStyle = AMBER_LOOP_TINT;
        ctx.fillRect(Math.max(0, lx1), 18, Math.min(width, lx2) - Math.max(0, lx1), height - 18);

        ctx.strokeStyle = AMBER_ACCENT;
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

      // 7. Draw Playhead (White vertical hairline)
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
    timeToPixel,
  ]);

  // Mouse interaction: Scrubbing / Selecting
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
    if (!track || !isSelecting || dragStartSec === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const currX = e.clientX - rect.left;
    const rawTime = pixelToTime(currX, rect.width);
    const currTime = snapTime(rawTime);

    const start = Math.min(dragStartSec, currTime);
    const end = Math.max(dragStartSec, currTime);

    if (end - start > 0.05) {
      updateSelectionRange(start, end);
    }
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

  // Wie viele Buckets nicht aus der Importkurve stammen – nach einem Eingriff der
  // ehrliche Hinweis darauf, dass nur dieses Fenster neu gezeichnet wurde.
  const drawnBuckets = track.analysis ? recomputedBucketCount(track.analysis, track.duration) : 0;
  const gridLabel = track.beatGrid.beatsAreDerived
    ? `GRID ${track.beatGrid.bpm.toFixed(1)} BPM · FORTGESCHRIEBEN`
    : `GRID ${track.beatGrid.bpm.toFixed(1)} BPM · IMPORTIERT`;

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isDraggingOver) setIsDraggingOver(true);
        if (track && carriesClip(e.dataTransfer)) {
          e.dataTransfer.dropEffect = 'copy';
          const rect = canvasRef.current?.getBoundingClientRect();
          const width = rect?.width || 1;
          const x = rect ? Math.min(Math.max(e.clientX - rect.left, 0), width) : 0;
          const raw = pixelToTime(x, width);
          const mode = dropModeFor({ altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey });
          const resolved = resolveClipTargetTime(raw, track.beatGrid, {
            quantize: quantize,
            mode,
            maxSeconds: mode === 'insert' ? Number.POSITIVE_INFINITY : track.duration,
          });
          setClipDrag({ x, seconds: resolved.seconds, mode });
        } else if (clipDrag) {
          setClipDrag(null);
        }
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingOver(false);
        setClipDrag(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingOver(false);
        const payload = readClipDragPayload(e.dataTransfer);
        if (payload && track) {
          const rect = canvasRef.current?.getBoundingClientRect();
          const width = rect?.width || 1;
          const seconds = pixelToTime(rect ? Math.min(Math.max(e.clientX - rect.left, 0), width) : 0, width);
          onDropClip?.(payload.clipId, seconds, {
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            metaKey: e.metaKey,
          });
          setClipDrag(null);
          return;
        }
        setClipDrag(null);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          onDropFile?.(e.dataTransfer.files[0]);
        }
      }}
      className={`relative flex-1 bg-[#0a0806] flex overflow-hidden select-none transition-all ${
        clipDrag ? 'ring-2 ring-inset' : isDraggingOver ? 'ring-2 ring-[#00a2ff] ring-inset bg-[#0d1525]' : ''
      }`}
    >
      {/* Left side column: BPM display, Memory Cue controls & Zoom controls */}
      <div className="w-12 bg-[#0d0e12] border-r border-[#181a22] flex flex-col justify-between py-1.5 px-1 z-20 flex-shrink-0">
        {/* Top: BPM display tag */}
        <div className="flex flex-col space-y-1">
          <div className="bg-[#16171e] border border-[#262835] rounded-xs px-0.5 py-0.5 text-center">
            <span className="text-[9.5px] font-mono font-bold text-white tracking-tighter">
              {track ? track.bpm.toFixed(2) : '--.--'}
            </span>
          </div>

          {/* Database Inspector button */}
          {onOpenDatabaseInspector && (
            <button
              onClick={onOpenDatabaseInspector}
              disabled={!track}
              className={`w-full py-0.5 rounded-xs text-[7.5px] font-bold tracking-tight transition-colors text-center ${
                track
                  ? 'bg-[#0088ff]/15 hover:bg-[#0088ff] text-[#0088ff] hover:text-white border border-[#0088ff]/30'
                  : 'bg-[#15161c] text-neutral-600 border border-neutral-800 cursor-not-allowed'
              }`}
              title="Rekordbox Datenbank & Visualisierungs-Daten"
            >
              DATA
            </button>
          )}
        </div>

        {/* Middle: Pioneer Memory Cue Navigation (MEM <, +MEM, MEM >) */}
        <div className="flex flex-col space-y-1 items-center border-y border-[#1a1b24] py-1.5 my-1">
          <div className="text-[7.5px] text-[#ff3b30] font-bold tracking-tighter">
            MEM CUE
          </div>
          <div className="flex space-x-0.5 w-full">
            <button
              onClick={onPrevMemoryCue}
              disabled={!track}
              className="flex-1 h-5 bg-[#1f1618] border border-[#4a1c20] hover:bg-[#ff2222] text-[#ff6666] hover:text-white rounded-xs flex items-center justify-center text-[8px] font-bold transition-colors disabled:opacity-30 disabled:pointer-events-none"
              title="Previous Memory Cue (CDJ Memory Call <)"
            >
              &lt;
            </button>
            <button
              onClick={onNextMemoryCue}
              disabled={!track}
              className="flex-1 h-5 bg-[#1f1618] border border-[#4a1c20] hover:bg-[#ff2222] text-[#ff6666] hover:text-white rounded-xs flex items-center justify-center text-[8px] font-bold transition-colors disabled:opacity-30 disabled:pointer-events-none"
              title="Next Memory Cue (CDJ Memory Call >)"
            >
              &gt;
            </button>
          </div>
          <button
            onClick={onAddMemoryCue}
            disabled={!track}
            className="w-full h-4 bg-[#261618] border border-[#521c22] hover:bg-[#ff2222] text-[#ff8888] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors disabled:opacity-30 disabled:pointer-events-none"
            title="Set Memory Cue at Current Position (MEM)"
          >
            +MEM
          </button>
        </div>

        {/* Rekordbox Beatgrid Adjustments (GRID <, >, 1.1, AUTO) */}
        <div className="flex flex-col space-y-1 items-center border-b border-[#1a1b24] pb-1.5 mb-1 w-full">
          <div className="text-[7.5px] text-[#00a2ff] font-bold tracking-wider">
            GRID
          </div>
          <div className="flex space-x-0.5 w-full">
            <button
              onClick={(e) => onShiftBeatgrid?.(e.shiftKey ? -0.01 : -0.001)}
              disabled={!track}
              className="flex-1 h-4 bg-[#141822] border border-[#23304a] hover:bg-[#0088ff] text-[#70b0ff] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors disabled:opacity-30 disabled:pointer-events-none"
              title="Grid feinjustieren: 1ms nach links (Shift: 10ms)"
            >
              ◀
            </button>
            <button
              onClick={(e) => onShiftBeatgrid?.(e.shiftKey ? 0.01 : 0.001)}
              disabled={!track}
              className="flex-1 h-4 bg-[#141822] border border-[#23304a] hover:bg-[#0088ff] text-[#70b0ff] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors disabled:opacity-30 disabled:pointer-events-none"
              title="Grid feinjustieren: 1ms nach rechts (Shift: 10ms)"
            >
              ▶
            </button>
          </div>
          <button
            onClick={onSetFirstBeatHere}
            disabled={!track}
            className="w-full h-4 bg-[#1e2330] border border-[#2e3b55] hover:bg-[#2563eb] text-[#8cb4ff] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors disabled:opacity-30 disabled:pointer-events-none"
            title="Takt 1.1 an aktuellen Playhead setzen (Set 1.1 here)"
          >
            1.1
          </button>
          <button
            onClick={onAutoAlignBeatgrid}
            disabled={!track}
            className="w-full h-4 bg-[#12241c] border border-[#1d4634] hover:bg-[#10b981] text-[#6ee7b7] hover:text-white rounded-xs flex items-center justify-center text-[7px] font-bold transition-colors disabled:opacity-30 disabled:pointer-events-none"
            title="Wellenform-Transienten analysieren & Grid automatisch anpassen (Auto-Align)"
          >
            AUTO
          </button>
        </div>

        {/* Bottom Zoom controls (+, RST, -, <, >) */}
        <div className="flex flex-col space-y-1 items-center">
          {/* Zoom in (+) */}
          <button
            onClick={onZoomIn}
            disabled={!track}
            className="w-7 h-5 bg-[#181920] border border-[#2b2e3a] hover:bg-[#252834] text-neutral-300 hover:text-white rounded-xs flex items-center justify-center transition-colors disabled:opacity-30 disabled:pointer-events-none"
            title="Zoom In (+)"
          >
            <Plus size={10} strokeWidth={2.5} />
          </button>

          {/* Reset Zoom (RST) */}
          <button
            onClick={onResetZoom}
            disabled={!track}
            className="w-7 h-4 bg-[#181920] border border-[#2b2e3a] hover:bg-[#252834] text-neutral-300 hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors disabled:opacity-30 disabled:pointer-events-none"
            title="Reset Zoom (RST)"
          >
            RST
          </button>

          {/* Zoom out (-) */}
          <button
            onClick={onZoomOut}
            disabled={!track}
            className="w-7 h-5 bg-[#181920] border border-[#2b2e3a] hover:bg-[#252834] text-neutral-300 hover:text-white rounded-xs flex items-center justify-center transition-colors disabled:opacity-30 disabled:pointer-events-none"
            title="Zoom Out (-)"
          >
            <Minus size={10} strokeWidth={2.5} />
          </button>

          {/* Pan Left (<) */}
          <button
            onClick={() => onPanView(Math.max(0, viewOffset - viewDuration * 0.25))}
            disabled={!track}
            className="w-7 h-5 bg-[#181920] border border-[#2b2e3a] hover:bg-[#252834] text-neutral-300 hover:text-white rounded-xs flex items-center justify-center transition-colors disabled:opacity-30 disabled:pointer-events-none"
            title="Pan Left (<)"
          >
            <ChevronLeft size={11} />
          </button>

          {/* Pan Right (>) */}
          <button
            onClick={() => track && onPanView(Math.min(track.duration - viewDuration, viewOffset + viewDuration * 0.25))}
            disabled={!track}
            className="w-7 h-5 bg-[#181920] border border-[#2b2e3a] hover:bg-[#252834] text-neutral-300 hover:text-white rounded-xs flex items-center justify-center transition-colors disabled:opacity-30 disabled:pointer-events-none"
            title="Pan Right (>)"
          >
            <ChevronRight size={11} />
          </button>
        </div>
      </div>

      {/* Center Waveform Canvas */}
      <div className="flex-1 h-full relative overflow-hidden bg-[#0a0b0d]">
        {clipDrag && (
          <div className="absolute inset-0 pointer-events-none z-30">
            <div
              className="absolute top-0 bottom-0 w-px"
              style={{ left: `${clipDrag.x}px`, backgroundColor: AMBER_ACCENT_LINE, boxShadow: `0 0 8px ${AMBER_ACCENT}` }}
            />
            <div
              className="absolute top-1 -translate-x-1/2 px-2 py-1 rounded-xs text-[9.5px] font-mono whitespace-nowrap border"
              style={{
                left: `${clipDrag.x}px`,
                backgroundColor: 'rgba(12,10,4,0.92)',
                borderColor: AMBER_ACCENT,
                color: '#ffd9a0',
              }}
            >
              {CLIP_DROP_LABELS[clipDrag.mode]} · {clipDrag.seconds.toFixed(3)} s
            </div>
          </div>
        )}
        <canvas
          ref={canvasRef}
          width={1200}
          height={320}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
          className={`w-full h-full block ${track ? 'cursor-crosshair' : 'cursor-default'}`}
        />

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

        {/* Subtle Database Extraction & Memory Cue Status Overlay */}
        {track ? (
          <div className="absolute bottom-1.5 left-2 pointer-events-none flex items-center space-x-2 text-[9.5px] font-mono select-none">
            <span className="px-1.5 py-0.5 rounded-xs bg-[#0088ff]/20 border border-[#0088ff]/40 text-[#00a2ff] font-semibold">
              {track.databaseRecord?.databaseSource || track.origin}
            </span>
            <span className="text-[#ff5555] font-semibold">
              {track.cues.filter((c) => c.type === 'MEMORY').length} MEMORY CUES
            </span>
            <span className="text-neutral-600">•</span>
            <span className="text-neutral-400">
              {track.analysis?.length || 0} WAVEFORM BUCKETS · {analysisSourceLabel(track.analysis?.origin)}
              {drawnBuckets > 0 && (
                <span className="text-amber-400"> · {drawnBuckets} NEU GEZEICHNET</span>
              )}
            </span>
            <span className="text-neutral-600">•</span>
            <span className={track.beatGrid.beatsAreDerived ? 'text-amber-400' : 'text-neutral-400'}>
              {gridLabel}
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
        ) : (
          <div className="absolute bottom-1.5 left-2 pointer-events-none flex items-center space-x-2 text-[9.5px] font-mono select-none text-neutral-500">
            <span className="px-1.5 py-0.5 rounded-xs bg-[#161822] border border-[#262835] text-neutral-400 font-semibold">
              STANDBY / LEERES PROJEKT
            </span>
            <span>KEINE MEDIENDATEN GELADEN</span>
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
                  Add to Clip Library
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
