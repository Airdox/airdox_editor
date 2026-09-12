/**
 * @license
 * Rekordbox ClipDeckView Component
 * Full secondary Deck view ("Deck B • Clip Palette") matching Pioneer Rekordbox architecture:
 * - Complete Deck header (Title, Artist, Source Track, BPM, Key, Duration, Time display)
 * - Interactive Detail Waveform (Canvas RGB / 3-Band / Blue with Beatgrid, Playhead, Zoom, Selection)
 * - Transport controls (Play/Pause, Return to Cue, Loop 1/2/4/8, Volume)
 * - Automatic Tempo & Harmonic Pitch Adaptation with toggleable Key Sync checkbox
 * - Direct Deck A Transfer Actions (Insert @ Playhead, Replace Selection, Overdub)
 * - Clip Carousel & Library browser
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  PaletteClip,
  TrackModel,
  WaveformMode,
  SelectionRange,
} from '../types/rekordbox';
import {
  Play,
  Square,
  Repeat,
  Layers,
  ArrowRightLeft,
  Plus,
  Trash2,
  Minimize2,
  Maximize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Music,
  CheckSquare,
  Square as SquareOutline,
  Disc3,
  Sliders,
} from 'lucide-react';
import { audioEngine } from '../audio/audioEngine';
import { beginDrag, endDrag, resolveDragPayload } from '../dnd/dragPayload';
import { calculateHarmonicPitchShift } from '../audio/pitchTempoEngine';

interface ClipDeckViewProps {
  clips: PaletteClip[];
  activeClipId: string | null;
  onSelectClip: (clip: PaletteClip) => void;
  onDeleteClip: (clipId: string) => void;
  onAddFromSelection: () => void;
  hasSelectionInDeckA: boolean;
  activeTrack: TrackModel | null;
  matchPitch: boolean;
  onToggleMatchPitch: (match: boolean) => void;
  onInsertClipToDeckA: (clip: PaletteClip) => void;
  onReplaceDeckAWithClip: (clip: PaletteClip) => void;
  onOverdubDeckAWithClip: (clip: PaletteClip) => void;
  onCloseDeckView: () => void;
  waveformMode: WaveformMode;
  /** Drag & drop: a clip card dropped on the preview inserts it into Deck A. */
  onDropClipIntoDeckA?: (clipId: string) => void;
}

export const ClipDeckView: React.FC<ClipDeckViewProps> = ({
  clips,
  activeClipId,
  onSelectClip,
  onDeleteClip,
  onAddFromSelection,
  hasSelectionInDeckA,
  activeTrack,
  matchPitch,
  onToggleMatchPitch,
  onInsertClipToDeckA,
  onReplaceDeckAWithClip,
  onOverdubDeckAWithClip,
  onCloseDeckView,
  waveformMode,
  onDropClipIntoDeckA,
}) => {
  const activeClip = clips.find((c) => c.id === activeClipId) || clips[0] || null;

  // Drag & drop: a clip being dragged inside this view, plus the hovered target.
  const [dragClipId, setDragClipId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<'deck' | 'insert' | 'replace' | 'overdub' | null>(null);
  const clipDragProps = (clip: PaletteClip) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setDragClipId(clip.id);
      e.dataTransfer.effectAllowed = 'copyLink';
      beginDrag(e.dataTransfer, { kind: 'clip', clipId: clip.id, label: clip.name });
    },
    onDragEnd: () => {
      endDrag();
      setDragClipId(null);
      setDropTarget(null);
    },
  });
  const targetHandlers = (
    target: 'deck' | 'insert' | 'replace' | 'overdub',
    run: (clipId: string) => void
  ) => ({
    onDragOver: (e: React.DragEvent) => {
      if (resolveDragPayload(e.dataTransfer)?.kind !== 'clip') return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      if (dropTarget !== target) setDropTarget(target);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setDropTarget((prev) => (prev === target ? null : prev));
    },
    onDrop: (e: React.DragEvent) => {
      const payload = resolveDragPayload(e.dataTransfer);
      if (payload?.kind !== 'clip') return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      setDragClipId(null);
      run(payload.clipId);
    },
  });
  const clipById = (id: string) => clips.find((c) => c.id === id) ?? null;

  // Deck playback & navigation state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [loopActive, setLoopActive] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1.0); // 1.0 = fit whole clip
  const [volume, setVolume] = useState(0.85);

  // Sub-selection inside clip
  const [clipSelection, setClipSelection] = useState<{ start: number; end: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Stop playback if clip switches
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    audioEngine.stop();
  }, [activeClip?.id]);

  // Real-time animation loop for playhead
  useEffect(() => {
    let animId: number;
    const update = () => {
      if (isPlaying && activeClip && activeClip.audioBuffer) {
        const time = audioEngine.getCurrentTime();
        if (time >= activeClip.duration) {
          if (loopActive) {
            audioEngine.play(activeClip.audioBuffer, 0, true, 0, activeClip.duration);
            setCurrentTime(0);
          } else {
            setIsPlaying(false);
            setCurrentTime(0);
            audioEngine.stop();
          }
        } else {
          setCurrentTime(time);
        }
      }
      animId = requestAnimationFrame(update);
    };
    animId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, activeClip, loopActive]);

  // Transport handlers
  const handleTogglePlay = () => {
    if (!activeClip || !activeClip.audioBuffer) return;
    if (isPlaying) {
      audioEngine.stop();
      setIsPlaying(false);
    } else {
      audioEngine.play(
        activeClip.audioBuffer,
        currentTime < activeClip.duration ? currentTime : 0,
        loopActive,
        0,
        activeClip.duration
      );
      setIsPlaying(true);
    }
  };

  const handleReturnToCue = () => {
    audioEngine.stop();
    setIsPlaying(false);
    setCurrentTime(0);
  };

  // Harmonic adaptation preview
  const harmonicPreview = activeClip && activeTrack
    ? calculateHarmonicPitchShift(activeClip.key, activeTrack.key)
    : { semitones: 0, harmonicRelation: 'Keine Tonartdaten' };

  const tempoRatio = activeClip && activeTrack && activeClip.bpm > 0
    ? activeTrack.bpm / activeClip.bpm
    : 1.0;
  const bpmDiff = activeClip && activeTrack
    ? (activeTrack.bpm - activeClip.bpm).toFixed(1)
    : '0.0';

  // Draw interactive Waveform Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Background
    ctx.fillStyle = '#0a0b0e';
    ctx.fillRect(0, 0, width, height);

    if (!activeClip || !activeClip.audioBuffer) {
      ctx.fillStyle = '#4a4d5a';
      ctx.font = '12px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Wähle einen Clip aus der Palette oder erstelle einen neuen', width / 2, height / 2);
      return;
    }

    const duration = activeClip.duration;
    const buffer = activeClip.audioBuffer;
    const chData = buffer.getChannelData(0);

    const visibleDuration = duration / zoomLevel;
    const visibleStart = Math.max(0, Math.min(currentTime - visibleDuration * 0.4, duration - visibleDuration));

    const timeToX = (t: number) => ((t - visibleStart) / visibleDuration) * width;
    const xToTime = (x: number) => visibleStart + (x / width) * visibleDuration;

    // 1. Draw Beatgrid Lines
    const bpm = activeClip.bpm || 120.0;
    const spb = 60.0 / bpm;
    const numBeats = Math.floor(duration / spb);

    ctx.lineWidth = 1;
    for (let b = 0; b <= numBeats; b++) {
      const beatTime = b * spb;
      const x = timeToX(beatTime);
      if (x >= 0 && x <= width) {
        const isBar = b % 4 === 0;
        ctx.strokeStyle = isBar ? '#444958' : '#22252e';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();

        if (isBar) {
          ctx.fillStyle = '#7a8092';
          ctx.font = '10px JetBrains Mono, monospace';
          ctx.textAlign = 'left';
          ctx.fillText(`Bar ${b / 4 + 1}`, x + 3, 12);
        }
      }
    }

    // 2. Draw Waveform Peaks
    const midY = height / 2;
    const samplesPerPixel = Math.max(1, Math.floor((visibleDuration * buffer.sampleRate) / width));

    ctx.lineWidth = 1.5;
    for (let px = 0; px < width; px++) {
      const t = xToTime(px);
      const startSample = Math.floor(t * buffer.sampleRate);
      if (startSample < 0 || startSample >= chData.length) continue;

      let min = 0;
      let max = 0;
      for (let s = 0; s < samplesPerPixel && startSample + s < chData.length; s += 2) {
        const val = chData[startSample + s];
        if (val < min) min = val;
        if (val > max) max = val;
      }

      const amp = Math.max(Math.abs(min), Math.abs(max));
      const barH = amp * (height * 0.44);

      // Color scheme based on waveformMode
      if (waveformMode === 'RGB') {
        // High frequencies cyan, low frequencies red/orange
        ctx.strokeStyle = px % 2 === 0 ? '#00e5ff' : '#ff3b30';
      } else if (waveformMode === '3BAND') {
        ctx.strokeStyle = '#0088ff';
      } else {
        ctx.strokeStyle = '#2979ff';
      }

      ctx.beginPath();
      ctx.moveTo(px, midY - barH);
      ctx.lineTo(px, midY + barH);
      ctx.stroke();
    }

    // 3. Draw Sub-Selection
    if (clipSelection && clipSelection.end > clipSelection.start) {
      const selX1 = timeToX(clipSelection.start);
      const selX2 = timeToX(clipSelection.end);
      ctx.fillStyle = 'rgba(0, 136, 255, 0.22)';
      ctx.fillRect(selX1, 0, selX2 - selX1, height);
      ctx.strokeStyle = '#00a2ff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(selX1, 0, selX2 - selX1, height);
    }

    // 4. Draw Playhead (White vertical line + Red top triangle)
    const playheadX = timeToX(currentTime);
    if (playheadX >= 0 && playheadX <= width) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();

      // Top indicator
      ctx.fillStyle = '#ff3b30';
      ctx.beginPath();
      ctx.moveTo(playheadX - 6, 0);
      ctx.lineTo(playheadX + 6, 0);
      ctx.lineTo(playheadX, 9);
      ctx.closePath();
      ctx.fill();
    }
  }, [activeClip, currentTime, zoomLevel, waveformMode, clipSelection]);

  // Canvas click / drag to seek or select
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!activeClip || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;

    const visibleDuration = activeClip.duration / zoomLevel;
    const visibleStart = Math.max(0, Math.min(currentTime - visibleDuration * 0.4, activeClip.duration - visibleDuration));
    const clickTime = Math.max(0, Math.min(activeClip.duration, visibleStart + (x / width) * visibleDuration));

    if (e.shiftKey) {
      // Begin sub-selection
      setIsSelecting(true);
      setClipSelection({ start: clickTime, end: clickTime });
    } else {
      // Seek
      setCurrentTime(clickTime);
      if (isPlaying && activeClip.audioBuffer) {
        audioEngine.play(activeClip.audioBuffer, clickTime, loopActive, 0, activeClip.duration);
      }
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isSelecting || !clipSelection || !activeClip || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;

    const visibleDuration = activeClip.duration / zoomLevel;
    const visibleStart = Math.max(0, Math.min(currentTime - visibleDuration * 0.4, activeClip.duration - visibleDuration));
    const curTime = Math.max(0, Math.min(activeClip.duration, visibleStart + (x / width) * visibleDuration));

    setClipSelection({
      start: Math.min(clipSelection.start, curTime),
      end: Math.max(clipSelection.start, curTime),
    });
  };

  const handleCanvasMouseUp = () => {
    setIsSelecting(false);
  };

  return (
    <div className="flex-1 flex flex-col bg-[#0b0c0f] border-t border-[#1c1e26] select-none z-30 overflow-hidden">
      {/* 1. Deck B Header: Chamfer Tab, Clip Meta, Pitch/Tempo Sync & Controls */}
      <div className="h-11 bg-[#101217] border-b border-[#1f212a] flex items-center justify-between px-3">
        <div className="flex items-center space-x-3">
          {/* Deck Chamfer Badge */}
          <div className="rb-tab-chamfer bg-[#0088ff] text-black font-extrabold text-[11px] px-3.5 py-1 tracking-wider uppercase flex items-center space-x-1.5 shadow-sm">
            <Disc3 size={13} className="animate-spin-slow" />
            <span>DECK B • CLIP PALETTE</span>
          </div>

          {/* Active Clip Title & Artist */}
          {activeClip ? (
            <div className="flex items-center space-x-2">
              <span className="text-white text-xs font-bold truncate max-w-[220px]">
                {activeClip.name}
              </span>
              <span className="text-[11px] text-neutral-400 font-mono">
                aus "{activeClip.sourceTrackName}"
              </span>
            </div>
          ) : (
            <span className="text-neutral-500 text-xs italic">Kein Clip ausgewählt</span>
          )}
        </div>

        {/* Right Header: Master Alignment Indicators & View Mode Toggle */}
        <div className="flex items-center space-x-3 text-xs">
          {/* Deck A comparison badges */}
          {activeClip && activeTrack && (
            <div className="flex items-center space-x-2 bg-[#171922] px-2.5 py-1 rounded border border-[#262835] text-[11px]">
              <span className="text-neutral-400">Ziel:</span>
              <span className="font-mono text-[#00e5ff] font-bold">
                {activeTrack.bpm.toFixed(1)} BPM
              </span>
              <span className="text-neutral-600">|</span>
              <span className="font-mono text-[#ffaa00] font-bold">
                {activeTrack.key}
              </span>
            </div>
          )}

          {/* Switch back to Sidebar button */}
          <button
            onClick={onCloseDeckView}
            className="flex items-center space-x-1 bg-[#1a1c24] hover:bg-[#252834] text-neutral-300 hover:text-white px-2.5 py-1 rounded border border-[#2d303d] text-[11px] font-medium transition-colors"
            title="Zurück zur Palette-Seitenleiste"
          >
            <Minimize2 size={12} />
            <span>Sidebar</span>
          </button>
        </div>
      </div>

      {/* 2. Tempo & Pitch Adaptation Alignment Toolbar (The Primary User Feature) */}
      <div className="h-9 bg-[#13151c] border-b border-[#1e2029] flex items-center justify-between px-3 text-xs">
        <div className="flex items-center space-x-4">
          {/* Automatic Tempo Sync Notification */}
          <div className="flex items-center space-x-1.5 text-[11px]">
            <span className="w-2 h-2 rounded-full bg-[#00c853] animate-pulse" />
            <span className="text-neutral-300 font-medium">BPM Tempo-Sync:</span>
            <span className="font-mono text-[#00c853] font-bold">
              {activeClip ? `${activeClip.bpm.toFixed(1)} ➔ ${activeTrack?.bpm.toFixed(1) || 120} BPM` : '---'}
            </span>
            <span className="text-[10px] text-neutral-500 font-mono">
              ({tempoRatio.toFixed(3)}× {Number(bpmDiff) > 0 ? `+${bpmDiff}` : bpmDiff} BPM)
            </span>
          </div>

          <div className="h-4 w-[1px] bg-[#292c3a]" />

          {/* Interactive Checkbox for Pitch Adjustment (Tonhöhenanpassung) */}
          <label className="flex items-center space-x-2 cursor-pointer group select-none">
            <input
              type="checkbox"
              checked={matchPitch}
              onChange={(e) => onToggleMatchPitch(e.target.checked)}
              className="sr-only"
            />
            <div
              className={`w-4 h-4 rounded-xs border flex items-center justify-center transition-all ${
                matchPitch
                  ? 'bg-[#0088ff] border-[#0088ff] text-white shadow-[0_0_8px_rgba(0,136,255,0.4)]'
                  : 'bg-[#181a22] border-[#363a49] group-hover:border-[#53586e]'
              }`}
            >
              {matchPitch ? <CheckSquare size={12} strokeWidth={2.5} /> : null}
            </div>
            <span className={`text-[11px] font-semibold transition-colors ${
              matchPitch ? 'text-white' : 'text-neutral-400 group-hover:text-neutral-200'
            }`}>
              Tonhöhe an Ziel-Track anpassen (Key Sync)
            </span>
          </label>

          {/* Harmonic status readout */}
          {activeClip && activeTrack && (
            <div className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#1c1f2b] border border-[#2b2f40] text-neutral-300 flex items-center space-x-1">
              <Music size={10} className="text-[#ff9500]" />
              <span>
                {matchPitch
                  ? harmonicPreview.harmonicRelation
                  : `Originaltonart beibehalten (${activeClip.key})`}
              </span>
            </div>
          )}
        </div>

        {/* Transfer Action Buttons into Deck A */}
        <div className="flex items-center space-x-1.5">
          {/* Insert @ Playhead */}
          <button
            onClick={() => activeClip && onInsertClipToDeckA(activeClip)}
            disabled={!activeClip || !activeTrack}
            {...targetHandlers('insert', (id) => {
              const clip = clipById(id);
              if (clip) onInsertClipToDeckA(clip);
            })}
            className={`flex items-center space-x-1 text-white disabled:opacity-30 px-2.5 py-1 rounded text-[11px] font-bold shadow-sm transition-all ${
              dropTarget === 'insert'
                ? 'bg-[#4db2ff] ring-2 ring-white'
                : 'bg-[#0088ff] hover:bg-[#0099ff]'
            }`}
            title="Clip mit Tempo- & Tonhöhenanpassung an Playhead einfügen – Clip auch hierher ziehen"
          >
            <ArrowRightLeft size={12} />
            <span>In Deck A einfügen</span>
          </button>

          {/* Replace Selection */}
          <button
            onClick={() => activeClip && onReplaceDeckAWithClip(activeClip)}
            disabled={!activeClip || !activeTrack || !hasSelectionInDeckA}
            {...targetHandlers('replace', (id) => {
              const clip = clipById(id);
              if (clip) onReplaceDeckAWithClip(clip);
            })}
            className={`flex items-center space-x-1 text-black disabled:opacity-30 px-2.5 py-1 rounded text-[11px] font-bold shadow-sm transition-all ${
              dropTarget === 'replace' ? 'bg-[#ffc061] ring-2 ring-white' : 'bg-[#ff9500] hover:bg-[#ffaa22]'
            }`}
            title={hasSelectionInDeckA ? "Auswahl in Deck A durch diesen Clip ersetzen – Clip auch hierher ziehen" : "Zuerst Bereich in Deck A auswählen"}
          >
            <Repeat size={12} />
            <span>Auswahl ersetzen</span>
          </button>

          {/* Overdub Selection */}
          <button
            onClick={() => activeClip && onOverdubDeckAWithClip(activeClip)}
            disabled={!activeClip || !activeTrack || !hasSelectionInDeckA}
            {...targetHandlers('overdub', (id) => {
              const clip = clipById(id);
              if (clip) onOverdubDeckAWithClip(clip);
            })}
            className={`flex items-center space-x-1 disabled:opacity-30 px-2 py-1 rounded text-[11px] font-bold transition-all border ${
              dropTarget === 'overdub'
                ? 'bg-[#00c853] border-[#00c853] text-black ring-2 ring-white'
                : 'bg-[#1b2230] hover:bg-[#252f44] border-[#36425a] text-[#00c853] hover:text-white'
            }`}
            title="Clip über Deck A Auswahl mischen – Clip auch hierher ziehen"
          >
            <Layers size={12} />
            <span>Überlagern</span>
          </button>
        </div>
      </div>

      {/* 3. Main Deck Body: Left Transport / Waveform Canvas / Right Controls */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Transport Column */}
        <div className="w-24 bg-[#0e1014] border-r border-[#1c1e26] flex flex-col items-center justify-between p-2">
          {/* Play / Pause & Return to Cue */}
          <div className="w-full space-y-2">
            <button
              onClick={handleTogglePlay}
              disabled={!activeClip}
              className={`w-full h-11 flex flex-col items-center justify-center rounded transition-all ${
                isPlaying
                  ? 'bg-[#00c853] text-black shadow-[0_0_12px_rgba(0,200,83,0.5)]'
                  : 'bg-[#181a22] hover:bg-[#222530] text-white border border-[#2b2e3c]'
              }`}
              title="Clip abspielen / anhalten"
            >
              {isPlaying ? <Square size={13} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
              <span className="text-[9px] font-bold mt-0.5">{isPlaying ? 'STOP' : 'PLAY'}</span>
            </button>

            <button
              onClick={handleReturnToCue}
              disabled={!activeClip}
              className="w-full h-7 bg-[#14161d] hover:bg-[#1f212c] text-neutral-300 hover:text-white border border-[#262936] rounded text-[10px] font-mono flex items-center justify-center space-x-1 transition-colors"
              title="Return to Start"
            >
              <span>|&lt; CUE</span>
            </button>

            {/* Loop Toggle */}
            <button
              onClick={() => setLoopActive(!loopActive)}
              className={`w-full h-6 rounded text-[9.5px] font-bold border transition-all flex items-center justify-center space-x-1 ${
                loopActive
                  ? 'bg-[#ff9500] text-black border-[#ff9500]'
                  : 'bg-[#14161d] text-neutral-400 border-[#262936] hover:text-white'
              }`}
            >
              <Repeat size={10} />
              <span>LOOP</span>
            </button>
          </div>

          {/* Time Display */}
          <div className="w-full bg-[#08090b] p-1.5 rounded border border-[#1b1c23] text-center font-mono">
            <div className="text-[11px] font-bold text-[#00e5ff] leading-tight">
              {currentTime.toFixed(2)}s
            </div>
            <div className="text-[9px] text-neutral-500">
              / {(activeClip?.duration || 0).toFixed(2)}s
            </div>
          </div>
        </div>

        {/* Center: Waveform Canvas */}
        <div
          ref={containerRef}
          {...targetHandlers('deck', (id) => {
            if (onDropClipIntoDeckA) onDropClipIntoDeckA(id);
            else {
              const clip = clipById(id);
              if (clip) onInsertClipToDeckA(clip);
            }
          })}
          className={`flex-1 relative bg-[#090a0d] flex flex-col transition-all ${
            dropTarget === 'deck' ? 'ring-2 ring-[#00a2ff] ring-inset bg-[#0d1525]' : ''
          }`}
        >
          {dropTarget === 'deck' && (
            <div className="absolute inset-0 z-30 pointer-events-none flex items-center justify-center">
              <span className="text-[12px] font-mono font-bold text-white bg-[#0088ff]/85 border border-[#4db2ff] px-3 py-1.5 rounded shadow-lg">
                Clip hier ablegen → an Playhead in Deck A einfügen
              </span>
            </div>
          )}
          <canvas
            ref={canvasRef}
            width={900}
            height={130}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            className="w-full h-full cursor-crosshair"
          />

          {/* Zoom controls floating in top-right */}
          <div className="absolute top-2 right-2 flex items-center space-x-1 bg-[#14161e]/90 p-1 rounded border border-[#252836] z-20">
            <button
              onClick={() => setZoomLevel((z) => Math.min(8.0, z * 1.35))}
              className="p-1 hover:bg-[#252836] text-neutral-400 hover:text-white rounded"
              title="Zoom In"
            >
              <ZoomIn size={12} />
            </button>
            <button
              onClick={() => setZoomLevel((z) => Math.max(1.0, z / 1.35))}
              className="p-1 hover:bg-[#252836] text-neutral-400 hover:text-white rounded"
              title="Zoom Out"
            >
              <ZoomOut size={12} />
            </button>
            <button
              onClick={() => setZoomLevel(1.0)}
              className="p-1 hover:bg-[#252836] text-neutral-400 hover:text-white rounded"
              title="Reset Zoom"
            >
              <RotateCcw size={12} />
            </button>
          </div>
        </div>

        {/* Right: Clip Library Carousel / Switcher */}
        <div className="w-64 bg-[#0e1014] border-l border-[#1c1e26] flex flex-col">
          <div className="h-7 bg-[#12141a] border-b border-[#1f212a] flex items-center justify-between px-2 text-[11px] font-bold text-neutral-300">
            <span>CLIPS ({clips.length})</span>
            <button
              onClick={onAddFromSelection}
              disabled={!hasSelectionInDeckA}
              className="text-[#00a2ff] hover:text-white disabled:opacity-30 flex items-center space-x-0.5"
              title="Auswahl in Deck A als neuen Clip hinzufügen"
            >
              <Plus size={12} />
              <span className="text-[10px]">Neu</span>
            </button>
          </div>

          {/* Scrollable Clips Strip */}
          <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
            {clips.length === 0 ? (
              <div className="h-24 flex items-center justify-center text-center text-neutral-500 text-[11px] px-2">
                Keine Clips gespeichert.
                <br />
                Auswahl in Deck A markieren und „Neu“ – oder Auswahl aus der Timeline hierher ziehen.
              </div>
            ) : (
              clips.map((clip) => {
                const isSelected = activeClip?.id === clip.id;
                return (
                  <div
                    key={clip.id}
                    {...clipDragProps(clip)}
                    onClick={() => onSelectClip(clip)}
                    title="In die Timeline von Deck A ziehen (an der Drop-Position einfügen) · Klick = auswählen"
                    className={`p-1.5 rounded-xs border cursor-grab active:cursor-grabbing transition-all flex items-center justify-between ${
                      isSelected
                        ? 'bg-[#181d29] border-[#0088ff] shadow-sm'
                        : 'bg-[#12141a] border-[#22242f] hover:border-[#313545]'
                    } ${dragClipId === clip.id ? 'opacity-40 border-dashed border-[#00a2ff]' : ''}`}
                  >
                    <div className="flex flex-col truncate pr-1">
                      <span className="text-white text-[11px] font-medium truncate">
                        {clip.name}
                      </span>
                      <span className="text-neutral-500 text-[9.5px] font-mono">
                        {clip.bpm.toFixed(0)} BPM • {clip.key} • {clip.duration.toFixed(1)}s
                      </span>
                    </div>

                    <div className="flex items-center space-x-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteClip(clip.id);
                        }}
                        className="p-1 text-neutral-500 hover:text-[#ff453a] transition-colors"
                        title="Clip löschen"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
