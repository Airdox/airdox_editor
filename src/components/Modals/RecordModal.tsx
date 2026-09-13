/**
 * @license
 * Rekordbox DJ Record Pop-up Window (RecordModal)
 * 
 * Professional Pioneer DJ hardware-style recording studio interface:
 * - Live stereo VU-Meters (L/R) with dBFS scale & Clip Indicators
 * - Limiter Gain Reduction (GR) Meter
 * - Real-time scrolling oscilloscope canvas
 * - Precision digital studio clock (00:00:00.00)
 * - Auto-Record detection on signal threshold (with 1.0s pre-roll buffer) or Rekordbox playback
 * - Input Gain (-12 to +18 dB) & Brickwall Limiter threshold controls
 * - Multi-source audio routing (Internal Deck, USB Interface/Mixer, System Loopback)
 * - Output format selection (24-bit / 16-bit Studio WAV, WebM 320k)
 * - Live Cue/Drop marker placement
 * - Seamless take export and "Load to Deck" integration
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Mic,
  Radio,
  Sliders,
  Volume2,
  ShieldCheck,
  Flag,
  Download,
  UploadCloud,
  CheckCircle2,
  Play,
  Pause,
  Square,
  RefreshCw,
  Sparkles,
  Layers,
  Settings2,
  HardDrive,
  Info,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import {
  recordingEngine,
  RecordingState,
  RecordingMeters,
  RecordingSettings,
  RecordingSource,
  OutputFormat,
  RecordingResult,
} from '../../audio/recordingEngine';
import { logger } from '../../utils/logger';

interface RecordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadRecordingIntoDeck?: (buffer: AudioBuffer, title: string) => void;
  onSaveAsClip?: (buffer: AudioBuffer, name: string) => void;
}

export const RecordModal: React.FC<RecordModalProps> = ({
  isOpen,
  onClose,
  onLoadRecordingIntoDeck,
  onSaveAsClip,
}) => {
  const [state, setState] = useState<RecordingState>(recordingEngine.getState());
  const [settings, setSettings] = useState<RecordingSettings>(recordingEngine.getSettings());
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [meters, setMeters] = useState<RecordingMeters>({
    peakL: 0,
    peakR: 0,
    peakDbL: -96,
    peakDbR: -96,
    clipL: false,
    clipR: false,
    gainReductionDb: 0,
    waveformSamples: new Float32Array(256),
  });
  const [audioDevices, setAudioDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [lastTake, setLastTake] = useState<RecordingResult | null>(recordingEngine.getLastResult());
  const [activeTab, setActiveTab] = useState<'RECORD' | 'SETTINGS' | 'TAKE'>('RECORD');
  const [autoTriggerNotice, setAutoTriggerNotice] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timerRef = useRef<any>(null);

  // Enumerate hardware devices on mount or when opening
  useEffect(() => {
    if (!isOpen) return;

    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          const audioInputs = devices
            .filter((d) => d.kind === 'audioinput')
            .map((d, index) => ({
              deviceId: d.deviceId,
              label: d.label || `Audioeingang #${index + 1}`,
            }));
          setAudioDevices(audioInputs);
          logger.debug('RECORDING', `Gefundene Audio-Eingabegeräte: ${audioInputs.length}`, audioInputs, 'DeviceEnum');
        })
        .catch((err) => {
          logger.warn('RECORDING', 'Audioeingänge konnten nicht ermittelt werden', err, 'DeviceEnum');
        });
    }

    // Subscribe to recording engine events
    const unsubState = recordingEngine.subscribeState((newState) => {
      setState(newState);
      if (newState === 'STOPPED') {
        const take = recordingEngine.getLastResult();
        setLastTake(take);
        if (take) setActiveTab('TAKE');
      }
    });

    const unsubMeters = recordingEngine.subscribeMeters((newMeters) => {
      setMeters(newMeters);
      drawWaveform(newMeters.waveformSamples);
    });

    const unsubAuto = recordingEngine.subscribeAutoTrigger((reason) => {
      setAutoTriggerNotice(reason);
      setTimeout(() => setAutoTriggerNotice(null), 4000);
    });

    // High resolution clock timer
    timerRef.current = setInterval(() => {
      setElapsedSec(recordingEngine.getElapsedSeconds());
    }, 100);

    return () => {
      unsubState();
      unsubMeters();
      unsubAuto();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isOpen]);

  // Real-time oscilloscope / waveform drawing
  const drawWaveform = (samples: Float32Array) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Dark grid background
    ctx.fillStyle = '#080a0f';
    ctx.fillRect(0, 0, width, height);

    // Center baseline
    ctx.strokeStyle = '#1a2233';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Waveform line with neon cyan/emerald gradient
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#00e5ff');
    gradient.addColorStop(0.5, '#00ffa3');
    gradient.addColorStop(1, '#00a2ff');

    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2;
    ctx.beginPath();

    const sliceWidth = width / samples.length;
    let x = 0;

    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      const y = (height / 2) + v * (height / 2) * 0.9;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.stroke();
  };

  const handleUpdateSetting = <K extends keyof RecordingSettings>(
    key: K,
    val: RecordingSettings[K]
  ) => {
    const updated = { ...settings, [key]: val };
    setSettings(updated);
    recordingEngine.updateSettings({ [key]: val });
  };

  const handleSourceChange = async (src: RecordingSource) => {
    handleUpdateSetting('source', src);
    try {
      await recordingEngine.setupPipeline();
    } catch (err: any) {
      logger.error('RECORDING', `Quelle konnte nicht umgestellt werden: ${err.message}`, err);
    }
  };

  const handleStartManualRecord = async () => {
    try {
      await recordingEngine.startRecording('Manuell gestartet');
    } catch (err: any) {
      alert(`Fehler beim Starten der Aufnahme: ${err?.message || err}`);
    }
  };

  const handleArmAutoRecord = async () => {
    try {
      await recordingEngine.setupPipeline();
      recordingEngine.armAutoRecord();
    } catch (err: any) {
      alert(`Fehler beim Scharfschalten: ${err?.message || err}`);
    }
  };

  const handleDisarmAutoRecord = () => {
    recordingEngine.disarmAutoRecord();
  };

  const handlePauseRecord = () => {
    recordingEngine.pauseRecording();
  };

  const handleResumeRecord = () => {
    recordingEngine.resumeRecording();
  };

  const handleStopRecord = () => {
    const res = recordingEngine.stopRecording();
    if (res) {
      setLastTake(res);
      setActiveTab('TAKE');
    }
  };

  const handleAddMarker = () => {
    recordingEngine.addMarker();
  };

  const handleLoadToDeck = () => {
    if (lastTake && onLoadRecordingIntoDeck) {
      onLoadRecordingIntoDeck(lastTake.audioBuffer, lastTake.fileName.replace('.wav', ''));
      logger.info('RECORDING', `Aufnahme "${lastTake.fileName}" in Deck-Editor geladen`, null, 'DeckIntegration');
      onClose();
    }
  };

  const handleSaveAsPaletteClip = () => {
    if (lastTake && onSaveAsClip) {
      onSaveAsClip(lastTake.audioBuffer, lastTake.fileName.replace('.wav', ''));
      logger.info('RECORDING', `Aufnahme "${lastTake.fileName}" in Clip-Palette Deck B gespeichert`, null, 'DeckIntegration');
      onClose();
    }
  };

  const handleDownload = () => {
    recordingEngine.downloadTake();
  };

  // Format elapsed time string 00:00:00.00
  const formatTimer = (sec: number) => {
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 100);
    return `${hrs > 0 ? hrs.toString().padStart(2, '0') + ':' : ''}${mins
      .toString()
      .padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-center justify-center p-3 select-none animate-in fade-in duration-150">
      <div className="w-full max-w-4xl bg-[#0d0f14] border border-[#232738] rounded-xs shadow-2xl flex flex-col overflow-hidden text-neutral-200 text-xs">
        {/* Header Bar */}
        <div className="h-11 bg-[#12151f] border-b border-[#232738] px-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2">
              <div className="w-3 h-3 rounded-full bg-red-600 flex items-center justify-center">
                <div className={`w-1.5 h-1.5 rounded-full ${state === 'RECORDING' ? 'bg-white animate-ping' : 'bg-red-200'}`} />
              </div>
              <span className="font-extrabold text-white text-xs tracking-wider uppercase">
                Pioneer Rekordbox Master REC
              </span>
            </div>

            {/* State Pill */}
            <div className={`px-2.5 py-0.5 rounded text-[10.5px] font-mono font-bold flex items-center space-x-1.5 border ${
              state === 'RECORDING'
                ? 'bg-red-500/20 border-red-500/50 text-red-300'
                : state === 'ARMED'
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                : state === 'PAUSED'
                ? 'bg-yellow-500/20 border-yellow-500/50 text-yellow-300'
                : 'bg-neutral-800 border-neutral-700 text-neutral-400'
            }`}>
              <span className={`w-2 h-2 rounded-full ${
                state === 'RECORDING'
                  ? 'bg-red-500 animate-pulse'
                  : state === 'ARMED'
                  ? 'bg-amber-400 animate-ping'
                  : state === 'PAUSED'
                  ? 'bg-yellow-400'
                  : 'bg-neutral-500'
              }`} />
              <span>
                {state === 'RECORDING'
                  ? 'AUFNAHME LÄUFT (LIVE)'
                  : state === 'ARMED'
                  ? 'AUTO-RECORD SCHARF (WARTE AUF SIGNAL)'
                  : state === 'PAUSED'
                  ? 'AUFNAHME PAUSIERT'
                  : state === 'STOPPED'
                  ? 'FERTIGGESTELLT'
                  : 'BEREIT (IDLE)'}
              </span>
            </div>

            {autoTriggerNotice && (
              <span className="text-[10px] text-emerald-400 bg-emerald-950/60 border border-emerald-500/40 px-2 py-0.5 rounded font-mono animate-pulse">
                ⚡ {autoTriggerNotice}
              </span>
            )}
          </div>

          <div className="flex items-center space-x-2">
            {/* View Tabs */}
            <div className="flex items-center bg-[#090b10] p-0.5 rounded border border-[#232738]">
              <button
                onClick={() => setActiveTab('RECORD')}
                className={`px-2.5 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                  activeTab === 'RECORD'
                    ? 'bg-[#1b2030] text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Aufnahme
              </button>
              <button
                onClick={() => setActiveTab('SETTINGS')}
                className={`px-2.5 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                  activeTab === 'SETTINGS'
                    ? 'bg-[#1b2030] text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Einstellungen
              </button>
              {lastTake && (
                <button
                  onClick={() => setActiveTab('TAKE')}
                  className={`px-2.5 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                    activeTab === 'TAKE'
                      ? 'bg-[#1b2030] text-white'
                      : 'text-emerald-400 hover:text-emerald-300'
                  }`}
                >
                  Letzter Take
                </button>
              )}
            </div>

            <button
              onClick={onClose}
              className="p-1 hover:text-white text-neutral-400 hover:bg-[#1f2436] rounded transition-colors"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Modal Main Body */}
        <div className="p-4 flex flex-col space-y-4 max-h-[82vh] overflow-y-auto">
          {activeTab === 'RECORD' && (
            <>
              {/* Main Visual Display Block: Clock, Meters & Oscilloscope */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-[#08090d] border border-[#1b1f2d] p-3.5 rounded-xs">
                {/* Digital Clock & Format Info */}
                <div className="flex flex-col justify-between border-b md:border-b-0 md:border-r border-[#1b1f2d] pr-3 pb-3 md:pb-0">
                  <div>
                    <div className="text-[10px] text-neutral-500 uppercase tracking-widest font-mono">
                      Aufnahmezeit
                    </div>
                    <div className="text-3xl lg:text-4xl font-mono font-black text-white tracking-wider my-1 tabular-nums">
                      {formatTimer(elapsedSec)}
                    </div>
                    <div className="flex items-center space-x-2 text-[10.5px] text-neutral-400 font-mono">
                      <span className="px-1.5 py-0.2 rounded bg-blue-950/60 border border-blue-600/40 text-blue-300">
                        {settings.sampleRate / 1000} kHz
                      </span>
                      <span className="px-1.5 py-0.2 rounded bg-purple-950/60 border border-purple-600/40 text-purple-300">
                        {settings.outputFormat.replace('_', ' ')}
                      </span>
                      {settings.limiterEnabled && (
                        <span className="px-1.5 py-0.2 rounded bg-emerald-950/60 border border-emerald-600/40 text-emerald-300">
                          LIMITER AKTIV
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Marker Counter */}
                  <div className="mt-3 pt-2 border-t border-[#1a1d2b] flex items-center justify-between text-[11px] text-neutral-400">
                    <span>Gesetzte Cue-Marker:</span>
                    <span className="font-mono font-bold text-white bg-[#141824] px-2 py-0.5 rounded">
                      {recordingEngine.getMarkers().length}
                    </span>
                  </div>
                </div>

                {/* Oscilloscope Canvas */}
                <div className="flex flex-col justify-between">
                  <div className="flex items-center justify-between text-[10px] text-neutral-500 font-mono mb-1">
                    <span>LIVE-OSZILLOSKOP / SIGNAL</span>
                    <span className="text-[#00ffa3]">ECHTZEIT-ANALYSIS</span>
                  </div>
                  <canvas
                    ref={canvasRef}
                    width={280}
                    height={85}
                    className="w-full h-22 rounded bg-[#06070a] border border-[#171b26]"
                  />
                  <div className="text-[9.5px] text-neutral-500 font-mono mt-1 text-center truncate">
                    Quelle: {settings.source === 'INTERNAL_DECK' ? 'Rekordbox Master-Deck' : settings.source === 'HARDWARE_INPUT' ? 'Hardware Line-In / Mixer' : 'System Loopback'}
                  </div>
                </div>

                {/* Stereo VU Peak & RMS Meters */}
                <div className="flex flex-col justify-between border-t md:border-t-0 md:border-l border-[#1b1f2d] pl-0 md:pl-3 pt-3 md:pt-0">
                  <div className="flex items-center justify-between text-[10px] text-neutral-500 font-mono mb-1">
                    <span>STEREO LEVEL PEAK (dBFS)</span>
                    <div className="flex items-center space-x-1 font-bold">
                      <span className={`px-1 rounded text-[9px] ${meters.clipL ? 'bg-red-600 text-white animate-pulse' : 'bg-[#151722] text-neutral-600'}`}>
                        CLIP L
                      </span>
                      <span className={`px-1 rounded text-[9px] ${meters.clipR ? 'bg-red-600 text-white animate-pulse' : 'bg-[#151722] text-neutral-600'}`}>
                        CLIP R
                      </span>
                    </div>
                  </div>

                  {/* Dual Meters */}
                  <div className="space-y-1.5 my-auto">
                    {/* Left Channel */}
                    <div>
                      <div className="flex items-center justify-between text-[9px] text-neutral-400 font-mono mb-0.5">
                        <span>CH L</span>
                        <span>{meters.peakDbL.toFixed(1)} dBFS</span>
                      </div>
                      <div className="w-full h-3 bg-[#11131c] rounded-xs overflow-hidden flex border border-[#1e2333]">
                        <div
                          className={`h-full transition-all duration-75 ${
                            meters.peakDbL >= -0.5
                              ? 'bg-red-500'
                              : meters.peakDbL >= -6
                              ? 'bg-amber-400'
                              : 'bg-[#00ffa3]'
                          }`}
                          style={{ width: `${Math.max(0, Math.min(100, (meters.peakDbL + 60) * 1.66))}%` }}
                        />
                      </div>
                    </div>

                    {/* Right Channel */}
                    <div>
                      <div className="flex items-center justify-between text-[9px] text-neutral-400 font-mono mb-0.5">
                        <span>CH R</span>
                        <span>{meters.peakDbR.toFixed(1)} dBFS</span>
                      </div>
                      <div className="w-full h-3 bg-[#11131c] rounded-xs overflow-hidden flex border border-[#1e2333]">
                        <div
                          className={`h-full transition-all duration-75 ${
                            meters.peakDbR >= -0.5
                              ? 'bg-red-500'
                              : meters.peakDbR >= -6
                              ? 'bg-amber-400'
                              : 'bg-[#00ffa3]'
                          }`}
                          style={{ width: `${Math.max(0, Math.min(100, (meters.peakDbR + 60) * 1.66))}%` }}
                        />
                      </div>
                    </div>

                    {/* Limiter Gain Reduction */}
                    {settings.limiterEnabled && (
                      <div className="pt-1">
                        <div className="flex items-center justify-between text-[9px] text-amber-400/90 font-mono mb-0.5">
                          <span>LIMITER GR (REDUCTION)</span>
                          <span>-{meters.gainReductionDb.toFixed(1)} dB</span>
                        </div>
                        <div className="w-full h-1.5 bg-[#11131c] rounded-xs overflow-hidden flex border border-[#2b2210]">
                          <div
                            className="h-full bg-amber-500 transition-all duration-75"
                            style={{ width: `${Math.min(100, meters.gainReductionDb * 10)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="text-[9px] text-neutral-500 flex justify-between font-mono mt-1">
                    <span>-60 dB</span>
                    <span>-18</span>
                    <span>-6</span>
                    <span>0 dB</span>
                    <span className="text-red-400">+3</span>
                  </div>
                </div>
              </div>

              {/* Main Transport Controls */}
              <div className="bg-[#11141d] border border-[#202537] p-3.5 rounded-xs flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center space-x-2">
                  {/* Record Button */}
                  {state !== 'RECORDING' && state !== 'PAUSED' ? (
                    <button
                      onClick={handleStartManualRecord}
                      className="px-5 py-2.5 bg-red-600 hover:bg-red-500 active:bg-red-700 text-white font-bold rounded-xs flex items-center space-x-2 shadow-lg shadow-red-950/60 transition-colors"
                    >
                      <div className="w-3 h-3 rounded-full bg-white animate-pulse" />
                      <span className="text-xs uppercase tracking-wide">Aufnahme starten</span>
                    </button>
                  ) : state === 'PAUSED' ? (
                    <button
                      onClick={handleResumeRecord}
                      className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xs flex items-center space-x-2 transition-colors"
                    >
                      <Play size={14} />
                      <span className="text-xs uppercase tracking-wide">Fortsetzen</span>
                    </button>
                  ) : (
                    <button
                      onClick={handlePauseRecord}
                      className="px-4 py-2.5 bg-amber-600/80 hover:bg-amber-600 text-white font-bold rounded-xs flex items-center space-x-2 transition-colors"
                    >
                      <Pause size={14} />
                      <span className="text-xs uppercase tracking-wide">Pause</span>
                    </button>
                  )}

                  {/* Stop Button */}
                  {(state === 'RECORDING' || state === 'PAUSED') && (
                    <button
                      onClick={handleStopRecord}
                      className="px-5 py-2.5 bg-[#252a3d] hover:bg-[#323852] border border-[#3b4363] text-white font-bold rounded-xs flex items-center space-x-2 transition-colors"
                    >
                      <Square size={13} className="text-red-400 fill-red-400" />
                      <span className="text-xs uppercase tracking-wide">Stopp &amp; Speichern</span>
                    </button>
                  )}

                  {/* Live Marker Button */}
                  {(state === 'RECORDING' || state === 'PAUSED') && (
                    <button
                      onClick={handleAddMarker}
                      className="px-3.5 py-2.5 bg-[#1b2030] hover:bg-[#252c42] border border-[#2b334d] text-[#00ffa3] font-semibold rounded-xs flex items-center space-x-1.5 transition-colors"
                      title="Setzt einen Cue/Drop-Marker mit exaktem Zeitstempel"
                    >
                      <Flag size={13} />
                      <span className="text-xs">Marker +</span>
                    </button>
                  )}
                </div>

                {/* Smart Auto-Record Switcher */}
                <div className="flex items-center space-x-3 bg-[#0a0c12] px-3 py-2 rounded border border-[#1e2333]">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-white flex items-center space-x-1.5">
                      <Radio size={13} className={state === 'ARMED' ? 'text-amber-400 animate-spin' : 'text-neutral-400'} />
                      <span>Auto-Record bei Signal-Erkennung</span>
                    </span>
                    <span className="text-[10px] text-neutral-400">
                      Startet automatisch bei Rekordbox-Wiedergabe oder Pegel &gt; {settings.autoRecordThresholdDb} dBFS
                    </span>
                  </div>

                  {state === 'ARMED' ? (
                    <button
                      onClick={handleDisarmAutoRecord}
                      className="px-3 py-1 bg-amber-500 text-black font-bold text-[11px] rounded-xs hover:bg-amber-400 transition-colors"
                    >
                      Entschärfen
                    </button>
                  ) : (
                    <button
                      onClick={handleArmAutoRecord}
                      disabled={state === 'RECORDING'}
                      className="px-3 py-1 bg-[#1a2030] hover:bg-[#232b40] border border-[#2f3954] text-neutral-200 font-bold text-[11px] rounded-xs transition-colors disabled:opacity-40"
                    >
                      Scharfschalten
                    </button>
                  )}
                </div>
              </div>

              {/* Quick Input Gain & Limiter Bar */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 bg-[#0d1017] border border-[#1c202d] p-3 rounded-xs">
                {/* Input Level Slider */}
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="font-semibold text-neutral-300 flex items-center space-x-1">
                      <Volume2 size={13} className="text-blue-400" />
                      <span>Level Input Gain</span>
                    </span>
                    <span className="font-mono text-white bg-[#151824] px-2 py-0.2 rounded border border-[#232738]">
                      {settings.inputGainDb > 0 ? `+${settings.inputGainDb}` : settings.inputGainDb} dB
                    </span>
                  </div>
                  <input
                    type="range"
                    min="-12"
                    max="18"
                    step="0.5"
                    value={settings.inputGainDb}
                    onChange={(e) => handleUpdateSetting('inputGainDb', parseFloat(e.target.value))}
                    className="w-full accent-[#0088ff] cursor-pointer"
                  />
                  <div className="flex justify-between text-[9px] text-neutral-500 font-mono mt-0.5">
                    <span>-12 dB</span>
                    <button
                      onClick={() => handleUpdateSetting('inputGainDb', 0)}
                      className="hover:text-white"
                    >
                      Reset (0 dB)
                    </button>
                    <span>+18 dB</span>
                  </div>
                </div>

                {/* Input Limiter Quick Toggle */}
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="font-semibold text-neutral-300 flex items-center space-x-1">
                      <ShieldCheck size={13} className="text-emerald-400" />
                      <span>Studio Peak Limiter</span>
                    </span>
                    <label className="flex items-center space-x-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={settings.limiterEnabled}
                        onChange={(e) => handleUpdateSetting('limiterEnabled', e.target.checked)}
                        className="rounded border-[#292f44] text-[#00c853] focus:ring-0"
                      />
                      <span className="text-[10px] text-neutral-400">Aktiv</span>
                    </label>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    {[-0.1, -0.5, -1.0, -3.0].map((th) => (
                      <button
                        key={th}
                        onClick={() => handleUpdateSetting('limiterThresholdDb', th)}
                        className={`flex-1 py-1 rounded text-[10px] font-mono transition-colors border ${
                          settings.limiterThresholdDb === th
                            ? 'bg-[#00c853]/20 border-[#00c853] text-[#34d399] font-bold'
                            : 'bg-[#141722] border-[#222738] text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {th} dBFS
                      </button>
                    ))}
                  </div>
                  <div className="text-[9px] text-neutral-500 mt-1">
                    Verhindert digitales Übersteuern mit ultraschnellem Lookahead-Compressor (20:1 Ratio)
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Settings Tab */}
          {activeTab === 'SETTINGS' && (
            <div className="space-y-4">
              {/* Audio Routing & Input Source */}
              <div className="bg-[#0f1118] border border-[#202537] p-3.5 rounded-xs space-y-3">
                <div className="text-xs font-bold text-white uppercase tracking-wide flex items-center space-x-1.5">
                  <Mic size={14} className="text-[#0088ff]" />
                  <span>Audio-Eingangsquelle &amp; Hardware-Routing</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <button
                    onClick={() => handleSourceChange('INTERNAL_DECK')}
                    className={`p-3 rounded-xs border text-left flex flex-col justify-between transition-colors ${
                      settings.source === 'INTERNAL_DECK'
                        ? 'bg-[#0088ff]/15 border-[#0088ff] text-white'
                        : 'bg-[#131622] border-[#222738] text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-xs text-white">Interner Rekordbox-Bus</span>
                      <Layers size={14} className="text-[#00a2ff]" />
                    </div>
                    <span className="text-[10px] text-neutral-400">
                      Nimmt die direkte Wiedergabe aus dem Airdox/Rekordbox-Deck in Studioqualität ab.
                    </span>
                  </button>

                  <button
                    onClick={() => handleSourceChange('HARDWARE_INPUT')}
                    className={`p-3 rounded-xs border text-left flex flex-col justify-between transition-colors ${
                      settings.source === 'HARDWARE_INPUT'
                        ? 'bg-[#0088ff]/15 border-[#0088ff] text-white'
                        : 'bg-[#131622] border-[#222738] text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-xs text-white">Hardware Audio-Interface</span>
                      <Sliders size={14} className="text-[#00ffa3]" />
                    </div>
                    <span className="text-[10px] text-neutral-400">
                      Line-In, DJ-Mixer (Pioneer DJM, USB-Audio), Audio-Interface oder Mikrofon.
                    </span>
                  </button>

                  <button
                    onClick={() => handleSourceChange('SYSTEM_LOOPBACK')}
                    className={`p-3 rounded-xs border text-left flex flex-col justify-between transition-colors ${
                      settings.source === 'SYSTEM_LOOPBACK'
                        ? 'bg-[#0088ff]/15 border-[#0088ff] text-white'
                        : 'bg-[#131622] border-[#222738] text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-xs text-white">System-Audio Loopback</span>
                      <HardDrive size={14} className="text-purple-400" />
                    </div>
                    <span className="text-[10px] text-neutral-400">
                      Greift den Gesamtsound des Desktops / der laufenden Rekordbox Desktop-App ab.
                    </span>
                  </button>
                </div>

                {/* Device Selector when HARDWARE_INPUT is chosen */}
                {settings.source === 'HARDWARE_INPUT' && (
                  <div className="pt-2 border-t border-[#1b2030] flex flex-col space-y-1">
                    <label className="text-[11px] text-neutral-400">
                      Eingabegerät auswählen:
                    </label>
                    <select
                      value={settings.deviceId || ''}
                      onChange={(e) => handleUpdateSetting('deviceId', e.target.value)}
                      className="bg-[#161a26] border border-[#272e42] rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#0088ff]"
                    >
                      <option value="">Standard-Eingang (Default Audio Interface)</option>
                      {audioDevices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Output Format & Quality Settings */}
              <div className="bg-[#0f1118] border border-[#202537] p-3.5 rounded-xs space-y-3">
                <div className="text-xs font-bold text-white uppercase tracking-wide flex items-center space-x-1.5">
                  <Settings2 size={14} className="text-purple-400" />
                  <span>Ausgabeformat &amp; Aufnahmequalität</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Format Selector */}
                  <div>
                    <label className="text-[11px] text-neutral-400 block mb-1">
                      Dateiformat:
                    </label>
                    <div className="space-y-1.5">
                      {[
                        { id: 'WAV_24', title: 'WAV 24-Bit PCM (Studio Master)', desc: 'Unkomprimiert, maximale Dynamik für Rekordbox' },
                        { id: 'WAV_16', title: 'WAV 16-Bit PCM (CD Standard)', desc: 'Standard Red Book Audio, kompatibel mit allen CDJs' },
                        { id: 'WEBM_320', title: 'WebM / Opus 320 kbps', desc: 'Sehr hohe Qualität bei reduzierter Dateigröße' },
                      ].map((fmt) => (
                        <button
                          key={fmt.id}
                          onClick={() => handleUpdateSetting('outputFormat', fmt.id as OutputFormat)}
                          className={`w-full p-2 rounded text-left border flex flex-col transition-colors ${
                            settings.outputFormat === fmt.id
                              ? 'bg-purple-950/40 border-purple-500 text-purple-200'
                              : 'bg-[#141724] border-[#222738] text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          <span className="text-xs font-bold text-white">{fmt.title}</span>
                          <span className="text-[10px] text-neutral-400">{fmt.desc}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Sample Rate & Silence Detector */}
                  <div className="space-y-3">
                    <div>
                      <label className="text-[11px] text-neutral-400 block mb-1">
                        Abtastrate (Samplerate):
                      </label>
                      <div className="flex items-center space-x-2">
                        {[48000, 44100].map((rate) => (
                          <button
                            key={rate}
                            onClick={() => handleUpdateSetting('sampleRate', rate as 44100 | 48000)}
                            className={`flex-1 py-1.5 rounded text-xs font-mono font-bold border transition-colors ${
                              settings.sampleRate === rate
                                ? 'bg-blue-600 border-blue-400 text-white'
                                : 'bg-[#141724] border-[#222738] text-neutral-400 hover:text-neutral-200'
                            }`}
                          >
                            {rate / 1000} kHz {rate === 48000 ? '(Pioneer DJ Standard)' : '(CD)'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="text-[11px] text-neutral-400 block mb-1">
                        Auto-Stop bei Stille nach Set-Ende:
                      </label>
                      <select
                        value={settings.autoStopSilenceSec}
                        onChange={(e) => handleUpdateSetting('autoStopSilenceSec', parseInt(e.target.value, 10))}
                        className="w-full bg-[#161a26] border border-[#272e42] rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#0088ff]"
                      >
                        <option value="0">Deaktiviert (Nur manuell stoppen)</option>
                        <option value="3">Nach 3 Sekunden Stille</option>
                        <option value="5">Nach 5 Sekunden Stille (Empfohlen)</option>
                        <option value="10">Nach 10 Sekunden Stille</option>
                        <option value="15">Nach 15 Sekunden Stille</option>
                      </select>
                    </div>

                    {/* Auto-Record Automation Rules */}
                    <div className="pt-2 border-t border-[#1e2333] space-y-2">
                      <div className="text-[11px] font-bold text-white flex items-center space-x-1.5">
                        <Radio size={13} className="text-[#00ffa3]" />
                        <span>Automatische Wiedergabe-Erkennung (Rekordbox)</span>
                      </div>

                      <label className="flex items-center space-x-2 cursor-pointer text-[11px] text-neutral-300">
                        <input
                          type="checkbox"
                          checked={settings.autoRecordOnPlayback}
                          onChange={(e) => handleUpdateSetting('autoRecordOnPlayback', e.target.checked)}
                          className="rounded border-[#292f44] text-red-500 focus:ring-0"
                        />
                        <span>Sofort aufnehmen, sobald ein Track in Rekordbox abgespielt wird</span>
                      </label>

                      <label className="flex items-center space-x-2 cursor-pointer text-[11px] text-neutral-300">
                        <input
                          type="checkbox"
                          checked={settings.autoOpenWindowOnRecord}
                          onChange={(e) => handleUpdateSetting('autoOpenWindowOnRecord', e.target.checked)}
                          className="rounded border-[#292f44] text-[#0088ff] focus:ring-0"
                        />
                        <span>Aufnahme-Fenster bei Start automatisch im Vordergrund öffnen</span>
                      </label>
                    </div>

                    {/* Pre-Roll buffer note */}
                    <div className="p-2 bg-[#121520] border border-[#1e2333] rounded text-[10.5px] text-neutral-400 flex items-start space-x-2">
                      <Info size={14} className="text-[#0088ff] flex-shrink-0 mt-0.5" />
                      <span>
                        <strong>1.0s Pre-Roll Transienten-Ringspeicher:</strong> Bei Scharfschaltung werden die letzten 1.000 Millisekunden vor dem ersten Trigger kontinuierlich im RAM gepuffert, damit der erste Kick-Drum-Schlag vollständig aufgenommen wird.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Last Take Hub Tab */}
          {activeTab === 'TAKE' && lastTake && (
            <div className="bg-[#0e1118] border border-[#1f2436] p-4 rounded-xs space-y-4">
              <div className="flex items-center justify-between border-b border-[#1c2130] pb-3">
                <div className="flex items-center space-x-2">
                  <CheckCircle2 size={18} className="text-emerald-400" />
                  <div>
                    <span className="font-bold text-white text-xs block">
                      Aufnahme erfolgreich abgeschlossen: {lastTake.fileName}
                    </span>
                    <span className="text-[10.5px] text-neutral-400">
                      Dauer: {formatTimer(lastTake.durationSec)} • Dateigröße: {(lastTake.wavBlob.size / 1024 / 1024).toFixed(2)} MB • {lastTake.format.replace('_', ' ')}
                    </span>
                  </div>
                </div>

                <button
                  onClick={handleDownload}
                  className="px-3 py-1.5 bg-[#0088ff] hover:bg-blue-500 text-white rounded text-xs font-semibold flex items-center space-x-1.5 transition-colors shadow-sm"
                >
                  <Download size={13} />
                  <span>WAV Herunterladen</span>
                </button>
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={handleLoadToDeck}
                  className="p-3.5 bg-[#141926] hover:bg-[#1c2336] border border-[#242c42] hover:border-[#0088ff] rounded-xs text-left flex items-start space-x-3 transition-colors group"
                >
                  <div className="w-8 h-8 rounded bg-[#0088ff]/15 border border-[#0088ff]/40 flex items-center justify-center text-[#00a2ff] flex-shrink-0 group-hover:scale-105 transition-transform">
                    <UploadCloud size={16} />
                  </div>
                  <div>
                    <span className="font-bold text-white text-xs block">
                      Direkt ins Rekordbox-Deck laden
                    </span>
                    <span className="text-[10px] text-neutral-400">
                      Lädt diesen Take als aktiven Track in den Waveform-Editor für Beatgrid-Ausrichtung, Cues und Slicing.
                    </span>
                  </div>
                </button>

                <button
                  onClick={handleSaveAsPaletteClip}
                  className="p-3.5 bg-[#141926] hover:bg-[#1c2336] border border-[#242c42] hover:border-[#00ffa3] rounded-xs text-left flex items-start space-x-3 transition-colors group"
                >
                  <div className="w-8 h-8 rounded bg-[#00ffa3]/15 border border-[#00ffa3]/40 flex items-center justify-center text-[#00ffa3] flex-shrink-0 group-hover:scale-105 transition-transform">
                    <Layers size={16} />
                  </div>
                  <div>
                    <span className="font-bold text-white text-xs block">
                      Als Clip in Palette Deck B speichern
                    </span>
                    <span className="text-[10px] text-neutral-400">
                      Speichert den Take in der Clip-Palette für schnelle Overdubs und Drops.
                    </span>
                  </div>
                </button>
              </div>

              {/* Marker List if any */}
              {lastTake.markers.length > 0 && (
                <div className="bg-[#090b10] p-2.5 rounded border border-[#171b26] space-y-1.5">
                  <span className="text-[10px] text-neutral-500 font-mono uppercase block">
                    Gesetzte Live-Marker während des Sets ({lastTake.markers.length}):
                  </span>
                  <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                    {lastTake.markers.map((m) => (
                      <span
                        key={m.id}
                        className="px-2 py-0.5 rounded bg-[#161a27] border border-[#272f44] text-[10.5px] font-mono text-neutral-300 flex items-center space-x-1"
                      >
                        <Flag size={10} className="text-[#00ffa3]" />
                        <span>{m.timeString}</span>
                        <span className="text-neutral-500">•</span>
                        <span className="text-white">{m.label}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer info strip */}
        <div className="h-7 bg-[#10131c] border-t border-[#1e2333] px-4 flex items-center justify-between text-[10px] text-neutral-500">
          <div className="flex items-center space-x-3">
            <span>Pioneer Rekordbox Recording Engine</span>
            <span>•</span>
            <span className="font-mono">Quelle: {settings.source}</span>
          </div>
          <span className="font-mono text-neutral-400">
            {state === 'RECORDING' ? '🔴 REC LAUFEND' : state === 'ARMED' ? '⚡ AUTO-RECORD SCHARF' : 'BEREIT'}
          </span>
        </div>
      </div>
    </div>
  );
};
