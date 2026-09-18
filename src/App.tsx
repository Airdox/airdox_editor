/**
 * @license
 * Rekordbox DJ Audio Editor - Master Application
 * Authoritative Visual Lock implementation matching screenshots 01, 02, and 03.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
  WaveformAnalysisData,
} from './types/rekordbox';
import { mapRekordboxDatabaseRows } from './rekordbox/dbParser';
import {
  buildDbAnalysisIndex,
  dirOfPath,
  normalizeAudioKey,
  resolveAnalysisFilePath,
  DbAnalysisRef,
  deriveSiblingExtension,
} from './rekordbox/analysisResolver';
import { runMasterDbGate, TrackRequestGuard } from './rekordbox/masterDbPipeline';
import { buildDeckTrackAfterGate } from './rekordbox/deckTrackPipeline';
import { generateAnalysisFromMetadata } from './waveform/metadataAnalysis';
import { generateElectronicDjTrack } from './audio/synthesizerTrack';
import { analyzeAudioBuffer, extractMiniPeaks, extractMiniPeaksFromAnalysis, estimateBpm } from './waveform/analyzer';
import { selectTrackWaveform } from './waveform/renderModel';
import {
  DeckWaveformSource,
  describeDeckWaveformSource,
  resolveDeckWaveform,
} from './waveform/deckWaveformSource';
import { initFileLogging } from './utils/fileLog';
import { audioEngine } from './audio/audioEngine';
import { FileAudio, ShieldCheck } from 'lucide-react';
import {
  parseRekordboxXml,
  parseRekordboxXmlAsync,
  XmlImportProgress,
  DEFAULT_REKORDBOX_XML,
  buildBeatGridFromTempo,
} from './rekordbox/xmlParser';
import {
  applyAnlzExtractionToTrack,
  generateRekordboxPhrases,
  mergeAnlzExtractions,
  parseAnlzBinary,
} from './rekordbox/databaseExtractor';
import { ensureArrayBuffer, isRekordboxOrigin, ppthMismatchNote } from './rekordbox/trackGuards';
import {
  serializeProject,
  deserializeProject,
  base64ToBytes,
  SerializedTrack,
} from './rekordbox/projectFile';

import { TitleBar } from './components/TitleBar';
import { MenuBar } from './components/MenuBar';
import { EditModeBar } from './components/EditModeBar';
import { TrackHeader } from './components/TrackHeader';
import { DetailWaveform } from './components/DetailWaveform';
import { PalettePanel } from './components/PalettePanel';
import { ClipDeckView } from './components/ClipDeckView';
import { BottomControlBlock } from './components/BottomControlBlock';
import { BrowserMultiTrackBar } from './components/BrowserMultiTrackBar';
import { ProjectInfoModal } from './components/Modals/ProjectInfoModal';
import { ExportModal } from './components/Modals/ExportModal';
import { DatabaseExtractionModal } from './components/Modals/DatabaseExtractionModal';
import { RekordboxXmlImportModal } from './components/Modals/RekordboxXmlImportModal';
import { ImportProgressModal } from './components/Modals/ImportProgressModal';
import { OperationFeedbackModal, OperationTelemetry } from './components/Modals/OperationFeedbackModal';
import { SystemLogModal } from './components/Modals/SystemLogModal';
import { WorkspaceSettingsModal } from './components/Modals/WorkspaceSettingsModal';
import { ClearHistoryModal } from './components/Modals/ClearHistoryModal';
import { EditAssistantModal } from './components/Modals/EditAssistantModal';
import { editAssistant } from './audio/editAssistant';
import { useEditAssistant } from './hooks/useEditAssistant';
import { logger } from './utils/logger';
import { ChatbotPalette } from './components/ChatbotPalette';
import { ChatbotAction, TrackEditorContext } from './types/chatbot';
import { analyzeTrackForMixIn, generateAutoCuesForTrack } from './audio/mixAnalysis';
import {
  cloneAudioBuffer,
  executeCopy,
  executeCut,
  executeDelete,
  executeClear,
  executeInsert,
  executePaste,
  executeReplace,
  executeOverdub,
  applyExecutionToTrack,
} from './audio/editingEngine';

/**
 * Extracts the genuine source waveform slice for a palette clip: the ANLZ
 * columns of the selected range (aggregated by slicing, never synthesized),
 * taken from the zoom-appropriate variant of the source track. Clips cut
 * from tracks without any waveform carry no waveform payload — the palette
 * then shows its honest placeholder instead of an invented contour.
 */
function extractPaletteWaveform(
  track: TrackModel,
  start: number,
  end: number
): WaveformAnalysisData | undefined {
  const source = selectTrackWaveform(track, Math.max(0.001, end - start), 48);
  if (!source || source.length === 0) return undefined;
  const duration = Math.max(0.001, track.duration);
  const lo = Math.max(0, Math.floor((Math.max(0, start) / duration) * source.length));
  const hi = Math.min(source.length, Math.max(lo + 1, Math.ceil((Math.min(duration, end) / duration) * source.length)));
  const slice = (values: Float32Array) => values.slice(lo, hi);
  return {
    length: hi - lo,
    peaks: slice(source.peaks),
    peaksL: slice(source.peaksL),
    peaksR: slice(source.peaksR),
    lowEnergy: slice(source.lowEnergy),
    midEnergy: slice(source.midEnergy),
    highEnergy: slice(source.highEnergy),
    origin: source.origin,
    sourceTag: source.sourceTag,
    secPerBucket: source.secPerBucket,
    samplesPerBucket: source.samplesPerBucket,
  };
}

/**
 * Resolves the ANLZ analysis file referenced by a Rekordbox track
 * (AnalysisDataPath — from the database row or from the PPTH scan) and merges
 * it into the track. Returns the track unchanged when no path is present or
 * the file cannot be read. Read-only, never throws.
 */
async function tryAutoLoadAnlz(track: TrackModel): Promise<TrackModel> {
  const anlzPath = track.rawXmlAttributes?.analysisDataPath?.trim();
  if (!anlzPath || !window.rekordboxDesktop) return track;
  // Deterministic resolution only: <dbDir>/share/PIONEER/USBANLZ/... or a
  // verbatim absolute path (the PPTH scan always yields an absolute path).
  const resolved = resolveAnalysisFilePath(track.rawXmlAttributes?.sourceDbDir, anlzPath);
  if (!resolved) {
    console.info(`[ANLZ Auto] Keine deterministische Auflösung für AnalysisDataPath (${anlzPath}); manuelle ANLZ-Zuordnung erforderlich.`);
    return track;
  }
  try {
    const source = await window.rekordboxDesktop.readAnalysisFile(resolved);
    let extraction = parseAnlzBinary(ensureArrayBuffer(source.data as ArrayBuffer | Uint8Array));
    // Rekordbox splits every analysis across sibling containers: the resolved
    // file (usually ANLZnnnn.DAT) plus ANLZnnnn.EXT in the same folder. The
    // EXT carries the full-resolution color waveform (PWV5), PSSI phrases and
    // PCO2 colored cues — without it the deck can only show the low-res
    // preview. Deterministic sibling, read-only; a missing sibling means
    // fewer variants, never an error.
    const sibling =
      deriveSiblingExtension(resolved, 'EXT') ?? deriveSiblingExtension(resolved, 'DAT');
    if (sibling) {
      try {
        const extSource = await window.rekordboxDesktop.readAnalysisFile(sibling);
        const extExtraction = parseAnlzBinary(ensureArrayBuffer(extSource.data as ArrayBuffer | Uint8Array));
        // Positional merge: primary is always the DAT side (PQTZ authority),
        // secondary the EXT side (PCO2/PSSI priority) — independent of which
        // file the AnalysisDataPath resolved to first.
        extraction = /\.ext$/i.test(sibling)
          ? mergeAnlzExtractions(extraction, extExtraction)
          : mergeAnlzExtractions(extExtraction, extraction);
        console.info(`[ANLZ Auto] +Schwesterdatei ${sibling} → ${extExtraction.tagsFound.join(', ')}`);
      } catch {
        console.info(`[ANLZ Auto] Keine Schwesterdatei (${sibling}); Farb-Waveform (PWV5)/Phrasen (PSSI) ggf. nicht verfügbar.`);
      }
    }
    const merged = applyAnlzExtractionToTrack(track, extraction);
    // Plausibility guard: the PPTH source path should reference the same audio file.
    const expected = track.originalMedia?.resolvedPath || track.originalMedia?.location || '';
    const ppthNote = ppthMismatchNote(extraction.analysisPath, expected);
    if (ppthNote) {
      console.warn(`[ANLZ Auto] ${ppthNote}`);
      logger.warn('DATABASE', `[ANLZ Auto] ${ppthNote}`, { analysisPath: extraction.analysisPath, expected });
      if (merged.databaseRecord) {
        merged.databaseRecord.anlzWarnings = [...(merged.databaseRecord.anlzWarnings ?? []), ppthNote];
      }
    }
    console.info(`[ANLZ Auto] ${resolved} → ${extraction.tagsFound.join(', ')}`);
    logger.info('DATABASE', `[ANLZ Auto] ${resolved} → ${extraction.tagsFound.join(', ')}`, {
      buckets: extraction.waveform?.length ?? 0,
      variants: extraction.waveformVariants?.length ?? 0,
    });
    return merged;
  } catch (error) {
    console.warn(`[ANLZ Auto] ANLZ-Datei nicht lesbar (${resolved}); Track bleibt ohne ANLZ-Daten.`, error);
    return track;
  }
}

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

/** Decodes embedded base64 WAV bytes back into an AudioBuffer. */
async function decodeWavBase64(audioCtx: AudioContext, base64?: string): Promise<AudioBuffer | undefined> {
  if (!base64) return undefined;
  const bytes = base64ToBytes(base64);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return audioCtx.decodeAudioData(ab);
}

/**
 * Rebuilds a persisted project track into a playable TrackModel. The original
 * audio is NOT duplicated here for Rekordbox-sourced tracks (it is re-opened
 * from its read-only path); embedded clip/original audio is decoded on demand.
 */
async function rebuildTrackFromSerialized(
  st: SerializedTrack,
  audioCtx: AudioContext
): Promise<TrackModel> {
  const segments: EditSegment[] = [];
  for (const seg of st.workingSegments) {
    const clipBuffer = await decodeWavBase64(audioCtx, seg.clipWavBase64);
    segments.push({
      id: seg.id,
      type: seg.type,
      trackId: seg.trackId,
      sourceStart: seg.sourceStart,
      sourceEnd: seg.sourceEnd,
      projectStart: seg.projectStart,
      projectDuration: seg.projectDuration,
      clipId: seg.clipId,
      clipBuffer,
      gain: seg.gain,
    });
  }

  const embeddedOriginal = st.originalAudioBase64
    ? await decodeWavBase64(audioCtx, st.originalAudioBase64)
    : undefined;

  return {
    id: st.id,
    title: st.title,
    artist: st.artist,
    album: st.album,
    genre: st.genre,
    label: st.label,
    rating: st.rating,
    playCount: st.playCount,
    year: st.year,
    comments: st.comments,
    dateAdded: st.dateAdded,
    remixer: st.remixer,
    isrc: st.isrc,
    bpm: st.bpm,
    key: st.key,
    duration: st.duration,
    sampleRate: st.sampleRate,
    channels: st.channels,
    originalSha256: st.originalSha256,
    isOriginalUntouched: st.isOriginalUntouched,
    audioBuffer: embeddedOriginal ?? null,
    beatGrid: buildBeatGridFromTempo(
      st.beatGrid.firstBeat,
      st.beatGrid.bpm,
      st.duration,
      st.beatGrid.meter,
      st.origin
    ),
    cues: st.cues,
    loops: st.loops,
    analysis: null,
    origin: st.origin,
    phrases: st.phrases,
    rawXmlAttributes: st.rawXmlAttributes,
    originalMedia: st.originalMedia,
    workingSegments: segments,
  };
}

export default function App() {  // Project state - Stringent Empty Project (Master Prompt & Voice Directive)
  const [projectName, setProjectName] = useState<string>('New Project');
  const [tracks, setTracks] = useState<TrackModel[]>([]);
  const [activeTrackId, setActiveTrackId] = useState<string>('');
  const [workingAudioBuffer, setWorkingAudioBuffer] = useState<AudioBuffer | null>(null);

  // Viewport & Timeline state
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [viewOffset, setViewOffset] = useState<number>(0); // detail start in seconds
  const [viewDuration, setViewDuration] = useState<number>(18.0); // zoom window in seconds (default ~9-10 bars @ 130bpm)
  const [waveformMode, setWaveformMode] = useState<WaveformMode>('RGB');
  const [quantize, setQuantize] = useState<boolean>(true);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isSeparating, setIsSeparating] = useState<boolean>(false);
  const [loopActive, setLoopActive] = useState<boolean>(false);
  const [masterVolume, setMasterVolume] = useState<number>(0.9);
  const [meterL, setMeterL] = useState<number>(0);
  const [meterR, setMeterR] = useState<number>(0);
  const [stemVolumes, setStemVolumes] = useState<number[]>([]);
  // Stem identity, parallel to stemVolumes/stemBuffers. Labels come from here,
  // never from the index, so "VOCAL" is always actually the vocals stem.
  const [stemIds, setStemIds] = useState<string[]>([]);
  const [stemJobId, setStemJobId] = useState<string | null>(null);
  const [stemProgress, setStemProgress] = useState<number | null>(null);
  const [stemStatus, setStemStatus] = useState<{ kind: 'idle' | 'running' | 'done' | 'error'; message: string }>({ kind: 'idle', message: '' });

  // Selection state - Starts with null (Clean Empty Project)
  const [selection, setSelection] = useState<SelectionRange | null>(null);

  // Palette state - Starts completely empty
  const [paletteOpen, setPaletteOpen] = useState<boolean>(true); // Screenshot 01 (open) vs Screenshot 02 (closed)
  const [editPaletteOpen, setEditPaletteOpen] = useState<boolean>(true); // Collapsible lower Edit Palette (BEAT SELECT / SELECT / EDIT)
  const [paletteClips, setPaletteClips] = useState<PaletteClip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [paletteViewMode, setPaletteViewMode] = useState<'SIDEBAR' | 'FULL_DECK'>('SIDEBAR');
  const [matchPitchOnInsert, setMatchPitchOnInsert] = useState<boolean>(true);

  // Browser bar
  const [browserOpen, setBrowserOpen] = useState<boolean>(false);

  // Maximize Waveform Zen Mode (collapses both palettes for max screen editing area)
  const isMaxWaveform = !editPaletteOpen && !paletteOpen && !browserOpen;
  const handleToggleMaxWaveform = useCallback(() => {
    if (isMaxWaveform) {
      setEditPaletteOpen(true);
      setPaletteOpen(true);
    } else {
      setEditPaletteOpen(false);
      setPaletteOpen(false);
      setBrowserOpen(false);
    }
  }, [isMaxWaveform]);

  // Clipboard for Copy / Paste / Insert
  const [clipboardBuffer, setClipboardBuffer] = useState<AudioBuffer | null>(null);

  // History Stack for Undo / Redo
  const [undoStack, setUndoStack] = useState<EditHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<EditHistoryEntry[]>([]);

  // Modals
  const [infoModalOpen, setInfoModalOpen] = useState<boolean>(false);
  const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);
  const [dbExtractionModalOpen, setDbExtractionModalOpen] = useState<boolean>(false);
  const [xmlCollectionModalOpen, setXmlCollectionModalOpen] = useState<boolean>(false);
  const [xmlImportedTracks, setXmlImportedTracks] = useState<TrackModel[]>([]);
  const [xmlFileName, setXmlFileName] = useState<string>('rekordbox_collection.xml');
  // Pfad der zuletzt geöffneten Rekordbox Master Database (Pipeline-Gate).
  const [masterDbPath, setMasterDbPath] = useState<string | null>(null);
  // Request-Guard: verhindert, dass ein spät eintreffendes Ergebnis eines
  // früheren Tracks die Waveform des inzwischen gewählten Tracks überschreibt.
  const trackRequestGuard = useRef(new TrackRequestGuard());

  // Real-time Transparency Modals (Non-blocking parser & operation feedback)
  const [importProgress, setImportProgress] = useState<XmlImportProgress | null>(null);
  const [importProgressModalOpen, setImportProgressModalOpen] = useState<boolean>(false);
  const [feedbackTelemetry, setFeedbackTelemetry] = useState<OperationTelemetry | null>(null);
  const [feedbackModalOpen, setFeedbackModalOpen] = useState<boolean>(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [highQualityRendering, setHighQualityRendering] = useState<boolean>(true);
  const [snapToBeatgrid, setSnapToBeatgrid] = useState<boolean>(true);
  const [systemLogModalOpen, setSystemLogModalOpen] = useState<boolean>(false);
  const [clearHistoryModalOpen, setClearHistoryModalOpen] = useState<boolean>(false);
  const [editAssistantModalOpen, setEditAssistantModalOpen] = useState<boolean>(false);
  const [isGlobalDragging, setIsGlobalDragging] = useState<boolean>(false);
  const dragCounterRef = useRef<number>(0);

  // Edit Assistant State Manager (protects selection buffer & clipboard integrity)
  const { state: editAssistantState, summary: editAssistantSummary } = useEditAssistant(
    workingAudioBuffer,
    selection,
    clipboardBuffer
  );

  const showOperationFeedback = useCallback((telemetry: OperationTelemetry) => {
    setFeedbackTelemetry(telemetry);
    setFeedbackModalOpen(true);
  }, []);

  // Original source paths that the export/save bridge must never overwrite.
  const protectedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const t of tracks) {
      const location = t.originalMedia?.location;
      const resolved = t.originalMedia?.resolvedPath;
      if (location) set.add(location);
      if (resolved) set.add(resolved);
    }
    return Array.from(set);
  }, [tracks]);

  // Hidden file inputs
  const xmlFileInputRef = useRef<HTMLInputElement>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);

  // Active track helper (supports empty state)
  const activeTrack = tracks.find((t) => t.id === activeTrackId) || tracks[0] || null;

  // ---- Automatische Rekordbox-ANLZ-Zuordnung (Waveform ohne manuellen Klick) ----
  // Audio-Pfad → AnalysisDataPath aus einer lokal gefundenen Rekordbox-DB.
  const dbAnalysisIndexRef = useRef<Map<string, DbAnalysisRef>>(new Map());
  const dbAutoLoadAttemptedRef = useRef<boolean>(false);
  // Audio-Pfad → ANLZ-Container aus dem PPTH-Header-Scan (SQLCipher-frei).
  const anlzPpthIndexRef = useRef<
    Map<string, { datPath: string | null; extPath: string | null; matchTier: 1 | 2; note?: string | null }>
  >(new Map());
  const anlzPpthScanStateRef = useRef<'IDLE' | 'RUNNING' | 'DONE'>('IDLE');
  const anlzPpthMissedKeysRef = useRef<Set<string>>(new Set());
  const anlzPpthScanPromiseRef = useRef<Promise<void> | null>(null);
  const anlzPpthScanInfoRef = useRef<{ scanned: number; folders: number; elapsedMs: number } | null>(null);

  /**
   * Baut den Audio-Pfad→AnalysisDataPath-Index aus allen automatisch
   * auffindbaren Rekordbox-Datenbanken (master.db / exportLibrary.db).
   * Einmalig pro Session; Fehler werden protokolliert, nie geworfen.
   */
  const ensureDbAnalysisIndex = useCallback(async () => {
    if (dbAnalysisIndexRef.current.size > 0) return dbAnalysisIndexRef.current;
    if (dbAutoLoadAttemptedRef.current) return dbAnalysisIndexRef.current;
    if (!window.rekordboxDesktop) return dbAnalysisIndexRef.current;
    dbAutoLoadAttemptedRef.current = true;
    try {
      const candidates = await window.rekordboxDesktop.locateRekordboxDatabases();
      for (const cand of candidates || []) {
        try {
          const result = await window.rekordboxDesktop.readRekordboxDatabase(cand.path);
          if (!result.available || !result.rows) {
            console.warn(`[DB Auto] ${cand.path}: ${result.reason || 'nicht lesbar'}`);
            logger.warn('DATABASE', `[DB Auto] ${cand.path}: ${result.reason || 'nicht lesbar'}`);
            continue;
          }
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
          const sourceDbDir = dirOfPath(result.filePath || cand.path);
          const models = mapped.tracks.map((track, idx) =>
            buildCollectionTrackModel(track, idx, DataOrigin.REKORDBOX_DB)
          );
          const index = buildDbAnalysisIndex(models, sourceDbDir);
          let added = 0;
          for (const [k, v] of index) {
            if (!dbAnalysisIndexRef.current.has(k)) {
              dbAnalysisIndexRef.current.set(k, v);
              added += 1;
            }
          }
          console.info(
            `[DB Auto] ${cand.label || cand.path}: ${mapped.stats.tracks} Tracks, ${added} neue ANLZ-Links ` +
              `(gesamt ${dbAnalysisIndexRef.current.size})`
          );
          logger.info('DATABASE', `[DB Auto] ${cand.path}: ${added} ANLZ-Links`, { dbType: result.dbType });
        } catch (e) {
          console.warn(`[DB Auto] Fehler bei ${cand.path}:`, e);
          logger.warn('DATABASE', `[DB Auto] Fehler bei ${cand.path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      console.warn('[DB Auto] locateRekordboxDatabases fehlgeschlagen:', e);
    }
    return dbAnalysisIndexRef.current;
  }, []);

  /**
   * SQLCipher-unabhängige ANLZ-Auflösung: jeder ANLZ-Container speichert den
   * exakten Audio-Pfad im PPTH-Header. Die Desktop-Bridge scannt die
   * Standard-Verzeichnisstrukturen (nur Header lesen, read-only) und liefert
   * exakte Treffer — so bekommt ein aus XML importierter Track seine echte
   * Rekordbox-Waveform auch dann, wenn keine master.db lesbar ist.
   */
  const ensureAnlzPpthIndex = useCallback(
    async (track: TrackModel, linkKey: string): Promise<void> => {
      if (!window.rekordboxDesktop?.scanAnlzPaths) return;
      if (anlzPpthIndexRef.current.has(linkKey)) return;
      if (anlzPpthScanStateRef.current === 'DONE' && anlzPpthMissedKeysRef.current.has(linkKey)) return;
      if (anlzPpthScanPromiseRef.current) {
        await anlzPpthScanPromiseRef.current;
        return;
      }
      anlzPpthScanStateRef.current = 'RUNNING';
      const promise = (async () => {
        try {
          // Alle bekannten Audio-Lokalisationen in einem Scan abfragen, damit
          // ein Durchlauf die gesamte Sammlung beantwortet.
          const targets = new Set<string>();
          const pushTarget = (loc?: string | null) => {
            if (loc && loc.trim()) targets.add(loc.trim());
          };
          for (const t of xmlImportedTracks) pushTarget(t.originalMedia?.location);
          for (const t of tracks) pushTarget(t.originalMedia?.location);
          pushTarget(track.originalMedia?.location);
          pushTarget(track.originalMedia?.resolvedPath);
          const result = await window.rekordboxDesktop!.scanAnlzPaths(Array.from(targets));
          let added = 0;
          for (const m of result.matches) {
            if (!m.datPath && !m.extPath) continue;
            anlzPpthIndexRef.current.set(normalizeAudioKey(m.path), {
              datPath: m.datPath,
              extPath: m.extPath,
              matchTier: m.matchTier,
              note: m.note,
            });
            added += 1;
          }
          anlzPpthScanInfoRef.current = {
            scanned: result.scanned,
            folders: result.folders.length,
            elapsedMs: result.elapsedMs,
          };
          for (const t of targets) {
            const k = normalizeAudioKey(t);
            if (k && !anlzPpthIndexRef.current.has(k)) anlzPpthMissedKeysRef.current.add(k);
          }
          console.info(
            `[ANLZ PPTH-Scan] ${result.scanned} ANLZ-Dateien gescannt ` +
              `(${result.folders.length} Ordner, ${result.elapsedMs} ms) → ${added} exakte Zuordnung(en).`
          );
          logger.info('DATABASE', `[ANLZ PPTH-Scan] ${result.scanned} Dateien, ${added} Treffer`, {
            folders: result.folders,
            elapsedMs: result.elapsedMs,
          });
        } catch (e) {
          console.warn('[ANLZ PPTH-Scan] fehlgeschlagen:', e);
          logger.warn('DATABASE', `[ANLZ PPTH-Scan] fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          anlzPpthScanStateRef.current = 'DONE';
          anlzPpthScanPromiseRef.current = null;
        }
      })();
      anlzPpthScanPromiseRef.current = promise;
      await promise;
    },
    [xmlImportedTracks, tracks]
  );

  // Eager auto-load: Waveform/Cues direkt aus der lokalen Rekordbox-DB holen,
  // ohne dass der Benutzer erst einen DATA-Klick ausführen muss.
  useEffect(() => {
    if (!window.rekordboxDesktop) return;
    void ensureDbAnalysisIndex();
  }, [ensureDbAnalysisIndex]);

  // Mirror every logger entry into the durable desktop log file
  // (<userData>/airdox-smart-editor.log, rotated at 5 MB) while the app runs
  // inside Electron; in a plain browser this degrades to a no-op.
  useEffect(() => {
    const stopFileLogging = initFileLogging();
    return stopFileLogging;
  }, []);

  // Chatbot Palette state
  const [chatbotOpen, setChatbotOpen] = useState<boolean>(false);

  // Manual loader for reference track and palette clips from DEFAULT_REKORDBOX_XML
  // (Disabled on startup so the app opens with a completely empty project as requested)
  const handleSeparateStems = useCallback(async () => {
    const sourcePath = activeTrack?.filePath || activeTrack?.originalMedia?.resolvedPath || activeTrack?.originalMedia?.location;
    if (!activeTrack || !sourcePath) {
      setStemStatus({ kind: 'error', message: 'Es muss zuerst eine echte Audiodatei geladen werden.' });
      return;
    }
    const bridge = window.rekordboxDesktop;
    if (!bridge?.separateStems) {
      setStemStatus({ kind: 'error', message: 'Desktop-Bridge nicht gefunden. Die App muss in Electron laufen.' });
      return;
    }

    // Preflight first: an actionable install hint beats a failure mid-track.
    if (bridge.stemsPreflight) {
      try {
        const pre = await bridge.stemsPreflight();
        if (!pre.available) {
          setStemStatus({ kind: 'error', message: pre.reason || 'Separations-Engine nicht verfügbar.' });
          return;
        }
      } catch {
        // Preflight itself is best-effort; a hard failure still surfaces below.
      }
    }

    const jobId = `stem-${Date.now()}`;
    setIsSeparating(true);
    setStemJobId(jobId);
    setStemProgress(0);
    setStemStatus({ kind: 'running', message: 'Separation läuft …' });

    const unsubscribe = bridge.onStemsProgress?.((payload) => {
      if (payload.jobId !== jobId) return;
      if (typeof payload.percent === 'number') setStemProgress(payload.percent);
    });

    try {
      const result = await bridge.separateStems({ inputFilePath: sourcePath, jobId });

      if (result.status === 'CANCELLED') {
        setStemStatus({ kind: 'idle', message: 'Separation abgebrochen.' });
        return;
      }
      if (result.status !== 'COMPLETED' || result.stems.length === 0) {
        setStemStatus({ kind: 'error', message: result.error?.message || 'Separation fehlgeschlagen.' });
        return;
      }
      if (result.originalUnchanged === false) {
        setStemStatus({ kind: 'error', message: 'Die Originaldatei wurde verändert — Ergebnis verworfen.' });
        return;
      }

      // Decode in parallel and keep each buffer bound to its stem id, so a
      // failed decode can never shift the remaining stems onto wrong labels.
      const audioCtx = audioEngine.getContext();
      const decoded = await Promise.all(result.stems.map(async (stem) => {
        try {
          const source = await bridge.readOriginalAudio(stem.filePath);
          return { id: stem.id, filePath: stem.filePath, buffer: await audioCtx.decodeAudioData(source.data) };
        } catch (err) {
          console.error('Stem konnte nicht dekodiert werden:', stem.filePath, err);
          return { id: stem.id, filePath: stem.filePath, buffer: undefined };
        }
      }));

      const usable = decoded.filter((s): s is { id: string; filePath: string; buffer: AudioBuffer } => !!s.buffer);
      if (usable.length === 0) {
        setStemStatus({ kind: 'error', message: 'Kein Stem konnte dekodiert werden.' });
        return;
      }

      setTracks(prev => prev.map(t => t.id === activeTrack.id
        ? { ...t, stems: usable.map(s => ({ id: s.id, filePath: s.filePath })), stemBuffers: usable.map(s => s.buffer) }
        : t));
      setStemIds(usable.map(s => s.id));
      setStemVolumes(new Array(usable.length).fill(1.0));
      const skipped = decoded.length - usable.length;
      setStemStatus({
        kind: 'done',
        message: `${usable.length} Stems geladen (${usable.map(s => s.id).join(', ')})${skipped > 0 ? ` — ${skipped} übersprungen` : ''}.`,
      });
    } catch (e: unknown) {
      console.error('Separation error', e);
      setStemStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      unsubscribe?.();
      setIsSeparating(false);
      setStemJobId(null);
      setStemProgress(null);
    }
  }, [activeTrack]);

  const handleCancelSeparation = useCallback(() => {
    if (stemJobId) void window.rekordboxDesktop?.cancelStems?.(stemJobId);
  }, [stemJobId]);

  const handleLoadDemoTrack = useCallback(() => {
    try {
      const parsed = parseRekordboxXml(DEFAULT_REKORDBOX_XML);
      if (parsed.tracks.length > 0) {
        const rawTrack = parsed.tracks[0];
        const audioCtx = audioEngine.getContext();
        const bpm = rawTrack.bpm || 130.0;
        const firstBeat = rawTrack.beatGrid?.firstBeat || 0.0;
        const duration = rawTrack.duration || 326.0;
        const bars = Math.max(32, Math.ceil(duration / (240 / bpm)));
        const synthBuf = generateElectronicDjTrack(audioCtx, bpm, bars, firstBeat);
        const analysis = analyzeAudioBuffer(synthBuf, DataOrigin.REKORDBOX_XML);
        const sha256 = audioEngine.computeBufferChecksum(synthBuf);
        const phrases = generateRekordboxPhrases(bpm, synthBuf.duration, firstBeat);

        const initialTrack: TrackModel = {
          id: rawTrack.id || 'track-1',
          title: rawTrack.title || 'Quicksand (Boy 8 Bit mix)',
          artist: rawTrack.artist || 'La Roux',
          album: rawTrack.album || 'Quicksand',
          bpm,
          key: rawTrack.key || '3A',
          duration: synthBuf.duration,
          sampleRate: synthBuf.sampleRate,
          channels: synthBuf.numberOfChannels,
          originalSha256: sha256,
          isOriginalUntouched: true,
          audioBuffer: synthBuf,
          beatGrid: buildBeatGridFromTempo(firstBeat, bpm, synthBuf.duration, 4, DataOrigin.REKORDBOX_XML),
          cues: rawTrack.cues || [],
          loops: rawTrack.loops || [],
          analysis,
          phrases,
          origin: DataOrigin.REKORDBOX_XML,
          workingSegments: [
            {
              id: 'seg-init-1',
              type: 'ORIGINAL',
              trackId: rawTrack.id || 'track-1',
              sourceStart: 0,
              sourceEnd: synthBuf.duration,
              projectStart: 0,
              projectDuration: synthBuf.duration,
              gain: 1.0,
            },
          ],
        };

        // Extract palette clips from this authentic audio buffer matching screenshot
        const secPerBeat = 60 / bpm;
        const makeClip = (id: string, name: string, startBeat: number, numBeats: number, color: string): PaletteClip => {
          const startSec = startBeat * secPerBeat;
          const durSec = numBeats * secPerBeat;
          const startSample = Math.floor(startSec * synthBuf.sampleRate);
          const numSamples = Math.floor(durSec * synthBuf.sampleRate);
          const subBuf = audioCtx.createBuffer(2, numSamples, synthBuf.sampleRate);
          for (let ch = 0; ch < 2; ch++) {
            const src = synthBuf.getChannelData(ch);
            const dest = subBuf.getChannelData(ch);
            for (let i = 0; i < numSamples; i++) {
              dest[i] = src[startSample + i] || 0;
            }
          }
          return {
            id,
            name,
            sourceTrackId: rawTrack.id || 'track-1',
            sourceTrackName: rawTrack.title || 'Quicksand (Boy 8 Bit mix)',
            sourceStart: startSec,
            sourceEnd: startSec + durSec,
            duration: durSec,
            beats: numBeats,
            bars: Math.max(1, Math.round(numBeats / 4)),
            bpm,
            key: '3A',
            color,
            audioBuffer: subBuf,
            miniPeaks: extractMiniPeaks(subBuf, 64),
            origin: DataOrigin.REKORDBOX_XML,
          };
        };

        const sampleClips: PaletteClip[] = [
          makeClip('clip-1', 'Intro Kick 4B', 0, 16, '#ff2b2b'),
          makeClip('clip-2', '8-Bit Arp 8B', 432, 32, '#00a2ff'),
          makeClip('clip-3', 'Main Drop 8B', 448, 32, '#10b981'),
          makeClip('clip-4', 'Breakdown 16B', 384, 64, '#f59e0b'),
        ];

        setTracks([initialTrack]);
        setActiveTrackId(initialTrack.id);
        setWorkingAudioBuffer(synthBuf);
        setPaletteClips(sampleClips);

        // Position initial viewport to match the authentic Rekordbox EDIT mode reference (Bar 109 to 117)
        const dropTime = 112 * 4 * (60 / bpm); // ~206.69s (Bar 113)
        setCurrentTime(dropTime);
        setViewOffset(Math.max(0, dropTime - 9.85));
        setViewDuration(14.76);
      }
    } catch (err) {
      console.error('Fehler beim Laden des Referenz-Tracks:', err);
    }
  }, []);

  // Real-time animation loop for playhead progress and VU stereo meters
  useEffect(() => {
    let animId: number;
    const updateLoop = () => {
      if (audioEngine.getIsPlaying()) {
        const time = audioEngine.getCurrentTime();
        setCurrentTime(time);

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

  // Master volume control
  const handleMasterVolumeChange = (vol: number) => {
    setMasterVolume(vol);
    audioEngine.setMasterVolume(vol);
  };
  
  const handleStemVolumeChange = (index: number, vol: number) => {
    setStemVolumes(prev => {
      const next = [...prev];
      next[index] = vol;
      return next;
    });
    audioEngine.setStemVolume(index, vol);
  };

  // Playback Toggle
  const handleTogglePlay = () => {
    if (!activeTrack) {
      alert('Bitte lade zuerst einen Track oder importiere eine Audiodatei (WAV, MP3, FLAC).');
      return;
    }

    if (!workingAudioBuffer) {
      if (
        confirm(
          `Für "${activeTrack.title}" ist noch keine Audiodatei verknüpft.\n\nMöchtest du jetzt die passende Originaldatei (WAV, MP3, FLAC, AIFF) auswählen?`
        )
      ) {
        audioFileInputRef.current?.click();
      }
      return;
    }

    if (isPlaying) {
      audioEngine.pause();
      setIsPlaying(false);
    } else {
      let loopStart = 0;
      let loopEnd = 0;
      if (loopActive && selection) {
        loopStart = selection.start;
        loopEnd = selection.end;
      }
      audioEngine.play(workingAudioBuffer, currentTime, loopActive, loopStart, loopEnd, activeTrack?.stemBuffers);
      setIsPlaying(true);
    }
  };

  const handleReturnToStart = () => {
    audioEngine.stop();
    setIsPlaying(false);
    setCurrentTime(0);
    setViewOffset(0);
  };

  const handleSeek = (targetTime: number) => {
    const clamped = Math.max(0, Math.min(activeTrack?.duration || 0, targetTime));
    setCurrentTime(clamped);
    if (isPlaying && workingAudioBuffer) {
      audioEngine.play(workingAudioBuffer, clamped, loopActive, 0, 0, activeTrack?.stemBuffers);
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
  const handleSelectZoomPreset = useCallback(
    (preset: '2_BARS' | '4_BARS' | '8_BARS' | '16_BARS' | '32_BARS' | '64_BARS' | 'FULL_TRACK') => {
      const bpm = activeTrack?.bpm || 120.0;
      const secPerBar = (60 / bpm) * 4;
      let targetDuration = 16.0;

      if (preset === 'FULL_TRACK') {
        targetDuration = activeTrack ? activeTrack.duration : 60.0;
        setViewOffset(0);
        setViewDuration(targetDuration);
        return;
      }

      const barMap: Record<string, number> = {
        '2_BARS': 2,
        '4_BARS': 4,
        '8_BARS': 8,
        '16_BARS': 16,
        '32_BARS': 32,
        '64_BARS': 64,
      };
      const bars = barMap[preset] || 16;
      targetDuration = bars * secPerBar;

      if (activeTrack && targetDuration > activeTrack.duration) {
        targetDuration = activeTrack.duration;
      }

      const half = targetDuration / 2;
      let newOffset = Math.max(0, currentTime - half);
      if (activeTrack && newOffset + targetDuration > activeTrack.duration) {
        newOffset = Math.max(0, activeTrack.duration - targetDuration);
      }
      setViewDuration(targetDuration);
      setViewOffset(newOffset);
    },
    [activeTrack, currentTime]
  );
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

  // Set Beat 1.1 at current playhead position (Pioneer Rekordbox "Set 1.1 Here")
  const handleSetFirstBeatHere = useCallback(() => {
    if (!activeTrack) return;
    const newFirstBeat = Math.max(0, currentTime);
    const spb = 60.0 / activeTrack.bpm;

    setTracks((prev) =>
      prev.map((t) => {
        if (t.id === activeTrack.id) {
          const totalBeats = Math.floor((t.duration - newFirstBeat) / spb);
          const newBeats = Array.from({ length: Math.max(0, totalBeats) }, (_, i) => ({
            index: i,
            time: newFirstBeat + i * spb,
            isBarStart: i % 4 === 0,
            barNumber: Math.floor(i / 4) + 1,
            beatInBar: (i % 4) + 1,
          }));

          return {
            ...t,
            beatGrid: {
              ...t.beatGrid,
              firstBeat: newFirstBeat,
              beats: newBeats,
              origin: DataOrigin.USER_EDIT,
            },
            isModified: true,
          };
        }
        return t;
      })
    );
  }, [activeTrack, currentTime]);

  // Fine-tune Beatgrid offset (Pioneer Rekordbox Grid Shift: +/- 1ms or 10ms)
  const handleShiftBeatgrid = useCallback((deltaSeconds: number) => {
    if (!activeTrack) return;
    const currentFirstBeat = activeTrack.beatGrid.firstBeat || 0;
    const newFirstBeat = Math.max(0, currentFirstBeat + deltaSeconds);
    const spb = 60.0 / activeTrack.bpm;

    setTracks((prev) =>
      prev.map((t) => {
        if (t.id === activeTrack.id) {
          const totalBeats = Math.floor((t.duration - newFirstBeat) / spb);
          const newBeats = Array.from({ length: Math.max(0, totalBeats) }, (_, i) => ({
            index: i,
            time: newFirstBeat + i * spb,
            isBarStart: i % 4 === 0,
            barNumber: Math.floor(i / 4) + 1,
            beatInBar: (i % 4) + 1,
          }));

          return {
            ...t,
            beatGrid: {
              ...t.beatGrid,
              firstBeat: newFirstBeat,
              beats: newBeats,
              origin: DataOrigin.USER_EDIT,
            },
            isModified: true,
          };
        }
        return t;
      })
    );
  }, [activeTrack]);

  // Auto-align Beatgrid to nearest transient peak
  const handleAutoAlignBeatgrid = useCallback(() => {
    if (!activeTrack) return;
    const analysis = activeTrack.analysis;
    if (!analysis || analysis.peaks.length === 0) return;

    const secPerBucket = analysis.secPerBucket || (activeTrack.duration / analysis.length);
    const searchCenterBucket = Math.round(currentTime / secPerBucket);
    const searchRadius = Math.round(0.1 / secPerBucket); // search within +/- 100ms
    const minBucket = Math.max(0, searchCenterBucket - searchRadius);
    const maxBucket = Math.min(analysis.peaks.length - 1, searchCenterBucket + searchRadius);

    let maxPeak = -1;
    let bestBucket = searchCenterBucket;
    for (let b = minBucket; b <= maxBucket; b++) {
      const peakVal = analysis.lowEnergy[b] * 0.7 + analysis.peaks[b] * 0.3;
      if (peakVal > maxPeak) {
        maxPeak = peakVal;
        bestBucket = b;
      }
    }

    const alignedTime = bestBucket * secPerBucket;
    const spb = 60.0 / activeTrack.bpm;
    const currentFirst = activeTrack.beatGrid.firstBeat || 0;
    const beatDistance = (alignedTime - currentFirst) % spb;
    const shift = beatDistance > spb / 2 ? beatDistance - spb : beatDistance;
    handleShiftBeatgrid(shift);
  }, [activeTrack, currentTime, handleShiftBeatgrid]);

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
    }
  };

  // Snapshot current state for Undo (stores buffer, duration, analysis, cues, segments)
  const pushHistorySnapshot = (desc: string) => {
    if (!activeTrack) return;
    const snapshot: EditHistoryEntry = {
      description: desc,
      timestamp: Date.now(),
      segments: JSON.parse(JSON.stringify(activeTrack.workingSegments)),
      selection: selection ? { ...selection } : null,
      cues: JSON.parse(JSON.stringify(activeTrack.cues)),
      audioBuffer: workingAudioBuffer ? cloneAudioBuffer(workingAudioBuffer) : undefined,
      duration: activeTrack.duration,
      analysis: activeTrack.analysis ? { ...activeTrack.analysis } : undefined,
    };
    setUndoStack((prev) => [...prev.slice(-30), snapshot]);
    setRedoStack([]);
  };

  // Undo / Redo
  const handleUndo = () => {
    if (undoStack.length === 0 || !activeTrack) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));

    // Push current to redo
    const currentSnapshot: EditHistoryEntry = {
      description: 'Before Undo',
      timestamp: Date.now(),
      segments: JSON.parse(JSON.stringify(activeTrack.workingSegments)),
      selection: selection ? { ...selection } : null,
      cues: JSON.parse(JSON.stringify(activeTrack.cues)),
      audioBuffer: workingAudioBuffer ? cloneAudioBuffer(workingAudioBuffer) : undefined,
      duration: activeTrack.duration,
      analysis: activeTrack.analysis ? { ...activeTrack.analysis } : undefined,
    };
    setRedoStack((prev) => [...prev, currentSnapshot]);

    // Restore track state
    activeTrack.workingSegments = previous.segments;
    activeTrack.cues = previous.cues;
    if (previous.duration !== undefined) {
      activeTrack.duration = previous.duration;
    }
    if (previous.analysis) {
      activeTrack.analysis = previous.analysis;
    }
    setSelection(previous.selection);

    if (previous.audioBuffer) {
      setWorkingAudioBuffer(previous.audioBuffer);
      if (!previous.analysis) {
        // Project-sourced analysis for re-rendered project audio (never a
        // replacement for an original Rekordbox analysis).
        const projectAnalysis = analyzeAudioBuffer(previous.audioBuffer, DataOrigin.PROJECT);
        activeTrack.analysis = projectAnalysis;
      }
    } else if (activeTrack.audioBuffer) {
      const reRendered = audioEngine.renderWorkingAudio(activeTrack.audioBuffer, previous.segments);
      setWorkingAudioBuffer(reRendered);
      activeTrack.duration = reRendered.duration;
      const projectAnalysis = analyzeAudioBuffer(reRendered, DataOrigin.PROJECT);
      activeTrack.analysis = projectAnalysis;
    }
    setTracks([...tracks]);
  };

  const handleRedo = () => {
    if (redoStack.length === 0 || !activeTrack) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));

    // Push current to undo
    const currentSnapshot: EditHistoryEntry = {
      description: 'Before Redo',
      timestamp: Date.now(),
      segments: JSON.parse(JSON.stringify(activeTrack.workingSegments)),
      selection: selection ? { ...selection } : null,
      cues: JSON.parse(JSON.stringify(activeTrack.cues)),
      audioBuffer: workingAudioBuffer ? cloneAudioBuffer(workingAudioBuffer) : undefined,
      duration: activeTrack.duration,
      analysis: activeTrack.analysis ? { ...activeTrack.analysis } : undefined,
    };
    setUndoStack((prev) => [...prev, currentSnapshot]);

    activeTrack.workingSegments = next.segments;
    activeTrack.cues = next.cues;
    if (next.duration !== undefined) {
      activeTrack.duration = next.duration;
    }
    if (next.analysis) {
      activeTrack.analysis = next.analysis;
    }
    setSelection(next.selection);

    if (next.audioBuffer) {
      setWorkingAudioBuffer(next.audioBuffer);
      if (!next.analysis) {
        // Project-sourced analysis for re-rendered project audio (never a
        // replacement for an original Rekordbox analysis).
        const projectAnalysis = analyzeAudioBuffer(next.audioBuffer, DataOrigin.PROJECT);
        activeTrack.analysis = projectAnalysis;
      }
    } else if (activeTrack.audioBuffer) {
      const reRendered = audioEngine.renderWorkingAudio(activeTrack.audioBuffer, next.segments);
      setWorkingAudioBuffer(reRendered);
      activeTrack.duration = reRendered.duration;
      const projectAnalysis = analyzeAudioBuffer(reRendered, DataOrigin.PROJECT);
      activeTrack.analysis = projectAnalysis;
    }
    setTracks([...tracks]);
  };

  // Clear History handler (confirmed through ClearHistoryModal)
  const handleClearHistoryConfirm = () => {
    const totalCount = undoStack.length + redoStack.length;
    setUndoStack([]);
    setRedoStack([]);
    logger.info('EDITING', `[History] Cleared ${totalCount} history snapshots after user confirmation.`);
    showOperationFeedback({
      title: 'Bearbeitungsverlauf geleert',
      operationType: 'CLEAR_HISTORY',
      description: `Der Bearbeitungsverlauf (${totalCount} Schritte) wurde sicher geleert. Der aktuelle Zustand von Track und Waveform bleibt unverändert erhalten.`,
      originalSha256: activeTrack?.originalSha256 || 'N/A',
      timestamp: Date.now(),
    });
  };

  // BEAT SELECT handler (1, 2, 4, 8, 16, 32, 64, 128 beats)
  const handleAutoCue = useCallback(() => {
    if (!activeTrack) return;
    try {
      const newCues = generateAutoCuesForTrack(activeTrack);
      
      if (newCues.length > 0) {
        setTracks(prev => prev.map(t => {
          if (t.id === activeTrack.id) {
            return {
              ...t,
              cues: [...t.cues, ...newCues].sort((a, b) => a.position - b.position)
            };
          }
          return t;
        }));
        
        logger.info('SYSTEM', `Auto-Cue: Generierte ${newCues.length} neue Cue-Punkte (Drops & Breaks) für "${activeTrack.title}"`);
      }
    } catch (err: any) {
      logger.error('SYSTEM', `Fehler bei Auto-Cue Generierung: ${err.message}`);
    }
  }, [activeTrack]);

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

  // Add selection to Palette (CLONE or '+' button)
  const handleAddSelectionToPalette = () => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    const sliced = audioEngine.sliceAudioBuffer(workingAudioBuffer, selection.start, selection.end);

    // The clip carries the genuine source waveform slice of its range; the
    // mini-peak preview is aggregated from that payload (never synthesized).
    const clipWaveform = extractPaletteWaveform(activeTrack, selection.start, selection.end);
    let analysisData: Partial<PaletteClip>;
    if (activeTrack.analysis) {
      const extracted = extractMiniPeaksFromAnalysis(activeTrack.analysis, selection.start, selection.end, 48);
      analysisData = {
        miniPeaks: extracted.peaks,
        miniLow: extracted.low,
        miniMid: extracted.mid,
        miniHigh: extracted.high
      };
    } else if (clipWaveform) {
      const extracted = extractMiniPeaksFromAnalysis(clipWaveform, 0, selection.duration, 48);
      analysisData = {
        miniPeaks: extracted.peaks,
        miniLow: extracted.low,
        miniMid: extracted.mid,
        miniHigh: extracted.high
      };
    } else {
      analysisData = { miniPeaks: extractMiniPeaks(sliced, 48) };
    }

    const newClipId = `clip-${Date.now()}`;
    const newClip: PaletteClip = {
      id: newClipId,
      name: `${activeTrack.title} (${selection.barsCount.toFixed(1)} Bars)`,
      sourceTrackId: activeTrack.id,
      sourceTrackName: activeTrack.title,
      sourceStart: selection.start,
      sourceEnd: selection.end,
      duration: selection.duration,
      beats: Math.round(selection.beatsCount),
      bars: selection.barsCount,
      bpm: activeTrack.bpm,
      key: activeTrack.key,
      color: '#00a2ff',
      audioBuffer: sliced,
      waveform: clipWaveform,
      ...analysisData,
      origin: DataOrigin.PROJECT,
    };

    setPaletteClips((prev) => [...prev, newClip]);
    setSelectedClipId(newClipId);
    if (!paletteOpen) setPaletteOpen(true);
  };

  // Copy selection (validated by Edit Assistant)
  const handleCopy = () => {
    const validation = editAssistant.validateCopy(selection, workingAudioBuffer);
    if (!validation.isValid) {
      setEditAssistantModalOpen(true);
      return;
    }
    const effectiveSel = validation.sanitizedSelection || selection;
    if (!effectiveSel || !workingAudioBuffer) return;

    const sliced = executeCopy(workingAudioBuffer, effectiveSel);
    setClipboardBuffer(sliced);

    showOperationFeedback({
      title: 'Audio in Zwischenablage kopiert (Copy)',
      operationType: 'COPY',
      description: `Bereich (${effectiveSel.duration.toFixed(3)}s / ${effectiveSel.barsCount.toFixed(1)} Takte) kopiert. Puffer-Integrität validiert.`,
      timeRangeSec: { start: effectiveSel.start, end: effectiveSel.end, duration: effectiveSel.duration },
      barsCount: effectiveSel.barsCount,
      beatsCount: effectiveSel.beatsCount,
      originalSha256: activeTrack?.originalSha256 || 'N/A',
      timestamp: Date.now(),
    });
  };

  // Cut selection (validated by Edit Assistant)
  const handleCut = () => {
    const validation = editAssistant.validateCut(selection, workingAudioBuffer);
    if (!validation.isValid) {
      setEditAssistantModalOpen(true);
      return;
    }
    const effectiveSel = validation.sanitizedSelection || selection;
    if (!effectiveSel || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Cut');

    const { clipboard, execution } = executeCut(
      workingAudioBuffer,
      effectiveSel,
      activeTrack.cues,
      activeTrack.workingSegments
    );

    setClipboardBuffer(clipboard);
    applyExecutionToTrack(activeTrack, execution);
    setWorkingAudioBuffer(execution.newBuffer);
    setTracks([...tracks]);
    setSelection(null);

    showOperationFeedback({
      title: 'Auswahl ausgeschnitten (Cut)',
      operationType: 'CUT',
      description: `Bereich (${effectiveSel.duration.toFixed(3)}s / ${effectiveSel.barsCount.toFixed(1)} Takte) in die Zwischenablage kopiert und aus Track entfernt.`,
      timeRangeSec: { start: effectiveSel.start, end: effectiveSel.end, duration: effectiveSel.duration },
      barsCount: effectiveSel.barsCount,
      beatsCount: effectiveSel.beatsCount,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  };

  // Paste at playhead (validated by Edit Assistant)
  const handlePaste = () => {
    const validation = editAssistant.validatePaste(clipboardBuffer, workingAudioBuffer, currentTime);
    if (!validation.isValid) {
      setEditAssistantModalOpen(true);
      return;
    }
    if (!clipboardBuffer || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Paste');

    const insertTime = validation.sanitizedInsertionTime ?? currentTime;
    const result = executePaste(
      workingAudioBuffer,
      clipboardBuffer,
      insertTime,
      selection,
      activeTrack.cues,
      activeTrack.workingSegments
    );

    applyExecutionToTrack(activeTrack, result);
    setWorkingAudioBuffer(result.newBuffer);
    setTracks([...tracks]);

    showOperationFeedback({
      title: 'Audio Segment eingefügt (Paste)',
      operationType: 'PASTE',
      description: `Zwischenablage (${clipboardBuffer.duration.toFixed(3)}s) an Position ${insertTime.toFixed(3)}s eingefügt. Wellenform und Taktgitter synchronisiert.`,
      timeRangeSec: { start: insertTime, end: insertTime + clipboardBuffer.duration, duration: clipboardBuffer.duration },
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  };

  // Insert (shifts timeline and subsequent markers, validated by Edit Assistant)
  const handleInsert = () => {
    const validation = editAssistant.validateInsert(clipboardBuffer, workingAudioBuffer, currentTime);
    if (!validation.isValid) {
      setEditAssistantModalOpen(true);
      return;
    }
    if (!clipboardBuffer || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Insert');

    const insertPos = validation.sanitizedInsertionTime ?? currentTime;
    const result = executeInsert(
      workingAudioBuffer,
      clipboardBuffer,
      insertPos,
      activeTrack.cues,
      activeTrack.workingSegments
    );

    applyExecutionToTrack(activeTrack, result);
    setWorkingAudioBuffer(result.newBuffer);
    setTracks([...tracks]);

    showOperationFeedback({
      title: 'Audio Segment eingefügt (Insert)',
      operationType: 'INSERT',
      description: `Audio-Material (${clipboardBuffer.duration.toFixed(3)}s) an Playhead-Position ${insertPos.toFixed(3)}s eingefügt. Nachfolgende Cues und Wellenform wurden um +${clipboardBuffer.duration.toFixed(3)}s verschoben.`,
      timeRangeSec: { start: insertPos, end: insertPos + clipboardBuffer.duration, duration: clipboardBuffer.duration },
      shiftedCuesCount: activeTrack.cues.filter((c) => c.position >= insertPos).length,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  };

  // Insert Clip into Deck A with Tempo & Harmonic Pitch Adaptation
  const handleInsertClipToDeckA = (clip: PaletteClip) => {
    if (!activeTrack || !workingAudioBuffer) {
      alert('Bitte lade zuerst einen Track in Deck A.');
      return;
    }
    if (!clip.audioBuffer) {
      alert('Der Clip enthält keine Audiodaten.');
      return;
    }

    pushHistorySnapshot('Insert Clip');

    // Adapt clip audio: tempo is always matched to destination track, pitch is matched if matchPitchOnInsert is true
    const adapted = audioEngine.adaptClipToTrack(clip, activeTrack, matchPitchOnInsert);
    const insertPos = currentTime;

    const result = executeInsert(
      workingAudioBuffer,
      adapted.adaptedBuffer,
      insertPos,
      activeTrack.cues,
      activeTrack.workingSegments
    );

    applyExecutionToTrack(activeTrack, result);
    setWorkingAudioBuffer(result.newBuffer);
    setTracks([...tracks]);

    showOperationFeedback({
      title: 'Clip in Deck A eingefügt (Insert)',
      operationType: 'INSERT',
      description: `Clip "${clip.name}" an Position ${insertPos.toFixed(3)}s eingefügt. Tempo: ${clip.bpm.toFixed(1)} ➔ ${activeTrack.bpm.toFixed(1)} BPM (${adapted.tempoRatio.toFixed(3)}×). ${
        adapted.semitonesShifted !== 0
          ? `Tonhöhe: um ${adapted.semitonesShifted > 0 ? '+' : ''}${adapted.semitonesShifted} Halbtöne angepasst (${adapted.harmonicRelation}).`
          : matchPitchOnInsert
          ? 'Tonhöhe: Harmonisch synchronisiert.'
          : 'Tonhöhe: Original beibehalten (Key Sync aus).'
      }`,
      timeRangeSec: { start: insertPos, end: insertPos + adapted.newDuration, duration: adapted.newDuration },
      shiftedCuesCount: activeTrack.cues.filter((c) => c.position >= insertPos).length,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  };

  // Replace selection in Deck A with Clip (with Tempo & Harmonic Pitch Adaptation)
  const handleReplaceDeckAWithClip = (clip: PaletteClip) => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    if (!clip.audioBuffer) {
      alert('Der ausgewählte Clip enthält keine Audiodaten.');
      return;
    }

    pushHistorySnapshot('Replace with Clip');

    const adapted = audioEngine.adaptClipToTrack(clip, activeTrack, matchPitchOnInsert);
    const result = executeReplace(
      workingAudioBuffer,
      adapted.adaptedBuffer,
      selection,
      activeTrack.cues,
      activeTrack.workingSegments
    );

    applyExecutionToTrack(activeTrack, result);
    setWorkingAudioBuffer(result.newBuffer);
    setTracks([...tracks]);

    showOperationFeedback({
      title: 'Auswahl in Deck A ersetzt (Replace mit Clip)',
      operationType: 'REPLACE',
      description: `Auswahlbereich (${selection.duration.toFixed(3)}s / ${selection.barsCount.toFixed(1)} Takte) durch Clip "${clip.name}" ersetzt. Tempo angepasst: ${clip.bpm.toFixed(1)} ➔ ${activeTrack.bpm.toFixed(1)} BPM (${adapted.tempoRatio.toFixed(3)}×). ${
        adapted.semitonesShifted !== 0
          ? `Tonhöhe angepasst: um ${adapted.semitonesShifted > 0 ? '+' : ''}${adapted.semitonesShifted} Halbtöne (${adapted.harmonicRelation}).`
          : matchPitchOnInsert
          ? 'Tonhöhe: Harmonisch kompatibel.'
          : 'Tonhöhe: Original beibehalten.'
      }`,
      timeRangeSec: { start: selection.start, end: selection.end, duration: selection.duration },
      barsCount: selection.barsCount,
      beatsCount: selection.beatsCount,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  };

  // Overdub selection in Deck A with Clip (with Tempo & Harmonic Pitch Adaptation)
  const handleOverdubDeckAWithClip = (clip: PaletteClip) => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    if (!clip.audioBuffer) {
      alert('Der ausgewählte Clip enthält keine Audiodaten.');
      return;
    }

    pushHistorySnapshot('Overdub with Clip');

    const adapted = audioEngine.adaptClipToTrack(clip, activeTrack, matchPitchOnInsert);
    const result = executeOverdub(
      workingAudioBuffer,
      adapted.adaptedBuffer,
      selection,
      activeTrack.cues,
      activeTrack.workingSegments
    );

    applyExecutionToTrack(activeTrack, result);
    setWorkingAudioBuffer(result.newBuffer);
    setTracks([...tracks]);

    showOperationFeedback({
      title: 'Deck A überlagert (Overdub mit Clip)',
      operationType: 'OVERDUB',
      description: `Clip "${clip.name}" über Auswahl gemischt (${selection.duration.toFixed(3)}s / ${selection.barsCount.toFixed(1)} Takte). Tempo angepasst: ${clip.bpm.toFixed(1)} ➔ ${activeTrack.bpm.toFixed(1)} BPM (${adapted.tempoRatio.toFixed(3)}×). ${
        adapted.semitonesShifted !== 0
          ? `Tonhöhe: um ${adapted.semitonesShifted > 0 ? '+' : ''}${adapted.semitonesShifted} Halbtöne angepasst (${adapted.harmonicRelation}).`
          : 'Tonhöhe: Harmonisch kompatibel.'
      }`,
      timeRangeSec: { start: selection.start, end: selection.end, duration: selection.duration },
      barsCount: selection.barsCount,
      beatsCount: selection.beatsCount,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  };

  // Replace selection with active Palette clip
  const handleReplace = () => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    const activeClip = paletteClips.find((c) => c.id === selectedClipId) || paletteClips[0];
    if (!activeClip || !activeClip.audioBuffer) {
      alert('Bitte wähle zuerst einen Clip in der Palette aus.');
      return;
    }
    handleReplaceDeckAWithClip(activeClip);
  };

  // Overdub active Palette clip onto selection
  const handleOverdub = () => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    const activeClip = paletteClips.find((c) => c.id === selectedClipId) || paletteClips[0];
    if (!activeClip || !activeClip.audioBuffer) {
      alert('Bitte wähle zuerst einen Clip in der Palette aus.');
      return;
    }
    handleOverdubDeckAWithClip(activeClip);
  };

  // Delete selection (removes range and shifts subsequent material, validated by Edit Assistant)
  const handleDelete = () => {
    const validation = editAssistant.validateDelete(selection, workingAudioBuffer);
    if (!validation.isValid) {
      setEditAssistantModalOpen(true);
      return;
    }
    const effectiveSel = validation.sanitizedSelection || selection;
    if (!effectiveSel || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Delete');

    const result = executeDelete(
      workingAudioBuffer,
      effectiveSel,
      activeTrack.cues,
      activeTrack.workingSegments
    );

    applyExecutionToTrack(activeTrack, result);
    setWorkingAudioBuffer(result.newBuffer);
    setTracks([...tracks]);
    setSelection(null);

    showOperationFeedback({
      title: 'Auswahl gelöscht (Delete)',
      operationType: 'DELETE',
      description: `Bereich (${effectiveSel.duration.toFixed(3)}s / ${effectiveSel.barsCount.toFixed(1)} Takte) gelöscht. Nachfolgendes Audio-Material um -${effectiveSel.duration.toFixed(3)}s nach vorne gerückt.`,
      timeRangeSec: { start: effectiveSel.start, end: effectiveSel.end, duration: effectiveSel.duration },
      barsCount: effectiveSel.barsCount,
      beatsCount: effectiveSel.beatsCount,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  };

  // Clear selection (silences range without changing duration, validated by Edit Assistant)
  const handleClear = () => {
    const validation = editAssistant.validateClear(selection, workingAudioBuffer);
    if (!validation.isValid) {
      setEditAssistantModalOpen(true);
      return;
    }
    const effectiveSel = validation.sanitizedSelection || selection;
    if (!effectiveSel || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Clear');

    const result = executeClear(
      workingAudioBuffer,
      effectiveSel,
      activeTrack.cues,
      activeTrack.workingSegments
    );

    applyExecutionToTrack(activeTrack, result);
    setWorkingAudioBuffer(result.newBuffer);
    setTracks([...tracks]);

    showOperationFeedback({
      title: 'Bereich stummgeschaltet (Clear / Mute)',
      operationType: 'CLEAR',
      description: `Bereich (${effectiveSel.duration.toFixed(3)}s / ${effectiveSel.barsCount.toFixed(1)} Takte) stummgeschaltet. Timeline-Dauer und Beatgrid-Synchronisation unverändert erhalten.`,
      timeRangeSec: { start: effectiveSel.start, end: effectiveSel.end, duration: effectiveSel.duration },
      barsCount: effectiveSel.barsCount,
      beatsCount: effectiveSel.beatsCount,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
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
  // When the file was chosen through the desktop bridge, its sibling container
  // (ANLZnnnn.EXT ↔ ANLZnnnn.DAT) is loaded as well: only the pair carries the
  // full-resolution color waveform (PWV5), PSSI phrases and PCO2 cues.
  const handleImportAnlzData = async (data: ArrayBuffer, fileName: string, sourcePath?: string) => {
    if (!activeTrack) return;

    try {
      let extraction = parseAnlzBinary(ensureArrayBuffer(data));
      const sibling = sourcePath
        ? deriveSiblingExtension(sourcePath, 'EXT') ?? deriveSiblingExtension(sourcePath, 'DAT')
        : null;
      if (sibling && window.rekordboxDesktop) {
        try {
          const extSource = await window.rekordboxDesktop.readAnalysisFile(sibling);
          const extExtraction = parseAnlzBinary(ensureArrayBuffer(extSource.data as ArrayBuffer | Uint8Array));
          // DAT stays primary (PQTZ authority), EXT secondary (PCO2/PSSI).
          extraction = /\.ext$/i.test(sibling)
            ? mergeAnlzExtractions(extraction, extExtraction)
            : mergeAnlzExtractions(extExtraction, extraction);
          console.info(`[ANLZ Import] +Schwesterdatei ${sibling} → ${extExtraction.tagsFound.join(', ')}`);
        } catch {
          console.info(`[ANLZ Import] Keine Schwesterdatei (${sibling}) lesbar.`);
        }
      }
      const enrichedTrack = applyAnlzExtractionToTrack(activeTrack, extraction);
      setTracks((previous) => previous.map((track) => (
        track.id === enrichedTrack.id ? enrichedTrack : track
      )));
      if (enrichedTrack.audioBuffer) setWorkingAudioBuffer(enrichedTrack.audioBuffer);

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
      await handleImportAnlzData(
        ensureArrayBuffer(source.data as ArrayBuffer | Uint8Array),
        fileName,
        chosen.path
      );
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
    try {
      const result = await window.rekordboxDesktop.readRekordboxDatabase(dbPath);
      if (!result.available || !result.rows) {
        throw new Error(result.reason || 'Die Rekordbox-Datenbank konnte nicht gelesen werden.');
      }

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
      setMasterDbPath(result.filePath || dbPath);
      setXmlCollectionModalOpen(true);

      showOperationFeedback({
        title: 'Rekordbox-Datenbank importiert (Read-Only)',
        operationType: 'CUE',
        description: `${sourceLabel || result.fileName || dbPath}: ${mapped.stats.tracks} Tracks, ${mapped.stats.memoryCues} Memory Cues, ${mapped.stats.hotCues} Hot Cues, ${mapped.stats.loops} Loops aus der Datenbank übernommen.`,
        timeRangeSec: { start: 0, end: 0, duration: 0 },
        originalSha256: 'NOT_COMPUTED_READ_ONLY_SOURCE',
        timestamp: Date.now(),
      });

      const warnings = [...(mapped.warnings || []), ...(result.warnings || [])];
      if (warnings.length > 0) {
        console.warn('[Rekordbox DB] Hinweise:', warnings);
      }
    } catch (error) {
      console.error('[Rekordbox DB] Import fehlgeschlagen:', error);
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

  // Load a selected track from Rekordbox XML into the DJ Deck
  const handleSelectTrackFromXml = async (selectedDef: TrackModel) => {
    // Request-Guard gegen Race Conditions: nur das Ergebnis der zuletzt
    // gestarteten Auswahl darf das Deck/die Waveform setzen.
    const generation = trackRequestGuard.current.begin();
    try {
      const audioCtx = audioEngine.getContext();
      let originalAudio = selectedDef.audioBuffer || null;
      let originalMedia = selectedDef.originalMedia;

      // ---- VERPFLICHTENDES MASTER-DB-/SQLCIPHER-GATE ----------------------
      // Rekordbox → master.db → SQLCipher → geöffnet → Schema → Track →
      // Trackdaten. Erst danach darf die Waveform-/Analysis-Pipeline laufen.
      // Kein stiller XML-Fallback, keine erfundenen Werte.
      let dbGateTrack: TrackModel | null = null;
      let masterDbGateFailure: string | null = null;
      if (window.rekordboxDesktop) {
        const gate = await runMasterDbGate({
          dbPath: masterDbPath || undefined,
          trackId: selectedDef.origin === DataOrigin.REKORDBOX_DB ? selectedDef.id : undefined,
          audioPath: selectedDef.originalMedia?.location,
          location: selectedDef.originalMedia?.location,
        });
        if (!trackRequestGuard.current.isCurrent(generation)) return;
        if (gate.ok === false) {
          // Das Gate bleibt verbindlich und wird unverändert gemeldet – es darf
          // nur keine erfundenen Rekordbox-Daten erzeugen. Der Track wird
          // deshalb NICHT mehr verworfen: die SQLCipher-unabhängige Kette
          // (ANLZ über AnalysisDataPath/PPTH-Scan, dann Originalaudio, dann
          // gekennzeichnete Vorschau) läuft weiter, jede Quelle bleibt getaggt.
          masterDbGateFailure = `${gate.errorCode}: ${gate.reason}`;
          console.error(`[Pipeline] MASTER_DB_GATE_FAILED: ${masterDbGateFailure}`);
          logger.warn('DATABASE', `[Pipeline] MASTER_DB_GATE_FAILED: ${masterDbGateFailure}`);
        } else {
          const built = buildDeckTrackAfterGate({
            gate,
            supplementary: selectedDef,
            anlzAnalysis: selectedDef.analysis ?? null,
            firstBeat: selectedDef.beatGrid?.firstBeat ?? null,
          });
          if (built.ok === false) {
            masterDbGateFailure = `${built.errorCode}: ${built.reason}`;
            console.error(`[Pipeline] MASTER_DB_GATE_FAILED: ${masterDbGateFailure}`);
            logger.warn('DATABASE', `[Pipeline] MASTER_DB_GATE_FAILED: ${masterDbGateFailure}`);
          } else {
            dbGateTrack = built.track;
            console.info(
              `[RekordboxDB] track ${built.provenance.trackId} aus Master DB übernommen (matchedBy=${built.provenance.matchedBy}, analysis=${built.analysisSource})`
            );
            selectedDef = { ...selectedDef, ...dbGateTrack, audioBuffer: selectedDef.audioBuffer ?? null };
            originalMedia = selectedDef.originalMedia;
          }
        }
      }

      // The native bridge can resolve the XML Location and only ever opens the
      // original audio read-only. In a browser or when no Location exists, the
      // track is provisioned with high-fidelity audio matching its BPM, beatgrid,
      // and key, ensuring beatgrid, waveform, playback, and editing work immediately.
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
          console.warn('[XML Location] Originalaudio konnte nicht gelesen werden; erzeuge kompatibles Deck-Audio.', error);
          originalMedia = { ...originalMedia, status: 'MISSING' };
        }
      }

      const bpm = selectedDef.bpm || 130.0;
      const durationDef = selectedDef.duration || 300.0;
      const firstBeatDef = selectedDef.beatGrid?.firstBeat || 0.0;

      // In accordance with VORHABEN.md: No synthetic replacement track is
      // generated when original audio is missing. The waveform itself is
      // resolved a few lines below: ANLZ first, then the track's own audio,
      // and only as a last resort a clearly tagged beatgrid preview.
      const duration = originalAudio ? originalAudio.duration : durationDef;
      const sha256 = originalAudio
        ? audioEngine.computeBufferChecksum(originalAudio)
        : (selectedDef.originalSha256 || 'missing-audio');
      // No template phrases: only genuine PSSI data (from ANLZ) or phrases
      // already attached to the collection entry are shown.
      const phrases = selectedDef.phrases && selectedDef.phrases.length > 0 ? selectedDef.phrases : [];

      // Deterministic XML→DB analysis link: when the collection entry carries
      // no AnalysisDataPath of its own, attach the DB reference whose audio
      // path matches exactly (no fuzzy/metadata similarity matching).
      // Without this the deck has no waveform at all, because a Rekordbox XML
      // export never contains waveform data.
      const rbExclusive = isRekordboxOrigin(selectedDef.origin ?? DataOrigin.REKORDBOX_XML);
      let linkedRawXmlAttributes = selectedDef.rawXmlAttributes;
      // UI-Diagnostik: was hat die automatische ANLZ-Zuordnung getan?
      let anlzLookup: {
        via: 'DB' | 'PPTH' | 'PPTH_NAME' | null;
        scanned: number;
        folders: number;
        elapsedMs: number;
        note?: string | null;
      } | null = null;
      if (rbExclusive && !selectedDef.rawXmlAttributes?.analysisDataPath?.trim()) {
        if (dbAnalysisIndexRef.current.size === 0) {
          await ensureDbAnalysisIndex();
        }
        const linkKey = normalizeAudioKey(
          selectedDef.originalMedia?.resolvedPath || selectedDef.originalMedia?.location || ''
        );
        const linkRef = linkKey ? dbAnalysisIndexRef.current.get(linkKey) : undefined;
        if (linkRef) {
          linkedRawXmlAttributes = {
            ...(selectedDef.rawXmlAttributes ?? {}),
            analysisDataPath: linkRef.analysisDataPath,
            sourceDbDir: linkRef.sourceDbDir,
          };
          anlzLookup = { via: 'DB', scanned: 0, folders: 0, elapsedMs: 0 };
          console.info(`[Track-Link] Track exakt mit DB-Analyse verknüpft (DB-Track ${linkRef.trackId}).`);
        } else if (linkKey) {
          // PPTH-Fallback (SQLCipher-unabhängig): exakter Treffer über die
          // PPTH-Header der ANLZ-Container in den Rekordbox-Verzeichnissen.
          await ensureAnlzPpthIndex(selectedDef, linkKey);
          const ppthEntry = anlzPpthIndexRef.current.get(linkKey);
          const ppthFile = ppthEntry ? ppthEntry.datPath || ppthEntry.extPath : null;
          const scanInfo = anlzPpthScanInfoRef.current;
          if (ppthFile) {
            linkedRawXmlAttributes = {
              ...(selectedDef.rawXmlAttributes ?? {}),
              analysisDataPath: ppthFile,
              sourceDbDir: dirOfPath(ppthFile),
            };
            anlzLookup = {
              via: ppthEntry.matchTier === 2 ? 'PPTH_NAME' : 'PPTH',
              scanned: scanInfo?.scanned ?? 0,
              folders: scanInfo?.folders ?? 0,
              elapsedMs: scanInfo?.elapsedMs ?? 0,
              note: ppthEntry.note,
            };
            console.info(`[Track-Link] Track mit ANLZ verknüpft (PPTH-Scan Tier ${ppthEntry.matchTier}: ${ppthFile}).`);
          } else {
            anlzLookup = {
              via: null,
              scanned: scanInfo?.scanned ?? 0,
              folders: scanInfo?.folders ?? 0,
              elapsedMs: scanInfo?.elapsedMs ?? 0,
            };
            console.info(
              `[Track-Link] Kein DB-Eintrag und kein PPTH-Treffer für ${linkKey} ` +
                `(${anlzLookup.scanned} ANLZ-Dateien in ${anlzLookup.folders} Ordner(n) gescannt) – ` +
                `Waveform wird aus Originalaudio/Vorschau dargestellt (manuelle ANLZ-Zuordnung über DATA möglich).`
            );
          }
        }
      }
      if (anlzLookup) {
        linkedRawXmlAttributes = {
          ...(linkedRawXmlAttributes ?? {}),
          anlzLookup: JSON.stringify(anlzLookup),
        };
      }

      let loadedTrack: TrackModel = {
        ...selectedDef,
        id: selectedDef.id || `track-${Date.now()}`,
        title: selectedDef.title || 'Rekordbox Track',
        artist: selectedDef.artist || 'Unknown Artist',
        album: selectedDef.album || 'Rekordbox Collection',
        bpm,
        key: selectedDef.key || '2A',
        duration,
        sampleRate: originalAudio ? originalAudio.sampleRate : 44100,
        channels: originalAudio ? originalAudio.numberOfChannels : 2,
        originalSha256: sha256,
        isOriginalUntouched: true,
        audioBuffer: originalAudio,
        // Collection entries intentionally retain only compact beatgrid
        // metadata. Expand it when this one track is actually loaded,
        // keeping the source origin (XML or Rekordbox DB).
        beatGrid: buildBeatGridFromTempo(
          firstBeatDef,
          selectedDef.beatGrid?.bpm ?? bpm,
          duration,
          selectedDef.beatGrid?.meter ?? 4,
          selectedDef.origin ?? DataOrigin.REKORDBOX_XML
        ),
        cues: selectedDef.cues || [],
        loops: selectedDef.loops || [],
        analysis: selectedDef.analysis || null,
        analysisVariants: selectedDef.analysisVariants,
        phrases,
        originalMedia: originalMedia || {
          location: selectedDef.title,
          accessMode: 'READ_ONLY',
          status: originalAudio ? 'AVAILABLE' : 'MISSING',
        },
        rawXmlAttributes: linkedRawXmlAttributes,
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

      // 1) Echte Rekordbox-ANLZ-Daten automatisch zuordnen (AnalysisDataPath
      //    aus der DB oder aus dem PPTH-Scan, inkl. EXT-Schwesterdatei).
      let anlzApplied = false;
      if (rbExclusive) {
        const before = loadedTrack;
        loadedTrack = await tryAutoLoadAnlz(loadedTrack);
        anlzApplied = loadedTrack !== before;
      }

      // 2) Waveform-Garantie: ohne ANLZ wird die Wellenform aus dem
      //    Originalaudio berechnet, und ohne lesbares Audio aus dem
      //    Beatgrid — jeweils klar gekennzeichnet, nie still erfunden.
      const withWaveform = resolveDeckWaveform(loadedTrack);
      loadedTrack = withWaveform.track;
      const waveformSource = withWaveform.source;
      logger.info('WAVEFORM', `[Deck] ${loadedTrack.title}: Waveform-Quelle = ${waveformSource}`, {
        anlzApplied,
        buckets: loadedTrack.analysis?.length ?? 0,
        variants: loadedTrack.analysisVariants?.length ?? 0,
        anlzLookup,
      });

      // Ergebnis eines inzwischen überholten Requests niemals anwenden.
      if (!trackRequestGuard.current.isCurrent(generation)) return;

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
      setCurrentTime(0);
      setViewOffset(0);
      setIsPlaying(false);
      audioEngine.stop();

      showOperationFeedback({
        title:
          waveformSource === 'ANLZ'
            ? 'Rekordbox-Track geladen (ANLZ-Waveform)'
            : waveformSource === 'LOCAL_AUDIO'
              ? 'Rekordbox-Track geladen (Waveform aus Originalaudio)'
              : 'Rekordbox-Track geladen (Vorschau-Waveform)',
        operationType: 'CUE',
        description:
          `"${loadedTrack.title}": Beatgrid, Cues und Loops stammen aus den Rekordbox-Importdaten. ` +
          (masterDbGateFailure
            ? `Master-DB-Gate fehlgeschlagen (${masterDbGateFailure}) – es werden keine DB-Werte als Rekordbox-Daten ausgegeben. `
            : '') +
          describeDeckWaveformSource(waveformSource) +
          (loadedTrack.analysis
            ? ` ${loadedTrack.analysis.length} Buckets` +
              (loadedTrack.databaseRecord?.anlzTagsFound?.length
                ? ` (${loadedTrack.databaseRecord.anlzTagsFound.join(', ')})`
                : '') +
              '.'
            : '') +
          (anlzApplied ? ' ANLZ-Analyse wurde automatisch zugeordnet.' : '') +
          (anlzLookup && !anlzLookup.via
            ? ` ANLZ-Suche: ${anlzLookup.scanned} Dateien in ${anlzLookup.folders} Ordnern ohne Treffer.`
            : ''),
        timeRangeSec: { start: 0, end: duration, duration },
        originalSha256: loadedTrack.originalSha256,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('Fehler beim Laden des Tracks in das Deck:', err);
    }
  };

  // ---- Phase 4: Project persistence & desktop write path -----------------

  const sanitizeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');

  const handleSaveProject = useCallback(async () => {
    const doc = serializeProject({
      projectName,
      activeTrackId,
      selection,
      tracks,
      paletteClips,
    });
    const defaultName = `${sanitizeFileName(projectName) || 'project'}.airdox.json`;
    const data = new TextEncoder().encode(doc);

    try {
      if (window.rekordboxDesktop) {
        const res = await window.rekordboxDesktop.saveExportFile({
          kind: 'PROJECT',
          data,
          defaultName,
          protectedPaths,
        });
        if (res.saved) {
          showOperationFeedback({
            title: 'Projekt gespeichert',
            operationType: 'EXPORT',
            description: `Projekt "${projectName}" als "${res.path?.split(/[\\\\/]/).pop() || defaultName}" gespeichert. Original-Rekordbox-Quellen bleiben unverändert.`,
            originalSha256: activeTrack?.originalSha256 ?? 'NOT_COMPUTED_READ_ONLY_SOURCE',
            timestamp: Date.now(),
          });
        }
        return;
      }

      // Browser fallback: plain download of the project document.
      const blob = new Blob([doc], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showOperationFeedback({
        title: 'Projekt gespeichert',
        operationType: 'EXPORT',
        description: `Projekt "${projectName}" als "${defaultName}" heruntergeladen.`,
        originalSha256: activeTrack?.originalSha256 ?? 'NOT_COMPUTED_READ_ONLY_SOURCE',
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('[Projekt] Speichern fehlgeschlagen:', err);
      alert(`Projekt konnte nicht gespeichert werden: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [projectName, activeTrackId, selection, tracks, paletteClips, protectedPaths, activeTrack, showOperationFeedback]);

  const handleOpenProject = useCallback(async () => {
    if (!window.rekordboxDesktop) {
      alert('Projekte öffnen ist nur in der Windows-Desktop-App verfügbar.');
      return;
    }

    try {
      const opened = await window.rekordboxDesktop.openProjectFile();
      if (!opened) return;

      const doc = deserializeProject(opened.data);
      const audioCtx = audioEngine.getContext();

      // Rebuild all deck tracks (metadata + embedded clip audio) first.
      const rebuiltTracks: TrackModel[] = [];
      for (const st of doc.tracks) {
        rebuiltTracks.push(await rebuildTrackFromSerialized(st, audioCtx));
      }

      // Rebuild the palette with its embedded clip audio.
      const rebuiltClips = [];
      for (const clip of doc.paletteClips) {
        const audioBuffer = await decodeWavBase64(audioCtx, clip.clipWavBase64);
        rebuiltClips.push({
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
          audioBuffer,
          miniPeaks: clip.miniPeaks,
          origin: clip.origin,
        });
      }

      setProjectName(doc.projectName);
      setSelection(doc.selection);
      setPaletteClips(rebuiltClips);
      setTracks(rebuiltTracks);
      setActiveTrackId(doc.activeTrackId || rebuiltTracks[0]?.id || '');
      setCurrentTime(0);
      setViewOffset(0);
      setIsPlaying(false);
      audioEngine.stop();

      // The active track re-opens its original audio from the read-only source
      // path (if it has one) and re-applies the stored edit segments.
      const activeTrack = rebuiltTracks.find((t) => t.id === (doc.activeTrackId || rebuiltTracks[0]?.id)) ?? null;
      if (activeTrack) {
        let originalAudio = activeTrack.audioBuffer;
        let originalMedia = activeTrack.originalMedia;

        if (!originalAudio && originalMedia?.location && window.rekordboxDesktop) {
          try {
            const source = await window.rekordboxDesktop.readOriginalAudio(originalMedia.location);
            originalAudio = await audioCtx.decodeAudioData(source.data);
            originalMedia = { ...originalMedia, resolvedPath: source.path, size: source.size, modifiedAt: source.modifiedAt, status: 'AVAILABLE' as const };
          } catch (error) {
            console.warn('[Projekt] Originalaudio konnte nicht erneut geöffnet werden; Metadaten bleiben verfügbar.', error);
            originalMedia = { ...originalMedia, status: 'MISSING' as const };
          }
        }

        if (originalAudio) {
          const withAudio: TrackModel = {
            ...activeTrack,
            audioBuffer: originalAudio,
            originalMedia,
            duration: originalAudio.duration || activeTrack.duration,
            sampleRate: originalAudio.sampleRate,
            channels: originalAudio.numberOfChannels,
          };
          // Same guarantee as a fresh deck load: real ANLZ data first (the
          // project file stores no waveform), then the track's own audio, then
          // a clearly tagged beatgrid preview.
          const withAnlz = await tryAutoLoadAnlz(withAudio);
          const resolved = resolveDeckWaveform({ ...withAnlz, analysis: withAnlz.analysis ?? null });
          const finalTrack = resolved.track;
          logger.info('WAVEFORM', `[Projekt] ${finalTrack.title}: Waveform-Quelle = ${resolved.source}`);
          const working = audioEngine.renderWorkingAudio(originalAudio, finalTrack.workingSegments);
          setWorkingAudioBuffer(working);
          setTracks((prev) => prev.map((t) => (t.id === finalTrack.id ? finalTrack : t)));
        } else if (activeTrack.audioBuffer) {
          setWorkingAudioBuffer(
            audioEngine.renderWorkingAudio(activeTrack.audioBuffer, activeTrack.workingSegments)
          );
          const resolved = resolveDeckWaveform(activeTrack);
          if (resolved.source !== 'NONE' && resolved.track !== activeTrack) {
            setTracks((prev) => prev.map((t) => (t.id === resolved.track.id ? resolved.track : t)));
          }
        } else {
          // No audio at all: still never an empty bar.
          const resolved = resolveDeckWaveform(activeTrack);
          if (resolved.source !== 'NONE' && resolved.track !== activeTrack) {
            setTracks((prev) => prev.map((t) => (t.id === resolved.track.id ? resolved.track : t)));
          }
        }
      }

      showOperationFeedback({
        title: 'Projekt geladen',
        operationType: 'EXPORT',
        description: `Projekt "${doc.projectName}" mit ${rebuiltTracks.length} Track(s) und ${rebuiltClips.length} Palette-Clip(s) geladen. Originalquellen wurden nur lesend erneut geöffnet.`,
        originalSha256: 'NOT_COMPUTED_READ_ONLY_SOURCE',
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('[Projekt] Öffnen fehlgeschlagen:', err);
      alert(`Projekt konnte nicht geöffnet werden: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [showOperationFeedback]);

  // Audio file loading (WAV, MP3, FLAC, AIFF)
  const loadAudioFile = async (file: File) => {
    try {
      const audioCtx = audioEngine.getContext();
      if (audioCtx.state === 'suspended') {
        try {
          await audioCtx.resume();
        } catch (e) {
          console.warn('AudioContext resume error:', e);
        }
      }

      const arrayBuf = await file.arrayBuffer();
      // Robust decodeAudioData with promise/callback compatibility
      const decoded: AudioBuffer = await new Promise((resolve, reject) => {
        const copy = arrayBuf.slice(0);
        const res = audioCtx.decodeAudioData(copy, resolve, reject);
        if (res && typeof (res as unknown as Promise<AudioBuffer>).then === 'function') {
          (res as unknown as Promise<AudioBuffer>).then(resolve).catch(reject);
        }
      });

      const analysis = analyzeAudioBuffer(decoded, DataOrigin.LOCAL_ANALYSIS);
      const sha256 = audioEngine.computeBufferChecksum(decoded);

      // Check if the currently active deck track needs its audio file (or has matching name)
      const currentActive = tracks.find((t) => t.id === activeTrackId);
      const isMissingAudioOnActive = currentActive && !currentActive.audioBuffer;
      const isMatchingName =
        currentActive &&
        (currentActive.title.toLowerCase().includes(file.name.toLowerCase().replace(/\.[^/.]+$/, '')) ||
          file.name.toLowerCase().includes(currentActive.title.toLowerCase().replace(/\.[^/.]+$/, '')));

      if (currentActive && (isMissingAudioOnActive || isMatchingName)) {
        // Link this decoded audio to the active track
        const updatedTrack: TrackModel = {
          ...currentActive,
          duration: decoded.duration,
          sampleRate: decoded.sampleRate,
          channels: decoded.numberOfChannels,
          originalSha256: sha256,
          isOriginalUntouched: true,
          audioBuffer: decoded,
          analysis,
          originalMedia: {
            location: file.name,
            resolvedPath: file.name,
            accessMode: 'READ_ONLY',
            status: 'AVAILABLE',
            size: file.size,
            modifiedAt: file.lastModified,
          },
          beatGrid: buildBeatGridFromTempo(
            currentActive.beatGrid?.firstBeat || 0.0,
            currentActive.bpm || 130.0,
            decoded.duration,
            currentActive.beatGrid?.meter || 4,
            currentActive.origin
          ),
          workingSegments: [
            {
              id: `seg-${Date.now()}`,
              type: 'ORIGINAL',
              trackId: currentActive.id,
              sourceStart: 0,
              sourceEnd: decoded.duration,
              projectStart: 0,
              projectDuration: decoded.duration,
              gain: 1.0,
            },
          ],
        };

        setTracks((prev) => prev.map((t) => (t.id === updatedTrack.id ? updatedTrack : t)));
        setWorkingAudioBuffer(decoded);
        setCurrentTime(0);
        setViewOffset(0);
        setIsPlaying(false);
        audioEngine.stop();

        showOperationFeedback({
          title: 'Audiodatei verknüpft',
          operationType: 'CUE',
          description: `Audiodatei "${file.name}" erfolgreich mit Track "${updatedTrack.title}" verknüpft (${decoded.duration.toFixed(2)}s, ${decoded.sampleRate}Hz). Echte Audiodaten sind jetzt im Player aktiv.`,
          timeRangeSec: { start: 0, end: decoded.duration, duration: decoded.duration },
          originalSha256: sha256,
          timestamp: Date.now(),
        });
      } else {
        // Create new track from imported audio
        const detectedBpm = estimateBpm(decoded);
        const newTrack: TrackModel = {
          id: `track-${Date.now()}`,
          title: file.name.replace(/\.[^/.]+$/, ''),
          artist: 'User Import',
          album: 'Single',
          bpm: detectedBpm,
          key: '2A',
          duration: decoded.duration,
          sampleRate: decoded.sampleRate,
          channels: decoded.numberOfChannels,
          originalSha256: sha256,
          isOriginalUntouched: true,
          audioBuffer: decoded,
          beatGrid: buildBeatGridFromTempo(0.0, detectedBpm, decoded.duration),
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
          phrases: generateRekordboxPhrases(detectedBpm, decoded.duration),
          origin: DataOrigin.LOCAL_ANALYSIS,
          originalMedia: {
            location: file.name,
            resolvedPath: file.name,
            accessMode: 'READ_ONLY',
            status: 'AVAILABLE',
            size: file.size,
            modifiedAt: file.lastModified,
          },
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

        // If the only track was the synthetic default demo, replace it
        setTracks((prev) => {
          const nonDemo = prev.filter((t) => t.id !== 'track-default-quicksand');
          return [newTrack, ...nonDemo];
        });
        setActiveTrackId(newTrack.id);
        setWorkingAudioBuffer(decoded);
        setCurrentTime(0);
        setViewOffset(0);
        setIsPlaying(false);
        audioEngine.stop();

        showOperationFeedback({
          title: 'Audiodatei importiert',
          operationType: 'CUE',
          description: `Track "${newTrack.title}" erfolgreich decodiert (${decoded.duration.toFixed(2)}s, ${decoded.sampleRate}Hz, ${decoded.numberOfChannels} Kanäle, ${detectedBpm} BPM). Echte Audiodaten geladen.`,
          timeRangeSec: { start: 0, end: decoded.duration, duration: decoded.duration },
          originalSha256: sha256,
          timestamp: Date.now(),
        });
      }
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

  // Drag & drop file handler (accepts Rekordbox XML, ANLZ analysis, and audio files)
  const handleDropFile = (file: File) => {
    const nameLower = file.name.toLowerCase();
    if (nameLower.endsWith('.xml')) {
      loadXmlFile(file);
    } else if (
      nameLower.endsWith('.dat') ||
      nameLower.endsWith('.ext') ||
      nameLower.endsWith('.2ex') ||
      nameLower.endsWith('.anlz')
    ) {
      handleImportAnlzFile(file);
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
      alert(`Dateityp "${file.name}" wird nicht unterstützt. Bitte Rekordbox XML (.xml), ANLZ (.dat, .ext, .2ex) oder Audio (.wav, .mp3, .flac) verwenden.`);
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
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyX') {
        e.preventDefault();
        handleCut();
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
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        // Single-key shortcuts when not typing in an input
        const target = e.target as HTMLElement | null;
        const isInputField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (!isInputField) {
          if (e.code === 'KeyE') {
            e.preventDefault();
            setEditPaletteOpen((prev) => !prev);
          } else if (e.code === 'KeyP') {
            e.preventDefault();
            setPaletteOpen((prev) => !prev);
          } else if (e.code === 'KeyM') {
            e.preventDefault();
            handleToggleMaxWaveform();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  // Action: Open a completely clean, empty project
  const handleNewProject = useCallback(() => {
    setProjectName('New Project');
    setTracks([]);
    setActiveTrackId('');
    setWorkingAudioBuffer(null);
    setPaletteClips([]);
    setSelection(null);
    setCurrentTime(0);
    setViewOffset(0);
    setViewDuration(16.0);
    setUndoStack([]);
    setRedoStack([]);
    audioEngine.stop();
    setIsPlaying(false);
  }, []);

  // Track context exposed to AI Copilot
  const chatbotTrackContext: TrackEditorContext = useMemo(() => {
    const secPerBeat = activeTrack?.bpm ? 60 / activeTrack.bpm : 0.5;
    const secPerBar = secPerBeat * 4;
    const currentBar = Math.floor(currentTime / secPerBar) + 1;
    const currentBeat = Math.floor(currentTime / secPerBeat) + 1;

    // Automated Rekordbox-compatible Mix-In & phrase energy analysis
    const mixInAnalysis = activeTrack ? analyzeTrackForMixIn(activeTrack) : undefined;

    return {
      title: activeTrack?.title,
      artist: activeTrack?.artist,
      bpm: activeTrack?.bpm,
      key: activeTrack?.key,
      duration: activeTrack?.duration,
      currentTime,
      currentBar,
      hasSelection: selection !== null && selection.duration > 0,
      selectionStart: selection?.start,
      selectionEnd: selection?.end,
      selectionBeats: selection?.beatsCount,
      selectionBars: selection?.barsCount,
      hasClipboard: clipboardBuffer !== null,
      quantize,
      waveformMode,
      paletteClipsCount: paletteClips.length,
      undoCount: undoStack.length,
      redoCount: redoStack.length,
      mixInAnalysis,
    };
  }, [
    activeTrack,
    currentTime,
    selection,
    clipboardBuffer,
    quantize,
    waveformMode,
    paletteClips.length,
    undoStack.length,
    redoStack.length,
  ]);

  // Execute AI Copilot proposed actions
  const handleExecuteChatbotAction = useCallback(
    (action: ChatbotAction) => {
      logger.info('CHATBOT', `Copilot Aktion wird ausgeführt: ${action.type}`, action.params);
      switch (action.type) {
        case 'SET_MIX_IN_POINT': {
          if (!activeTrack) return;
          const bpm = activeTrack.bpm || 130.0;
          const secPerBeat = 60 / bpm;
          const secPerBar = secPerBeat * 4;

          let mixTime = action.params.time;
          let mixBar = action.params.bar;

          if (typeof mixTime !== 'number' && typeof mixBar === 'number') {
            mixTime = (mixBar - 1) * secPerBar;
          } else if (typeof mixTime === 'number' && typeof mixBar !== 'number') {
            mixBar = Math.floor(mixTime / secPerBar) + 1;
          } else if (typeof mixTime !== 'number' && typeof mixBar !== 'number') {
            mixTime = currentTime;
            mixBar = Math.floor(mixTime / secPerBar) + 1;
          }

          const safeMixTime = Math.max(0, Math.min(activeTrack.duration, mixTime!));
          const safeMixBar = Math.max(1, mixBar || 1);
          const cueSlot = action.params.cueSlot || 'A';
          const cueName = action.params.cueName || `MIX-IN ${safeMixBar}.1`;

          // 1. Seek playhead to exact beat
          handleSeek(safeMixTime);
          pushHistorySnapshot('Set Mix-In Point');

          // 2. Set or update Hot Cue
          const existingCueIdx = activeTrack.cues.findIndex(
            (c) => (c.type === 'HOT_CUE' && c.letter === cueSlot) || (c.name && c.name.startsWith('MIX-IN'))
          );

          const hotCueNumber =
            cueSlot === 'A' ? 0 : cueSlot === 'B' ? 1 : cueSlot === 'C' ? 2 : cueSlot === 'D' ? 3 : 0;

          const newCue = {
            id: `cue-mixin-${Date.now()}`,
            name: cueName,
            type: (cueSlot === 'MEMORY' ? 'MEMORY' : 'HOT_CUE') as any,
            hotCueNum: cueSlot === 'MEMORY' ? undefined : hotCueNumber,
            letter: cueSlot === 'MEMORY' ? undefined : cueSlot,
            position: safeMixTime,
            inMsec: Math.round(safeMixTime * 1000),
            barNumber: safeMixBar,
            beatNumber: 1,
            comment: action.params.description || `Optimaler Mix-In Punkt (Takt ${safeMixBar})`,
            color: '#10b981', // Rekordbox Green
            origin: DataOrigin.USER_EDIT,
          };

          if (existingCueIdx >= 0) {
            activeTrack.cues[existingCueIdx] = newCue;
          } else {
            activeTrack.cues.push(newCue);
          }
          setTracks([...tracks]);

          // 3. Set zoom preset
          if (action.params.zoomPreset) {
            handleSelectZoomPreset(action.params.zoomPreset);
          } else {
            handleSelectZoomPreset('16_BARS');
          }

          // 4. Select the transition loop phrase (e.g. 16 or 32 bars)
          const selectBars = action.params.selectBars || 16;
          const dur = selectBars * secPerBar;
          const selEnd = Math.min(activeTrack.duration, safeMixTime + dur);
          setSelection({
            start: safeMixTime,
            end: selEnd,
            duration: selEnd - safeMixTime,
            startBeat: Math.round(safeMixTime / secPerBeat),
            endBeat: Math.round(selEnd / secPerBeat),
            barsCount: selectBars,
            beatsCount: selectBars * 4,
          });

          // 5. Operation Feedback Modal
          showOperationFeedback({
            title: `Optimaler Mix-In Punkt verankert (Hot Cue ${cueSlot})`,
            operationType: 'INSERT',
            description: `Playhead auf Takt ${safeMixBar}.1 (${safeMixTime.toFixed(2)}s) positioniert, Hot Cue ${cueSlot} zugewiesen und ${selectBars} Takte Übergangsfenster selektiert.`,
            timeRangeSec: { start: safeMixTime, end: selEnd, duration: selEnd - safeMixTime },
            barsCount: selectBars,
            beatsCount: selectBars * 4,
            originalSha256: activeTrack.originalSha256,
            timestamp: Date.now(),
          });
          break;
        }
        case 'SET_ZOOM':
          if (action.params.preset) {
            handleSelectZoomPreset(action.params.preset);
          } else if (action.params.bars) {
            handleSelectZoomPreset(`${action.params.bars}_BARS` as any);
          }
          break;
        case 'SEEK_TO':
          if (typeof action.params.time === 'number') {
            handleSeek(action.params.time);
          }
          break;
        case 'SELECT_RANGE':
          if (activeTrack) {
            const secPerBeat = 60 / activeTrack.bpm;
            const beats = action.params.beats || 16;
            const dur = beats * secPerBeat;
            const start = action.params.start ?? currentTime;
            const end = Math.min(activeTrack.duration, start + dur);
            setSelection({
              start,
              end,
              duration: end - start,
              startBeat: Math.round(start / secPerBeat),
              endBeat: Math.round(end / secPerBeat),
              barsCount: Math.max(1, Math.round(beats / 4)),
              beatsCount: beats,
            });
          }
          break;
        case 'ADD_CUE':
          handleAddCue(action.params.time ?? currentTime);
          break;
        case 'ADD_MEMORY_CUE':
          handleAddMemoryCue();
          break;
        case 'SHIFT_BEATGRID':
          handleShiftBeatgrid(action.params.deltaSeconds ?? 0.005);
          break;
        case 'AUTO_ALIGN_GRID':
          handleAutoAlignBeatgrid();
          break;
        case 'SET_QUANTIZE':
          setQuantize(action.params.enabled ?? true);
          break;
        case 'SET_WAVEFORM_MODE':
          if (action.params.mode) {
            setWaveformMode(action.params.mode);
          }
          break;
        case 'ADD_TO_PALETTE':
          if (selection) {
            handleAddSelectionToPalette();
          }
          break;
        case 'PERFORM_EDIT':
          switch (action.params.operation) {
            case 'COPY': handleCopy(); break;
            case 'CUT': handleCut(); break;
            case 'PASTE': handlePaste(); break;
            case 'DELETE': handleDelete(); break;
            case 'CLEAR': handleClear(); break;
            case 'REPLACE': handleReplace(); break;
            case 'OVERDUB': handleOverdub(); break;
          }
          break;
      }
    },
    [
      activeTrack,
      currentTime,
      selection,
      tracks,
      handleSelectZoomPreset,
      handleSeek,
      handleAddCue,
      handleAddMemoryCue,
      handleShiftBeatgrid,
      handleAutoAlignBeatgrid,
      handleAddSelectionToPalette,
      handleCopy,
      handleCut,
      handlePaste,
      handleDelete,
      handleClear,
      handleReplace,
      handleOverdub,
      pushHistorySnapshot,
      showOperationFeedback,
    ]
  );

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
        onNewProject={handleNewProject}
        onSaveProject={handleSaveProject}
        onOpenProject={handleOpenProject}
        onImportXml={() => xmlFileInputRef.current?.click()}
        onImportAudio={() => audioFileInputRef.current?.click()}
        onExportWav={() => setExportModalOpen(true)}
        onExportXml={() => setExportModalOpen(true)}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        waveformMode={waveformMode}
        onSetWaveformMode={setWaveformMode}
        paletteOpen={paletteOpen}
        onTogglePalette={() => setPaletteOpen(!paletteOpen)}
        editPaletteOpen={editPaletteOpen}
        onToggleEditPalette={() => setEditPaletteOpen(!editPaletteOpen)}
        onMaximizeWaveform={handleToggleMaxWaveform}
        browserOpen={browserOpen}
        onToggleBrowser={() => setBrowserOpen(!browserOpen)}
        chatbotOpen={chatbotOpen}
        onToggleChatbot={() => setChatbotOpen(!chatbotOpen)}
        onLoadDemoTrack={handleLoadDemoTrack}
        onShowInfo={() => setInfoModalOpen(true)}
        onOpenDatabaseInspector={() => setDbExtractionModalOpen(true)}
        onOpenXmlCollection={() => setXmlCollectionModalOpen(true)}
        onOpenSystemLogs={() => setSystemLogModalOpen(true)}
        onClearHistory={() => setClearHistoryModalOpen(true)}
        hasHistory={undoStack.length > 0 || redoStack.length > 0}
        onCopy={handleCopy}
        onCut={handleCut}
        onPaste={handlePaste}
        onDelete={handleDelete}
        hasSelection={selection !== null && selection.duration > 0}
        hasClipboard={clipboardBuffer !== null}
        onOpenEditAssistant={() => setEditAssistantModalOpen(true)}
        onAnalyzeMixIn={() => setChatbotOpen(true)}
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
        onNewProject={() => setProjectName('New Project')}
        onSaveProject={handleSaveProject}
        onExport={() => setExportModalOpen(true)}
        onShowInfo={() => setInfoModalOpen(true)}
        onOpenSettings={() => setSettingsModalOpen(true)}
        masterVolume={masterVolume}
        onMasterVolumeChange={handleMasterVolumeChange}
        meterL={meterL}
        meterR={meterR}
        paletteViewMode={paletteViewMode}
        onTogglePaletteViewMode={() =>
          setPaletteViewMode((prev) => (prev === 'FULL_DECK' ? 'SIDEBAR' : 'FULL_DECK'))
        }
        bottomControlOpen={editPaletteOpen}
        onToggleBottomControl={() => setEditPaletteOpen(!editPaletteOpen)}
        paletteOpen={paletteOpen}
        onTogglePalette={() => setPaletteOpen(!paletteOpen)}
        isMaxWaveform={isMaxWaveform}
        onToggleMaxWaveform={handleToggleMaxWaveform}
        stemVolumes={stemVolumes}
        stemIds={stemIds}
        onStemVolumeChange={handleStemVolumeChange}
        trackHasStems={!!(activeTrack && activeTrack.stems && activeTrack.stems.length > 0)}
      />

      {/* 4. Track Header & Overview Waveform (Authentic Pioneer DJ Header) */}
      <TrackHeader
        track={activeTrack}
        currentTime={currentTime}
        viewOffset={viewOffset}
        viewDuration={viewDuration}
        onSeek={handleSeek}
        onPanView={handlePanView}
        onSeparateStems={handleSeparateStems}
        isSeparating={isSeparating}
        stemVolumes={stemVolumes}
        stemIds={stemIds}
        stemProgress={stemProgress}
        stemStatus={stemStatus}
        onCancelSeparation={handleCancelSeparation}
        onStemVolumeChange={handleStemVolumeChange}
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
          onSelectZoomPreset={handleSelectZoomPreset}
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
          onSetFirstBeatHere={handleSetFirstBeatHere}
          onShiftBeatgrid={handleShiftBeatgrid}
          onAutoAlignBeatgrid={handleAutoAlignBeatgrid}
          onOpenDatabaseInspector={() => setDbExtractionModalOpen(true)}
          onImportXmlClick={() => xmlFileInputRef.current?.click()}
          onLoadAudioClick={() => audioFileInputRef.current?.click()}
          onDropFile={handleDropFile}
        />

        {/* Palette Panel (Screenshot 01 vs Screenshot 02) */}
        {paletteViewMode === 'SIDEBAR' && (
          <PalettePanel
            isOpen={paletteOpen}
            onToggle={() => setPaletteOpen(!paletteOpen)}
            clips={paletteClips}
            onAddFromSelection={handleAddSelectionToPalette}
            onDeleteClip={(id) => {
              setPaletteClips((prev) => prev.filter((c) => c.id !== id));
              if (selectedClipId === id) setSelectedClipId(null);
            }}
            onSelectClip={(clip) => setSelectedClipId(clip.id)}
            selectedClipId={selectedClipId}
            hasSelection={selection !== null && selection.duration > 0}
            onExpandToDeckView={() => setPaletteViewMode('FULL_DECK')}
            matchPitch={matchPitchOnInsert}
            onToggleMatchPitch={setMatchPitchOnInsert}
            targetBpm={activeTrack?.bpm}
            targetKey={activeTrack?.key}
          />
        )}

        {/* Collapsible AI Copilot Assistant Palette */}
        <ChatbotPalette
          isOpen={chatbotOpen}
          onClose={() => setChatbotOpen(false)}
          trackContext={chatbotTrackContext}
          onExecuteAction={handleExecuteChatbotAction}
          onSelectZoomPreset={handleSelectZoomPreset}
        />
      </div>

      {/* Full Deck View (Expanded Clip Library Deck B) */}
      {paletteViewMode === 'FULL_DECK' && (
        <div className="h-56 flex flex-col flex-shrink-0 z-30 shadow-2xl">
          <ClipDeckView
            clips={paletteClips}
            activeClipId={selectedClipId}
            onSelectClip={(clip) => setSelectedClipId(clip.id)}
            onDeleteClip={(id) => {
              setPaletteClips((prev) => prev.filter((c) => c.id !== id));
              if (selectedClipId === id) setSelectedClipId(null);
            }}
            onAddFromSelection={handleAddSelectionToPalette}
            hasSelectionInDeckA={selection !== null && selection.duration > 0}
            activeTrack={activeTrack}
            matchPitch={matchPitchOnInsert}
            onToggleMatchPitch={setMatchPitchOnInsert}
            onInsertClipToDeckA={handleInsertClipToDeckA}
            onReplaceDeckAWithClip={handleReplaceDeckAWithClip}
            onOverdubDeckAWithClip={handleOverdubDeckAWithClip}
            onCloseDeckView={() => setPaletteViewMode('SIDEBAR')}
            waveformMode={waveformMode}
          />
        </div>
      )}

      {/* 6. Lower Action Block: BEAT SELECT | SELECT | EDIT (Screenshots 01, 02, 03) */}
      <BottomControlBlock
        selection={selection}
        onBeatSelect={handleBeatSelect}
        onHalfSelection={handleHalfSelection}
        onDoubleSelection={handleDoubleSelection}
        onCancelSelection={handleCancelSelection}
        onClone={handleAddSelectionToPalette}
        onCopy={handleCopy}
        onCut={handleCut}
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
        matchPitch={matchPitchOnInsert}
        onToggleMatchPitch={setMatchPitchOnInsert}
        targetKey={activeTrack?.key}
        onClearHistory={() => setClearHistoryModalOpen(true)}
        onOpenEditAssistant={() => setEditAssistantModalOpen(true)}
        isOpen={editPaletteOpen}
        onToggle={() => setEditPaletteOpen(!editPaletteOpen)}
      />

      {/* 7. Bottom Strip: BROWSER tab, Pioneer Rekordbox branding & Track Collection */}
      <BrowserMultiTrackBar
        isOpen={browserOpen}
        onToggle={() => setBrowserOpen(!browserOpen)}
        tracks={tracks}
        activeTrackId={activeTrackId}
        onSelectTrack={(id) => {
          setActiveTrackId(id);
          const t = tracks.find((tr) => tr.id === id);
          if (t && t.audioBuffer) {
            setWorkingAudioBuffer(t.audioBuffer);
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
      <WorkspaceSettingsModal
        isOpen={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        onShowInfo={() => setInfoModalOpen(true)}
        onOpenDatabaseInspector={() => setDbExtractionModalOpen(true)}
        onOpenSystemLogs={() => setSystemLogModalOpen(true)}
        onClearHistory={() => setClearHistoryModalOpen(true)}
        onAutoCue={() => {
          handleAutoCue();
          setSettingsModalOpen(false);
        }}
        waveformMode={waveformMode}
        onSetWaveformMode={setWaveformMode}
        snapToBeatgrid={snapToBeatgrid}
        onSetSnapToBeatgrid={setSnapToBeatgrid}
        autoScroll={autoScroll}
        onSetAutoScroll={setAutoScroll}
        highQualityRendering={highQualityRendering}
        onSetHighQualityRendering={setHighQualityRendering}
      />
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
            clips={paletteClips}
            workingAudioBuffer={workingAudioBuffer}
            protectedPaths={protectedPaths}
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

      {/* Clear History Confirmation Modal (Data Loss Prevention) */}
      <ClearHistoryModal
        isOpen={clearHistoryModalOpen}
        onClose={() => setClearHistoryModalOpen(false)}
        onConfirm={handleClearHistoryConfirm}
        undoCount={undoStack.length}
        redoCount={redoStack.length}
        recentActions={[...undoStack, ...redoStack].slice(-6).map((s) => s.description)}
      />

      {/* Edit Assistant Diagnostic & Buffer Integrity Modal */}
      <EditAssistantModal
        isOpen={editAssistantModalOpen}
        onClose={() => setEditAssistantModalOpen(false)}
        lastValidation={editAssistantState.lastValidation}
        summary={editAssistantSummary}
        autoCorrect={editAssistantState.autoCorrect}
        onToggleAutoCorrect={(enabled) => editAssistant.setAutoCorrect(enabled)}
      />
    </div>
  );
}
