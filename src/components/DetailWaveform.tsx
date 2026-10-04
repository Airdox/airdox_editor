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
import { createLayerScheduler } from '../waveform/layerScheduler';
import { drawPlayhead, drawSelectionOverlay, drawSnapGuide } from '../waveform/canvasLayers';
import { subscribeTransport } from '../state/transportStore';
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
  Disc,
  FileAudio,
  ShieldCheck,
  ZoomIn,
} from 'lucide-react';
import {
  hasPaletteClipDrag,
  paletteDropTime,
  readPaletteClipDrag,
} from '../utils/paletteDrag';
import {
  REKORDBOX_BASELINE_HEX,
  renderRekordboxWaveformColumn,
  sampleWaveformColumn,
} from '../waveform/spectralColor';

interface DetailWaveformProps {
  track: TrackModel | null;
  /**
   * Live-Zugriff auf die Wiedergabeposition (Transport-Store). Bevorzugt, weil
   * die Position dann ohne React-Render in das Overlay fließen kann.
   */
  getPositionSec?: () => number;
  /** Position zum Zeitpunkt des letzten React-Renders (Fallback/Tests). */
  currentTime?: number;
  /**
   * Inkrement-Zähler des Elternbaums: steigt, wenn sich der Track geändert hat,
   * auch wenn die `track`-Identität gleich bleibt (z. B. In-Place-Mutation des
   * AudioBuffer nach einem Edit). Ohne diesen Wert bliebe die Basis-Ebene stehen.
   */
  trackRevision?: number;
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
  onImportTracksClick?: () => void;
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
  getPositionSec,
  currentTime,
  trackRevision,
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
  onImportTracksClick,
  onLoadAudioClick,
  onDropFile,
  onDropPaletteClip,
  onAnalyzeParts,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Zweite Ebene über der Basis: Auswahl, Hover-Führung, Playhead. */
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  /*
   * Interaktionszustand, der nur die Zeichnung betrifft, liegt in Refs: ein
   * `setState` pro Mausbewegung würde die Komponente (und über die Props auch
   * die App) neu rendern, obwohl sich sichtbar nur eine Linie bewegt.
   */
  const isSelectingRef = useRef(false);
  const dragStartSecRef = useRef<number | null>(null);
  const hoveredTimeRef = useRef<number | null>(null);
  /**
   * Auswahl-Änderungen werden auf einen Frame gedrosselt: Ein Ziehen erzeugt
   * sonst pro Mausereignis ein `onSelect` (React-Update von `App`). Der
   * Ref-Spiegel hält dabei immer den aktuellen Track bzw. Callback.
   */
  const currentTrackRef = useRef(track);
  currentTrackRef.current = track;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const pendingSelectionRef = useRef<SelectionRange | null>(null);
  const selectionUpdateFrameRef = useRef<number | null>(null);

  /** Logische Canvas-Größe in CSS-Pixeln (die Backing-Store-Größe ist DPR-skaliert). */
  const logicalSizeRef = useRef({ width: 0, height: 0 });
  const schedulerRef = useRef(createLayerScheduler());
  const frameRef = useRef(0);
  const renderFrameRef = useRef<() => void>(() => {});
  /** Plant genau einen Frame ein – weitere Aufrufe im selben Frame sind No-Ops. */
  const scheduleFrameRef = useRef<() => void>(() => {});

  /** Live-Position: Store-Zugriff, sonst der zuletzt gerenderte Prop-Wert. */
  const readPosition = useCallback(
    () => (getPositionSec ? getPositionSec() : currentTime ?? 0),
    [getPositionSec, currentTime]
  );

  // Canvas-Größe folgt dem Container – inklusive devicePixelRatio.
  // Vorher wurde `canvas.width = cssBreite` gesetzt; auf HiDPI-Displays war die
  // Wellenform dadurch unscharf und 1-px-Rekordbox-Linien wurden zu 2-px-Bändern.
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const updateCanvasSize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      if (width <= 10 || height <= 10) return;

      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const backingWidth = Math.round(width * dpr);
      const backingHeight = Math.round(height * dpr);
      const changed = logicalSizeRef.current.width !== width || logicalSizeRef.current.height !== height;

      for (const canvas of [canvasRef.current, overlayCanvasRef.current]) {
        if (!canvas) continue;
        if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
          canvas.width = backingWidth;
          canvas.height = backingHeight;
          // Zeichnen in CSS-Pixeln, damit die Pfadangaben unverändert bleiben.
          canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
      }

      logicalSizeRef.current = { width, height };
      if (changed) {
        schedulerRef.current.markBase();
        scheduleFrameRef.current();
      }
    };

    updateCanvasSize();
    const ro = new ResizeObserver(updateCanvasSize);
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

  // ---------------------------------------------------------------------------
  // Zeichnung: zwei Ebenen, ein Frame-Budget.
  //
  //   Basis   – Hintergrund, Beatgrid, Wellenform-Spalten, Parts, Cues, Loops.
  //             Teuer (~2,4–4,0 ms pro Bild, siehe `npm run bench`) und nur bei
  //             Änderung von Track/Ansicht/Zoom fällig.
  //   Overlay – Auswahl, Hover-Führung, Playhead. Günstig und pro Bewegung fällig.
  //
  // Die Zeichenfunktionen werden bei jedem Render neu gebildet und über Refs
  // aufgerufen. So sieht der Frame-Callback immer die aktuellen Props, ohne
  // dass ein Effekt neu registriert werden muss.
  // ---------------------------------------------------------------------------
  const basePaintRef = useRef<(ctx: CanvasRenderingContext2D, width: number, height: number) => void>(() => {});
  const overlayPaintRef = useRef<(ctx: CanvasRenderingContext2D, width: number, height: number) => void>(() => {});

  basePaintRef.current = (ctx, width, height) => {
    ctx.clearRect(0, 0, width, height);

      // 1. Dark background (Rekordbox EDIT #191919 on odd bars 1,3,5..., #000000 on even bars 2,4,6... and pre-track)
      const rulerBottom = 18;
      const hasPhraseLane = Boolean(track?.phrases && track.phrases.length > 0);
      const waveBottom = hasPhraseLane ? Math.max(rulerBottom + 20, height - PHRASE_LANE_HEIGHT) : height;
      const waveLaneHeight = Math.max(20, waveBottom - rulerBottom);
      const centerY = rulerBottom + waveLaneHeight / 2;
      const maxHalfHeight = waveLaneHeight * 0.44;

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);

      if (track) {
        const bg = track.beatGrid;
        const spb = 60.0 / bg.bpm;
        const barDuration = spb * bg.meter;
        const firstBarIdx = Math.max(0, Math.floor((viewOffset - bg.firstBeat) / barDuration));
        const lastBarIdx = Math.ceil((viewOffset + viewDuration - bg.firstBeat) / barDuration);
        for (let barIdx = firstBarIdx; barIdx <= lastBarIdx; barIdx++) {
          // Odd bar numbers (Bar 1, 3, 5 -> barIdx 0, 2, 4) have #191919 background in Rekordbox EDIT
          if (barIdx % 2 !== 0) continue;
          const bStart = Math.max(0, bg.firstBeat + barIdx * barDuration);
          const bEnd = Math.min(track.duration, bg.firstBeat + (barIdx + 1) * barDuration);
          if (bEnd <= bStart) continue;
          const x0 = Math.max(0, Math.min(width, timeToPixel(bStart, width)));
          const x1 = Math.max(0, Math.min(width, timeToPixel(bEnd, width)));
          if (x1 > x0) {
            ctx.fillStyle = '#191919';
            ctx.fillRect(x0, rulerBottom, x1 - x0, waveLaneHeight);
          }
        }
      }

      // Subtle horizontal amplitude bounds + Rekordbox centerline (#f2f2f2 pre-track, #00A2E8 inside track)
      ctx.strokeStyle = '#707070';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, waveBottom - 0.5);
      ctx.lineTo(width, waveBottom - 0.5);
      ctx.stroke();

      if (track) {
        const firstBeatX = Math.max(0, Math.min(width, timeToPixel(track.beatGrid.firstBeat, width)));
        if (firstBeatX > 0) {
          ctx.fillStyle = '#f2f2f2';
          ctx.fillRect(0, Math.round(centerY), firstBeatX, 1);
        }
        ctx.fillStyle = REKORDBOX_BASELINE_HEX;
        ctx.fillRect(firstBeatX, Math.round(centerY), Math.max(0, width - firstBeatX), 1);
      } else {
        ctx.fillStyle = REKORDBOX_BASELINE_HEX;
        ctx.fillRect(0, Math.round(centerY), width, 1);
      }

      ctx.fillStyle = '#323232';
      ctx.fillRect(0, 0, width, rulerBottom); // top bar number strip (Rekordbox #323232)
      ctx.strokeStyle = '#707070';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 0.5);
      ctx.lineTo(width, 0.5);
      ctx.moveTo(0, rulerBottom);
      ctx.lineTo(width, rulerBottom);
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

      // 2. Beatgrid lines & Bar Numbers (Top header strip, matching rekordbox_edit.png)
      const bg = track.beatGrid;
      const secondsPerBeat = 60.0 / bg.bpm;
      const barPx = (secondsPerBeat * bg.meter / viewDuration) * width;
      const startBeat = Math.max(0, Math.floor((viewOffset - bg.firstBeat) / secondsPerBeat));
      const endBeat = Math.ceil((viewOffset + viewDuration - bg.firstBeat) / secondsPerBeat);

      for (let b = startBeat; b <= endBeat; b++) {
        const beatTime = bg.firstBeat + b * secondsPerBeat;
        const x = Math.round(timeToPixel(beatTime, width));
        if (x < -20 || x > width + 20) continue;

        const isBar = b % bg.meter === 0;
        const barIdx = Math.floor(b / bg.meter);
        const barNumber = barIdx + 1;
        const isMajorPhraseBar = (barNumber - 1) % 4 === 0;

        if (isBar) {
          // Major 4-bar phrase lines (1, 5, 9, 13...) are crisp white (#fefefe);
          // intermediate bar lines (2, 3, 4...) are medium grey (#6f6f6f).
          ctx.strokeStyle = isMajorPhraseBar ? '#fefefe' : '#6f6f6f';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 0.5, 0);
          ctx.lineTo(x + 0.5, waveBottom);
          ctx.stroke();

          if (isMajorPhraseBar || barPx >= 240) {
            ctx.fillStyle = '#ffffff';
            ctx.font = '11px sans-serif';
            ctx.fillText(`${barNumber}`, x + 4, 12);
          }

          // Iconic orange 'E' Edit-Start badge on Bar 1 (rekordbox_edit.png x=243, y=211)
          if (barNumber === 1) {
            ctx.fillStyle = '#ff8c00';
            ctx.fillRect(x - 3, rulerBottom - 9, 7, 8);
            ctx.fillStyle = '#191919';
            ctx.font = 'bold 7px sans-serif';
            ctx.fillText('E', x - 2, rulerBottom - 2);
          }
        } else {
          // Sub-beat lines (beats 2, 3, 4): #000000 in top ruler and odd (#191919) bars,
          // #242424 in even (#000000) bars — drawn behind the waveform.
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 0.5, 0);
          ctx.lineTo(x + 0.5, rulerBottom);
          ctx.stroke();

          ctx.strokeStyle = barIdx % 2 === 0 ? '#000000' : '#242424';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 0.5, rulerBottom);
          ctx.lineTo(x + 0.5, waveBottom);
          ctx.stroke();
        }
      }

      // 3. Render the source waveform as 1-px vertical Rekordbox EDIT-mode columns.
      // Never use edit-operation bars or a synthetic beat pattern here: inserted,
      // replaced and overdubbed audio must be rendered by the same renderer as
      // the untouched source so the waveform has one consistent visual language.
      const analysis = track.analysis;
      if (analysis && analysis.length > 0) {
        const duration = Math.max(0.01, track.duration);

        for (let x = 0; x < width; x++) {
          const t0 = viewOffset + (x / width) * viewDuration;
          const t1 = viewOffset + ((x + 1) / width) * viewDuration;
          const sample = sampleWaveformColumn(
            analysis,
            t0,
            t1,
            duration,
            track.beatGrid
          );
          renderRekordboxWaveformColumn(
            ctx,
            x,
            centerY,
            maxHalfHeight,
            sample,
            waveformMode
          );
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

      // 3b. Beatgrid bar overlay lines (keep 4-bar major downbeats crisp white and
      // intermediate bars subtle grey; sub-beats stay behind the waveform like rekordbox_edit.png)
      for (let b = startBeat; b <= endBeat; b++) {
        const isBar = b % bg.meter === 0;
        if (!isBar) continue;
        const beatTime = bg.firstBeat + b * secondsPerBeat;
        const x = Math.round(timeToPixel(beatTime, width));
        if (x < -10 || x > width + 10) continue;
        const barNumber = Math.floor(b / bg.meter) + 1;
        const isMajorPhraseBar = (barNumber - 1) % 4 === 0;

        ctx.strokeStyle = isMajorPhraseBar ? 'rgba(254, 254, 254, 0.85)' : 'rgba(111, 111, 111, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, rulerBottom);
        ctx.lineTo(x + 0.5, waveBottom);
        ctx.stroke();
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

  overlayPaintRef.current = (ctx, width, height) => {
    ctx.clearRect(0, 0, width, height);

      // 6. Auswahlrahmen (Screenshots 01, 02, 03) inklusive Kennzahlen-Box.
      //    Die Zeichnung liegt in `waveform/canvasLayers.ts`, damit die
      //    Detail-Wellenform und die Tests dieselbe Implementierung nutzen.
      drawSelectionOverlay(ctx, selection, viewOffset, viewDuration, width, height);

      // 7. Hover-Führung auf der Rasterlinie (Beat/Takt) samt Badge.
      drawSnapGuide(
        ctx,
        hoveredTimeRef.current,
        track?.beatGrid ?? null,
        snapTime,
        viewOffset,
        viewDuration,
        width,
        height
      );

      // 8. Playhead (weiße Haarlinie + Dreieck oben). Die Zeichnung liegt in
      //    `waveform/canvasLayers.ts` und wird hier ohne Leeren aufgerufen –
      //    das Overlay wurde am Anfang dieses Frames bereits geleert.
      drawPlayhead(ctx, readPosition(), viewOffset, viewDuration, width, height, { clear: false });

  };

  renderFrameRef.current = () => {
    frameRef.current = 0;
    const { width, height } = logicalSizeRef.current;
    if (width <= 10 || height <= 10) return;

    const plan = schedulerRef.current.take();
    if (!plan.base && !plan.overlay) return;

    if (plan.base) {
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx) basePaintRef.current(ctx, width, height);
    }
    if (plan.overlay) {
      const ctx = overlayCanvasRef.current?.getContext('2d');
      if (ctx) overlayPaintRef.current(ctx, width, height);
    }
  };

  scheduleFrameRef.current = () => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => renderFrameRef.current());
  };

  /** Overlay-only-Repaint – für Playhead, Auswahl und Hover. */
  const requestOverlayPaint = useCallback(() => {
    schedulerRef.current.markOverlay();
    scheduleFrameRef.current();
  }, []);

  // Neue Basis: Track, Fenster, Zoom, Modus, Snap-Raster – und `trackRevision`,
  // weil ein Edit den AudioBuffer an Ort und Stelle verändert, ohne dass sich
  // die Track-Identität ändert.
  useEffect(() => {
    schedulerRef.current.markBase();
    scheduleFrameRef.current();
  }, [track, trackRevision, viewOffset, viewDuration, waveformMode, snapTime, timeToPixel]);

  // Nur Overlay: Auswahl und Quantisierung.
  useEffect(() => {
    requestOverlayPaint();
  }, [selection, quantize, requestOverlayPaint]);

  // Playhead: der Treiber schreibt die Position in den Store; hier wird nur
  // neu gezeichnet – ohne React-Render und ohne Dauer-rAF im Leerlauf.
  useEffect(() => {
    const unsubscribe = subscribeTransport(requestOverlayPaint);
    return () => {
      unsubscribe();
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
    };
  }, [requestOverlayPaint]);

  /*
   * Beim Trackwechsel (und beim Abbau) werden Zeiger- und Auswahl-Zustand
   * verworfen: Die Bezugszeiten eines alten Tracks dürfen nicht in den neuen
   * übernommen werden, und geplante Frames wären für den falschen Track.
   */
  useEffect(
    () => () => {
      isSelectingRef.current = false;
      dragStartSecRef.current = null;
      hoveredTimeRef.current = null;
      pendingSelectionRef.current = null;
      if (selectionUpdateFrameRef.current !== null) {
        cancelAnimationFrame(selectionUpdateFrameRef.current);
        selectionUpdateFrameRef.current = null;
      }
    },
    [track?.id]
  );

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
      scheduleSelectionRange(newStart, newEnd);
    } else {
      isSelectingRef.current = true;
      dragStartSecRef.current = clickedTime;
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

    // Hover-Führung nur zeichnen, nicht rendern.
    hoveredTimeRef.current = rawTime;
    requestOverlayPaint();

    if (!isSelectingRef.current || dragStartSecRef.current === null) return;
    const currTime = snapTime(rawTime);

    const start = Math.min(dragStartSecRef.current, currTime);
    const end = Math.max(dragStartSecRef.current, currTime);

    if (end - start > 0.05) {
      scheduleSelectionRange(start, end);
    }
  };

  const handleMouseLeave = () => {
    flushSelectionUpdate();
    hoveredTimeRef.current = null;
    requestOverlayPaint();
    isSelectingRef.current = false;
    dragStartSecRef.current = null;
  };

  const handleMouseUp = () => {
    flushSelectionUpdate();
    isSelectingRef.current = false;
    dragStartSecRef.current = null;
  };

  const buildSelectionRange = (start: number, end: number): SelectionRange | null => {
    const activeTrack = currentTrackRef.current;
    if (!activeTrack) return null;
    const bg = activeTrack.beatGrid;
    const spb = 60.0 / bg.bpm;
    const startBeat = Math.max(0, (start - bg.firstBeat) / spb);
    const endBeat = Math.max(0, (end - bg.firstBeat) / spb);
    const beatsCount = Math.max(0, endBeat - startBeat);
    return {
      start,
      end,
      startBeat,
      endBeat,
      beatsCount,
      barsCount: beatsCount / bg.meter,
      duration: end - start,
    };
  };

  const flushSelectionUpdate = () => {
    if (selectionUpdateFrameRef.current !== null) {
      cancelAnimationFrame(selectionUpdateFrameRef.current);
      selectionUpdateFrameRef.current = null;
    }
    const pendingSelection = pendingSelectionRef.current;
    pendingSelectionRef.current = null;
    if (pendingSelection) onSelectRef.current(pendingSelection);
  };

  const scheduleSelectionRange = (start: number, end: number) => {
    const nextSelection = buildSelectionRange(start, end);
    if (!nextSelection) return;
    pendingSelectionRef.current = nextSelection;
    if (selectionUpdateFrameRef.current !== null) return;
    selectionUpdateFrameRef.current = requestAnimationFrame(() => {
      selectionUpdateFrameRef.current = null;
      const pendingSelection = pendingSelectionRef.current;
      pendingSelectionRef.current = null;
      if (pendingSelection) onSelectRef.current(pendingSelection);
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
        {/*
          Zwei Ebenen: die untere trägt die teure Basis (Wellenform, Grid,
          Parts, Cues), die obere nur Auswahl, Hover-Führung und Playhead.
          Mausereignisse liegen auf der unteren Ebene; die obere ist
          `pointer-events-none` und rein visuell.
        */}
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onContextMenu={handleContextMenu}
          className={`absolute inset-0 w-full h-full block ${track ? 'cursor-crosshair' : 'cursor-default'}`}
        />
        <canvas
          ref={overlayCanvasRef}
          aria-hidden="true"
          className="absolute inset-0 w-full h-full block pointer-events-none"
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
                Wähle einen Track aus der eingebetteten Rekordbox-Sammlung oder öffne eine eigenständige Audiodatei.
              </p>

              <div className="flex flex-wrap gap-2 justify-center mb-4">
                {onImportTracksClick && (
                  <button
                    onClick={onImportTracksClick}
                    className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#0088ff] hover:bg-[#0077ee] text-white rounded text-xs font-semibold shadow transition-colors"
                  >
                    <Disc size={13} />
                    <span>Track-Import</span>
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
