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
  BeatGrid,
} from './types/rekordbox';
import { mapRekordboxDatabaseRows } from './rekordbox/dbParser';
import {
  buildDbAnalysisIndex,
  buildDbAnalysisIdIndex,
  dirOfPath,
  normalizeAudioKey,
  resolveAnalysisFilePath,
  resolveVerifiedDbIdentity,
  DbAnalysisRef,
} from './rekordbox/analysisResolver';
import { analyzeAudioBuffer, extractMiniPeaks } from './waveform/analyzer';
import {
  describeProjection,
  projectTrackEdits,
  rebaseTrackAnalysis,
  toSpanViews,
  waveformOriginAfterEdit,
  createSegment,
  type ProjectedSpanView,
  type TrackProjection,
} from './edit/editModel';
import {
  extendGridAcrossGap,
  locateSpan,
  mapWindowToSourceWindow,
  projectEditTimeline,
  retimeBeatNodes,
  retimeCues,
  retimeLoops,
  retimePhrases,
  type StructuralEditDelta,
} from './edit/editTimeline';
import { describeEditWaveform } from './edit/editWaveform';
import { clipPreviewProfile, describePreviewOrigin, type PreviewProfile } from './waveform/preview';
import { isFileDrag, isInternalDrag } from './dnd/dragPayload';
import { planClipDrop } from './edit/editDrop';
import { audioEngine } from './audio/audioEngine';
import {
  parseRekordboxXmlAsync,
  XmlImportProgress,
  buildBeatGridFromTempo,
} from './rekordbox/xmlParser';
import { applyAnlzExtractionToTrack, AnlzExtractionResult } from './rekordbox/databaseExtractor';
import { loadAnlzContainerSet } from './rekordbox/analysisContainerLoader';
import { initFileLogging } from './utils/fileLog';
import { adoptSerializedGrid, describeGridEdit, ensureArrayBuffer, isRekordboxOrigin, ppthMismatchNote, shiftBeatNodes } from './rekordbox/trackGuards';
import { logger } from './utils/logger';
import { nextId } from './utils/ids';
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
  // One id source for the whole app: a timestamp is only probably unique and is a
  // separate read per field, which is how a track and its segments once disagreed.
  const id = pt.id || nextId(origin === DataOrigin.REKORDBOX_DB ? 'rb-db' : 'rb-xml');
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
    beatGrid: pt.beatGrid || (isRekordboxOrigin(origin)
      ? { firstBeat: 0, bpm, meter: 4, beats: [], origin }
      : buildBeatGridFromTempo(0.0, bpm, duration, 4, origin)),
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

// Deck-loader guards (isRekordboxOrigin, waveform-source rule, grid-shift,
// PPTH plausibility, serialized-grid adoption) live in ./rekordbox/trackGuards
// as pure, unit-tested helpers.

/**
 * Resolves the ANLZ analysis file referenced by a Rekordbox database track
 * (AnalysisDataPath) and merges it into the track. Missing paths and read
 * failures are pipeline errors: the caller must never substitute other data.
 */
async function tryAutoLoadAnlz(track: TrackModel): Promise<TrackModel> {
  const anlzPath = track.rawXmlAttributes?.analysisDataPath?.trim();
  if (!anlzPath) throw new Error(`[ANLZ Pipelinefehler] master.db lieferte für „${track.title}“ keinen AnalysisDataPath.`);
  if (!window.rekordboxDesktop) throw new Error('[ANLZ Pipelinefehler] Die Rekordbox-Desktop-Bridge ist nicht verfügbar.');
  const sourceDbDir = track.rawXmlAttributes?.sourceDbDir;
  // Deterministic resolution only: <dbDir>/share/PIONEER/USBANLZ/... or a
  // verbatim absolute path. There is no scan, fallback, or manual assignment.
  const resolved = resolveAnalysisFilePath(sourceDbDir, anlzPath);
  logger.info('DATABASE', `[ANLZ Auto] Auflösung „${track.title}"`, {
    analysisDataPath: anlzPath,
    sourceDbDir: sourceDbDir ?? null,
    resolved: resolved ?? null,
  });
  if (!resolved) {
    const message =
      `[ANLZ Pipelinefehler] AnalysisDataPath „${anlzPath}“ konnte nicht gegen das ` +
      `DB-Verzeichnis „${sourceDbDir || '(leer)'}“ aufgelöst werden.`;
    logger.error('DATABASE', message, { analysisDataPath: anlzPath, sourceDbDir: sourceDbDir ?? null });
    throw new Error(message);
  }
  const variantSummary = (e: AnlzExtractionResult) =>
    e.waveformVariants.map((v) => ({ tag: v.sourceTag, buckets: v.length }));
  try {
    const loadedSet = await loadAnlzContainerSet(
      resolved,
      (filePath) => window.rekordboxDesktop!.readAnalysisFile(filePath)
    );
    const extraction = loadedSet.extraction;
    logger.info('DATABASE', '[ANLZ Auto] Primärcontainer gelesen', {
      path: loadedSet.primary.path,
      bytes: loadedSet.primary.size ?? null,
      tags: loadedSet.primary.extraction.tagsFound.join(','),
      waveformVariants: variantSummary(loadedSet.primary.extraction),
    });
    if (loadedSet.datExtSibling) {
      logger.info('DATABASE', '[ANLZ Auto] Schwesterdatei gelesen & gemergt', {
        path: loadedSet.datExtSibling.path,
        bytes: loadedSet.datExtSibling.size ?? null,
        tags: loadedSet.datExtSibling.extraction.tagsFound.join(','),
        waveformVariants: variantSummary(loadedSet.datExtSibling.extraction),
      });
    }
    if (loadedSet.twoExSibling) {
      logger.info('DATABASE', '[ANLZ Auto] 2EX-Schwesterncontainer gelesen', {
        path: loadedSet.twoExSibling.path,
        bytes: loadedSet.twoExSibling.size ?? null,
        tags: loadedSet.twoExSibling.extraction.tagsFound.join(','),
        waveformVariants: variantSummary(loadedSet.twoExSibling.extraction),
      });
    } else if (loadedSet.twoExError) {
      logger.info('DATABASE', '[ANLZ Auto] Kein lesbarer 2EX-Schwesterncontainer; vorhandene DAT/EXT-Werte bleiben unverändert.', {
        path: resolved.replace(/\.[A-Za-z0-9]+$/, '.2EX'),
        reason: loadedSet.twoExError,
      });
    }
    const merged = applyAnlzExtractionToTrack(track, extraction);
    // Plausibility guard: the PPTH source path should reference the same audio file.
    const expected = track.originalMedia?.resolvedPath || track.originalMedia?.location || '';
    const ppthNote = ppthMismatchNote(extraction.analysisPath, expected);
    if (ppthNote) {
      logger.warn('DATABASE', `[ANLZ Auto] ${ppthNote}`, { analysisPath: extraction.analysisPath, expected });
      if (merged.databaseRecord) {
        merged.databaseRecord.anlzWarnings = [...(merged.databaseRecord.anlzWarnings ?? []), ppthNote];
      }
    }
    logger.info('DATABASE', '[ANLZ Auto] Übernommen', {
      title: track.title,
      waveform: merged.analysis ? `${merged.analysis.sourceTag ?? 'ANLZ'}:${merged.analysis.length}` : null,
      waveformVariants: merged.analysisVariants?.length ?? 0,
      beatGridOrigin: merged.beatGrid.origin,
      beatNodes: merged.beatGrid.beats?.length ?? 0,
      cues: merged.cues.length,
      loops: merged.loops.length,
      phrases: merged.phrases?.length ?? 0,
      warnings: extraction.warnings,
    });
    if (!merged.analysis || merged.analysis.length === 0) {
      throw new Error(
        `[ANLZ Pipelinefehler] Rekordbox-Container „${resolved}“ enthält keine lesbare PWAV/PWV-Wellenform. ` +
        `Gefundene Tags: ${extraction.tagsFound.join(', ') || '(keine)'}.`
      );
    }
    logger.info('DATABASE', `[ANLZ Auto] ${resolved} → ${extraction.tagsFound.join(', ')}`);
    return merged;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('DATABASE', '[ANLZ Auto] Direkter Rekordbox-Analysepfad fehlgeschlagen.', {
      resolved,
      error: message,
    });
    throw error instanceof Error ? error : new Error(message);
  }
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
      ...(seg.sourceTrackId ? { sourceTrackId: seg.sourceTrackId } : {}),
      ...(seg.sourceClipStart !== undefined ? { sourceClipStart: seg.sourceClipStart } : {}),
      ...(seg.tempoRatio !== undefined ? { tempoRatio: seg.tempoRatio } : {}),
      ...(seg.pitchShift !== undefined ? { pitchShift: seg.pitchShift } : {}),
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
    // Verbatim adoption of persisted nodes (grid origin included); a uniform
    // rebuild happens only for projects saved before beat persistence.
    beatGrid: adoptSerializedGrid(st.beatGrid, st.duration, st.origin),
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
  const [paletteViewMode, setPaletteViewMode] = useState<'SIDEBAR' | 'FULL_DECK'>('SIDEBAR');
  const [matchPitchOnInsert, setMatchPitchOnInsert] = useState<boolean>(true);

  // Clipboard for Copy / Paste / Insert
  const [clipboardBuffer, setClipboardBuffer] = useState<AudioBuffer | null>(null);

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

  // Deterministic XML→DB analysis index: normalized audio path → ANLZ
  // reference (exact match only, rebuilt on every database import).
  const dbAnalysisIndexRef = useRef<Map<string, DbAnalysisRef>>(new Map());
  // Guarded Rekordbox 7.2.16 identity index: XML TrackID must resolve to one
  // desktop djmdContent.ID and the exact canonical media path must also match.
  const dbAnalysisIdIndexRef = useRef<Map<string, DbAnalysisRef>>(new Map());
  // Every caller awaits the same master.db read. A second deck-load must never
  // observe an empty, half-built index while the first read is still running.
  const dbIndexLoadPromiseRef = useRef<Promise<Map<string, DbAnalysisRef>> | null>(null);
  const dbIndexDiagRef = useRef<{
    attempts: number;
    found: number;
    readable: number;
    links: number;
    reasons: string[];
  }>({ attempts: 0, found: 0, readable: 0, links: 0, reasons: [] });

  // Auto-populate the XML→DB ANLZ index directly from the local Rekordbox
  // databases (master.db / exportLibrary.db) without manual user assignment.
  // This fulfills REKORDBOX_XML → Waveform ausschließlich aus ANLZ/DB:
  // the Desktop bridge scans %APPDATA%/Pioneer/rekordbox* read-only and the
  // renderer builds the exact-match audio-path → AnalysisDataPath map.
  const loadDbAnalysisIndex = useCallback(async () => {
    if (dbAnalysisIndexRef.current.size > 0) return dbAnalysisIndexRef.current;
    const diag = dbIndexDiagRef.current;
    // A failed first attempt (module not ready at boot, DB mounted late, …)
    // gets exactly one retry; a successful read is never repeated.
    if (diag.attempts >= (diag.readable > 0 ? 1 : 2)) {
      return dbAnalysisIndexRef.current;
    }
    if (!window.rekordboxDesktop) return dbAnalysisIndexRef.current;
    diag.attempts += 1;
    try {
      const candidates = await window.rekordboxDesktop.locateRekordboxDatabases();
      if (!candidates || candidates.length === 0) {
        diag.found = 0;
        diag.reasons = ['Keine lokale master.db/exportLibrary.db gefunden.'];
        logger.error('DATABASE', '[DB Auto] Keine lokale Rekordbox-Datenbank gefunden (master.db / exportLibrary.db) — ein XML-Track kann nicht geladen werden', {
          hint: 'Rekordbox-Version und Bibliotheksort prüfen (Standard: %APPDATA%/Pioneer, verschoben: rekordboxAgent/options.json)',
        });
        return dbAnalysisIndexRef.current;
      }
      diag.found = candidates.length;
      for (const cand of candidates) {
        try {
          const result = await window.rekordboxDesktop.readRekordboxDatabase(cand.path);
          if (!result.available || !result.rows) {
            diag.reasons.push(`${cand.label || cand.path}: ${result.reason || 'nicht lesbar'}`);
            logger.warn('DATABASE', `[DB Auto] ${cand.path}: nicht lesbar`, {
              reason: result.reason || 'nicht lesbar',
              label: cand.label ?? null,
              appVer: cand.appVer ?? null,
            });
            continue;
          }
          // XML tracks are linked only to the desktop master.db. Device
          // Library Plus/OneLibrary has a distinct identity namespace.
          if (result.dbType !== 'MASTER_DB') continue;
          diag.readable += 1;
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
            'MASTER_DB'
          );
          const sourceDbDir = dirOfPath(cand.path);
          const fullTrackModels = mapped.tracks.map((track, idx) => {
            track.rawXmlAttributes = { ...(track.rawXmlAttributes ?? {}), sourceDbDir };
            return buildCollectionTrackModel(track, idx, DataOrigin.REKORDBOX_DB);
          });
          const built = buildDbAnalysisIndex(fullTrackModels, sourceDbDir);
          // Merge – keep first entry on duplicate keys (earliest DB wins)
          let added = 0;
          for (const [k, v] of built) {
            if (!dbAnalysisIndexRef.current.has(k)) {
              dbAnalysisIndexRef.current.set(k, v);
              added++;
            }
          }
          const builtIds = buildDbAnalysisIdIndex(fullTrackModels, sourceDbDir);
          for (const [id, ref] of builtIds) {
            if (!dbAnalysisIdIndexRef.current.has(id)) dbAnalysisIdIndexRef.current.set(id, ref);
          }
          logger.info('DATABASE', `[DB Auto] ${cand.path}: ${mapped.stats.tracks} Tracks, ${added} ANLZ-Links`, { dbType: result.dbType, appVer: cand.appVer ?? null });
          if (mapped.warnings?.length || result.warnings?.length) {
            logger.warn('DATABASE', '[DB Auto] Hinweise aus der Datenbank-Einlesung', {
              mapping: [...(mapped.warnings || [])],
              datei: [...(result.warnings || [])],
            });
          }
          // One exact desktop library owns the XML identity namespace. Never
          // merge rows from another discovered master.db into this index.
          break;
        } catch (e) {
          diag.reasons.push(`${cand.path}: ${e instanceof Error ? e.message : String(e)}`);
          logger.warn('DATABASE', `[DB Auto] Fehler bei ${cand.path}`, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } catch (e) {
      diag.reasons.push(`locateRekordboxDatabases: ${e instanceof Error ? e.message : String(e)}`);
      logger.warn('DATABASE', '[DB Auto] Datenbank-Suche fehlgeschlagen', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    diag.links = dbAnalysisIndexRef.current.size;
    return dbAnalysisIndexRef.current;
  }, []);

  const ensureDbAnalysisIndex = useCallback(async () => {
    if (dbAnalysisIndexRef.current.size > 0) return dbAnalysisIndexRef.current;
    if (dbIndexLoadPromiseRef.current) return dbIndexLoadPromiseRef.current;
    const request = loadDbAnalysisIndex();
    dbIndexLoadPromiseRef.current = request;
    try {
      return await request;
    } finally {
      dbIndexLoadPromiseRef.current = null;
    }
  }, [loadDbAnalysisIndex]);

  /** Activates a loaded track in Deck A and (re)builds its project projection. */
  const loadTrackIntoDeck = (track: TrackModel) => {
    setActiveTrackId(track.id);
    resetEditProjection();
    syncEditProjection(track);
    setCurrentTime(0);
    setViewOffset(0);
    setSelection(null);
    setIsPlaying(false);
    audioEngine.stop();
  };

  // Active track helper (supports empty state)
  const activeTrack = tracks.find((t) => t.id === activeTrackId) || tracks[0] || null;

  // ── Follow-up state of an edit: one derivation for audio + waveform ──────
  // The edit list on the track is the single source of truth. After every edit
  // (and after Undo/Redo or a re-opened project) the SAME derivation produces the
  // working audio, the projected waveform and the project duration, so no view
  // can contradict the audio. Untouched material keeps its stored ANLZ columns;
  // only genuinely new material is analysed (and is labelled as such).
  const tracksRef = useRef<TrackModel[]>(tracks);
  tracksRef.current = tracks;
  const paletteClipsRef = useRef<PaletteClip[]>(paletteClips);
  paletteClipsRef.current = paletteClips;
  const projectionRef = useRef<TrackProjection | null>(null);
  const [spanViews, setSpanViews] = useState<ProjectedSpanView[]>([]);
  /** Copied material keeps its source window, so it can reuse stored columns. */
  const [clipboardSource, setClipboardSource] = useState<{
    trackId: string;
    sourceStart: number;
    duration: number;
    via: 'original' | 'clip';
  } | null>(null);

  /**
   * Re-derives the deck's project state from its edit list and publishes it to
   * every view (audio, waveform, duration, provenance telemetry, edit blocks).
   */
  const syncEditProjection = useCallback((track: TrackModel | null): TrackProjection | null => {
    if (!track) return null;
    const projection = projectTrackEdits(track, paletteClipsRef.current, tracksRef.current, {
      createBuffer: (numberOfChannels, length, sampleRate) =>
        audioEngine.getContext().createBuffer(numberOfChannels, length, sampleRate),
    });
    const derived = projection.track;
    track.duration = derived.duration;
    track.analysis = derived.analysis;
    track.analysisVariants = derived.analysisVariants;
    track.sourceDuration = derived.sourceDuration;
    track.baseAnalysis = derived.baseAnalysis;
    track.baseAnalysisVariants = derived.baseAnalysisVariants;
    track.editInfo = derived.editInfo;
    projectionRef.current = projection;
    setSpanViews(toSpanViews(projection.timeline, paletteClipsRef.current));
    // Decisive follow-up parameters, durably logged (see the log-file contract):
    // what the projection contains and where the rendered columns came from.
    logger.info('EDITING', `[Edit-Projektion] „${track.title}“ neu abgeleitet`, {
      segments: track.workingSegments?.length ?? 0,
      spans: projection.timeline.spans.length,
      structuralEdits: projection.timeline.structuralEdits,
      overlays: projection.timeline.overdubs.length,
      identity: projection.identity,
      mediaDurationSec: Number((track.sourceDuration ?? track.duration).toFixed(3)),
      projectDurationSec: Number(projection.timeline.duration.toFixed(3)),
      waveformOrigin: waveformOriginAfterEdit(projection),
      waveformVariants: projection.variants.length,
      columnsStored: projection.stats
        ? projection.stats.verbatimColumns + projection.stats.retimedColumns + projection.stats.clipColumns
        : track.analysis?.length ?? 0,
      columnsComputed: projection.stats?.computedColumns ?? 0,
      columnsMissing: projection.stats?.missingColumns ?? 0,
      columnsSilence: projection.stats?.silenceColumns ?? 0,
      cues: track.cues.length,
      loops: track.loops.length,
      phrases: track.phrases?.length ?? 0,
      beatNodes: track.beatGrid?.beats?.length ?? 0,
      audioRendered: !!projection.workingBuffer && projection.workingBuffer !== track.audioBuffer,
    });
    if (projection.workingBuffer) {
      const wasPlaying = audioEngine.getIsPlaying();
      setWorkingAudioBuffer(projection.workingBuffer);
      setCurrentTime((prev) => Math.max(0, Math.min(prev, projection.timeline.duration)));
      if (wasPlaying) {
        setIsPlaying(false);
        audioEngine.stop();
      }
    }
    setTracks((prev) => [...prev]);
    return projection;
  }, []);

  /** Resets the derived state after a fresh (un-edited) deck load. */
  const resetEditProjection = useCallback(() => {
    projectionRef.current = null;
    setSpanViews([]);
  }, []);

  /**
   * Maps a project-time window back onto the pristine source material. It only
   * returns a source window when the whole selection lives inside one original
   * span — that is the exact condition under which stored ANLZ columns may be
   * reused instead of being recomputed from audio.
   */
  /**
   * Where does a window of the (possibly edited) timeline come from? Delegates to
   * the strict mapper in editTimeline: a window is only "original material" when it
   * lies inside one span, otherwise nothing is guessed — callers must then say
   * honestly that the material is edit audio (and must not reuse any position in
   * the original file as if it were the source).
   */
  const mapWindowToSource = (
    track: TrackModel | null,
    startSec: number,
    endSec: number
  ): { trackId: string; sourceStart: number; duration: number; via: 'original' | 'clip' } | null => {
    const mapped = mapWindowToSourceWindow(projectionRef.current?.timeline, track?.id ?? '', startSec, endSec);
    return mapped ? { ...mapped } : null;
  };

  // Stringent empty project: no demo bootstrap. The deck starts empty and
  // only genuine Rekordbox/local data loads it (XML-exclusive guarantee:
  // no synthetic reference track, no generated previews, no template data).

  // Eager auto-load: hole Waveform/Cues direkt aus lokaler Rekordbox DB ohne manuellen DATA-Klick.
  useEffect(() => {
    if (!window.rekordboxDesktop) return;
    ensureDbAnalysisIndex();
  }, [ensureDbAnalysisIndex]);

  // Durable file logging: mirrors every decisive pipeline parameter into the
  // desktop log file (idempotent, browser-safe).
  useEffect(() => initFileLogging(), []);

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

  // Playback Toggle
  const handleTogglePlay = () => {
    if (!activeTrack || !workingAudioBuffer) return;

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
      audioEngine.play(workingAudioBuffer, currentTime, loopActive, loopStart, loopEnd);
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
      id: nextId('mem'),
      position: currentTime,
      inMsec: Math.round(currentTime * 1000),
      type: 'MEMORY',
      name: `MEM ${nextIndex}`,
      color: '#ff2222',
      cueIndex: nextIndex,
      barNumber,
      beatNumber,
      origin: DataOrigin.USER_EDIT,
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
  // Manual grid edits (Shift / Set 1.1 / Auto-Align) share one guarded core:
  // rigid shift preserving the original intervals, labeled USER_EDIT, with an
  // Undo snapshot taken beforehand and a user-facing change notice. Auto-Align
  // runs ONLY from its manual trigger — never automatically.
  const applyGridShift = useCallback((deltaSeconds: number, source: 'SHIFT' | 'SET_1_1' | 'AUTO_ALIGN') => {
    if (!activeTrack) return;
    const currentFirstBeat = activeTrack.beatGrid.firstBeat || 0;
    const newFirstBeat = Math.max(0, currentFirstBeat + deltaSeconds);
    const actualDelta = newFirstBeat - currentFirstBeat;
    const hadNodes = (activeTrack.beatGrid.beats?.length ?? 0) > 0;
    pushHistorySnapshot(source === 'AUTO_ALIGN' ? 'Auto-Align Beatgrid' : source === 'SET_1_1' ? 'Set 1.1' : 'Beatgrid-Shift');

    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== activeTrack.id) return t;
        const spb = 60.0 / t.bpm;
        const beats = (t.beatGrid.beats?.length ?? 0) > 0
          ? shiftBeatNodes(t.beatGrid.beats, actualDelta)
          : Array.from({ length: Math.max(0, Math.floor((t.duration - newFirstBeat) / spb)) }, (_, i) => ({
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
            beats,
            origin: DataOrigin.USER_EDIT,
          },
          isModified: true,
        };
      })
    );

    const notice = describeGridEdit(
      source,
      currentFirstBeat,
      newFirstBeat,
      hadNodes ? activeTrack.beatGrid.beats.length : 0
    );
    showOperationFeedback({
      title: 'Beatgrid manuell angepasst (USER_EDIT)',
      operationType: 'GRID',
      description: notice,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
    logger.info('BEATGRID', notice, { trackId: activeTrack.id, source, deltaSeconds: actualDelta });
  }, [activeTrack, showOperationFeedback]);

  const handleSetFirstBeatHere = useCallback(() => {
    if (!activeTrack) return;
    const currentFirstBeat = activeTrack.beatGrid.firstBeat || 0;
    applyGridShift(Math.max(0, currentTime) - currentFirstBeat, 'SET_1_1');
  }, [activeTrack, currentTime, applyGridShift]);

  // Fine-tune Beatgrid offset (Pioneer Rekordbox Grid Shift: +/- 1ms or 10ms)
  const handleShiftBeatgrid = useCallback((deltaSeconds: number) => {
    applyGridShift(deltaSeconds, 'SHIFT');
  }, [applyGridShift]);

  // Auto-align Beatgrid to nearest transient peak (manual trigger only)
  const handleAutoAlignBeatgrid = useCallback(() => {
    if (!activeTrack) return;
    const analysis = activeTrack.analysis;
    if (!analysis || analysis.peaks.length === 0) return;

    const secPerBucket = analysis.secPerBucket || (activeTrack.duration / analysis.length);
    const searchCenterBucket = Math.round(currentTime / secPerBucket);
    const searchRadius = Math.round(0.1 / secPerBucket); // search within +/- 100ms
    const minBucket = Math.max(0, searchCenterBucket - searchRadius);
    const maxBucket = Math.min(analysis.peaks.length - 1, searchCenterBucket + searchRadius);

    // Transient search uses the stored ANLZ column heights verbatim — no
    // self-computed weighting of channels.
    let maxPeak = -1;
    let bestBucket = searchCenterBucket;
    for (let b = minBucket; b <= maxBucket; b++) {
      const peakVal = analysis.peaks[b];
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
    applyGridShift(shift, 'AUTO_ALIGN');
  }, [activeTrack, currentTime, applyGridShift]);

  // Apply extracted track from Rekordbox Database / ANLZ
  const handleApplyExtractedTrack = (extractedTrack: TrackModel) => {
    // Fresh analysis data for a deck that may already carry a composite: drop the
    // frozen base so the projection re-freezes from the newly applied ANLZ arrays
    // instead of projecting on top of the previous composite.
    const rebased = rebaseTrackAnalysis(extractedTrack);
    setTracks((prev) => {
      const idx = prev.findIndex((t) => t.id === rebased.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = rebased;
        return next;
      }
      return [rebased, ...prev];
    });
    setActiveTrackId(rebased.id);
    if (rebased.audioBuffer) {
      setWorkingAudioBuffer(rebased.audioBuffer);
    }
    syncEditProjection(rebased);
  };

  // Snapshot current state for Undo (the beat grid is included so manual
  // grid edits stay reversible and the original grid stays traceable).
  /**
   * Shallow snapshot of the edit list. Segment `clipBuffer`s are shared, never
   * deep-copied: a `JSON.parse(JSON.stringify(...))` turned every AudioBuffer
   * into `{}`, so Undo silently destroyed inserted clip material.
   */
  const snapshotSegments = (list: EditSegment[]): EditSegment[] => (list ?? []).map((s) => ({ ...s }));
  const snapshotGrid = (grid: BeatGrid): BeatGrid => ({
    ...grid,
    beats: (grid?.beats ?? []).map((node) => ({ ...node })),
  });

  /**
   * One snapshot shape for Undo, Redo and the undo-stack push: the edit list plus
   * every marker the edit moved. The beat grid is included so manual grid edits
   * stay reversible and the original grid stays traceable. Audio and waveform are
   * NOT snapshotted — they are re-derived from the restored edit list.
   */
  const makeHistorySnapshot = (description: string): EditHistoryEntry | null => {
    if (!activeTrack) return null;
    return {
      description,
      timestamp: Date.now(),
      segments: snapshotSegments(activeTrack.workingSegments),
      selection: selection ? { ...selection } : null,
      cues: (activeTrack.cues ?? []).map((c) => ({ ...c })),
      loops: (activeTrack.loops ?? []).map((l) => ({ ...l })),
      phrases: (activeTrack.phrases ?? []).map((p) => ({ ...p })),
      beatGrid: snapshotGrid(activeTrack.beatGrid),
    };
  };

  // Snapshot current state for Undo.
  const pushHistorySnapshot = (desc: string) => {
    const snapshot = makeHistorySnapshot(desc);
    if (!snapshot) return;
    setUndoStack((prev) => [...prev.slice(-30), snapshot]);
    setRedoStack([]);
  };

  /** Restores one snapshot and re-derives every follow-up state from it. */
  const restoreHistorySnapshot = (snapshot: EditHistoryEntry, track: TrackModel) => {
    track.workingSegments = snapshotSegments(snapshot.segments);
    track.cues = (snapshot.cues ?? []).map((c) => ({ ...c }));
    if (snapshot.loops) track.loops = snapshot.loops.map((l) => ({ ...l }));
    if (snapshot.phrases) track.phrases = snapshot.phrases.map((p) => ({ ...p }));
    if (snapshot.beatGrid) track.beatGrid = snapshotGrid(snapshot.beatGrid);
    setSelection(snapshot.selection);
    // Audio + waveform are never restored from a stale copy: they are projected
    // from the restored edit list, which keeps Undo exactly reversible.
    syncEditProjection(track);
  };

  // Undo / Redo
  const handleUndo = () => {
    if (undoStack.length === 0 || !activeTrack) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));

    // Push current to redo
    const currentSnapshot = makeHistorySnapshot('Before Undo');
    if (currentSnapshot) setRedoStack((prev) => [...prev, currentSnapshot]);
    restoreHistorySnapshot(previous, activeTrack);
  };

  const handleRedo = () => {
    if (redoStack.length === 0 || !activeTrack) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));

    // Push current to undo
    const currentSnapshot = makeHistorySnapshot('Before Redo');
    if (currentSnapshot) setUndoStack((prev) => [...prev, currentSnapshot]);
    restoreHistorySnapshot(next, activeTrack);
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

  /**
   * Builds one structural edit segment. `source` carries the provenance that
   * lets the waveform compositor decide between copying stored ANLZ columns and
   * computing new ones (tempoRatio/pitchShift ≠ untouched ⇒ must compute).
   */
  type ClipSourceInfo = {
    clipId?: string;
    sourceTrackId?: string;
    sourceClipStart?: number;
    sourceStart?: number;
    tempoRatio?: number;
    pitchShift?: number;
  };

  const makeSegment = (
    type: EditSegment['type'],
    projectStart: number,
    projectDuration: number,
    buffer: AudioBuffer | null,
    source: ClipSourceInfo = {}
  ): EditSegment =>
    createSegment({
      type,
      trackId: activeTrack?.id ?? '',
      projectStart,
      projectDuration,
      sourceStart: source.sourceStart,
      clipId: source.clipId,
      clipBuffer: buffer ?? undefined,
      sourceTrackId: source.sourceTrackId,
      sourceClipStart: source.sourceClipStart,
      tempoRatio: source.tempoRatio,
      pitchShift: source.pitchShift,
    });

  /**
   * The single path every edit takes: append the segment, re-time the follow-up
   * state (cues, loops, phrases, beatgrid) and re-derive audio + waveform.
   */
  const commitSegmentEdit = (
    track: TrackModel,
    segment: EditSegment,
    edit: StructuralEditDelta | null,
    insertWindow: { start: number; end: number } | null
  ): { projection: TrackProjection | null; retimed: { cues: number; dropped: number; loops: number; phrases: number; beats: number; gridFilled: number } } => {
    track.workingSegments = [...(track.workingSegments ?? []), segment];

    const retimed = { cues: 0, dropped: 0, loops: 0, phrases: 0, beats: 0, gridFilled: 0 };
    if (edit) {
      const cueRes = retimeCues(track.cues ?? [], edit);
      track.cues = cueRes.cues;
      const loopRes = retimeLoops(track.loops ?? [], edit);
      track.loops = loopRes.loops;
      const meter = track.beatGrid?.meter ?? 4;
      const spb = 60.0 / (track.beatGrid?.bpm || track.bpm || 120);
      const phraseRes = retimePhrases(track.phrases ?? [], edit, spb * meter);
      track.phrases = phraseRes.phrases;

      const hadNodes = (track.beatGrid?.beats?.length ?? 0) > 0;
      const beatRes = retimeBeatNodes(track.beatGrid?.beats ?? [], edit);
      let beats = beatRes.beats;
      if (hadNodes && insertWindow) {
        // Only a deck with an imported grid gets the inserted window covered —
        // a missing PQTZ stays visibly missing and is never manufactured.
        const ext = extendGridAcrossGap(
          beats,
          insertWindow.start,
          insertWindow.end,
          track.beatGrid?.bpm || track.bpm || 120,
          meter,
          track.beatGrid?.firstBeat ?? 0
        );
        beats = ext.beats;
        retimed.gridFilled = ext.generated;
      }
      const baseGrid = track.beatGrid ?? { firstBeat: 0, bpm: track.bpm, meter, beats: [], origin: track.origin };
      track.beatGrid = {
        ...baseGrid,
        beats,
        origin:
          edit.mode === 'insert' || edit.mode === 'remove' ? DataOrigin.USER_EDIT : baseGrid.origin,
      };

      retimed.cues = cueRes.moved;
      retimed.dropped = cueRes.dropped + loopRes.dropped + phraseRes.dropped;
      retimed.loops = loopRes.loops.length;
      retimed.phrases = phraseRes.phrases.length;
      retimed.beats = beatRes.beats.length;
    }

    const projection = syncEditProjection(track);
    return { projection, retimed };
  };

  /** Feedback text: what the projected waveform is actually made of. */
  const waveformFollowUpNote = (projection: TrackProjection | null): string => {
    if (!projection) return '';
    if (projection.identity) {
      return 'Wellenform: unbedarft – Projekt entspricht dem Original (keine Neu-Berechnung nötig).';
    }
    return `Wellenform-Neuberechnung: ${describeEditWaveform(
      projection.stats!,
      projection.timeline.duration
    )}.`;
  };

  // Add selection to Palette (CLONE or '+' button)
  /**
   * The palette button in the bottom bar is wired straight to onClick, so this
   * handler can receive the click event where a time is expected. A non-numeric
   * argument therefore means "use the current selection" — otherwise the guard
   * `!(to > from)` trips on a MouseEvent and CLONE silently does nothing.
   */
  const handleAddSelectionToPalette = (
    startSec?: number | { type?: string },
    endSec?: number | { type?: string }
  ) => {
    const from = typeof startSec === 'number' ? startSec : selection?.start;
    const to = typeof endSec === 'number' ? endSec : selection?.end;
    if (from === undefined || to === undefined || !activeTrack || !workingAudioBuffer) return;
    if (!(to > from)) return;
    const sliced = audioEngine.sliceAudioBuffer(workingAudioBuffer, from, to);
    const newClipId = nextId('clip');
    // Keep the source window when the copied range is genuine original material:
    // a clip inserted from it can then reuse the stored ANLZ columns verbatim.
    const sourceWindow = mapWindowToSource(activeTrack, from, to);
    // A bar is FOUR beats: secondsPerBeat * 4. The previous formula divided by
    // the beat length instead of multiplying, which labelled a 2 s clip as
    // 17.3 Bars and even persisted that wrong number into saved projects.
    const secondsPerBeat = 60 / (activeTrack.beatGrid?.bpm || activeTrack.bpm || 120);
    const barsOfWindow = (to - from) / (secondsPerBeat * 4);
    const newClip: PaletteClip = {
      id: newClipId,
      name: `${activeTrack.title} (${barsOfWindow.toFixed(1)} Bars)`,
      sourceTrackId: sourceWindow?.trackId ?? activeTrack.id,
      sourceTrackName: activeTrack.title,
      // Only a verified window may be read back as source material. Unmapped clips
      // keep the EDIT-timeline window (what the user actually heard) and are marked
      // `sourceMapped: false`, so no drop may reinterpret these seconds as a position
      // inside the original file.
      sourceMapped: sourceWindow !== null,
      sourceStart: sourceWindow ? sourceWindow.sourceStart : from,
      sourceEnd: sourceWindow ? sourceWindow.sourceStart + (to - from) : to,
      duration: to - from,
      beats: Math.round((to - from) / secondsPerBeat),
      bars: barsOfWindow,
      bpm: activeTrack.bpm,
      key: activeTrack.key,
      color: '#00a2ff',
      audioBuffer: sliced,
      ...((): { miniPeaks: number[]; previewOrigin: PreviewProfile['origin']; previewNote: string } => {
        const profile = sourceWindow
          ? clipPreviewProfile(
              sourcePreviewVariant(activeTrack),
              sourceWindow.sourceStart,
              to - from,
              48,
              () => extractMiniPeaks(sliced, 48)
            )
          : {
              peaks: extractMiniPeaks(sliced, 48),
              origin: 'EDIT' as const,
              columns: 0,
            };
        return { miniPeaks: profile.peaks, previewOrigin: profile.origin, previewNote: describePreviewOrigin(profile) };
      })(),
      origin: DataOrigin.PROJECT,
    };

    setPaletteClips((prev) => {
      const next = [...prev, newClip];
      paletteClipsRef.current = next;
      return next;
    });
    setSelectedClipId(newClipId);
    if (!paletteOpen) setPaletteOpen(true);
  };

  /** Stored analysis variant that describes the track's ORIGINAL source times. */
  const sourcePreviewVariant = (track: TrackModel | null) => {
    if (!track) return null;
    const candidates = [
      ...(track.baseAnalysisVariants ?? []),
      track.baseAnalysis ?? null,
      ...(track.analysisVariants ?? []),
      track.analysis ?? null,
    ].filter((v): v is NonNullable<typeof v> => Boolean(v && v.length > 0 && !v.isEditComposite));
    return candidates[0] ?? null;
  };

  // Copy selection (with its source window, for verbatim column reuse on paste)
  const handleCopy = () => {
    if (!selection || !workingAudioBuffer || !activeTrack) return;
    const sliced = audioEngine.sliceAudioBuffer(workingAudioBuffer, selection.start, selection.end);
    setClipboardBuffer(sliced);
    setClipboardSource(mapWindowToSource(activeTrack, selection.start, selection.end));
  };

  // Cut selection
  const handleCut = () => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    handleCopy();
    handleDelete();
  };

  /** Inserts the clipboard at the playhead (paste == insert on the timeline). */
  const pasteClipboardAt = (projectStart: number, atLabel = 'Wiedergabeposition') => {
    if (!clipboardBuffer || !activeTrack) return;
    pushHistorySnapshot('Paste');
    const dur = clipboardBuffer.duration;
    const seg = makeSegment('INSERT', projectStart, dur, clipboardBuffer, {
      sourceTrackId: clipboardSource?.trackId,
      sourceClipStart: clipboardSource?.sourceStart,
      tempoRatio: 1.0,
      pitchShift: 0,
    });
    const { projection, retimed } = commitSegmentEdit(
      activeTrack,
      seg,
      { mode: 'insert', start: projectStart, end: projectStart + dur, delta: dur },
      { start: projectStart, end: projectStart + dur }
    );
    showOperationFeedback({
      title: 'Zwischenablage eingefügt (Insert)',
      operationType: 'INSERT',
      description:
        `${dur.toFixed(3)}s an der ${atLabel} (${projectStart.toFixed(3)}s) eingefügt; folgendes Material rückt um +${dur.toFixed(3)}s. ` +
        (clipboardSource
          ? `Quelle: Originalmaterial ab ${clipboardSource.sourceStart.toFixed(3)}s${
              clipboardSource.via === 'clip' ? ' (über bereits eingefügtes Material nachgeführt)' : ''
            } – gespeicherte Wellenform-Spalten werden übernommen.`
          : 'Quelle: Material aus dem Edit-Audio – keine eindeutige Quellposition im Original; Spalten werden daraus berechnet und als BERECHNET gekennzeichnet.') +
        ` ${waveformFollowUpNote(projection)}` +
        ` Verschoben: ${retimed.cues} Cues, ${retimed.beats} Beat-Knoten${retimed.gridFilled ? `, ${retimed.gridFilled} Grid-Füllbeats im neuen Bereich` : ''}.`,
      timeRangeSec: { start: projectStart, end: projectStart + dur, duration: dur },
      shiftedCuesCount: retimed.cues,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  };

  /**
   * PASTE goes where the user pointed: a live selection wins (that is the place
   * the user selected as target), otherwise the playhead. INSERT is the explicit
   * playhead variant — both say so in their feedback, no silent re-anchoring.
   */
  const handlePaste = () => pasteClipboardAt(selection?.start ?? currentTime, selection ? 'Auswahlposition' : 'Wiedergabeposition');
  const handleInsert = () => pasteClipboardAt(currentTime, 'Wiedergabeposition');

  /**
   * Drag & drop from the clip palette onto the deck timeline. The drop position
   * decides where the material lands; the modifiers decide what happens to the
   * material that was there before (insert / replace / overdub). Every mode runs
   * through the same projection, so audio, waveform, cues and grid stay aligned.
   */
  const handleDropClipOnDeck = (
    clipId: string,
    projectStart: number,
    mode: 'insert' | 'replace' | 'overdub',
    windowEnd?: number
  ) => {
    const clip = paletteClips.find((c) => c.id === clipId);
    if (!clip || !activeTrack) {
      alert('Kein Deck-Track geladen – Clip kann nicht eingefügt werden.');
      return;
    }
    if (!clip.audioBuffer) {
      alert('Der Clip enthält keine Audiodaten (Originaldatei nicht lesbar?).');
      return;
    }
    const adapted = audioEngine.adaptClipToTrack(clip, activeTrack, matchPitchOnInsert);
    const tempoRatio = adapted.tempoRatio;
    const pitchShift = adapted.semitonesShifted;
    const source = {
      clipId: clip.id,
      // `sourceMapped` is the guard against a silently wrong source position: only
      // clips whose window was verified against the timeline may reuse the stored
      // columns of the original material. Everything else is drawn from the clip's
      // own audio and labelled accordingly.
      ...(clip.sourceMapped ? { sourceTrackId: clip.sourceTrackId, sourceClipStart: clip.sourceStart } : {}),
      tempoRatio,
      pitchShift,
    };
    // The drop's geometry (window, length change, segment type) is derived by one
    // pure planner, so the pointer handling and the projection agree exactly.
    const plan = planClipDrop({
      mode,
      dropTime: projectStart,
      clipDuration: adapted.newDuration,
      timelineDuration: projectionRef.current?.timeline.duration ?? activeTrack.duration,
      windowEnd,
    });
    const position = plan.projectStart;
    const dur = plan.projectDuration;
    pushHistorySnapshot(mode === 'insert' ? 'Drop: Insert Clip' : mode === 'replace' ? 'Drop: Replace mit Clip' : 'Drop: Overdub');

    if (mode === 'insert') {
      const seg = makeSegment('INSERT', position, dur, adapted.adaptedBuffer, source);
      const { projection, retimed } = commitSegmentEdit(activeTrack, seg, plan.delta, plan.window);
      showOperationFeedback({
        title: 'Clip per Drag & Drop eingefügt',
        operationType: 'INSERT',
        description:
          `Clip „${clip.name}" an ${position.toFixed(3)}s eingefügt (Drop auf der Timeline). ${plan.note} ` +
          `Tempo ${clip.bpm.toFixed(1)} ➔ ${activeTrack.bpm.toFixed(1)} BPM (${tempoRatio.toFixed(3)}×). ` +
          `${waveformFollowUpNote(projection)} ` +
          `Verschoben: ${retimed.cues} Cues, ${retimed.beats} Beat-Knoten${retimed.gridFilled ? `, ${retimed.gridFilled} Füllbeats` : ''}.` +
          (adapted.semitonesShifted !== 0 ? ` Tonhöhe ${adapted.semitonesShifted > 0 ? '+' : ''}${adapted.semitonesShifted} ST (${adapted.harmonicRelation}).` : ''),
        timeRangeSec: { start: position, end: position + dur, duration: dur },
        shiftedCuesCount: retimed.cues,
        originalSha256: activeTrack.originalSha256,
        timestamp: Date.now(),
      });
      return;
    }

    if (mode === 'replace') {
      const seg = makeSegment('REPLACE', position, dur, adapted.adaptedBuffer, source);
      const { projection } = commitSegmentEdit(activeTrack, seg, plan.delta, null);
      showOperationFeedback({
        title: 'Clip per Drag & Drop: Bereich ersetzt',
        operationType: 'REPLACE',
        description:
          `Bereich durch Clip „${clip.name}" ersetzt (Drop auf der Timeline). ${plan.note} ` +
          `${waveformFollowUpNote(projection)}`,
        timeRangeSec: plan.window ? { start: plan.window.start, end: plan.window.end, duration: dur } : undefined,
        originalSha256: activeTrack.originalSha256,
        timestamp: Date.now(),
      });
      return;
    }

    const seg = makeSegment('OVERDUB', position, dur, adapted.adaptedBuffer, source);
    const { projection } = commitSegmentEdit(activeTrack, seg, plan.delta, null);
    showOperationFeedback({
      title: 'Clip per Drag & Drop überlagert (Overdub)',
      operationType: 'OVERDUB',
      description:
        `Clip „${clip.name}" über der Timeline gemischt (Drop). ${plan.note} ` +
        `${waveformFollowUpNote(projection)}`,
      timeRangeSec: plan.window ? { start: plan.window.start, end: plan.window.end, duration: dur } : undefined,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  };

  /** Drag & drop of a collection/browser row onto the deck: loads it into Deck A. */
  const handleDropTrackOnDeck = (trackId: string) => {
    const loaded = tracks.find((t) => t.id === trackId);
    if (loaded) {
      loadTrackIntoDeck(loaded);
      return;
    }
    const def = xmlImportedTracks.find((t) => t.id === trackId);
    if (def) {
      void handleSelectTrackFromXml(def);
      return;
    }
    alert('Das gezogene Element gehört zu keiner geladenen Sammlung.');
  };

  /** Dragging an inserted clip block along the timeline (move, not re-insert). */
  const handleMoveClipSegment = (segmentId: string, newProjectStart: number) => {
    if (!activeTrack) return;
    const seg = (activeTrack.workingSegments ?? []).find((s) => s.id === segmentId);
    if (!seg || seg.type !== 'INSERT') return;
    const oldStart = seg.projectStart;
    const length = seg.projectDuration;
    const target = Math.max(0, Math.min(newProjectStart, Math.max(0, (projectionRef.current?.timeline.duration ?? activeTrack.duration) - length)));
    if (Math.abs(target - oldStart) < 1e-4) return;
    pushHistorySnapshot('Clip verschoben');
    const delta = target - oldStart;
    activeTrack.workingSegments = (activeTrack.workingSegments ?? []).map((s) =>
      s.id === segmentId ? { ...s, projectStart: target } : s
    );
    // Markers that belong to the moved clip follow it; the rest of the project
    // keeps its positions (a move changes no lengths).
    activeTrack.cues = retimeCues(activeTrack.cues ?? [], { mode: 'move', start: oldStart, end: oldStart + length, delta }).cues;
    const projection = syncEditProjection(activeTrack);
    showOperationFeedback({
      title: 'Clip verschoben',
      operationType: 'INSERT',
      description:
        `Clip von ${oldStart.toFixed(3)}s nach ${target.toFixed(3)}s verschoben (${delta > 0 ? '+' : ''}${delta.toFixed(3)}s). ` +
        `Wellenform und Audio wurden aus den Segmenten neu projiziert. ${waveformFollowUpNote(projection)}`,
      timeRangeSec: { start: target, end: target + length, duration: length },
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
    handleDropClipOnDeck(clip.id, currentTime, 'insert');
  };

  // Replace selection in Deck A with Clip (with Tempo & Harmonic Pitch Adaptation)
  const handleReplaceDeckAWithClip = (clip: PaletteClip) => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    handleDropClipOnDeck(clip.id, selection.start, 'replace', selection.end);
  };

  // Overdub selection in Deck A with Clip (with Tempo & Harmonic Pitch Adaptation)
  const handleOverdubDeckAWithClip = (clip: PaletteClip) => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    handleDropClipOnDeck(clip.id, selection.start, 'overdub', selection.end);
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

  // Delete selection (removes range and shifts subsequent material)
  const handleDelete = () => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Delete');

    const delDuration = selection.duration;
    const delStart = selection.start;
    const seg = makeSegment('CUT', delStart, delDuration, null);
    const { projection, retimed } = commitSegmentEdit(
      activeTrack,
      seg,
      { mode: 'remove', start: delStart, end: selection.end, delta: -delDuration },
      null
    );

    showOperationFeedback({
      title: 'Auswahl gelöscht (Delete)',
      operationType: 'DELETE',
      description:
        `Bereich (${delDuration.toFixed(3)}s / ${selection.barsCount.toFixed(1)} Takte) gelöscht; nachfolgendes Material rückt um -${delDuration.toFixed(3)}s nach vorne. ` +
        `Nicht-destruktiv: Das Original bleibt unverändert, der Schnitt sitzt in der Edit-Liste und ist per Undo zurücknehmbar. ` +
        `Marker: ${retimed.cues} verschoben, ${retimed.dropped} verworfen. ` +
        `${waveformFollowUpNote(projection)}`,
      timeRangeSec: { start: delStart, end: selection.end, duration: delDuration },
      barsCount: selection.barsCount,
      beatsCount: selection.beatsCount,
      shiftedCuesCount: retimed.cues,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });

    setSelection(null);
  };

  // Clear selection (silences range without changing duration)
  const handleClear = () => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Clear');

    const seg = makeSegment('CLEAR', selection.start, selection.duration, null);
    const { projection } = commitSegmentEdit(
      activeTrack,
      seg,
      { mode: 'clear', start: selection.start, end: selection.end, delta: 0 },
      null
    );

    showOperationFeedback({
      title: 'Bereich stummgeschaltet (Clear / Mute)',
      operationType: 'CLEAR',
      description:
        `Bereich (${selection.duration.toFixed(3)}s / ${selection.barsCount.toFixed(1)} Takte) stummgeschaltet – als Edit-Segment, nicht durch Überschreiben des Arbeits-Audios. ` +
        `Timeline-Dauer und Beatgrid-Synchronisation bleiben erhalten. ` +
        `Die Wellenform zeigt in diesem Bereich echte Stille statt der gespeicherten Peaks. ${waveformFollowUpNote(projection)}`,
      timeRangeSec: { start: selection.start, end: selection.end, duration: selection.duration },
      barsCount: selection.barsCount,
      beatsCount: selection.beatsCount,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  };

  // Add Cue marker at position
  const handleAddCue = (pos: number) => {
    if (!activeTrack) return;
    pushHistorySnapshot('Add Cue');
    const newCue = {
      id: nextId('cue'),
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
      logger.info('XML_IMPORT', '[XML Import] Collection gelesen', {
        fileName: file.name,
        tracks: fullTrackModels.length,
        withLocation: fullTrackModels.filter((t) => t.originalMedia?.location).length,
      });

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
      logger.error('XML_IMPORT', 'Fehler beim Einlesen der Rekordbox XML-Datei', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
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

      // Anchor every DB track to its database directory so AnalysisDataPath
      // values resolve deterministically to <dbDir>/share/PIONEER/USBANLZ/...
      const sourceDbDir = dirOfPath(dbPath);
      const fullTrackModels = mapped.tracks.map((track, idx) => {
        track.rawXmlAttributes = { ...(track.rawXmlAttributes ?? {}), sourceDbDir };
        return buildCollectionTrackModel(track, idx, DataOrigin.REKORDBOX_DB);
      });

      // Rebuild the deterministic XML→DB link index (exact audio-path match).
      if (result.dbType === 'MASTER_DB') {
        dbAnalysisIndexRef.current = buildDbAnalysisIndex(fullTrackModels, sourceDbDir);
        dbAnalysisIdIndexRef.current = buildDbAnalysisIdIndex(fullTrackModels, sourceDbDir);
      }

      setXmlImportedTracks(fullTrackModels);
      setXmlFileName(sourceLabel || result.fileName || 'Rekordbox Datenbank');
      setXmlCollectionModalOpen(true);
      logger.info('DATABASE', '[DB Import] Rekordbox-Datenbank gelesen', {
        dbPath,
        sourceDbDir,
        dbType: result.dbType ?? null,
        tracks: fullTrackModels.length,
        memoryCues: mapped.stats.memoryCues,
        hotCues: mapped.stats.hotCues,
        loops: mapped.stats.loops,
        withAnalysisDataPath: fullTrackModels.filter((t) => t.rawXmlAttributes?.analysisDataPath?.trim()).length,
        linkIndexSize: dbAnalysisIndexRef.current.size,
      });

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
        logger.warn('DATABASE', '[Rekordbox DB] Hinweise beim Datenbank-Import', { warnings });
      }
    } catch (error) {
      logger.error('DATABASE', '[Rekordbox DB] Import fehlgeschlagen', {
        error: error instanceof Error ? error.message : String(error),
      });
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
      logger.error('DATABASE', '[Rekordbox DB] Dateiauswahl fehlgeschlagen', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleLocateRekordboxDatabases = async () => {
    if (!window.rekordboxDesktop) return [];
    try {
      return await window.rekordboxDesktop.locateRekordboxDatabases();
    } catch (error) {
      logger.warn('DATABASE', '[Rekordbox DB] Automatische Suche fehlgeschlagen', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  // Load a selected track from a Rekordbox collection (XML or database) into
  // the DJ Deck.
  //
  // XML-EXCLUSIVE WORKFLOW GUARANTEE: for Rekordbox-sourced tracks, every
  // visualized datum comes from Rekordbox sources ONLY:
  //   beatgrid <- XML TEMPO / DB parameters (uniform reconstruction),
  //   waveform <- ANLZ analysis only (never own peak analysis),
  //   cues/loops <- XML / DB / ANLZ only,
  //   phrases <- ANLZ PSSI only (never template phrases).
  // No synthetic audio is generated: if the original file is unavailable, the
  // track loads metadata-only and the UI states exactly what is missing.
  const handleSelectTrackFromXml = async (selectedDef: TrackModel) => {
    try {
      const audioCtx = audioEngine.getContext();
      const rbExclusive = isRekordboxOrigin(selectedDef.origin ?? DataOrigin.REKORDBOX_XML);
      let originalAudio = selectedDef.audioBuffer || null;
      let originalMedia = selectedDef.originalMedia;

      // The native bridge can resolve the XML Location and only ever opens the
      // original audio read-only.
      if (!originalAudio && originalMedia?.location && window.rekordboxDesktop) {
        try {
          const source = await window.rekordboxDesktop.readOriginalAudio(originalMedia.location);
          originalAudio = await audioCtx.decodeAudioData(ensureArrayBuffer(source.data as ArrayBuffer | Uint8Array));
          originalMedia = {
            ...originalMedia,
            resolvedPath: source.path,
            size: source.size,
            modifiedAt: source.modifiedAt,
            status: 'AVAILABLE',
          };
        } catch (error) {
          logger.warn('DATABASE', '[XML Location] Originalaudio konnte nicht gelesen werden; Track wird ohne Audio geladen (kein Ersatz-Audio).', {
            error: error instanceof Error ? error.message : String(error),
          });
          originalMedia = { ...originalMedia, status: 'MISSING' };
        }
      }

      const bpm = selectedDef.bpm || 130.0;
      const durationDef = selectedDef.duration || 300.0;
      const firstBeatDef = selectedDef.beatGrid?.firstBeat || 0.0;

      // No replacement audio is ever generated: a track whose original file
      // is unreadable loads metadata-only, and the UI states what is missing
      // (XML-exclusive workflow guarantee).
      const duration = originalAudio ? originalAudio.duration : durationDef;
      // RB-exclusive: never run own analysis here; the waveform arrives only
      // via ANLZ (auto-resolved below for DB tracks, manually assigned else).
      // Collection selection never analyzes audio. Rekordbox analysis arrives
      // from ANLZ; any non-Rekordbox collection must bring an explicit source.
      const analysis = selectedDef.analysis ?? null;
      const sha256 = originalAudio
        ? audioEngine.computeBufferChecksum(originalAudio)
        : (selectedDef.originalSha256 || 'NOT_COMPUTED_READ_ONLY_SOURCE');
      // No template phrases: only genuine PSSI data (from ANLZ) or phrases
      // already attached to the collection entry are shown.
      const phrases = selectedDef.phrases && selectedDef.phrases.length > 0
        ? selectedDef.phrases
        : [];

      // Deterministic XML→DB analysis link: when the collection entry carries
      // no AnalysisDataPath of its own, attach the DB reference whose audio
      // path matches exactly (no fuzzy/metadata similarity matching).
      // Garantie-Erfüllung: ohne ANLZ direkt aus lokaler Rekordbox-DB holen – kein manueller DATA-Klick nötig.
      let linkedRawXmlAttributes = selectedDef.rawXmlAttributes;
      // UI-Diagnostik: was hat die automatische ANLZ-Zuordnung getan?
      let anlzLookup: {
        via: 'DB' | 'PPTH' | 'PPTH_NAME' | null;
        scanned: number;
        folders: number;
        elapsedMs: number;
        truncated?: boolean;
        note?: string;
        db?: { found: number; readable: number; links: number; reasons: string[] };
      } | null = null;
      if (rbExclusive && !selectedDef.rawXmlAttributes?.analysisDataPath?.trim()) {
        if (dbAnalysisIndexRef.current.size === 0) {
          await ensureDbAnalysisIndex();
        }
        // DB-Diagnose sichtbar machen: Warum hat der DB-Pfad (nicht) geliefert?
        const dbDiag = {
          found: dbIndexDiagRef.current.found,
          readable: dbIndexDiagRef.current.readable,
          links: dbIndexDiagRef.current.links,
          reasons: dbIndexDiagRef.current.reasons.slice(0, 3),
        };
        const xmlLocation = selectedDef.originalMedia?.location || selectedDef.originalMedia?.resolvedPath || '';
        const linkKey = normalizeAudioKey(xmlLocation);
        const linkRef = resolveVerifiedDbIdentity(
          dbAnalysisIdIndexRef.current,
          selectedDef.id,
          xmlLocation
        );
        if (linkRef) {
          linkedRawXmlAttributes = {
            ...(selectedDef.rawXmlAttributes ?? {}),
            analysisDataPath: linkRef.analysisDataPath,
            sourceDbDir: linkRef.sourceDbDir,
          };
          anlzLookup = { via: 'DB', scanned: 0, folders: 0, elapsedMs: 0, db: dbDiag };
          logger.info('DATABASE', `[Track-Link] XML-Track exakt mit DB-Analyse verknüpft (DB-Track ${linkRef.trackId}).`);
        } else {
          const reasons = dbDiag.reasons.length > 0 ? dbDiag.reasons.join(' | ') : 'kein technischer Grund protokolliert';
          const message =
            `[ANLZ Pipelinefehler] Rekordbox-7.2.16-Identität nicht bestätigt für XML-Track „${selectedDef.title}“ ` +
            `(TrackID ${selectedDef.id}). Erforderlich sind dieselbe djmdContent.ID und derselbe exakte Dateipfad. ` +
            `XML-Adresse: ${linkKey || '(leer)'}; DBs gefunden/lesbar: ${dbDiag.found}/${dbDiag.readable}; ` +
            `Index-Schlüssel: ${dbDiag.links}; Diagnose: ${reasons}`;
          logger.error('DATABASE', message, {
            xmlLocation: selectedDef.originalMedia?.location ?? null,
            normalizedXmlLocation: linkKey || null,
            db: dbDiag,
          });
          throw new Error(message);
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
        id: selectedDef.id || nextId('track'),
        title: selectedDef.title || 'Rekordbox Track',
        artist: selectedDef.artist || 'Unknown Artist',
        album: selectedDef.album || 'Rekordbox Collection',
        bpm,
        key: selectedDef.key || '2A',
        duration,
        sampleRate: originalAudio ? originalAudio.sampleRate : (selectedDef.sampleRate || 44100),
        channels: originalAudio ? originalAudio.numberOfChannels : (selectedDef.channels || 2),
        originalSha256: sha256,
        isOriginalUntouched: true,
        audioBuffer: originalAudio,
        // Keep the imported grid exactly as stored. Rekordbox tracks receive
        // their detailed beat nodes from PQTZ below; a scalar XML/DB tempo is
        // never expanded into invented beats during deck loading.
        beatGrid: selectedDef.beatGrid ?? {
          firstBeat: firstBeatDef,
          bpm,
          meter: 4,
          beats: [],
          origin: selectedDef.origin ?? DataOrigin.REKORDBOX_XML,
        },
        cues: selectedDef.cues || [],
        loops: selectedDef.loops || [],
        analysis,
        phrases,
        originalMedia,
        rawXmlAttributes: linkedRawXmlAttributes,
        origin: selectedDef.origin ?? DataOrigin.REKORDBOX_XML,
        workingSegments: [
          {
            id: nextId('seg-edit'),
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

      // Auto-resolve the ANLZ analysis file for tracks carrying an
      // AnalysisDataPath (Rekordbox database imports).
      let anlzApplied = false;
      if (rbExclusive) {
        const before = loadedTrack;
        loadedTrack = await tryAutoLoadAnlz(loadedTrack);
        anlzApplied = loadedTrack !== before;
        if (!loadedTrack.analysis || loadedTrack.analysis.length === 0) {
          const message =
            `[ANLZ Pipelinefehler] master.db lieferte den Analysepfad, aber daraus wurden keine ` +
            `Rekordbox-Wellenformdaten geladen. Track: „${loadedTrack.title}“; ` +
            `AnalysisDataPath: ${loadedTrack.rawXmlAttributes?.analysisDataPath || '(leer)'}; ` +
            `DB-Verzeichnis: ${loadedTrack.rawXmlAttributes?.sourceDbDir || '(leer)'}.`;
          logger.error('DATABASE', message);
          throw new Error(message);
        }
      }

      // Decisive deck-load parameters, durably logged: waveform must come
      // from Rekordbox-analyzed data (ANLZ) only — never from own analysis.
      logger.info('XML_IMPORT', `[Deck] „${loadedTrack.title}" geladen`, {
        origin: loadedTrack.origin,
        mediaStatus: loadedTrack.originalMedia?.status ?? null,
        location: loadedTrack.originalMedia?.location ?? null,
        resolvedPath: loadedTrack.originalMedia?.resolvedPath ?? null,
        hasAudio: !!loadedTrack.audioBuffer,
        durationSec: Number(loadedTrack.duration.toFixed(3)),
        bpm: loadedTrack.bpm,
        key: loadedTrack.key,
        sampleRate: loadedTrack.sampleRate,
        channels: loadedTrack.channels,
        anlzAutoApplied: anlzApplied,
        waveformSource: loadedTrack.analysis?.sourceTag ?? null,
        waveformBuckets: loadedTrack.analysis?.length ?? 0,
        waveformVariants: loadedTrack.analysisVariants?.length ?? 0,
        beatGridOrigin: loadedTrack.beatGrid.origin,
        beatNodes: loadedTrack.beatGrid.beats?.length ?? 0,
        cues: loadedTrack.cues.length,
        loops: loadedTrack.loops.length,
        phrases: loadedTrack.phrases?.length ?? 0,
        waveformRule: rbExclusive ? 'ANLZ_ONLY (keine eigene Analyse)' : 'LOCAL_ALLOWED',
      });

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
      // Freeze the pristine ANLZ/audio state as the projection base of this deck
      // and start from an empty edit list (project === original).
      resetEditProjection();
      syncEditProjection(loadedTrack);

      if (!originalAudio) {
        const missingAudio = true;
        showOperationFeedback({
          title: missingAudio ? 'Rekordbox-Track ohne Audio geladen' : 'Rekordbox-Track geladen (ohne ANLZ-Waveform)',
          operationType: 'CUE',
          description: `"${loadedTrack.title}": Beatgrid, Cues und Loops stammen aus den Rekordbox-Importdaten. ` +
            (missingAudio
              ? 'Das Originalaudio ist nicht verfügbar – es wird kein Ersatz-Audio erzeugt. '
              : '') +
            `Waveform: ${loadedTrack.analysis!.length} Buckets aus ANLZ (${loadedTrack.databaseRecord?.anlzTagsFound.join(', ') || 'ANLZ'}).` +
            (anlzApplied ? ' ANLZ-Analyse wurde automatisch zugeordnet.' : ''),
          timeRangeSec: { start: 0, end: duration, duration },
          originalSha256: loadedTrack.originalSha256,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('AUDIO_ENGINE', 'Fehler beim Laden des Tracks in das Deck', { error: message });
      alert(message);
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
      logger.error('SYSTEM', '[Projekt] Speichern fehlgeschlagen', {
        error: err instanceof Error ? err.message : String(err),
      });
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
          previewOrigin: clip.previewOrigin,
          previewNote: clip.previewNote,
          // Strenge Übernahme: nur ein explizit verifiziertes Fenster aus einem
          // Projekt dieser Version darf wieder als Quellfenster gelesen werden.
          sourceMapped: clip.sourceMapped === true,
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
            originalAudio = await audioCtx.decodeAudioData(ensureArrayBuffer(source.data as ArrayBuffer | Uint8Array));
            originalMedia = { ...originalMedia, resolvedPath: source.path, size: source.size, modifiedAt: source.modifiedAt, status: 'AVAILABLE' as const };
          } catch (error) {
            logger.warn('SYSTEM', '[Projekt] Originalaudio konnte nicht erneut geöffnet werden; Metadaten bleiben verfügbar.', {
              error: error instanceof Error ? error.message : String(error),
            });
            originalMedia = { ...originalMedia, status: 'MISSING' as const };
          }
        }

        if (originalAudio) {
          // RB-exclusive: a Rekordbox track is never re-analyzed on project
          // load; its waveform returns via ANLZ assignment (AnalysisDataPath
          // auto-resolve or DATA panel), never via own peak analysis.
          let withAudio: TrackModel = {
            ...activeTrack,
            audioBuffer: originalAudio,
            originalMedia,
            duration: originalAudio.duration || activeTrack.duration,
            sampleRate: originalAudio.sampleRate,
            channels: originalAudio.numberOfChannels,
            analysis: isRekordboxOrigin(activeTrack.origin)
              ? null
              : analyzeAudioBuffer(originalAudio, DataOrigin.LOCAL_ANALYSIS),
          };
          if (isRekordboxOrigin(activeTrack.origin)) {
            withAudio = await tryAutoLoadAnlz(withAudio);
          }
          // The restored edit list is re-projected (audio AND waveform) from the
          // freshly loaded ANLZ arrays — never re-analysed from audio, and never
          // taken over from the previous session's composite.
          setTracks((prev) => prev.map((t) => (t.id === withAudio.id ? withAudio : t)));
          resetEditProjection();
          const projection = syncEditProjection(withAudio);
          setWorkingAudioBuffer(projection?.workingBuffer ?? originalAudio);
          logger.info('EDITING', '[Projekt] Edit-Projektion nach dem Laden neu abgeleitet', {
            track: withAudio.title,
            segments: withAudio.workingSegments?.length ?? 0,
            projectDurationSec: Number((projection?.timeline.duration ?? withAudio.duration).toFixed(3)),
            identity: projection?.identity ?? true,
            waveformOrigin: projection ? waveformOriginAfterEdit(projection) : withAudio.origin,
            computedColumns: projection?.stats?.computedColumns ?? 0,
            storedColumns:
              (projection?.stats?.verbatimColumns ?? 0) +
              (projection?.stats?.retimedColumns ?? 0) +
              (projection?.stats?.clipColumns ?? 0),
          });
        } else if (activeTrack.audioBuffer) {
          resetEditProjection();
          const projection = syncEditProjection(activeTrack);
          setWorkingAudioBuffer(projection?.workingBuffer ?? activeTrack.audioBuffer);
        }
      }

      showOperationFeedback({
        title: 'Projekt geladen',
        operationType: 'EXPORT',
        description: `Projekt "${doc.projectName}" mit ${rebuiltTracks.length} Track(s) und ${rebuiltClips.length} Palette-Clip(s) geladen. Originalquellen wurden nur lesend erneut geöffnet; Audio und Wellenform wurden aus den gespeicherten Edit-Segmenten neu projiziert.`,
        originalSha256: 'NOT_COMPUTED_READ_ONLY_SOURCE',
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error('SYSTEM', '[Projekt] Öffnen fehlgeschlagen', {
        error: err instanceof Error ? err.message : String(err),
      });
      alert(`Projekt konnte nicht geöffnet werden: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [showOperationFeedback]);

  // Audio file loading (WAV, MP3, FLAC, AIFF)
  const loadAudioFile = async (file: File) => {
    try {
      const arrayBuf = await file.arrayBuffer();
      const audioCtx = audioEngine.getContext();
      const decoded = await audioCtx.decodeAudioData(arrayBuf);
      const analysis = analyzeAudioBuffer(decoded, DataOrigin.LOCAL_ANALYSIS);
      const sha256 = audioEngine.computeBufferChecksum(decoded);

      // One id for the track AND its original segment: they must agree, so the
      // timestamp is sampled once (two Date.now() calls could straddle a tick).
      const newTrackId = nextId('track');
      const newTrack: TrackModel = {
        id: newTrackId,
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
        // Locally imported audio is present (AVAILABLE) but has no re-openable
        // source path, so the project still embeds it (see serializeTrack).
        originalMedia: { location: '', accessMode: 'READ_ONLY', status: 'AVAILABLE' },
        beatGrid: buildBeatGridFromTempo(0.0, 130.0, decoded.duration, 4, DataOrigin.LOCAL_ANALYSIS),
        cues: [
          {
            id: nextId('cue'),
            name: 'Cue 1',
            type: 'MEMORY',
            position: 0.0,
            color: '#ff2a2a',
            origin: DataOrigin.LOCAL_ANALYSIS,
          },
        ],
        loops: [],
        analysis,
        // No template phrases: local audio carries no Rekordbox analysis, so
        // no PSSI song structure exists (phrases stay empty, never invented).
        phrases: [],
        origin: DataOrigin.LOCAL_ANALYSIS,
        workingSegments: [
          {
            id: nextId('seg-edit'),
            type: 'ORIGINAL',
            trackId: newTrackId,
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
      resetEditProjection();
      syncEditProjection(newTrack);
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
      logger.error('AUDIO_ENGINE', 'Fehler beim Decodieren der Audiodatei', {
        error: err instanceof Error ? err.message : String(err),
      });
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
      alert(`Dateityp "${file.name}" wird nicht unterstützt. Bitte Rekordbox XML (.xml) oder Audio (.wav, .mp3, .flac) verwenden. ANLZ wird automatisch über master.db geladen.`);
    }
  };

  /**
   * Window-level file drop: an external file (XML / audio) may be dropped
   * anywhere in the app, not only on the waveform. Internal drags (clips,
   * tracks, selections) are ignored here — their own targets handle them and
   * stop propagation, so this overlay never steals an edit drop.
   */
  const handleDropFileRef = useRef(handleDropFile);
  handleDropFileRef.current = handleDropFile;
  const [externalFileDrag, setExternalFileDrag] = useState(false);
  const dragDepthRef = useRef(0);
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      if (isInternalDrag()) return;
      dragDepthRef.current += 1;
      setExternalFileDrag(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      if (isInternalDrag()) return;
      // Prevent the browser default (which would navigate to the file).
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setExternalFileDrag(true);
    };
    const onDragLeave = () => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setExternalFileDrag(false);
    };
    const onDrop = (e: DragEvent) => {
      dragDepthRef.current = 0;
      setExternalFileDrag(false);
      if (!isFileDrag(e.dataTransfer)) return;
      if (isInternalDrag()) return;
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) handleDropFileRef.current(file);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

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
        }}
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
        onNewProject={() => setProjectName('New Project')}
        onSaveProject={handleSaveProject}
        onExport={() => setExportModalOpen(true)}
        onShowInfo={() => setInfoModalOpen(true)}
        masterVolume={masterVolume}
        onMasterVolumeChange={handleMasterVolumeChange}
        meterL={meterL}
        meterR={meterR}
        paletteViewMode={paletteViewMode}
        onTogglePaletteViewMode={() =>
          setPaletteViewMode((prev) => (prev === 'FULL_DECK' ? 'SIDEBAR' : 'FULL_DECK'))
        }
      />

      {/* 4. Track Header & Overview Waveform (Authentic Pioneer DJ Header) */}
      <TrackHeader
        track={activeTrack}
        currentTime={currentTime}
        viewOffset={viewOffset}
        viewDuration={viewDuration}
        onSeek={handleSeek}
        onPanView={handlePanView}
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
          onSetFirstBeatHere={handleSetFirstBeatHere}
          onShiftBeatgrid={handleShiftBeatgrid}
          onAutoAlignBeatgrid={handleAutoAlignBeatgrid}
          onOpenDatabaseInspector={() => setDbExtractionModalOpen(true)}
          onImportXmlClick={() => xmlFileInputRef.current?.click()}
          onLoadAudioClick={() => audioFileInputRef.current?.click()}
          onDropFile={handleDropFile}
          spans={spanViews}
          clipInfo={(clipId) => {
            const clip = paletteClips.find((c) => c.id === clipId);
            return clip ? { name: clip.name, duration: clip.duration } : null;
          }}
          onDropClip={(clipId, projectStart, mode, windowEnd) =>
            handleDropClipOnDeck(clipId, projectStart, mode, windowEnd)
          }
          onDropTrack={handleDropTrackOnDeck}
          onMoveSpan={handleMoveClipSegment}
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
            onDropSelection={(startSec, endSec) => {
              // The dropped window is authoritative — it is what the user dragged,
              // even if the visible selection changed in the meantime.
              if (endSec - startSec > 0.02) handleAddSelectionToPalette(startSec, endSec);
            }}
            matchPitch={matchPitchOnInsert}
            onToggleMatchPitch={setMatchPitchOnInsert}
            targetBpm={activeTrack?.bpm}
            targetKey={activeTrack?.key}
          />
        )}
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
            onDropClipIntoDeckA={(clipId) => {
              const clip = paletteClips.find((c) => c.id === clipId);
              if (clip) handleInsertClipToDeckA(clip);
            }}
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
      />

      {/* 7. Bottom Strip: BROWSER tab, Pioneer Rekordbox branding & Track Collection */}
      <BrowserMultiTrackBar
        isOpen={browserOpen}
        onToggle={() => setBrowserOpen(!browserOpen)}
        tracks={tracks}
        activeTrackId={activeTrackId}
        onSelectTrack={(id) => {
          const t = tracks.find((tr) => tr.id === id);
          if (t) loadTrackIntoDeck(t);
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

      {/* Externes File-Drop: eine Datei darf überall im Fenster abgelegt werden */}
      {externalFileDrag && (
        <div className="fixed inset-0 z-[90] pointer-events-none flex items-center justify-center bg-[#0088ff]/10">
          <div className="border-2 border-dashed border-[#00a2ff] rounded-lg bg-[#0b0c0f]/92 px-8 py-6 text-center shadow-2xl">
            <p className="text-sm font-bold text-white uppercase tracking-wide font-mono">
              Datei hier ablegen
            </p>
            <p className="text-[11px] text-neutral-400 mt-1 font-mono">
              Rekordbox XML · Audio (WAV / MP3 / FLAC / AIFF / M4A / OGG)
            </p>
            <p className="text-[10px] text-[#00a2ff] mt-2 font-mono">
              Clips und Tracks liegen auf ihren eigenen Zielen: Timeline, Palette, Papierkorb
            </p>
            <p className="text-[10px] text-emerald-400 mt-1 font-mono">
              ORIGINALSCHUTZ: Quellendateien werden nur lesend geöffnet
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
