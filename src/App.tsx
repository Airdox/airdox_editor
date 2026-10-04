/**
 * @license
 * Rekordbox DJ Audio Editor - Master Application
 * Authoritative Visual Lock implementation matching screenshots 01, 02, and 03.
 */

import React, { Suspense, useState, useEffect, useRef, useCallback, useMemo, useReducer } from 'react';
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
  AnalysisFileReference,
  RekordboxCueSource,
} from './types/rekordbox';
import { buildCues, mapRekordboxDatabaseRows } from './rekordbox/dbParser';
import { analyzeAudioBuffer, extractMiniPeaks, estimateBpm } from './waveform/analyzer';
import {
  composeWaveformFromEditSegments,
  isNativeRekordboxWaveform,
  sliceWaveformAnalysis,
} from './waveform/analysisComposer';
import { audioEngine } from './audio/audioEngine';
import { exportAudioBuffer } from './audio/audioExporter';
import { measureRecordingAudio, optimizeRecordingBuffer } from './audio/recordingProcessor';
import { FileAudio, ShieldCheck } from 'lucide-react';
import {
  parseRekordboxXmlAsync,
  buildBeatGridFromTempo,
} from './rekordbox/xmlParser';
import { applyAnlzExtractionToTrack, generateRekordboxPhrases, parseAnlzBinary } from './rekordbox/databaseExtractor';
import {
  serializeProject,
  deserializeProject,
  base64ToBytes,
  SerializedTrack,
} from './rekordbox/projectFile';

/*
 * UI v2.0 – Drei-Zonen-Architektur (docs/UI_V2_DREI_ZONEN.md):
 *   Zone 1 -> Zone1TopBar (dauerhaft, ohne Prozessstatus)
 *   Zone 2 -> TrackHeader + StemCenter + DetailWaveform + Paletten
 *   Zone 3 -> Zone3Footer (eingeklappte Reiter) + BrowserMultiTrackBar
 * Die früheren Zeilen TitleBar/MenuBar/EditModeBar sind in Zone 1 aufgegangen:
 * eine Leiste statt drei. MenuBar lebt unverändert als Menü-Cluster darin.
 */
import { Zone1TopBar } from './components/zones/Zone1TopBar';
import { StemCenter } from './components/zones/StemCenter';
import { Zone3Footer } from './components/zones/Zone3Footer';
import { TransientStatusToast } from './components/zones/TransientStatusToast';
import type { TransientStatusItem } from './components/zones/TransientStatusToast';
import { TrackHeader } from './components/TrackHeader';
import type { DeckStemsControlProps } from './components/DeckStemsControl';
import { StemQualityWarningModal } from './components/Modals/StemQualityWarningModal';
import { StemModelInstallModal } from './components/Modals/StemModelInstallModal';
import {
  LazyClearHistoryModal,
  LazyDatabaseExtractionModal,
  LazyDeleteModeModal,
  LazyEditAssistantModal,
  LazyExportModal,
  LazyMidiControllerModal,
  LazyRecorderModal,
  LazyRekordboxXmlImportModal,
  LazyRemoteFlowModal,
  LazyRemoteSetupModal,
  LazyStemModelInstallModal,
  LazyStemQualityWarningModal,
  LazySystemLogModal,
  LazyWorkspaceSettingsModal,
} from './components/Modals/lazyModals';
import { DetailWaveform } from './components/DetailWaveform';
import { PalettePanel } from './components/PalettePanel';
import { ClipDeckView } from './components/ClipDeckView';
import { BrowserMultiTrackBar } from './components/BrowserMultiTrackBar';
import { ProjectInfoModal } from './components/Modals/ProjectInfoModal';
import { OperationFeedbackModal, OperationTelemetry } from './components/Modals/OperationFeedbackModal';
import { InitialSetupModal } from './components/Modals/InitialSetupModal';
import { RecorderSource, RecorderFormat, RecorderStage } from './components/Modals/RecorderModal';
import {
  stemEngine,
  StemType,
  TrackStems,
  StemsMixerState,
  StemSeparationProgress,
  StemEngineInfo,
  StemQualityProfile,
  ModelFamily,
  SELECTABLE_MODEL_FAMILIES,
  DEFAULT_STEMS_MIXER_STATE,
  STEM_TYPES,
  type RemoteServiceStatus,
} from './audio/stemEngine';
import { applyStemMixDuringPlayback, isCustomStemMix } from './audio/stemPlayback';
import {
  INITIAL_WORKSPACE_PANELS,
  workspaceReducer,
  deriveStemCenterPhase,
  activeStemModelLabel,
  zone3Visible,
} from './ui/workspaceLayout';
import type { StemQualityMode } from './components/zones/StemCenter';
import {
  loadStemArchitectureSettings,
  resolveArchitectureJobOptions,
  saveStemArchitectureSettings,
  loadWorkspacePathSettings,
  saveWorkspacePathSettings,
  architectureLabel,
  type StemArchitectureOption,
  type StemArchitectureSettings,
  type StemArchitectureViewState,
  type WorkspacePathSettings,
} from './audio/stemArchitectures';
import {
  RemoteCancelRequestGuard,
  REMOTE_CANCEL_RETRY_COOLDOWN_MS,
} from './stems/remote/remoteCancelRequestGuard';
import { midiManager } from './midi/midiManager';
import { editAssistant } from './audio/editAssistant';
import { useEditAssistant } from './hooks/useEditAssistant';
import { useEditHistory } from './hooks/useEditHistory';
import { createEditHistoryEntry, restoreEditHistoryEntry } from './audio/editHistory';
import { updateTrackById } from './state/trackUpdates';
import { logger } from './utils/logger';
import {
  getPositionSec,
  getTransport,
  setPosition,
  setTransport,
  subscribeTransport,
} from './state/transportStore';
import { startPlayheadDriver, type PlayheadDriverHandle } from './features/transport/playheadDriver';
import { useTransportControls, DEFAULT_VIEW_DURATION_SEC } from './features/transport/useTransportControls';
import { useMidiBridge } from './features/transport/useMidiBridge';
import { useTrackImport } from './features/import/useTrackImport';
import { useProjectFiles } from './features/project/useProjectFiles';
import { useRecorder } from './features/recorder/useRecorder';
import { useAppSettings } from './state/settingsStore';
import { sha256Hex } from './utils/sha256';
import { ChatbotPalette } from './components/ChatbotPalette';
import { ChatbotAction, TrackEditorContext } from './types/chatbot';
import { analyzeTrackForMixIn, generateAutoCuesForTrack } from './audio/mixAnalysis';
import { detectTrackParts } from './audio/phraseDetection';
import {
  executeCopy,
  executeCut,
  executeRippleDelete,
  executeClear,
  executeInsert,
  executePaste,
  executeReplace,
  executeOverdub,
  applyExecutionToTrack,
  type EditCommandContext,
  type EditExecutionResult,
  isExactSameSourceSlotRoundTrip,
} from './audio/editingEngine';

import {
  BUNDLED_REKORDBOX_XML_FILENAME,
  type ClipboardProvenance,
  areSameMediaPath,
  beatOffsetsForRange,
  buildCollectionTrackModel,
  createEditContext,
  decodeWavBase64,
  nativeSourceCoordinatesForRange,
  rebuildTrackFromSerialized,
} from './features/project/projectModel';
export default function App() {
  /*
   * Viewport & Timeline
   *
   * Die Wiedergabeposition liegt NICHT mehr im React-State: sie wird vom
   * Playhead-Treiber pro Frame in den Transport-Store geschrieben
   * (`src/state/transportStore.ts`). Wer sie braucht, holt sie dort ab –
   * per `getPositionSec()` im Moment der Aktion (exakt) oder über einen
   * gedrosselten Hook (Anzeige). Nur so kostet eine laufende Wiedergabe
   * keinen einzigen Re-Render der Anwendung.
   */
  // Project state - Stringent Empty Project (Master Prompt & Voice Directive)
  const [projectName, setProjectName] = useState<string>('New Project');
  const [tracks, setTrackState] = useState<TrackModel[]>([]);
  const [trackRevision, setTrackRevision] = useState(0);
  const setTracks = useCallback(
    (nextTracks: TrackModel[] | ((current: TrackModel[]) => TrackModel[])) => {
      setTrackRevision((revision) => revision + 1);
      setTrackState(nextTracks);
    },
    []
  );
  /**
   * Ein Track wird ersetzt, nicht an Ort und Stelle verändert: In-Place-Mutation
   * plus `setTracks([...tracks])` funktioniert nur, solange jede Änderung von
   * einem Render gefolgt wird – und ein Edit, der den Arbeitspuffer verändert,
   * würde sonst dieselbe Track-Identität behalten. `updateTrackById` erzeugt ein
   * neues Track-Objekt und damit ein echtes Re-Render.
   */
  const updateTrack = useCallback(
    (trackId: string, update: (track: TrackModel) => TrackModel) => {
      setTracks((current) => updateTrackById(current, trackId, update));
    },
    [setTracks]
  );
  const [activeTrackId, setActiveTrackId] = useState<string>('');
  const [workingAudioBuffer, setWorkingAudioBuffer] = useState<AudioBuffer | null>(null);

  /*
   * Aufnahme-Voreinstellungen und Bearbeitungsverhalten liegen in
   * `state/settingsStore.ts` – samt Persistenz und Standardwerten.
   * Die Setter behalten hier ihre Namen.
   */
  const {
    recordingSource,
    setRecordingSource,
    recordingFormat,
    setRecordingFormat,
    recordingSampleRate,
    setRecordingSampleRate,
    recordingBitDepth,
    setRecordingBitDepth,
    recordingChannels,
    setRecordingChannels,
    recordingLimiter,
    setRecordingLimiter,
    confirmDestructiveEdits,
    setConfirmDestructiveEdits,
    autoSaveProject,
    setAutoSaveProject,
    autoScroll,
    setAutoScroll,
    highQualityRendering,
    setHighQualityRendering,
    snapToBeatgrid,
    setSnapToBeatgrid,
  } = useAppSettings();

  // Viewport & Timeline state
  const [viewOffset, setViewOffset] = useState<number>(0); // detail start in seconds
  const [viewDuration, setViewDuration] = useState<number>(18.0); // zoom window in seconds (default ~9-10 bars @ 130bpm)
  const [waveformMode, setWaveformMode] = useState<WaveformMode>('RGB');
  const [quantize, setQuantize] = useState<boolean>(true);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [loopActive, setLoopActive] = useState<boolean>(false);
  const [masterVolume, setMasterVolume] = useState<number>(0.9);

  // Selection state - Starts with null (Clean Empty Project)
  const [selection, setSelection] = useState<SelectionRange | null>(null);

  // Palette state - Starts completely empty
  /*
   * ── Panel-Zustand der Drei-Zonen-Architektur ─────────────────────────────
   * Zone 3 ist standardmäßig eingeklappt, Zone 2 zeigt die Clip-Palette. Alle
   * schließbaren Panels liegen in EINEM Reducer: der Fokus-Modus („Max. Platz /
   * Alles einklappen") ist damit ein einziger, synchroner Übergang und kann
   * kein Panel vergessen (die Liste steht in `FOCUS_MODE_CLOSES`).
   */
  const [workspace, dispatchWorkspace] = useReducer(workspaceReducer, INITIAL_WORKSPACE_PANELS);
  const {
    focusMode,
    zone3Section,
    stemConfigOpen,
    stemModelPickerOpen,
    paletteOpen,
    deckViewOpen,
    chatbotOpen,
    browserOpen,
  } = workspace;
  const paletteViewMode: 'SIDEBAR' | 'FULL_DECK' = deckViewOpen ? 'FULL_DECK' : 'SIDEBAR';
  const setPaletteOpen = useCallback((open: boolean) => dispatchWorkspace({ type: 'SET_PALETTE', open }), []);
  const setBrowserOpen = useCallback((open: boolean) => dispatchWorkspace({ type: 'SET_BROWSER', open }), []);
  const setChatbotOpenState = useCallback((open: boolean) => dispatchWorkspace({ type: 'SET_CHATBOT', open }), []);
  const setPaletteViewMode = useCallback((mode: 'SIDEBAR' | 'FULL_DECK') => {
    dispatchWorkspace({ type: 'SET_DECK_VIEW', open: mode === 'FULL_DECK' });
  }, []);
  const handleToggleZone3Section = useCallback((section: 'BEAT_SELECT' | 'SELECT' | 'EDIT') => {
    dispatchWorkspace({ type: 'TOGGLE_ZONE3_SECTION', section });
  }, []);
  const handleToggleFocusMode = useCallback(() => dispatchWorkspace({ type: 'TOGGLE_FOCUS_MODE' }), []);

  const [paletteClips, setPaletteClips] = useState<PaletteClip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [matchPitchOnInsert, setMatchPitchOnInsert] = useState<boolean>(true);

  // Clipboard for Copy / Paste / Insert. The compact provenance sidecar keeps
  // ANLZ waveform buckets and beat offsets with a copied selection.
  const [clipboardBuffer, setClipboardBuffer] = useState<AudioBuffer | null>(null);
  const [clipboardProvenance, setClipboardProvenance] = useState<ClipboardProvenance | null>(null);

  // History Stack for Undo / Redo

  // Modals
  const [infoModalOpen, setInfoModalOpen] = useState<boolean>(false);
  const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);
  const [dbExtractionModalOpen, setDbExtractionModalOpen] = useState<boolean>(false);
  const [xmlCollectionModalOpen, setXmlCollectionModalOpen] = useState<boolean>(false);
  const [xmlImportedTracks, setXmlImportedTracks] = useState<TrackModel[]>([]);
  const [xmlFileName, setXmlFileName] = useState<string>(BUNDLED_REKORDBOX_XML_FILENAME);
  const [trackImportLoading, setTrackImportLoading] = useState(false);
  const [analysisIndexStatus, setAnalysisIndexStatus] = useState('');

  // The bundled collection is parsed once. Rekordbox DB/ANLZ data is resolved
  // only for the explicitly selected TrackID through the targeted read-only gate.
  const bundledCollectionPromiseRef = useRef<Promise<TrackModel[]> | null>(null);

  // Operation feedback
  const [feedbackTelemetry, setFeedbackTelemetry] = useState<OperationTelemetry | null>(null);
  const [feedbackModalOpen, setFeedbackModalOpen] = useState<boolean>(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState<boolean>(false);
  // Recording is configured here, not hard-coded: the eventual recorder can use
  // the editor master, a microphone/line input, or Windows/Rekordbox loopback.

  // Dedicated set recorder state. The modal is intentionally independent from
  // the edit transport: Rekordbox can be captured while the editor remains
  // open, and the complete file is mastered only after Stop.

  const [systemLogModalOpen, setSystemLogModalOpen] = useState<boolean>(false);
  const [clearHistoryModalOpen, setClearHistoryModalOpen] = useState<boolean>(false);
  const [editAssistantModalOpen, setEditAssistantModalOpen] = useState<boolean>(false);
  const [deleteModeModalOpen, setDeleteModeModalOpen] = useState<boolean>(false);
  const [isGlobalDragging, setIsGlobalDragging] = useState<boolean>(false);
  const dragCounterRef = useRef<number>(0);

  // Stems Separation and Multi-Track Mixer state
  const [activeTrackStems, setActiveTrackStems] = useState<TrackStems | null>(null);
  const [stemsMixerState, setStemsMixerState] = useState<StemsMixerState>({ ...DEFAULT_STEMS_MIXER_STATE });
  const [isSeparatingStems, setIsSeparatingStems] = useState<boolean>(false);
  const [stemQualityWarning, setStemQualityWarning] = useState<string | null>(null);
  const [separationProgress, setSeparationProgress] = useState<StemSeparationProgress | null>(null);
  const [stemProfile, setStemProfile] = useState<StemQualityProfile | null>(null);
  const [stemEngineInfo, setStemEngineInfo] = useState<StemEngineInfo | null>(null);
  const [stemEngineUnavailableReason, setStemEngineUnavailableReason] = useState<string | null>(null);
  /**
   * Fernpfad (externe Zerlegung auf Google Colab): Der Button „Externe
   * Zerlegung (Google Colab)" ist der einzige Zielumschalter; hier stehen
   * Machbarkeit/Status des Transports und der laufende Fern-Job. Es gibt
   * keine Colab-/Python-Bedienung und keine Zugangsdaten in der UI (§13, §23).
   * Die Wahl überlebt einen Neustart (lokale Persistenz).
   */
  const [stemRemoteEnabled, setStemRemoteEnabledState] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('airdox.stemRemoteEnabled') === '1';
    } catch {
      return false;
    }
  });
  const setStemRemoteEnabled = useCallback((value: boolean) => {
    setStemRemoteEnabledState(value);
    try {
      window.localStorage.setItem('airdox.stemRemoteEnabled', value ? '1' : '0');
    } catch {
      /* Persistenz ist Komfort, kein Pfand */
    }
  }, []);
  const [stemRemoteStatus, setStemRemoteStatus] = useState<RemoteServiceStatus | null>(null);
  const [remoteSetupOpen, setRemoteSetupOpen] = useState(false);
  const [remoteFlowOpen, setRemoteFlowOpen] = useState(false);
  const [remoteFlowJobId, setRemoteFlowJobId] = useState<string | null>(null);
  const [remoteFlowJob, setRemoteFlowJob] = useState<import('./stems/transportTypes').RemoteStemJobView | null>(null);
  const [remoteFlowError, setRemoteFlowError] = useState<string | null>(null);
  /**
   * Rückmeldung für den Bediener, direkt an der Stem-Leiste: was ein Klick auf
   * „Abbrechen“ tatsächlich ausgelöst hat. Ohne diese Zeile wirkt der Button
   * tot, solange der externe Job noch antwortet.
   */
  const [remoteNotice, setRemoteNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [remoteCancelPendingJobId, setRemoteCancelPendingJobId] = useState<string | null>(null);
  /**
   * Abbruch-Sperre über den Guard statt über einen einzelnen Ref: eine
   * angenommene Anfrage bleibt gesperrt, bis der Job einen Endzustand meldet,
   * eine abgelehnte/fehlgeschlagene bekommt eine kurze Wartezeit (Cooldown).
   * Ohne diesen zweiten Zustand konnte ein Klick auf „Abbrechen“ in einer
   * Fehlschleife beliebig oft wiederholt werden.
   */
  const remoteCancelRequestGuardRef = useRef(new RemoteCancelRequestGuard());
  const [remoteCancelCooldownJobId, setRemoteCancelCooldownJobId] = useState<string | null>(null);
  const remoteCancelCooldownTimersRef = useRef(new Map<string, number>());
  const [remoteFlowRunning, setRemoteFlowRunning] = useState(false);
  const [remoteFlowTrack, setRemoteFlowTrack] = useState('');
  /** Abbruchsignal für die kurze Vorbereitungsphase vor dem ersten Remote-Job. */
  const remoteAbortRef = useRef<{ aborted: boolean }>({ aborted: false });
  // Architektur-Voreinstellung aus dem Einstellungsmenü: gilt für neue
  // Separationen und wird wie die übrigen Settings lokal persistiert.
  const [stemArchitecture, setStemArchitecture] = useState<StemArchitectureSettings>(() =>
    loadStemArchitectureSettings(typeof window === 'undefined' ? null : window.localStorage)
  );
  const [stemArchitectures, setStemArchitectures] = useState<StemArchitectureOption[]>([]);
  const [stemArchitectureState, setStemArchitectureState] = useState<StemArchitectureViewState | null>(null);
  const [stemArchitecturesLoading, setStemArchitecturesLoading] = useState<boolean>(false);
  // Installations-Dialog: öffnet sich, wenn das im Einstellungsmenü gewählte
  // Modell noch nicht installiert ist und der Nutzer den Button drückt.
  const [stemInstallOpen, setStemInstallOpen] = useState<boolean>(false);

  // Die im Einstellungsmenü tatsächlich gewählte Architektur („auto" = keine
  // Fixierung). Ist sie nicht installiert, zeigt das Hauptfenster einen Button,
  // der exakt dieses Modell installiert – nichts anderes.
  const pinnedStemArchitecture: StemArchitectureOption | undefined =
    stemArchitecture.architectureId && stemArchitecture.architectureId !== 'auto'
      ? stemArchitectures.find((entry) => entry.id === stemArchitecture.architectureId)
      : undefined;
  const missingStemModel: { id: string; label: string; detail?: string } | null =
    pinnedStemArchitecture && !pinnedStemArchitecture.installed
      ? { id: pinnedStemArchitecture.id, label: pinnedStemArchitecture.label, detail: pinnedStemArchitecture.detail }
      : null;

  // Installationspfade & Ersteinrichtungsstatus
  const [workspacePaths, setWorkspacePaths] = useState<WorkspacePathSettings>(() =>
    loadWorkspacePathSettings(typeof window === 'undefined' ? null : window.localStorage)
  );
  const [initialSetupOpen, setInitialSetupOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const done = window.localStorage?.getItem('airdox.initialSetupCompleted');
    return done !== 'true';
  });

  useEffect(() => {
    saveStemArchitectureSettings(typeof window === 'undefined' ? null : window.localStorage, stemArchitecture);
  }, [stemArchitecture]);

  // Hardware Controller (Pioneer DDJ-FLX4 / DDJ-1000) state
  const [midiModalOpen, setMidiModalOpen] = useState<boolean>(false);
  const [isMidiConnected, setIsMidiConnected] = useState<boolean>(false);
  const [midiStatusLabel, setMidiStatusLabel] = useState<string>('MIDI bereit');

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

  // Standalone audio file input. Rekordbox XML is bundled and has no file picker.
  const audioFileInputRef = useRef<HTMLInputElement>(null);

  // Active track helper (supports empty state)
  const activeTrack = tracks.find((t) => t.id === activeTrackId) || tracks[0] || null;

  /**
   * Ein Bearbeitungsschritt hat genau zwei Wirkungen: der Track bekommt seine
   * neuen Segmente (unveränderlich ersetzt) und der Arbeitspuffer wird der neu
   * gerenderte. Beides gehört zusammen – eine Stelle statt neun.
   */
  const commitEditExecution = useCallback(
    (trackId: string, result: EditExecutionResult) => {
      updateTrack(trackId, (track) => applyExecutionToTrack(track, result));
      setWorkingAudioBuffer(result.newBuffer);
    },
    [updateTrack]
  );


  /*
   * Der Chatbot-Zustand liegt im Workspace-Reducer (Fokus-Modus schließt ihn
   * mit). `useRecorder` erwartet weiterhin einen `Dispatch<SetStateAction<boolean>>`
   * – die Fassade unten erfüllt diesen Vertrag, ohne einen zweiten Zustand
   * anzulegen (zwei Quellen für „ist die Palette offen" waren der Grund, warum
   * der Fokus-Modus sie früher stehen ließ).
   */
  const chatbotOpenRef = useRef(chatbotOpen);
  chatbotOpenRef.current = chatbotOpen;
  const setChatbotOpen = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((value) => {
    const open = typeof value === 'function' ? Boolean(value(chatbotOpenRef.current)) : value;
    setChatbotOpenState(open);
  }, [setChatbotOpenState]);

  /** Persist a compact, app-owned track ↔ ANLZ association (never DB/audio data). */
  /*
   * Set-Aufnahme: Zustand (12 Schalter) und Ablauf liegen in
   * `features/recorder/useRecorder` – verschoben, nicht umgeschrieben.
   */
  const {
    recorderOpen, setRecorderOpen,
    recorderStage, setRecorderStage,
    recorderElapsed, setRecorderElapsed,
    recorderSource, setRecorderSource,
    recorderOptimize, setRecorderOptimize,
    recorderTargetLufs, setRecorderTargetLufs,
    recorderTruePeak, setRecorderTruePeak,
    recorderPreRoll, setRecorderPreRoll,
    recorderFileName, setRecorderFileName,
    recorderError, setRecorderError,
    recorderSavedPath, setRecorderSavedPath,
    recorderStats, setRecorderStats,
    openRecorder, handleRecorderStart, handleRecorderStop, clearRecorderResources,
  } = useRecorder({
    activeTrack,
    recordingSource,
    protectedPaths,
    showOperationFeedback,
    setChatbotOpen,
    recordingFormat,
    recordingSampleRate,
    recordingBitDepth,
    recordingChannels,
    recordingLimiter,
  });

  // Beim Verlassen der Seite laufende Aufnahme-Ressourcen freigeben.
  useEffect(() => () => clearRecorderResources(), [clearRecorderResources]);

  const cacheAnalysisMapping = useCallback(async (
    track: TrackModel,
    analysisPath: string,
    source: string,
    details?: { size?: number; modifiedAt?: number; sourceMediaPath?: string; sourceDuration?: number }
  ) => {
    if (!window.rekordboxDesktop || !analysisPath) return;
    try {
      await window.rekordboxDesktop.cacheAnalysisMappings([{
        trackId: track.id,
        mediaPath: track.originalMedia?.resolvedPath || track.originalMedia?.location,
        sourceMediaPath: details?.sourceMediaPath || track.analysisSource?.sourceMediaPath,
        analysisPath,
        title: track.title,
        artist: track.artist,
        format: (analysisPath.split('.').pop() || 'ANLZ').toUpperCase() as 'DAT' | 'EXT' | '2EX' | 'ANLZ',
        size: details?.size,
        modifiedAt: details?.modifiedAt,
        sourceDuration: details?.sourceDuration || track.analysisSource?.sourceDuration,
        source,
      }]);
    } catch (error) {
      // A cache miss/write failure must never block loading an authentic source.
      logger.warn('DATABASE', `[ANLZ-Pfadindex] Zuordnung konnte nicht gespeichert werden: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  }, []);

  /**
   * Hydrates a compact XML/DB/project track from a known read-only ANLZ path.
   * The path can be carried by the project, supplied by master.db once, or
   * found in our small local index; no repeated master.db scan is required.
   */
  const hydrateNativeAnalysis = useCallback(async (
    track: TrackModel,
    options?: {
      preserveProjectMetadata?: boolean;
      sourceDuration?: number;
      requireExactMediaPath?: boolean;
    }
  ): Promise<TrackModel> => {
    if (isNativeRekordboxWaveform(track.analysis) || !window.rekordboxDesktop) return track;

    let mapping: RekordboxAnalysisPathMapping | null = null;
    const directPath = track.analysisSource?.path;
    if (directPath) {
      mapping = {
        trackId: track.id,
        mediaPath: track.originalMedia?.resolvedPath || track.originalMedia?.location,
        analysisPath: directPath,
        format: track.analysisSource?.format,
        size: track.analysisSource?.size,
        modifiedAt: track.analysisSource?.modifiedAt,
        sourceMediaPath: track.analysisSource?.sourceMediaPath,
        sourceDuration: track.analysisSource?.sourceDuration,
      };
    } else {
      try {
        mapping = await window.rekordboxDesktop.findAnalysisMapping({
          trackId: track.id,
          mediaPath: track.originalMedia?.resolvedPath || track.originalMedia?.location,
          title: track.title,
          artist: track.artist,
          requireExactMediaPath: options?.requireExactMediaPath,
        });
      } catch (error) {
        logger.warn('DATABASE', `[ANLZ-Pfadindex] Suche fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`, error);
      }
    }
    if (!mapping?.analysisPath) return track;
    const sourceDuration = options?.sourceDuration || track.analysisSource?.sourceDuration ||
      mapping.sourceDuration || track.audioBuffer?.duration || track.duration;

    let observedSourceMediaPath = mapping.sourceMediaPath;
    try {
      const source = await window.rekordboxDesktop.readAnalysisFile(mapping.analysisPath);
      const extraction = parseAnlzBinary(source.data);
      observedSourceMediaPath = extraction.analysisPath || mapping.sourceMediaPath;
      const mediaPath = track.originalMedia?.resolvedPath || track.originalMedia?.location;
      if (
        options?.requireExactMediaPath &&
        observedSourceMediaPath &&
        !areSameMediaPath(mediaPath, observedSourceMediaPath)
      ) {
        throw new Error('Die interne ANLZ-PPTH-Quelle stimmt nicht mit dem ausgewählten Original-Audio überein.');
      }
      const enriched = applyAnlzExtractionToTrack(track, extraction);
      // ANLZ waveform chunks do not reliably embed their total media duration.
      // Stamp the known original duration now, before a later edited project
      // can mistake its shorter/longer EDL timeline for the native source.
      const nativeAnalysis = extraction.waveform
        ? {
            ...extraction.waveform,
            secPerBucket: sourceDuration / Math.max(1, extraction.waveform.length),
          }
        : enriched.analysis;
      const analysisSource = {
        path: source.path,
        accessMode: 'READ_ONLY' as const,
        status: 'AVAILABLE' as const,
        size: source.size,
        modifiedAt: source.modifiedAt,
        sourceMediaPath: observedSourceMediaPath,
        sourceDuration,
        format: (source.path.split('.').pop() || 'ANLZ').toUpperCase() as 'DAT' | 'EXT' | '2EX' | 'ANLZ',
      };
      const withSource: TrackModel = options?.preserveProjectMetadata
        ? {
            ...track,
            analysis: nativeAnalysis,
            analysisSource,
            databaseRecord: enriched.databaseRecord
              ? { ...enriched.databaseRecord, filePath: source.path }
              : track.databaseRecord,
          }
        : {
            ...enriched,
            analysis: nativeAnalysis,
            analysisSource,
            databaseRecord: enriched.databaseRecord
              ? { ...enriched.databaseRecord, filePath: source.path }
              : enriched.databaseRecord,
          };
      await cacheAnalysisMapping(withSource, source.path, 'CACHE_REOPEN', {
        size: source.size,
        modifiedAt: source.modifiedAt,
        sourceMediaPath: observedSourceMediaPath,
        sourceDuration,
      });
      return withSource;
    } catch (error) {
      logger.warn('DATABASE', `[ANLZ-Pfadindex] ${mapping.analysisPath} konnte nicht erneut geöffnet werden: ${error instanceof Error ? error.message : String(error)}`, error);
      return {
        ...track,
        analysisSource: {
          path: mapping.analysisPath,
          accessMode: 'READ_ONLY',
          status: 'MISSING',
          sourceMediaPath: observedSourceMediaPath,
          sourceDuration: mapping.sourceDuration || sourceDuration,
          format: mapping.format,
        },
      };
    }
  }, [cacheAnalysisMapping]);

  // Real-time animation loop for playhead progress and VU stereo meters
  /*
   * Playhead & Pegel: Der Treiber liest die Engine und schreibt in den
   * Transport-Store. Dieses useEffect hält nur noch die *diskreten* Zustände
   * der Anwendung synchron – es läuft einmal beim Start, nicht pro Frame.
   *
   * Die Ansicht (viewOffset) wird über `viewportRef` gelesen statt über die
   * Effekt-Dependencies: vorher stand `viewOffset` in der Dependency-Liste des
   * Loops, sodass sich der Loop beim Auto-Scroll jeden Frame neu registrierte.
   */
  const viewportRef = useRef({ offset: viewOffset, duration: viewDuration, trackDuration: 0 });
  viewportRef.current = {
    offset: viewOffset,
    duration: viewDuration,
    trackDuration: activeTrack?.duration ?? 0,
  };

  useEffect(() => {
    const driver: PlayheadDriverHandle = startPlayheadDriver({
      port: audioEngine,
      getViewport: () => viewportRef.current,
      onFollowOffset: (offset) => setViewOffset(offset),
    });
    return () => driver.stop();
  }, []);

  // „Läuft/läuft nicht" ist ein diskreter Zustand: nur ein echter Wechsel
  // erzeugt einen React-Render (z. B. wenn die Wiedergabe natürlich endet).
  useEffect(
    () =>
      subscribeTransport(() => {
        const playing = getTransport().isPlaying;
        setIsPlaying((previous) => (previous === playing ? previous : playing));
      }),
    []
  );

  // Master volume control
  const handleMasterVolumeChange = useCallback((vol: number) => {
    setMasterVolume(vol);
    audioEngine.setMasterVolume(vol);
  }, []);


  /*
   * Stems nur übernehmen, wenn der *aktuelle* Arbeitspuffer denselben
   * PCM-Fingerabdruck hat wie bei der Trennung. Ein Edit erzeugt einen neuen
   * Puffer; die Stems des Quelltracks dürfen dann nicht weiterlaufen, sonst
   * passen Wellenform und Stem-Mischung nicht mehr zueinander.
   */
  useEffect(() => {
    if (activeTrack && workingAudioBuffer) {
      const cached = stemEngine.getCachedStemsForBuffer(
        activeTrack.id,
        workingAudioBuffer,
        activeTrack.originalSha256
      );
      setActiveTrackStems(cached || null);
    } else {
      setActiveTrackStems(null);
    }
  }, [activeTrackId, activeTrack, workingAudioBuffer]);

  // Engine-Status beim Start abfragen: die UI baut daraus Profil-Auswahl UND
  // die Stem-Liste (die kommt aus dem Deskriptor, nicht aus einer Konstanten).
  useEffect(() => {
    let cancelled = false;
    void stemEngine.getEngineInfo().then((info) => {
      if (!cancelled) setStemEngineInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Ohne eigene Wahl entscheidet die Engine: sie kennt das *beste Profil, das
   * ein Modell mit startklarem Backend hat* (`defaultProfile` aus der
   * Profil-Matrix). Vorher wurde pauschal HIGH gewählt, was auf Rechnern mit
   * installiertem ONNX-Graphen, aber ohne PyTorch zu einem Lauf führte, der
   * gar nicht startklar war.
   */
  const resolvedStemProfile: StemQualityProfile =
    stemProfile ??
    (stemEngineInfo?.defaultProfile as StemQualityProfile | undefined) ??
    (stemEngineInfo?.usable ? 'HIGH' : 'BALANCED');

  /*
   * ── Zone 2: abgeleitete Werte des Stem-Centers (UI v2.0) ──────────────────
   * Der Zustand wird NICHT zusätzlich gespeichert, sondern aus den echten
   * Signalen abgeleitet (Fertig → STEMS, läuft → PROCESSING, Panel offen →
   * CONFIGURE, sonst IDLE). Eine zweite Wahrheit über „was zeigt die Leiste"
   * wäre genau die Doppelung, die der Master-Plan beseitigt.
   */
  const stemCenterPhase = deriveStemCenterPhase({
    hasStems: activeTrackStems !== null,
    // Ein externer Job läuft über die Fern-Pipeline, nicht über die lokale
    // Engine – beide Signale halten den Fortschrittsbalken sichtbar.
    isSeparating: isSeparatingStems || remoteFlowRunning,
    configOpen: stemConfigOpen,
  });

  /** Zustand B zeigt ausschließlich dieses Modell (Modell-Isolation). */
  const activeModelOption = stemArchitectures.find(
    (entry) => entry.id === stemArchitecture.architectureId
  );
  const activeModelLabel = activeStemModelLabel(
    activeModelOption?.label ?? architectureLabel(stemArchitecture, stemArchitectures)
  );

  const FAST_PROFILES: StemQualityProfile[] = ['BALANCED', 'PREVIEW', 'HIGH'];
  const HQ_PROFILES: StemQualityProfile[] = ['HIGH_QUALITY', 'MAXIMUM_QUALITY'];
  const stemQualityMode: StemQualityMode = HQ_PROFILES.includes(resolvedStemProfile) ? 'hq' : 'fast';

  /*
   * Parameterwechsel im Stem-Center: „Schnell" wählt das beste verfügbare
   * schnelle Profil und schaltet das Verarbeitungsziel auf lokal; „High
   * Quality" wählt das beste HQ-Profil (lokal oder extern – der Zielumschalter
   * daneben entscheidet). Nichts davon startet bereits einen Job.
   */
  const handleStemQualityModeChange = useCallback(
    (mode: StemQualityMode) => {
      const wanted = mode === 'hq' ? HQ_PROFILES : FAST_PROFILES;
      const candidates = (stemEngineInfo?.profiles ?? []).filter((profile) =>
        wanted.includes(profile.profile)
      );
      const target = candidates.find((profile) => profile.available) ?? candidates[0];
      if (target) setStemProfile(target.profile);
      if (mode === 'fast') setStemRemoteEnabled(false);
    },
    [stemEngineInfo, setStemRemoteEnabled]
  );

  /*
   * Flüchtige Prozessmeldungen (außerhalb der Zonen): Ladezustand der Sammlung
   * und Rückmeldungen der externen Zerlegung. Beides darf NICHT in Zone 1
   * stehen und soll Zone 2 nicht dauerhaft belegen.
   */
  const transientStatuses = useMemo<TransientStatusItem[]>(() => {
    const items: TransientStatusItem[] = [];
    if (trackImportLoading) {
      items.push({
        id: 'track-import',
        tone: 'busy',
        text: 'Rekordbox-Sammlung wird geladen – der Track-Dialog öffnet sich gleich.',
        dismissible: false,
      });
    }
    if (remoteNotice) {
      items.push({
        id: 'remote-notice',
        tone: remoteNotice.tone === 'error' ? 'error' : 'info',
        text: remoteNotice.text,
      });
    }
    return items;
  }, [trackImportLoading, remoteNotice]);

  const dismissTransientStatus = useCallback((id: string) => {
    if (id === 'remote-notice') setRemoteNotice(null);
  }, []);

  /**
   * Architekturliste für das Einstellungsmenü: kommt aus derselben Quelle wie
   * die Profilanzeige (Desktop-IPC oder HTTP) und braucht keine Gewichte.
   */
  const refreshStemArchitectures = useCallback(async () => {
    setStemArchitecturesLoading(true);
    try {
      const result = await stemEngine.listArchitectures();
      setStemArchitectures(result.options);
      setStemArchitectureState({ transport: result.transport, reason: result.reason, onnx: result.onnx });
      setStemArchitecture((prev) => {
        if (!prev.architectureId || prev.architectureId === 'auto') return prev;
        const selected = result.options.find((entry) => entry.id === prev.architectureId);
        const auto = result.options.find((entry) => entry.id === 'auto');
        if (auto?.installed && (!selected || !selected.installed)) {
          logger.warn(
            'EDITING',
            `Stem-Architektur ${prev.architectureId} ist nicht einsatzbereit; Automatisch nutzt die installierte Engine.`
          );
          return { ...prev, architectureId: 'auto' };
        }
        return prev;
      });
    } catch (error) {
      setStemArchitectureState({
        transport: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStemArchitecturesLoading(false);
    }
  }, []);

  // Einmal beim Start …
  useEffect(() => {
    void refreshStemArchitectures();
  }, [refreshStemArchitectures]);

  const handleCompleteInitialSetup = useCallback((paths: WorkspacePathSettings) => {
    setWorkspacePaths(paths);
    saveWorkspacePathSettings(typeof window === 'undefined' ? null : window.localStorage, paths);
    setInitialSetupOpen(false);
    void refreshStemArchitectures();
    logger.info('SYSTEM', 'Ersteinrichtung erfolgreich abgeschlossen.', { paths });
  }, [refreshStemArchitectures]);

  // … und jedes Mal, wenn die Einstellungen geöffnet werden: die
  // Installationslage kann sich zwischenzeitlich geändert haben.
  useEffect(() => {
    if (!settingsModalOpen) return;
    void refreshStemArchitectures();
  }, [settingsModalOpen, refreshStemArchitectures]);

  // Stem separation & mixer handlers – BS-RoFormer only, no spectral fallback per §2,§38
  const runStemSeparation = useCallback(async (
    profile: StemQualityProfile = 'BALANCED',
    architectureOverride?: StemArchitectureSettings
  ) => {
    if (!activeTrack || !workingAudioBuffer) {
      alert('Bitte lade zuerst einen Track mit Audiodaten in Deck A.');
      return;
    }
    setIsSeparatingStems(true);
    setStemEngineUnavailableReason(null);
    try {
      const effectiveArchitecture = architectureOverride ?? stemArchitecture;
      const separated = await stemEngine.separateWithEngine(workingAudioBuffer, activeTrack.id, activeTrack.originalSha256, {
        profile,
        ...resolveArchitectureJobOptions(effectiveArchitecture),
        onProgress: (prog) => setSeparationProgress(prog),
      });
      setActiveTrackStems(separated);
      const stemList = (separated.stemIds ?? STEM_TYPES).join(', ');
      showOperationFeedback({
        title: `Stems getrennt – echte AI (${separated.profile})`,
        operationType: 'CUE',
        description: `Track "${activeTrack.title}" mit ${separated.modelId} (${separated.separationMethod}) in ${separated.stemIds?.length ?? 4} Stems aufgeteilt: ${stemList}. Engine: BS-RoFormer, Device: CPU/GPU. Original SHA256 unverändert: ${activeTrack.originalSha256.slice(0,16)}. Job mit job.json reproduzierbar.`,
        originalSha256: activeTrack.originalSha256,
        timestamp: Date.now(),
      });
      logger.info('EDITING', `Stem-Separation: ${separated.modelId} (${separated.profile}) echte AI für "${activeTrack.title}" abgeschlossen.`);
    } catch (err: any) {
      const message = err?.message || String(err);
      const code = err?.code || (message.includes('STEM_ENGINE_UNAVAILABLE') ? 'STEM_ENGINE_UNAVAILABLE' : undefined);
      if (code === 'STEM_ENGINE_UNAVAILABLE' || message.includes('STEM_ENGINE_UNAVAILABLE') || message.includes('Spektrale Fallback')) {
        logger.warn('EDITING', `Stem-Separation: Engine nicht verfügbar – ${message}`);
        setStemEngineUnavailableReason(message);
        setStemQualityWarning(message);
      } else {
        logger.error('EDITING', `Fehler bei Stem-Separation: ${message}`);
        setStemEngineUnavailableReason(message);
        setStemQualityWarning(message);
      }
    } finally {
      setIsSeparatingStems(false);
      setSeparationProgress(null);
    }
  }, [activeTrack, workingAudioBuffer, showOperationFeedback, stemArchitecture]);

  /**
   * Fernpfad (§15–§22): Status holen, offene Jobs nach einem Neustart
   * übernehmen (§32) und – solange „extern rechnen“ aktiv ist – in ruhigem
   * Takt pollen (§20). Das Polling läuft unabhängig vom Renderer weiter; die
   * Anzeige kommt aus denselben Phasen wie bei einem lokalen Lauf.
   */
  useEffect(() => {
    let cancelled = false;
    void stemEngine
      .remoteStatus()
      .then((status) => {
        if (!cancelled) setStemRemoteStatus(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!stemRemoteEnabled && !remoteFlowRunning) return undefined;
    let cancelled = false;
    const apply = (status: RemoteServiceStatus | null) => {
      if (!cancelled && status) setStemRemoteStatus(status);
    };
    // Beim Einschalten: übernommene Jobs abgleichen und fertige Ergebnisse
    // importieren, ohne dass der Nutzer etwas anklicken muss.
    void stemEngine.resumeRemoteJobs().then(apply).catch(() => undefined);
    const timer = window.setInterval(() => {
      void stemEngine.pollRemoteJobs().then(apply).catch(() => undefined);
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [stemRemoteEnabled, remoteFlowRunning]);

  const runRemoteStemSeparation = useCallback(
    async (profile: StemQualityProfile) => {
      if (!activeTrack || !workingAudioBuffer) return;
      setIsSeparatingStems(true);
      setRemoteFlowOpen(true);
      setRemoteFlowTrack(activeTrack.title);
      setRemoteFlowJob(null);
      setRemoteFlowJobId(null);
      setRemoteFlowError(null);
      setRemoteFlowRunning(true);
      remoteAbortRef.current = { aborted: false };
      setStemEngineUnavailableReason(null);
      try {
        const separated = await stemEngine.separateRemoteWithEngine(
          workingAudioBuffer,
          activeTrack.id,
          activeTrack.originalSha256,
          {
            profile,
            signal: remoteAbortRef.current,
            onProgress: (prog) => setSeparationProgress(prog),
            onRemoteJob: (job) => { setRemoteFlowJob(job); setRemoteFlowJobId(job.jobId); },
          }
        );
        setActiveTrackStems(separated);
        showOperationFeedback({
          title: `Stems getrennt – High Quality extern (${separated.profile})`,
          operationType: 'CUE',
          description:
            `Track \"${activeTrack.title}\" wurde auf dem externen Rechner getrennt (${separated.modelId}) und automatisch importiert: ` +
            `${(separated.stemIds ?? STEM_TYPES).join(', ')}. Original SHA256 unverändert: ${activeTrack.originalSha256.slice(0, 16)}.`,
          originalSha256: activeTrack.originalSha256,
          timestamp: Date.now(),
        });
        logger.info('STEM-REMOTE', `Fern-Separation abgeschlossen: ${separated.modelId} (${separated.profile}) für \"${activeTrack.title}\".`);
      } catch (err: any) {
        const message = err?.message || String(err);
        if (err?.code === 'INFERENCE_CANCELLED') {
          logger.info('STEM-REMOTE', `Fern-Separation abgebrochen: ${message}`);
          setRemoteFlowError(null);
          setRemoteNotice({ tone: 'info', text: 'Abbruch vorgemerkt: Die Arbeitskopie wird verworfen, es werden keine Stems übernommen.' });
        } else {
          logger.error('STEM-REMOTE', `Fern-Separation fehlgeschlagen: ${message}`);
          setRemoteFlowError(message);
          // Kein Python-/Colab-Text in der UI (§13): der Nutzer bekommt eine
          // verständliche Ursache und den Hinweis, lokal weiterzurechnen.
          setStemQualityWarning(
            `Externe Zerlegung (Google Colab) konnte nicht abgeschlossen werden: ${message}\n` +
              'Die Arbeitskopie und das Original bleiben unverändert. Wählen Sie im Stem-Center „Stem-Separation starten“ und dort „Schnell“ (lokal) – oder starten Sie den externen Lauf erneut.'
          );
        }
      } finally {
        remoteAbortRef.current = { aborted: false };
        setRemoteFlowRunning(false);
        setIsSeparatingStems(false);
        setSeparationProgress(null);
        void stemEngine.pollRemoteJobs().then((status) => status && setStemRemoteStatus(status)).catch(() => undefined);
      }
    },
    [activeTrack, workingAudioBuffer, showOperationFeedback]
  );

  /**
   * Klick auf den eindeutigen Button „Externe Zerlegung (Google Colab)":
   * Hochladen der Arbeitskopie nach Google Drive, Übergabe an den
   * Colab-Worker, Rückimport der Stems – der Editor speichert sie dauerhaft
   * und verknüpft sie mit dem Original-Track (Original, rekordbox.xml und
   * master.db bleiben unverändert). Ohne eingerichtete Jobablage öffnet der
   * Klick den Einrichtungs-Dialog statt stillschweigend lokal zu rechnen.
   */
  const handleStartExternalSeparation = useCallback(async () => {
    if (!activeTrack || !workingAudioBuffer) {
      alert('Bitte lade zuerst einen Track mit Audiodaten in Deck A.');
      return;
    }
    if (!stemRemoteStatus?.configured) {
      logger.info('STEM-REMOTE', 'Externe Zerlegung gewählt, aber keine Jobablage eingerichtet – Einrichtungs-Dialog öffnen.');
      setRemoteSetupOpen(true);
      return;
    }
    // Ein aktiver Job ist kein neuer Auftrag: dessen Monitor öffnen. Das
    // verhindert vor allem nach einem Neustart versehentliche Mehrfachstarts.
    const existing = (stemRemoteStatus.jobs ?? []).find((job) =>
      !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status) && job.trackName === `track_${activeTrack.id}`
    );
    if (existing || remoteFlowRunning) {
      if (existing) {
        setRemoteFlowJob(existing);
        setRemoteFlowJobId(existing.jobId);
        setRemoteFlowTrack(activeTrack.title);
      }
      setRemoteFlowOpen(true);
      return;
    }
    setStemRemoteEnabled(true);
    setStemProfile('HIGH_QUALITY');
    await runRemoteStemSeparation('HIGH_QUALITY');
  }, [activeTrack, workingAudioBuffer, stemRemoteStatus, remoteFlowRunning, runRemoteStemSeparation, setStemRemoteEnabled]);

  useEffect(() => {
    if (!remoteNotice) return;
    const timer = window.setTimeout(() => setRemoteNotice(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [remoteNotice]);

  /**
   * Ein Klick auf „Abbrechen“ muss etwas bewirken **und** sichtbar sein:
   *  1. Abbruchbitte in die Jobablage legen (der Worker beendet die Rechnung),
   *  2. Jobstand sofort neu einlesen,
   *  3. dem Nutzer in der Stem-Leiste sagen, was passiert ist – inklusive des
   *     Grunds, wenn die Ablage gerade nicht erreichbar war.
   * Doppelklicks werden über einen Ref geblockt, damit nicht elf Abbrüche im
   * Protokoll stehen, während der erste noch läuft.
   */
  /**
   * Kurzzeitige Sperre nach einer abgelehnten/fehlgeschlagenen Abbruchanfrage:
   * Der Benutzer sieht „Kurz warten…“ statt eines Buttons, der sofort wieder
   * denselben Fehler erzeugt.
   */
  const startRemoteCancelCooldown = useCallback((jobId: string) => {
    const previousTimer = remoteCancelCooldownTimersRef.current.get(jobId);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    setRemoteCancelCooldownJobId(jobId);
    const timer = window.setTimeout(() => {
      if (remoteCancelCooldownTimersRef.current.get(jobId) !== timer) return;
      remoteCancelCooldownTimersRef.current.delete(jobId);
      setRemoteCancelCooldownJobId((current) => (current === jobId ? null : current));
      // Der Guard gibt denselben Job erst nach Ablauf der Wartezeit wieder frei.
    }, REMOTE_CANCEL_RETRY_COOLDOWN_MS);
    remoteCancelCooldownTimersRef.current.set(jobId, timer);
  }, []);

  const cancelRemoteFlowJob = useCallback((jobId: string) => {
    const cancelGuard = remoteCancelRequestGuardRef.current;
    if (!cancelGuard.begin(jobId)) {
      setRemoteNotice({
        tone: 'info',
        text: cancelGuard.isCoolingDown(jobId)
          ? 'Die letzte Abbruchanfrage wurde nicht bestätigt – einen Moment warten, dann erneut versuchen.'
          : 'Der erste Abbruch ist noch unterwegs – bitte einen Moment warten.',
      });
      return;
    }
    setRemoteCancelCooldownJobId(null);
    setRemoteCancelPendingJobId(jobId);
    setRemoteFlowError(null);
    setRemoteNotice({ tone: 'info', text: 'Abbruch wird an den externen Rechner gemeldet…' });
    setSeparationProgress((prev) => (prev ? { ...prev, phaseText: 'Abbruch wird an den Worker gemeldet…' } : prev));
    void (async () => {
      try {
        const result = await stemEngine.cancelRemoteJob(jobId, 'Abbruch durch Benutzer');
        const status = await stemEngine.pollRemoteJobs();
        if (status) setStemRemoteStatus(status);
        cancelGuard.settle(jobId, result.accepted);
        if (result.accepted) {
          logger.warn('STEM-REMOTE', `Abbruch des externen Jobs ${jobId} angenommen – der Worker verwirft die laufende Rechnung.`);
          setRemoteFlowError(null);
          setRemoteNotice({ tone: 'info', text: 'Abbruch gemeldet: Der externe Rechner stoppt die Rechnung, Ergebnisse werden nicht übernommen.' });
          return;
        }
        const reason = result.message ?? 'Der Job konnte nicht abgebrochen werden.';
        logger.error('STEM-REMOTE', `Abbruch des externen Jobs ${jobId} ohne Wirkung: ${reason}`, { jobId, deferred: Boolean(result.deferred) });
        setRemoteFlowError(reason);
        setRemoteFlowOpen(true);
        setRemoteNotice({ tone: 'error', text: result.deferred ? reason : `Abbruch nicht möglich: ${reason}` });
        startRemoteCancelCooldown(jobId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cancelGuard.settle(jobId, false);
        logger.error('STEM-REMOTE', `Abbruch des externen Jobs ${jobId} fehlgeschlagen: ${message}`, { jobId });
        setRemoteFlowError(`Abbruch fehlgeschlagen: ${message}`);
        setRemoteFlowOpen(true);
        setRemoteNotice({ tone: 'error', text: `Abbruch fehlgeschlagen: ${message}` });
        startRemoteCancelCooldown(jobId);
      } finally {
        // Eine angenommene Anfrage bleibt gesperrt, bis der Job einen
        // Endzustand meldet (die Statusabfrage räumt den Guard dort auf).
        if (!cancelGuard.isPending(jobId)) {
          setRemoteCancelPendingJobId((current) => (current === jobId ? null : current));
        }
      }
    })();
  }, [startRemoteCancelCooldown]);

  /*
   * Abbruch-Sperren nur so lange halten, wie der Job läuft: Jobs in einem
   * Endzustand (oder verschwundene) dürfen keine Sperre im Renderer
   * hinterlassen – sonst bliebe der Abbrechen-Button an einem längst
   * beendeten Job hängen.
   */
  useEffect(() => {
    if (!stemRemoteStatus) return;
    for (const jobId of remoteCancelRequestGuardRef.current.trackedJobIds()) {
      const job = stemRemoteStatus.jobs.find((entry) => entry.jobId === jobId);
      if (job && job.status !== 'COMPLETED' && job.status !== 'FAILED' && job.status !== 'CANCELLED') continue;
      remoteCancelRequestGuardRef.current.forget(jobId);
      const timer = remoteCancelCooldownTimersRef.current.get(jobId);
      if (timer !== undefined) window.clearTimeout(timer);
      remoteCancelCooldownTimersRef.current.delete(jobId);
      setRemoteCancelPendingJobId((current) => (current === jobId ? null : current));
      setRemoteCancelCooldownJobId((current) => (current === jobId ? null : current));
    }
  }, [stemRemoteStatus]);

  // Beim Abbau dürfen keine Cooldown-Timer zurückbleiben: sie würden in einen
  // bereits verworfenen Zustand schreiben.
  useEffect(
    () => () => {
      for (const timer of remoteCancelCooldownTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      remoteCancelCooldownTimersRef.current.clear();
    },
    []
  );

  const handleCancelStemSeparation = useCallback(() => {
    const remoteJob = (stemRemoteStatus?.jobs ?? []).find(
      (job) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)
    );
    if (remoteJob) {
      cancelRemoteFlowJob(remoteJob.jobId);
      return;
    }
    if (remoteFlowJobId && remoteFlowRunning) {
      cancelRemoteFlowJob(remoteFlowJobId);
      return;
    }
    // The Remote Flow can still be creating the working copy before the first
    // status poll sees a job. Mark that preparation as aborted instead of
    // telling the user that nothing is running.
    if (remoteFlowRunning) {
      remoteAbortRef.current.aborted = true;
      setRemoteNotice({ tone: 'info', text: 'Abbruch vorgemerkt: Der Editor stoppt vor dem Upload bzw. meldet den Abbruch direkt an den Worker.' });
      setSeparationProgress((prev) => (prev ? { ...prev, phaseText: 'Abbruch wird vorgemerkt…' } : prev));
      logger.info('STEM-REMOTE', 'Abbruch während der Vorbereitung vorgemerkt.');
      return;
    }
    const accepted = stemEngine.cancelActiveEngineJob('Abbruch über das Deck');
    logger.warn('EDITING', accepted ? 'Stem-Separation: Abbruch angefordert.' : 'Stem-Separation: kein aktiver Job abbruchbar.');
    setSeparationProgress((prev) => (prev ? { ...prev, phaseText: 'Abbruch wird ausgeführt…' } : prev));
    // Auch lokal gilt: der Klick muss eine Antwort zeigen. „kein aktiver Job
    // abbruchbar“ nur ins Protokoll zu schreiben, ist der Weg zu „ich drücke,
    // es passiert nichts“.
    setRemoteNotice(
      accepted
        ? { tone: 'info', text: 'Abbruch angefordert: Der laufende Chunk wird zu Ende gerechnet, dann stoppt die lokale Engine.' }
        : { tone: 'info', text: 'Es läuft gerade keine Stem-Separation – abgebrochen werden kann nichts.' }
    );
  }, [stemRemoteStatus, remoteFlowJobId, remoteFlowRunning, cancelRemoteFlowJob]);

  const handleSeparateStems = useCallback(async () => {
    if (!activeTrack || !workingAudioBuffer) {
      alert('Bitte lade zuerst einen Track mit Audiodaten in Deck A.');
      return;
    }
    /*
     * „High Quality extern“ zuerst prüfen: hier entscheidet der Transport über
     * die Machbarkeit, nicht die lokale Engine. Ein lokaler Preflight würde die
     * Gewichte verlangen, die der externe Rechner ohnehin selbst lädt – und
     * damit genau den Fall blockieren, für den der Fernpfad existiert (§15).
     */
    if (stemRemoteEnabled && (resolvedStemProfile === 'HIGH_QUALITY' || resolvedStemProfile === 'MAXIMUM_QUALITY')) {
      if (!stemRemoteStatus?.configured) {
        const reason = 'Kein externer Rechenort eingerichtet (Google Drive) – High Quality läuft lokal.';
        logger.warn('STEM-REMOTE', 'Fern-Separation angefordert, aber kein Transport konfiguriert.');
        setStemEngineUnavailableReason(reason);
        setStemQualityWarning(reason);
        return;
      }
      await runRemoteStemSeparation(resolvedStemProfile);
      return;
    }
    // Feste Architektur aus dem Einstellungsmenü vor dem Preflight prüfen:
    // lieber eine klare Ansage als ein Job, der in MODEL_MISSING endet. Wenn
    // die gespeicherte Auswahl auf ein inzwischen fehlendes Modell zeigt, aber
    // „Automatisch" bereits eine lauffähige Alternative hat, wird der Lauf auf
    // Auto umgebogen; andernfalls bleibt der neue modellgenaue Installer der
    // Hauptpfad und installiert exakt die gewählte Architektur.
    let effectiveArchitecture = stemArchitecture;
    if (pinnedStemArchitecture && !pinnedStemArchitecture.installed) {
      const reason = pinnedStemArchitecture.reason ?? `Modell ${pinnedStemArchitecture.id} ist nicht installiert.`;
      const autoArchitecture = stemArchitectures.find((entry) => entry.id === 'auto');
      if (autoArchitecture?.installed) {
        effectiveArchitecture = { ...stemArchitecture, architectureId: 'auto' };
        setStemArchitecture(effectiveArchitecture);
        logger.warn(
          'EDITING',
          `Stem-Preflight: Architektur ${pinnedStemArchitecture.id} nicht nutzbar — ${reason}. Automatisch nutzt eine installierte Alternative.`
        );
      } else {
        logger.warn('EDITING', `Stem-Preflight: Architektur ${pinnedStemArchitecture.id} nicht nutzbar — ${reason}`);
        setStemEngineUnavailableReason(reason);
        setStemQualityWarning(
          `Architektur „${pinnedStemArchitecture.label}" ist nicht einsatzbereit: ${reason}\n` +
            'Installation: Button „Modell installieren" im Konfigurations-Panel des Stem-Centers bzw. im Einstellungsmenü – oder auf „Automatisch" stellen.'
        );
        return;
      }
    }

    // Wenn auf "Automatisch" gestellt ist: prüfen ob irgendein Modell vorhanden ist
    const anyInstalled = stemArchitectures.some((entry) => entry.id !== 'auto' && entry.installed);
    if (stemArchitecture.architectureId === 'auto' && stemArchitectures.length > 0 && !anyInstalled) {
      const reason = 'Keine KI-Stem-Modelle installiert (BS-RoFormer / HT-Demucs fehlen).';
      logger.warn('EDITING', `Stem-Preflight: Auto-Modus ohne installierte Modelle — ${reason}`);
      setStemEngineUnavailableReason(reason);
      setStemQualityWarning(
        `Keine KI-Stem-Modelle installiert: ${reason}\n` +
          'Klicken Sie auf „BS-RoFormer installieren", um die KI-Stem-Engine jetzt einzurichten.'
      );
      return;
    }

    const profile = resolvedStemProfile;
    setIsSeparatingStems(true);
    setStemEngineUnavailableReason(null);
    setSeparationProgress({
      percent: 1,
      phaseText: `KI Stem-Preflight (${architectureLabel(stemArchitecture, stemArchitectures)})…`,
      processedSeconds: 0,
      totalSeconds: workingAudioBuffer.duration,
    });
    const availability = await stemEngine.checkAvailability();
    setIsSeparatingStems(false);
    setSeparationProgress(null);
    if (!availability.available) {
      logger.warn('EDITING', `Stem-Preflight: KI-Engine nicht verfügbar — ${availability.reason}. Code: ${availability.code}`);
      setStemEngineUnavailableReason(availability.reason || 'STEM AI UNAVAILABLE');
      setStemQualityWarning(availability.reason || 'STEM AI UNAVAILABLE');
      const info = await stemEngine.getEngineInfo().catch(() => null);
      if (info) setStemEngineInfo(info);
      return;
    }
    const info = await stemEngine.getEngineInfo();
    setStemEngineInfo(info);
    const chosen = info.profiles.find((entry) => entry.profile === profile);
    // Bei fest gewählter Architektur entscheidet deren Verfügbarkeit (oben
    // geprüft) – die Profil-Reserve darf den Job nicht blockieren. Hat die UI
    // gerade automatisch auf „Automatisch" umgeschaltet, gilt wieder die
    // Profilprüfung.
    const pinnedStillEffective = effectiveArchitecture.architectureId !== 'auto' ? pinnedStemArchitecture : undefined;
    // `chosen` MUSS existieren: fehlt das Profil in der Matrix (z. B. weil der
    // Statusaufruf nichts geliefert hat), darf der Lauf nicht „irgendwie“ starten.
    if (!pinnedStillEffective && (!info.ok || !chosen?.available)) {
      logger.warn('EDITING', `Stem-Preflight: Profil ${profile} nicht nutzbar — ${chosen?.reason || info.reason}`);
      setStemEngineUnavailableReason(chosen?.reason || info.reason || 'Profil nicht verfügbar');
      setStemQualityWarning(
        `Profil ${profile} nicht verfügbar: ${chosen?.reason || info.reason || 'Engine nicht erreichbar'}. ` +
          'Klicken Sie auf „BS-RoFormer installieren", um die KI-Modelle einzurichten.'
      );
      return;
    }
    await runStemSeparation(profile, effectiveArchitecture);
  }, [
    activeTrack,
    workingAudioBuffer,
    runStemSeparation,
    runRemoteStemSeparation,
    resolvedStemProfile,
    stemArchitecture,
    stemArchitectures,
    pinnedStemArchitecture,
    stemRemoteEnabled,
    stemRemoteStatus,
  ]);

  const updateLiveStemPlayback = useCallback((next: StemsMixerState) => {
    applyStemMixDuringPlayback(
      audioEngine,
      activeTrackStems,
      workingAudioBuffer,
      next,
      loopActive,
      loopActive && selection ? selection.start : 0,
      loopActive && selection ? selection.end : 0
    );
  }, [activeTrackStems, workingAudioBuffer, loopActive, selection]);

  const handleToggleStemMute = useCallback((stem: StemType) => {
    setStemsMixerState((prev) => {
      const next: StemsMixerState = {
        ...prev,
        [stem]: { ...prev[stem], muted: !prev[stem].muted },
      };
      updateLiveStemPlayback(next);
      midiManager.updateStemPadLeds(next);
      return next;
    });
  }, [updateLiveStemPlayback]);

  const handleToggleStemSolo = useCallback((stem: StemType) => {
    setStemsMixerState((prev) => {
      const next: StemsMixerState = {
        ...prev,
        [stem]: { ...prev[stem], solo: !prev[stem].solo },
      };
      updateLiveStemPlayback(next);
      midiManager.updateStemPadLeds(next);
      return next;
    });
  }, [updateLiveStemPlayback]);

  const handleStemVolumeChange = useCallback((stem: StemType, vol: number) => {
    setStemsMixerState((prev) => {
      const next: StemsMixerState = {
        ...prev,
        [stem]: { ...prev[stem], volume: vol },
      };
      updateLiveStemPlayback(next);
      return next;
    });
  }, [updateLiveStemPlayback]);

  const handleExtractStemToClip = useCallback((stem: StemType) => {
    if (!activeTrack || !activeTrackStems) return;
    const stemBuffer = activeTrackStems[stem];
    const startSec = selection ? selection.start : 0;
    const endSec = selection ? selection.end : stemBuffer.duration;
    const sliced = audioEngine.sliceAudioBuffer(stemBuffer, startSec, endSec);
    const beats = selection ? selection.beatsCount : Math.round(sliced.duration * (activeTrack.bpm / 60));
    const bars = selection ? selection.barsCount : Math.max(1, Math.round(beats / 4));

    const stemColorMap: Record<StemType, string> = {
      vocals: '#00c8ff',
      drums: '#ffaa00',
      bass: '#ff3b30',
      other: '#00e676',
    };

    const newClipId = `clip-stem-${stem}-${Date.now()}`;
    const newClip: PaletteClip = {
      id: newClipId,
      name: `${activeTrack.title} [${stem.toUpperCase()}]`,
      sourceTrackId: activeTrack.id,
      sourceTrackName: activeTrack.title,
      sourceStart: startSec,
      sourceEnd: endSec,
      duration: sliced.duration,
      beats,
      bars,
      bpm: activeTrack.bpm,
      key: activeTrack.key,
      color: stemColorMap[stem],
      audioBuffer: sliced,
      miniPeaks: extractMiniPeaks(sliced, 48),
      analysis: analyzeAudioBuffer(sliced, DataOrigin.PROJECT),
      origin: DataOrigin.PROJECT,
    };

    setPaletteClips((prev) => [...prev, newClip]);
    setSelectedClipId(newClipId);
    if (!paletteOpen) setPaletteOpen(true);

    showOperationFeedback({
      title: `${stem.toUpperCase()}-Stem als Clip extrahiert`,
      operationType: 'COPY',
      description: `Isolierter Stem "${stem.toUpperCase()}" (${sliced.duration.toFixed(2)}s / ${bars.toFixed(1)} Takte) wurde als neuer Clip zur Palette hinzugefügt.`,
      timeRangeSec: { start: startSec, end: endSec, duration: sliced.duration },
      barsCount: bars,
      beatsCount: beats,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  }, [activeTrack, activeTrackStems, selection, paletteOpen, showOperationFeedback]);

  const applyStemsMixerState = useCallback((next: StemsMixerState) => {
    setStemsMixerState(next);
    midiManager.updateStemPadLeds(next);

    updateLiveStemPlayback(next);
  }, [updateLiveStemPlayback]);

  const handleSetAcapella = useCallback(() => {
    applyStemsMixerState({
      vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals, solo: true },
      drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
      bass: { ...DEFAULT_STEMS_MIXER_STATE.bass },
      other: { ...DEFAULT_STEMS_MIXER_STATE.other },
    });
  }, [applyStemsMixerState]);

  const handleSetInstrumental = useCallback(() => {
    applyStemsMixerState({
      vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals, muted: true },
      drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
      bass: { ...DEFAULT_STEMS_MIXER_STATE.bass },
      other: { ...DEFAULT_STEMS_MIXER_STATE.other },
    });
  }, [applyStemsMixerState]);

  const handleResetStems = useCallback(() => {
    applyStemsMixerState({
      vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals },
      drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
      bass: { ...DEFAULT_STEMS_MIXER_STATE.bass },
      other: { ...DEFAULT_STEMS_MIXER_STATE.other },
    });
  }, [applyStemsMixerState]);

  /** Stems playback is only engaged when the mixer actually deviates from the full mix. */
  const stemsMixIsCustom = useMemo(
    () => activeTrackStems !== null && isCustomStemMix(stemsMixerState),
    [activeTrackStems, stemsMixerState]
  );

  /*
   * Transport, Zoom und Ansichtsfenster liegen in `features/transport`.
   * Der Hook bekommt die Abhängigkeiten als Parameter und gibt dieselben
   * Handler zurück wie zuvor – verschoben, nicht umgeschrieben.
   */
  const {
    handleTogglePlay,
    handleReturnToStart,
    handleSeek,
    handleZoomIn,
    handleZoomOut,
    handleResetZoom,
    handleSelectZoomPreset,
    handlePanView,
  } = useTransportControls({
    activeTrack,
    workingAudioBuffer,
    isPlaying,
    setIsPlaying,
    loopActive,
    selection,
    activeTrackStems,
    stemsMixerState,
    stemsMixIsCustom,
    audioFileInputRef,
    viewDuration,
    setViewDuration,
    setViewOffset,
  });

  /*
   * Stop (Zone 1, Transport-Player): beendet die Wiedergabe und setzt den
   * Playhead an den Anfang. Bewusst dieselbe Wirkung wie „|<" (Cue-Start),
   * nur zusätzlich mit beendeter Wiedergabe – ein Stop, der weiterlaufen lässt,
   * wäre ein Pause-Knopf mit anderem Symbol.
   */
  const handleStopTransport = useCallback(() => {
    setIsPlaying(false);
    audioEngine.stop();
    handleReturnToStart();
  }, [handleReturnToStart]);

  // Hardware-Bedienung (Pioneer DDJ): Zuordnung Ereignis → Aktion in
  // `features/transport/useMidiBridge`.
  useMidiBridge({
    handleTogglePlay,
    handleReturnToStart,
    handleSeek,
    handleToggleStemMute,
    handleToggleStemSolo,
    handleMasterVolumeChange,
    setLoopActive,
    setMidiConnected: setIsMidiConnected,
    setMidiStatusLabel,
  });

  // Pioneer Memory Cue Jump Handlers (Memory Call < and >)
  const handlePrevMemoryCue = useCallback(() => {
    if (!activeTrack) return;
    const memCues = activeTrack.cues
      .filter((c) => c.type === 'MEMORY')
      .sort((a, b) => a.position - b.position);
    if (memCues.length === 0) return;

    // Find cue immediately before current time (with small buffer)
    const prevCues = memCues.filter((c) => c.position < getPositionSec() - 0.08);
    const target = prevCues.length > 0 ? prevCues[prevCues.length - 1] : memCues[memCues.length - 1];
    handleSeek(target.position);
  }, [activeTrack]);

  const handleNextMemoryCue = useCallback(() => {
    if (!activeTrack) return;
    const memCues = activeTrack.cues
      .filter((c) => c.type === 'MEMORY')
      .sort((a, b) => a.position - b.position);
    if (memCues.length === 0) return;

    // Find cue immediately after current time
    const nextCues = memCues.filter((c) => c.position > getPositionSec() + 0.08);
    const target = nextCues.length > 0 ? nextCues[0] : memCues[0];
    handleSeek(target.position);
  }, [activeTrack]);

  // Set new Memory Cue with precise database millisecond timestamp and bar/beat calculation
  const handleAddMemoryCue = useCallback(() => {
    if (!activeTrack) return;
    const existingMems = activeTrack.cues.filter((c) => c.type === 'MEMORY');
    const nextIndex = existingMems.length + 1;
    const spb = 60.0 / activeTrack.bpm;
    const cuePosition = getPositionSec();
    const beatIndex = Math.max(0, Math.round((cuePosition - (activeTrack.beatGrid.firstBeat || 0)) / spb));
    const barNumber = Math.floor(beatIndex / 4) + 1;
    const beatNumber = (beatIndex % 4) + 1;

    const newCue: CuePoint = {
      id: `mem-${Date.now()}`,
      position: cuePosition,
      inMsec: Math.round(cuePosition * 1000),
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
          };
        }
        return t;
      })
    );
  }, [activeTrack]);

  // Set Beat 1.1 at current playhead position (Pioneer Rekordbox "Set 1.1 Here")
  const handleSetFirstBeatHere = useCallback(() => {
    if (!activeTrack) return;
    const newFirstBeat = Math.max(0, getPositionSec());
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
          };
        }
        return t;
      })
    );
  }, [activeTrack]);

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
    const searchCenterBucket = Math.round(getPositionSec() / secPerBucket);
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
  }, [activeTrack, handleShiftBeatgrid]);

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

  /*
   * Verlauf: `audio/editHistory*.ts` snapshotet nur kleine Metadaten und hält
   * den unveränderlichen Arbeitspuffer per Referenz; der Hook führt je Track
   * einen eigenen, auf 30 Schritte begrenzten Stapel. Ein neuer Edit verwirft
   * damit nur den Redo-Zweig dieses Tracks, nicht den anderer Decks.
   */
  const {
    undoStack,
    redoStack,
    allUndoCount,
    allRedoCount,
    push: pushHistoryEntry,
    undo: takeUndoEntry,
    redo: takeRedoEntry,
    clear: clearEditHistory,
  } = useEditHistory(activeTrackId || null);

  // Snapshot current state for Undo (stores buffer, duration, analysis, cues, segments)
  const pushHistorySnapshot = (desc: string) => {
    if (!activeTrack) return;
    pushHistoryEntry(createEditHistoryEntry(activeTrack, selection, workingAudioBuffer, desc));
  };

  // Undo / Redo
  const handleUndo = () => {
    if (!activeTrack) return;
    const current = createEditHistoryEntry(activeTrack, selection, workingAudioBuffer, 'Before Undo');
    const previous = takeUndoEntry(current);
    if (!previous) return;

    const restored = restoreEditHistoryEntry(activeTrack, previous, {
      renderWorkingAudio: (source, segments) => audioEngine.renderWorkingAudio(source, segments),
      analyzeAudioBuffer: (buffer) => analyzeAudioBuffer(buffer, DataOrigin.PROJECT),
    });
    updateTrack(activeTrack.id, () => restored.track);
    if (restored.audioBuffer) setWorkingAudioBuffer(restored.audioBuffer);
    setSelection(previous.selection);
  };

  const handleRedo = () => {
    if (!activeTrack) return;
    const current = createEditHistoryEntry(activeTrack, selection, workingAudioBuffer, 'Before Redo');
    const next = takeRedoEntry(current);
    if (!next) return;

    const restored = restoreEditHistoryEntry(activeTrack, next, {
      renderWorkingAudio: (source, segments) => audioEngine.renderWorkingAudio(source, segments),
      analyzeAudioBuffer: (buffer) => analyzeAudioBuffer(buffer, DataOrigin.PROJECT),
    });
    updateTrack(activeTrack.id, () => restored.track);
    if (restored.audioBuffer) setWorkingAudioBuffer(restored.audioBuffer);
    setSelection(next.selection);
  };

  // Clear History handler (confirmed through ClearHistoryModal)
  const handleClearHistoryConfirm = () => {
    const totalCount = allUndoCount + allRedoCount;
    clearEditHistory();
    logger.info('EDITING', `[History] Cleared ${totalCount} history snapshots after user confirmation.`);
    showOperationFeedback({
      title: 'Bearbeitungsverlauf geleert',
      operationType: 'CLEAR_HISTORY',
      description: `Der Bearbeitungsverlauf (${totalCount} Schritte) wurde sicher geleert. Der aktuelle Zustand von Track und Waveform bleibt unverändert erhalten.`,
      originalSha256: activeTrack?.originalSha256 || 'N/A',
      timestamp: Date.now(),
    });
  };

  // Track-Part-Analyse: erkennt Intro/Build/Drop/Break aus der realen
  // Wellenform-Energie, zeigt die Parts farbig unter der Wellenform und setzt
  // an den prägnanten Part-Grenzen (Drop, Break, Build) Cue-Punkte.
  const handleAnalyzeParts = useCallback(() => {
    if (!activeTrack) return;
    try {
      const detectedParts = detectTrackParts(activeTrack);
      if (!detectedParts || detectedParts.length === 0) {
        logger.warn(
          'BEATGRID',
          `Part-Analyse: Keine Wellenform-Analyse für "${activeTrack.title}" vorhanden — Parts können nicht erkannt werden.`
        );
        return;
      }

      const trackWithParts: TrackModel = { ...activeTrack, phrases: detectedParts };
      const newCues = generateAutoCuesForTrack(trackWithParts);

      setTracks((prev) =>
        prev.map((t) => {
          if (t.id !== activeTrack.id) return t;
          // Alte Auto-Cues (ANALYSIS_CACHE) entfernen, damit eine erneute
          // Analyse keine doppelten Marker anhäuft. User-Cues bleiben erhalten.
          const keptCues = t.cues.filter((c) => c.origin !== DataOrigin.ANALYSIS_CACHE);
          return {
            ...t,
            phrases: detectedParts,
            cues: [...keptCues, ...newCues].sort((a, b) => a.position - b.position),
          };
        })
      );

      const partSummary = detectedParts
        .map((p) => `${p.name === 'BREAKDOWN' ? 'BREAK' : p.name} (Takt ${p.startBar})`)
        .join(', ');
      logger.info(
        'BEATGRID',
        `Part-Analyse: ${detectedParts.length} Parts erkannt [${partSummary}] und ${newCues.length} Cue-Punkte an prägnanten Stellen gesetzt für "${activeTrack.title}".`
      );
      showOperationFeedback({
        title: 'Track-Parts analysiert',
        operationType: 'CUE',
        description: `${detectedParts.length} Parts aus der Wellenform-Energie erkannt: ${partSummary}. ${newCues.length} Cue-Punkte wurden an den prägnanten Part-Grenzen (Drop, Break, Build-Up) gesetzt. Die Parts werden farblich unter der Wellenform angezeigt.`,
        originalSha256: activeTrack.originalSha256 || 'N/A',
        timestamp: Date.now(),
      });
    } catch (err: any) {
      logger.error('BEATGRID', `Fehler bei der Track-Part-Analyse: ${err.message}`, err);
    }
  }, [activeTrack, showOperationFeedback]);

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
        
        logger.info('BEATGRID', `Auto-Cue: Generierte ${newCues.length} neue Cue-Punkte (Drops & Breaks) für "${activeTrack.title}"`);
      }
    } catch (err: any) {
      logger.error('BEATGRID', `Fehler bei Auto-Cue Generierung: ${err.message}`, err);
    }
  }, [activeTrack]);

  const handleBeatSelect = (beats: number) => {
    if (!activeTrack) return;
    const bg = activeTrack.beatGrid;
    const spb = 60.0 / bg.bpm;

    // Start from either current playhead or snapped bar start
    let startSec = getPositionSec();
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

  // Add selection to Palette (CLONE or '+' button).  Besides the PCM copy, a
  // clip carries the matching native ANLZ bucket range and beat offsets. This
  // lets a later same-track placement keep Rekordbox's original waveform.
  const handleAddSelectionToPalette = () => {
    if (!selection || !activeTrack || !workingAudioBuffer) return;
    const sliced = audioEngine.sliceAudioBuffer(workingAudioBuffer, selection.start, selection.end);
    const clipAnalysis = sliceWaveformAnalysis(
      activeTrack.analysis,
      workingAudioBuffer.duration,
      selection.start,
      selection.end
    );
    const newClipId = `clip-${Date.now()}`;
    const newClip: PaletteClip = {
      id: newClipId,
      name: `${activeTrack.title} (${selection.barsCount.toFixed(1)} Bars)`,
      sourceTrackId: activeTrack.id,
      sourceTrackName: activeTrack.title,
      sourceStart: selection.start,
      sourceEnd: selection.end,
      duration: sliced.duration,
      beats: Math.round(selection.beatsCount),
      bars: selection.barsCount,
      bpm: activeTrack.bpm,
      key: activeTrack.key,
      color: '#00a2ff',
      audioBuffer: sliced,
      miniPeaks: extractMiniPeaks(sliced, 48),
      analysis: clipAnalysis,
      beatOffsets: beatOffsetsForRange(activeTrack, selection.start, selection.end),
      ...nativeSourceCoordinatesForRange(activeTrack, selection.start, selection.end),
      analysisSource: activeTrack.analysisSource,
      origin: clipAnalysis?.origin ?? DataOrigin.PROJECT,
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
    if (activeTrack) {
      setClipboardProvenance({
        sourceTrackId: activeTrack.id,
        sourceStart: effectiveSel.start,
        sourceEnd: effectiveSel.end,
        duration: sliced.duration,
        analysis: sliceWaveformAnalysis(activeTrack.analysis, workingAudioBuffer.duration, effectiveSel.start, effectiveSel.end),
        beatOffsets: beatOffsetsForRange(activeTrack, effectiveSel.start, effectiveSel.end),
        ...nativeSourceCoordinatesForRange(activeTrack, effectiveSel.start, effectiveSel.end),
      });
    } else {
      setClipboardProvenance(null);
    }

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
      activeTrack.workingSegments,
      undefined,
      createEditContext(activeTrack)
    );

    setClipboardBuffer(clipboard);
    setClipboardProvenance({
      sourceTrackId: activeTrack.id,
      sourceStart: effectiveSel.start,
      sourceEnd: effectiveSel.end,
      duration: clipboard.duration,
      analysis: sliceWaveformAnalysis(activeTrack.analysis, workingAudioBuffer.duration, effectiveSel.start, effectiveSel.end),
      beatOffsets: beatOffsetsForRange(activeTrack, effectiveSel.start, effectiveSel.end),
      ...nativeSourceCoordinatesForRange(activeTrack, effectiveSel.start, effectiveSel.end),
    });
    commitEditExecution(activeTrack.id, execution);
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
    const validation = editAssistant.validatePaste(clipboardBuffer, workingAudioBuffer, getPositionSec());
    if (!validation.isValid) {
      setEditAssistantModalOpen(true);
      return;
    }
    if (!clipboardBuffer || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Paste');

    const insertTime = validation.sanitizedInsertionTime ?? getPositionSec();
    const result = executePaste(
      workingAudioBuffer,
      clipboardBuffer,
      insertTime,
      selection,
      activeTrack.cues,
      activeTrack.workingSegments,
      undefined,
      createEditContext(activeTrack, clipboardProvenance ? {
        analysis: clipboardProvenance.analysis,
        duration: clipboardProvenance.duration,
        beatOffsets: clipboardProvenance.beatOffsets,
        analysisSource: clipboardProvenance.analysisSource,
        analysisSourceTrackId: clipboardProvenance.analysisSourceTrackId,
        analysisSourceStart: clipboardProvenance.analysisSourceStart,
        analysisSourceEnd: clipboardProvenance.analysisSourceEnd,
      } : undefined)
    );

    commitEditExecution(activeTrack.id, result);

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
    const validation = editAssistant.validateInsert(clipboardBuffer, workingAudioBuffer, getPositionSec());
    if (!validation.isValid) {
      setEditAssistantModalOpen(true);
      return;
    }
    if (!clipboardBuffer || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Insert');

    const insertPos = validation.sanitizedInsertionTime ?? getPositionSec();
    const result = executeInsert(
      workingAudioBuffer,
      clipboardBuffer,
      insertPos,
      activeTrack.cues,
      activeTrack.workingSegments,
      undefined,
      createEditContext(activeTrack, clipboardProvenance ? {
        analysis: clipboardProvenance.analysis,
        duration: clipboardProvenance.duration,
        beatOffsets: clipboardProvenance.beatOffsets,
        analysisSource: clipboardProvenance.analysisSource,
        analysisSourceTrackId: clipboardProvenance.analysisSourceTrackId,
        analysisSourceStart: clipboardProvenance.analysisSourceStart,
        analysisSourceEnd: clipboardProvenance.analysisSourceEnd,
      } : undefined)
    );

    commitEditExecution(activeTrack.id, result);

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
  const handleInsertClipToDeckA = (clip: PaletteClip, requestedInsertTime: number = getPositionSec()) => {
    if (!activeTrack || !workingAudioBuffer) {
      alert('Bitte lade zuerst einen Track in Deck A.');
      return;
    }
    if (!clip.audioBuffer) {
      alert('Der Clip enthält keine Audiodaten.');
      return;
    }

    // Adapt clip audio only once. For a same-track clip with equal BPM/key this
    // path is a lossless copy; no WSOLA/pitch processing is allowed to invent a
    // tail of silence.
    const adapted = audioEngine.adaptClipToTrack(clip, activeTrack, matchPitchOnInsert);
    const insertPos = Math.max(0, Math.min(workingAudioBuffer.duration, requestedInsertTime));
    const isExactSameSourceSlot = isExactSameSourceSlotRoundTrip({
      targetBuffer: workingAudioBuffer,
      clipBuffer: adapted.adaptedBuffer,
      targetTrackId: activeTrack.id,
      sourceTrackId: clip.sourceTrackId,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
      selection,
      insertTime: insertPos,
      tempoRatio: adapted.tempoRatio,
      semitonesShifted: adapted.semitonesShifted,
    });

    // A four-bar selection saved to the palette and placed back into the exact
    // same selected slot is an identity operation, not an instruction to add a
    // duplicate four bars. This is the expected Rekordbox-style round trip.
    if (isExactSameSourceSlot) {
      showOperationFeedback({
        title: 'Original-Clip unverändert belassen',
        operationType: 'INSERT',
        description: `Clip "${clip.name}" entspricht exakt der noch markierten Originalstelle. Es wurden keine zusätzlichen Takte und keine Stille eingefügt; die native Rekordbox-Wellenform bleibt unverändert.`,
        timeRangeSec: { start: selection!.start, end: selection!.end, duration: selection!.duration },
        barsCount: selection!.barsCount,
        beatsCount: selection!.beatsCount,
        originalSha256: activeTrack.originalSha256,
        timestamp: Date.now(),
      });
      return;
    }

    pushHistorySnapshot('Insert Clip');
    const result = executeInsert(
      workingAudioBuffer,
      adapted.adaptedBuffer,
      insertPos,
      activeTrack.cues,
      activeTrack.workingSegments,
      undefined,
      createEditContext(activeTrack, {
        analysis: clip.analysis,
        duration: clip.duration,
        beatOffsets: clip.beatOffsets,
        adaptedDuration: adapted.newDuration,
        analysisSource: clip.analysisSource,
        analysisSourceTrackId: clip.analysisSourceTrackId || clip.sourceTrackId,
        analysisSourceStart: clip.analysisSourceStart ?? clip.sourceStart,
        analysisSourceEnd: clip.analysisSourceEnd ?? clip.sourceEnd,
        clipId: clip.id,
      })
    );

    commitEditExecution(activeTrack.id, result);

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

  const handleDropPaletteClip = (clipId: string, dropTime: number) => {
    const clip = paletteClips.find((candidate) => candidate.id === clipId);
    if (!clip) {
      logger.warn('EDITING', `Drag-and-Drop-Clip nicht mehr in der Palette vorhanden: ${clipId}`);
      return;
    }
    setSelectedClipId(clip.id);
    setPosition(dropTime);
    handleInsertClipToDeckA(clip, dropTime);
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
      activeTrack.workingSegments,
      undefined,
      createEditContext(activeTrack, {
        analysis: clip.analysis,
        duration: clip.duration,
        beatOffsets: clip.beatOffsets,
        adaptedDuration: adapted.newDuration,
        analysisSource: clip.analysisSource,
        analysisSourceTrackId: clip.analysisSourceTrackId || clip.sourceTrackId,
        analysisSourceStart: clip.analysisSourceStart ?? clip.sourceStart,
        analysisSourceEnd: clip.analysisSourceEnd ?? clip.sourceEnd,
        clipId: clip.id,
      })
    );

    commitEditExecution(activeTrack.id, result);

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
      activeTrack.workingSegments,
      0.85,
      undefined,
      createEditContext(activeTrack, {
        analysis: clip.analysis,
        duration: clip.duration,
        beatOffsets: clip.beatOffsets,
        adaptedDuration: adapted.newDuration,
        analysisSource: clip.analysisSource,
        analysisSourceTrackId: clip.analysisSourceTrackId || clip.sourceTrackId,
        analysisSourceStart: clip.analysisSourceStart ?? clip.sourceStart,
        analysisSourceEnd: clip.analysisSourceEnd ?? clip.sourceEnd,
        clipId: clip.id,
      })
    );

    commitEditExecution(activeTrack.id, result);

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

  // DELETE button opens an explicit choice; no timeline behavior is implicit.
  const handleDelete = () => {
    const validation = editAssistant.validateClear(selection, workingAudioBuffer);
    if (!validation.isValid) {
      setEditAssistantModalOpen(true);
      return;
    }
    setDeleteModeModalOpen(true);
  };

  // Normal Delete: duration-preserving silence on the working representation.
  const handleNormalDelete = () => {
    setDeleteModeModalOpen(false);
    const validation = editAssistant.validateClear(selection, workingAudioBuffer);
    if (!validation.isValid) {
      setEditAssistantModalOpen(true);
      return;
    }
    const effectiveSel = validation.sanitizedSelection || selection;
    if (!effectiveSel || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Normal Delete');

    const result = executeClear(
      workingAudioBuffer,
      effectiveSel,
      activeTrack.cues,
      activeTrack.workingSegments,
      undefined,
      createEditContext(activeTrack)
    );

    commitEditExecution(activeTrack.id, result);
    setSelection(null);

    showOperationFeedback({
      title: 'Auswahl gelöscht (Normales Delete)',
      operationType: 'DELETE',
      description: `Bereich (${effectiveSel.duration.toFixed(3)}s / ${effectiveSel.barsCount.toFixed(1)} Takte) in der Arbeitsrepräsentation durch Stille ersetzt. Tracklänge und nachfolgende Positionen bleiben unverändert; die Originaldatei bleibt schreibgeschützt.`,
      timeRangeSec: { start: effectiveSel.start, end: effectiveSel.end, duration: effectiveSel.duration },
      barsCount: effectiveSel.barsCount,
      beatsCount: effectiveSel.beatsCount,
      originalSha256: activeTrack.originalSha256,
      timestamp: Date.now(),
    });
  };

  // Ripple Delete: removes the range and shifts all subsequent timeline data.
  const handleRippleDelete = () => {
    setDeleteModeModalOpen(false);
    const validation = editAssistant.validateDelete(selection, workingAudioBuffer);
    if (!validation.isValid) {
      setEditAssistantModalOpen(true);
      return;
    }
    const effectiveSel = validation.sanitizedSelection || selection;
    if (!effectiveSel || !activeTrack || !workingAudioBuffer) return;
    pushHistorySnapshot('Ripple Delete');

    const result = executeRippleDelete(
      {
        originalBuffer: activeTrack.audioBuffer,
        workingBuffer: workingAudioBuffer,
        originalMedia: activeTrack.originalMedia,
      },
      effectiveSel,
      activeTrack.cues,
      activeTrack.workingSegments,
      undefined,
      createEditContext(activeTrack)
    );

    commitEditExecution(activeTrack.id, result);
    setSelection(null);

    showOperationFeedback({
      title: 'Auswahl entfernt (Ripple Delete)',
      operationType: 'DELETE',
      description: `Bereich (${effectiveSel.duration.toFixed(3)}s / ${effectiveSel.barsCount.toFixed(1)} Takte) ausschließlich aus der Arbeitsrepräsentation entfernt. Nachfolgendes Audio-Material wurde um -${effectiveSel.duration.toFixed(3)}s nach vorne gerückt; die Originaldatei bleibt unverändert und schreibgeschützt.`,
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
      activeTrack.workingSegments,
      undefined,
      createEditContext(activeTrack)
    );

    commitEditExecution(activeTrack.id, result);

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
    updateTrack(activeTrack.id, (track) => ({
      ...track,
      cues: [
        ...track.cues,
        {
          id: `cue-${Date.now()}`,
          name: `Cue ${track.cues.length + 1}`,
          type: 'MEMORY' as const,
          position: pos,
          color: '#ff2a2a',
          origin: DataOrigin.USER_EDIT,
        },
      ],
    }));
  };

  // ANLZ belongs to the explicitly active XML/DB track. It is read-only input
  // and takes priority over XML values only for analysis fields it actually
  // holds. Desktop imports additionally remember the safe, read-only path.
  /*
   * Track-Import (ANLZ, Datenbank, eingebettete Sammlung, Originaldatei) liegt in
   * `features/import/useTrackImport`. Abhängigkeiten kommen als Parameter herein,
   * die Handler-Namen bleiben unverändert.
   */
  const {
    handleImportAnlzData,
    handleImportAnlzFile,
    handleImportAnlzFromDesktop,
    handleLoadRekordboxDatabase,
    handleOpenRekordboxDatabase,
    handleLocateRekordboxDatabases,
    loadBundledRekordboxCollection,
    handleTrackImport,
    handleSelectTrackFromXml,
  } = useTrackImport({
    activeTrack,
    workingAudioBuffer,
    tracks,
    setTracks,
    setWorkingAudioBuffer,
    activeTrackId,
    setActiveTrackId,
    setAnalysisIndexStatus,
    setIsPlaying,
    setSelection,
    clearEditHistory,
    setViewOffset,
    setXmlCollectionModalOpen,
    setXmlFileName,
    setXmlImportedTracks,
    setTrackImportLoading,
    trackImportLoading,
    xmlFileName,
    xmlImportedTracks,
    bundledCollectionPromiseRef,
    cacheAnalysisMapping,
    showOperationFeedback,
  });

  /*
   * Projektdateien (speichern/öffnen) und das Laden von Audiodateien liegen in
   * `features/project/useProjectFiles` – verschoben, nicht umgeschrieben.
   */
  const { handleSaveProject, handleOpenProject, loadAudioFile, handleImportAudioFile, handleDropFile } =
    useProjectFiles({
      projectName,
      setProjectName,
      tracks,
      setTracks,
      activeTrack,
      activeTrackId,
      setActiveTrackId,
      selection,
      setSelection,
      paletteClips,
      setPaletteClips,
      setWorkingAudioBuffer,
      setIsPlaying,
      setViewOffset,
      protectedPaths,
      hydrateNativeAnalysis,
      showOperationFeedback,
      handleImportAnlzFile,
    });

  // Global keyboard shortcuts (Space=Play, Ctrl+Z=Undo, Ctrl+Y=Redo, Ctrl+C=Copy, Ctrl+V=Paste, Esc=Cancel)
  /*
   * Tastaturbindung: Der Listener wird genau EINMAL registriert.
   *
   * Vorher stand dieser Effekt ohne Dependency-Array da – `addEventListener`
   * und `removeEventListener` liefen also bei jedem Render, und das bei ~60
   * Renders pro Sekunde während der Wiedergabe. Der Ref hält trotzdem immer
   * den neuesten Handler (kein veralteter Abschluss).
   */
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});

  keyHandlerRef.current = (e: KeyboardEvent) => {
    {
      if (deleteModeModalOpen) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.code === 'F9') {
        e.preventDefault();
        openRecorder();
      } else if (e.code === 'Space') {
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
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyO') {
        e.preventDefault();
        void handleTrackImport();
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
            handleToggleZone3Section('EDIT');
          } else if (e.code === 'KeyS' && !e.shiftKey) {
            e.preventDefault();
            handleStopTransport();
          } else if (e.code === 'KeyP') {
            e.preventDefault();
            setPaletteOpen(!paletteOpen);
          } else if (e.code === 'KeyM') {
            e.preventDefault();
            handleToggleFocusMode();
          }
        }
      }
    };

  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // Action: Open a completely clean, empty project
  const handleNewProject = useCallback(() => {
    setProjectName('New Project');
    setTracks([]);
    setActiveTrackId('');
    setWorkingAudioBuffer(null);
    setPaletteClips([]);
    setSelection(null);
    setPosition(0);
    setViewOffset(0);
    setViewDuration(16.0);
    clearEditHistory();
    audioEngine.stop();
    setIsPlaying(false);
  }, [clearEditHistory]);

  // Track context exposed to AI Copilot
  const chatbotTrackContext: TrackEditorContext = useMemo(() => {
    const secPerBeat = activeTrack?.bpm ? 60 / activeTrack.bpm : 0.5;
    const secPerBar = secPerBeat * 4;
    const currentPosition = getPositionSec();
    const currentBar = Math.floor(currentPosition / secPerBar) + 1;
    const currentBeat = Math.floor(currentPosition / secPerBeat) + 1;

    // Automated Rekordbox-compatible Mix-In & phrase energy analysis
    const mixInAnalysis = activeTrack ? analyzeTrackForMixIn(activeTrack) : undefined;

    return {
      title: activeTrack?.title,
      artist: activeTrack?.artist,
      bpm: activeTrack?.bpm,
      key: activeTrack?.key,
      duration: activeTrack?.duration,
      currentTime: currentPosition,
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
      undoCount: allUndoCount,
      redoCount: allRedoCount,
      mixInAnalysis,
    };
  }, [
    activeTrack,
    selection,
    clipboardBuffer,
    quantize,
    waveformMode,
    paletteClips.length,
    allUndoCount,
    allRedoCount,
  ]);

  /*
   * Der Chatbot braucht die *aktuelle* Position im Moment des Absendens. Der
   * gemerkte Kontext enthält die teure Mix-In-Analyse und wird nur bei
   * Inhaltsänderungen neu gebaut; die Position wird erst hier eingesetzt.
   */
  const resolveChatbotTrackContext = useCallback((): TrackEditorContext => {
    const position = getPositionSec();
    const secPerBar = activeTrack?.bpm ? (60 / activeTrack.bpm) * 4 : 2;
    return {
      ...chatbotTrackContext,
      currentTime: position,
      currentBar: Math.floor(position / secPerBar) + 1,
    };
  }, [chatbotTrackContext, activeTrack]);

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
            mixTime = getPositionSec();
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

          updateTrack(activeTrack.id, (track) => {
            const existingCueIdx = track.cues.findIndex(
              (cue) => (cue.type === 'HOT_CUE' && cue.letter === cueSlot) || (cue.name && cue.name.startsWith('MIX-IN'))
            );
            const cues = [...track.cues];
            if (existingCueIdx >= 0) cues[existingCueIdx] = newCue;
            else cues.push(newCue);
            return { ...track, cues };
          });

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
            const start = action.params.start ?? getPositionSec();
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
          handleAddCue(action.params.time ?? getPositionSec());
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
      selection,
      updateTrack,
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
      {/* Standalone audio file picker; Rekordbox XML is bundled in the app. */}
      <input
        ref={audioFileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.aiff"
        onChange={handleImportAudioFile}
        className="hidden"
      />

      {/* ═══════════ ZONE 1: Globale System-, Transport- & Fokus-Leiste ═══════════
          Permanent sichtbar. Enthält ausschließlich Werkzeuge, Menüs, den
          kompakten Player, den aktiven Track, die Systemzeit und den
          Fokus-Umschalter – niemals Fortschritt, Status oder Import-Buttons. */}
      <Zone1TopBar
        projectName={projectName}
        activeTrack={activeTrack}
        isPlaying={isPlaying}
        onTogglePlay={handleTogglePlay}
        onStop={handleStopTransport}
        onReturnToStart={handleReturnToStart}
        loopActive={loopActive}
        onToggleLoop={() => setLoopActive(!loopActive)}
        quantizeActive={quantize}
        onToggleQuantize={() => setQuantize(!quantize)}
        masterVolume={masterVolume}
        onMasterVolumeChange={handleMasterVolumeChange}
        focusMode={focusMode}
        onToggleFocusMode={handleToggleFocusMode}
        chatbotOpen={chatbotOpen}
        onToggleChatbot={() => setChatbotOpen(!chatbotOpen)}
        onOpenDatabaseInspector={() => setDbExtractionModalOpen(true)}
        onOpenRecorder={openRecorder}
        recorderActive={
          recorderStage === 'RECORDING' ||
          recorderStage === 'PREROLL' ||
          recorderStage === 'OPTIMIZING' ||
          recorderStage === 'SAVING'
        }
        onOpenSettings={() => setSettingsModalOpen(true)}
        onShowInfo={() => setInfoModalOpen(true)}
        menuProps={{
          onNewProject: handleNewProject,
          onSaveProject: handleSaveProject,
          onOpenProject: handleOpenProject,
          onImportTracks: handleTrackImport,
          trackImportLoading,
          onImportAudio: () => audioFileInputRef.current?.click(),
          onExportWav: () => setExportModalOpen(true),
          onExportXml: () => setExportModalOpen(true),
          onUndo: handleUndo,
          onRedo: handleRedo,
          canUndo: undoStack.length > 0,
          canRedo: redoStack.length > 0,
          waveformMode,
          onSetWaveformMode: setWaveformMode,
          paletteOpen,
          onTogglePalette: () => setPaletteOpen(!paletteOpen),
          zone3Section,
          onToggleZone3Section: handleToggleZone3Section,
          focusMode,
          onToggleFocusMode: handleToggleFocusMode,
          browserOpen,
          onToggleBrowser: () => setBrowserOpen(!browserOpen),
          chatbotOpen,
          onToggleChatbot: () => setChatbotOpen(!chatbotOpen),
          onShowInfo: () => setInfoModalOpen(true),
          onOpenDatabaseInspector: () => setDbExtractionModalOpen(true),
          onOpenSystemLogs: () => setSystemLogModalOpen(true),
          onClearHistory: () => setClearHistoryModalOpen(true),
          hasHistory: allUndoCount > 0 || allRedoCount > 0,
          onCopy: handleCopy,
          onCut: handleCut,
          onPaste: handlePaste,
          onDelete: handleDelete,
          hasSelection: selection !== null && selection.duration > 0,
          hasClipboard: clipboardBuffer !== null,
          onOpenEditAssistant: () => setEditAssistantModalOpen(true),
          onAnalyzeMixIn: () => setChatbotOpen(true),
          onOpenMidiModal: () => setMidiModalOpen(true),
          onSeparateStems: () => dispatchWorkspace({ type: 'OPEN_STEM_CONFIG' }),
          onOpenRecorder: openRecorder,
          onOpenInitialSetup: () => setInitialSetupOpen(true),
          onOpenStemModels: () => dispatchWorkspace({ type: 'SET_STEM_MODEL_PICKER', open: true }),
        }}
      />

      {/* ═══════════ ZONE 2: Primärer Viewport ═══════════
          Deck-Kontext, dynamisches Stem-Center (Zustände A/B/C), die
          High-Resolution-Wellenform und die andockbaren Paletten. */}
      <main className="flex-1 flex flex-col overflow-hidden min-h-0" data-zone="2">
        {/* 4. Track Header & Overview Waveform (authentischer Pioneer-DJ-Kopf) */}
        <TrackHeader
          track={activeTrack}
          viewOffset={viewOffset}
          viewDuration={viewDuration}
          onSeek={handleSeek}
          onPanView={handlePanView}
        />

        {/* 4b. Dynamisches Stem-Center – Zustand A/B/C, Modell-Isolation */}
        <StemCenter
          phase={stemCenterPhase}
          configOpen={stemConfigOpen}
          onOpenConfig={() => dispatchWorkspace({ type: 'OPEN_STEM_CONFIG' })}
          onCloseConfig={() => dispatchWorkspace({ type: 'CLOSE_STEM_CONFIG' })}
          modelPickerOpen={stemModelPickerOpen}
          onOpenModelPicker={() => dispatchWorkspace({ type: 'SET_STEM_MODEL_PICKER', open: true })}
          onCloseModelPicker={() => dispatchWorkspace({ type: 'SET_STEM_MODEL_PICKER', open: false })}
          activeModelLabel={activeModelLabel}
          activeModelDetail={activeModelOption?.detail}
          modelOptions={stemArchitectures}
          selectedArchitectureId={stemArchitecture.architectureId}
          onSelectArchitecture={(id) => setStemArchitecture((prev) => ({ ...prev, architectureId: id }))}
          qualityMode={stemQualityMode}
          onQualityModeChange={handleStemQualityModeChange}
          targetMode={stemRemoteEnabled ? 'remote' : 'local'}
          onTargetModeChange={(mode) => setStemRemoteEnabled(mode === 'remote')}
          remoteConfigured={Boolean(stemRemoteStatus?.configured)}
          remoteStatus={stemRemoteStatus}
          onOpenRemoteSetup={() => setRemoteSetupOpen(true)}
          onStartJob={() => { void handleSeparateStems(); }}
          missingModel={missingStemModel}
          onInstallModel={() => setStemInstallOpen(true)}
          engineReason={stemEngineUnavailableReason}
          onShowDiagnostics={() => {
            logger.info('STEMS', 'Diagnose angefordert – npm run stems:diagnose');
            if (window.rekordboxDesktop?.getStemDiagnostics) {
              void window.rekordboxDesktop.getStemDiagnostics().then((d: unknown) => console.log('Diagnostics:', d));
            }
          }}
          progress={separationProgress}
          onCancelSeparation={handleCancelStemSeparation}
          remoteCancelPendingJobId={remoteCancelPendingJobId}
          remoteCancelCooldownJobId={remoteCancelCooldownJobId}
          deckProps={{
            stems: activeTrackStems,
            mixerState: stemsMixerState,
            onToggleStemMute: handleToggleStemMute,
            onToggleStemSolo: handleToggleStemSolo,
            onStemVolumeChange: handleStemVolumeChange,
            onExtractStemToClip: handleExtractStemToClip,
            onSetAcapella: handleSetAcapella,
            onSetInstrumental: handleSetInstrumental,
            onResetStems: handleResetStems,
            onOpenMidiModal: () => setMidiModalOpen(true),
            midiStatusLabel,
            isMidiConnected,
            activeArchitectureLabel: activeModelLabel,
          }}
        />

        {/* 5. Hauptarbeitsfläche: Detail-Wellenform (voll oder mit Palette) */}
        <div className="flex-1 flex overflow-hidden relative min-h-0">
          <DetailWaveform
            track={activeTrack}
            trackRevision={trackRevision}
            getPositionSec={getPositionSec}
            viewOffset={viewOffset}
            viewDuration={viewDuration}
            waveformMode={waveformMode}
            selection={selection}
            quantize={quantize}
            /* Fokus-Modus: maximale vertikale Ausnutzung – die Wellenform
               skaliert über die freie Höhe hinaus auf 1,25× Amplitude. */
            verticalScale={focusMode ? 1.25 : 1}
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
            onImportTracksClick={handleTrackImport}
            onLoadAudioClick={() => audioFileInputRef.current?.click()}
            onDropFile={handleDropFile}
            onDropPaletteClip={handleDropPaletteClip}
            onAnalyzeParts={handleAnalyzeParts}
          />

          {/* Clip-Palette (Zone 2, rechts); im Fokus-Modus geschlossen */}
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
              waveformMode={waveformMode}
            />
          )}

          {/* KI-Copilot-Palette (Zone 2, rechts); im Fokus-Modus geschlossen */}
          <ChatbotPalette
            isOpen={chatbotOpen}
            onClose={() => setChatbotOpen(false)}
            trackContext={chatbotTrackContext}
            getTrackContext={resolveChatbotTrackContext}
            onExecuteAction={handleExecuteChatbotAction}
            onSelectZoomPreset={handleSelectZoomPreset}
          />
        </div>

        {/* Vollflächiges Clip-Deck (Zone 2, unterhalb der Wellenform) */}
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
      </main>

      {/* ═══════════ ZONE 3: Untere Bearbeitungs-Paletten ═══════════
          Standardmäßig eingeklappt (schmale Reiter). Der Fokus-Modus blendet
          die Zone vollständig aus – siehe `zone3Visible`. */}
      {zone3Visible(workspace) && (
        <div className="flex flex-col flex-shrink-0" data-zone3-shell="true">
          <Zone3Footer
            activeSection={zone3Section}
            onToggleSection={handleToggleZone3Section}
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
          />

          {/* Unterster Streifen: Browser & Sammlung */}
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
                setPosition(0);
                setViewOffset(0);
                setIsPlaying(false);
                audioEngine.stop();
              }
            }}
            onImportTracks={handleTrackImport}
            trackImportLoading={trackImportLoading}
            onImportAudio={() => audioFileInputRef.current?.click()}
          />
        </div>
      )}

      {/* Flüchtige Prozessmeldungen: bewusst außerhalb aller drei Zonen, damit
          Zone 1 statusfrei bleibt und Zone 2 im Ruhezustand nur die Wellenform
          und die schmale Stem-Zeile zeigt. */}
      <TransientStatusToast items={transientStatuses} onDismiss={dismissTransientStatus} />

      {/* Modals */}
      {/*
        Nur Dialoge, die der Nutzer aktiv öffnet, liegen hinter React.lazy
        (siehe src/components/Modals/lazyModals.ts). Der Fallback ist bewusst
        `null`: die Chunks sind klein und nach dem ersten Öffnen im Cache.
      */}
      <Suspense fallback={null}>
      <LazyRecorderModal
        isOpen={recorderOpen}
        onClose={() => setRecorderOpen(false)}
        stage={recorderStage}
        elapsed={recorderElapsed}
        source={recorderSource}
        onSetSource={(value) => { setRecorderSource(value); setRecordingSource(value); }}
        format={recordingFormat}
        onSetFormat={setRecordingFormat}
        sampleRate={recordingSampleRate}
        onSetSampleRate={setRecordingSampleRate}
        bitDepth={recordingBitDepth}
        onSetBitDepth={setRecordingBitDepth}
        channels={recordingChannels}
        onSetChannels={setRecordingChannels}
        limiter={recordingLimiter}
        onSetLimiter={setRecordingLimiter}
        optimize={recorderOptimize}
        onSetOptimize={setRecorderOptimize}
        targetLufs={recorderTargetLufs}
        onSetTargetLufs={setRecorderTargetLufs}
        truePeak={recorderTruePeak}
        onSetTruePeak={setRecorderTruePeak}
        preRoll={recorderPreRoll}
        onSetPreRoll={setRecorderPreRoll}
        fileName={recorderFileName}
        onSetFileName={setRecorderFileName}
        onStart={() => { void handleRecorderStart(); }}
        onStop={() => { void handleRecorderStop(); }}
        error={recorderError}
        savedPath={recorderSavedPath}
        stats={recorderStats}
      />
      {!remoteFlowOpen && (remoteFlowRunning || remoteFlowJobId) && (
        <button type="button" onClick={() => setRemoteFlowOpen(true)} className="fixed bottom-5 right-5 z-[105] rounded-xl border border-cyan-400/40 bg-[#10212b] px-4 py-3 text-sm font-semibold text-cyan-100 shadow-xl hover:bg-[#183745]" aria-label="Live-Datenfluss der externen Zerlegung anzeigen">
          {remoteFlowRunning ? '↗ Live-Datenfluss · Status ansehen' : '✓ Datenfluss · Ergebnis ansehen'}
        </button>
      )}
      <LazyRemoteFlowModal
        open={remoteFlowOpen}
        onClose={() => setRemoteFlowOpen(false)}
        onCancel={handleCancelStemSeparation}
        onRefresh={() => void stemEngine.pollRemoteJobs().then((status) => status && setStemRemoteStatus(status)).catch((error) => setRemoteFlowError(error?.message ?? 'Status konnte nicht abgefragt werden.'))}
        status={stemRemoteStatus}
        job={(remoteFlowJobId && stemRemoteStatus?.jobs.find((job) => job.jobId === remoteFlowJobId)) || remoteFlowJob}
        trackName={remoteFlowTrack}
        running={remoteFlowRunning || Boolean(remoteFlowJobId && stemRemoteStatus?.jobs.some((job) => job.jobId === remoteFlowJobId && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)))}
        error={remoteFlowError}
        phaseText={separationProgress?.phaseText}
        cancelPending={Boolean(remoteFlowJobId && remoteCancelPendingJobId === remoteFlowJobId)}
      />
      <LazyRemoteSetupModal
        isOpen={remoteSetupOpen}
        onClose={() => setRemoteSetupOpen(false)}
        remoteStatus={stemRemoteStatus}
        onStatus={(status) => setStemRemoteStatus(status)}
      />
      <LazyWorkspaceSettingsModal
        isOpen={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        onShowInfo={() => setInfoModalOpen(true)}
        onOpenDatabaseInspector={() => setDbExtractionModalOpen(true)}
        onOpenSystemLogs={() => setSystemLogModalOpen(true)}
        onClearHistory={() => setClearHistoryModalOpen(true)}
        onOpenRecorder={openRecorder}
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
        recordingSource={recordingSource}
        onSetRecordingSource={(value) => { setRecordingSource(value); setRecorderSource(value); }}
        recordingFormat={recordingFormat}
        onSetRecordingFormat={setRecordingFormat}
        recordingSampleRate={recordingSampleRate}
        onSetRecordingSampleRate={setRecordingSampleRate}
        recordingBitDepth={recordingBitDepth}
        onSetRecordingBitDepth={setRecordingBitDepth}
        recordingChannels={recordingChannels}
        onSetRecordingChannels={setRecordingChannels}
        recordingLimiter={recordingLimiter}
        onSetRecordingLimiter={setRecordingLimiter}
        confirmDestructiveEdits={confirmDestructiveEdits}
        onSetConfirmDestructiveEdits={setConfirmDestructiveEdits}
        autoSaveProject={autoSaveProject}
        onSetAutoSaveProject={setAutoSaveProject}
        stemArchitectures={stemArchitectures}
        stemArchitectureId={stemArchitecture.architectureId}
        onSetStemArchitectureId={(id) => setStemArchitecture((prev) => ({ ...prev, architectureId: id }))}
        onInstallModel={() => setStemInstallOpen(true)}
        stemValidationMode={stemArchitecture.validationMode}
        onSetStemValidationMode={(mode) => setStemArchitecture((prev) => ({ ...prev, validationMode: mode }))}
        stemDevice={stemArchitecture.device}
        onSetStemDevice={(device) => setStemArchitecture((prev) => ({ ...prev, device }))}
        stemEngineState={stemArchitectureState}
        stemArchitecturesLoading={stemArchitecturesLoading}
        onRefreshStemArchitectures={() => { void refreshStemArchitectures(); }}
        workspacePaths={workspacePaths}
        onSetWorkspacePaths={(paths) => {
          setWorkspacePaths(paths);
          saveWorkspacePathSettings(typeof window === 'undefined' ? null : window.localStorage, paths);
        }}
        onOpenInitialSetup={() => setInitialSetupOpen(true)}
      />
      {activeTrack && (
        <>
          <ProjectInfoModal
            isOpen={infoModalOpen}
            onClose={() => setInfoModalOpen(false)}
            track={activeTrack}
          />
          <LazyExportModal
            isOpen={exportModalOpen}
            onClose={() => setExportModalOpen(false)}
            track={activeTrack}
            clips={paletteClips}
            workingAudioBuffer={workingAudioBuffer}
            protectedPaths={protectedPaths}
            onExportComplete={showOperationFeedback}
          />
          <LazyDatabaseExtractionModal
            isOpen={dbExtractionModalOpen}
            onClose={() => setDbExtractionModalOpen(false)}
            activeTrack={activeTrack}
            track={activeTrack}
            onApplyTrack={handleApplyExtractedTrack}
            onImportAnlzFile={handleImportAnlzFile}
            onImportAnlzFromDesktop={handleImportAnlzFromDesktop}
            onOpenRekordboxDatabase={handleOpenRekordboxDatabase}
            onLocateRekordboxDatabases={handleLocateRekordboxDatabases}
            onLoadRekordboxDatabase={handleLoadRekordboxDatabase}
          />
        </>
      )}

      {/* Rekordbox XML Track-Auswahl Modal with Search Bar */}
      <LazyRekordboxXmlImportModal
        isOpen={xmlCollectionModalOpen}
        onClose={() => setXmlCollectionModalOpen(false)}
        xmlTracks={xmlImportedTracks}
        fileName={xmlFileName}
        analysisIndexStatus={analysisIndexStatus}
        onSelectTrack={handleSelectTrackFromXml}
        currentTrackId={activeTrackId}
      />

      {/* Real-time Operation Feedback Modal (Insert, Replace, Delete, etc.) */}
      <OperationFeedbackModal
        isOpen={feedbackModalOpen}
        onClose={() => setFeedbackModalOpen(false)}
        telemetry={feedbackTelemetry}
      />

      {/* System-Protokoll Modal (Hilfe → System-Protokoll...) */}
      <LazySystemLogModal
        isOpen={systemLogModalOpen}
        onClose={() => setSystemLogModalOpen(false)}
      />

      {/* Explicit Normal Delete / Ripple Delete choice */}
      {deleteModeModalOpen && selection && (
        <LazyDeleteModeModal
          selection={selection}
          onNormalDelete={handleNormalDelete}
          onRippleDelete={handleRippleDelete}
          onCancel={() => setDeleteModeModalOpen(false)}
        />
      )}

      {/* Clear History Confirmation Modal (Data Loss Prevention) */}
      <LazyClearHistoryModal
        isOpen={clearHistoryModalOpen}
        onClose={() => setClearHistoryModalOpen(false)}
        onConfirm={handleClearHistoryConfirm}
        undoCount={undoStack.length}
        redoCount={redoStack.length}
        recentActions={[...undoStack, ...redoStack].slice(-6).map((s) => s.description)}
      />

      {/* STEM AI UNAVAILABLE – no fake stems, clear status per §25 */}
      <LazyStemQualityWarningModal
        isOpen={stemQualityWarning !== null}
        reason={stemQualityWarning || stemEngineUnavailableReason || 'STEM AI UNAVAILABLE'}
        installModel={missingStemModel}
        onClose={() => {
          setStemQualityWarning(null);
          setStemEngineUnavailableReason(null);
        }}
        onProceedWithFallback={() => {
          // Fallback is NOT allowed as productive path per §2 – only close modal
          logger.warn('EDITING', 'Spectral fallback requested but blocked per §2 – STEM AI UNAVAILABLE remains');
          setStemQualityWarning(null);
        }}
        onEngineInstalled={(result) => {
          // Wortlaut aus dem Installer: nur ein PyTorch-Modell mit Test-Inferenz
          // ist „verifiziert“; ein ONNX-Graph meldet Datei + SHA256 getrennt.
          logger.info(
            'EDITING',
            result?.label ??
              (missingStemModel
                ? `KI-Modell wurde installiert: ${missingStemModel.id}`
                : 'KI-Stem-Engine wurde installiert.'),
            result?.warning ? { warning: result.warning } : undefined
          );
          if (!missingStemModel) {
            // Der Legacy-In-App-Installer installiert die primäre BS-RoFormer-
            // Engine. Eine vorher gepinnte, fehlende ONNX/Demucs-Architektur
            // darf den nächsten Lauf nicht weiter blockieren. Bei einem exakt
            // gewählten Modell bleibt die Auswahl dagegen unverändert.
            setStemArchitecture((prev) => ({ ...prev, architectureId: 'auto' }));
          }
          void stemEngine.getEngineInfo().then((info) => setStemEngineInfo(info));
          void refreshStemArchitectures();
        }}
        onRunWithInstalledEngine={() => {
          setStemQualityWarning(null);
          setStemEngineUnavailableReason(null);
          stemEngine.clearCache();
          setActiveTrackStems(null);
          const effectiveArchitecture: StemArchitectureSettings = missingStemModel
            ? stemArchitecture
            : { ...stemArchitecture, architectureId: 'auto' };
          if (!missingStemModel) setStemArchitecture(effectiveArchitecture);
          void (async () => {
            const info = await stemEngine.getEngineInfo().catch(() => null);
            if (info) setStemEngineInfo(info);
            await refreshStemArchitectures();
            /*
             * Bewusst über den Preflight (wie der Deck-Button): die Installation
             * kann eine Runtime nachgeliefert haben, muss aber nicht. Ein
             * Direktstart ohne Prüfung erzeugte im Produktionslog einen Job,
             * der nach 263 s mit BACKEND_UNAVAILABLE endete.
             */
            await handleSeparateStems();
          })();
        }}
      />

      {/* Installiert exakt das im Einstellungsmenü gewählte, noch fehlende Modell. */}
      <LazyStemModelInstallModal
        isOpen={stemInstallOpen}
        model={missingStemModel}
        onClose={() => setStemInstallOpen(false)}
        onInstalled={(modelId, result) => {
          logger.info(
            'EDITING',
            result?.label ?? `KI-Modell wurde installiert: ${modelId}`,
            result?.warning ? { warning: result.warning } : undefined
          );
          // Architekturliste + Engine-Status aktualisieren, damit das Modell
          // sofort „installiert" gezeigt wird (Dialog bleibt für die Erfolgsmeldung offen).
          void refreshStemArchitectures();
          void stemEngine.getEngineInfo().then((info) => setStemEngineInfo(info));
        }}
      />

      {/* Ersteinrichtungs- & Installationsassistent beim ersten Öffnen */}
      <InitialSetupModal
        isOpen={initialSetupOpen}
        onClose={() => setInitialSetupOpen(false)}
        onComplete={handleCompleteInitialSetup}
      />

      {/* Edit Assistant Diagnostic & Buffer Integrity Modal */}
      <LazyEditAssistantModal
        isOpen={editAssistantModalOpen}
        onClose={() => setEditAssistantModalOpen(false)}
        lastValidation={editAssistantState.lastValidation}
        summary={editAssistantSummary}
        autoCorrect={editAssistantState.autoCorrect}
        onToggleAutoCorrect={(enabled) => editAssistant.setAutoCorrect(enabled)}
      />

      {/* Pioneer Hardware Controller & MIDI Mapping Modal */}
      <LazyMidiControllerModal
        isOpen={midiModalOpen}
        onClose={() => setMidiModalOpen(false)}
        stemsMixerState={stemsMixerState}
        onToggleStemMute={handleToggleStemMute}
        onToggleStemSolo={handleToggleStemSolo}
      />
      </Suspense>
    </div>
  );
}
