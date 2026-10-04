/**
 * Set-Aufnahme (Recorder): Zustand und Ablauf der Aufnahme aus dem Editor oder
 * aus einer Audio-Eingabe.
 *
 * Warum diese Datei existiert:
 *   Zwölf `useState`-Zeilen plus ein Sitzungs-`Ref` standen zwischen
 *   Stem-Zustand und Ansichts-Schaltern in `App.tsx`, die zugehörigen fünf
 *   Handler gut 200 Zeilen weiter unten (Zerlegung WP-06, Schritt 7). Zustand
 *   und Ablauf gehören zusammen: eine Aufnahme ist ein Vorgang mit klaren Stufen
 *   (Vorlauf → Aufnahme → Nachbearbeitung → Speichern), hier an einer Stelle.
 *
 *   Übertragen, nicht umgeschrieben. Das Modal bleibt unabhängig vom
 *   Bearbeitungs-Transport: eine Rekordbox-Aufnahme läuft weiter, während der
 *   Editor offen ist.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { audioEngine } from '../../audio/audioEngine';
import {
  AudioExportFormatUnavailableError,
  exportAudioBuffer,
  isAudioExportFormatSupported,
} from '../../audio/audioExporter';
import { measureRecordingAudio, optimizeRecordingBuffer } from '../../audio/recordingProcessor';
import type { OperationTelemetry } from '../../components/Modals/OperationFeedbackModal';
import type { RecorderFormat, RecorderSource, RecorderStage } from '../../components/Modals/RecorderModal';
import type { TrackModel } from '../../types/rekordbox';
import { logger } from '../../utils/logger';

export interface RecorderDependencies {
  activeTrack: TrackModel | null;
  /** Tonquelle aus den Anwendungseinstellungen (Vorbelegung des Recorders). */
  recordingSource: RecorderSource;
  protectedPaths: string[];
  showOperationFeedback: (telemetry: OperationTelemetry) => void;
  setChatbotOpen: (open: boolean) => void;
  /** Aufnahme-Voreinstellungen aus den Anwendungseinstellungen. */
  recordingFormat: RecorderFormat;
  recordingSampleRate: 44100 | 48000;
  recordingBitDepth: 16 | 24 | 32;
  recordingChannels: 'STEREO' | 'MONO';
  recordingLimiter: boolean;
}

export function useRecorder(deps: RecorderDependencies) {
  const {
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
  } = deps;

const [recorderOpen, setRecorderOpen] = useState<boolean>(false);
const [recorderStage, setRecorderStage] = useState<RecorderStage>('IDLE');
const [recorderElapsed, setRecorderElapsed] = useState<number>(0);
const [recorderSource, setRecorderSource] = useState<RecorderSource>(recordingSource);
const [recorderOptimize, setRecorderOptimize] = useState<boolean>(true);
const [recorderTargetLufs, setRecorderTargetLufs] = useState<-14 | -12 | -9>(-14);
const [recorderTruePeak, setRecorderTruePeak] = useState<-1 | -0.3>(-1);
const [recorderPreRoll, setRecorderPreRoll] = useState<0 | 3 | 5>(3);
const [recorderFileName, setRecorderFileName] = useState<string>('airdox_rekordbox_set');
const [recorderError, setRecorderError] = useState<string | null>(null);
const [recorderSavedPath, setRecorderSavedPath] = useState<string | null>(null);
const [recorderStats, setRecorderStats] = useState<{ beforeLufs: number; afterLufs: number; peak: number; duration: number } | null>(null);

const recorderSessionRef = useRef<{
  mediaRecorder: MediaRecorder | null;
  chunks: Blob[];
  inputStream: MediaStream | null;
  processedStream: MediaStream | null;
  dispose: (() => void) | null;
  timer: number | null;
  countdown: number | null;
  startedAt: number;
}>({ mediaRecorder: null, chunks: [], inputStream: null, processedStream: null, dispose: null, timer: null, countdown: null, startedAt: 0 });

const clearRecorderResources = useCallback(() => {
  const session = recorderSessionRef.current;
  if (session.timer !== null) window.clearInterval(session.timer);
  if (session.countdown !== null) window.clearTimeout(session.countdown);
  session.timer = null;
  session.countdown = null;
  session.dispose?.();
  session.dispose = null;
  // Only device/display tracks are owned by the recorder. The editor master
  // destination is an internal tap and has no hardware track to stop.
  session.inputStream?.getTracks().forEach((track) => track.stop());
  session.inputStream = null;
  session.processedStream = null;
  session.mediaRecorder = null;
}, []);

const openRecorder = useCallback(() => {
  setRecorderError(null);
  setRecorderSavedPath(null);
  setRecorderStats(null);
  if (recorderStage === 'DONE' || recorderStage === 'ERROR') setRecorderStage('IDLE');
  setRecorderOpen(true);
}, [recorderStage]);

const saveRecorderBytes = useCallback(async (
  bytes: Uint8Array,
  extension: string,
  mimeType: string,
  defaultName: string
): Promise<string | null> => {
  const safeBase = (defaultName.trim() || 'airdox_rekordbox_set')
    .replace(/[\\/:*?\"<>|]/g, '_')
    .replace(/\.(wav|flac|mp3)$/i, '');
  const fileName = `${safeBase}.${extension}`;

  if (window.rekordboxDesktop) {
    const result = await window.rekordboxDesktop.saveExportFile({
      kind: 'AUDIO',
      data: bytes,
      defaultName: fileName,
      protectedPaths,
    });
    if (!result.saved) return null;
    return result.path || fileName;
  }

  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return fileName;
}, [protectedPaths]);

const handleRecorderStart = useCallback(async () => {
  if (recorderStage === 'PREROLL' || recorderStage === 'RECORDING' || recorderStage === 'OPTIMIZING' || recorderStage === 'SAVING') return;
  /*
   * Export-Unterstützung vor dem Aufnehmen prüfen: ein Format, das der
   * Exporteur nicht schreiben kann, würde sonst erst nach der Aufnahme
   * auffallen – die Aufnahme wäre dann verloren. WAV ist verfügbar; die
   * komprimierten Formate melden ihren Grund sofort.
   */
  if (!isAudioExportFormatSupported(recordingFormat)) {
    setRecorderError(new AudioExportFormatUnavailableError(recordingFormat).message);
    setRecorderStage('ERROR');
    return;
  }
  if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
    setRecorderError('Dieser Chromium/Electron-Build unterstützt keine Audioaufnahme. Bitte die Desktop-App aktualisieren.');
    setRecorderStage('ERROR');
    return;
  }

  clearRecorderResources();
  setRecorderError(null);
  setRecorderSavedPath(null);
  setRecorderStats(null);
  setRecorderElapsed(0);

  const beginCapture = async () => {
    try {
      let capturedStream: MediaStream;
      let ownedInput: MediaStream | null = null;
      let dispose: (() => void) | null = null;

      if (recorderSource === 'EDITOR_MASTER') {
        // This is already post master-limiter and therefore the cleanest
        // source when the set is played inside airdox.
        capturedStream = audioEngine.getMasterRecordStream();
      } else if (recorderSource === 'AUDIO_INPUT') {
        ownedInput = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 2, echoCancellation: false, autoGainControl: false, noiseSuppression: false },
          video: false,
        });
        const processed = audioEngine.createInputRecordingStream(ownedInput, recordingLimiter);
        capturedStream = processed.stream;
        dispose = processed.dispose;
      } else {
        // Electron/Chromium shows a native chooser. The user selects the
        // display or output carrying Rekordbox and enables "Audio teilen".
        ownedInput = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        } as DisplayMediaStreamOptions);
        if (ownedInput.getAudioTracks().length === 0) {
          ownedInput.getTracks().forEach((track) => track.stop());
          throw new Error('Kein Loopback-Audiosignal gewählt. Bitte in der Systemauswahl "Audio teilen" aktivieren.');
        }
        ownedInput.getVideoTracks().forEach((track) => track.stop());
        const processed = audioEngine.createInputRecordingStream(ownedInput, recordingLimiter);
        capturedStream = processed.stream;
        dispose = processed.dispose;
      }

      const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
      const mimeType = mimeCandidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
      const recorder = new MediaRecorder(capturedStream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 320000,
      });
      const session = recorderSessionRef.current;
      session.mediaRecorder = recorder;
      session.chunks = [];
      session.inputStream = ownedInput;
      session.processedStream = capturedStream;
      session.dispose = dispose;
      session.startedAt = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) session.chunks.push(event.data);
      };
      recorder.start(1000);
      setRecorderStage('RECORDING');
      session.timer = window.setInterval(() => {
        setRecorderElapsed((Date.now() - session.startedAt) / 1000);
      }, 250);
    } catch (error) {
      clearRecorderResources();
      setRecorderError(error instanceof Error ? error.message : String(error));
      setRecorderStage('ERROR');
      logger.error('RECORDER', `Aufnahme konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  };

  if (recorderPreRoll > 0) {
    setRecorderStage('PREROLL');
    recorderSessionRef.current.countdown = window.setTimeout(() => { void beginCapture(); }, recorderPreRoll * 1000);
  } else {
    await beginCapture();
  }
}, [clearRecorderResources, recorderStage, recorderSource, recorderPreRoll, recordingLimiter, recordingFormat]);

const handleRecorderStop = useCallback(async () => {
  const session = recorderSessionRef.current;
  if (recorderStage === 'PREROLL') {
    if (session.countdown !== null) window.clearTimeout(session.countdown);
    session.countdown = null;
    clearRecorderResources();
    setRecorderStage('IDLE');
    setRecorderElapsed(0);
    return;
  }
  if (recorderStage !== 'RECORDING' || !session.mediaRecorder) return;

  const mediaRecorder = session.mediaRecorder;
  setRecorderStage('OPTIMIZING');
  if (session.timer !== null) window.clearInterval(session.timer);
  session.timer = null;

  try {
    await new Promise<void>((resolve, reject) => {
      mediaRecorder.addEventListener('stop', () => resolve(), { once: true });
      mediaRecorder.addEventListener('error', () => reject(new Error('MediaRecorder hat einen Fehler gemeldet.')), { once: true });
      mediaRecorder.stop();
    });
    const captureBlob = new Blob(session.chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    const rawBytes = await captureBlob.arrayBuffer();
    const audioContext = audioEngine.getContext();
    const decoded = await audioContext.decodeAudioData(rawBytes.slice(0));
    const before = measureRecordingAudio(decoded);

    // Even when the optional loudness pass is disabled, a requested limiter
    // still gets a final whole-file safety ceiling before encoding.
    const shouldProcess = recorderOptimize || recordingLimiter;
    const processed = shouldProcess
      ? await optimizeRecordingBuffer(decoded, {
          targetLufs: recorderOptimize ? recorderTargetLufs : before.estimatedLufs as -14 | -12 | -9,
          truePeakDb: recorderTruePeak,
          targetSampleRate: recordingSampleRate,
          channels: recordingChannels,
        })
      : { buffer: decoded, before, after: { ...before, gainDb: 0 } };
    const after = processed.after;
    setRecorderStats({ beforeLufs: before.estimatedLufs, afterLufs: after.estimatedLufs, peak: after.peakDbtp, duration: after.duration });

    setRecorderStage('SAVING');
    const encoded = await exportAudioBuffer(processed.buffer, {
      format: recordingFormat,
      bitDepth: recordingBitDepth,
      sampleRate: recordingSampleRate,
      bitrateKbps: 320,
    });
    const saved = await saveRecorderBytes(encoded.bytes, encoded.extension, encoded.mimeType, recorderFileName);
    setRecorderSavedPath(saved);
    if (!saved) {
      setRecorderError('Speichern abgebrochen. Die Aufnahme wurde verarbeitet, aber keine Zieldatei gewählt.');
    }
    setRecorderStage('DONE');
    showOperationFeedback({
      title: saved ? `Set aufgenommen und optimiert (${recordingFormat})` : 'Aufnahme verarbeitet',
      operationType: 'EXPORT',
      description: saved
        ? `Die komplette Aufnahme wurde als ein zusammenhängendes Set auf ${recorderTargetLufs} LUFS (≈) und ${recorderTruePeak} dBTP begrenzt. Originalquellen bleiben unverändert.`
        : 'Die Aufnahme wurde optimiert, das Speichern wurde jedoch abgebrochen.',
      originalSha256: activeTrack?.originalSha256 || 'RECORDER_EXTERNAL_SOURCE',
      timestamp: Date.now(),
    });
    logger.info('RECORDER', `Set-Aufnahme beendet: ${saved || 'nicht gespeichert'}`, {
      source: recorderSource,
      format: recordingFormat,
      duration: after.duration,
      beforeLufs: before.estimatedLufs,
      afterLufs: after.estimatedLufs,
      peakDbtp: after.peakDbtp,
    });
  } catch (error) {
    setRecorderError(error instanceof Error ? error.message : String(error));
    setRecorderStage('ERROR');
    logger.error('RECORDER', `Set-Aufnahme konnte nicht verarbeitet werden: ${error instanceof Error ? error.message : String(error)}`, error);
  } finally {
    clearRecorderResources();
  }
}, [activeTrack, clearRecorderResources, recorderFileName, recorderOptimize, recorderSource, recorderStage, recorderTargetLufs, recorderTruePeak, recordingBitDepth, recordingChannels, recordingFormat, recordingLimiter, recordingSampleRate, saveRecorderBytes, showOperationFeedback]);

useEffect(() => () => clearRecorderResources(), [clearRecorderResources]);



  return {
    recorderOpen,
    setRecorderOpen,
    recorderStage,
    setRecorderStage,
    recorderElapsed,
    setRecorderElapsed,
    recorderSource,
    setRecorderSource,
    recorderOptimize,
    setRecorderOptimize,
    recorderTargetLufs,
    setRecorderTargetLufs,
    recorderTruePeak,
    setRecorderTruePeak,
    recorderPreRoll,
    setRecorderPreRoll,
    recorderFileName,
    setRecorderFileName,
    recorderError,
    setRecorderError,
    recorderSavedPath,
    setRecorderSavedPath,
    recorderStats,
    setRecorderStats,
    openRecorder,
    handleRecorderStart,
    handleRecorderStop,
    clearRecorderResources,
  };
}
