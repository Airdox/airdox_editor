import React from 'react';
import { X, Settings, Info, Database, Activity, Trash2, Layout, Sliders, Waves } from 'lucide-react';
import { WaveformMode } from '../../types/rekordbox';

interface WorkspaceSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onShowInfo: () => void;
  onOpenDatabaseInspector?: () => void;
  onOpenSystemLogs?: () => void;
  onClearHistory?: () => void;
  waveformMode: WaveformMode;
  onSetWaveformMode: (mode: WaveformMode) => void;
}

export const WorkspaceSettingsModal: React.FC<WorkspaceSettingsModalProps> = ({
  isOpen,
  onClose,
  onShowInfo,
  onOpenDatabaseInspector,
  onOpenSystemLogs,
  onClearHistory,
  waveformMode,
  onSetWaveformMode,
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
