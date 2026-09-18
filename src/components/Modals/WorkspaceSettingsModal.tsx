/**
 * @license
 * WorkspaceSettingsModal Component
 * Full configuration panel: Appearance, Audio Recording, Stem Architecture Modes,
 * 5-Minute Reference Benchmarks, Path Configuration, and System Diagnostics.
 */

import React, { useState } from 'react';
import {
  X,
  Settings,
  Info,
  Database,
  Activity,
  Trash2,
  Layout,
  Sliders,
  Waves,
  Cpu,
  CheckCircle2,
  AlertCircle,
  Timer,
  Zap,
  Sparkles,
  HardDrive,
  Folder,
  ChevronDown,
  ChevronUp,
  Download,
} from 'lucide-react';
import { WaveformMode } from '../../types/rekordbox';
import {
  STEM_VALIDATION_MODES,
  deviceChoices,
  modeLabel,
  type StemArchitectureOption,
  type StemArchitectureViewState,
  type WorkspacePathSettings,
} from '../../audio/stemArchitectures';
import type { StemComputeDevice, StemValidationMode } from '../../stems/transportTypes';
import { Tooltip, HelpBadge, GLOSSARY } from '../Tooltip';

export type RecordingSource = 'EDITOR_MASTER' | 'AUDIO_INPUT' | 'SYSTEM_LOOPBACK';
export type RecordingFormat = 'WAV' | 'FLAC' | 'MP3';

interface WorkspaceSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onShowInfo: () => void;
  onOpenDatabaseInspector?: () => void;
  onOpenSystemLogs?: () => void;
  onAutoCue?: () => void;
  onClearHistory?: () => void;
  onOpenRecorder?: () => void;
  onOpenInitialSetup?: () => void;
  waveformMode: WaveformMode;
  onSetWaveformMode: (mode: WaveformMode) => void;
  snapToBeatgrid: boolean;
  onSetSnapToBeatgrid: (val: boolean) => void;
  autoScroll: boolean;
  onSetAutoScroll: (val: boolean) => void;
  highQualityRendering: boolean;
  onSetHighQualityRendering: (val: boolean) => void;
  recordingSource: RecordingSource;
  onSetRecordingSource: (source: RecordingSource) => void;
  recordingFormat: RecordingFormat;
  onSetRecordingFormat: (format: RecordingFormat) => void;
  recordingSampleRate: 44100 | 48000;
  onSetRecordingSampleRate: (rate: 44100 | 48000) => void;
  recordingBitDepth: 16 | 24 | 32;
  onSetRecordingBitDepth: (depth: 16 | 24 | 32) => void;
  recordingChannels: 'STEREO' | 'MONO';
  onSetRecordingChannels: (channels: 'STEREO' | 'MONO') => void;
  recordingLimiter: boolean;
  onSetRecordingLimiter: (value: boolean) => void;
  confirmDestructiveEdits: boolean;
  onSetConfirmDestructiveEdits: (value: boolean) => void;
  autoSaveProject: boolean;
  onSetAutoSaveProject: (value: boolean) => void;
  /** Stem-Architekturen (Katalog + Installationsstatus) für die Auswahl. */
  stemArchitectures: StemArchitectureOption[];
  /** `auto` oder eine Modell-ID – gilt für neue Separationen. */
  stemArchitectureId: string;
  onSetStemArchitectureId: (id: string) => void;
  stemValidationMode: StemValidationMode;
  onSetStemValidationMode: (mode: StemValidationMode) => void;
  stemDevice: StemComputeDevice;
  onSetStemDevice: (device: StemComputeDevice) => void;
  stemEngineState?: StemArchitectureViewState | null;
  stemArchitecturesLoading?: boolean;
  onRefreshStemArchitectures?: () => void;
  workspacePaths?: WorkspacePathSettings;
  onSetWorkspacePaths?: (paths: WorkspacePathSettings) => void;
}

export const WorkspaceSettingsModal: React.FC<WorkspaceSettingsModalProps> = ({
  isOpen,
  onClose,
  onShowInfo,
  onOpenDatabaseInspector,
  onOpenSystemLogs,
  onAutoCue,
  onClearHistory,
  onOpenRecorder,
  onOpenInitialSetup,
  waveformMode,
  onSetWaveformMode,
  snapToBeatgrid,
  onSetSnapToBeatgrid,
  autoScroll,
  onSetAutoScroll,
  highQualityRendering,
  onSetHighQualityRendering,
  recordingSource,
  onSetRecordingSource,
  recordingFormat,
  onSetRecordingFormat,
  recordingSampleRate,
  onSetRecordingSampleRate,
  recordingBitDepth,
  onSetRecordingBitDepth,
  recordingChannels,
  onSetRecordingChannels,
  recordingLimiter,
  onSetRecordingLimiter,
  confirmDestructiveEdits,
  onSetConfirmDestructiveEdits,
  autoSaveProject,
  onSetAutoSaveProject,
  stemArchitectures,
  stemArchitectureId,
  onSetStemArchitectureId,
  stemValidationMode,
  onSetStemValidationMode,
  stemDevice,
  onSetStemDevice,
  stemEngineState,
  stemArchitecturesLoading,
  onRefreshStemArchitectures,
  workspacePaths,
  onSetWorkspacePaths,
}) => {
  const [showBenchmarkComparison, setShowBenchmarkComparison] = useState<boolean>(false);
  const [showPathSettings, setShowPathSettings] = useState<boolean>(false);

  const stemDeviceOptions = deviceChoices(stemEngineState?.onnx);
  const activeDevice = stemDeviceOptions.find((choice) => choice.id === stemDevice);
  const activeArchitecture = stemArchitectures.find((option) => option.id === stemArchitectureId);
  const architectureMissing = Boolean(activeArchitecture && !activeArchitecture.installed);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[100] p-4 select-none animate-in fade-in duration-150">
      <div className="bg-[#12141a] border border-[#272935] rounded-sm shadow-2xl w-full max-w-xl flex flex-col overflow-hidden text-neutral-200 max-h-[85vh]">
        
        {/* Header */}
        <div className="h-10 bg-[#171922] border-b border-[#252834] flex items-center justify-between px-4">
          <div className="flex items-center space-x-2">
            <Settings size={16} className="text-[#0088ff]" />
            <span className="font-bold text-white text-xs tracking-wide">
              Workspace Settings &amp; Engine Configuration
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors"
            title="Einstellungen schließen (Esc)"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-5 overflow-y-auto min-h-0 text-xs">
          
          {/* Section: Appearance & Layout */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-[#1f222d] pb-1">
              <h3 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider flex items-center space-x-1.5">
                <Layout size={12} className="text-[#00a2ff]" />
                <span>Appearance &amp; Display</span>
              </h3>
              <HelpBadge
                title="Wellenform-Visualisierung"
                text="Wählen Sie zwischen 3-Band-Frequenzansicht (Low/Mid/High), RGB-Spektralfarben oder monochromem Pioneer Blue."
              />
            </div>
            
            <div className="bg-[#161820] border border-[#22242d] rounded-xs p-3 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-white">Waveform Color Mode</div>
                <div className="text-[10.5px] text-neutral-500">Wählen Sie das Farbschema für Wellenformen.</div>
              </div>
              <div className="flex space-x-1 bg-[#0f1015] p-1 rounded-xs border border-[#1d1f27]">
                {(['RGB', 'BLUE', '3BAND'] as WaveformMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => onSetWaveformMode(mode)}
                    className={`px-3 py-1 rounded-xs text-[11px] font-bold transition-colors ${
                      waveformMode === mode 
                        ? 'bg-[#2a2d3a] text-white shadow-sm' 
                        : 'text-neutral-500 hover:text-neutral-300'
                    }`}
                    title={
                      mode === 'RGB'
                        ? 'RGB: Bässe (Rot), Mitten (Grün), Höhen (Blau)'
                        : mode === 'BLUE'
                        ? 'BLUE: Klassische monochrome Rekordbox-Ansicht'
                        : '3BAND: Getrennte Frequenzbänder (Bass, Mitten, Höhen)'
                    }
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-[#161820] border border-[#22242d] rounded-xs p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-white">Snap to Beatgrid</div>
                  <div className="text-[10px] text-neutral-500">Auswahl und Playhead exakt am Rekordbox-Taktraster ausrichten.</div>
                </div>
                <label className="flex items-center cursor-pointer" title="Snap to Beatgrid aktivieren/deaktivieren">
                  <input type="checkbox" className="sr-only peer" checked={snapToBeatgrid} onChange={(e) => onSetSnapToBeatgrid(e.target.checked)} />
                  <div className="w-8 h-4 bg-[#0f1015] border border-[#22242d] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-neutral-400 peer-checked:after:bg-[#0088ff] after:border-neutral-500 after:border after:rounded-full after:h-3 after:w-3 after:transition-all"></div>
                </label>
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-white">Auto-Scroll Waveform</div>
                  <div className="text-[10px] text-neutral-500">Playhead während der Wiedergabe automatisch zentrieren.</div>
                </div>
                <label className="flex items-center cursor-pointer" title="Automatisches Mitscrollen bei Playback">
                  <input type="checkbox" className="sr-only peer" checked={autoScroll} onChange={(e) => onSetAutoScroll(e.target.checked)} />
                  <div className="w-8 h-4 bg-[#0f1015] border border-[#22242d] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-neutral-400 peer-checked:after:bg-[#00c853] after:border-neutral-500 after:border after:rounded-full after:h-3 after:w-3 after:transition-all"></div>
                </label>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-white">High Quality Rendering</div>
                  <div className="text-[10px] text-neutral-500">32-Bit Float internes Audio-Mixing &amp; Anti-Aliasing.</div>
                </div>
                <label className="flex items-center cursor-pointer" title="Verlustfreies 32-Bit Float Mixing">
                  <input type="checkbox" className="sr-only peer" checked={highQualityRendering} onChange={(e) => onSetHighQualityRendering(e.target.checked)} />
                  <div className="w-8 h-4 bg-[#0f1015] border border-[#22242d] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-neutral-400 peer-checked:after:bg-[#8b5cf6] after:border-neutral-500 after:border after:rounded-full after:h-3 after:w-3 after:transition-all"></div>
                </label>
              </div>
            </div>
          </div>

          {/* Section: KI Stem-Separation & Architekturen mit Rechenzeiten */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-[#1f222d] pb-1">
              <h3 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider flex items-center space-x-1.5">
                <Cpu size={12} className="text-[#00e5ff]" />
                <span>KI Stem-Separation &amp; Architekturen</span>
              </h3>
              <div className="flex items-center space-x-2">
                {onRefreshStemArchitectures && (
                  <button
                    onClick={onRefreshStemArchitectures}
                    disabled={stemArchitecturesLoading}
                    className="text-[10px] text-[#0088ff] hover:text-[#00c8ff] disabled:opacity-40"
                    title="Installationsstatus der Modelle neu einlesen"
                  >
                    {stemArchitecturesLoading ? 'Prüfe…' : 'Neu prüfen'}
                  </button>
                )}
                <HelpBadge
                  title="KI-Architektur & Rechenzeiten"
                  text={GLOSSARY.BS_ROFORMER + ' ' + GLOSSARY.SDR}
                />
              </div>
            </div>

            <div className="bg-[#161820] border border-[#22242d] rounded-xs p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-white">Architekturmodus für Stem-Separation</div>
                  <div className="text-[10.5px] text-neutral-400">
                    Wählt das KI-Modell für den Deck-Trennen-Button. Inklusive 5-Minuten-Referenzzeiten.
                  </div>
                </div>
                <button
                  onClick={() => setShowBenchmarkComparison(!showBenchmarkComparison)}
                  className="px-2 py-0.5 rounded bg-[#1f2330] hover:bg-[#282d3e] text-[#00c8ff] text-[10px] font-semibold flex items-center space-x-1 border border-[#2f364d]"
                  title="Benchmark- & Rechenzeit-Vergleich für 5-Minuten-Track öffnen"
                >
                  <Timer size={11} />
                  <span>5-Min. Benchmark-Tabelle</span>
                  {showBenchmarkComparison ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                </button>
              </div>

              {/* Side-by-Side Benchmark Comparison Table */}
              {showBenchmarkComparison && (
                <div className="bg-[#0b0c12] border border-[#232738] rounded p-2.5 space-y-2 animate-in fade-in duration-150">
                  <div className="flex items-center justify-between text-[11px] font-bold text-white border-b border-white/10 pb-1">
                    <span className="flex items-center gap-1.5 text-[#00c8ff]">
                      <Timer size={12} />
                      <span>Ungefähre Rechenzeiten pro 5-Minuten-Referenztitel</span>
                    </span>
                    <span className="text-[9.5px] font-mono text-neutral-400 font-normal">Tracklänge: 5:00 min</span>
                  </div>

                  <div className="grid grid-cols-1 gap-1.5 text-[10px]">
                    {stemArchitectures.map((arch) => {
                      const bm = arch.benchmark5Min;
                      if (!bm) return null;
                      return (
                        <div
                          key={`bm-${arch.id}`}
                          className={`p-2 rounded border flex flex-col space-y-1 ${
                            arch.id === stemArchitectureId
                              ? 'bg-[#121c2b] border-[#0088ff]/50'
                              : 'bg-[#101218] border-[#1d202c]'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-neutral-200">{arch.label}</span>
                            <span className="font-mono text-[#34d399] font-semibold">{bm.sdrScore}</span>
                          </div>
                          <div className="grid grid-cols-3 gap-1 font-mono text-[9.5px] text-neutral-300 bg-black/40 p-1 rounded">
                            <div>
                              <span className="text-neutral-500">GPU: </span>
                              <strong className="text-[#00e5ff]">{bm.gpuTime}</strong>
                            </div>
                            <div>
                              <span className="text-neutral-500">CPU: </span>
                              <strong className="text-amber-300">{bm.cpuTime}</strong>
                            </div>
                            <div>
                              <span className="text-neutral-500">Speed: </span>
                              <strong className="text-[#34d399]">{bm.realtimeFactor}</strong>
                            </div>
                          </div>
                          <div className="text-[9.5px] text-neutral-400">{bm.useCase}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Architecture Selection List */}
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {stemArchitectures.map((option) => {
                  const active = option.id === stemArchitectureId;
                  const bm = option.benchmark5Min;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => onSetStemArchitectureId(option.id)}
                      className={`w-full text-left p-2.5 rounded-xs border transition-all flex flex-col ${
                        active
                          ? 'bg-[#101e2e] border-[#0088ff] text-white shadow-sm'
                          : 'bg-[#0f1015] border-[#1f222d] hover:border-[#2f3545] text-neutral-300'
                      }`}
                      title={`${option.label} auswählen. ${bm?.summary || ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center space-x-2 min-w-0">
                          <span className={`w-2.5 h-2.5 rounded-full border shrink-0 ${active ? 'bg-[#0088ff] border-[#0088ff]' : 'border-neutral-500'}`} />
                          <span className={`text-[11.5px] font-semibold truncate ${active ? 'text-white' : 'text-neutral-300'}`}>
                            {option.label}
                          </span>
                        </div>
                        <span className={`shrink-0 inline-flex items-center gap-1 text-[9.5px] font-semibold px-1.5 py-0.5 rounded-sm border ${
                          option.installed
                            ? 'text-[#39d353] border-[#1d3d28] bg-[#0f1d14]'
                            : 'text-[#f0b429] border-[#3a2f14] bg-[#1d1808]'
                        }`}>
                          {option.installed ? <CheckCircle2 size={9} /> : <AlertCircle size={9} />}
                          {option.installed ? (option.inProcess ? 'in-process' : 'installiert') : 'nicht installiert'}
                        </span>
                      </div>

                      <div className="text-[10px] text-neutral-400 mt-1 pl-[18px]">
                        {option.detail}
                      </div>

                      {/* Rechenzeit Badge für 5-Minuten-Track */}
                      {bm && (
                        <div className="mt-1.5 ml-[18px] bg-black/40 border border-white/5 rounded px-2 py-1 flex items-center justify-between text-[9.5px] font-mono">
                          <span className="flex items-center gap-1 text-neutral-400">
                            <Timer size={10} className="text-[#00c8ff]" />
                            <span>5-Min. Track:</span>
                            <span className="text-[#00e5ff] font-bold">GPU {bm.gpuTime}</span>
                            <span className="text-neutral-500">|</span>
                            <span className="text-neutral-300">CPU {bm.cpuTime}</span>
                          </span>
                          <span className="text-[#34d399] font-bold">{bm.sdrScore}</span>
                        </div>
                      )}

                      {!option.installed && option.reason && (
                        <div className="text-[10px] text-[#f0b429] mt-1 pl-[18px]">{option.reason}</div>
                      )}
                    </button>
                  );
                })}
              </div>

              {architectureMissing && (
                <div className="text-[10px] text-[#f0b429] bg-[#1d1808] border border-[#3a2f14] rounded-xs px-2.5 py-1.5 flex items-center justify-between">
                  <span>Diese Architektur ist noch nicht installiert.</span>
                  {onOpenInitialSetup && (
                    <button
                      onClick={onOpenInitialSetup}
                      className="px-2 py-0.5 rounded bg-[#f0b429] hover:bg-[#fbbf24] text-black font-bold text-[9.5px]"
                    >
                      Jetzt installieren
                    </button>
                  )}
                </div>
              )}

              {/* Validation Mode & Device Selectors */}
              <div className="grid grid-cols-2 gap-2 border-t border-[#252834] pt-2.5">
                <label className="text-[10.5px] text-neutral-300 font-semibold">
                  <div className="flex items-center justify-between mb-1">
                    <span>Validierungsmodus:</span>
                    <HelpBadge
                      title="Validierungsmodus"
                      text="Live (fast_dj): Schneller Durchlauf für DJ-Betrieb. Studio (studio_master): Zusätzliche spektrale Phasen- und Rekombinationsprüfungen."
                    />
                  </div>
                  <select
                    value={stemValidationMode}
                    onChange={(e) => onSetStemValidationMode(e.target.value as StemValidationMode)}
                    className="w-full bg-[#0f1015] border border-[#2b2e39] text-xs rounded px-2 py-1.5 text-neutral-200 outline-none"
                  >
                    {STEM_VALIDATION_MODES.map((mode) => (
                      <option key={mode} value={mode}>{modeLabel(mode)}</option>
                    ))}
                  </select>
                </label>

                <label className="text-[10.5px] text-neutral-300 font-semibold">
                  <div className="flex items-center justify-between mb-1">
                    <span>Rechengerät (Compute):</span>
                    <HelpBadge
                      title="Rechengerät"
                      text="Automatisch wählt DirectML/CUDA GPU falls verfügbar, sonst CPU. DirectML beschleunigt die Separation um Faktor 5× bis 25×."
                    />
                  </div>
                  <select
                    value={stemDevice}
                    onChange={(e) => onSetStemDevice(e.target.value as StemComputeDevice)}
                    className="w-full bg-[#0f1015] border border-[#2b2e39] text-xs rounded px-2 py-1.5 text-neutral-200 outline-none"
                  >
                    {stemDeviceOptions.map((choice) => (
                      <option key={choice.id} value={choice.id} disabled={!choice.available}>
                        {choice.label}{choice.available ? '' : ' – nicht verfügbar'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="text-[10px] text-neutral-500 space-y-0.5">
                {activeDevice && <div>{activeDevice.hint}</div>}
              </div>
            </div>
          </div>

          {/* Section: Speicherpfade & Verzeichnisse */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-[#1f222d] pb-1">
              <h3 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider flex items-center space-x-1.5">
                <HardDrive size={12} className="text-[#f59e0b]" />
                <span>Installations- &amp; Datenpfade</span>
              </h3>
              <button
                onClick={() => setShowPathSettings(!showPathSettings)}
                className="text-[10px] text-neutral-400 hover:text-white flex items-center space-x-1"
              >
                <span>{showPathSettings ? 'Einklappen' : 'Pfade anzeigen'}</span>
                {showPathSettings ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              </button>
            </div>

            {showPathSettings && workspacePaths && onSetWorkspacePaths && (
              <div className="bg-[#161820] border border-[#22242d] rounded-xs p-3 space-y-3 animate-in fade-in duration-150">
                <div className="space-y-1">
                  <label className="text-[10.5px] font-semibold text-neutral-300">
                    Anwendungs- &amp; Projektverzeichnis:
                  </label>
                  <input
                    type="text"
                    value={workspacePaths.appProjectsPath}
                    onChange={(e) =>
                      onSetWorkspacePaths({ ...workspacePaths, appProjectsPath: e.target.value })
                    }
                    className="w-full bg-[#0a0b10] border border-[#282d3e] focus:border-[#0088ff] rounded px-2 py-1 font-mono text-[10.5px] text-neutral-200"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10.5px] font-semibold text-neutral-300">
                    Stem-Modelle &amp; KI-Datenverzeichnis:
                  </label>
                  <input
                    type="text"
                    value={workspacePaths.stemDataPath}
                    onChange={(e) =>
                      onSetWorkspacePaths({ ...workspacePaths, stemDataPath: e.target.value })
                    }
                    className="w-full bg-[#0a0b10] border border-[#282d3e] focus:border-[#0088ff] rounded px-2 py-1 font-mono text-[10.5px] text-neutral-200"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Section: Advanced Utilities */}
          <div className="space-y-3">
            <h3 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider flex items-center space-x-1.5 border-b border-[#1f222d] pb-1">
              <Sliders size={12} className="text-neutral-400" />
              <span>System &amp; Utilities</span>
            </h3>

            <div className="grid grid-cols-2 gap-2">
              {onOpenInitialSetup && (
                <button
                  onClick={() => { onClose(); onOpenInitialSetup(); }}
                  className="flex items-center space-x-2 bg-[#161820] border border-[#22242d] hover:border-[#00c8ff]/50 p-3 rounded-xs text-left transition-colors group"
                  title="Ersteinrichtungs- & Installationsassistenten erneut ausführen"
                >
                  <div className="p-1.5 bg-[#1c1f2b] rounded text-[#00c8ff] group-hover:bg-[#00c8ff] group-hover:text-black transition-colors">
                    <Sparkles size={14} />
                  </div>
                  <div>
                    <div className="text-[11.5px] font-semibold text-neutral-200 group-hover:text-white">Setup-Assistent</div>
                    <div className="text-[10px] text-neutral-500">Ersteinrichtung &amp; KI-Setup</div>
                  </div>
                </button>
              )}

              <button
                onClick={() => { onClose(); onOpenDatabaseInspector?.(); }}
                className="flex items-center space-x-2 bg-[#161820] border border-[#22242d] hover:border-[#383d4e] p-3 rounded-xs text-left transition-colors group"
                title="Rekordbox Master.db und ANLZ Wellenform-Daten analysieren"
              >
                <div className="p-1.5 bg-[#1c1f2b] rounded text-[#0088ff] group-hover:bg-[#0088ff] group-hover:text-white transition-colors">
                  <Database size={14} />
                </div>
                <div>
                  <div className="text-[11.5px] font-semibold text-neutral-200 group-hover:text-white">Database Inspector</div>
                  <div className="text-[10px] text-neutral-500">View Rekordbox DB</div>
                </div>
              </button>

              <button
                onClick={() => { onClose(); onOpenSystemLogs?.(); }}
                className="flex items-center space-x-2 bg-[#161820] border border-[#22242d] hover:border-[#383d4e] p-3 rounded-xs text-left transition-colors group"
                title="System-Diagnose-Protokoll und Fehlerberichte einsehen"
              >
                <div className="p-1.5 bg-[#1c1f2b] rounded text-[#00c853] group-hover:bg-[#00c853] group-hover:text-white transition-colors">
                  <Activity size={14} />
                </div>
                <div>
                  <div className="text-[11.5px] font-semibold text-neutral-200 group-hover:text-white">System Logs</div>
                  <div className="text-[10px] text-neutral-500">Diagnostics &amp; Errors</div>
                </div>
              </button>
              
              <button
                onClick={() => { onClose(); onShowInfo(); }}
                className="flex items-center space-x-2 bg-[#161820] border border-[#22242d] hover:border-[#383d4e] p-3 rounded-xs text-left transition-colors group"
                title="Lizenzinformationen und Originalschutz-Status"
              >
                <div className="p-1.5 bg-[#1c1f2b] rounded text-[#f59e0b] group-hover:bg-[#f59e0b] group-hover:text-white transition-colors">
                  <Info size={14} />
                </div>
                <div>
                  <div className="text-[11.5px] font-semibold text-neutral-200 group-hover:text-white">Project Info</div>
                  <div className="text-[10px] text-neutral-500">License &amp; Data Origin</div>
                </div>
              </button>

              <button
                onClick={() => { onClose(); onAutoCue?.(); }}
                className="flex items-center space-x-2 bg-[#161820] border border-[#22242d] hover:border-[#383d4e] p-3 rounded-xs text-left transition-colors group"
                title="Automatische HotCue-Punkte an Drops und Breaks setzen"
              >
                <div className="p-1.5 bg-[#1c1f2b] rounded text-[#8b5cf6] group-hover:bg-[#8b5cf6] group-hover:text-white transition-colors">
                  <Waves size={14} />
                </div>
                <div>
                  <div className="text-[11.5px] font-semibold text-neutral-200 group-hover:text-white">Auto-Cue</div>
                  <div className="text-[10px] text-neutral-500">Find Drops &amp; Breaks</div>
                </div>
              </button>

              <button
                onClick={() => { onClose(); onClearHistory?.(); }}
                className="flex items-center space-x-2 bg-[#161820] border border-[#22242d] hover:border-[#383d4e] p-3 rounded-xs text-left transition-colors group"
                title="Undo/Redo Verlauf sicher leeren"
              >
                <div className="p-1.5 bg-[#1c1f2b] rounded text-[#ff3b30] group-hover:bg-[#ff3b30] group-hover:text-white transition-colors">
                  <Trash2 size={14} />
                </div>
                <div>
                  <div className="text-[11.5px] font-semibold text-neutral-200 group-hover:text-white">Clear History</div>
                  <div className="text-[10px] text-neutral-500">Purge Undo/Redo</div>
                </div>
              </button>
            </div>
          </div>
          
          {/* License Badge */}
          <div className="pt-2">
            <div className="flex items-center justify-between p-3 bg-gradient-to-r from-[#1a1c24] to-[#12141a] border border-[#2a2d3a] rounded-xs">
              <div className="flex items-center space-x-3">
                <div className="px-2 py-1 bg-white text-black font-bold text-[10px] uppercase tracking-wider rounded-sm shadow-sm">
                  Free Plus
                </div>
                <span className="text-xs text-neutral-400">Rekordbox Integration Active</span>
              </div>
              <span className="text-[10px] text-neutral-500 font-mono">v0.4.2</span>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
};
