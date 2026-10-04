/**
 * Projektdateien: Speichern, Öffnen sowie Laden von Audiodateien.
 *
 * Warum diese Datei existiert:
 *   Speichern und Öffnen lagen als Block von rund 230 Zeilen mitten in
 *   `App.tsx`, das Laden von Audiodateien direkt darunter (Zerlegung WP-06,
 *   Schritte 3/4). Beides sind Ein-/Ausgabevorgänge: sie berühren
 *   Projektzustand, Dateisystem und Rückmeldung, enthalten aber keine
 *   Bearbeitungslogik.
 *
 *   Übertragen, nicht umgeschrieben. Geöffnete Originalquellen werden
 *   ausschließlich lesend behandelt; geschrieben wird nur über den
 *   ausdrücklichen Speichern-Pfad.
 */

import { useCallback } from 'react';
import { audioEngine } from '../../audio/audioEngine';
import type React from 'react';
import { DataOrigin, type PaletteClip, type SelectionRange, type TrackModel } from '../../types/rekordbox';
import type { OperationTelemetry } from '../../components/Modals/OperationFeedbackModal';
import { analyzeAudioBuffer, estimateBpm, extractMiniPeaks } from '../../waveform/analyzer';
import { composeWaveformFromEditSegments, isNativeRekordboxWaveform, sliceWaveformAnalysis } from '../../waveform/analysisComposer';
import { buildBeatGridFromTempo } from '../../rekordbox/xmlParser';
import { generateRekordboxPhrases } from '../../rekordbox/databaseExtractor';
import { serializeProject, deserializeProject } from '../../rekordbox/projectFile';
import { logger } from '../../utils/logger';
import { sha256Hex } from '../../utils/sha256';
import { setPosition } from '../../state/transportStore';
import { beatOffsetsForRange, decodeWavBase64, rebuildTrackFromSerialized } from './projectModel';

export interface ProjectFileDependencies {
  projectName: string;
  setProjectName: React.Dispatch<React.SetStateAction<string>>;
  tracks: TrackModel[];
  setTracks: (next: TrackModel[] | ((previous: TrackModel[]) => TrackModel[])) => void;
  activeTrack: TrackModel | null;
  activeTrackId: string;
  setActiveTrackId: React.Dispatch<React.SetStateAction<string>>;
  selection: SelectionRange | null;
  setSelection: React.Dispatch<React.SetStateAction<SelectionRange | null>>;
  paletteClips: PaletteClip[];
  setPaletteClips: React.Dispatch<React.SetStateAction<PaletteClip[]>>;
  setWorkingAudioBuffer: React.Dispatch<React.SetStateAction<AudioBuffer | null>>;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  setViewOffset: React.Dispatch<React.SetStateAction<number>>;
  /** Pfade, in die nie geschrieben werden darf (Quelldateien der Nutzer). */
  protectedPaths: string[];
  hydrateNativeAnalysis: (
    track: TrackModel,
    options?: { preserveProjectMetadata?: boolean; sourceDuration?: number; requireExactMediaPath?: boolean }
  ) => Promise<TrackModel>;
  showOperationFeedback: (telemetry: OperationTelemetry) => void;
  /** Drag & Drop von ANLZ-Dateien kommt aus dem Import-Modul (WP-06, Schritt 3). */
  handleImportAnlzFile: (file: File) => Promise<void>;
}

export interface ProjectFileControls {
  handleSaveProject: () => Promise<void>;
  handleOpenProject: () => Promise<void>;
  loadAudioFile: (file: File) => Promise<void>;
  handleImportAudioFile: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleDropFile: (file: File) => void;
}

export function useProjectFiles(options: ProjectFileDependencies): ProjectFileControls {
  const {
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
  } = options;

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
  logger.info('PROJECT', `Projekt wird gespeichert: "${projectName}"`, {
    defaultName,
    bytes: data.length,
    tracks: tracks.length,
    paletteClips: paletteClips.length,
  });

  try {
    if (window.rekordboxDesktop) {
      const res = await window.rekordboxDesktop.saveExportFile({
        kind: 'PROJECT',
        data,
        defaultName,
        protectedPaths,
      });
      if (res.saved) {
        logger.info('PROJECT', `Projekt gespeichert: ${res.path}`, {
          bytes: res.bytes,
          path: res.path,
        });
        showOperationFeedback({
          title: 'Projekt gespeichert',
          operationType: 'EXPORT',
          description: `Projekt "${projectName}" als "${res.path?.split(/[\\\\/]/).pop() || defaultName}" gespeichert. Original-Rekordbox-Quellen bleiben unverändert.`,
          originalSha256: activeTrack?.originalSha256 ?? 'NOT_COMPUTED_READ_ONLY_SOURCE',
          timestamp: Date.now(),
        });
      } else {
        logger.warn('PROJECT', 'Projektspeichern vom Benutzer abgebrochen (kein Ziel gewählt).');
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
    logger.info('PROJECT', `Projekt als Browser-Download heruntergeladen: ${defaultName}`, {
      bytes: data.length,
    });
    showOperationFeedback({
      title: 'Projekt gespeichert',
      operationType: 'EXPORT',
      description: `Projekt "${projectName}" als "${defaultName}" heruntergeladen.`,
      originalSha256: activeTrack?.originalSha256 ?? 'NOT_COMPUTED_READ_ONLY_SOURCE',
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('PROJECT', `[Projekt] Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, err);
    alert(`Projekt konnte nicht gespeichert werden: ${err instanceof Error ? err.message : String(err)}`);
  }
}, [projectName, activeTrackId, selection, tracks, paletteClips, protectedPaths, activeTrack, showOperationFeedback]);

const handleOpenProject = useCallback(async () => {
  if (!window.rekordboxDesktop) {
    alert('Projekte öffnen ist nur in der Windows-Desktop-App verfügbar.');
    return;
  }

  const openStartedAt = Date.now();
  try {
    const opened = await window.rekordboxDesktop.openProjectFile();
    if (!opened) {
      logger.info('PROJECT', 'Projekt-Öffnen vom Benutzer abgebrochen (keine Datei gewählt).');
      return;
    }
    logger.info('PROJECT', `Projektdatei wird geöffnet: ${opened.path}`, {
      path: opened.path,
      size: opened.size,
    });

    const doc = deserializeProject(opened.data);
    const audioCtx = audioEngine.getContext();

    // Rebuild all deck tracks (metadata + embedded clip audio) first.
    const rebuiltTracks: TrackModel[] = [];
    for (const st of doc.tracks) {
      rebuiltTracks.push(await rebuildTrackFromSerialized(st, audioCtx));
    }

    // Resolve the active source *before* hydrating its ANLZ data: ANLZ
    // waveform chunks need the unedited source duration, not the persisted
    // (possibly shorter/longer) project duration.
    const persistedActiveId = doc.activeTrackId || rebuiltTracks[0]?.id;
    const persistedActiveIndex = rebuiltTracks.findIndex((track) => track.id === persistedActiveId);
    let activeWorkingAudio: AudioBuffer | null = null;

    if (persistedActiveIndex >= 0) {
      const persistedTrack = rebuiltTracks[persistedActiveIndex];
      let originalAudio = persistedTrack.audioBuffer;
      let originalMedia = persistedTrack.originalMedia;

      if (!originalAudio && originalMedia?.location) {
        try {
          const source = await window.rekordboxDesktop.readOriginalAudio(originalMedia.location);
          originalAudio = await audioCtx.decodeAudioData(source.data);
          originalMedia = {
            ...originalMedia,
            resolvedPath: source.path,
            size: source.size,
            modifiedAt: source.modifiedAt,
            status: 'AVAILABLE' as const,
          };
        } catch (error) {
          logger.warn('PROJECT', `[Projekt] Originalaudio konnte nicht erneut geöffnet werden; Metadaten bleiben verfügbar: ${error instanceof Error ? error.message : String(error)}`, error);
          originalMedia = { ...originalMedia, status: 'MISSING' as const };
        }
      }

      const isUneditedOriginal = persistedTrack.workingSegments.length === 1 &&
        persistedTrack.workingSegments[0]?.type === 'ORIGINAL';
      const nativeSourceDuration = originalAudio?.duration ||
        persistedTrack.analysisSource?.sourceDuration || persistedTrack.duration;
      const hydrated = await hydrateNativeAnalysis(
        { ...persistedTrack, audioBuffer: originalAudio || persistedTrack.audioBuffer, originalMedia },
        {
          preserveProjectMetadata: !isUneditedOriginal,
          sourceDuration: nativeSourceDuration,
        }
      );

      if (originalAudio) {
        const working = audioEngine.renderWorkingAudio(originalAudio, hydrated.workingSegments);
        const analysis = isNativeRekordboxWaveform(hydrated.analysis)
          ? composeWaveformFromEditSegments(
              working,
              hydrated.analysis,
              hydrated.analysisSource?.sourceDuration || nativeSourceDuration,
              hydrated.workingSegments,
              { path: hydrated.analysisSource?.path, trackId: hydrated.id }
            )
          : analyzeAudioBuffer(working, DataOrigin.PROJECT);
        rebuiltTracks[persistedActiveIndex] = {
          ...hydrated,
          audioBuffer: originalAudio,
          originalMedia,
          // The decision list is authoritative; never let an original tail
          // reappear as an apparent silent region after reopening.
          duration: working.duration,
          sampleRate: originalAudio.sampleRate,
          channels: originalAudio.numberOfChannels,
          analysis,
        };
        activeWorkingAudio = working;
      } else {
        rebuiltTracks[persistedActiveIndex] = { ...hydrated, originalMedia };
      }
    }

    // Rebuild the palette after the active track was hydrated, so its stored
    // source coordinates can reuse native ANLZ buckets on the next edit.
    const rebuiltClips = [];
    for (const clip of doc.paletteClips) {
      const audioBuffer = await decodeWavBase64(audioCtx, clip.clipWavBase64);
      const sourceTrack = rebuiltTracks.find((track) => track.id === clip.sourceTrackId);
      const sourceDuration = sourceTrack?.analysisSource?.sourceDuration || sourceTrack?.duration || clip.duration;
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
        analysis: sliceWaveformAnalysis(sourceTrack?.analysis, sourceDuration, clip.analysisSourceStart ?? clip.sourceStart, clip.analysisSourceEnd ?? clip.sourceEnd),
        beatOffsets: clip.beatOffsets || (sourceTrack ? beatOffsetsForRange(sourceTrack, clip.sourceStart, clip.sourceEnd) : undefined),
        analysisSource: clip.analysisSource || sourceTrack?.analysisSource,
        analysisSourceTrackId: clip.analysisSourceTrackId || sourceTrack?.id,
        analysisSourceStart: clip.analysisSourceStart ?? clip.sourceStart,
        analysisSourceEnd: clip.analysisSourceEnd ?? clip.sourceEnd,
        origin: clip.origin,
      });
    }

    setProjectName(doc.projectName);
    setSelection(doc.selection);
    setPaletteClips(rebuiltClips);
    setTracks(rebuiltTracks);
    setActiveTrackId(persistedActiveId || rebuiltTracks[0]?.id || '');
    setWorkingAudioBuffer(activeWorkingAudio);
    setPosition(0);
    setViewOffset(0);
    setIsPlaying(false);
    audioEngine.stop();

    logger.info('PROJECT', `Projekt "${doc.projectName}" geöffnet: ${rebuiltTracks.length} Track(s), ${rebuiltClips.length} Clip(s) in ${Date.now() - openStartedAt} ms`, {
      projectName: doc.projectName,
      formatVersion: doc.version,
      tracks: rebuiltTracks.length,
      paletteClips: rebuiltClips.length,
      durationMs: Date.now() - openStartedAt,
    });
    showOperationFeedback({
      title: 'Projekt geladen',
      operationType: 'EXPORT',
      description: `Projekt "${doc.projectName}" mit ${rebuiltTracks.length} Track(s) und ${rebuiltClips.length} Palette-Clip(s) geladen. Originalquellen wurden nur lesend erneut geöffnet.`,
      originalSha256: 'NOT_COMPUTED_READ_ONLY_SOURCE',
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('PROJECT', `[Projekt] Öffnen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, err);
    alert(`Projekt konnte nicht geöffnet werden: ${err instanceof Error ? err.message : String(err)}`);
  }
}, [showOperationFeedback]);

// Audio file loading (WAV, MP3, FLAC, AIFF)
const loadAudioFile = async (file: File) => {
  const loadStartedAt = Date.now();
  logger.info('AUDIO_ENGINE', `Audiodatei wird geladen: ${file.name}`, {
    fileName: file.name,
    sizeBytes: file.size,
    type: file.type,
  });
  try {
    const audioCtx = audioEngine.getContext();
    if (audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume();
      } catch (e) {
        logger.warn('AUDIO_ENGINE', `AudioContext resume fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`, e);
      }
    }

    const arrayBuf = await file.arrayBuffer();
    // Hash the complete source file bytes, not a sample of the decoded left channel.
    const decodedPromise: Promise<AudioBuffer> = new Promise((resolve, reject) => {
      const copy = arrayBuf.slice(0);
      const res = audioCtx.decodeAudioData(copy, resolve, reject);
      if (res && typeof (res as unknown as Promise<AudioBuffer>).then === 'function') {
        (res as unknown as Promise<AudioBuffer>).then(resolve).catch(reject);
      }
    });
    const [decoded, sha256] = await Promise.all([decodedPromise, sha256Hex(arrayBuf)]);
    const analysis = analyzeAudioBuffer(decoded, DataOrigin.LOCAL_ANALYSIS);

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
      setPosition(0);
      setViewOffset(0);
      setIsPlaying(false);
      audioEngine.stop();

      logger.info('AUDIO_ENGINE', `Audiodatei mit Track "${updatedTrack.title}" verknüpft (${Date.now() - loadStartedAt} ms)`, {
        fileName: file.name,
        duration: decoded.duration,
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        sha256: sha256.slice(0, 16),
      });
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
      setPosition(0);
      setViewOffset(0);
      setIsPlaying(false);
      audioEngine.stop();

      logger.info('AUDIO_ENGINE', `Audiodatei importiert: "${newTrack.title}" (${decoded.duration.toFixed(2)}s, ${decoded.sampleRate}Hz, ${detectedBpm.toFixed(1)} BPM, ${Date.now() - loadStartedAt} ms)`, {
        fileName: file.name,
        duration: decoded.duration,
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        detectedBpm,
        sizeBytes: file.size,
      });
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
    logger.error('AUDIO_ENGINE', `Fehler beim Laden der Audiodatei "${file.name}": ${err instanceof Error ? err.message : String(err)}`, err);
    alert(`Audiodatei konnte nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`);
  }
};

const handleImportAudioFile = (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;
  loadAudioFile(file);
  e.target.value = '';
};

// Drag & drop accepts read-only ANLZ files and standalone original audio.
// The bundled XML is opened only through the Track-Import action.
const handleDropFile = (file: File) => {
  const nameLower = file.name.toLowerCase();
  if (nameLower.endsWith('.xml')) {
    alert('Ein externer XML-Import ist deaktiviert. Verwende „Track-Import“ für die eingebettete Rekordbox-Sammlung.');
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
    alert(`Dateityp "${file.name}" wird nicht unterstützt. Bitte ANLZ (.dat, .ext, .2ex) oder Audio (.wav, .mp3, .flac) verwenden.`);
  }
};

  return {
    handleSaveProject,
    handleOpenProject,
    loadAudioFile,
    handleImportAudioFile,
    handleDropFile,
  };
}
