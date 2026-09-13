import React from 'react';
import { X, Settings, Info, Database, Activity, Trash2, Layout, Sliders, Waves } from 'lucide-react';
import { WaveformMode } from '../../types/rekordbox';

export type RecordingSource = 'EDITOR_MASTER' | 'AUDIO_INPUT' | 'SYSTEM_LOOPBACK';
export type RecordingFormat = 'WAV' | 'FLAC';

interface WorkspaceSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onShowInfo: () => void;
  onOpenDatabaseInspector?: () => void;
  onOpenSystemLogs?: () => void;
  onAutoCue?: () => void;
  onClearHistory?: () => void;
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
}

export const WorkspaceSettingsModal: React.FC<WorkspaceSettingsModalProps> = ({
  isOpen,
  onClose,
  onShowInfo,
  onOpenDatabaseInspector,
  onOpenSystemLogs,
  onAutoCue,
  onClearHistory,
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
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] p-4 select-none">
      <div className="bg-[#12141a] border border-[#272935] rounded-sm shadow-2xl w-full max-w-lg flex flex-col overflow-hidden text-neutral-200">
        
        {/* Header */}
        <div className="h-10 bg-[#171922] border-b border-[#252834] flex items-center justify-between px-4">
          <div className="flex items-center space-x-2">
            <Settings size={16} className="text-neutral-400" />
            <span className="font-bold text-white text-xs tracking-wide">
              Workspace Settings & Utilities
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-6 max-h-[70vh] overflow-y-auto">
          
          {/* Section: Appearance & Layout */}
          <div className="space-y-3">
            <h3 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider flex items-center space-x-1.5 border-b border-[#1f222d] pb-1">
              <Layout size={12} />
              <span>Appearance & Display</span>
            </h3>
            
            <div className="bg-[#161820] border border-[#22242d] rounded-xs p-3 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-white">Waveform Color Mode</div>
                <div className="text-[10.5px] text-neutral-500">Choose how frequencies are visualized in the waveforms.</div>
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
                  <div className="text-[10px] text-neutral-500">Align selection and playhead perfectly to the beatgrid.</div>
                </div>
                <label className="flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" checked={snapToBeatgrid} onChange={(e) => onSetSnapToBeatgrid(e.target.checked)} />
                  <div className="w-8 h-4 bg-[#0f1015] border border-[#22242d] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-neutral-400 peer-checked:after:bg-[#0088ff] after:border-neutral-500 after:border after:rounded-full after:h-3 after:w-3 after:transition-all"></div>
                </label>
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-white">Auto-Scroll Waveform</div>
                  <div className="text-[10px] text-neutral-500">Center the playhead automatically during playback.</div>
                </div>
                <label className="flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" checked={autoScroll} onChange={(e) => onSetAutoScroll(e.target.checked)} />
                  <div className="w-8 h-4 bg-[#0f1015] border border-[#22242d] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-neutral-400 peer-checked:after:bg-[#00c853] after:border-neutral-500 after:border after:rounded-full after:h-3 after:w-3 after:transition-all"></div>
                </label>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-white">High Quality Rendering</div>
                  <div className="text-[10px] text-neutral-500">Use 32-bit float internal mixing and anti-aliasing.</div>
                </div>
                <label className="flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" checked={highQualityRendering} onChange={(e) => onSetHighQualityRendering(e.target.checked)} />
                  <div className="w-8 h-4 bg-[#0f1015] border border-[#22242d] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-neutral-400 peer-checked:after:bg-[#8b5cf6] after:border-neutral-500 after:border after:rounded-full after:h-3 after:w-3 after:transition-all"></div>
                </label>
              </div>
            </div>
          </div>

          {/* Section: Recording / Capture */}
          <div className="space-y-3">
            <h3 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider flex items-center space-x-1.5 border-b border-[#1f222d] pb-1">
              <Waves size={12} />
              <span>Aufnahme & Signalquelle</span>
            </h3>
            <div className="bg-[#161820] border border-[#22242d] rounded-xs p-3 space-y-3">
              <div>
                <label className="text-xs font-semibold text-white block mb-1">Aufnahmequelle</label>
                <select value={recordingSource} onChange={(e) => onSetRecordingSource(e.target.value as RecordingSource)} className="w-full bg-[#0f1015] border border-[#2b2e39] text-xs rounded px-2 py-1.5">
                  <option value="EDITOR_MASTER">Editor-Master (intern)</option>
                  <option value="AUDIO_INPUT">Mikrofon / Line-In</option>
                  <option value="SYSTEM_LOOPBACK">Windows / Rekordbox Master (Loopback)</option>
                </select>
                <div className="text-[10px] text-neutral-500 mt-1">Die Quelle wird für die künftige Aufnahmefunktion gespeichert; Rekordbox wird über WASAPI-Loopback aufgenommen, nicht über den Editor-Master.</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] text-neutral-400">Format<select value={recordingFormat} onChange={(e) => onSetRecordingFormat(e.target.value as RecordingFormat)} className="mt-1 w-full bg-[#0f1015] border border-[#2b2e39] text-xs rounded px-2 py-1.5"><option value="WAV">WAV (PCM)</option><option value="FLAC">FLAC</option></select></label>
                <label className="text-[10px] text-neutral-400">Samplerate<select value={recordingSampleRate} onChange={(e) => onSetRecordingSampleRate(Number(e.target.value) as 44100 | 48000)} className="mt-1 w-full bg-[#0f1015] border border-[#2b2e39] text-xs rounded px-2 py-1.5"><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option></select></label>
                <label className="text-[10px] text-neutral-400">Bit-Tiefe<select value={recordingBitDepth} onChange={(e) => onSetRecordingBitDepth(Number(e.target.value) as 16 | 24 | 32)} className="mt-1 w-full bg-[#0f1015] border border-[#2b2e39] text-xs rounded px-2 py-1.5"><option value="16">16 Bit</option><option value="24">24 Bit</option><option value="32">32 Bit Float</option></select></label>
                <label className="text-[10px] text-neutral-400">Kanäle<select value={recordingChannels} onChange={(e) => onSetRecordingChannels(e.target.value as 'STEREO' | 'MONO')} className="mt-1 w-full bg-[#0f1015] border border-[#2b2e39] text-xs rounded px-2 py-1.5"><option value="STEREO">Stereo</option><option value="MONO">Mono</option></select></label>
              </div>
              <div className="space-y-2 border-t border-[#252834] pt-2">
                <label className="flex items-center justify-between text-xs text-neutral-200"><span>Soft-Limiter gegen Clipping</span><input type="checkbox" checked={recordingLimiter} onChange={(e) => onSetRecordingLimiter(e.target.checked)} /></label>
                <label className="flex items-center justify-between text-xs text-neutral-200"><span>Vor destruktiven Befehlen bestätigen</span><input type="checkbox" checked={confirmDestructiveEdits} onChange={(e) => onSetConfirmDestructiveEdits(e.target.checked)} /></label>
                <label className="flex items-center justify-between text-xs text-neutral-200"><span>Projekt automatisch sichern</span><input type="checkbox" checked={autoSaveProject} onChange={(e) => onSetAutoSaveProject(e.target.checked)} /></label>
              </div>
            </div>
          </div>

          {/* Section: Advanced Utilities */}
          <div className="space-y-3">
            <h3 className="text-[11px] font-bold text-neutral-400 uppercase tracking-wider flex items-center space-x-1.5 border-b border-[#1f222d] pb-1">
              <Sliders size={12} />
              <span>System & Utilities</span>
            </h3>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => { onClose(); onOpenDatabaseInspector?.(); }}
                className="flex items-center space-x-2 bg-[#161820] border border-[#22242d] hover:border-[#383d4e] p-3 rounded-xs text-left transition-colors group"
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
              >
                <div className="p-1.5 bg-[#1c1f2b] rounded text-[#00c853] group-hover:bg-[#00c853] group-hover:text-white transition-colors">
                  <Activity size={14} />
                </div>
                <div>
                  <div className="text-[11.5px] font-semibold text-neutral-200 group-hover:text-white">System Logs</div>
                  <div className="text-[10px] text-neutral-500">Diagnostics & Errors</div>
                </div>
              </button>
              
              <button
                onClick={() => { onClose(); onShowInfo(); }}
                className="flex items-center space-x-2 bg-[#161820] border border-[#22242d] hover:border-[#383d4e] p-3 rounded-xs text-left transition-colors group"
              >
                <div className="p-1.5 bg-[#1c1f2b] rounded text-[#f59e0b] group-hover:bg-[#f59e0b] group-hover:text-white transition-colors">
                  <Info size={14} />
                </div>
                <div>
                  <div className="text-[11.5px] font-semibold text-neutral-200 group-hover:text-white">Project Info</div>
                  <div className="text-[10px] text-neutral-500">License & Data Origin</div>
                </div>
              </button>

              <button
                onClick={() => { onClose(); onAutoCue?.(); }}
                className="flex items-center space-x-2 bg-[#161820] border border-[#22242d] hover:border-[#383d4e] p-3 rounded-xs text-left transition-colors group"
              >
                <div className="p-1.5 bg-[#1c1f2b] rounded text-[#8b5cf6] group-hover:bg-[#8b5cf6] group-hover:text-white transition-colors">
                  <Waves size={14} />
                </div>
                <div>
                  <div className="text-[11.5px] font-semibold text-neutral-200 group-hover:text-white">Auto-Cue</div>
                  <div className="text-[10px] text-neutral-500">Find Drops & Breaks</div>
                </div>
              </button>

              <button
                onClick={() => { onClose(); onClearHistory?.(); }}
                className="flex items-center space-x-2 bg-[#161820] border border-[#22242d] hover:border-[#383d4e] p-3 rounded-xs text-left transition-colors group"
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
              <span className="text-[10px] text-neutral-500">v0.4.2</span>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
};
