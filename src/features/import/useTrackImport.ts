/**
 * Track-Import: ANLZ-Analysedateien, Rekordbox-Datenbank, eingebettete Sammlung,
 * Track-Auswahl aus der Sammlung und das Laden der Original-Audiodatei.
 *
 * Warum diese Datei existiert:
 *   Diese 645 Zeilen lagen mitten in `App.tsx`, zwischen Bearbeitungsbefehlen
 *   und Projektpersistenz. Der Ablauf (ANLZ lesen → Track anreichern →
 *   Analyse-Zuordnung merken → Rückmeldung zeigen) war nur aus dem
 *   Zusammenhang erkennbar.
 *
 *   Zerlegung WP-06, Schritt 3. Übertragen, nicht umgeschrieben: Rümpfe,
 *   Logmeldungen und Rückmeldungen sind unverändert. Die Abhängigkeiten kommen
 *   als Parameter herein, damit der Ablauf ohne Komponente lesbar und prüfbar ist.
 *
 * Wichtig: Der Import öffnet fremde Dateien ausschließlich lesend. Kein Pfad in
 * dieser Datei schreibt in eine Rekordbox-Datei oder in die Original-Audioquelle.
 */

import { useCallback, type RefObject } from 'react';
import { audioEngine } from '../../audio/audioEngine';
import { buildCues, mapRekordboxDatabaseRows } from '../../rekordbox/dbParser';
import { applyAnlzExtractionToTrack, parseAnlzBinary } from '../../rekordbox/databaseExtractor';
import { parseRekordboxXmlAsync } from '../../rekordbox/xmlParser';
import { isNativeRekordboxWaveform } from '../../waveform/analysisComposer';
import { setPosition } from '../../state/transportStore';
import { DataOrigin, type RekordboxCueSource, type SelectionRange, type TrackModel } from '../../types/rekordbox';
import type { OperationTelemetry } from '../../components/Modals/OperationFeedbackModal';
import { logger } from '../../utils/logger';
import {
  BUNDLED_REKORDBOX_XML_FILENAME,
  areSameMediaPath,
  buildCollectionTrackModel,
} from '../project/projectModel';

export interface TrackImportDependencies {
  activeTrack: TrackModel | null;
  workingAudioBuffer: AudioBuffer | null;
  tracks: TrackModel[];
  /** Setzt Projektspuren und erhöht den Revisionszähler für die Wellenform. */
  setTracks: (updater: (previous: TrackModel[]) => TrackModel[]) => void;
  setWorkingAudioBuffer: React.Dispatch<React.SetStateAction<AudioBuffer | null>>;
  activeTrackId: string;
  setActiveTrackId: React.Dispatch<React.SetStateAction<string>>;
  setAnalysisIndexStatus: React.Dispatch<React.SetStateAction<string>>;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  setSelection: React.Dispatch<React.SetStateAction<SelectionRange | null>>;
  /** Verwirft den Bearbeitungsverlauf (beim Laden eines anderen Tracks). */
  clearEditHistory: () => void;
  setViewOffset: React.Dispatch<React.SetStateAction<number>>;
  /** Zustand der Import-Modalitäten (Sammlungsauswahl, Ladeanzeige). */
  setXmlCollectionModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setXmlFileName: React.Dispatch<React.SetStateAction<string>>;
  setXmlImportedTracks: React.Dispatch<React.SetStateAction<TrackModel[]>>;
  setTrackImportLoading: React.Dispatch<React.SetStateAction<boolean>>;
  trackImportLoading: boolean;
  xmlFileName: string;
  xmlImportedTracks: TrackModel[];
  /** Einmal geladene eingebettete Sammlung bleibt im Speicher (kommt vom Aufrufer). */
  bundledCollectionPromiseRef: RefObject<Promise<TrackModel[]> | null>;
  cacheAnalysisMapping: (
    track: TrackModel,
    analysisPath: string,
    source: string,
    details?: { size?: number; modifiedAt?: number; sourceMediaPath?: string; sourceDuration?: number }
  ) => Promise<void>;
  showOperationFeedback: (telemetry: OperationTelemetry) => void;
}

export interface TrackImportControls {
  handleImportAnlzData: (
    data: ArrayBuffer,
    fileName: string,
    sourceDetails?: { path: string; size?: number; modifiedAt?: number }
  ) => Promise<void>;
  handleImportAnlzFile: (file: File) => Promise<void>;
  handleImportAnlzFromDesktop: () => Promise<void>;
  handleLoadRekordboxDatabase: (dbPath: string, sourceLabel?: string) => Promise<void>;
  handleOpenRekordboxDatabase: () => Promise<void>;
  handleLocateRekordboxDatabases: () => Promise<{ path: string; kind: 'MASTER_DB' | 'ONE_LIBRARY'; label: string }[]>;
  loadBundledRekordboxCollection: () => Promise<TrackModel[]>;
  handleTrackImport: () => Promise<void>;
  handleSelectTrackFromXml: (track: TrackModel) => Promise<void>;
}

export function useTrackImport(options: TrackImportDependencies): TrackImportControls {
  const {
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
  } = options;

const handleImportAnlzData = async (
  data: ArrayBuffer,
  fileName: string,
  sourceDetails?: { path: string; size?: number; modifiedAt?: number }
) => {
  if (!activeTrack) return;

  logger.info('XML_IMPORT', `ANLZ-Analyseimport gestartet: ${fileName}`, {
    fileName,
    sizeBytes: data.byteLength,
    fromDesktop: Boolean(sourceDetails?.path),
  });
  try {
    const extraction = parseAnlzBinary(data);
    const sourceDuration = activeTrack.analysisSource?.sourceDuration || activeTrack.audioBuffer?.duration || workingAudioBuffer?.duration || activeTrack.duration;
    const extracted = applyAnlzExtractionToTrack(activeTrack, extraction);
    const nativeAnalysis = extraction.waveform
      ? { ...extraction.waveform, secPerBucket: sourceDuration / Math.max(1, extraction.waveform.length) }
      : extracted.analysis;
    const hasProjectEdits = !(activeTrack.workingSegments.length === 1 && activeTrack.workingSegments[0]?.type === 'ORIGINAL');
    // Importing an ANLZ into an edited deck supplies waveform provenance but
    // must not replace the user's already causal cues/grid/phrases.
    const appliedTrack: TrackModel = hasProjectEdits
      ? { ...activeTrack, analysis: nativeAnalysis }
      : { ...extracted, analysis: nativeAnalysis };
    const enrichedTrack: TrackModel = sourceDetails
      ? {
          ...appliedTrack,
          analysisSource: {
            path: sourceDetails.path,
            accessMode: 'READ_ONLY',
            status: 'AVAILABLE',
            size: sourceDetails.size,
            modifiedAt: sourceDetails.modifiedAt,
            sourceMediaPath: extraction.analysisPath,
            sourceDuration,
            format: (sourceDetails.path.split('.').pop() || 'ANLZ').toUpperCase() as 'DAT' | 'EXT' | '2EX' | 'ANLZ',
          },
          databaseRecord: appliedTrack.databaseRecord
            ? { ...appliedTrack.databaseRecord, filePath: sourceDetails.path }
            : appliedTrack.databaseRecord,
        }
      : appliedTrack;
    setTracks((previous) => previous.map((track) => (
      track.id === enrichedTrack.id ? enrichedTrack : track
    )));
    if (enrichedTrack.audioBuffer) setWorkingAudioBuffer(enrichedTrack.audioBuffer);

    if (sourceDetails) {
      await cacheAnalysisMapping(enrichedTrack, sourceDetails.path, 'MANUAL_ANLZ', {
        size: sourceDetails.size,
        modifiedAt: sourceDetails.modifiedAt,
        sourceMediaPath: extraction.analysisPath,
        sourceDuration,
      });
    }

    const tags = extraction.tagsFound.join(', ');
    showOperationFeedback({
      title: 'Rekordbox ANLZ-Analyse übernommen (Read-Only)',
      operationType: 'CUE',
      description: `${fileName}: ${extraction.cues.length} Cues, ${extraction.loops.length} Loops, ${extraction.phrases.length} PSSI-Phrasen, ${extraction.waveform?.length || 0} originale Waveform-Buckets und ${extraction.beatGrid ? extraction.beatGrid.beats.length : 0} Beat-Einträge übernommen.${sourceDetails ? ' Die Track↔ANLZ-Pfadzuordnung wurde lokal gespeichert.' : ''}`,
      timeRangeSec: { start: 0, end: enrichedTrack.duration, duration: enrichedTrack.duration },
      originalSha256: enrichedTrack.originalSha256,
      timestamp: Date.now(),
    });
    logger.info('XML_IMPORT', `[ANLZ Import] ${fileName} → Tags: ${tags}`, {
      warnings: extraction.warnings,
      cues: extraction.cues.length,
      loops: extraction.loops.length,
      phrases: extraction.phrases.length,
      waveformBuckets: extraction.waveform?.length || 0,
    });
  } catch (error) {
    logger.error('XML_IMPORT', `[ANLZ Import] Rekordbox-Analyse konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`, error);
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
    await handleImportAnlzData(source.data, fileName, source);
  } catch (error) {
    logger.error('XML_IMPORT', `[ANLZ Import] Windows-Lesepfad fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`, error);
    alert(`ANLZ-Datei konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`);
  }
};

// Rekordbox 6/7 database (master.db / OneLibrary exportLibrary.db).
// The desktop bridge opens the SQLCipher library strictly for reading and
// returns only rows; the renderer never touches the source file.
const handleLoadRekordboxDatabase = async (dbPath: string, sourceLabel?: string) => {
  if (!window.rekordboxDesktop) return;
  const dbStartedAt = Date.now();
  logger.info('DATABASE', `Rekordbox-Datenbank-Import gestartet: ${sourceLabel || dbPath}`, { dbPath });
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

    // master.db is used here only as a one-time discovery source. Persist all
    // valid AnalysisDataPath associations in the app-owned path index so
    // later track loads can open ANLZ directly.
    const analysisMappings = fullTrackModels
      .filter((track) => Boolean(track.analysisSource?.path))
      .map((track) => ({
        trackId: track.id,
        mediaPath: track.originalMedia?.location,
        sourceMediaPath: track.analysisSource?.sourceMediaPath,
        analysisPath: track.analysisSource!.path,
        title: track.title,
        artist: track.artist,
        format: track.analysisSource!.format,
        sourceDuration: track.analysisSource!.sourceDuration,
        source: result.dbType === 'ONE_LIBRARY' ? 'ONE_LIBRARY' : 'MASTER_DB',
      }));
    let indexedAnalysisMappings = 0;
    if (analysisMappings.length > 0) {
      try {
        const cached = await window.rekordboxDesktop.cacheAnalysisMappings(analysisMappings);
        indexedAnalysisMappings = cached.accepted;
      } catch (cacheError) {
        logger.warn('DATABASE', `[ANLZ-Pfadindex] DB-Zuordnungen konnten nicht gespeichert werden: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`, cacheError);
      }
    }
    setAnalysisIndexStatus(
      indexedAnalysisMappings > 0
        ? `ANLZ-Pfadindex aktualisiert: ${indexedAnalysisMappings} read-only Zuordnungen.`
        : 'Aus dieser Datenbank wurden keine nutzbaren ANLZ-Pfadzuordnungen gelesen.'
    );

    setXmlImportedTracks(fullTrackModels);
    setXmlFileName(sourceLabel || result.fileName || 'Rekordbox Datenbank');
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
      logger.warn('DATABASE', `[Rekordbox DB] ${warnings.length} Hinweis(e) beim Import`, { warnings });
    }
    logger.info('DATABASE', `Rekordbox-Datenbank importiert: ${mapped.stats.tracks} Tracks in ${Date.now() - dbStartedAt} ms`, {
      dbPath,
      sourceLabel,
      stats: mapped.stats,
      dbType: result.dbType,
      durationMs: Date.now() - dbStartedAt,
    });
  } catch (error) {
    logger.error('DATABASE', `[Rekordbox DB] Import fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`, error);
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
    logger.error('DATABASE', `[Rekordbox DB] Dateiauswahl fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`, error);
  }
};

const handleLocateRekordboxDatabases = async () => {
  if (!window.rekordboxDesktop) return [];
  try {
    return await window.rekordboxDesktop.locateRekordboxDatabases();
  } catch (error) {
    logger.warn('DATABASE', `[Rekordbox DB] Automatische Suche fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`, error);
    return [];
  }
};

const loadBundledRekordboxCollection = useCallback((): Promise<TrackModel[]> => {
  if (!bundledCollectionPromiseRef.current) {
    const loading = (async () => {
      // Verbindliche Quelle in der Desktop-App: die app-eigene Ressource
      // (resources/rekordbox/rekordbox_export2.xml bzw. Repo-Root im
      // Entwicklungsmodus), ausschließlich lesend über den Main-Prozess.
      // Kein Dateidialog, keine Benutzerdatei, keine zweite XML.
      let xml = '';
      let source: 'DESKTOP_RESOURCE' | 'BUNDLED_ASSET' = 'BUNDLED_ASSET';
      const bridge = window.rekordboxDesktop;
      if (bridge?.readBundledRekordboxXml) {
        try {
          const bundled = await bridge.readBundledRekordboxXml();
          if (bundled.available && bundled.data) {
            xml = bundled.data;
            source = 'DESKTOP_RESOURCE';
          } else {
            logger.warn(
              'XML_IMPORT',
              `Eingebettete Rekordbox-Sammlung nicht als Ressource lesbar: ${bundled.reason || 'unbekannter Grund'}`,
              { path: bundled.path }
            );
          }
        } catch (error) {
          logger.warn(
            'XML_IMPORT',
            `Eingebettete Rekordbox-Sammlung konnte nicht über die Desktop-Brücke gelesen werden: ${error instanceof Error ? error.message : String(error)}`,
            error
          );
        }
      }
      if (!xml) {
        // Browser-/Dev-Fallback ohne Electron-Brücke: dieselbe Datei,
        // zur Laufzeit als Vite-Asset gebündelt (per Test auf denselben
        // SHA-256 festgenagelt).
        const bundled = await import('../../rekordbox/bundledCollection');
        xml = bundled.BUNDLED_REKORDBOX_XML;
      }
      const { tracks } = await parseRekordboxXmlAsync(xml);
      if (tracks.length === 0) throw new Error('Die eingebettete Rekordbox-Sammlung enthält keine Tracks.');
      logger.info('XML_IMPORT', `Eingebettete Sammlung dekodiert (${source}): ${tracks.length} Tracks`, {
        source,
        tracks: tracks.length,
      });
      return tracks.map((track, index) =>
        buildCollectionTrackModel(track, index, DataOrigin.REKORDBOX_XML)
      );
    })();
    bundledCollectionPromiseRef.current = loading;
    void loading.catch(() => {
      if (bundledCollectionPromiseRef.current === loading) bundledCollectionPromiseRef.current = null;
    });
  }
  return bundledCollectionPromiseRef.current;
}, []);

// Opening the collection must stay lightweight: the master DB is not
// scanned or copied into memory here. Each selected TrackID is read through
// the targeted Master-DB gate in handleSelectTrackFromXml.

const handleTrackImport = useCallback(async () => {
  if (trackImportLoading) return;
  if (xmlFileName === BUNDLED_REKORDBOX_XML_FILENAME && xmlImportedTracks.length > 0) {
    setXmlCollectionModalOpen(true);
    return;
  }

  setTrackImportLoading(true);
  try {
    const tracks = await loadBundledRekordboxCollection();
    setXmlImportedTracks(tracks);
    setXmlFileName(BUNDLED_REKORDBOX_XML_FILENAME);
    setAnalysisIndexStatus(
      window.rekordboxDesktop
        ? 'Die Master-Datenbank wird nach Auswahl gezielt nur für diese TrackID gelesen (read-only).'
        : 'Zum Laden eines Tracks werden die Windows-Desktop-App und ihre read-only Rekordbox-Datenbank benötigt.'
    );
    setXmlCollectionModalOpen(true);
    logger.info('XML_IMPORT', `Eingebettete Rekordbox-Sammlung bereit: ${tracks.length} Tracks`, {
      fileName: BUNDLED_REKORDBOX_XML_FILENAME,
      tracks: tracks.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('XML_IMPORT', `Eingebettete Rekordbox-Sammlung konnte nicht geladen werden: ${message}`, error);
    alert(`Track-Import fehlgeschlagen: ${message}`);
  } finally {
    setTrackImportLoading(false);
  }
}, [
  loadBundledRekordboxCollection,
  trackImportLoading,
  xmlFileName,
  xmlImportedTracks.length,
]);

// Load a selected bundled-XML track only after the mandatory Master-DB-Gate
// approved TrackID → djmdContent → ANLZ → original audio. No local analysis,
// generated audio, or synthetic waveform is an allowed fallback.
const handleSelectTrackFromXml = async (track: TrackModel) => {
  const loadStartedAt = Date.now();
  try {
    const bridge = window.rekordboxDesktop;
    if (!bridge) {
      throw new Error('[MASTER_DB_NOT_FOUND] Der Track-Import benötigt die Windows-Desktop-App mit Rekordbox-Datenbankzugriff.');
    }

    const trackId = String(track?.id ?? '').trim();
    if (!trackId) {
      throw new Error('[TRACK_NOT_FOUND_IN_MASTER_DB] Der ausgewählte XML-Track enthält keine Rekordbox-TrackID.');
    }
    const xmlLocation = track.originalMedia?.location || track.rawXmlAttributes?.Location;
    logger.info('XML_IMPORT', `Track-Laden über den Master-DB-Gate gestartet: ${trackId}`, {
      trackId,
      title: track.title,
      artist: track.artist,
    });

    // Die Track-Auswahl öffnet ausschließlich die gezielte djmdContent-Zeile.
    // Die gesamte master.db wird nicht vorab in den Renderer kopiert.
    const gate = await bridge.resolveTrackFromMasterDb({
      trackId,
      mediaPath: xmlLocation,
      title: track.title,
      artist: track.artist,
    });
    if (!gate.ok || gate.code !== 'OK') {
      if (gate.code === 'REKORDBOX_WAVEFORM_MISSING') {
        throw new Error(`[REKORDBOX_WAVEFORM_MISSING] ${gate.reason || 'Die ANLZ-Datei enthält keine Rekordbox-Waveform.'}`);
      }
      throw new Error(`[${gate.code}] ${gate.reason || 'Der Master-DB-Gate hat den Track nicht freigegeben.'}`);
    }
    if (!gate.content?.id || !gate.dbPath || !gate.dbType) {
      throw new Error('[MASTER_DB_SCHEMA_INVALID] Der Gate lieferte keinen vollständigen Datenbanknachweis.');
    }
    if (!gate.analysis?.path) {
      throw new Error('[ANLZ_NOT_FOUND] Der Gate lieferte keinen AnalysisDataPath.');
    }
    const gateWaveform = gate.analysis.waveform;
    if (!gate.analysis.hasWaveform || !gateWaveform) {
      throw new Error('[REKORDBOX_WAVEFORM_MISSING] Der Gate hat keine native Rekordbox-Waveform bestätigt.');
    }
    if (!gate.original?.path) {
      throw new Error('[ORIGINAL_AUDIO_NOT_FOUND] Der Gate hat kein lokales Original-Audio bestätigt.');
    }

    // Read the exact ANLZ file approved by the gate. Both IPC reads are
    // explicitly READ_ONLY and return their pre-read size/mtime fingerprints.
    let analysisSource;
    try {
      analysisSource = await bridge.readAnalysisFile(gate.analysis.path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(`[ANLZ_NOT_FOUND] ${detail}`);
      }
      throw new Error(`[ANLZ_READ_FAILED] ${detail}`);
    }
    if (analysisSource.accessMode !== 'READ_ONLY') {
      throw new Error('[ANLZ_READ_FAILED] Die ANLZ-Datei wurde nicht mit READ_ONLY bestätigt.');
    }
    if (!areSameMediaPath(analysisSource.path, gate.analysis.path)) {
      throw new Error('[ANLZ_SOURCE_MISMATCH] Der gelesene ANLZ-Pfad weicht vom Gate-Ergebnis ab.');
    }
    if (
      analysisSource.size !== gate.analysis.size ||
      analysisSource.modifiedAt !== gate.analysis.modifiedAt ||
      analysisSource.size !== analysisSource.data.byteLength
    ) {
      throw new Error('[ANLZ_READ_FAILED] Größe oder mtime der ANLZ-Datei änderte sich zwischen Gate-Prüfung und Lesevorgang.');
    }

    let extraction;
    try {
      extraction = parseAnlzBinary(analysisSource.data);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[ANLZ_INVALID] ${detail}`);
    }
    if (!extraction.waveform) {
      throw new Error('[ANLZ_WAVEFORM_UNREADABLE] Der Renderer kann die vom Gate bestätigte ANLZ-Waveform nicht dekodieren.');
    }
    if (extraction.waveformTag !== gateWaveform.tag || extraction.waveform.length !== gateWaveform.buckets) {
      throw new Error(
        `[ANLZ_WAVEFORM_UNREADABLE] Waveform-Abschnitt oder Bucket-Anzahl weichen vom Gate-Nachweis ab. ` +
          `Gate: ${gateWaveform.tag}/${gateWaveform.buckets} Buckets, Renderer: ${extraction.waveformTag ?? 'kein Tag'}/${extraction.waveform.length} Buckets, ` +
          `ANLZ: ${gate.analysis.path} (${analysisSource.data.byteLength} Bytes)`
      );
    }
    if (!isNativeRekordboxWaveform(extraction.waveform)) {
      throw new Error('[ANLZ_WAVEFORM_UNREADABLE] Die dekodierte Waveform trägt keine REKORDBOX_ANLZ-Herkunft.');
    }

    const ppthPath = extraction.analysisPath || gate.analysis.ppthPath;
    if (
      (gate.analysis.ppthPath &&
        (!extraction.analysisPath || !areSameMediaPath(gate.analysis.ppthPath, extraction.analysisPath))) ||
      (ppthPath && !areSameMediaPath(gate.original.path, ppthPath))
    ) {
      throw new Error(`[ANLZ_SOURCE_MISMATCH] PPTH (${ppthPath || 'nicht lesbar'}) und bestätigtes Original-Audio stimmen nicht überein.`);
    }

    let originalSource;
    try {
      // Use the gate-selected local file, not the raw XML URL. Rekordbox
      // device URLs such as /contents_… are never opened as local media.
      originalSource = await bridge.readOriginalAudio(gate.original.path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[ORIGINAL_AUDIO_NOT_FOUND] ${detail}`);
    }
    if (originalSource.accessMode !== 'READ_ONLY') {
      throw new Error('[ORIGINAL_AUDIO_NOT_FOUND] Das Original-Audio wurde nicht mit READ_ONLY bestätigt.');
    }
    if (!areSameMediaPath(originalSource.path, gate.original.path)) {
      throw new Error('[ANLZ_SOURCE_MISMATCH] Der gelesene Audio-Pfad weicht vom PPTH-/Gate-Nachweis ab.');
    }
    if (
      originalSource.size !== gate.original.size ||
      originalSource.modifiedAt !== gate.original.modifiedAt ||
      originalSource.size !== originalSource.data.byteLength
    ) {
      throw new Error('[ANLZ_SOURCE_MISMATCH] Größe oder mtime des Original-Audios änderte sich zwischen Gate-Prüfung und Lesevorgang.');
    }

    let originalAudio: AudioBuffer;
    try {
      originalAudio = await audioEngine.getContext().decodeAudioData(originalSource.data.slice(0));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[ORIGINAL_AUDIO_NOT_FOUND] Original-Audio kann nicht dekodiert werden: ${detail}`);
    }
    if (!Number.isFinite(originalAudio.duration) || originalAudio.duration <= 0) {
      throw new Error('[ORIGINAL_AUDIO_NOT_FOUND] Das dekodierte Original-Audio hat keine gültige Dauer.');
    }

    const originalMedia = {
      // Store the usable local source path for project reopening. The original
      // XML Location remains intact in rawXmlAttributes for diagnostics.
      location: originalSource.path,
      resolvedPath: originalSource.path,
      accessMode: 'READ_ONLY' as const,
      status: 'AVAILABLE' as const,
      size: originalSource.size,
      modifiedAt: originalSource.modifiedAt,
    };
    const sourceDuration = originalAudio.duration;
    const sourceTrack: TrackModel = {
      ...track,
      duration: sourceDuration,
      sampleRate: originalAudio.sampleRate,
      channels: originalAudio.numberOfChannels,
      originalSha256: 'NOT_COMPUTED_READ_ONLY_SOURCE',
      isOriginalUntouched: true,
      audioBuffer: originalAudio,
      originalMedia,
      workingSegments: [
        {
          id: `seg-rb-${trackId}`,
          type: 'ORIGINAL',
          trackId,
          sourceStart: 0,
          sourceEnd: sourceDuration,
          projectStart: 0,
          projectDuration: sourceDuration,
          gain: 1,
        },
      ],
    };

    const extractedTrack = applyAnlzExtractionToTrack(sourceTrack, extraction);
    const nativeAnalysis = {
      ...extraction.waveform,
      secPerBucket: sourceDuration / Math.max(1, extraction.waveform.length),
    };
    const dbCueModel = buildCues(
      gate.content.id,
      gate.cues,
      extractedTrack.bpm,
      extractedTrack.beatGrid.firstBeat
    );
    const hasAnlzCues = extraction.cues.length > 0;
    const hasDatabaseCues = dbCueModel.cues.length > 0;
    const cues = hasAnlzCues
      ? extraction.cues
      : hasDatabaseCues
        ? dbCueModel.cues
        : sourceTrack.cues;
    const loops = extraction.loops.length > 0
      ? extraction.loops
      : dbCueModel.loops.length > 0
        ? dbCueModel.loops
        : sourceTrack.loops;
    const cueSource: RekordboxCueSource = hasAnlzCues
      ? extraction.tagsFound.includes('PCO2') ? 'ANLZ_PCO2' : 'ANLZ_PCOB'
      : hasDatabaseCues
        ? 'DJMD_CUE'
        : sourceTrack.cues.length > 0
          ? 'REKORDBOX_XML'
          : 'NONE';
    const gateProvenance = {
      rekordboxTrackId: trackId,
      contentId: gate.content.id,
      databasePath: gate.dbPath,
      databaseType: gate.dbType,
      ppthPath,
      originalPath: originalSource.path,
      waveform: gateWaveform,
      cueSource,
      gateCode: 'OK' as const,
      gateVerifiedAt: Date.now(),
    };
    const databaseRecord = {
      ...(extractedTrack.databaseRecord || {}),
      trackId: gate.content.id,
      databaseSource: 'REKORDBOX_ANLZ' as const,
      anlzTagsFound: extraction.tagsFound,
      memoryCuesCount: cues.filter((cue) => cue.type === 'MEMORY').length,
      hotCuesCount: cues.filter((cue) => cue.type === 'HOT_CUE').length,
      loopsCount: loops.length,
      waveformBuckets: nativeAnalysis.length,
      waveformModeSupported: ['BLUE', 'RGB', '3BAND'] as Array<'BLUE' | 'RGB' | '3BAND'>,
      sampleRate: originalAudio.sampleRate,
      checksum: 'NOT_COMPUTED_READ_ONLY_SOURCE',
      extractedAt: Date.now(),
      filePath: analysisSource.path,
      rekordboxTrackId: gateProvenance.rekordboxTrackId,
      contentId: gateProvenance.contentId,
      databasePath: gateProvenance.databasePath,
      databaseType: gateProvenance.databaseType,
      analysisPath: analysisSource.path,
      waveformTag: gateWaveform.tag,
      ppthPath: gateProvenance.ppthPath,
      originalPath: gateProvenance.originalPath,
      cueSource,
      gateCode: 'OK' as const,
    };
    const resolvedDef = {
      ...extractedTrack,
      duration: sourceDuration,
      sampleRate: originalAudio.sampleRate,
      channels: originalAudio.numberOfChannels,
      originalSha256: 'NOT_COMPUTED_READ_ONLY_SOURCE',
      isOriginalUntouched: true,
      audioBuffer: originalAudio,
      originalMedia,
      analysis: nativeAnalysis,
      cues,
      loops,
      origin: DataOrigin.REKORDBOX_ANLZ,
      analysisSource: {
        path: analysisSource.path,
        accessMode: 'READ_ONLY' as const,
        status: 'AVAILABLE' as const,
        size: analysisSource.size,
        modifiedAt: analysisSource.modifiedAt,
        sourceMediaPath: ppthPath,
        sourceDuration,
        format: (analysisSource.path.split('.').pop() || 'ANLZ').toUpperCase() as 'DAT' | 'EXT' | '2EX' | 'ANLZ',
        ...gateProvenance,
      },
      databaseRecord,
      workingSegments: sourceTrack.workingSegments,
    };

    if (!isNativeRekordboxWaveform(resolvedDef.analysis)) {
      throw new Error('[ANLZ_WAVEFORM_UNREADABLE] Die Track-Waveform ist nicht als Rekordbox-ANLZ markiert.');
    }
    if (resolvedDef.analysis.length !== gateWaveform.buckets) {
      throw new Error(
        `[ANLZ_WAVEFORM_UNREADABLE] Die Renderer-Bucket-Anzahl stimmt nicht mit dem Gate-Nachweis überein. ` +
          `Gate: ${gateWaveform.buckets}, Track: ${resolvedDef.analysis.length}`
      );
    }

    setTracks((previous) => {
      const existingIndex = previous.findIndex((candidate) => candidate.id === resolvedDef.id);
      if (existingIndex < 0) return [...previous, resolvedDef];
      const next = [...previous];
      next[existingIndex] = resolvedDef;
      return next;
    });
    setActiveTrackId(resolvedDef.id);
    setWorkingAudioBuffer(originalAudio);
    setPosition(0);
    setViewOffset(0);
    setIsPlaying(false);
    setSelection(null);
    clearEditHistory();
    audioEngine.stop();

    await cacheAnalysisMapping(resolvedDef, analysisSource.path, 'MASTER_DB_GATE', {
      size: analysisSource.size,
      modifiedAt: analysisSource.modifiedAt,
      sourceMediaPath: ppthPath,
      sourceDuration,
    });

    const duration = originalAudio.duration;
    const sourceStatus = `SOURCE    REKORDBOX ANLZ · DATABASE ${gate.dbType} · ANALYSIS ${gateWaveform.tag} · WAVEFORM ${gateWaveform.buckets} Buckets · CUES ${cueSource} · AUDIO READ ONLY`;
    showOperationFeedback({
      title: 'Rekordbox-Track geladen (READ ONLY)',
      operationType: 'CUE',
      description: `${resolvedDef.artist} — ${resolvedDef.title}\n${sourceStatus}`,
      timeRangeSec: { start: 0, end: duration, duration },
      originalSha256: 'NOT_COMPUTED_READ_ONLY_SOURCE',
      timestamp: Date.now(),
    });
    logger.info('XML_IMPORT', `Track ${trackId} über REKORDBOX_ANLZ geladen (${Date.now() - loadStartedAt} ms)`, {
      trackId,
      contentId: gate.content.id,
      databasePath: gate.dbPath,
      databaseType: gate.dbType,
      analysisPath: analysisSource.path,
      waveform: gateWaveform,
      cueSource,
      originalPath: originalSource.path,
      originalSize: originalSource.size,
      originalModifiedAt: originalSource.modifiedAt,
      duration,
      durationMs: Date.now() - loadStartedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('XML_IMPORT', `[Track-Import] ${message}`, error);
    throw error;
  }
};

  return {
    handleImportAnlzData,
    handleImportAnlzFile,
    handleImportAnlzFromDesktop,
    handleLoadRekordboxDatabase,
    handleOpenRekordboxDatabase,
    handleLocateRekordboxDatabases,
    loadBundledRekordboxCollection,
    handleTrackImport,
    handleSelectTrackFromXml,
  };
}
