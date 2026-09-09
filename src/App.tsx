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
import { analyzeAudioBuffer, extractMiniPeaks } from './waveform/analyzer';
import { audioEngine } from './audio/audioEngine';
import {
  parseRekordboxXmlAsync,
  XmlImportProgress,
  buildBeatGridFromTempo,
} from './rekordbox/xmlParser';
import { applyAnlzExtractionToTrack, AnlzExtractionResult, mergeAnlzExtractions, parseAnlzBinary } from './rekordbox/databaseExtractor';
import { initFileLogging } from './utils/fileLog';
import { adoptSerializedGrid, describeGridEdit, ensureArrayBuffer, isRekordboxOrigin, ppthMismatchNote, shiftBeatNodes } from './rekordbox/trackGuards';
import { logger } from './utils/logger';
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
    beatGrid: pt.beatGrid || buildBeatGridFromTempo(0.0, bpm, duration, 4, origin),
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
 * (AnalysisDataPath) and merges it into the track. Returns the track unchanged
 * when no path is present or the file cannot be read. Read-only, never throws.
 */
async function tryAutoLoadAnlz(track: TrackModel): Promise<TrackModel> {
  const anlzPath = track.rawXmlAttributes?.analysisDataPath?.trim();
  if (!anlzPath || !window.rekordboxDesktop) return track;
  const sourceDbDir = track.rawXmlAttributes?.sourceDbDir;
  // Deterministic resolution only: <dbDir>/share/PIONEER/USBANLZ/... or a
  // verbatim absolute path. Unresolvable values fall back to manual ANLZ
  // assignment — never to searching or guessing.
  const resolved = resolveAnalysisFilePath(sourceDbDir, anlzPath);
  logger.info('DATABASE', `[ANLZ Auto] Auflösung „${track.title}"`, {
    analysisDataPath: anlzPath,
    sourceDbDir: sourceDbDir ?? null,
    resolved: resolved ?? null,
  });
  if (!resolved) {
    logger.warn('DATABASE', '[ANLZ Auto] Keine deterministische Auflösung — manuelle ANLZ-Zuordnung erforderlich.', {
      analysisDataPath: anlzPath,
      sourceDbDir: sourceDbDir ?? null,
    });
    console.info(`[ANLZ Auto] Keine deterministische Auflösung für AnalysisDataPath (${anlzPath}); manuelle ANLZ-Zuordnung erforderlich.`);
    return track;
  }
  const variantSummary = (e: AnlzExtractionResult) =>
    e.waveformVariants.map((v) => ({ tag: v.sourceTag, buckets: v.length }));
  try {
    const source = await window.rekordboxDesktop.readAnalysisFile(resolved);
    let extraction = parseAnlzBinary(ensureArrayBuffer(source.data as ArrayBuffer | Uint8Array));
    logger.info('DATABASE', '[ANLZ Auto] Primärcontainer gelesen', {
      path: resolved,
      bytes: source.size ?? null,
      tags: extraction.tagsFound.join(','),
      waveformVariants: variantSummary(extraction),
      bestWaveform: extraction.waveform ? `${extraction.waveform.sourceTag}:${extraction.waveform.length}` : null,
      beatNodes: extraction.beatGrid?.beats.length ?? 0,
      bpm: extraction.bpm ?? null,
      firstBeat: extraction.firstBeat ?? null,
      cues: extraction.cues.length,
      loops: extraction.loops.length,
      phrases: extraction.phrases.length,
      ppth: extraction.analysisPath ?? null,
    });
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
        logger.info('DATABASE', '[ANLZ Auto] Schwesterdatei gelesen & gemergt', {
          path: sibling,
          bytes: extSource.size ?? null,
          tags: extExtraction.tagsFound.join(','),
          waveformVariants: variantSummary(extExtraction),
          mergedVariants: variantSummary(extraction),
          phrases: extExtraction.phrases.length,
          cues: extExtraction.cues.length,
        });
      } catch (siblingError) {
        logger.warn('DATABASE', '[ANLZ Auto] Schwesterdatei nicht lesbar — Farb-Waveform (PWV5)/Phrasen (PSSI) ggf. nicht verfügbar.', {
          path: sibling,
          error: siblingError instanceof Error ? siblingError.message : String(siblingError),
        });
        console.info(`[ANLZ Auto] Keine Schwesterdatei (${sibling}); Farb-Waveform (PWV5)/Phrasen (PSSI) ggf. nicht verfügbar.`);
      }
    } else {
      logger.info('DATABASE', '[ANLZ Auto] Keine Schwesterdatei abgeleitet (Ziel-Extension bereits vorhanden).', { path: resolved });
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
    if (!merged.analysis) {
      logger.warn('DATABASE', '[ANLZ Auto] ANLZ enthält KEINE Waveform-Variante (kein PWAV/PWV-Tag) — Deck zeigt ehrlichen Leerzustand.', {
        title: track.title,
        resolved,
        tags: extraction.tagsFound.join(','),
      });
    }
    console.info(`[ANLZ Auto] ${resolved} → ${extraction.tagsFound.join(', ')}`);
    return merged;
  } catch (error) {
    logger.error('DATABASE', '[ANLZ Auto] ANLZ-Datei nicht lesbar — Track bleibt ohne ANLZ-Daten.', {
      resolved,
      error: error instanceof Error ? error.message : String(error),
    });
    console.warn(`[ANLZ Auto] ANLZ-Datei nicht lesbar (${resolved}); Track bleibt ohne ANLZ-Daten.`, error);
    return track;
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
  const dbAutoLoadAttemptedRef = useRef(false);

  // PPTH-based ANLZ index (SQLCipher-independent fallback): every ANLZ
  // container records the exact audio path in its PPTH header. The desktop
  // bridge scans the standard analysis folders (read-only, headers only) and
  // returns exact audio-path matches, so REKORDBOX_XML tracks get their
  // genuine Rekordbox waveform even when no master.db/exportLibrary.db is
  // readable. One lazy scan per session; misses are remembered.
  const anlzPpthIndexRef = useRef<Map<string, { datPath: string | null; extPath: string | null; matchTier: 1 | 2; note?: string }>>(new Map());
  const anlzPpthScanStateRef = useRef<'IDLE' | 'RUNNING' | 'DONE'>('IDLE');
  const anlzPpthMissedKeysRef = useRef<Set<string>>(new Set());
  const anlzPpthScanPromiseRef = useRef<Promise<void> | null>(null);
  const anlzPpthScanInfoRef = useRef<{ scanned: number; folders: number; elapsedMs: number; truncated: boolean } | null>(null);

  // Auto-populate the XML→DB ANLZ index directly from the local Rekordbox
  // databases (master.db / exportLibrary.db) without manual user assignment.
  // This fulfills REKORDBOX_XML → Waveform ausschließlich aus ANLZ/DB:
  // the Desktop bridge scans %APPDATA%/Pioneer/rekordbox* read-only and the
  // renderer builds the exact-match audio-path → AnalysisDataPath map.
  const ensureDbAnalysisIndex = useCallback(async () => {
    if (dbAnalysisIndexRef.current.size > 0) return dbAnalysisIndexRef.current;
    if (dbAutoLoadAttemptedRef.current) return dbAnalysisIndexRef.current;
    if (!window.rekordboxDesktop) return dbAnalysisIndexRef.current;
    dbAutoLoadAttemptedRef.current = true;
    try {
      const candidates = await window.rekordboxDesktop.locateRekordboxDatabases();
      if (!candidates || candidates.length === 0) {
        console.info('[DB Auto] Keine lokale Rekordbox-Datenbank gefunden (master.db / exportLibrary.db). XML-Tracks bleiben bis zur DB-Zuordnung auf Vorschau.');
        return dbAnalysisIndexRef.current;
      }
      for (const cand of candidates) {
        try {
          const result = await window.rekordboxDesktop.readRekordboxDatabase(cand.path);
          if (!result.available || !result.rows) {
            console.warn(`[DB Auto] ${cand.path}: ${result.reason || 'nicht lesbar'}`);
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
          console.info(`[DB Auto] ${cand.label || cand.path}: ${mapped.stats.tracks} Tracks, ${added} neue ANLZ-Links (gesamt ${dbAnalysisIndexRef.current.size})`);
          logger.info('DATABASE', `[DB Auto] ${cand.path}: ${mapped.stats.tracks} Tracks, ${added} ANLZ-Links`, { dbType: result.dbType });
          if (mapped.warnings?.length || result.warnings?.length) {
            console.warn('[DB Auto] Hinweise:', [...(mapped.warnings || []), ...(result.warnings || [])]);
          }
        } catch (e) {
          console.warn(`[DB Auto] Fehler bei ${cand.path}:`, e);
        }
      }
    } catch (e) {
      console.warn('[DB Auto] locateRekordboxDatabases fehlgeschlagen:', e);
    }
    return dbAnalysisIndexRef.current;
  }, []);

  // SQLCipher-unabhängige ANLZ-Auflösung: Jeder ANLZ-Container speichert den
  // exakten Audio-Pfad im PPTH-Header. Die Desktop-Bridge scannt die
  // Standard-Verzeichnisstrukturen (nur Header lesen, read-only) und liefert
  // exakte Treffer – so bekommt ein REKORDBOX_XML-Track seine echte
  // Rekordbox-Waveform, selbst wenn keine master.db/exportLibrary.db lesbar
  // ist. Einmalig lazy pro Session; bekannte Verfehlungen werden gemerkt.
  const ensureAnlzPpthIndex = useCallback(async (track: TrackModel, linkKey: string): Promise<void> => {
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
        const truncated = result.truncated === true;
        anlzPpthScanInfoRef.current = { scanned: result.scanned, folders: result.folders.length, elapsedMs: result.elapsedMs, truncated };
        for (const t of targets) {
          const k = normalizeAudioKey(t);
          if (k && !anlzPpthIndexRef.current.has(k)) anlzPpthMissedKeysRef.current.add(k);
        }
        console.info(
          `[ANLZ PPTH-Scan] ${result.scanned} ANLZ-Dateien gescannt (rekursiv, ` +
            `${result.folders.length} Ordner, ${result.elapsedMs} ms) → ${added} exakte Zuordnung(en).` +
            (truncated ? ' [HINWEIS: Scan-Limit erreicht, Teilergebnis]' : '')
        );
        logger.info('DATABASE', `[ANLZ PPTH-Scan] ${result.scanned} Dateien, ${added} Treffer`, {
          folders: result.folders,
          elapsedMs: result.elapsedMs,
          recursive: true,
          truncated,
          ppthSample: result.ppthSample ?? [],
        });
      } catch (e) {
        console.warn('[ANLZ PPTH-Scan] fehlgeschlagen:', e);
      } finally {
        anlzPpthScanStateRef.current = 'DONE';
        anlzPpthScanPromiseRef.current = null;
      }
    })();
    anlzPpthScanPromiseRef.current = promise;
    await promise;
  }, [xmlImportedTracks, tracks]);

  // Active track helper (supports empty state)
  const activeTrack = tracks.find((t) => t.id === activeTrackId) || tracks[0] || null;

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
    applyGridShift(shift, 'AUTO_ALIGN');
  }, [activeTrack, currentTime, applyGridShift]);

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

  // Snapshot current state for Undo (the beat grid is included so manual
  // grid edits stay reversible and the original grid stays traceable).
  const pushHistorySnapshot = (desc: string) => {
    if (!activeTrack) return;
    const snapshot: EditHistoryEntry = {
      description: desc,
      timestamp: Date.now(),
      segments: JSON.parse(JSON.stringify(activeTrack.workingSegments)),
      selection: selection ? { ...selection } : null,
      cues: JSON.parse(JSON.stringify(activeTrack.cues)),
      beatGrid: JSON.parse(JSON.stringify(activeTrack.beatGrid)),
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
      beatGrid: JSON.parse(JSON.stringify(activeTrack.beatGrid)),
    };
    setRedoStack((prev) => [...prev, currentSnapshot]);

    // Restore
    activeTrack.workingSegments = previous.segments;
    activeTrack.cues = previous.cues;
    if (previous.beatGrid) activeTrack.beatGrid = previous.beatGrid;
    setSelection(previous.selection);

    // Audio re-render only when audio exists; metadata-only tracks (e.g.
    // grid edits without readable originals) still undo their model state.
    if (activeTrack.audioBuffer) {
      const reRendered = audioEngine.renderWorkingAudio(activeTrack.audioBuffer, previous.segments);
      setWorkingAudioBuffer(reRendered);
    } else {
      setTracks((prev) => [...prev]);
    }
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
      beatGrid: JSON.parse(JSON.stringify(activeTrack.beatGrid)),
    };
    setUndoStack((prev) => [...prev, currentSnapshot]);

    activeTrack.workingSegments = next.segments;
    activeTrack.cues = next.cues;
    if (next.beatGrid) activeTrack.beatGrid = next.beatGrid;
    setSelection(next.selection);

    if (activeTrack.audioBuffer) {
      const reRendered = audioEngine.renderWorkingAudio(activeTrack.audioBuffer, next.segments);
      setWorkingAudioBuffer(reRendered);
    } else {
      setTracks((prev) => [...prev]);
    }
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

  // Add selection to Palette (CLONE or '+' button)
  const handleAddSelectionToPalette = () => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    const sliced = audioEngine.sliceAudioBuffer(workingAudioBuffer, selection.start, selection.end);
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
      miniPeaks: extractMiniPeaks(sliced, 48),
      origin: DataOrigin.PROJECT,
    };

    setPaletteClips((prev) => [...prev, newClip]);
    setSelectedClipId(newClipId);
    if (!paletteOpen) setPaletteOpen(true);
  };

  // Copy selection
  const handleCopy = () => {
    if (!selection || !workingAudioBuffer) return;
    const sliced = audioEngine.sliceAudioBuffer(workingAudioBuffer, selection.start, selection.end);
    setClipboardBuffer(sliced);
  };

  // Cut selection
  const handleCut = () => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    handleCopy();
    handleDelete();
  };

  // Paste at playhead
  const handlePaste = () => {
    if (!clipboardBuffer || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Paste');

    const pasteDuration = clipboardBuffer.duration;
    const newSeg: EditSegment = {
      id: `paste-${Date.now()}`,
      type: 'INSERT',
      trackId: activeTrack.id,
      sourceStart: 0,
      sourceEnd: pasteDuration,
      projectStart: currentTime,
      projectDuration: pasteDuration,
      clipBuffer: clipboardBuffer,
      gain: 1.0,
    };

    const updatedSegments = [...activeTrack.workingSegments, newSeg];
    activeTrack.workingSegments = updatedSegments;

    const rendered = audioEngine.renderWorkingAudio(activeTrack.audioBuffer!, updatedSegments);
    setWorkingAudioBuffer(rendered);
  };

  // Insert (shifts timeline and subsequent markers)
  const handleInsert = () => {
    if (!clipboardBuffer || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Insert');

    const shiftAmount = clipboardBuffer.duration;
    const insertPos = currentTime;

    // Mathematically shift cues occurring after insert position
    activeTrack.cues = activeTrack.cues.map((c) => {
      if (c.position >= insertPos) {
        return { ...c, position: c.position + shiftAmount };
      }
      return c;
    });

    const newSeg: EditSegment = {
      id: `insert-${Date.now()}`,
      type: 'INSERT',
      trackId: activeTrack.id,
      sourceStart: 0,
      sourceEnd: shiftAmount,
      projectStart: insertPos,
      projectDuration: shiftAmount,
      clipBuffer: clipboardBuffer,
      gain: 1.0,
    };

    const updatedSegments = [...activeTrack.workingSegments, newSeg];
    activeTrack.workingSegments = updatedSegments;

    const rendered = audioEngine.renderWorkingAudio(activeTrack.audioBuffer!, updatedSegments);
    setWorkingAudioBuffer(rendered);

    showOperationFeedback({
      title: 'Audio Segment eingefügt (Insert)',
      operationType: 'INSERT',
      description: `Audio-Material (${shiftAmount.toFixed(3)}s) an Playhead-Position ${insertPos.toFixed(3)}s eingefügt. Nachfolgende Cues und Wellenform wurden um +${shiftAmount.toFixed(3)}s verschoben.`,
      timeRangeSec: { start: insertPos, end: insertPos + shiftAmount, duration: shiftAmount },
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

    const shiftAmount = adapted.newDuration;
    const insertPos = currentTime;

    // Shift cues occurring after insert position
    activeTrack.cues = activeTrack.cues.map((c) => {
      if (c.position >= insertPos) {
        return { ...c, position: c.position + shiftAmount };
      }
      return c;
    });

    const newSeg: EditSegment = {
      id: `insert-clip-${Date.now()}`,
      type: 'INSERT',
      trackId: activeTrack.id,
      sourceStart: 0,
      sourceEnd: shiftAmount,
      projectStart: insertPos,
      projectDuration: shiftAmount,
      clipId: clip.id,
      clipBuffer: adapted.adaptedBuffer,
      gain: 1.0,
    };

    const updatedSegments = [...activeTrack.workingSegments, newSeg];
    activeTrack.workingSegments = updatedSegments;

    const rendered = audioEngine.renderWorkingAudio(activeTrack.audioBuffer!, updatedSegments);
    setWorkingAudioBuffer(rendered);

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
      timeRangeSec: { start: insertPos, end: insertPos + shiftAmount, duration: shiftAmount },
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

    // Adapt clip audio: tempo is always matched to destination track, pitch is matched if matchPitchOnInsert is true
    const adapted = audioEngine.adaptClipToTrack(clip, activeTrack, matchPitchOnInsert);

    const replaceSeg: EditSegment = {
      id: `replace-${Date.now()}`,
      type: 'REPLACE',
      trackId: activeTrack.id,
      sourceStart: 0,
      sourceEnd: Math.min(adapted.newDuration, selection.duration),
      projectStart: selection.start,
      projectDuration: selection.duration,
      clipId: clip.id,
      clipBuffer: adapted.adaptedBuffer,
      gain: 1.0,
    };

    const updatedSegments = [...activeTrack.workingSegments, replaceSeg];
    activeTrack.workingSegments = updatedSegments;

    const rendered = audioEngine.renderWorkingAudio(activeTrack.audioBuffer!, updatedSegments);
    setWorkingAudioBuffer(rendered);

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

    const overdubSeg: EditSegment = {
      id: `overdub-${Date.now()}`,
      type: 'OVERDUB',
      trackId: activeTrack.id,
      sourceStart: 0,
      sourceEnd: Math.min(adapted.newDuration, selection.duration),
      projectStart: selection.start,
      projectDuration: selection.duration,
      clipId: clip.id,
      clipBuffer: adapted.adaptedBuffer,
      gain: 1.0,
    };

    const updatedSegments = [...activeTrack.workingSegments, overdubSeg];
    activeTrack.workingSegments = updatedSegments;

    const rendered = audioEngine.renderWorkingAudio(activeTrack.audioBuffer!, updatedSegments);
    setWorkingAudioBuffer(rendered);

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

  // Delete selection (removes range and shifts subsequent material)
  const handleDelete = () => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Delete');

    const delDuration = selection.duration;
    const delStart = selection.start;

    // Shift cues occurring after delete
    activeTrack.cues = activeTrack.cues
      .filter((c) => c.position < delStart || c.position > selection.end)
      .map((c) => {
        if (c.position > selection.end) {
          return { ...c, position: Math.max(0, c.position - delDuration) };
        }
        return c;
      });

    // Create a new buffer with that duration removed
    const audioCtx = audioEngine.getContext();
    const rate = workingAudioBuffer.sampleRate;
    const startIdx = Math.floor(delStart * rate);
    const endIdx = Math.floor(selection.end * rate);
    const delSamples = endIdx - startIdx;
    const newLength = Math.max(1, workingAudioBuffer.length - delSamples);

    const newBuffer = audioCtx.createBuffer(
      workingAudioBuffer.numberOfChannels,
      newLength,
      rate
    );

    for (let ch = 0; ch < workingAudioBuffer.numberOfChannels; ch++) {
      const src = workingAudioBuffer.getChannelData(ch);
      const dest = newBuffer.getChannelData(ch);
      dest.set(src.subarray(0, startIdx), 0);
      dest.set(src.subarray(endIdx), startIdx);
    }

    setWorkingAudioBuffer(newBuffer);
    activeTrack.duration = newBuffer.duration;
    activeTrack.analysis = analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT);

    showOperationFeedback({
      title: 'Auswahl gelöscht (Delete)',
      operationType: 'DELETE',
      description: `Bereich (${delDuration.toFixed(3)}s / ${selection.barsCount.toFixed(1)} Takte) gelöscht. Nachfolgendes Audio-Material um -${delDuration.toFixed(3)}s nach vorne gerückt.`,
      timeRangeSec: { start: delStart, end: selection.end, duration: delDuration },
      barsCount: selection.barsCount,
      beatsCount: selection.beatsCount,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });

    setSelection(null);
  };

  // Clear selection (silences range without changing duration)
  const handleClear = () => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Clear');

    const rate = workingAudioBuffer.sampleRate;
    const startIdx = Math.floor(selection.start * rate);
    const endIdx = Math.floor(selection.end * rate);

    const audioCtx = audioEngine.getContext();
    const newBuffer = audioCtx.createBuffer(
      workingAudioBuffer.numberOfChannels,
      workingAudioBuffer.length,
      rate
    );

    for (let ch = 0; ch < workingAudioBuffer.numberOfChannels; ch++) {
      const src = workingAudioBuffer.getChannelData(ch);
      const dest = newBuffer.getChannelData(ch);
      dest.set(src);
      // Zero out range
      for (let i = startIdx; i < endIdx && i < dest.length; i++) {
        dest[i] = 0;
      }
    }

    setWorkingAudioBuffer(newBuffer);
    activeTrack.analysis = analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT);

    showOperationFeedback({
      title: 'Bereich stummgeschaltet (Clear / Mute)',
      operationType: 'CLEAR',
      description: `Bereich (${selection.duration.toFixed(3)}s / ${selection.barsCount.toFixed(1)} Takte) stummgeschaltet. Timeline-Dauer und Beatgrid-Synchronisation unverändert erhalten.`,
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
  const handleImportAnlzData = async (data: ArrayBuffer | Uint8Array, fileName: string, sourcePath?: string) => {
    if (!activeTrack) return;

    try {
      let extraction = parseAnlzBinary(ensureArrayBuffer(data));
      logger.info('DATABASE', '[ANLZ Import] Container gelesen', {
        fileName,
        sourcePath: sourcePath ?? null,
        bytes: data.byteLength,
        tags: extraction.tagsFound.join(','),
        waveformVariants: extraction.waveformVariants.map((v) => ({ tag: v.sourceTag, buckets: v.length })),
        bestWaveform: extraction.waveform ? `${extraction.waveform.sourceTag}:${extraction.waveform.length}` : null,
        beatNodes: extraction.beatGrid?.beats.length ?? 0,
        cues: extraction.cues.length,
        loops: extraction.loops.length,
        phrases: extraction.phrases.length,
        ppth: extraction.analysisPath ?? null,
      });
      // Same sibling rule as the auto path: a manually assigned ANLZnnnn.DAT
      // is merged with its ANLZnnnn.EXT (color waveform/phrases) when the
      // desktop bridge knows the file path.
      if (sourcePath && window.rekordboxDesktop) {
        const sibling =
          deriveSiblingExtension(sourcePath, 'EXT') ?? deriveSiblingExtension(sourcePath, 'DAT');
        if (sibling) {
          try {
            const extSource = await window.rekordboxDesktop.readAnalysisFile(sibling);
            const extExtraction = parseAnlzBinary(ensureArrayBuffer(extSource.data as ArrayBuffer | Uint8Array));
            // Positional merge (primary = DAT, secondary = EXT), regardless
            // of which sibling the user picked.
            extraction = /\.ext$/i.test(sibling)
              ? mergeAnlzExtractions(extraction, extExtraction)
              : mergeAnlzExtractions(extExtraction, extraction);
            logger.info('DATABASE', '[ANLZ Import] Schwesterdatei gelesen & gemergt', {
              path: sibling,
              bytes: extSource.size ?? null,
              tags: extExtraction.tagsFound.join(','),
              waveformVariants: extExtraction.waveformVariants.map((v) => ({ tag: v.sourceTag, buckets: v.length })),
              phrases: extExtraction.phrases.length,
            });
            console.info(`[ANLZ Import] +Schwesterdatei ${sibling}`);
          } catch (siblingError) {
            logger.warn('DATABASE', '[ANLZ Import] Schwesterdatei nicht lesbar; nur Primärcontainer importiert.', {
              path: sibling,
              error: siblingError instanceof Error ? siblingError.message : String(siblingError),
            });
            console.info(`[ANLZ Import] Keine Schwesterdatei (${sibling}); importiere nur ${fileName}.`);
          }
        }
      }
      const enrichedTrack = applyAnlzExtractionToTrack(activeTrack, extraction);
      logger.info('DATABASE', '[ANLZ Import] Übernommen', {
        fileName,
        title: enrichedTrack.title,
        waveform: enrichedTrack.analysis ? `${enrichedTrack.analysis.sourceTag ?? 'ANLZ'}:${enrichedTrack.analysis.length}` : null,
        waveformVariants: enrichedTrack.analysisVariants?.length ?? 0,
        beatGridOrigin: enrichedTrack.beatGrid.origin,
        beatNodes: enrichedTrack.beatGrid.beats?.length ?? 0,
        cues: enrichedTrack.cues.length,
        loops: enrichedTrack.loops.length,
        phrases: enrichedTrack.phrases?.length ?? 0,
        warnings: extraction.warnings,
      });
      if (!enrichedTrack.analysis) {
        logger.warn('DATABASE', '[ANLZ Import] Importierte Datei enthält KEINE Waveform-Variante (kein PWAV/PWV-Tag).', {
          fileName,
          tags: extraction.tagsFound.join(','),
        });
      }
      // Same plausibility guard as the auto path: the PPTH source path inside
      // the container should reference this track's audio file.
      const expectedPath = activeTrack.originalMedia?.resolvedPath || activeTrack.originalMedia?.location || '';
      const ppthNote = ppthMismatchNote(extraction.analysisPath, expectedPath);
      if (ppthNote) {
        console.warn(`[ANLZ Import] ${ppthNote}`);
        logger.warn('DATABASE', `[ANLZ Import] ${ppthNote}`, { fileName, analysisPath: extraction.analysisPath });
        if (enrichedTrack.databaseRecord) {
          enrichedTrack.databaseRecord.anlzWarnings = [...(enrichedTrack.databaseRecord.anlzWarnings ?? []), ppthNote];
        }
      }
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
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ANLZ Import] Rekordbox-Analyse konnte nicht gelesen werden:', error);
      logger.error('DATABASE', `[ANLZ Import] ${fileName}: ${message}`);
      // Import failures must be visible: a silently closed picker with no
      // waveform is indistinguishable from a bug.
      showOperationFeedback({
        title: 'ANLZ-Import fehlgeschlagen',
        operationType: 'CUE',
        description: `${fileName} konnte nicht gelesen werden (${message}). Die Datei bleibt unverändert; es wurden keine Daten übernommen.`,
        originalSha256: activeTrack?.originalSha256 ?? 'UNKNOWN',
        timestamp: Date.now(),
      });
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
      await handleImportAnlzData(ensureArrayBuffer(source.data as ArrayBuffer | Uint8Array), fileName, chosen.path);
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

      // Anchor every DB track to its database directory so AnalysisDataPath
      // values resolve deterministically to <dbDir>/share/PIONEER/USBANLZ/...
      const sourceDbDir = dirOfPath(dbPath);
      const fullTrackModels = mapped.tracks.map((track, idx) => {
        track.rawXmlAttributes = { ...(track.rawXmlAttributes ?? {}), sourceDbDir };
        return buildCollectionTrackModel(track, idx, DataOrigin.REKORDBOX_DB);
      });

      // Rebuild the deterministic XML→DB link index (exact audio-path match).
      dbAnalysisIndexRef.current = buildDbAnalysisIndex(fullTrackModels, sourceDbDir);

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
          console.warn('[XML Location] Originalaudio konnte nicht gelesen werden; Track wird ohne Audio geladen (kein Ersatz-Audio).', error);
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
      const analysis = rbExclusive
        ? (selectedDef.analysis ?? null)
        : (selectedDef.analysis || (originalAudio ? analyzeAudioBuffer(originalAudio, DataOrigin.LOCAL_ANALYSIS) : null));
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
      let anlzLookup: { via: 'DB' | 'PPTH' | 'PPTH_NAME' | null; scanned: number; folders: number; elapsedMs: number; truncated?: boolean; note?: string } | null = null;
      if (rbExclusive && !selectedDef.rawXmlAttributes?.analysisDataPath?.trim()) {
        if (dbAnalysisIndexRef.current.size === 0) {
          await ensureDbAnalysisIndex();
        }
        const linkKey = normalizeAudioKey(
          selectedDef.originalMedia?.location || selectedDef.originalMedia?.resolvedPath || ''
        );
        const linkRef = linkKey ? dbAnalysisIndexRef.current.get(linkKey) : undefined;
        if (linkRef) {
          linkedRawXmlAttributes = {
            ...(selectedDef.rawXmlAttributes ?? {}),
            analysisDataPath: linkRef.analysisDataPath,
            sourceDbDir: linkRef.sourceDbDir,
          };
          anlzLookup = { via: 'DB', scanned: 0, folders: 0, elapsedMs: 0 };
          console.info(`[Track-Link] XML-Track exakt mit DB-Analyse verknüpft (DB-Track ${linkRef.trackId}).`);
        } else if (linkKey) {
          // PPTH-Fallback (SQLCipher-unabhängig): exakter Treffer über die
          // PPTH-Header der ANLZ-Container in den Standard-Verzeichnissen.
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
              truncated: scanInfo?.truncated ?? false,
              note: ppthEntry.note,
            };
            console.info(`[Track-Link] XML-Track mit ANLZ verknüpft (PPTH-Scan Tier ${ppthEntry.matchTier}: ${ppthFile}).`);
          } else {
            anlzLookup = {
              via: null,
              scanned: scanInfo?.scanned ?? 0,
              folders: scanInfo?.folders ?? 0,
              elapsedMs: scanInfo?.elapsedMs ?? 0,
              truncated: scanInfo?.truncated ?? false,
            };
            console.info(
              `[Track-Link] Kein DB-Eintrag und kein PPTH-Treffer für ${linkKey} ` +
                `(${anlzLookup.scanned} ANLZ-Dateien in ${anlzLookup.folders} Ordner(n) gescannt) – ` +
                `Track bleibt auf VORSCHAU (manuelle ANLZ-Zuordnung über DATA möglich).`
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
        sampleRate: originalAudio ? originalAudio.sampleRate : (selectedDef.sampleRate || 44100),
        channels: originalAudio ? originalAudio.numberOfChannels : (selectedDef.channels || 2),
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
        analysis,
        phrases,
        originalMedia,
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

      // Auto-resolve the ANLZ analysis file for tracks carrying an
      // AnalysisDataPath (Rekordbox database imports).
      let anlzApplied = false;
      if (rbExclusive) {
        const before = loadedTrack;
        loadedTrack = await tryAutoLoadAnlz(loadedTrack);
        anlzApplied = loadedTrack !== before;
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
      if (rbExclusive && !loadedTrack.analysis) {
        logger.warn('XML_IMPORT', `[Deck] „${loadedTrack.title}": KEINE Waveform — Rekordbox-Track ohne ANLZ-Daten; ehrlicher Leerzustand aktiv.`, {
          title: loadedTrack.title,
          origin: loadedTrack.origin,
          analysisDataPath: loadedTrack.rawXmlAttributes?.analysisDataPath ?? null,
          sourceDbDir: loadedTrack.rawXmlAttributes?.sourceDbDir ?? null,
          hint: 'ANLZ-Datei (ANLZnnnn.DAT/.EXT) über DATA-Panel zuordnen oder AnalysisDataPath in der DB prüfen.',
        });
      }

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

      if (!originalAudio || (!loadedTrack.analysis && rbExclusive)) {
        const missingAudio = !originalAudio;
        showOperationFeedback({
          title: missingAudio ? 'Rekordbox-Track ohne Audio geladen' : 'Rekordbox-Track geladen (ohne ANLZ-Waveform)',
          operationType: 'CUE',
          description: `"${loadedTrack.title}": Beatgrid, Cues und Loops stammen aus den Rekordbox-Importdaten. ` +
            (missingAudio
              ? 'Das Originalaudio ist nicht verfügbar – es wird kein Ersatz-Audio erzeugt. '
              : '') +
            (loadedTrack.analysis
              ? `Waveform: ${loadedTrack.analysis.length} Buckets aus ANLZ (${loadedTrack.databaseRecord?.anlzTagsFound.join(', ') || 'ANLZ'}).`
              : 'Waveform/Phrasen erscheinen nach ANLZ-Zuordnung (DATA-Panel oder AnalysisDataPath).') +
            (anlzApplied ? ' ANLZ-Analyse wurde automatisch zugeordnet.' : ''),
          timeRangeSec: { start: 0, end: duration, duration },
          originalSha256: loadedTrack.originalSha256,
          timestamp: Date.now(),
        });
      }
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
            originalAudio = await audioCtx.decodeAudioData(ensureArrayBuffer(source.data as ArrayBuffer | Uint8Array));
            originalMedia = { ...originalMedia, resolvedPath: source.path, size: source.size, modifiedAt: source.modifiedAt, status: 'AVAILABLE' as const };
          } catch (error) {
            console.warn('[Projekt] Originalaudio konnte nicht erneut geöffnet werden; Metadaten bleiben verfügbar.', error);
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
          const working = audioEngine.renderWorkingAudio(originalAudio, withAudio.workingSegments);
          setWorkingAudioBuffer(working);
          setTracks((prev) => prev.map((t) => (t.id === withAudio.id ? withAudio : t)));
        } else if (activeTrack.audioBuffer) {
          setWorkingAudioBuffer(
            audioEngine.renderWorkingAudio(activeTrack.audioBuffer, activeTrack.workingSegments)
          );
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
        // Locally imported audio is present (AVAILABLE) but has no re-openable
        // source path, so the project still embeds it (see serializeTrack).
        originalMedia: { location: '', accessMode: 'READ_ONLY', status: 'AVAILABLE' },
        beatGrid: buildBeatGridFromTempo(0.0, 130.0, decoded.duration, 4, DataOrigin.LOCAL_ANALYSIS),
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
        // No template phrases: local audio carries no Rekordbox analysis, so
        // no PSSI song structure exists (phrases stay empty, never invented).
        phrases: [],
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
    </div>
  );
}
