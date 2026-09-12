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
  DataOrigin,
} from '../types/rekordbox';
import type { ProjectedSpanView } from '../edit/editModel';
import {
  beginDrag,
  endDrag,
  isFileDrag,
  isInternalDrag,
  readDragPayload,
  dropEffectFor,
  resolveDragPayload,
  structuralDropMode,
} from '../dnd/dragPayload';
import {
  BAR_SHADE_FILL,
  beatIndexAtOrAfter,
  collectVisibleBeats,
  columnDrawWidth,
  isBarShaded,
  monoBlueColor,
  pwv4BackColor,
  pwv4FrontColor,
  rgbColumnColor,
  rgbCss,
  selectWaveformVariant,
  threeBandLayers,
  VisibleBeat,
} from '../waveform/renderModel';
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
  MousePointerClick,
} from 'lucide-react';

/** Colour of the pending drop footprint, keyed by structural drop mode. */
const DROP_COLORS: Record<'insert' | 'replace' | 'overdub', string> = {
  insert: '#00a2ff',
  replace: '#ffb340',
  overdub: '#d24dff',
};

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
  /** Drag & drop: a palette clip dropped on the timeline (insert/replace/overdub). */
  onDropClip?: (
    clipId: string,
    projectStart: number,
    mode: 'insert' | 'replace' | 'overdub',
    windowEnd?: number
  ) => void;
  /** Drag & drop: a collection/browser row dropped on the deck loads it. */
  onDropTrack?: (trackId: string) => void;
  /** Duration/name of a clip, needed to preview the drop footprint. */
  clipInfo?: (clipId: string) => { name: string; duration: number } | null;
  /** Projected edit spans (audio blocks) drawn under the waveform. */
  spans?: ProjectedSpanView[];
  /** Dragging an inserted clip block re-positions it on the timeline. */
  onMoveSpan?: (segmentId: string, newProjectStart: number) => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  timeAtClick: number;
}

/** Visible status for the deterministic master.db → AnalysisDataPath path. */
function anlzLookupParts(track: TrackModel | null): { label: string; title: string } {
  if (track?.analysis && track.analysis.length > 0) {
    return { label: `${track.analysis.length} BUCKETS`, title: 'Rekordbox-ANLZ aus dem master.db-Analysepfad geladen.' };
  }
  return {
    label: '— MISSING_REKORDBOX_ANALYSIS',
    title: 'Keine Rekordbox-Waveformdaten geladen. Es wird keine Ersatz-Waveform erzeugt.',
  };
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
  onDropTrack,
  clipInfo,
  spans,
  onMoveSpan,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [dragStartSec, setDragStartSec] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const [hoveredPos, setHoveredPos] = useState<{ x: number; y: number } | null>(null);

  // ── Drag & drop state ────────────────────────────────────────────────────
  // Kept in refs because the waveform is drawn in a requestAnimationFrame loop:
  // the ghost follows the pointer without re-creating the render effect.
  const dropHintRef = useRef<{
    clipId: string;
    start: number;
    end: number;
    mode: 'insert' | 'replace' | 'overdub';
    label: string;
  } | null>(null);
  const [dropModeLabel, setDropModeLabel] = useState<string | null>(null);
  const [isClipDragOver, setIsClipDragOver] = useState(false);
  const [isTrackDragOver, setIsTrackDragOver] = useState(false);
  const moveDragRef = useRef<{
    segmentId: string;
    label: string;
    grabOffset: number;
    duration: number;
    /** Where the block was before this drag — a move to the same spot is a no-op. */
    sourceStart: number;
    target: number;
  } | null>(null);
  const [movingSegmentId, setMovingSegmentId] = useState<string | null>(null);
  /** Height of the edit-span strip drawn at the bottom of the waveform. */
  const SPAN_STRIP_H = 16;

  // Crisp canvas: back the CSS box with devicePixelRatio-scaled pixels so the
  // visual lock stays sharp on HiDPI displays instead of a stretched bitmap.
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
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

  // Helper to snap time to nearest beat (prefers original Rekordbox beat
  // nodes; uniform reconstruction only when no nodes are stored).
  const snapTime = useCallback(
    (t: number) => {
      if (!quantize || !track) return t;
      const bg = track.beatGrid;
      if (bg.beats && bg.beats.length > 0) {
        const idx = beatIndexAtOrAfter(bg.beats, t);
        const after = bg.beats[Math.min(idx, bg.beats.length - 1)].time;
        const before = bg.beats[Math.max(0, idx - 1)].time;
        return Math.max(0, Math.abs(after - t) < Math.abs(t - before) ? after : before);
      }
      // A Rekordbox grid without PQTZ nodes is missing analysis, not a request
      // to manufacture a uniform replacement from BPM/firstBeat.
      if (
        track.origin === DataOrigin.REKORDBOX_XML ||
        track.origin === DataOrigin.REKORDBOX_DB ||
        track.origin === DataOrigin.REKORDBOX_ANLZ
      ) return t;
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
      // Original Rekordbox beat nodes (PQTZ/XML) have priority; the uniform
      // firstBeat+bpm reconstruction runs only for compact grids without nodes.
      const bg = track.beatGrid;
      const secondsPerBeat = 60.0 / bg.bpm;
      let visibleBeats: VisibleBeat[];
      if (bg.beats && bg.beats.length > 0) {
        visibleBeats = collectVisibleBeats(bg.beats, viewOffset - 1, viewOffset + viewDuration + 1);
      } else if (
        track.origin === DataOrigin.REKORDBOX_XML ||
        track.origin === DataOrigin.REKORDBOX_DB ||
        track.origin === DataOrigin.REKORDBOX_ANLZ
      ) {
        // Missing PQTZ remains visibly missing for Rekordbox tracks.
        visibleBeats = [];
      } else {
        const startBeat = Math.max(0, Math.floor((viewOffset - bg.firstBeat) / secondsPerBeat));
        const endBeat = Math.ceil((viewOffset + viewDuration - bg.firstBeat) / secondsPerBeat);
        visibleBeats = [];
        for (let b = startBeat; b <= endBeat; b++) {
          visibleBeats.push({
            time: bg.firstBeat + b * secondsPerBeat,
            isBar: b % bg.meter === 0,
            barNumber: Math.floor(b / bg.meter) + 1,
            tail: false,
          });
        }
      }

      // Bar-label decluttering: Rekordbox numbers bars only as densely as the
      // zoom allows (e.g. every 4 bars: 129, 133). Below ~40 px per bar only
      // every Nth bar gets a label; labels are also suppressed while they
      // would slide under the top-left BPM badge (~58 px).
      const pxPerBar = Math.max(1, ((secondsPerBeat * bg.meter) / Math.max(0.001, viewDuration)) * width);
      const barLabelEvery = Math.max(1, Math.ceil(40 / pxPerBar));

      for (const vb of visibleBeats) {
        const x = timeToPixel(vb.time, width);
        if (x < -20 || x > width + 20) continue;

        const isBar = vb.isBar;
        const barNumber = vb.barNumber;
        // Uniform tail continuations (appended after the last verbatim beat)
        // render dimmed so genuine Rekordbox beats stay distinguishable.
        const tail = vb.tail;

        if (isBar) {
          // Rekordbox authentic solid white Bar vertical downbeat line
          ctx.strokeStyle = tail ? 'rgba(255, 255, 255, 0.45)' : '#ffffff';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();

          // Rekordbox Bar number in top ruler (e.g. 109, 113)
          const showLabel = ((barNumber - 1) % barLabelEvery === 0) && x >= 58;
          if (showLabel) {
            ctx.fillStyle = tail ? 'rgba(255, 255, 255, 0.55)' : '#ffffff';
            ctx.font = 'bold 11px sans-serif';
            ctx.fillText(`${barNumber}`, x + 3, 14);
          }
        } else {
          // Intermediate beat lines (beats 2, 3, 4)
          ctx.strokeStyle = tail ? 'rgba(255, 255, 255, 0.10)' : 'rgba(255, 255, 255, 0.22)';
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

      // 2a. Authentic alternating bar shading behind the waveform
      // (reference 01/02: even bars sit on a slightly lighter ground).
      const barStarts = visibleBeats.filter((v) => v.isBar);
      for (let i = 0; i < barStarts.length; i++) {
        const a = barStarts[i];
        if (!isBarShaded(a.barNumber)) continue;
        const nextTime =
          i + 1 < barStarts.length ? barStarts[i + 1].time : viewOffset + viewDuration + 1;
        const x1 = Math.max(0, timeToPixel(a.time, width));
        const x2 = Math.min(width, timeToPixel(nextTime, width));
        if (x2 - x1 <= 0) continue;
        ctx.fillStyle = BAR_SHADE_FILL;
        ctx.fillRect(x1, 18, x2 - x1, height - 18);
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
      // Zoom-matched variant: every candidate is genuine ANLZ data — the
      // selector only decides which resolution fits the current view.
      const candidates =
        track.analysisVariants && track.analysisVariants.length > 0
          ? track.analysisVariants
          : track.analysis
            ? [track.analysis]
            : [];
      const variantIdx = selectWaveformVariant(
        candidates.map((c) => c.length),
        viewDuration,
        track.duration,
        width
      );
      const analysis = variantIdx >= 0 ? candidates[variantIdx] : null;
      if (analysis && analysis.length > 0) {
        const buckets = analysis.length;
        // DAT-only preview variants (PWAV/PWV2/PWV3) carry one mono channel;
        // Rekordbox renders those in its classic preview blue — never as fake
        // RGB color. Band variants (PWV5/PWV7/...) use the spectral palette.
        const isMonoPreview =
          analysis.sourceTag === 'PWAV' ||
          analysis.sourceTag === 'PWV2' ||
          analysis.sourceTag === 'PWV3';
        const secPerBucket = analysis.secPerBucket || (track.duration / buckets);
        const startBucket = Math.max(0, Math.floor(viewOffset / secPerBucket) - 1);
        const endBucket = Math.min(buckets - 1, Math.ceil((viewOffset + viewDuration) / secPerBucket) + 1);

        const maxHalfH = height * 0.42;

        for (let b = startBucket; b <= endBucket; b++) {
          const t = b * secPerBucket;
          const centerT = t + secPerBucket * 0.5;
          const x = timeToPixel(centerT, width);
          const nextX = timeToPixel(centerT + secPerBucket, width);
          // Comb look: 1 px black gap between columns once zoomed in enough.
          const colW = columnDrawWidth(Math.max(1, nextX - x));

          const peak = analysis.peaks[b];
          const low = analysis.lowEnergy[b];
          const mid = analysis.midEnergy[b];
          const high = analysis.highEnergy[b];

          const colX = x - colW * 0.5;

          if (waveformMode === '3BAND') {
            // Documented 3-band look (PWV6/PWV7): same axis, lows dark blue,
            // mids amber translucent, highs white last.
            for (const layer of threeBandLayers(low, mid, high, maxHalfH)) {
              if (layer.halfHeight <= 0) continue;
              ctx.globalAlpha = layer.alpha;
              ctx.fillStyle = rgbCss(layer.color);
              ctx.fillRect(colX, centerY - layer.halfHeight, colW, layer.halfHeight * 2);
            }
            ctx.globalAlpha = 1;
          } else if (waveformMode === 'BLUE') {
            // Documented blue waveform: stored height + stored whiteness.
            const w = analysis.whiteness ? analysis.whiteness[b] : peak;
            const barH = Math.max(1, peak * maxHalfH);
            ctx.fillStyle = rgbCss(monoBlueColor(w));
            ctx.fillRect(colX, centerY - barH, colW, barH * 2);
          } else if (analysis.frontPeaks && analysis.luminance && analysis.backPeaks) {
            // Documented PWV4 two-tone: back column rgb·luminance at the back
            // height, brighter front column at the stored front height.
            const lum = analysis.luminance[b];
            const backH = Math.max(1, analysis.backPeaks[b] * maxHalfH);
            ctx.fillStyle = rgbCss(pwv4BackColor(low, mid, high, lum));
            ctx.fillRect(colX, centerY - backH, colW, backH * 2);
            const frontH = Math.max(1, analysis.frontPeaks[b] * maxHalfH);
            ctx.fillStyle = rgbCss(pwv4FrontColor(low, mid, high, lum));
            ctx.fillRect(colX, centerY - frontH, colW, frontH * 2);
          } else if (isMonoPreview) {
            // Mono variant in RGB mode: the documented blue ramp.
            const w = analysis.whiteness ? analysis.whiteness[b] : peak;
            const barH = Math.max(1, peak * maxHalfH);
            ctx.fillStyle = rgbCss(monoBlueColor(w));
            ctx.fillRect(colX, centerY - barH, colW, barH * 2);
          } else {
            // Documented PWV5: stored RGB is the column color, stored 5-bit
            // value the column height.
            const barH = Math.max(1, peak * maxHalfH);
            ctx.fillStyle = rgbCss(rgbColumnColor(low, mid, high));
            ctx.fillRect(colX, centerY - barH, colW, barH * 2);
          }
        }

        // Active variant provenance (zoom-dependent), drawn in-canvas so it
        // never lags the rendered frame.
        if (analysis.sourceTag) {
          ctx.textAlign = 'right';
          ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
          ctx.font = '9px monospace';
          ctx.fillText(analysis.sourceTag, width - 6, height - 6);
          ctx.textAlign = 'left';
        }
      } else {
        // Without ANLZ there is no waveform data — the original Rekordbox
        // shows an empty waveform pane here. We draw nothing invented (no
        // fake contour, no amplitudes); the beatgrid lines and ruler above
        // already visualize the imported grid data. Only the honest hint:
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.font = '11px sans-serif';
        ctx.fillText('KEINE WAVEFORM-DATEN (ANLZ fehlt) – das Original zeigt hier ebenfalls keine Wellenform', width / 2, height - 10);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.font = '9px sans-serif';
        ctx.fillText('Beatgrid & Cues stammen aus dem Rekordbox-Import – für echte Peaks ANLZ über DATA zuordnen', width / 2, height - 22);
        ctx.textAlign = 'left';
      }

      // 3b. Beatgrid overlay lines over waveform (clean white downbeat lines, subtle beat lines)
      for (const vb of visibleBeats) {
        const x = timeToPixel(vb.time, width);
        if (x < -10 || x > width + 10) continue;
        const isBar = vb.isBar;
        const tail = vb.tail;

        if (isBar) {
          ctx.strokeStyle = tail ? 'rgba(255, 255, 255, 0.45)' : '#ffffff';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x, 18);
          ctx.lineTo(x, height);
          ctx.stroke();
        } else {
          ctx.strokeStyle = tail ? 'rgba(255, 255, 255, 0.10)' : 'rgba(255, 255, 255, 0.2)';
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

      // 8. Edit-Spuren (projizierte Blöcke) + Drop-Vorschau
      // Die Projektion ist das, was nach einem Drop gilt: Originalblöcke,
      // Clip-Einschübe, Ersetzungen, Überlagerungen und Stillefenster. Der
      // Drop-Geist zeigt vorab, welches Fenster ein Drop erzeugt.
      const stripTop = height - SPAN_STRIP_H;
      if (spans && spans.length > 0) {
        ctx.save();
        ctx.fillStyle = 'rgba(5,6,10,0.72)';
        ctx.fillRect(0, stripTop, width, SPAN_STRIP_H);
        for (const span of spans) {
          const x1 = timeToPixel(span.start, width);
          const x2 = timeToPixel(span.start + span.duration, width);
          const w = x2 - x1;
          if (x2 <= 0 || x1 >= width) continue;
          const color = span.color;
          const isMoving = moveDragRef.current?.segmentId === span.segmentId;
          const isGrabbed = span.segmentId === movingSegmentId;
          ctx.fillStyle = color + '4d';
          ctx.fillRect(x1, stripTop + 2, Math.max(1, w), SPAN_STRIP_H - 4);
          if (span.kind === 'silence') {
            // Diagonal hatching keeps a muted window visually distinct from audio.
            ctx.save();
            ctx.beginPath();
            ctx.rect(x1, stripTop + 2, Math.max(1, w), SPAN_STRIP_H - 4);
            ctx.clip();
            ctx.strokeStyle = 'rgba(255,255,255,0.14)';
            ctx.lineWidth = 1;
            for (let hx = x1 - SPAN_STRIP_H; hx < x2 + SPAN_STRIP_H; hx += 6) {
              ctx.beginPath();
              ctx.moveTo(hx, stripTop + SPAN_STRIP_H);
              ctx.lineTo(hx + SPAN_STRIP_H, stripTop);
              ctx.stroke();
            }
            ctx.restore();
          }
          ctx.strokeStyle = isMoving || isGrabbed ? '#ffffff' : color + 'aa';
          ctx.lineWidth = isMoving || isGrabbed ? 1.6 : 1;
          ctx.strokeRect(x1 + 0.5, stripTop + 2.5, Math.max(1, w - 1), SPAN_STRIP_H - 5);
          if (w > 52) {
            ctx.fillStyle = color;
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(span.label, x1 + 6, stripTop + SPAN_STRIP_H / 2);
          }
          if (span.movable && w > 96) {
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.font = '8px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText('ziehen = verschieben', x2 - 6, stripTop + SPAN_STRIP_H / 2);
          }
        }
        ctx.restore();
      }
      const dropHint = dropHintRef.current;
      if (dropHint) {
        ctx.save();
        const x1 = timeToPixel(dropHint.start, width);
        const x2 = timeToPixel(dropHint.end, width);
        const w = Math.max(3, x2 - x1);
        const color = DROP_COLORS[dropHint.mode] ?? '#00a2ff';
        ctx.fillStyle = color + '33';
        ctx.fillRect(x1, 18, w, Math.max(2, stripTop - 18));
        ctx.strokeStyle = color;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x1 + 0.5, 18.5, w, Math.max(2, stripTop - 19));
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.fillRect(x1 - 3, stripTop, 6, SPAN_STRIP_H);
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const label = `${dropHint.label} · ${dropHint.mode.toUpperCase()}`;
        const labelW = ctx.measureText(label).width;
        const textX = x1 + 8 + labelW > width ? Math.max(4, x1 - 8 - labelW) : x1 + 8;
        ctx.fillStyle = '#0b0c0f';
        ctx.fillRect(textX - 4, 22, labelW + 8, 16);
        ctx.fillStyle = color;
        ctx.fillText(label, textX, 25);
        ctx.restore();
      }

      // 9. Draw Playhead (White vertical hairline)
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
    spans,
    movingSegmentId,
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

    // Grab an inserted clip block in the edit strip to move it on the timeline.
    if (!e.shiftKey && spans && spans.length > 0 && onMoveSpan) {
      const hit = spanAtPoint(e.clientX, clickY);
      if (hit && hit.movable) {
        moveDragRef.current = {
          segmentId: hit.segmentId,
          label: hit.label,
          duration: hit.duration,
          sourceStart: hit.start,
          grabOffset: timeAtClientX(e.clientX) - hit.start,
          target: hit.start,
        };
        setMovingSegmentId(hit.segmentId);
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

  // Time under an arbitrary client X coordinate (canvas box, CSS pixels).
  const timeAtClientX = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return 0;
      const rect = canvas.getBoundingClientRect();
      const px = Math.max(0, Math.min(clientX - rect.left, rect.width));
      return pixelToTime(px, rect.width);
    },
    [pixelToTime]
  );

  // Which projected edit block sits under the pointer (only the bottom strip).
  const spanAtPoint = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !spans || spans.length === 0) return null;
      const rect = canvas.getBoundingClientRect();
      if (clientY < rect.height - SPAN_STRIP_H || clientY > rect.height) return null;
      const t = timeAtClientX(clientX);
      for (const span of spans) {
        if (t >= span.start && t <= span.start + span.duration) return span;
      }
      return null;
    },
    [spans, timeAtClientX]
  );

  // A span-move drag can end outside the canvas: listen on the window.
  useEffect(() => {
    if (!movingSegmentId) return;
    const finish = () => {
      const move = moveDragRef.current;
      moveDragRef.current = null;
      setMovingSegmentId(null);
      if (move && onMoveSpan && Math.abs(move.target - move.sourceStart) > 1e-6) {
        onMoveSpan(move.segmentId, move.target);
      }
    };
    window.addEventListener('mouseup', finish);
    return () => window.removeEventListener('mouseup', finish);
  }, [movingSegmentId, onMoveSpan]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!track) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const currX = e.clientX - rect.left;
    const currY = e.clientY - rect.top;
    const rawTime = pixelToTime(currX, rect.width);

    // A block being dragged in the edit strip: only move it, no selection.
    const move = moveDragRef.current;
    if (move) {
      const target = Math.max(0, snapTime(rawTime - move.grabOffset));
      if (Math.abs(target - move.target) > 1e-9) {
        moveDragRef.current = { ...move, target };
      }
      return;
    }

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
        const payload = resolveDragPayload(e.dataTransfer);
        if (payload?.kind === 'clip') {
          const usable = !!track && !!onDropClip;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = usable
            ? dropEffectFor(structuralDropMode(e).mode)
            : 'none';
          if (!usable) {
            // No deck track (or no handler): say why the drop is refused instead of
            // swallowing it — an unexplained no-op looks like a broken app.
            dropHintRef.current = null;
            const why = !onDropClip
              ? 'Clip-Drop ist hier nicht vorgesehen'
              : 'Clip-Drop braucht einen geladenen Deck-Track';
            if (dropModeLabel !== why) setDropModeLabel(why);
            return;
          }
          const mode = structuralDropMode(e).mode;
          const info = clipInfo?.(payload.clipId) ?? null;
          const snapped = snapTime(timeAtClientX(e.clientX));
          const clipDuration = info?.duration ?? 0;
          const end =
            mode === 'overdub' && selection && selection.end > snapped
              ? selection.end
              : snapped + clipDuration;
          dropHintRef.current = {
            clipId: payload.clipId,
            start: snapped,
            end,
            mode,
            label: info?.name ?? payload.label ?? 'Clip',
          };
          const label =
            mode === 'insert'
              ? `BEI ${snapped.toFixed(2)} s EINFÜGEN (Alles danach rückt nach rechts)`
              : mode === 'replace'
              ? `FENSTER ${snapped.toFixed(2)}–${end.toFixed(2)} s ERSETZEN`
              : `ÜBER ${snapped.toFixed(2)}–${end.toFixed(2)} s ÜBERLAGERN (Mix)`;
          if (dropModeLabel !== label) setDropModeLabel(label);
          if (!isClipDragOver) setIsClipDragOver(true);
          return;
        }
        if (payload?.kind === 'track') {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'link';
          if (!isTrackDragOver) setIsTrackDragOver(true);
          return;
        }
        if (payload?.kind === 'selection') {
          // A selection dragged out of the deck: accepted only by the palette.
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          return;
        }
        if (onDropFile && isFileDrag(e.dataTransfer)) {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          if (!isDraggingOver) setIsDraggingOver(true);
        }
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isDraggingOver) setIsDraggingOver(false);
        if (isClipDragOver) setIsClipDragOver(false);
        if (isTrackDragOver) setIsTrackDragOver(false);
      }}
      onDrop={(e) => {
        const payload = readDragPayload(e.dataTransfer);
        const hint = dropHintRef.current;
        dropHintRef.current = null;
        e.preventDefault();
        e.stopPropagation();
        setDropModeLabel(null);
        setIsClipDragOver(false);
        setIsTrackDragOver(false);
        setIsDraggingOver(false);
        if (payload?.kind === 'clip') {
          if (track && onDropClip) {
            const mode = structuralDropMode(e).mode;
            const info = clipInfo?.(payload.clipId) ?? null;
            const snapped = snapTime(timeAtClientX(e.clientX));
            const start = hint && hint.clipId === payload.clipId ? hint.start : snapped;
            const windowEnd =
              mode === 'overdub'
                ? (hint && hint.clipId === payload.clipId
                    ? hint.end
                    : selection && selection.end > snapped
                    ? selection.end
                    : snapped + (info?.duration ?? 0))
                : undefined;
            onDropClip(payload.clipId, start, mode, windowEnd);
          }
          return;
        }
        if (payload?.kind === 'track') {
          onDropTrack?.(payload.trackId);
          return;
        }
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          onDropFile?.(e.dataTransfer.files[0]);
        }
      }}
      className={`relative flex-1 bg-[#0b0c0f] flex overflow-hidden select-none transition-all ${
        isClipDragOver
          ? 'ring-2 ring-[#00a2ff] ring-inset bg-[#0d1525]'
          : isTrackDragOver
          ? 'ring-2 ring-[#10b981] ring-inset bg-[#0b1a16]'
          : isDraggingOver
          ? 'ring-2 ring-[#00a2ff] ring-inset bg-[#0d1525]'
          : ''
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
        <div className="flex flex-col space-y-1 items-center border-y border-[#1c202d] py-1.5 my-1">
          <div className="text-[7.5px] text-[#ff453a] font-bold tracking-wider">
            MEM CUE
          </div>
          <div className="flex space-x-0.5 w-full">
            <button
              onClick={onPrevMemoryCue}
              disabled={!track}
              className="flex-1 h-5 bg-[#1b1c24] border border-[#303648] hover:bg-[#ff3b30] text-neutral-300 hover:text-white rounded-xs flex items-center justify-center text-[8.5px] font-bold transition-colors disabled:opacity-25 disabled:pointer-events-none"
              title="Previous Memory Cue (CDJ Memory Call <)"
            >
              &lt;
            </button>
            <button
              onClick={onNextMemoryCue}
              disabled={!track}
              className="flex-1 h-5 bg-[#1b1c24] border border-[#303648] hover:bg-[#ff3b30] text-neutral-300 hover:text-white rounded-xs flex items-center justify-center text-[8.5px] font-bold transition-colors disabled:opacity-25 disabled:pointer-events-none"
              title="Next Memory Cue (CDJ Memory Call >)"
            >
              &gt;
            </button>
          </div>
          <button
            onClick={onAddMemoryCue}
            disabled={!track}
            className="w-full h-4.5 bg-[#201c22] border border-[#3f292f] hover:bg-[#ff3b30] text-[#ff9999] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors disabled:opacity-25 disabled:pointer-events-none"
            title="Set Memory Cue at Current Position (MEM)"
          >
            +MEM
          </button>
        </div>

        {/* Rekordbox Beatgrid Adjustments (GRID <, >, 1.1, AUTO) */}
        <div className="flex flex-col space-y-1 items-center border-b border-[#1c202d] pb-1.5 mb-1 w-full">
          <div className="text-[7.5px] text-[#0091ff] font-bold tracking-wider">
            GRID
          </div>
          <div className="flex space-x-0.5 w-full">
            <button
              onClick={(e) => onShiftBeatgrid?.(e.shiftKey ? -0.01 : -0.001)}
              disabled={!track}
              className="flex-1 h-4 bg-[#141722] border border-[#262c3e] hover:bg-[#0088ff] text-[#80b8ff] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors disabled:opacity-25 disabled:pointer-events-none"
              title="Grid feinjustieren: 1ms nach links (Shift: 10ms)"
            >
              ◀
            </button>
            <button
              onClick={(e) => onShiftBeatgrid?.(e.shiftKey ? 0.01 : 0.001)}
              disabled={!track}
              className="flex-1 h-4 bg-[#141722] border border-[#262c3e] hover:bg-[#0088ff] text-[#80b8ff] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors disabled:opacity-25 disabled:pointer-events-none"
              title="Grid feinjustieren: 1ms nach rechts (Shift: 10ms)"
            >
              ▶
            </button>
          </div>
          <button
            onClick={onSetFirstBeatHere}
            disabled={!track}
            className="w-full h-4 bg-[#171b26] border border-[#262f44] hover:bg-[#2563eb] text-[#8cb4ff] hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors disabled:opacity-25 disabled:pointer-events-none"
            title="Takt 1.1 an aktuellen Playhead setzen (Set 1.1 here)"
          >
            1.1
          </button>
          <button
            onClick={onAutoAlignBeatgrid}
            disabled={!track}
            className="w-full h-4 bg-[#131d1a] border border-[#1e3c30] hover:bg-[#10b981] text-[#6ee7b7] hover:text-white rounded-xs flex items-center justify-center text-[7px] font-bold transition-colors disabled:opacity-25 disabled:pointer-events-none"
            title="Wellenform-Transienten analysieren & Grid automatisch anpassen (Auto-Align)"
          >
            AUTO
          </button>
        </div>

        {/* Bottom Zoom controls (+, RST, -) */}
        <div className="flex flex-col space-y-1 items-center">
          {/* Zoom in (+) */}
          <button
            onClick={onZoomIn}
            disabled={!track}
            className="w-7 h-5 bg-[#171a22] border border-[#272d3e] hover:bg-[#242b3d] text-neutral-300 hover:text-white rounded-xs flex items-center justify-center transition-colors disabled:opacity-25 disabled:pointer-events-none"
            title="Zoom In (+)"
          >
            <Plus size={10} strokeWidth={2.5} />
          </button>

          {/* Reset Zoom (RST) */}
          <button
            onClick={onResetZoom}
            disabled={!track}
            className="w-7 h-4 bg-[#171a22] border border-[#272d3e] hover:bg-[#242b3d] text-neutral-300 hover:text-white rounded-xs flex items-center justify-center text-[7.5px] font-bold transition-colors disabled:opacity-25 disabled:pointer-events-none"
            title="Reset Zoom (RST)"
          >
            RST
          </button>

          {/* Zoom out (-) */}
          <button
            onClick={onZoomOut}
            disabled={!track}
            className="w-7 h-5 bg-[#171a22] border border-[#272d3e] hover:bg-[#242b3d] text-neutral-300 hover:text-white rounded-xs flex items-center justify-center transition-colors disabled:opacity-25 disabled:pointer-events-none"
            title="Zoom Out (-)"
          >
            <Minus size={10} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {/* Center Waveform Canvas */}
      <div className="flex-1 h-full relative overflow-hidden bg-[#0a0b0d]">
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

        {/* Pending drop: what this drop would do, and the modifier alternatives */}
        {dropModeLabel && (
          <div className="absolute top-1 left-1/2 -translate-x-1/2 z-20 pointer-events-none flex flex-col items-center gap-0.5">
            <span className="text-[10.5px] font-mono font-semibold text-white bg-[#0088ff]/85 border border-[#4db2ff] px-2 py-0.5 rounded-xs shadow-lg whitespace-nowrap">
              {dropModeLabel}
            </span>
            <span className="text-[9px] font-mono text-neutral-300 bg-[#0b0c0f]/85 border border-[#2d3142] px-1.5 py-0.5 rounded-xs whitespace-nowrap">
              ohne Modifier = einfügen · Shift/Strg = ersetzen · Alt = überlagern · SchnappRaster: {quantize ? 'Beat' : 'aus'}
            </span>
          </div>
        )}

        {movingSegmentId && (
          <div className="absolute top-1 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
            <span className="text-[10.5px] font-mono font-semibold text-black bg-[#ffb340] px-2 py-0.5 rounded-xs shadow-lg whitespace-nowrap">
              Clip-Block verschieben · loslassen zum Umsetzen
            </span>
          </div>
        )}

        {/* Top-Left Authentic Rekordbox BPM Badge */}
        {track && (
          <div className="absolute top-1 left-2 z-10 select-none pointer-events-none flex items-center">
            <span className="text-[12px] font-mono font-bold text-white/95 bg-[#12141a]/85 border border-[#2d3142]/80 px-1.5 py-0.5 rounded-xs tracking-wider shadow-sm">
              {track.bpm.toFixed(2)}
            </span>
          </div>
        )}

        {/* Selection → palette: drag this chip into the Schnipselpalette */}
        {track && selection && selection.end - selection.start > 0.02 && (
          <div
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'copy';
              beginDrag(e.dataTransfer, {
                kind: 'selection',
                start: selection.start,
                end: selection.end,
                label: `Auswahl ${selection.start.toFixed(2)}–${selection.end.toFixed(2)} s`,
              });
            }}
            onDragEnd={() => endDrag()}
            onClick={() => {
              onAddToPalette(selection.start, selection.end);
            }}
            title="Auswahl in die Schnipselpalette ziehen (oder klicken) – Zeitfenster auf der Timeline wird dabei nicht verändert"
            className="absolute bottom-1.5 right-2 z-20 flex items-center gap-1.5 text-[9.5px] font-mono font-semibold text-[#00a2ff] bg-[#0088ff]/15 border border-[#0088ff]/50 px-1.5 py-0.5 rounded-xs cursor-grab active:cursor-grabbing hover:bg-[#0088ff]/25 select-none"
          >
            <MousePointerClick size={10} />
            AUSWAHL {selection.duration.toFixed(2)} s → PALETTE (ziehen)
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
                Ziehe eine <span className="text-[#00a2ff] font-mono font-medium">Rekordbox XML</span>, eine <span className="text-white font-mono font-medium">Audiodatei</span> oder einen <span className="text-emerald-400 font-mono font-medium">Track</span> aus Sammlung/Browser direkt hierher:
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
              {track.cues.filter((c) => c.type === 'MEMORY').length} MEM
            </span>
            <span className="text-[#00a2ff] font-semibold">
              {track.cues.filter((c) => c.type === 'HOT_CUE').length} HOT
            </span>
            <span className="text-neutral-500 font-semibold">
              {track.cues.length} CUES
            </span>
            <span className="text-neutral-600">•</span>
            {track.editInfo && !track.editInfo.isIdentity && (
              <span className="text-neutral-600">•</span>
            )}
            {track.editInfo && !track.editInfo.isIdentity && (
              <span
                className="text-[#ffb340] font-semibold"
                title={`Wellenform der Edit-Timeline: ${track.editInfo.verbatimColumns} Spalten unverändert aus ANLZ, ${track.editInfo.retimedColumns} Spalten neu positioniert (aus gespeicherten ANLZ-Werten aufgerechnet), ${track.editInfo.clipColumns} Spalten aus Clip-ANLZ, ${track.editInfo.computedColumns} Spalten aus Edit-Audio berechnet, ${track.editInfo.silenceColumns} stummgeschaltet, ${track.editInfo.missingColumns} ohne Daten.
Originale bleiben unverändert; die Projektion wird bei jedem Edit/Undo neu abgeleitet.`}
              >
                EDIT-WAVEFORM {track.editInfo.verbatimColumns + track.editInfo.retimedColumns + track.editInfo.clipColumns}/{track.editInfo.columns} AUS ANLZ
                {track.editInfo.computedColumns > 0
                  ? ` · ${track.editInfo.computedColumns} BERECHNET`
                  : ' · KEINE NEUANALYSE'}
              </span>
            )}
            {(() => {
              const anl = anlzLookupParts(track);
              return (
                <span className="text-neutral-400" title={anl.title}>
                  {track.analysis?.sourceTag ? `${track.analysis.sourceTag} • ` : track.analysis ? '' : 'KEINE WAVEFORM • '}
                  {anl.label}
                  {track.analysisVariants && track.analysisVariants.length > 1
                    ? ` • ${track.analysisVariants.length} VARIANTEN`
                    : ''}
                </span>
              );
            })()}
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
