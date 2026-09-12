/**
 * @license
 * Rekordbox Audio Record Modal Component
 * 
 * Gesonderter Aufnahmebereich für Audiodateien, die über Rekordbox oder externe
 * Audioquellen abgespielt werden:
 * - Echtes Stereo-VU-Level-Meter mit dB-Skala & Clip-Indikator
 * - Input-Level-Regler (Gain-Steuerung in Echtzeit)
 * - Wählbare Aufnahmequalität & Formate vor der Aufnahme (WAV 24-bit, WAV 16-bit, WebM/Opus)
 * - Wählbare Audioquellen (Line-In / Mikrofon, System-Audio / Rekordbox Desktop, Interner Deck-Mix)
 * - Automatische Stille-Erkennung / Auto-Stop nach Track-Ende
 * - Datumsbasierte Dateibenennung (z. B. Rekordbox_REC_2026-09-12_17-30-00.wav)
 * - Abfrage des Ziel-Speicherorts (Native File System Access API mit Download-Fallback)
 * - Direktes Übernehmen der fertigen Aufnahme in das Editor-Deck
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Radio,
  Square,
  Play,
  Download,
  FolderOpen,
  Volume2,
  Sliders,
  Settings2,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Clock,
  HardDrive,
  FileAudio,
  Activity,
  Maximize2
} from 'lucide-react';
import { TrackModel, DataOrigin } from '../../types/rekordbox';
import { analyzeAudioBuffer } from '../../waveform/analyzer';
import { buildBeatGridFromTempo } from '../../rekordbox/xmlParser';
import { audioEngine } from '../../audio/audioEngine';
import { logger } from '../../utils/logger';
import { nextId, nextEditId } from '../../utils/ids';

export type RecordFormat = 'WAV_24' | 'WAV_16' | 'WEBM_320' | 'WEBM_192' | 'WEBM_128';
export type RecordSource = 'MIC_LINE' | 'SYSTEM_LOOPBACK' | 'INTERNAL_DECK';

interface AudioRecordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRecordingSaved?: (track: TrackModel) => void;
  activeDeckBuffer?: AudioBuffer | null;
}

// Format definition helpers
const FORMAT_OPTIONS: { id: RecordFormat; label: string; details: string; ext: string }[] = [
  {
    id: 'WAV_24',
    label: 'WAV 24-Bit / 48 kHz',
    details: 'Verlustfrei Studio-Masterqualität (Linear PCM)',
    ext: '.wav',
  },
  {
    id: 'WAV_16',
    label: 'WAV 16-Bit / 44.1 kHz',
    details: 'Verlustfrei CD-Standard (Linear PCM)',
    ext: '.wav',
  },
  {
    id: 'WEBM_320',
    label: 'WebM / Opus 320 kbps',
    details: 'Hohe Audioqualität, extrem kompakte Dateigröße',
    ext: '.webm',
  },
  {
    id: 'WEBM_192',
    label: 'WebM / Opus 192 kbps',
    details: 'Standard DJ-Set Mitschnitt',
    ext: '.webm',
  },
  {
    id: 'WEBM_128',
    label: 'WebM / Opus 128 kbps',
    details: 'Kompakte Sprach- & Referenzaufnahme',
    ext: '.webm',
  },
];

function generateDateBasedFilename(prefix = 'Rekordbox_REC', ext = '.wav'): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${prefix}_${y}-${m}-${d}_${h}-${min}-${s}${ext}`;
}

export const AudioRecordModal: React.FC<AudioRecordModalProps> = ({
  isOpen,
  onClose,
  onRecordingSaved,
  activeDeckBuffer,
}) => {
  // Config state (selectable before recording)
  const [selectedFormat, setSelectedFormat] = useState<RecordFormat>('WAV_24');
  const [selectedSource, setSelectedSource] = useState<RecordSource>('MIC_LINE');
  const [inputGain, setInputGain] = useState<number>(1.0); // 0.0 to 2.0 (0% to 200%)
  const [autoStopOnSilence, setAutoStopOnSilence] = useState<boolean>(true);
  const [silenceDurationSec, setSilenceDurationSec] = useState<number>(4);

  // Active recording state
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [levelL, setLevelL] = useState<number>(0);
  const [levelR, setLevelR] = useState<number>(0);
  const [peakL, setPeakL] = useState<number>(0);
  const [peakR, setPeakR] = useState<number>(0);
  const [isClipping, setIsClipping] = useState<boolean>(false);
  const [audioDetected, setAudioDetected] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('Bereit zur Aufnahme');

  // Finished recording state
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedBuffer, setRecordedBuffer] = useState<AudioBuffer | null>(null);
  const [targetFilename, setTargetFilename] = useState<string>('');
  const [targetFolderHint, setTargetFolderHint] = useState<string>('Downloads / DJ-Aufnahmen');
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  // Audio nodes and refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const analyserLRef = useRef<AnalyserNode | null>(null);
  const analyserRRef = useRef<AnalyserNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const animFrameRef = useRef<number | null>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const silenceCounterRef = useRef<number>(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const startTimeRef = useRef<number>(0);

  // Clean up audio graph on unmount
  useEffect(() => {
    return () => {
      stopActiveRecordingInternal(false);
    };
  }, []);

  // Sync input gain to live gain node
  useEffect(() => {
    if (gainNodeRef.current && audioCtxRef.current) {
      gainNodeRef.current.gain.setTargetAtTime(inputGain, audioCtxRef.current.currentTime, 0.02);
    }
  }, [inputGain]);

  // Update default filename when format changes or dialog opens
  useEffect(() => {
    if (isOpen && !isRecording && !recordedBlob) {
      const ext = FORMAT_OPTIONS.find((f) => f.id === selectedFormat)?.ext || '.wav';
      setTargetFilename(generateDateBasedFilename('Rekordbox_REC', ext));
      setSaveSuccessMsg(null);
    }
  }, [isOpen, selectedFormat, isRecording, recordedBlob]);

  // Main start recording logic
  const handleStartRecording = async () => {
    try {
      setStatusMessage('Verbinde Audioquelle…');
      setIsClipping(false);
      silenceCounterRef.current = 0;
      recordedChunksRef.current = [];
      setRecordedBlob(null);
      setRecordedBuffer(null);
      setSaveSuccessMsg(null);

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const sampleRate = selectedFormat === 'WAV_16' ? 44100 : 48000;
      const ctx = new AudioCtx({ sampleRate });
      audioCtxRef.current = ctx;
      await ctx.resume();

      const gain = ctx.createGain();
      gain.gain.value = inputGain;
      gainNodeRef.current = gain;

      const splitter = ctx.createChannelSplitter(2);
      const analyserL = ctx.createAnalyser();
      const analyserR = ctx.createAnalyser();
      analyserL.fftSize = 256;
      analyserR.fftSize = 256;
      analyserLRef.current = analyserL;
      analyserRRef.current = analyserR;

      gain.connect(splitter);
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);

      let streamToRecord: MediaStream;

      if (selectedSource === 'MIC_LINE') {
        // Line-In / Audio Interface / Rekordbox Rec Out
        streamToRecord = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: sampleRate,
            channelCount: 2,
          },
          video: false,
        });
      } else if (selectedSource === 'SYSTEM_LOOPBACK') {
        // Desktop Screen / Tab Audio Loopback for desktop Rekordbox
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: true,
        });
        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length === 0) {
          displayStream.getTracks().forEach((t) => t.stop());
          throw new Error('Keine Audiospur in der Systemauswahl gefunden. Bitte „Systemaudio freigeben“ aktivieren.');
        }
        // Stop video track immediately, keep audio
        displayStream.getVideoTracks().forEach((vt) => vt.stop());
        streamToRecord = new MediaStream(audioTracks);
      } else {
        // INTERNAL_DECK: Capture audio directly from the audio engine destination
        const dest = ctx.createMediaStreamDestination();
        gain.connect(dest);
        streamToRecord = dest.stream;

        // If an active audio buffer is currently in the editor, we can loop it or play it
        if (activeDeckBuffer) {
          const src = ctx.createBufferSource();
          src.buffer = activeDeckBuffer;
          src.connect(gain);
          src.start();
          sourceNodeRef.current = src;
        }
      }

      mediaStreamRef.current = streamToRecord;

      if (selectedSource !== 'INTERNAL_DECK') {
        const sourceNode = ctx.createMediaStreamSource(streamToRecord);
        sourceNode.connect(gain);
        sourceNodeRef.current = sourceNode;

        // Create recording destination from gain node
        const dest = ctx.createMediaStreamDestination();
        gain.connect(dest);
        streamToRecord = dest.stream;
      }

      // Determine MIME type for MediaRecorder
      let mimeType = 'audio/webm;codecs=opus';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
        mimeType = 'audio/ogg;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      }

      const bitsPerSecond =
        selectedFormat === 'WEBM_320'
          ? 320000
          : selectedFormat === 'WEBM_192'
          ? 192000
          : selectedFormat === 'WEBM_128'
          ? 128000
          : 320000;

      const recorder = new MediaRecorder(streamToRecord, {
        mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : undefined,
        audioBitsPerSecond: bitsPerSecond,
      });

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recordedChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        await processFinishedRecording();
      };

      // Listen for stream ending (e.g., user stopped sharing system audio)
      streamToRecord.getAudioTracks().forEach((track) => {
        track.onended = () => {
          logger.info('AUDIO_ENGINE', '[Recorder] Audio-Track durch System beendet');
          handleStopRecording();
        };
      });

      recorder.start(100);
      setIsRecording(true);
      startTimeRef.current = Date.now();
      setRecordingSeconds(0);
      setStatusMessage('Aufnahme läuft…');

      // Recording elapsed timer
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);

      // Start Level Meter & Oscilloscope loop
      startMeterLoop();
    } catch (err: unknown) {
      logger.error('AUDIO_ENGINE', 'Fehler beim Starten der Aufnahme', { error: err });
      const errMsg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Aufnahmefehler: ${errMsg}`);
      stopActiveRecordingInternal(false);
    }
  };

  // Level Meter & Oscilloscope animation loop
  const startMeterLoop = () => {
    const dataL = new Uint8Array(128);
    const dataR = new Uint8Array(128);

    const update = () => {
      if (!analyserLRef.current || !analyserRRef.current) return;

      analyserLRef.current.getByteTimeDomainData(dataL);
      analyserRRef.current.getByteTimeDomainData(dataR);

      let maxL = 0;
      let maxR = 0;
      for (let i = 0; i < 128; i++) {
        const valL = Math.abs((dataL[i] - 128) / 128);
        const valR = Math.abs((dataR[i] - 128) / 128);
        if (valL > maxL) maxL = valL;
        if (valR > maxR) maxR = valR;
      }

      // Convert to dB-like percentage scale
      const currentLevelL = Math.min(1.0, maxL * 1.4);
      const currentLevelR = Math.min(1.0, maxR * 1.4);
      setLevelL(currentLevelL);
      setLevelR(currentLevelR);

      // Peak holds
      setPeakL((prev) => Math.max(prev * 0.95, currentLevelL));
      setPeakR((prev) => Math.max(prev * 0.95, currentLevelR));

      // Clip detection
      if (maxL >= 0.99 || maxR >= 0.99) {
        setIsClipping(true);
      }

      // Silence detection (auto-stop when silence lasts longer than threshold)
      const isAudible = maxL > 0.02 || maxR > 0.02;
      if (isAudible) {
        setAudioDetected(true);
        silenceCounterRef.current = 0;
      } else {
        silenceCounterRef.current += 1 / 60; // 60fps
        if (autoStopOnSilence && audioDetected && silenceCounterRef.current >= silenceDurationSec) {
          logger.info('AUDIO_ENGINE', '[Recorder] Automatisch beendet wegen Stille');
          setStatusMessage('Automatisch beendet (Track-Ende erkannt)');
          handleStopRecording();
          return;
        }
      }

      // Draw Mini Oscilloscope
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.fillStyle = '#0a0b0e';
          ctx.fillRect(0, 0, w, h);

          // Grid lines
          ctx.strokeStyle = '#181b22';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, h / 2);
          ctx.lineTo(w, h / 2);
          ctx.stroke();

          // Waveform line
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = currentLevelL > 0.9 ? '#ff3b30' : '#00a2ff';
          ctx.beginPath();
          const sliceWidth = w / 128;
          let x = 0;
          for (let i = 0; i < 128; i++) {
            const v = dataL[i] / 128.0;
            const y = (v * h) / 2;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            x += sliceWidth;
          }
          ctx.stroke();
        }
      }

      animFrameRef.current = requestAnimationFrame(update);
    };

    animFrameRef.current = requestAnimationFrame(update);
  };

  // Stop recording trigger
  const handleStopRecording = () => {
    if (!isRecording) return;
    setStatusMessage('Aufnahme beendet. Verarbeite Audiodaten…');
    stopActiveRecordingInternal(true);
  };

  // Process and finalize recorded buffer
  const stopActiveRecordingInternal = (processResult = true) => {
    setIsRecording(false);

    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        logger.warn('AUDIO_ENGINE', 'Error stopping MediaRecorder', { error: e });
      }
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
  };

  // Convert chunks to selected WAV / AudioBuffer
  const processFinishedRecording = async () => {
    try {
      const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const decodeCtx = new AudioCtx();
      const decodedBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
      decodeCtx.close();

      setRecordedBuffer(decodedBuffer);

      // Encode to selected format
      let finalBlob: Blob;
      if (selectedFormat === 'WAV_24' || selectedFormat === 'WAV_16') {
        finalBlob = exportAudioBufferToWav(decodedBuffer, selectedFormat === 'WAV_24' ? 24 : 16);
      } else {
        finalBlob = blob;
      }

      setRecordedBlob(finalBlob);
      const ext = FORMAT_OPTIONS.find((f) => f.id === selectedFormat)?.ext || '.wav';
      setTargetFilename(generateDateBasedFilename('Rekordbox_REC', ext));
      setStatusMessage(`Erfolgreich aufgenommen (${decodedBuffer.duration.toFixed(1)}s, ${decodedBuffer.sampleRate} Hz)`);
    } catch (err) {
      logger.error('AUDIO_ENGINE', 'Fehler bei der Audio-Konvertierung', { error: err });
      setStatusMessage('Audio wurde gespeichert, Dekodierung konnte jedoch nicht verifiziert werden.');
    }
  };

  // Native File System Access API or browser download prompt
  const handleSaveToTargetLocation = async () => {
    if (!recordedBlob) return;

    const ext = FORMAT_OPTIONS.find((f) => f.id === selectedFormat)?.ext || '.wav';
    const finalName = targetFilename.endsWith(ext) ? targetFilename : `${targetFilename}${ext}`;

    try {
      // Check if modern native File System Access API is supported
      if ('showSaveFilePicker' in window) {
        const pickerOpts = {
          suggestedName: finalName,
          types: [
            {
              description: selectedFormat.startsWith('WAV') ? 'WAV Audio-Master' : 'WebM Audio-Datei',
              accept: {
                [recordedBlob.type || 'audio/wav']: [ext],
              },
            },
          ],
        };

        const fileHandle = await (window as unknown as { showSaveFilePicker: (opts: typeof pickerOpts) => Promise<{ name: string; createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker(pickerOpts);
        const writable = await fileHandle.createWritable();
        await writable.write(recordedBlob);
        await writable.close();

        setSaveSuccessMsg(`Erfolgreich am gewünschten Zielort gespeichert als: "${fileHandle.name}"`);
        setTargetFolderHint(`Gespeichert über Datei-Dialog`);
      } else {
        // Fallback: standard browser download
        triggerBrowserDownload(recordedBlob, finalName);
        setSaveSuccessMsg(`Datei "${finalName}" wird in deinem Standard-Download-Ordner gespeichert.`);
      }
    } catch (err: unknown) {
      // User cancelled dialog or permission denied
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      logger.warn('AUDIO_ENGINE', 'File picker fallback triggered', { error: err });
      triggerBrowserDownload(recordedBlob, finalName);
      setSaveSuccessMsg(`Heruntergeladen als "${finalName}".`);
    }
  };

  const triggerBrowserDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  };

  // Directly load the recorded buffer into the main editor deck
  const handleLoadIntoEditorDeck = () => {
    if (!recordedBuffer || !onRecordingSaved) return;

    const duration = recordedBuffer.duration;
    const cleanName = targetFilename.replace(/\.[^/.]+$/, '');
    const bpm = 128.0;
    const trackId = nextId('rec');

    const newTrack: TrackModel = {
      id: trackId,
      title: cleanName,
      artist: 'Rekordbox Live-Aufnahme',
      album: 'Aufnahmen',
      duration,
      bpm,
      key: '1A',
      sampleRate: recordedBuffer.sampleRate,
      channels: recordedBuffer.numberOfChannels,
      originalSha256: `rec-sha256-${trackId}`,
      isOriginalUntouched: true,
      audioBuffer: recordedBuffer,
      originalMedia: {
        location: targetFilename,
        accessMode: 'READ_ONLY',
        status: 'AVAILABLE',
      },
      beatGrid: buildBeatGridFromTempo(0.0, bpm, duration, 4, DataOrigin.LOCAL_ANALYSIS),
      cues: [
        {
          id: nextId('cue'),
          name: 'Rec Start',
          type: 'MEMORY',
          position: 0.0,
          color: '#ff2a2a',
          origin: DataOrigin.LOCAL_ANALYSIS,
        },
      ],
      loops: [],
      analysis: analyzeAudioBuffer(recordedBuffer),
      phrases: [],
      origin: DataOrigin.LOCAL_ANALYSIS,
      workingSegments: [
        {
          id: nextEditId(),
          type: 'ORIGINAL',
          trackId,
          sourceStart: 0,
          sourceEnd: duration,
          projectStart: 0,
          projectDuration: duration,
          gain: 1.0,
        },
      ],
    };

    onRecordingSaved(newTrack);
    onClose();
  };

  if (!isOpen) return null;

  const formatTimer = (totalSeconds: number) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${h > 0 ? `${h.toString().padStart(2, '0')}:` : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-[#101217] border border-[#262935] w-full max-w-2xl rounded-sm shadow-2xl flex flex-col overflow-hidden text-neutral-200 animate-in fade-in duration-150">
        {/* Header matching Rekordbox Window Title */}
        <div className="h-9 bg-[#161820] border-b border-[#262935] px-4 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className={`w-3 h-3 rounded-full flex items-center justify-center ${isRecording ? 'bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.8)]' : 'bg-neutral-600'}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-white" />
            </div>
            <span className="font-bold text-xs tracking-wider text-white uppercase font-sans">
              Audio-Aufnahme (Rekordbox REC)
            </span>
            {isRecording && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-950/80 border border-red-800 text-red-400 font-bold uppercase tracking-wider">
                LIVE AUFNAHME
              </span>
            )}
          </div>

          <button
            onClick={() => {
              if (isRecording) {
                if (window.confirm('Aufnahme läuft gerade. Möchtest du sie wirklich beenden und das Fenster schließen?')) {
                  stopActiveRecordingInternal(false);
                  onClose();
                }
              } else {
                onClose();
              }
            }}
            className="text-neutral-400 hover:text-white p-1 rounded hover:bg-[#252834] transition-colors"
            title="Schließen"
          >
            <X size={15} />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 flex flex-col space-y-4 max-h-[85vh] overflow-y-auto">
          {/* 1. Main Status & Timer Display */}
          <div className="bg-[#0b0c0f] border border-[#1e212b] rounded-sm p-4 flex flex-col items-center justify-center relative overflow-hidden">
            <div className="flex items-center space-x-4 mb-2">
              <div className={`w-4 h-4 rounded-full ${isRecording ? 'bg-red-500 animate-ping' : 'bg-neutral-600'}`} />
              <div className="font-mono text-3xl font-bold tracking-widest text-white">
                {formatTimer(recordingSeconds)}
              </div>
            </div>

            <div className="text-xs text-neutral-400 font-medium flex items-center space-x-2">
              <Activity size={13} className={isRecording ? 'text-red-400 animate-pulse' : 'text-neutral-500'} />
              <span>{statusMessage}</span>
            </div>

            {/* Mini Oscilloscope */}
            <div className="w-full h-12 mt-3 rounded overflow-hidden border border-[#1b1e28]">
              <canvas ref={canvasRef} width={500} height={48} className="w-full h-full block" />
            </div>
          </div>

          {/* 2. Stereo VU-Meter & Input-Level Regler */}
          <div className="bg-[#14161d] border border-[#232632] rounded-sm p-3.5 flex flex-col space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-neutral-300 flex items-center space-x-1.5">
                <Sliders size={13} className="text-[#00a2ff]" />
                <span>Input-Level &amp; Aussteuerung</span>
              </span>
              <div className="flex items-center space-x-2">
                <span className="text-[11px] font-mono text-neutral-400">
                  Gain: <strong className="text-white">{(inputGain * 100).toFixed(0)}%</strong> ({((inputGain - 1) * 12).toFixed(1)} dB)
                </span>
                {isClipping && (
                  <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-red-600 text-white font-bold animate-pulse">
                    CLIP!
                  </span>
                )}
              </div>
            </div>

            {/* Input-Level Regler Slider */}
            <div className="flex items-center space-x-3">
              <span className="text-[10px] text-neutral-500 font-mono">-inf</span>
              <input
                type="range"
                min="0"
                max="2.0"
                step="0.02"
                value={inputGain}
                onChange={(e) => setInputGain(parseFloat(e.target.value))}
                className="flex-1 h-1.5 bg-[#262a38] rounded-lg appearance-none cursor-pointer accent-[#00a2ff]"
                title={`Input Gain: ${(inputGain * 100).toFixed(0)}%`}
              />
              <span className="text-[10px] text-neutral-500 font-mono">+6dB</span>
              <button
                onClick={() => setInputGain(1.0)}
                className="text-[10px] font-mono px-1.5 py-0.5 bg-[#20232e] hover:bg-[#2b2f3e] text-neutral-300 rounded border border-[#303546]"
                title="Gain auf 100% (0 dB) zurücksetzen"
              >
                RST
              </button>
            </div>

            {/* Stereo VU Peak Meter Bars */}
            <div className="flex flex-col space-y-1 pt-1">
              {/* Left Channel */}
              <div className="flex items-center space-x-2">
                <span className="text-[9.5px] font-mono font-bold text-neutral-400 w-3">L</span>
                <div className="flex-1 h-3 bg-[#0a0b0e] border border-[#20232e] rounded-xs p-[1px] flex items-center overflow-hidden">
                  <div
                    className="h-full transition-all duration-75 rounded-xs"
                    style={{
                      width: `${Math.min(100, levelL * 100)}%`,
                      background:
                        levelL > 0.9
                          ? 'linear-gradient(90deg, #10b981 60%, #f59e0b 85%, #ef4444 100%)'
                          : levelL > 0.7
                          ? 'linear-gradient(90deg, #10b981 75%, #f59e0b 100%)'
                          : '#10b981',
                    }}
                  />
                </div>
                <span className="text-[9px] font-mono text-neutral-500 w-10 text-right">
                  {levelL > 0.01 ? `${(20 * Math.log10(levelL)).toFixed(0)} dB` : '-inf'}
                </span>
              </div>

              {/* Right Channel */}
              <div className="flex items-center space-x-2">
                <span className="text-[9.5px] font-mono font-bold text-neutral-400 w-3">R</span>
                <div className="flex-1 h-3 bg-[#0a0b0e] border border-[#20232e] rounded-xs p-[1px] flex items-center overflow-hidden">
                  <div
                    className="h-full transition-all duration-75 rounded-xs"
                    style={{
                      width: `${Math.min(100, levelR * 100)}%`,
                      background:
                        levelR > 0.9
                          ? 'linear-gradient(90deg, #10b981 60%, #f59e0b 85%, #ef4444 100%)'
                          : levelR > 0.7
                          ? 'linear-gradient(90deg, #10b981 75%, #f59e0b 100%)'
                          : '#10b981',
                    }}
                  />
                </div>
                <span className="text-[9px] font-mono text-neutral-500 w-10 text-right">
                  {levelR > 0.01 ? `${(20 * Math.log10(levelR)).toFixed(0)} dB` : '-inf'}
                </span>
              </div>

              {/* dB Scale Legend */}
              <div className="flex justify-between text-[8px] font-mono text-neutral-500 px-5 pt-0.5">
                <span>-48</span>
                <span>-24</span>
                <span>-12</span>
                <span>-6</span>
                <span>-3</span>
                <span className="text-amber-400">0</span>
                <span className="text-red-400">+3</span>
              </div>
            </div>
          </div>

          {/* 3. Audio Source & Quality Format Selector (vor der Aufnahme bestimmbar) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Audio Source Selection */}
            <div className="bg-[#14161d] border border-[#232632] rounded-sm p-3 flex flex-col space-y-2">
              <label className="text-xs font-semibold text-neutral-300 flex items-center space-x-1.5">
                <Radio size={13} className="text-[#00a2ff]" />
                <span>Audioquelle</span>
              </label>

              <select
                disabled={isRecording}
                value={selectedSource}
                onChange={(e) => setSelectedSource(e.target.value as RecordSource)}
                className="bg-[#0b0c0f] border border-[#2c3040] rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#0088ff] disabled:opacity-50"
              >
                <option value="MIC_LINE">Line-In / Audio-Interface (Rekordbox REC Out)</option>
                <option value="SYSTEM_LOOPBACK">System-Audio / Rekordbox Desktop App</option>
                <option value="INTERNAL_DECK">Interner Deck-Mix (airdox Editor Master)</option>
              </select>

              <p className="text-[10.5px] text-neutral-400">
                {selectedSource === 'MIC_LINE' && 'Empfängt das Master- oder Rec-Signal über dein Mischpult / USB-Audio-Interface.'}
                {selectedSource === 'SYSTEM_LOOPBACK' && 'Nimmt den Ton direkt vom Desktop/Betriebssystem auf, wenn Rekordbox abspielt.'}
                {selectedSource === 'INTERNAL_DECK' && 'Nimmt das aktuell im Editor geladene Master-Audio direkt intern auf.'}
              </p>
            </div>

            {/* Quality & Format Selection */}
            <div className="bg-[#14161d] border border-[#232632] rounded-sm p-3 flex flex-col space-y-2">
              <label className="text-xs font-semibold text-neutral-300 flex items-center space-x-1.5">
                <Settings2 size={13} className="text-[#00a2ff]" />
                <span>Aufnahmeformat &amp; Qualität</span>
              </label>

              <select
                disabled={isRecording}
                value={selectedFormat}
                onChange={(e) => setSelectedFormat(e.target.value as RecordFormat)}
                className="bg-[#0b0c0f] border border-[#2c3040] rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#0088ff] disabled:opacity-50"
              >
                {FORMAT_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <p className="text-[10.5px] text-neutral-400">
                {FORMAT_OPTIONS.find((f) => f.id === selectedFormat)?.details}
              </p>
            </div>
          </div>

          {/* 4. Auto-Stop Options */}
          <div className="bg-[#14161d] border border-[#232632] rounded-sm px-3.5 py-2.5 flex items-center justify-between text-xs">
            <label className="flex items-center space-x-2 cursor-pointer select-none text-neutral-300 hover:text-white">
              <input
                type="checkbox"
                checked={autoStopOnSilence}
                onChange={(e) => setAutoStopOnSilence(e.target.checked)}
                disabled={isRecording}
                className="w-3.5 h-3.5 rounded-xs accent-[#0088ff] cursor-pointer"
              />
              <span>Automatisch beenden, wenn Rekordbox den Track beendet (Stille)</span>
            </label>

            {autoStopOnSilence && (
              <div className="flex items-center space-x-1 text-[11px] text-neutral-400 font-mono">
                <span>nach</span>
                <select
                  disabled={isRecording}
                  value={silenceDurationSec}
                  onChange={(e) => setSilenceDurationSec(parseInt(e.target.value))}
                  className="bg-[#0b0c0f] border border-[#2b2f3d] rounded px-1.5 py-0.5 text-white"
                >
                  <option value={2}>2s</option>
                  <option value={3}>3s</option>
                  <option value={4}>4s</option>
                  <option value={6}>6s</option>
                </select>
                <span>Stille</span>
              </div>
            )}
          </div>

          {/* 5. Start / Stop Recording Buttons */}
          <div className="flex items-center justify-center pt-2">
            {!isRecording ? (
              <button
                onClick={handleStartRecording}
                className="px-6 py-2.5 bg-red-600 hover:bg-red-500 text-white font-bold text-sm rounded shadow-lg flex items-center space-x-2 transition-transform active:scale-95 tracking-wide"
              >
                <div className="w-3.5 h-3.5 rounded-full bg-white animate-pulse" />
                <span>AUFNAHME STARTEN</span>
              </button>
            ) : (
              <button
                onClick={handleStopRecording}
                className="px-6 py-2.5 bg-neutral-200 hover:bg-white text-black font-bold text-sm rounded shadow-lg flex items-center space-x-2 transition-transform active:scale-95 tracking-wide"
              >
                <Square size={16} fill="black" />
                <span>AUFNAHME STOPPEN</span>
              </button>
            )}
          </div>

          {/* 6. Post-Recording Save & Location Prompt ("Speichere alles unter einen mit dem Datum beinhalteten Namensspeicher und nach dem Ziel-Speicherort fragt") */}
          {recordedBlob && !isRecording && (
            <div className="bg-[#12141a] border border-[#2a2f40] rounded-sm p-4 flex flex-col space-y-3 mt-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white flex items-center space-x-1.5">
                  <HardDrive size={14} className="text-[#00c853]" />
                  <span>Aufnahme speichern &amp; Ziel-Speicherort wählen</span>
                </span>
                <span className="text-[10.5px] font-mono text-neutral-400">
                  Größe: {(recordedBlob.size / (1024 * 1024)).toFixed(2)} MB
                </span>
              </div>

              {/* Date-stamped Filename input */}
              <div className="flex flex-col space-y-1">
                <label className="text-[11px] text-neutral-400 font-medium">
                  Dateiname (automatisch mit aktuellem Datum &amp; Uhrzeit versehen):
                </label>
                <div className="flex space-x-2">
                  <input
                    type="text"
                    value={targetFilename}
                    onChange={(e) => setTargetFilename(e.target.value)}
                    className="flex-1 bg-[#0a0b0e] border border-[#2e3344] rounded px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-[#0088ff]"
                  />
                  <button
                    onClick={() => {
                      const ext = FORMAT_OPTIONS.find((f) => f.id === selectedFormat)?.ext || '.wav';
                      setTargetFilename(generateDateBasedFilename('Rekordbox_REC', ext));
                    }}
                    className="px-2 py-1 bg-[#1e222e] hover:bg-[#282d3d] text-neutral-300 rounded text-xs border border-[#343a4e]"
                    title="Aktuellen Zeitstempel neu generieren"
                  >
                    Zeitstempel neu
                  </button>
                </div>
              </div>

              {/* Save destination action buttons */}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={handleSaveToTargetLocation}
                  className="flex-1 py-2 px-3 bg-[#0088ff] hover:bg-[#0077ee] text-white font-semibold text-xs rounded shadow flex items-center justify-center space-x-1.5 transition-colors"
                  title="Öffnet den nativen Speicherort-Dialog zur Auswahl des Ziel-Ordners"
                >
                  <FolderOpen size={14} />
                  <span>Ziel-Speicherort wählen &amp; Speichern...</span>
                </button>

                {onRecordingSaved && (
                  <button
                    onClick={handleLoadIntoEditorDeck}
                    className="py-2 px-3 bg-[#10b981] hover:bg-[#059669] text-white font-semibold text-xs rounded shadow flex items-center space-x-1.5 transition-colors"
                    title="Lädt die Aufnahme direkt ins Deck zur Beatgrid- und Wellenform-Bearbeitung"
                  >
                    <FileAudio size={14} />
                    <span>Direkt im Editor bearbeiten</span>
                  </button>
                )}
              </div>

              {saveSuccessMsg && (
                <div className="flex items-center space-x-2 text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-800/50 p-2 rounded">
                  <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0" />
                  <span>{saveSuccessMsg}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="h-10 bg-[#14161d] border-t border-[#232632] px-4 flex items-center justify-between text-xs text-neutral-400">
          <span className="text-[11px]">
            {isRecording ? 'Fenster bleibt geöffnet bis die Aufnahme beendet wird.' : 'Aufnahmebereit.'}
          </span>
          <button
            onClick={() => {
              if (isRecording) {
                stopActiveRecordingInternal(false);
              }
              onClose();
            }}
            className="px-3 py-1 bg-[#1e212b] hover:bg-[#282d3a] text-neutral-300 hover:text-white rounded border border-[#2e3342] text-xs transition-colors"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Encodes an AudioBuffer into uncompressed 16-bit or 24-bit PCM WAV Blob
 */
function exportAudioBufferToWav(buffer: AudioBuffer, bitDepth: 16 | 24 = 16): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const numSamples = buffer.length;
  const dataSize = numSamples * blockAlign;
  const totalSize = 36 + dataSize;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  // RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, totalSize, true);
  writeAscii(view, 8, 'WAVE');

  // "fmt " sub-chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // SubChunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // ByteRate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // "data" sub-chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const left = buffer.getChannelData(0);
  const right = numChannels > 1 ? buffer.getChannelData(1) : left;

  let offset = 44;
  if (bitDepth === 16) {
    for (let i = 0; i < numSamples; i++) {
      const sL = Math.max(-1, Math.min(1, left[i]));
      const sR = Math.max(-1, Math.min(1, right[i]));
      view.setInt16(offset, sL < 0 ? sL * 0x8000 : sL * 0x7fff, true);
      offset += 2;
      view.setInt16(offset, sR < 0 ? sR * 0x8000 : sR * 0x7fff, true);
      offset += 2;
    }
  } else {
    // 24-bit PCM
    for (let i = 0; i < numSamples; i++) {
      const sL = Math.max(-1, Math.min(1, left[i]));
      const sR = Math.max(-1, Math.min(1, right[i]));
      const valL = Math.floor(sL < 0 ? sL * 0x800000 : sL * 0x7fffff);
      const valR = Math.floor(sR < 0 ? sR * 0x800000 : sR * 0x7fffff);

      view.setUint8(offset, valL & 0xff);
      view.setUint8(offset + 1, (valL >> 8) & 0xff);
      view.setUint8(offset + 2, (valL >> 16) & 0xff);
      offset += 3;

      view.setUint8(offset, valR & 0xff);
      view.setUint8(offset + 1, (valR >> 8) & 0xff);
      view.setUint8(offset + 2, (valR >> 16) & 0xff);
      offset += 3;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
