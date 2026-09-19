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
import {
  hasPaletteClipDrag,
  paletteDropTime,
  readPaletteClipDrag,
} from '../utils/paletteDrag';
import { spectralRgb, spectralRgbCore } from '../waveform/spectralColor';
import { playbackClock } from '../audio/playbackClock';

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
  onDropPaletteClip?: (clipId: string, time: number) => void;
  /** Startet die Track-Part-Analyse (Intro/Build/Drop/Break) mit Auto-Cues. */
  onAnalyzeParts?: () => void;
}

/** Höhe der farbigen Part-Leiste (Intro/Drop/Break …) unter der Wellenform. */
const PHRASE_LANE_HEIGHT = 18;

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
  onDropPaletteClip,
  onAnalyzeParts,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [dragStartSec, setDragStartSec] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // ── Performance: zweischichtiges Canvas-Rendering ─────────────────────────
  // Die statische Szene (Hintergrund, Beatgrid, Waveform, Cues, Loops) wird in
  // ein Offscreen-Canvas gezeichnet und NUR bei echten Änderungen (Track,
  // Zoom/Pan, Modus, Größe) neu gerendert. Pro Frame wird lediglich das
  // Offscreen-Canvas geblittet und Playhead/Auswahl/Hover darüber gezeichnet.
  // Vorher wurde die komplette Szene 60×/Sekunde neu gezeichnet und dabei die
  // ganze React-App mitgerendert – dadurch reagierten Buttons erst Sekunden
  // nach dem Klick.
  const staticCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Per-Frame-Daten als Refs: dürfen KEIN Re-Render und keinen Effect-Neustart
  // auslösen (Playhead-Zeit kommt aus dem playbackClock).
  const timeRef = useRef<number>(currentTime);
  const selectionRef = useRef<SelectionRange | null>(selection);
  const hoveredTimeRef = useRef<number | null>(null);
  const trackRef = useRef<TrackModel | null>(track);
  const timeToPixelRef = useRef<(t: number, width: number) => number>(() => 0);
  const snapTimeRef = useRef<(t: number) => number>((t) => t);
  selectionRef.current = selection;
  trackRef.current = track;

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
          // Größenänderung → statische Szene muss neu gerendert werden.
          setCanvasSize({ w, h });
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

  // Frische Callback-Identitäten für den Frame-Overlay-Pfad bereitstellen
  // (Refs vermeiden Effect-Neustarts bei jedem Render).
  timeToPixelRef.current = timeToPixel;

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
  snapTimeRef.current = snapTime;

  // ── Statische Szene (Hintergrund, Beatgrid, Waveform, Phrasen, Cues, Loops) ──
  // Wird in ein Offscreen-Canvas gezeichnet und ausschließlich bei echten
  // Änderungen (Track, Zoom/Pan, Anzeigemodus, Canvas-Größe) neu berechnet.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return;

    let off = staticCanvasRef.current;
    if (!off) {
      off = document.createElement('canvas');
      staticCanvasRef.current = off;
    }
    if (off.width !== canvas.width || off.height !== canvas.height) {
      off.width = canvas.width;
      off.height = canvas.height;
    }
    const ctx = off.getContext('2d');
    if (!ctx) return;

    const width = off.width;
    const height = off.height;
    ctx.clearRect(0, 0, width, height);

    const renderStatic = () => {
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

      // 3. Render the source waveform as a continuous silhouette.
      // Never use edit-operation bars or a synthetic beat pattern here: inserted,
      // replaced and overdubbed audio must be rendered by the same renderer as
      // the untouched source so the waveform has one consistent visual language.
      const analysis = track.analysis;
      if (analysis && analysis.length > 0) {
        const buckets = analysis.length;
        const secPerBucket = analysis.secPerBucket || (track.duration / buckets);
        const startBucket = Math.max(0, Math.floor(viewOffset / secPerBucket) - 1);
        const endBucket = Math.min(buckets - 1, Math.ceil((viewOffset + viewDuration) / secPerBucket) + 1);
        const maxHalfH = height * 0.42;

        // Render from recorded analysis values only. The continuous envelope keeps
        // the cleaned-up UI from main, while separate non-zero runs ensure a
        // cleared/silent range is never bridged or given an invented minimum height.
        type EnvelopePoint = { x: number; y: number };
        type EnvelopeRun = { upper: EnvelopePoint[]; lower: EnvelopePoint[] };
        const envelopeRuns = (amplitudeAt: (bucket: number) => number): EnvelopeRun[] => {
          const runs: EnvelopeRun[] = [];
          let run: EnvelopeRun | null = null;
          for (let bucket = startBucket; bucket <= endBucket; bucket++) {
            const amplitude = Math.max(0, Math.min(1, amplitudeAt(bucket) || 0));
            if (amplitude <= 0) {
              run = null;
              continue;
            }
            if (!run) {
              run = { upper: [], lower: [] };
              runs.push(run);
            }
            const x = timeToPixel((bucket + 0.5) * secPerBucket, width);
            const halfHeight = amplitude * maxHalfH;
            run.upper.push({ x, y: centerY - halfHeight });
            run.lower.push({ x, y: centerY + halfHeight });
          }
          return runs;
        };

        const drawEnvelope = (runs: EnvelopeRun[], colour: string | CanvasGradient, alpha = 1) => {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = colour;
          for (const { upper, lower } of runs) {
            if (upper.length === 1) {
              const halfHeight = centerY - upper[0].y;
              ctx.fillRect(upper[0].x - 0.5, centerY - halfHeight, 1, halfHeight * 2);
              continue;
            }
            ctx.beginPath();
            ctx.moveTo(upper[0].x, centerY);
            upper.forEach((point) => ctx.lineTo(point.x, point.y));
            for (let i = lower.length - 1; i >= 0; i--) ctx.lineTo(lower[i].x, lower[i].y);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
        };

        const peakRuns = envelopeRuns((bucket) => analysis.peaks[bucket]);
        if (waveformMode === 'BLUE') {
          drawEnvelope(peakRuns, '#159fe8');
          drawEnvelope(peakRuns, '#b8e9ff', 0.34);
        } else if (waveformMode === '3BAND') {
          // Each continuous layer follows its actual recorded frequency band.
          drawEnvelope(envelopeRuns((bucket) => analysis.lowEnergy[bucket] * 0.85), '#ff3b45', 0.72);
          drawEnvelope(envelopeRuns((bucket) => analysis.midEnergy[bucket] * 0.70), '#18d8df', 0.48);
          drawEnvelope(envelopeRuns((bucket) => analysis.highEnergy[bucket] * 0.55), '#effcff', 0.30);
        } else {
          // RGB: rekordbox-authentic per-column spectral colouring. Every pixel
          // column is coloured from the real frequency content at that time so
          // drops (bass-heavy) glow red/orange while breaks and vocal passages
          // read blue/green — song sections are recognisable at a glance.
          // A single static top-to-bottom gradient cannot express this.
          for (let x = 0; x < width; x++) {
            const t0 = viewOffset + (x / width) * viewDuration;
            const t1 = viewOffset + ((x + 1) / width) * viewDuration;
            const b0 = Math.max(0, Math.floor(t0 / secPerBucket));
            const b1 = Math.min(buckets - 1, Math.floor(t1 / secPerBucket));
            if (b1 < b0) continue;

            let maxPeak = 0;
            let sumLow = 0;
            let sumMid = 0;
            let sumHigh = 0;
            let count = 0;
            for (let b = b0; b <= b1; b++) {
              const p = analysis.peaks[b] || 0;
              if (p > maxPeak) maxPeak = p;
              sumLow += analysis.lowEnergy[b] || 0;
              sumMid += analysis.midEnergy[b] || 0;
              sumHigh += analysis.highEnergy[b] || 0;
              count++;
            }
            // Zero-energy (CLEAR/silence) columns stay empty — no invented floor.
            if (maxPeak <= 0) continue;

            const low = count > 0 ? sumLow / count : 0;
            const mid = count > 0 ? sumMid / count : 0;
            const high = count > 0 ? sumHigh / count : 0;

            const h = maxPeak * maxHalfH;
            ctx.fillStyle = spectralRgb(low, mid, high);
            ctx.fillRect(x, centerY - h, 1, h * 2);

            // Bright inner core in the same spectral hue gives the glowing
            // centre rekordbox waveforms have.
            const coreH = h * 0.45;
            if (coreH >= 0.5) {
              ctx.fillStyle = spectralRgbCore(low, mid, high);
              ctx.globalAlpha = 0.55;
              ctx.fillRect(x, centerY - coreH, 1, coreH * 2);
              ctx.globalAlpha = 1;
            }
          }
        }

        // Fine centre traces retain visual detail without manufacturing audio in
        // zero-valued analysis buckets. The RGB columns already carry their own
        // spectral highlight, so the white trace applies to envelope modes only.
        if (waveformMode !== 'RGB') {
          ctx.strokeStyle = 'rgba(220,245,255,.38)';
          ctx.lineWidth = 0.7;
          for (const { upper, lower } of peakRuns) {
            if (upper.length < 2) continue;
            ctx.beginPath();
            upper.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
            ctx.stroke();
            ctx.beginPath();
            lower.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
            ctx.stroke();
          }
        }
      } else {
        // Never invent a rhythmic waveform from BPM metadata. Until real
        // ANLZ/audio analysis exists, expose an honest empty lane.
        ctx.fillStyle = '#606578';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Keine native Rekordbox-Wellenform geladen', width / 2, centerY + 4);
        ctx.textAlign = 'left';

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

      // 3c. Track-Part-Leiste (Intro / Build / Drop / Break / Outro) unter der
      // Wellenform. Jede erkannte Sektion wird als farbiger Block gerendert;
      // die Startgrenzen sitzen auf den Taktstrichen des Beatgrids.
      const laneTop = height - PHRASE_LANE_HEIGHT;
      if (track.phrases && track.phrases.length > 0) {
        // Dunkler Leisten-Hintergrund überdeckt Beatgrid-Linien im Lane-Bereich
        ctx.fillStyle = '#0e1015';
        ctx.fillRect(0, laneTop, width, PHRASE_LANE_HEIGHT);
        ctx.strokeStyle = '#232635';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, laneTop);
        ctx.lineTo(width, laneTop);
        ctx.stroke();

        track.phrases.forEach((p) => {
          const px1 = timeToPixel(p.startTime, width);
          const px2 = timeToPixel(p.endTime, width);
          if (px2 < 0 || px1 > width) return;
          const left = Math.max(0, px1);
          const right = Math.min(width, px2);
          const pw = right - left;
          if (pw <= 1) return;

          // Farbiger Part-Block mit leichtem vertikalen Verlauf
          const grad = ctx.createLinearGradient(0, laneTop, 0, height);
          grad.addColorStop(0, p.color + 'e6');
          grad.addColorStop(1, p.color + '99');
          ctx.fillStyle = grad;
          ctx.fillRect(left, laneTop + 1.5, pw, PHRASE_LANE_HEIGHT - 2.5);

          // Part-Startgrenze: kräftige Linie in Part-Farbe hoch bis zur Wellenform
          if (px1 >= 0 && px1 <= width) {
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 1.4;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(px1, 18);
            ctx.lineTo(px1, laneTop);
            ctx.stroke();
            ctx.setLineDash([]);

            // Kleiner Pfeil an der Part-Grenze oberhalb der Leiste
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.moveTo(px1 - 4, laneTop - 5);
            ctx.lineTo(px1 + 4, laneTop - 5);
            ctx.lineTo(px1, laneTop);
            ctx.closePath();
            ctx.fill();
          }

          // Label (BREAKDOWN wird als BREAK angezeigt)
          if (pw > 30) {
            const label = p.name === 'BREAKDOWN' ? 'BREAK' : p.name;
            ctx.font = 'bold 9px sans-serif';
            const labelW = ctx.measureText(label).width;
            if (labelW + 8 <= pw) {
              ctx.fillStyle = 'rgba(0,0,0,0.55)';
              ctx.fillRect(left + 3, laneTop + 3.5, labelW + 6, 11);
              ctx.fillStyle = '#ffffff';
              ctx.fillText(label, left + 6, laneTop + 12.5);
            }
          }

          // Takt-Angabe rechtsbündig, wenn Platz vorhanden
          if (pw > 110) {
            const barsLabel = `${p.endBar - p.startBar} BARS`;
            ctx.font = '8px monospace';
            ctx.fillStyle = 'rgba(255,255,255,0.75)';
            ctx.textAlign = 'right';
            ctx.fillText(barsLabel, right - 4, laneTop + 12.5);
            ctx.textAlign = 'left';
          }
        });
      } else {
        // Leere, dezent markierte Leiste als Hinweis auf die Part-Analyse
        ctx.fillStyle = '#0d0f14';
        ctx.fillRect(0, laneTop, width, PHRASE_LANE_HEIGHT);
        ctx.strokeStyle = '#1c1f2b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, laneTop);
        ctx.lineTo(width, laneTop);
        ctx.stroke();
        ctx.fillStyle = '#495066';
        ctx.font = '9px sans-serif';
        ctx.fillText('Keine Track-Parts analysiert — „PARTS“ klicken für Intro/Build/Drop/Break-Erkennung', 8, laneTop + 12.5);
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

    };

    renderStatic();
  }, [track, viewOffset, viewDuration, waveformMode, timeToPixel, canvasSize]);

  // ── Dynamische Overlay-Szene (Auswahl, Hover-Guide, Playhead) ──────────────
  // Läuft über den zentralen playbackClock: pro Frame nur ein Blit des
  // Offscreen-Canvas plus wenige Primitive – keine React-Re-Renders, keine
  // Neuberechnung der Waveform. Die Playhead-Zeit kommt direkt aus dem
  // Audio-Engine (auch im Pausenzustand korrekt, siehe setTransportPosition).
  useEffect(() => {
    const drawFrame = () => {
      const canvas = canvasRef.current;
      const off = staticCanvasRef.current;
      if (!canvas || !off || canvas.width <= 0) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(off, 0, 0);

      if (!trackRef.current) return;
      const timeToPixel = timeToPixelRef.current;
      const selection = selectionRef.current;

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
      const hoveredTime = hoveredTimeRef.current;
      if (trackRef.current && hoveredTime !== null) {
        const track = trackRef.current;
        const bg = track.beatGrid;
        const spb = 60.0 / bg.bpm;
        const snappedTime = snapTimeRef.current(hoveredTime);
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

      // 8. Draw Playhead (White vertical hairline) – Zeit aus dem playbackClock
      const playX = timeToPixel(timeRef.current, width);
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
    };

    return playbackClock.subscribe((frame) => {
      timeRef.current = frame.time;
      drawFrame();
    });
  }, []);

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
    const rawTime = pixelToTime(currX, rect.width);

    // Track hover position for snap-to-beat guide (Ref statt State:
    // kein Re-Render pro Mausbewegung, Overlay zeichnet über den Clock).
    hoveredTimeRef.current = rawTime;

    if (!isSelecting || dragStartSec === null) return;
    const currTime = snapTime(rawTime);

    const start = Math.min(dragStartSec, currTime);
    const end = Math.max(dragStartSec, currTime);

    if (end - start > 0.05) {
      updateSelectionRange(start, end);
    }
  };

  const handleMouseLeave = () => {
    hoveredTimeRef.current = null;
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

  // Zoom via mouse wheel. React/Chromium registers delegated wheel
  // listeners as passive in modern Electron, so calling preventDefault() from
  // an `onWheel` prop logs "Unable to preventDefault inside passive event
  // listener invocation". Attach a local non-passive listener instead.
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      onZoomIn();
    } else {
      onZoomOut();
    }
  }, [onZoomIn, onZoomOut]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    node.addEventListener('wheel', handleWheel, { passive: false });
    return () => node.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  return (
    <div
      ref={containerRef}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const supported = hasPaletteClipDrag(e.dataTransfer) || Array.from(e.dataTransfer.types).includes('Files');
        e.dataTransfer.dropEffect = supported ? 'copy' : 'none';
        if (supported && !isDraggingOver) setIsDraggingOver(true);
        if (!supported && isDraggingOver) setIsDraggingOver(false);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // Ignore transitions into child controls/canvas; only clear when the
        // pointer actually leaves the complete waveform drop zone.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setIsDraggingOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingOver(false);

        const clipId = readPaletteClipDrag(e.dataTransfer);
        if (clipId && track && canvasRef.current) {
          const rect = canvasRef.current.getBoundingClientRect();
          const rawDropTime = paletteDropTime(
            e.clientX,
            rect.left,
            rect.width,
            viewOffset,
            viewDuration,
            track.duration
          );
          onDropPaletteClip?.(clipId, snapTime(rawDropTime));
          return;
        }
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          onDropFile?.(e.dataTransfer.files[0]);
        }
      }}
      className={`relative flex-1 bg-[#0b0c0f] flex overflow-hidden select-none transition-all ${
        isDraggingOver ? 'ring-2 ring-[#00a2ff] ring-inset bg-[#0d1525]' : ''
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

          {/* Track-Part-Analyse (Intro/Build/Drop/Break) mit Auto-Cues */}
          {onAnalyzeParts && (
            <button
              onClick={onAnalyzeParts}
              disabled={!track || !track.analysis}
              className={`w-full py-0.5 rounded-xs text-[7.5px] font-bold tracking-tight transition-colors text-center ${
                track && track.analysis
                  ? 'bg-[#f59e0b]/15 hover:bg-[#f59e0b] text-[#f59e0b] hover:text-black border border-[#f59e0b]/30'
                  : 'bg-[#15161c] text-neutral-600 border border-neutral-800 cursor-not-allowed'
              }`}
              title="Track-Parts analysieren (Intro, Build-Up, Drop, Break, Outro) und Cue-Punkte an prägnanten Stellen setzen"
            >
              PARTS
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

            {onAnalyzeParts && (
              <button
                onClick={() => {
                  onAnalyzeParts();
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-[#b45309] text-[#fbbf24] hover:text-white flex items-center justify-between"
              >
                <span>Track-Parts analysieren + Auto-Cues</span>
                <span className="text-[10px] font-mono text-[#f59e0b]">PARTS</span>
              </button>
            )}

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
                  Delete… (Variante auswählen)
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
