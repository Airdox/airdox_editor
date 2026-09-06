/**
 * @license
 * Airdox_intelligents_Editor - Master Application
 * Authoritative Visual Lock implementation matching screenshots 01, 02, and 03.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  TrackModel,
  PartialTrackModel,
  WaveformMode,
  SelectionRange,
  PaletteClip,
  EditSegment,
  DataOrigin,
  EditHistoryEntry,
  CuePoint,
} from './types/rekordbox';
import { mapRekordboxDatabaseRows } from './rekordbox/dbParser';
import { logger } from './utils/logger';
import { analyzeAudioBuffer, analyzePcm } from './waveform/analyzer';
import {
  CLIP_LIBRARY_LABEL,
  addClip,
  buildClip,
  normalizeLibrary,
  clipAudioOf as pcmOfClip,
  describeClip,
  dropModeFor,
  duplicateClip,
  ensureConsistentClip,
  applyClipDrop,
  clipDropNote,
  clipDropTitle,
  clipExportFileName,
  clipLevelNote,
  describeClipFit,
  fitClipForTrack,
  moveClip,
  nextClipId,
  readClipDragPayload,
  removeClip,
  renameClip,
  resolveClipTargetTime,
  type ClipDropMode,
} from './audio/clipLibrary';
import { tempoFitNote } from './audio/timeStretch';
import {
  EditableAudio,
  copyRange,
  copyRangeToEnd,
  cutRange,
  insertClipAt,
  moveRangeToStart,
  overdubRange,
  pasteAt,
  removeRange,
  replaceRange,
  silenceRange,
  EditReport,
} from './audio/editOps';
import { PcmAudio, pcmDuration, pcmFromAudioBuffer, pcmSampleCount as pcmSampleCountOrZero, pcmToAudioBuffer } from './audio/pcm';
import { encodeWav } from './audio/wav';
import { generateDemoTrack } from './audio/demoTrack';
import {
  ProjectAudioBlock,
  ProjectSegment,
  ProjectTrack,
  buildProjectFile,
  encodeAudioBlock,
  decodeAudioBlock,
  parseProject,
  serializeProject,
} from './projects/projectFormat';
import {
  describeSaveMode,
  isDesktopShell,
  openTextFile,
  saveBinaryFile,
  saveFileSetToDirectory,
  saveTextFile,
  suggestProjectFileName,
} from './projects/projectIO';
import { audioEngine } from './audio/audioEngine';
import {
  parseRekordboxXml,
  parseRekordboxXmlAsync,
  XmlImportProgress,
  DEFAULT_REKORDBOX_XML,
  buildBeatGridFromTempo,
} from './rekordbox/xmlParser';
import { applyAnlzExtractionToTrack, generateRekordboxPhrases, parseAnlzBinary } from './rekordbox/databaseExtractor';

import { TitleBar } from './components/TitleBar';
import { MenuBar } from './components/MenuBar';
import { EditModeBar } from './components/EditModeBar';
import { TrackHeader } from './components/TrackHeader';
import { DetailWaveform } from './components/DetailWaveform';
import { PalettePanel, type ClipDeckCommand } from './components/PalettePanel';
import { BottomControlBlock } from './components/BottomControlBlock';
import { BrowserMultiTrackBar } from './components/BrowserMultiTrackBar';
import { ProjectInfoModal } from './components/Modals/ProjectInfoModal';
import { ExportModal } from './components/Modals/ExportModal';
import { DatabaseExtractionModal } from './components/Modals/DatabaseExtractionModal';
import { RekordboxXmlImportModal } from './components/Modals/RekordboxXmlImportModal';
import { ImportProgressModal } from './components/Modals/ImportProgressModal';
import {
  OperationFeedbackModal,
  OperationTelemetry,
} from './components/Modals/OperationFeedbackModal';
import { SystemLogModal } from './components/Modals/SystemLogModal';

/**
 * Shared conversion of a compact collection entry (XML or Rekordbox DB)
 * into a complete TrackModel that the collection browser can render.
 */
function buildCollectionTrackModel(
  pt: PartialTrackModel,
  idx: number,
  origin: DataOrigin
): TrackModel {
  const duration = pt.duration && !isNaN(pt.duration) ? pt.duration : 300.0;
  const bpm = pt.bpm && !isNaN(pt.bpm) ? pt.bpm : 130.0;
  const id = pt.id || `${origin === DataOrigin.REKORDBOX_DB ? 'rb-db' : 'rb-xml'}-${Date.now()}-${idx}`;
  return {
    id,
    title: pt.title || 'Untitled Track',
    artist: pt.artist || 'Unknown Artist',
    album: pt.album || 'Rekordbox Collection',
    genre: pt.genre,
    label: pt.label,
    rating: pt.rating,
    playCount: pt.playCount,
    year: pt.year,
    comments: pt.comments,
    dateAdded: pt.dateAdded,
    remixer: pt.remixer,
    isrc: pt.isrc,
    bpm,
    key: pt.key || '2A',
    duration,
    sampleRate: pt.sampleRate || 44100,
    channels: pt.channels || 2,
    originalSha256: pt.originalSha256 || `sha256-rb-${idx}`,
    isOriginalUntouched: true,
    audioBuffer: pt.audioBuffer || null,
    beatGrid: pt.beatGrid || buildBeatGridFromTempo(0.0, bpm, duration),
    cues: pt.cues || [],
    loops: pt.loops || [],
    analysis: pt.analysis || null,
    phrases: pt.phrases || [],
    rawXmlAttributes: pt.rawXmlAttributes,
    originalMedia: pt.originalMedia,
    origin,
    workingSegments: [
      {
        id: `seg-${idx}`,
        type: 'ORIGINAL',
        trackId: id,
        sourceStart: 0,
        sourceEnd: duration,
        projectStart: 0,
        projectDuration: duration,
        gain: 1.0,
      },
    ],
  };
}

export default function App() {
  // Project state - Stringent Empty Project (Master Prompt & Voice Directive)
  const [projectName, setProjectName] = useState<string>('New Project');
  const [tracks, setTracks] = useState<TrackModel[]>([]);
  const [activeTrackId, setActiveTrackId] = useState<string>('');
  const [workingAudioBuffer, setWorkingAudioBuffer] = useState<AudioBuffer | null>(null);
  /**
   * Arbeitskopie im reinen PCM-Modell: alle Schnitte laufen darüber, damit der
   * Editor dieselben Funktionen benutzt wie die Tests. workingAudioBuffer ist nur
   * die Wiedergabeansicht davon.
   */
  const [workingPcm, setWorkingPcm] = useState<PcmAudio | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState<boolean>(false);

  // Viewport & Timeline state
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [viewOffset, setViewOffset] = useState<number>(0); // detail start in seconds
  const [viewDuration, setViewDuration] = useState<number>(18.0); // zoom window in seconds (default ~9-10 bars @ 130bpm)
  const [waveformMode, setWaveformMode] = useState<WaveformMode>('AMBER');
  const [quantize, setQuantize] = useState<boolean>(true);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [loopActive, setLoopActive] = useState<boolean>(false);
  const [masterVolume, setMasterVolume] = useState<number>(0.9);
  const [meterL, setMeterL] = useState<number>(0);
  const [meterR, setMeterR] = useState<number>(0);

  // Selection state - Starts with null (Clean Empty Project)
  const [selection, setSelection] = useState<SelectionRange | null>(null);

  // Palette state - Starts completely empty
  const [paletteOpen, setPaletteOpen] = useState<boolean>(true); // Screenshot 01 (open) vs Screenshot 02 (closed)
  const [paletteClips, setPaletteClips] = useState<PaletteClip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  /** Clip, der gerade im Deck-Spieler läuft – die Spur selbst bleibt unberührt. */
  const [deckClipId, setDeckClipId] = useState<string | null>(null);
  const [deckTime, setDeckTime] = useState<number>(0);
  const deckClipBuffers = useRef<Map<string, AudioBuffer>>(new Map());
  /** Clips aus anderer Quelle: Tempo an die Zielspur anpassen (Standard: an). */
  const [clipTempoMatch, setClipTempoMatch] = useState<boolean>(true);
  /** Tonhöhe folgt dem Tempo (Key-Lock aus) – sonst hält der Vocoder die Tonhöhe. */
  const [clipPitchFollow, setClipPitchFollow] = useState<boolean>(false);
  /** Aufgeklappte Deck-Ansicht der Clip-Bibliothek. */
  const [clipDeckOpen, setClipDeckOpen] = useState<boolean>(false);
  /** true: die Vorschau spielt den Clip, wie er in die aktive Spur käme (Pegel + Tempo). */
  const [deckPreviewFitted, setDeckPreviewFitted] = useState<boolean>(false);
  /** Loop-Region des Clip-Spielers in Clip-Sekunden (null = ganzer Clip) und die offene Marke. */
  const [deckLoop, setDeckLoop] = useState<{ start: number; end: number } | null>(null);
  const [deckLoopMark, setDeckLoopMark] = useState<number | null>(null);
  /** Vorschau-Puffer „Clip wie eingefügt“, nach Einstellung censiert. */
  const clipFitBuffers = useRef<Map<string, AudioBuffer>>(new Map());
  /** Für den Animationslauf: läuft gerade ein Clip im Spieler (ID oder null)? */
  const deckClipRef = useRef<string | null>(null);

  // Clipboard for Copy / Paste / Insert
  const [clipboardBuffer, setClipboardBuffer] = useState<PcmAudio | null>(null);

  // History Stack for Undo / Redo
  const [undoStack, setUndoStack] = useState<EditHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<EditHistoryEntry[]>([]);

  // Browser bar
  const [browserOpen, setBrowserOpen] = useState<boolean>(false);

  // Modals
  const [infoModalOpen, setInfoModalOpen] = useState<boolean>(false);
  const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);
  const [dbExtractionModalOpen, setDbExtractionModalOpen] = useState<boolean>(false);
  const [xmlCollectionModalOpen, setXmlCollectionModalOpen] = useState<boolean>(false);
  const [xmlImportedTracks, setXmlImportedTracks] = useState<TrackModel[]>([]);
  const [xmlFileName, setXmlFileName] = useState<string>('rekordbox_collection.xml');
  // Which database reader is active in this installation (native module or the
  // compiler-free JavaScript path). Only meaningful inside the desktop app.
  const [databaseEngines, setDatabaseEngines] = useState<RekordboxDatabaseEngines | null>(null);

  // Real-time Transparency Modals (Non-blocking parser & operation feedback)
  const [importProgress, setImportProgress] = useState<XmlImportProgress | null>(null);
  const [importProgressModalOpen, setImportProgressModalOpen] = useState<boolean>(false);
  const [feedbackTelemetry, setFeedbackTelemetry] = useState<OperationTelemetry | null>(null);
  const [feedbackModalOpen, setFeedbackModalOpen] = useState<boolean>(false);
  const [systemLogModalOpen, setSystemLogModalOpen] = useState<boolean>(false);

  const showOperationFeedback = useCallback((telemetry: OperationTelemetry) => {
    setFeedbackTelemetry(telemetry);
    setFeedbackModalOpen(true);
  }, []);

  // Hidden file inputs
  const xmlFileInputRef = useRef<HTMLInputElement>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);

  // Active track helper (supports empty state)
  const activeTrack = tracks.find((t) => t.id === activeTrackId) || tracks[0] || null;

  // ── Arbeitsstand: PCM als Quelle, AudioBuffer nur für die Wiedergabe ──────
  const trackPcm = useCallback((track: TrackModel): PcmAudio | null => {
    if (track.workingPcm) return track.workingPcm;
    if (track.audioBuffer) return pcmFromAudioBuffer(track.audioBuffer);
    return null;
  }, []);

  const editableFrom = useCallback(
    (track: TrackModel, pcm: PcmAudio | null): EditableAudio => ({
      audio: pcm ?? { sampleRate: track.sampleRate, channels: [new Float32Array(0)] },
      cues: track.cues,
      loops: track.loops,
      beatGrid: track.beatGrid,
    }),
    []
  );

  /**
   * Ergebnis eines Eingriffs in den Zustand übernehmen: Spur, Wellenform,
   * Wiedergabepuffer und Schmutz-Markierung. Das Original (audioBuffer) bleibt.
   */
  const commitEditable = useCallback(
    (trackId: string, next: EditableAudio, options: { selection?: SelectionRange | null; touch?: boolean } = {}) => {
      const ctx = audioEngine.getContext();
      const buffer = pcmToAudioBuffer(ctx, next.audio);
      setWorkingPcm(next.audio);
      setWorkingAudioBuffer(buffer);
      setTracks((prev) =>
        prev.map((track) =>
          track.id === trackId
            ? {
                ...track,
                workingPcm: next.audio,
                duration: Math.round(pcmDuration(next.audio) * 1e6) / 1e6,
                cues: next.cues,
                loops: next.loops,
                beatGrid: next.beatGrid,
                analysis: analyzePcm(next.audio, DataOrigin.PROJECT),
              }
            : track
        )
      );
      if (options.selection !== undefined) setSelection(options.selection);
      if (options.touch !== false) setIsDirty(true);
    },
    []
  );

  /** Eintragung im Operations-Protokoll aus dem Report einer Editier-Operation. */
  const reportFeedback = useCallback(
    (track: TrackModel, report: EditReport, title: string) => {
      showOperationFeedback({
        title,
        operationType:
          report.kind === 'INSERT_CLIP'
            ? 'INSERT'
            : report.kind === 'REPLACE_RANGE'
              ? 'REPLACE'
              : report.kind === 'OVERDUB_RANGE'
                ? 'OVERDUB'
                : report.kind === 'SILENCE_RANGE'
                  ? 'CLEAR'
                  : report.kind === 'REMOVE_RANGE'
                    ? 'DELETE'
                    : 'INSERT',
        description: report.description,
        timeRangeSec: {
          start: report.targetStart,
          end: report.targetEnd,
          duration: report.durationSec,
        },
        barsCount: report.barsCount,
        beatsCount: report.endBeat - report.startBeat,
        shiftedCuesCount: report.shiftedCues,
        originalSha256: track.originalSha256,
        timestamp: Date.now(),
      });
    },
    [showOperationFeedback]
  );

  // Real-time animation loop for playhead progress and VU stereo meters
  useEffect(() => {
    let animId: number;
    const updateLoop = () => {
      if (audioEngine.getIsPlaying()) {
        const time = audioEngine.getCurrentTime();
        if (deckClipRef.current) {
          // Clip im Spieler: nur die Clip-Position läuft, die Spur bleibt stehen.
          setDeckTime(time);
        } else {
          setCurrentTime(time);
        }

        // Keep detail view centered or following playhead if near boundary
        if (time > viewOffset + viewDuration * 0.9) {
          setViewOffset(Math.max(0, time - viewDuration * 0.2));
        }

        const meter = audioEngine.getMasterMeter();
        setMeterL(meter.left);
        setMeterR(meter.right);
      } else {
        setMeterL((prev) => Math.max(0, prev * 0.85));
        setMeterR((prev) => Math.max(0, prev * 0.85));
      }
      animId = requestAnimationFrame(updateLoop);
    };

    animId = requestAnimationFrame(updateLoop);
    return () => cancelAnimationFrame(animId);
  }, [viewOffset, viewDuration]);

  /** Referenz für den Animationslauf: zeigt der Spieler gerade einen Clip? */
  deckClipRef.current = deckClipId;

  // Master volume control
  const handleMasterVolumeChange = (vol: number) => {
    setMasterVolume(vol);
    audioEngine.setMasterVolume(vol);
  };

  // Wiedergabe: läuft ein Clip im Deck-Spieler, gehören Zeit und Loop diesem Clip
  const handleTogglePlay = () => {
    if (isPlaying) {
      audioEngine.pause();
      setIsPlaying(false);
      return;
    }
    if (deckClip) {
      const buffer = deckBufferFor(deckClip);
      if (!buffer) {
        alert('Der Clip im Deck-Spieler hat keine Audiodaten.');
        return;
      }
      const loop = loopActive ? deckLoop : null;
      const wanted = Math.min(deckTime, Math.max(0, buffer.duration - 0.01));
      const from = loop ? Math.min(Math.max(wanted, loop.start), Math.max(loop.start, loop.end - 0.005)) : wanted;
      audioEngine.play(buffer, from, Boolean(loop), loop ? loop.start : 0, loop ? loop.end : buffer.duration);
      setIsPlaying(true);
      return;
    }
    if (!activeTrack || !workingAudioBuffer) return;
    let loopStart = 0;
    let loopEnd = 0;
    if (loopActive && selection) {
      loopStart = selection.start;
      loopEnd = selection.end;
    }
    audioEngine.play(workingAudioBuffer, currentTime, loopActive, loopStart, loopEnd);
    setIsPlaying(true);
  };

  const handleReturnToStart = () => {
    audioEngine.stop();
    setIsPlaying(false);
    setDeckTime(0);
    setCurrentTime(0);
    setViewOffset(0);
  };

  const handleSeek = (targetTime: number) => {
    if (deckClip) {
      // Im Spieler bezieht sich die Position auf den Clip, nicht auf die Spur.
      const buffer = deckBufferFor(deckClip);
      const limit = buffer ? buffer.duration : deckClip.duration;
      const clamped = Math.max(0, Math.min(Math.max(0, limit - 0.001), targetTime));
      setDeckTime(clamped);
      if (isPlaying && buffer) {
        const loop = loopActive ? deckLoop : null;
        audioEngine.play(buffer, clamped, Boolean(loop), loop ? loop.start : 0, loop ? loop.end : limit);
      }
      return;
    }
    const clamped = Math.max(0, Math.min(activeTrack?.duration || 0, targetTime));
    setCurrentTime(clamped);
    if (isPlaying && workingAudioBuffer) {
      audioEngine.play(workingAudioBuffer, clamped, loopActive);
    }
  };

  // Zoom controls
  const handleZoomIn = () => {
    setViewDuration((prev) => Math.max(3.0, prev * 0.7));
  };
  const handleZoomOut = () => {
    setViewDuration((prev) => Math.min(activeTrack?.duration || 120, prev * 1.4));
  };
  const handleResetZoom = () => {
    setViewDuration(18.0);
  };
  const handlePanView = (newOffset: number) => {
    const maxOffset = Math.max(0, (activeTrack?.duration || 120) - viewDuration);
    setViewOffset(Math.max(0, Math.min(maxOffset, newOffset)));
  };

  // Pioneer Memory Cue Jump Handlers (Memory Call < and >)
  const handlePrevMemoryCue = useCallback(() => {
    if (!activeTrack) return;
    const memCues = activeTrack.cues
      .filter((c) => c.type === 'MEMORY')
      .sort((a, b) => a.position - b.position);
    if (memCues.length === 0) return;

    // Find cue immediately before current time (with small buffer)
    const prevCues = memCues.filter((c) => c.position < currentTime - 0.08);
    const target = prevCues.length > 0 ? prevCues[prevCues.length - 1] : memCues[memCues.length - 1];
    handleSeek(target.position);
  }, [activeTrack, currentTime]);

  const handleNextMemoryCue = useCallback(() => {
    if (!activeTrack) return;
    const memCues = activeTrack.cues
      .filter((c) => c.type === 'MEMORY')
      .sort((a, b) => a.position - b.position);
    if (memCues.length === 0) return;

    // Find cue immediately after current time
    const nextCues = memCues.filter((c) => c.position > currentTime + 0.08);
    const target = nextCues.length > 0 ? nextCues[0] : memCues[0];
    handleSeek(target.position);
  }, [activeTrack, currentTime]);

  // Set new Memory Cue with precise database millisecond timestamp and bar/beat calculation
  const handleAddMemoryCue = useCallback(() => {
    if (!activeTrack) return;
    const existingMems = activeTrack.cues.filter((c) => c.type === 'MEMORY');
    const nextIndex = existingMems.length + 1;
    const spb = 60.0 / activeTrack.bpm;
    const beatIndex = Math.max(0, Math.round((currentTime - (activeTrack.beatGrid.firstBeat || 0)) / spb));
    const barNumber = Math.floor(beatIndex / 4) + 1;
    const beatNumber = (beatIndex % 4) + 1;

    const newCue: CuePoint = {
      id: `mem-${Date.now()}`,
      position: currentTime,
      inMsec: Math.round(currentTime * 1000),
      type: 'MEMORY',
      name: `MEM ${nextIndex}`,
      color: '#ff2222',
      cueIndex: nextIndex,
      barNumber,
      beatNumber,
      origin: DataOrigin.LOCAL_ANALYSIS,
    };

    setTracks((prev) =>
      prev.map((t) => {
        if (t.id === activeTrack.id) {
          return {
            ...t,
            cues: [...t.cues, newCue],
            isModified: true,
          };
        }
        return t;
      })
    );
  }, [activeTrack, currentTime]);

  // Apply extracted track from Rekordbox Database / ANLZ
  const handleApplyExtractedTrack = (extractedTrack: TrackModel) => {
    setTracks((prev) => {
      const idx = prev.findIndex((t) => t.id === extractedTrack.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = extractedTrack;
        return next;
      }
      return [extractedTrack, ...prev];
    });
    setActiveTrackId(extractedTrack.id);
    if (extractedTrack.audioBuffer) {
      setWorkingAudioBuffer(extractedTrack.audioBuffer);
      setWorkingPcm(pcmFromAudioBuffer(extractedTrack.audioBuffer));
    }
  };

  // Snapshot current state for Undo
  const pushHistorySnapshot = (desc: string) => {
    if (!activeTrack) return;
    const snapshot: EditHistoryEntry = {
      description: desc,
      timestamp: Date.now(),
      segments: activeTrack.workingSegments.map((s) => ({ ...s })),
      selection: selection ? { ...selection } : null,
      cues: activeTrack.cues.map((c) => ({ ...c })),
      loops: activeTrack.loops.map((l) => ({ ...l })),
      beatGrid: activeTrack.beatGrid,
      audio: trackPcm(activeTrack) ?? undefined,
    };
    setUndoStack((prev) => [...prev.slice(-30), snapshot]);
    setRedoStack([]);
  };

  /** Rückgängig: stellt den gespeicherten Arbeitsstand samplegenau wieder her. */
  const handleUndo = () => {
    if (undoStack.length === 0 || !activeTrack) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));

    const currentSnapshot: EditHistoryEntry = {
      description: 'Before Undo',
      timestamp: Date.now(),
      segments: activeTrack.workingSegments.map((s) => ({ ...s })),
      selection: selection ? { ...selection } : null,
      cues: activeTrack.cues.map((c) => ({ ...c })),
      loops: activeTrack.loops.map((l) => ({ ...l })),
      beatGrid: activeTrack.beatGrid,
      audio: trackPcm(activeTrack) ?? undefined,
    };
    setRedoStack((prev) => [...prev, currentSnapshot]);

    if (previous.audio) {
      commitEditable(
        activeTrack.id,
        {
          audio: previous.audio,
          cues: previous.cues,
          loops: previous.loops ?? [],
          beatGrid: previous.beatGrid ?? activeTrack.beatGrid,
        },
        { selection: previous.selection }
      );
    } else if (activeTrack.audioBuffer) {
      // Alter Stand ohne Sample-Snapshot: aus den Segmenten neu aufbauen.
      const reRendered = audioEngine.renderWorkingAudio(activeTrack.audioBuffer, previous.segments);
      setWorkingAudioBuffer(reRendered);
      setWorkingPcm(pcmFromAudioBuffer(reRendered));
      setSelection(previous.selection);
    }
    setIsDirty(true);
  };

  const handleRedo = () => {
    if (redoStack.length === 0 || !activeTrack) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));

    const currentSnapshot: EditHistoryEntry = {
      description: 'Before Redo',
      timestamp: Date.now(),
      segments: activeTrack.workingSegments.map((s) => ({ ...s })),
      selection: selection ? { ...selection } : null,
      cues: activeTrack.cues.map((c) => ({ ...c })),
      loops: activeTrack.loops.map((l) => ({ ...l })),
      beatGrid: activeTrack.beatGrid,
      audio: trackPcm(activeTrack) ?? undefined,
    };
    setUndoStack((prev) => [...prev, currentSnapshot]);

    if (next.audio) {
      commitEditable(
        activeTrack.id,
        {
          audio: next.audio,
          cues: next.cues,
          loops: next.loops ?? [],
          beatGrid: next.beatGrid ?? activeTrack.beatGrid,
        },
        { selection: next.selection }
      );
    } else if (activeTrack.audioBuffer) {
      const reRendered = audioEngine.renderWorkingAudio(activeTrack.audioBuffer, next.segments);
      setWorkingAudioBuffer(reRendered);
      setWorkingPcm(pcmFromAudioBuffer(reRendered));
      setSelection(next.selection);
    }
    setIsDirty(true);
  };

  /** Gemeinsamer Ablauf: Snapshot → Operation → commit → Protokoll. */
  const applyEdit = (
    title: string,
    operation: (track: EditableAudio) => { target: EditableAudio; report: EditReport },
    options: { newSelection?: SelectionRange | null } = {}
  ): boolean => {
    if (!activeTrack) return false;
    const editable = editableFrom(activeTrack, trackPcm(activeTrack));
    if (pcmDuration(editable.audio) <= 0) {
      alert('Diese Spur hat keine Audiodaten – laden oder importiere zuerst Audio.');
      return false;
    }
    pushHistorySnapshot(title);
    const outcome = operation(editable);
    commitEditable(activeTrack.id, outcome.target, {
      selection: options.newSelection === undefined ? selection : options.newSelection,
    });
    reportFeedback(activeTrack, outcome.report, title);
    if (outcome.report.warnings.length > 0) {
      logger.warn('EDITING', `[${title}] ${outcome.report.warnings.join(' ')}`);
    }
    return true;
  };

  // Add selection to Palette (CLONE or '+' button)
  const handleAddSelectionToPalette = () => {
    if (!selection || !activeTrack) return;
    const source = trackPcm(activeTrack);
    if (!source) return;
    const sliced = copyRange({ audio: source, cues: [], loops: [], beatGrid: activeTrack.beatGrid }, selection.start, selection.end);
    setPaletteClips((prev) => {
      const newClip = buildClip(
        {
          name: `${activeTrack.title} (${selection.barsCount.toFixed(1)} Bars)`,
          sourceTrackId: activeTrack.id,
          sourceTrackName: activeTrack.title,
          sourceStart: selection.start,
          sourceEnd: selection.end,
          bpm: activeTrack.bpm,
          key: activeTrack.key,
          meter: activeTrack.beatGrid.meter,
          origin: DataOrigin.PROJECT,
          pcm: sliced,
        },
        { existing: prev }
      );
      setSelectedClipId(newClip.id);
      logger.info('EDITING', `Clip in ${CLIP_LIBRARY_LABEL}: ${describeClip(newClip)}`);
      return addClip(prev, newClip);
    });
    if (!paletteOpen) setPaletteOpen(true);
    setIsDirty(true);
  };

  // ── Clip-Bibliothek: Pflege (alle Wege über src/audio/clipLibrary) ────────
  const handleRenameClip = (id: string, name: string) => {
    setPaletteClips((prev) => renameClip(prev, id, name));
    setIsDirty(true);
  };

  const handleDuplicateClip = (id: string) => {
    setPaletteClips((prev) => {
      const next = duplicateClip(prev, id);
      const copy = next.find((clip) => clip.id.startsWith(`${id}-kopie`));
      if (copy) setSelectedClipId(copy.id);
      return next;
    });
    setIsDirty(true);
  };

  const handleMoveClip = (id: string, delta: number) => {
    setPaletteClips((prev) => moveClip(prev, id, delta));
    setIsDirty(true);
  };

  const handleDeleteClip = (id: string) => {
    setPaletteClips((prev) => removeClip(prev, id));
    if (selectedClipId === id) setSelectedClipId(null);
    if (deckClipId === id) handleUnloadDeckClip();
    deckClipBuffers.current.delete(id);
    setIsDirty(true);
  };

  // ── Clip in den Deck-Spieler laden (die Spur bleibt unberührt) ────────────
  const handleLoadClipIntoDeck = (id: string) => {
    const clip = paletteClips.find((entry) => entry.id === id);
    if (!clip) return;
    if (!pcmOfClip(clip)) {
      alert(`Clip „${clip.name}“ enthält keine Audiodaten und kann nicht geladen werden.`);
      return;
    }
    if (!clipBufferFor(clip)) {
      alert('Der Clip konnte nicht für die Wiedergabe vorbereitet werden.');
      return;
    }
    setSelectedClipId(clip.id);
    setDeckClipId(clip.id);
    setDeckTime(0);
    audioEngine.stop();
    setIsPlaying(false);
    logger.info('UI', `Clip in den Deck-Spieler geladen: ${describeClip(clip)}`);
  };

  const handleUnloadDeckClip = () => {
    if (!deckClipId) return;
    audioEngine.stop();
    setIsPlaying(false);
    setDeckClipId(null);
    setDeckTime(0);
    logger.info('UI', 'Deck-Spieler: Clip entfernt, wieder die ganze Spur.');
  };

  /** Clip an einer Zielzeit ablegen: einfügen, darüberlegen, ersetzen oder in den Spieler. */
  const handleDropClip = (
    clipId: string,
    wantedSeconds: number,
    modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
  ) => {
    const clip = paletteClips.find((entry) => entry.id === clipId);
    if (!clip) return;
    const mode: ClipDropMode = dropModeFor(modifiers);
    if (mode === 'deck') {
      handleLoadClipIntoDeck(clipId);
      return;
    }
    const audio = pcmOfClip(clip);
    if (!audio) {
      alert(`Clip „${clip.name}“ enthält keine Audiodaten.`);
      return;
    }
    if (!activeTrack) {
      alert('Ohne geladene Spur kann kein Clip eingefügt werden.');
      return;
    }
    const source = trackPcm(activeTrack);
    if (!source) {
      alert('Die aktive Spur hat keine Audiodaten.');
      return;
    }
    // Dieselbe Rechnung wie in tests/clip-library.test.ts: anpassen, rastern, ablegen.
    // Vor der Ablage normalisiert der Kern den Clip-Pegel, hält beim Überlagern den
    // Kopfraum frei und bringt die Dauer auf das Tempo der Zielspur – was er getan
    // hat, steht mit im Bericht (und deshalb auch im Undo-Protokoll).
    const outcome = applyClipDrop(editableFrom(activeTrack, source), audio, wantedSeconds, {
      quantize,
      mode,
      sourceBpm: clip.bpm,
      tempoMatch: clipTempoMatch,
      pitchFollowsTempo: clipPitchFollow,
    });
    const levelNote = clipLevelNote(outcome.level, outcome.mix ?? null);
    if (levelNote) logger.info('EDITING', `[Pegel] ${levelNote}`);
    const fitNote = clipDropNote(outcome);
    const tempoNote = tempoFitNote(outcome.tempo);
    if (tempoNote) logger.info('EDITING', `[Tempo] ${tempoNote}`);
    if (fitNote) {
      const base = outcome.report.description.replace(/\s*\(?\s*–\s*.*$/, '').replace(/\.$/, '');
      outcome.report.description = `${base} – ${fitNote}.`;
    }
    applyEdit(clipDropTitle(clip, mode), () => ({ target: outcome.target, report: outcome.report }));
    const at = outcome.atSeconds;
    const clipEnd = outcome.clipEndSeconds;

    const grid = activeTrack.beatGrid;
    const spb = grid.bpm > 0 ? 60 / grid.bpm : 0.5;
    setSelection({
      start: at,
      end: Math.min(clipEnd, pcmDuration(outcome.target.audio)),
      startBeat: (at - grid.firstBeat) / spb,
      endBeat: (clipEnd - grid.firstBeat) / spb,
      beatsCount: pcmDuration(audio) / spb,
      barsCount: pcmDuration(audio) / spb / Math.max(1, grid.meter),
      duration: pcmDuration(audio),
    });
    handleSeek(at);
    if (outcome.reason) logger.info('EDITING', `Zielzeit gerastet: ${outcome.reason} → ${at.toFixed(4)} s`);
  };

  /** Einfügen an der Markierung bzw. am Spielkopf – dieselbe Rechnung wie beim Ablageweg. */
  const handleInsertClipFromLibrary = (id: string, mode: 'insert' | 'overdub' | 'replace' = 'insert') => {
    const modifiers = mode === 'overdub' ? { altKey: true } : mode === 'replace' ? { shiftKey: true } : {};
    handleDropClip(id, selection ? selection.start : currentTime, modifiers);
  };

  /**
   * Kommandos der aufgeklappten Deck-Ansicht. Alles läuft über die bestehenden
   * Handler der zentralen Wiedergabe – das Clip-Deck ist eine zweite Ansicht auf
   * denselben Spieler, nicht ein zweiter Transport.
   */
  const handleClipDeckCommand = (command: ClipDeckCommand): void => {
    switch (command.type) {
      case 'load':
        setClipDeckOpen(true);
        handleLoadClipIntoDeck(command.clipId);
        break;
      case 'togglePlay':
        handleTogglePlay();
        break;
      case 'stop':
        audioEngine.stop();
        setIsPlaying(false);
        break;
      case 'returnToStart':
        setDeckTime(0);
        audioEngine.stop();
        setIsPlaying(false);
        break;
      case 'seek':
        handleSeek(command.seconds);
        break;
      case 'loopToggle':
        if (!deckLoop) {
          const clip = deckClip;
          const buffer = clip ? deckBufferFor(clip) : null;
          setDeckLoop({ start: 0, end: buffer ? buffer.duration : clip?.duration ?? 0 });
        }
        setLoopActive((value) => !value);
        break;
      case 'loopEdge': {
        if (command.edge === 'in') {
          setDeckLoopMark(deckTime);
          return;
        }
        const start = deckLoopMark ?? 0;
        const end = deckTime;
        if (end > start + 0.02) {
          setDeckLoop({ start, end });
          setLoopActive(true);
          setDeckLoopMark(null);
          logger.info('UI', `Clip-Deck: Schleife ${start.toFixed(3)}–${end.toFixed(3)} s im Clip.`);
        }
        break;
      }
      case 'loopClear':
        setDeckLoop(null);
        setDeckLoopMark(null);
        setLoopActive(false);
        break;
      case 'preview':
        setDeckPreviewFitted(command.fitted);
        if (isPlaying && deckClip) {
          const buffer = deckPreviewFitted === false ? deckBufferFor(deckClip) : clipBufferFor(deckClip);
          if (buffer) audioEngine.play(buffer, Math.min(deckTime, buffer.duration - 0.01), false, 0, buffer.duration);
        }
        logger.info('UI', command.fitted ? 'Clip-Deck: Vorschau spielt den Clip, wie er in die Spur käme.' : 'Clip-Deck: Vorschau spielt das Original des Clips.');
        break;
      case 'apply':
        handleInsertClipFromLibrary(command.clipId, command.mode);
        break;
      case 'toggleTempoMatch':
        setClipTempoMatch((value) => !value);
        logger.info('UI', `Tempoangleichung beim Ablagen: ${clipTempoMatch ? 'aus' : 'an'}.`);
        break;
      case 'togglePitchFollow':
        setClipPitchFollow((value) => !value);
        logger.info('UI', `Tonhöhe folgt dem Tempo: ${clipPitchFollow ? 'nein (Master Tempo)' : 'ja (Key-Lock aus)'}.`);
        break;
    }
  };

  /** Samples eines Clips – immer über denselben Kern wie die Bibliotheks-Tests. */
  const clipAudioOf = (clip: PaletteClip): PcmAudio | null => pcmOfClip(clip);

  // Neue Einstellung, neue Spur, anderer Clip-Stand: Vorschau-Puffer müssen weg.
  useEffect(() => {
    clipFitBuffers.current.clear();
  }, [clipTempoMatch, clipPitchFollow, activeTrackId, paletteClips]);

  /**
   * Puffer für den Deck-Spieler: der Clip selbst – oder, wenn die Vorschau auf
   * „wie eingefügt“ steht, genau das Material, das die Ablage schreiben würde.
   */
  const deckBufferFor = (clip: PaletteClip): AudioBuffer | null => {
    if (deckPreviewFitted) {
      const fitted = fittedClipBufferFor(clip);
      if (fitted) return fitted;
    }
    return clipBufferFor(clip);
  };

  /** Vorschau „Clip, wie er in die aktive Spur käme“ – rechnet der gemeinsame Kern. */
  const fittedClipBufferFor = (clip: PaletteClip): AudioBuffer | null => {
    const targetBpm = activeTrack?.beatGrid?.bpm ?? 0;
    const audio = pcmOfClip(clip);
    if (!audio) return null;
    const key = `${clip.id}|${targetBpm.toFixed(4)}|${clipTempoMatch ? 't' : '-'}${clipPitchFollow ? 'p' : '-'}|${audio.sampleRate}|${clip.bpm.toFixed(4)}`;
    const cached = clipFitBuffers.current.get(key);
    if (cached) return cached;
    const fitted = fitClipForTrack(audio, clip.bpm, targetBpm, {
      tempoMatch: clipTempoMatch,
      pitchFollowsTempo: clipPitchFollow,
    });
    const buffer = pcmToAudioBuffer(audioEngine.getContext(), fitted.pcm);
    clipFitBuffers.current.set(key, buffer);
    return buffer;
  };

  /** AudioBuffer für die Wiedergabe, aus dem PCM-Anteil des Clips (mit Cache). */
  const clipBufferFor = (clip: PaletteClip): AudioBuffer | null => {
    const cached = deckClipBuffers.current.get(clip.id);
    if (cached) return cached;
    const audio = pcmOfClip(clip);
    if (!audio) return null;
    const buffer = pcmToAudioBuffer(audioEngine.getContext(), audio);
    deckClipBuffers.current.set(clip.id, buffer);
    return buffer;
  };

  const deckClip = deckClipId ? paletteClips.find((clip) => clip.id === deckClipId) ?? null : null;

  const activePaletteClip = (): PaletteClip | null => {
    const clip = paletteClips.find((c) => c.id === selectedClipId) || paletteClips[0];
    if (!clip) {
      alert('Bitte wähle zuerst einen Clip in der Palette aus.');
      return null;
    }
    if (!clipAudioOf(clip)) {
      alert('Der Clip enthält keine Audiodaten.');
      return null;
    }
    return clip;
  };

  // Copy selection
  const handleCopy = () => {
    if (!selection || !activeTrack) return;
    const source = trackPcm(activeTrack);
    if (!source) return;
    const sliced = copyRange({ audio: source, cues: [], loops: [], beatGrid: activeTrack.beatGrid }, selection.start, selection.end);
    setClipboardBuffer(sliced);
    logger.info('EDITING', `Ablage gefüllt: ${selection.duration.toFixed(3)} s (${selection.beatsCount.toFixed(0)} Beats)`);
  };

  // Cut selection
  const handleCut = () => {
    if (!selection || !activeTrack) return;
    handleCopy();
    applyEdit('Auswahl ausgeschnitten', (track) => cutRange(track, selection!.start, selection!.end), {
      newSelection: null,
    });
  };

  // Paste at playhead (überschreibt, verschiebt die Timeline nicht)
  const handlePaste = () => {
    if (!clipboardBuffer || !activeTrack) return;
    const clip = clipboardBuffer;
    applyEdit('Ablage eingefügt', (track) => pasteAt(track, currentTime, clip));
  };

  // Insert (verschiebt Timeline und nachfolgende Marker)
  const handleInsert = () => {
    if (!clipboardBuffer || !activeTrack) return;
    const clip = clipboardBuffer;
    const insertPos = selection ? selection.start : currentTime;
    applyEdit('Clip eingeschnitten', (track) => ({
      ...insertClipAt(track, insertPos, clip),
    }));
  };

  // Replace selection with active Palette clip
  const handleReplace = () => {
    if (!selection || !activeTrack) return;
    const clip = activePaletteClip();
    if (!clip) return;
    const audio = clipAudioOf(clip)!;
    applyEdit('Auswahl ersetzt', (track) => replaceRange(track, selection.start, selection.end, audio));
  };

  // Overdub active Palette clip onto selection
  const handleOverdub = () => {
    if (!selection || !activeTrack) return;
    const clip = activePaletteClip();
    if (!clip) return;
    const audio = clipAudioOf(clip)!;
    applyEdit('Clip überlagert', (track) => overdubRange(track, selection.start, selection.end, audio, 0.85));
  };

  // Delete selection (entfernt den Bereich und zieht das Folgende nach)
  const handleDelete = () => {
    if (!selection || !activeTrack) return;
    applyEdit('Auswahl gelöscht', (track) => removeRange(track, selection.start, selection.end), {
      newSelection: null,
    });
  };

  // Kopiert die Auswahl ans Ende der Spur (auf den nächsten Taktanfang gerastet)
  const handleCopySelectionToEnd = () => {
    if (!selection || !activeTrack) return;
    applyEdit('Auswahl ans Ende kopiert', (track) => copyRangeToEnd(track, selection.start, selection.end, { alignToBar: true }));
  };

  // Setzt die Auswahl an den Taktanfang und entfernt sie aus der Mitte
  const handleMoveSelectionToStart = () => {
    if (!selection || !activeTrack) return;
    const firstBeat = activeTrack.beatGrid.firstBeat || 0;
    applyEdit('Auswahl an den Taktanfang gesetzt', (track) =>
      moveRangeToStart(track, selection.start, selection.end, { atSec: firstBeat })
    );
  };

  // Clear selection (silences range without changing duration)
  const handleClear = () => {
    if (!selection || !activeTrack) return;
    applyEdit('Bereich stummgeschaltet', (track) => silenceRange(track, selection.start, selection.end));
  };

  // BEAT SELECT handler (1, 2, 4, 8, 16, 32, 64, 128 beats)
  const handleBeatSelect = (beats: number) => {
    if (!activeTrack) return;
    const bg = activeTrack.beatGrid;
    const spb = 60.0 / bg.bpm;

    // Start from either current playhead or snapped bar start
    let startSec = currentTime;
    if (quantize) {
      const beatIndex = Math.round((startSec - bg.firstBeat) / spb);
      startSec = Math.max(0, bg.firstBeat + beatIndex * spb);
    }
    const endSec = Math.min(activeTrack.duration, startSec + beats * spb);
    const actualBeats = (endSec - startSec) / spb;

    setSelection({
      start: startSec,
      end: endSec,
      startBeat: (startSec - bg.firstBeat) / spb,
      endBeat: (endSec - bg.firstBeat) / spb,
      beatsCount: actualBeats,
      barsCount: actualBeats / bg.meter,
      duration: endSec - startSec,
    });
  };

  // SELECT Modus (Screenshot 03): HALF (1/2), DOUBLE (×2), CANCEL (⊗)
  const handleHalfSelection = () => {
    if (!selection || !activeTrack) return;
    const bg = activeTrack.beatGrid;
    const spb = 60.0 / bg.bpm;
    const newBeats = Math.max(0.5, selection.beatsCount / 2);
    const newEnd = selection.start + newBeats * spb;

    setSelection({
      start: selection.start,
      end: newEnd,
      startBeat: selection.startBeat,
      endBeat: selection.startBeat + newBeats,
      beatsCount: newBeats,
      barsCount: newBeats / bg.meter,
      duration: newEnd - selection.start,
    });
  };

  const handleDoubleSelection = () => {
    if (!selection || !activeTrack) return;
    const bg = activeTrack.beatGrid;
    const spb = 60.0 / bg.bpm;
    const newBeats = Math.min((activeTrack.duration - selection.start) / spb, selection.beatsCount * 2);
    const newEnd = selection.start + newBeats * spb;

    setSelection({
      start: selection.start,
      end: newEnd,
      startBeat: selection.startBeat,
      endBeat: selection.startBeat + newBeats,
      beatsCount: newBeats,
      barsCount: newBeats / bg.meter,
      duration: newEnd - selection.start,
    });
  };

  const handleCancelSelection = () => {
    setSelection(null);
  };

  /** Einen einzelnen Clip als WAV speichern – Dateiname wie beim Massenexport. */
  const handleExportClip = async (clipId: string) => {
    const clip = paletteClips.find((entry) => entry.id === clipId);
    if (!clip) return;
    const audio = clipAudioOf(clip);
    if (!audio) {
      alert(`Clip „${clip.name}“ enthält keine Audiodaten.`);
      return;
    }
    try {
      const written = await saveBinaryFile({
        suggestedName: clipExportFileName(paletteClips, clip),
        bytes: encodeWav(audio),
        kind: 'wav',
      });
      if (!written) return;
      logger.info('UI', `Clip exportiert: ${describeClip(clip)} → ${written.target}`);
    } catch (err) {
      alert(`Export fehlgeschlagen: ${(err as Error).message}`);
    }
  };

  // ── Palette-Clips als einzelne WAVs exportieren ───────────────────────────
  const handleExportPaletteClips = async () => {
    if (!activeTrack) return;
    const clips = paletteClips.length > 0 ? paletteClips : [];
    if (clips.length === 0) {
      alert(`Die ${CLIP_LIBRARY_LABEL} ist leer. Auswahl markieren und mit CLONE in die Bibliothek legen.`);
      return;
    }
    const files: Array<{ name: string; bytes: Uint8Array }> = [];
    clips.forEach((clip) => {
      const audio = clipAudioOf(clip);
      if (!audio) return;
      files.push({
        name: clipExportFileName(clips, clip),
        bytes: encodeWav(audio),
      });
    });
    if (files.length === 0) {
      alert('Keiner der Clips enthält Audiodaten.');
      return;
    }
    try {
      const result = await saveFileSetToDirectory({
        files,
        directoryTitle: `${files.length} Clips exportieren – Zielordner wählen`,
      });
      if (result.written.length === 0) return;
      showOperationFeedback({
        title: `Clips exportiert (${files.length} WAVs)`,
        operationType: 'EXPORT',
        description:
          `${files.length} Clips als 16-Bit-WAVs geschrieben` +
          (result.directory ? ` nach ${result.directory}` : ' (Browser-Download)') +
          '. Originaldateien wurden nicht verändert.',
        originalSha256: activeTrack.originalSha256,
        timestamp: Date.now(),
      });
      logger.info('UI', `Clips exportiert: ${files.length} Dateien${result.directory ? ` → ${result.directory}` : ''}`);
    } catch (err) {
      alert(`Export fehlgeschlagen: ${(err as Error).message}`);
    }
  };

  // ── Projekt speichern / öffnen ────────────────────────────────────────────
  const buildProjectTracks = (): Array<Omit<ProjectTrack, 'audio'> & { pcm: PcmAudio }> =>
    tracks.map((track) => {
      const audio = trackPcm(track);
      const meta: Omit<ProjectTrack, 'audio' | 'segments'> = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        genre: track.genre,
        label: track.label,
        rating: track.rating,
        playCount: track.playCount,
        year: track.year,
        comments: track.comments,
        dateAdded: track.dateAdded,
        remixer: track.remixer,
        isrc: track.isrc,
        key: track.key,
        bpm: track.bpm,
        duration: Math.round(pcmDuration(audio ?? { sampleRate: track.sampleRate, channels: [new Float32Array(0)] }) * 1e6) / 1e6,
        sampleRate: audio?.sampleRate ?? track.sampleRate,
        channels: audio?.channels.length ?? 2,
        origin: track.origin,
        originalSha256: track.originalSha256,
        isOriginalUntouched: track.isOriginalUntouched !== false,
        source: track.originalMedia,
        cues: track.cues,
        loops: track.loops,
        beatGrid: {
          firstBeat: track.beatGrid.firstBeat,
          bpm: track.beatGrid.bpm,
          meter: track.beatGrid.meter,
          origin: track.beatGrid.origin,
          beats: track.beatGrid.beats,
        },
        phrases: track.phrases ?? [],
      };
      return {
        ...meta,
        pcm: audio ?? { sampleRate: track.sampleRate, channels: [new Float32Array(0)] },
        segments: track.workingSegments.map<ProjectSegment>((segment) => ({
          id: segment.id,
          type: segment.type,
          sourceStart: segment.sourceStart,
          sourceEnd: segment.sourceEnd,
          projectStart: segment.projectStart,
          projectDuration: segment.projectDuration,
          gain: segment.gain,
          clipId: segment.clipId,
        })),
      };
    });

  const handleSaveProject = async (forceDialog: boolean = false) => {
    if (tracks.length === 0) {
      alert('Es gibt nichts zu speichern: lade zuerst Audio oder importiere eine Rekordbox-Sammlung.');
      return;
    }
    const project = buildProjectFile({
      projectName,
      activeTrackId: activeTrack?.id ?? tracks[0].id,
      view: { waveformMode, quantize, viewOffset, viewDuration, paletteOpen, clipTempoMatch, clipPitchFollow, clipDeckOpen },
      tracks: buildProjectTracks(),
      clips: paletteClips.map((clip) => ({
          id: clip.id,
          name: clip.name,
          sourceTrackId: clip.sourceTrackId,
          sourceTrackName: clip.sourceTrackName,
          sourceStart: clip.sourceStart,
          sourceEnd: clip.sourceEnd,
          duration: clip.duration,
          beats: clip.beats,
          bars: clip.bars,
          bpm: clip.bpm,
          key: clip.key,
          color: clip.color,
          origin: clip.origin,
          miniPeaks: clip.miniPeaks ?? [],
          pcm: clipAudioOf(clip) ?? { sampleRate: workingPcm?.sampleRate ?? 44100, channels: [new Float32Array(0)] },
      })),
      app: { name: 'Airdox_intelligents_Editor', version: '0.1.0' },
    });
    const text = serializeProject(project);
    const target = !forceDialog && projectPath && isDesktopShell() ? projectPath : null;
    try {
      if (target) {
        const bytes = await saveTextFileOverwrite(target, text);
        finishProjectSave(target, bytes, project.tracks.length, project.clips.length);
        return;
      }
      const written = await saveTextFile({
        suggestedName: suggestProjectFileName(projectName, activeTrack?.title),
        text,
        kind: 'project',
      });
      if (!written) return; // Dialog abgebrochen
      finishProjectSave(written.target, written.bytes, project.tracks.length, project.clips.length);
    } catch (err) {
      alert(`Projekt konnte nicht gespeichert werden: ${(err as Error).message}`);
      logger.error('UI', `Projektspeicherung fehlgeschlagen: ${(err as Error).message}`);
    }
  };

  /** BPM der ersten_projekt-Spur – Fallback, wenn ein Clip ohne BPM gespeichert wurde. */
  const firstBpmOf = (project: { tracks: Array<{ bpm: number }> }): number | undefined => {
    const bpm = project.tracks?.[0]?.bpm;
    return typeof bpm === 'number' && bpm > 0 ? bpm : undefined;
  };

  const saveTextFileOverwrite = async (target: string, text: string): Promise<number> => {
    const bridge = window.rekordboxDesktop;
    if (!bridge?.writeFile) throw new Error('Die Desktop-Bridge ist nicht verfügbar.');
    const result = await bridge.writeFile({ filePath: target, data: text, encoding: 'utf8' });
    return result.bytes;
  };

  const finishProjectSave = (target: string, bytes: number, trackCount: number, clipCount: number) => {
    setProjectPath(target);
    setIsDirty(false);
    showOperationFeedback({
      title: 'Projekt gespeichert',
      operationType: 'EXPORT',
      description:
        `${trackCount} Spur(en), ${clipCount} Clip(s) nach ${target} geschrieben (${(bytes / 1024).toFixed(0)} kB). ` +
        'Enthält die geschnittene Arbeitskopie; Originaldateien bleiben unberührt.',
      originalSha256: activeTrack?.originalSha256 ?? '',
      timestamp: Date.now(),
    });
    logger.info('UI', `Projekt gespeichert: ${target} (${bytes} Bytes)`);
  };

  const handleOpenProject = async () => {
    try {
      const opened = await openTextFile({ kind: 'project' });
      if (!opened) return;
      const { project, errors, warnings } = parseProject(opened.text);
      if (!project) {
        alert(`Projekt kann nicht geöffnet werden:\n${errors.join('\n')}`);
        logger.error('UI', `Projektöffnung abgelehnt: ${errors.join(' ')}`);
        return;
      }

      const ctx = audioEngine.getContext();
      const loadedTracks: TrackModel[] = [];
      const loadWarnings = [...warnings];
      for (const entry of project.tracks) {
        const { pcm, warning } = decodeAudioBlock(entry.audio as ProjectAudioBlock);
        if (warning) loadWarnings.push(`${entry.title}: ${warning}`);
        const buffer = pcmSampleCountOrZero(pcm) > 0 ? pcmToAudioBuffer(ctx, pcm) : null;
        loadedTracks.push({
          id: entry.id,
          title: entry.title,
          artist: entry.artist,
          album: entry.album,
          genre: entry.genre,
          label: entry.label,
          rating: entry.rating,
          playCount: entry.playCount,
          year: entry.year,
          comments: entry.comments,
          dateAdded: entry.dateAdded,
          remixer: entry.remixer,
          isrc: entry.isrc,
          bpm: entry.bpm,
          key: entry.key,
          duration: entry.duration,
          sampleRate: entry.sampleRate,
          channels: entry.channels,
          originalSha256: entry.originalSha256,
          isOriginalUntouched: entry.isOriginalUntouched,
          audioBuffer: buffer,
          workingPcm: pcm,
          beatGrid: entry.beatGrid.beats.length > 0
            ? entry.beatGrid
            : buildBeatGridFromTempo(entry.beatGrid.firstBeat, entry.beatGrid.bpm, entry.duration, entry.beatGrid.meter, DataOrigin.PROJECT),
          cues: entry.cues,
          loops: entry.loops,
          analysis: pcmSampleCountOrZero(pcm) > 0 ? analyzePcm(pcm, DataOrigin.PROJECT) : null,
          phrases: entry.phrases ?? [],
          origin: entry.origin,
          originalMedia: entry.source,
          workingSegments: entry.segments.map((segment) => ({ ...segment, trackId: entry.id })),
        });
      }

      if (loadedTracks.length === 0) {
        alert('Das Projekt enthält keine lesbare Spur.');
        return;
      }

      // Clips über denselben Kern wie die Bibliothek: aus dem Projektblock lesen,
      // dann konsistent machen (Dauer, Beats, Vorschau werden nachgerechnet).
      const loadedClips: PaletteClip[] = [];
      for (const clip of project.clips) {
        try {
          const pcm = decodeAudioBlock(clip.audio).pcm;
          loadedClips.push(
            ensureConsistentClip(
              {
                ...clip,
                clipPcm: pcm,
                audioBuffer: pcmToAudioBuffer(ctx, pcm),
              },
              { bpm: firstBpmOf(project) }
            )
          );
        } catch (err) {
          loadWarnings.push(`Clip „${clip.name}“ konnte nicht gelesen werden: ${(err as Error).message}`);
        }
      }
      deckClipBuffers.current.clear();

      // Bibliothek auffrischen: eindeutige IDs/Namen, verwaiste Clips absehbarmachen
      const library = normalizeLibrary(loadedClips, { bpm: firstBpmOf(project) });
      for (const droppedClip of library.dropped) {
        loadWarnings.push(`Clip „${droppedClip.name}“ ohne Audiodaten wurde übergangen: ${droppedClip.reason}`);
      }
      const first = loadedTracks.find((t) => t.id === project.activeTrackId) ?? loadedTracks[0];
      setProjectName(project.projectName);
      setTracks(loadedTracks);
      setActiveTrackId(first.id);
      setPaletteClips(library.clips);
      setSelectedClipId(library.clips[0]?.id ?? null);
      setWorkingPcm(trackPcm(first));
      setWorkingAudioBuffer(first.audioBuffer);
      setUndoStack([]);
      setRedoStack([]);
      setSelection(null);
      setClipboardsEmpty();
      setProjectPath(opened.source);
      setIsDirty(false);
      if (project.view) {
        setWaveformMode(project.view.waveformMode);
        setQuantize(project.view.quantize);
        setViewOffset(project.view.viewOffset);
        setViewDuration(project.view.viewDuration);
        setPaletteOpen(project.view.paletteOpen);
        setClipTempoMatch(project.view.clipTempoMatch !== false);
        setClipPitchFollow(project.view.clipPitchFollow === true);
        setClipDeckOpen(project.view.clipDeckOpen === true);
        setDeckLoop(null);
        setDeckLoopMark(null);
        setDeckPreviewFitted(false);
        setDeckTime(0);
        clipFitBuffers.current.clear();
      }
      setCurrentTime(0);
      audioEngine.stop();
      setIsPlaying(false);

      showOperationFeedback({
        title: 'Projekt geöffnet',
        operationType: 'IMPORT',
        description:
          `${loadedTracks.length} Spur(en), ${loadedClips.length} Clip(s) aus ${opened.source} geladen` +
          (loadWarnings.length > 0 ? `. Hinweise: ${loadWarnings.join(' ')}` : '.') +
          ' Keine Originaldatei wurde verändert.',
        originalSha256: first.originalSha256,
        timestamp: Date.now(),
      });
      logger.info('UI', `Projekt geöffnet: ${opened.source} (${loadedTracks.length} Spuren, ${loadedClips.length} Clips)`);
    } catch (err) {
      alert(`Projekt konnte nicht geöffnet werden: ${(err as Error).message}`);
      logger.error('UI', `Projektöffnung fehlgeschlagen: ${(err as Error).message}`);
    }
  };

  const setClipboardsEmpty = () => setClipboardBuffer(null);

  /** Deterministische Demospur – für Vorführungen und zum Prüfen des Workflows. */
  const handleLoadDemoTrack = async () => {
    const demo = generateDemoTrack({ bars: 8, bpm: 128, sampleRate: 44100 });
    const ctx = audioEngine.getContext();
    const buffer = pcmToAudioBuffer(ctx, demo.pcm);
    const id = `demo-${Date.now()}`;
    const beatGrid = buildBeatGridFromTempo(demo.firstBeat, demo.bpm, demo.duration, demo.meter, DataOrigin.GENERATED_FALLBACK);
    const track: TrackModel = {
      id,
      title: 'Demospur 128 BPM (selbst erzeugt)',
      artist: 'Airdox Editor',
      album: 'Nachweis-Workflow',
      bpm: demo.bpm,
      key: '1A',
      duration: Math.round(demo.duration * 1e6) / 1e6,
      sampleRate: demo.sampleRate,
      channels: demo.pcm.channels.length,
      originalSha256: audioEngine.computeBufferChecksum(buffer),
      isOriginalUntouched: true,
      audioBuffer: buffer,
      workingPcm: demo.pcm,
      beatGrid,
      cues: [
        {
          id: 'demo-cue-1',
          name: 'MEM 1',
          type: 'MEMORY',
          position: 0,
          inMsec: 0,
          cueIndex: 1,
          barNumber: 1,
          beatNumber: 1,
          color: '#ff2222',
          origin: DataOrigin.LOCAL_ANALYSIS,
        },
      ],
      loops: [],
      analysis: analyzePcm(demo.pcm, DataOrigin.LOCAL_ANALYSIS),
      origin: DataOrigin.GENERATED_FALLBACK,
      workingSegments: [
        {
          id: `demo-seg-${id}`,
          type: 'ORIGINAL',
          trackId: id,
          sourceStart: 0,
          sourceEnd: demo.duration,
          projectStart: 0,
          projectDuration: demo.duration,
          gain: 1,
        },
      ],
    };
    setTracks((prev) => [...prev, track]);
    setActiveTrackId(id);
    setWorkingPcm(demo.pcm);
    setWorkingAudioBuffer(buffer);
    setSelection(null);
    setCurrentTime(0);
    setViewOffset(0);
    setIsDirty(true);
    showOperationFeedback({
      title: 'Demospur geladen',
      operationType: 'IMPORT',
      description:
        '8 Takte, 128 BPM, 44,1 kHz, deterministisch erzeugt (kein Zufall). Jeder Takt hat ' +
        'einen eigenen Wiedererkennungston – damit lassen sich Schnitte inhaltlich nachprüfen.',
      originalSha256: track.originalSha256,
      timestamp: Date.now(),
    });
    logger.info('UI', 'Demospur geladen (eigene Berechnung, als Fallback gekennzeichnet)');
  };

  // Add Cue marker at position
  const handleAddCue = (pos: number) => {
    if (!activeTrack) return;
    pushHistorySnapshot('Add Cue');
    const newCue = {
      id: `cue-${Date.now()}`,
      name: `Cue ${activeTrack.cues.length + 1}`,
      type: 'MEMORY' as const,
      position: pos,
      color: '#ff2a2a',
      origin: DataOrigin.USER_EDIT,
    };
    activeTrack.cues.push(newCue);
    setTracks([...tracks]);
  };

  // Non-blocking async Rekordbox XML file loading
  const loadXmlFile = async (file: File) => {
    try {
      setImportProgressModalOpen(true);
      setImportProgress({
        phase: 'READING',
        phaseText: `Datei wird geladen: ${file.name}...`,
        percent: 0,
        processedTracks: 0,
        totalTracks: 0,
        memoryCuesFound: 0,
        hotCuesFound: 0,
        loopsFound: 0,
        logMessages: [`Datei wird geladen: ${file.name} (${(file.size / 1024).toFixed(1)} KB)...`],
      });

      const text = await file.text();

      const { tracks: parsedTracks } = await parseRekordboxXmlAsync(text, (prog) => {
        setImportProgress(prog);
      });

      // Convert parsed entries to complete TrackModel instances
      const fullTrackModels: TrackModel[] = parsedTracks.map((pt, idx) =>
        buildCollectionTrackModel(pt, idx, DataOrigin.REKORDBOX_XML)
      );

      setXmlImportedTracks(fullTrackModels);
      setXmlFileName(file.name);

      // The XML is a collection browser: never put an arbitrary first track in
      // the deck. The user explicitly selects the record whose metadata should
      // be used to build the active track view.
      // Auto-close progress modal after short delay, then open the collection.
      setTimeout(() => {
        setImportProgressModalOpen(false);
        if (fullTrackModels.length > 0) {
          setXmlCollectionModalOpen(true);
        }
      }, 1200);

    } catch (err: any) {
      console.error('Fehler beim Einlesen der Rekordbox XML-Datei:', err);
      setImportProgress({
        phase: 'ERROR',
        phaseText: `Fehler beim Import: ${err?.message || err}`,
        percent: 0,
        processedTracks: 0,
        totalTracks: 0,
        memoryCuesFound: 0,
        hotCuesFound: 0,
        loopsFound: 0,
        logMessages: [`Kritischer Fehler beim Parsen: ${err?.message || err}`],
      });
    }
  };

  const handleImportXmlFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadXmlFile(file);
    e.target.value = '';
  };

  // ANLZ belongs to the explicitly active XML track. It is read-only input and
  // takes priority over XML values only for analysis fields it actually holds.
  const handleImportAnlzData = async (data: ArrayBuffer, fileName: string) => {
    if (!activeTrack) return;

    try {
      const extraction = parseAnlzBinary(data);
      const enrichedTrack = applyAnlzExtractionToTrack(activeTrack, extraction);
      setTracks((previous) => previous.map((track) => (
        track.id === enrichedTrack.id ? enrichedTrack : track
      )));
      if (enrichedTrack.audioBuffer) {
        setWorkingAudioBuffer(enrichedTrack.audioBuffer);
        setWorkingPcm(enrichedTrack.workingPcm ?? pcmFromAudioBuffer(enrichedTrack.audioBuffer));
      }

      const tags = extraction.tagsFound.join(', ');
      showOperationFeedback({
        title: 'Rekordbox ANLZ-Analyse übernommen (Read-Only)',
        operationType: 'CUE',
        description: `${fileName}: ${extraction.cues.length} Cues, ${extraction.loops.length} Loops, ${extraction.phrases.length} PSSI-Phrasen, ${extraction.waveform?.length || 0} Waveform-Buckets und ${extraction.beatGrid ? extraction.beatGrid.beats.length : 0} Beat-Einträge übernommen.`,
        timeRangeSec: { start: 0, end: enrichedTrack.duration, duration: enrichedTrack.duration },
        originalSha256: enrichedTrack.originalSha256,
        timestamp: Date.now(),
      });
      console.info(`[ANLZ Import] ${fileName} → Tags: ${tags}`, extraction.warnings);
    } catch (error) {
      console.error('[ANLZ Import] Rekordbox-Analyse konnte nicht gelesen werden:', error);
    }
  };

  const handleImportAnlzFile = async (file: File) => {
    await handleImportAnlzData(await file.arrayBuffer(), file.name);
  };

  // Native Windows path: the bridge opens the analysis file strictly for
  // reading; the renderer never writes to the ANLZ source.
  const handleImportAnlzFromDesktop = async () => {
    if (!activeTrack || !window.rekordboxDesktop) return;
    try {
      const chosen = await window.rekordboxDesktop.chooseAnalysisFile();
      if (!chosen) return;
      const source = await window.rekordboxDesktop.readAnalysisFile(chosen.path);
      const fileName = chosen.path.split(/[\\/]/).pop() || 'ANLZ-Datei';
      await handleImportAnlzData(source.data, fileName);
    } catch (error) {
      console.error('[ANLZ Import] Windows-Lesepfad fehlgeschlagen:', error);
      alert(`ANLZ-Datei konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Rekordbox 6/7 database (master.db / OneLibrary exportLibrary.db).
  // The desktop bridge opens the SQLCipher library strictly for reading and
  // returns only rows; the renderer never touches the source file.
  const handleLoadRekordboxDatabase = async (dbPath: string, sourceLabel?: string) => {
    if (!window.rekordboxDesktop) return;
    const startedAt = Date.now();
    try {
      logger.info('DATABASE', `Lese Rekordbox-Datenbank nur lesend: ${sourceLabel || dbPath}`);
      const result = await window.rekordboxDesktop.readRekordboxDatabase(dbPath);
      if (!result.available || !result.rows) {
        throw new Error(result.reason || 'Die Rekordbox-Datenbank konnte nicht gelesen werden.');
      }
      logger.info(
        'DATABASE',
        `Datenbank gelesen in ${Date.now() - startedAt}ms (${result.dbType}, Leseverfahren: ${result.engine || 'unbekannt'}` +
          `${result.cipher ? `, ${result.cipher}` : ''}).`
      );

      const mapped = mapRekordboxDatabaseRows(
        {
          content: result.rows.content,
          cues: result.rows.cues,
          artists: result.rows.artists,
          albums: result.rows.albums,
          genres: result.rows.genres,
          keys: result.rows.keys,
          labels: result.rows.labels,
          playlists: result.rows.playlists,
          songPlaylists: result.rows.songPlaylists,
        },
        result.dbType === 'ONE_LIBRARY' ? 'ONE_LIBRARY' : 'MASTER_DB'
      );

      const fullTrackModels = mapped.tracks.map((track, idx) =>
        buildCollectionTrackModel(track, idx, DataOrigin.REKORDBOX_DB)
      );

      setXmlImportedTracks(fullTrackModels);
      setXmlFileName(sourceLabel || result.fileName || 'Rekordbox Datenbank');
      setXmlCollectionModalOpen(true);

      showOperationFeedback({
        title: 'Rekordbox-Datenbank importiert (Read-Only)',
        operationType: 'CUE',
        description: `${sourceLabel || result.fileName || dbPath}: ${mapped.stats.tracks} Tracks, ${mapped.stats.memoryCues} Memory Cues, ${mapped.stats.hotCues} Hot Cues, ${mapped.stats.loops} Loops aus der Datenbank übernommen. ` +
          `Leseverfahren: ${
            result.engine === 'JS_SQLCIPHER'
              ? `reines JavaScript (SQLCipher-Entschlüsselung + SQLite/WASM${result.cipher ? `, ${result.cipher}` : ''}, kein natives Modul nötig)`
              : 'native SQLCipher-Bindung'
          }.`,
        timeRangeSec: { start: 0, end: 0, duration: 0 },
        originalSha256: 'NOT_COMPUTED_READ_ONLY_SOURCE',
        timestamp: Date.now(),
      });

      const warnings = [...(mapped.warnings || []), ...(result.warnings || [])];
      if (warnings.length > 0) {
        console.warn('[Rekordbox DB] Hinweise:', warnings);
        warnings.forEach((warning) => logger.warn('DATABASE', warning));
      }
    } catch (error) {
      console.error('[Rekordbox DB] Import fehlgeschlagen:', error);
      logger.error(
        'DATABASE',
        `Rekordbox-Datenbank konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`,
        { dbPath }
      );
      alert(`Rekordbox-Datenbank konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleOpenRekordboxDatabase = async () => {
    if (!window.rekordboxDesktop) {
      alert('Der Datenbank-Import ist nur in der Windows-Desktop-App verfügbar.');
      return;
    }
    try {
      const chosen = await window.rekordboxDesktop.chooseRekordboxDatabase();
      if (!chosen) return;
      await handleLoadRekordboxDatabase(chosen.path);
    } catch (error) {
      console.error('[Rekordbox DB] Dateiauswahl fehlgeschlagen:', error);
    }
  };

  const handleLocateRekordboxDatabases = async () => {
    if (!window.rekordboxDesktop) return [];
    try {
      return await window.rekordboxDesktop.locateRekordboxDatabases();
    } catch (error) {
      console.warn('[Rekordbox DB] Automatische Suche fehlgeschlagen:', error);
      return [];
    }
  };

  // Ask the desktop bridge which reader is installed, so the UI can tell an
  // actually broken import apart from a missing optional native module.
  useEffect(() => {
    if (!window.rekordboxDesktop?.describeDatabaseEngines) return;
    let cancelled = false;
    window.rekordboxDesktop
      .describeDatabaseEngines()
      .then((engines) => {
        if (!cancelled) setDatabaseEngines(engines);
      })
      .catch((error) => console.warn('[Rekordbox DB] Leseverfahren nicht ermittelbar:', error));
    return () => {
      cancelled = true;
    };
  }, []);

  // Load a selected track from Rekordbox XML into the DJ Deck
  const handleSelectTrackFromXml = async (selectedDef: TrackModel) => {
    try {
      const audioCtx = audioEngine.getContext();
      let originalAudio = selectedDef.audioBuffer || null;
      let originalMedia = selectedDef.originalMedia;

      // The native bridge can resolve the XML Location and only ever opens the
      // original audio read-only. In a browser or when no Location exists, the
      // track remains a metadata/ANLZ-only project track instead of becoming a
      // fabricated synthetic audio track.
      if (!originalAudio && originalMedia?.location && window.rekordboxDesktop) {
        try {
          const source = await window.rekordboxDesktop.readOriginalAudio(originalMedia.location);
          originalAudio = await audioCtx.decodeAudioData(source.data);
          originalMedia = {
            ...originalMedia,
            resolvedPath: source.path,
            size: source.size,
            modifiedAt: source.modifiedAt,
            status: 'AVAILABLE',
          };
        } catch (error) {
          console.warn('[XML Location] Originalaudio konnte nur nicht gelesen werden; Rekordbox-Metadaten bleiben verfügbar.', error);
          originalMedia = { ...originalMedia, status: 'MISSING' };
        }
      }

      const duration = originalAudio?.duration || selectedDef.duration || 300.0;
      const analysis = selectedDef.analysis || (
        originalAudio ? analyzeAudioBuffer(originalAudio, DataOrigin.LOCAL_ANALYSIS) : null
      );
      const sha256 = originalAudio
        ? audioEngine.computeBufferChecksum(originalAudio)
        : 'NOT_COMPUTED_READ_ONLY_SOURCE';
      const phrases = selectedDef.phrases || [];

      const loadedTrack: TrackModel = {
        ...selectedDef,
        id: selectedDef.id || `track-${Date.now()}`,
        title: selectedDef.title || 'Rekordbox Track',
        artist: selectedDef.artist || 'Unknown Artist',
        album: selectedDef.album || 'Rekordbox Collection',
        bpm: selectedDef.bpm || 130.0,
        key: selectedDef.key || '2A',
        duration,
        sampleRate: originalAudio?.sampleRate || selectedDef.sampleRate || 44100,
        channels: originalAudio?.numberOfChannels || selectedDef.channels || 2,
        originalSha256: sha256,
        isOriginalUntouched: true,
        audioBuffer: originalAudio,
        // Collection entries intentionally retain only compact beatgrid
        // metadata. Expand it when this one track is actually loaded,
        // keeping the source origin (XML or Rekordbox DB).
        beatGrid: buildBeatGridFromTempo(
          selectedDef.beatGrid?.firstBeat ?? 0.0,
          selectedDef.beatGrid?.bpm ?? selectedDef.bpm ?? 130.0,
          duration,
          selectedDef.beatGrid?.meter ?? 4,
          selectedDef.origin ?? DataOrigin.REKORDBOX_XML
        ),
        cues: selectedDef.cues || [],
        loops: selectedDef.loops || [],
        analysis,
        phrases,
        originalMedia,
        origin: selectedDef.origin ?? DataOrigin.REKORDBOX_XML,
        workingSegments: [
          {
            id: `seg-${Date.now()}`,
            type: 'ORIGINAL',
            trackId: selectedDef.id || '1',
            sourceStart: 0,
            sourceEnd: duration,
            projectStart: 0,
            projectDuration: duration,
            gain: 1.0,
          },
        ],
      };

      setTracks((prev) => {
        const existingIdx = prev.findIndex((t) => t.id === loadedTrack.id);
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = loadedTrack;
          return updated;
        }
        return [loadedTrack, ...prev];
      });

      setActiveTrackId(loadedTrack.id);
      setWorkingAudioBuffer(originalAudio);
      setWorkingPcm(pcmFromAudioBuffer(originalAudio));
      setCurrentTime(0);
      setViewOffset(0);
      setIsPlaying(false);
      audioEngine.stop();
    } catch (err) {
      console.error('Fehler beim Laden des Tracks in das Deck:', err);
    }
  };

  // Audio file loading (WAV, MP3, FLAC, AIFF)
  const loadAudioFile = async (file: File) => {
    try {
      const arrayBuf = await file.arrayBuffer();
      const audioCtx = audioEngine.getContext();
      const decoded = await audioCtx.decodeAudioData(arrayBuf);
      const analysis = analyzeAudioBuffer(decoded, DataOrigin.LOCAL_ANALYSIS);
      const sha256 = audioEngine.computeBufferChecksum(decoded);

      const newTrack: TrackModel = {
        id: `track-${Date.now()}`,
        title: file.name.replace(/\.[^/.]+$/, ''),
        artist: 'User Import',
        album: 'Single',
        bpm: 130.0,
        key: '2A',
        duration: decoded.duration,
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        originalSha256: sha256,
        isOriginalUntouched: true,
        audioBuffer: decoded,
        beatGrid: buildBeatGridFromTempo(0.0, 130.0, decoded.duration),
        cues: [
          {
            id: `cue-${Date.now()}`,
            name: 'Cue 1',
            type: 'MEMORY',
            position: 0.0,
            color: '#ff2a2a',
            origin: DataOrigin.LOCAL_ANALYSIS,
          },
        ],
        loops: [],
        analysis,
        phrases: generateRekordboxPhrases(130.0, decoded.duration),
        origin: DataOrigin.LOCAL_ANALYSIS,
        workingSegments: [
          {
            id: `seg-${Date.now()}`,
            type: 'ORIGINAL',
            trackId: `track-${Date.now()}`,
            sourceStart: 0,
            sourceEnd: decoded.duration,
            projectStart: 0,
            projectDuration: decoded.duration,
            gain: 1.0,
          },
        ],
      };

      setTracks((prev) => [newTrack, ...prev]);
      setActiveTrackId(newTrack.id);
      setWorkingAudioBuffer(decoded);
      setWorkingPcm(pcmFromAudioBuffer(decoded));
      setCurrentTime(0);
      setViewOffset(0);
      setIsPlaying(false);
      audioEngine.stop();

      showOperationFeedback({
        title: 'Audiodatei importiert',
        operationType: 'CUE',
        description: `Track "${newTrack.title}" erfolgreich decodiert (${decoded.duration.toFixed(2)}s, ${decoded.sampleRate}Hz, ${decoded.numberOfChannels} Kanäle). Originalschutz aktiv (SHA-256: ${sha256.slice(0, 12)}...).`,
        timeRangeSec: { start: 0, end: decoded.duration, duration: decoded.duration },
        originalSha256: sha256,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('Fehler beim Decodieren der Audiodatei:', err);
      alert('Konnte Audiodatei nicht decodieren. Bitte überprüfe das Dateiformat (WAV, MP3, AIFF, FLAC).');
    }
  };

  const handleImportAudioFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadAudioFile(file);
    e.target.value = '';
  };

  // Drag & drop file handler (accepts Rekordbox XML and audio files)
  const handleDropFile = (file: File) => {
    const nameLower = file.name.toLowerCase();
    if (nameLower.endsWith('.xml')) {
      loadXmlFile(file);
    } else if (
      nameLower.endsWith('.mp3') ||
      nameLower.endsWith('.wav') ||
      nameLower.endsWith('.aiff') ||
      nameLower.endsWith('.aif') ||
      nameLower.endsWith('.flac') ||
      nameLower.endsWith('.m4a') ||
      nameLower.endsWith('.ogg') ||
      file.type.startsWith('audio/')
    ) {
      loadAudioFile(file);
    } else {
      alert(`Dateityp "${file.name}" wird nicht unterstützt. Bitte Rekordbox XML (.xml) oder Audio (.wav, .mp3, .flac) verwenden.`);
    }
  };

  // Global keyboard shortcuts (Space=Play, Ctrl+Z=Undo, Ctrl+Y=Redo, Ctrl+C=Copy, Ctrl+V=Paste, Esc=Cancel)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'Escape') {
        setSelection(null);
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
        e.preventDefault();
        handleRedo();
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
        e.preventDefault();
        void handleSaveProject(e.shiftKey);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyO') {
        e.preventDefault();
        void handleOpenProject();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyX') {
        e.preventDefault();
        handleUnloadDeckClip();
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyJ') {
        e.preventDefault();
        handleCopySelectionToEnd();
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyM') {
        e.preventDefault();
        handleMoveSelectionToStart();
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') {
        e.preventDefault();
        handleCopy();
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
        e.preventDefault();
        handlePaste();
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        if (selection) {
          e.preventDefault();
          handleDelete();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <div className="w-screen h-screen bg-[#0a0b0d] flex flex-col overflow-hidden select-none text-neutral-200">
      {/* Hidden file pickers */}
      <input
        ref={xmlFileInputRef}
        type="file"
        accept=".xml"
        onChange={handleImportXmlFile}
        className="hidden"
      />
      <input
        ref={audioFileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.aiff"
        onChange={handleImportAudioFile}
        className="hidden"
      />

      {/* 1. Top Windows-style Titlebar */}
      <TitleBar />

      {/* 2. Menu bar (Datei, Bearbeiten, Betrachten, Hilfe) */}
      <MenuBar
        onNewProject={() => {
          setProjectName('New Project');
          setSelection(null);
          setProjectPath(null);
          setIsDirty(false);
        }}
        onImportXml={() => xmlFileInputRef.current?.click()}
        onImportAudio={() => audioFileInputRef.current?.click()}
        onExportWav={() => setExportModalOpen(true)}
        onExportXml={() => setExportModalOpen(true)}
        onSaveProject={() => void handleSaveProject(false)}
        onSaveProjectAs={() => void handleSaveProject(true)}
        onOpenProject={() => void handleOpenProject()}
        onExportClips={() => void handleExportPaletteClips()}
        onLoadDemoTrack={() => void handleLoadDemoTrack()}
        projectPath={projectPath}
        isDirty={isDirty}
        canSaveProject={tracks.length > 0}
        hasSelection={selection !== null && selection.duration > 0}
        onCopySelectionToEnd={handleCopySelectionToEnd}
        onMoveSelectionToStart={handleMoveSelectionToStart}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        waveformMode={waveformMode}
        onSetWaveformMode={setWaveformMode}
        paletteOpen={paletteOpen}
        onTogglePalette={() => setPaletteOpen(!paletteOpen)}
        browserOpen={browserOpen}
        onToggleBrowser={() => setBrowserOpen(!browserOpen)}
        onShowInfo={() => setInfoModalOpen(true)}
        onOpenDatabaseInspector={() => setDbExtractionModalOpen(true)}
        onOpenXmlCollection={() => setXmlCollectionModalOpen(true)}
        onOpenSystemLogs={() => setSystemLogModalOpen(true)}
      />

      {/* 3. EDIT Mode Toolbar / Transport */}
      <EditModeBar
        projectName={projectName}
        isPlaying={isPlaying}
        onTogglePlay={handleTogglePlay}
        onReturnToStart={handleReturnToStart}
        loopActive={loopActive}
        onToggleLoop={() => setLoopActive(!loopActive)}
        quantizeActive={quantize}
        onToggleQuantize={() => setQuantize(!quantize)}
        onNewProject={() => {
          setProjectName('New Project');
          setTracks([]);
          setActiveTrackId('');
          setPaletteClips([]);
          setSelectedClipId(null);
          setWorkingPcm(null);
          setWorkingAudioBuffer(null);
          setUndoStack([]);
          setRedoStack([]);
          setProjectPath(null);
          setIsDirty(false);
          setSelection(null);
          logger.info('UI', 'Neues Projekt: Arbeitsdaten geleert, geladene Originale bleiben unangetastet.');
        }}
        onSaveProject={() => void handleSaveProject(false)}
        onOpenProject={() => void handleOpenProject()}
        projectPath={projectPath}
        isDirty={isDirty}
        onExport={() => setExportModalOpen(true)}
        onShowInfo={() => setInfoModalOpen(true)}
        masterVolume={masterVolume}
        onMasterVolumeChange={handleMasterVolumeChange}
        meterL={meterL}
        meterR={meterR}
      />

      {/* 4. Track Header & Overview Waveform (Authentic Pioneer DJ Header) */}
      <TrackHeader
        track={activeTrack}
        currentTime={currentTime}
        viewOffset={viewOffset}
        viewDuration={viewDuration}
        onSeek={handleSeek}
        onPanView={handlePanView}
        mode={waveformMode}
      />

      {/* 5. Main Middle Working Area: Detail Waveform (Full-width or with Palette) */}
      <div className="flex-1 flex overflow-hidden relative">
        <DetailWaveform
          track={activeTrack}
          currentTime={currentTime}
          viewOffset={viewOffset}
          viewDuration={viewDuration}
          waveformMode={waveformMode}
          selection={selection}
          quantize={quantize}
          onSeek={handleSeek}
          onSelect={setSelection}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onResetZoom={handleResetZoom}
          onPanView={handlePanView}
          onAddToPalette={handleAddSelectionToPalette}
          onCopy={handleCopy}
          onCut={handleCut}
          onPaste={handlePaste}
          onInsert={handleInsert}
          onReplace={handleReplace}
          onOverdub={handleOverdub}
          onDelete={handleDelete}
          onClear={handleClear}
          onAddCue={handleAddCue}
          onPrevMemoryCue={handlePrevMemoryCue}
          onNextMemoryCue={handleNextMemoryCue}
          onAddMemoryCue={handleAddMemoryCue}
          onOpenDatabaseInspector={() => setDbExtractionModalOpen(true)}
          onImportXmlClick={() => xmlFileInputRef.current?.click()}
          onLoadAudioClick={() => audioFileInputRef.current?.click()}
          onDropFile={handleDropFile}
          onDropClip={handleDropClip}
        />

        {/* Palette Panel (Screenshot 01 vs Screenshot 02) */}
        <PalettePanel
          isOpen={paletteOpen}
          onToggle={() => setPaletteOpen(!paletteOpen)}
          clips={paletteClips}
          onAddFromSelection={handleAddSelectionToPalette}
          onSelectClip={(clip) => setSelectedClipId(clip.id)}
          selectedClipId={selectedClipId}
          hasSelection={selection !== null && selection.duration > 0}
          libraryLabel={CLIP_LIBRARY_LABEL}
          deckClipId={deckClipId}
          onLoadIntoDeck={handleLoadClipIntoDeck}
          onInsertAtPlayhead={(id) => handleInsertClipFromLibrary(id, 'insert')}
          onRenameClip={handleRenameClip}
          onApplyClipAt={(id, mode) => handleInsertClipFromLibrary(id, mode)}
          onExportClip={(id) => void handleExportClip(id)}
          onUnloadFromDeck={handleUnloadDeckClip}
          onDuplicateClip={handleDuplicateClip}
          onMoveClip={handleMoveClip}
          onDeleteClip={handleDeleteClip}
          tempoMatch={clipTempoMatch}
          pitchFollow={clipPitchFollow}
          targetBpm={activeTrack?.beatGrid?.bpm ?? 0}
          targetTrackName={activeTrack?.title ?? null}
          deckViewOpen={clipDeckOpen}
          onToggleDeckView={() => setClipDeckOpen((value) => !value)}
          deck={
            deckClip
              ? {
                  clipId: deckClip.id,
                  clipName: deckClip.name,
                  clipBpm: deckClip.bpm,
                  position: deckTime,
                  duration: deckBufferFor(deckClip)?.duration ?? deckClip.duration,
                  isPlaying,
                  loopActive,
                  loop: deckLoop,
                  loopMark: deckLoopMark,
                  previewFitted: deckPreviewFitted,
                  fitSpeed: clipTempoMatch && (activeTrack?.beatGrid?.bpm ?? 0) > 0 && deckClip.bpm > 0 ? (activeTrack!.beatGrid.bpm / deckClip.bpm) : 1,
                  peaks: deckClip.miniPeaks ?? [],
                  level: describeClipFit(deckClip, activeTrack?.beatGrid?.bpm ?? 0, {
                    tempoMatch: clipTempoMatch,
                    pitchFollowsTempo: clipPitchFollow,
                  }),
                }
              : null
          }
          onDeckCommand={handleClipDeckCommand}
        />
      </div>

      {/* 6. Lower Action Block: BEAT SELECT | SELECT | EDIT (Screenshots 01, 02, 03) */}
      <BottomControlBlock
        selection={selection}
        deckClip={
          deckClip
            ? {
                id: deckClip.id,
                name: deckClip.name,
                duration: clipAudioOf(deckClip) ? pcmDuration(clipAudioOf(deckClip)!) : deckClip.duration,
                position: deckTime,
              }
            : null
        }
        onDropClipIntoDeck={handleLoadClipIntoDeck}
        onUnloadDeckClip={handleUnloadDeckClip}
        onBeatSelect={handleBeatSelect}
        onHalfSelection={handleHalfSelection}
        onDoubleSelection={handleDoubleSelection}
        onCancelSelection={handleCancelSelection}
        onClone={handleAddSelectionToPalette}
        onCopy={handleCopy}
        onPaste={handlePaste}
        onInsert={handleInsert}
        onReplace={handleReplace}
        onOverdub={handleOverdub}
        onDelete={handleDelete}
        onClear={handleClear}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        hasClipboard={clipboardBuffer !== null}
      />

      {/* 7. Bottom Strip: BROWSER tab, Pioneer Rekordbox branding & Track Collection */}
      <BrowserMultiTrackBar
        isOpen={browserOpen}
        onToggle={() => setBrowserOpen(!browserOpen)}
        tracks={tracks}
        activeTrackId={activeTrackId}
        onSelectTrack={(id) => {
          setActiveTrackId(id);
          // Ein Clip im Spieler gehört zur vorigen Spur – nicht mitnehmen.
          if (deckClipId) {
            audioEngine.stop();
            setIsPlaying(false);
            setDeckClipId(null);
            setDeckTime(0);
          }
          const t = tracks.find((tr) => tr.id === id);
          if (t && t.audioBuffer) {
            setWorkingAudioBuffer(t.audioBuffer);
            setWorkingPcm(t.workingPcm ?? pcmFromAudioBuffer(t.audioBuffer));
            setCurrentTime(0);
            setViewOffset(0);
            setIsPlaying(false);
            audioEngine.stop();
          }
        }}
        onImportXml={() => xmlFileInputRef.current?.click()}
        onImportAudio={() => audioFileInputRef.current?.click()}
        onOpenXmlCollection={() => setXmlCollectionModalOpen(true)}
      />

      {/* Modals */}
      {activeTrack && (
        <>
          <ProjectInfoModal
            isOpen={infoModalOpen}
            onClose={() => setInfoModalOpen(false)}
            track={activeTrack}
          />
          <ExportModal
            isOpen={exportModalOpen}
            onClose={() => setExportModalOpen(false)}
            track={activeTrack}
            workingAudioBuffer={workingAudioBuffer}
            onExportComplete={showOperationFeedback}
          />
          <DatabaseExtractionModal
            isOpen={dbExtractionModalOpen}
            onClose={() => setDbExtractionModalOpen(false)}
            activeTrack={activeTrack}
            track={activeTrack}
            onApplyTrack={handleApplyExtractedTrack}
            onImportAnlzFile={handleImportAnlzFile}
            onImportAnlzFromDesktop={handleImportAnlzFromDesktop}
            onImportXmlFile={loadXmlFile}
            onOpenRekordboxDatabase={handleOpenRekordboxDatabase}
            onLocateRekordboxDatabases={handleLocateRekordboxDatabases}
            onLoadRekordboxDatabase={handleLoadRekordboxDatabase}
            databaseEngines={databaseEngines}
          />
        </>
      )}

      {/* Rekordbox XML Track-Auswahl Modal with Search Bar */}
      <RekordboxXmlImportModal
        isOpen={xmlCollectionModalOpen}
        onClose={() => setXmlCollectionModalOpen(false)}
        xmlTracks={xmlImportedTracks}
        fileName={xmlFileName}
        onSelectTrack={handleSelectTrackFromXml}
        currentTrackId={activeTrackId}
      />

      {/* Real-time Non-blocking Import Telemetry Progress Modal */}
      <ImportProgressModal
        isOpen={importProgressModalOpen}
        progress={importProgress}
        onClose={() => setImportProgressModalOpen(false)}
        onOpenCollection={() => {
          setImportProgressModalOpen(false);
          setXmlCollectionModalOpen(true);
        }}
      />

      {/* Real-time Operation Feedback Modal (Insert, Replace, Delete, etc.) */}
      <OperationFeedbackModal
        isOpen={feedbackModalOpen}
        onClose={() => setFeedbackModalOpen(false)}
        telemetry={feedbackTelemetry}
      />

      {/* System-Protokoll Modal (Hilfe → System-Protokoll...) */}
      <SystemLogModal
        isOpen={systemLogModalOpen}
        onClose={() => setSystemLogModalOpen(false)}
      />
    </div>
  );
}
