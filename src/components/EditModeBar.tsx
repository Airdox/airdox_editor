/**
 * @license
 * Rekordbox EditModeBar Component
 * Sub-toolbar matching screenshots 01, 02, 03:
 * EDIT dropdown, transport controls, quantize, master stereo meters, Free Plus badge.
 */

import React, { useState, useEffect } from 'react';
import {
  FilePlus,
  FolderOpen,
  Save,
  Share2,
  ChevronDown,
  RotateCcw,
  Info,
  Settings,
  Volume2
} from 'lucide-react';

interface EditModeBarProps {
  projectName: string;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onReturnToStart: () => void;
  loopActive: boolean;
  onToggleLoop: () => void;
  quantizeActive: boolean;
  onToggleQuantize: () => void;
  onNewProject: () => void;
  onSaveProject: () => void;
  onOpenProject: () => void;
  /** Pfad der zuletzt gespeicherten Projektdatei (Desktop) bzw. null. */
  projectPath: string | null;
  /** Ungespeicherte Änderungen am Arbeitsstand. */
  isDirty: boolean;
  onExport: () => void;
  onShowInfo: () => void;
  masterVolume: number;
  onMasterVolumeChange: (vol: number) => void;
  meterL: number;
  meterR: number;
}

export const EditModeBar: React.FC<EditModeBarProps> = ({
  projectName,
  isPlaying,
  onTogglePlay,
  onReturnToStart,
  loopActive,
  onToggleLoop,
  quantizeActive,
  onToggleQuantize,
  onNewProject,
  onSaveProject,
  onOpenProject,
  projectPath,
  isDirty,
  onExport,
  onShowInfo,
  masterVolume,
  onMasterVolumeChange,
  meterL,
  meterR,
}) => {
  const [timeStr, setTimeStr] = useState<string>('15:21');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hours = now.getHours().toString().padStart(2, '0');
      const mins = now.getMinutes().toString().padStart(2, '0');
      setTimeStr(`${hours}:${mins}`);
    };
    updateTime();
    const interval = setInterval(updateTime, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="h-10 bg-[#0e0f12] border-b border-[#1c1d23] flex items-center justify-between px-3 text-xs select-none">
      {/* Left section: EDIT mode dropdown, Project tools, Transport */}
      <div className="flex items-center space-x-3">
        {/* EDIT Mode selector */}
        <div className="flex items-center space-x-1 font-bold text-white tracking-wider text-[12px] bg-[#16171d] px-2 py-1 border border-[#2b2d38] rounded-sm cursor-pointer hover:bg-[#1f2027]">
          <span>EDIT</span>
          <ChevronDown size={12} className="text-neutral-400" />
        </div>

        {/* Small project icons */}
        <div className="flex items-center space-x-1.5 text-neutral-400 pl-1 border-r border-[#262832] pr-3">
          <button
            onClick={onNewProject}
            className="p-1 hover:text-white hover:bg-[#20222a] rounded transition-colors"
            title="Neues Projekt"
          >
            <FilePlus size={14} />
          </button>
          <button
            onClick={onOpenProject}
            className="p-1 hover:text-white hover:bg-[#20222a] rounded transition-colors"
            title="Projekt öffnen (Strg+Shift+O)"
          >
            <FolderOpen size={14} />
          </button>
          <button
            onClick={onSaveProject}
            className={`p-1 rounded transition-colors hover:text-black hover:bg-[#ff9500] ${
              isDirty ? 'text-[#ff9500]' : 'text-neutral-400'
            }`}
            title={
              isDirty
                ? 'Projekt speichern (Strg+S) – ungespeicherte Änderungen' +
                  (projectPath ? ` → ${projectPath}` : '')
                : projectPath
                  ? `zuletzt gespeichert: ${projectPath}`
                  : 'Projekt speichern (Strg+S)'
            }
          >
            <Save size={14} />
          </button>
          <button
            onClick={onExport}
            className="p-1 hover:text-white hover:bg-[#20222a] rounded transition-colors"
            title="Exportieren"
          >
            <Share2 size={14} />
          </button>
        </div>

        {/* Project Name dropdown */}
        <div
          className="flex items-center space-x-1 text-neutral-200 font-medium text-[12px] hover:text-white cursor-pointer px-2 py-1 rounded hover:bg-[#191b22]"
          title={projectPath ? `Projektdatei: ${projectPath}` : 'Projekt noch nicht gespeichert'}
        >
          <span>{projectName}</span>
          {isDirty && <span className="text-[#ff9500] font-bold">*</span>}
          <ChevronDown size={11} className="text-neutral-500" />
        </div>

        {/* Transport Controls */}
        <div className="flex items-center space-x-2 pl-4">
          {/* Cue / Return to Start: |< */}
          <button
            onClick={onReturnToStart}
            className="w-6 h-6 flex items-center justify-center text-neutral-300 hover:text-white hover:bg-[#242630] rounded transition-colors"
            title="Return to Cue / Start (|<)"
          >
            <div className="flex items-center">
              <div className="w-[2px] h-3 bg-current mr-[1px]"></div>
              <div className="w-0 h-0 border-y-[5px] border-y-transparent border-r-[8px] border-r-current"></div>
            </div>
          </button>

          {/* Play / Pause: > */}
          <button
            onClick={onTogglePlay}
            className={`w-7 h-7 flex items-center justify-center rounded transition-all ${
              isPlaying
                ? 'bg-[#00c853] text-black shadow-[0_0_10px_rgba(0,200,83,0.4)]'
                : 'text-neutral-200 hover:text-white hover:bg-[#282a34]'
            }`}
            title="Play / Pause"
          >
            {isPlaying ? (
              <div className="flex space-x-[2px]">
                <div className="w-[3px] h-3.5 bg-black rounded-[0.5px]" />
                <div className="w-[3px] h-3.5 bg-black rounded-[0.5px]" />
              </div>
            ) : (
              <div className="w-0 h-0 border-y-[6px] border-y-transparent border-l-[10px] border-l-current ml-0.5"></div>
            )}
          </button>

          {/* Loop toggle */}
          <button
            onClick={onToggleLoop}
            className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${
              loopActive ? 'text-[#ff9500] bg-[#332200]' : 'text-neutral-400 hover:text-white hover:bg-[#242630]'
            }`}
            title="Loop"
          >
            <RotateCcw size={13} />
          </button>

          {/* Quantize: Q : AUTO */}
          <button
            onClick={onToggleQuantize}
            className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
              quantizeActive
                ? 'border-[#ff3b30]/60 bg-[#281414] text-neutral-200'
                : 'border-transparent text-neutral-500 hover:text-neutral-300'
            }`}
            title="Quantize Mode"
          >
            <span className="text-[#ff3b30] font-bold">Q</span>
            <span className="text-neutral-300 font-sans text-[11px]">: AUTO</span>
            <ChevronDown size={10} className="text-neutral-400" />
          </button>
        </div>
      </div>

      {/* Right section: Info, Free Plus badge, Settings, Master Meter, Clock */}
      <div className="flex items-center space-x-3">
        {/* Info button */}
        <button
          onClick={onShowInfo}
          className="p-1 text-neutral-400 hover:text-white hover:bg-[#242630] rounded"
          title="Rekordbox Datenursprung & Originalschutz"
        >
          <Info size={14} />
        </button>

        {/* "Free Plus" Rekordbox license badge */}
        <div className="px-2.5 py-0.5 rounded border border-[#3a3d4a] bg-[#1a1b22] text-neutral-200 font-medium text-[11px] tracking-wide">
          Free Plus
        </div>

        {/* Settings gear */}
        <button
          onClick={onShowInfo}
          className="p-1 text-neutral-400 hover:text-white hover:bg-[#242630] rounded"
          title="Einstellungen"
        >
          <Settings size={14} />
        </button>

        {/* Master Meter & Level */}
        <div className="flex items-center space-x-2 bg-[#121317] px-2.5 py-1 rounded border border-[#22242d]">
          {/* Rotary indicator */}
          <div className="w-4 h-4 rounded-full border border-neutral-500 relative flex items-center justify-center">
            <div
              className="w-1.5 h-[1.5px] bg-[#00a2ff] absolute"
              style={{
                transform: `rotate(${(masterVolume * 240) - 120}deg)`,
                transformOrigin: 'right center',
                right: '50%',
              }}
            />
          </div>

          {/* Dual Stereo LED Meter (Left / Right) */}
          <div className="flex flex-col space-y-[2px] w-14">
            {/* L */}
            <div className="h-[4px] bg-[#1a1b22] rounded-xs overflow-hidden flex">
              <div
                className="h-full transition-all duration-75"
                style={{
                  width: `${Math.min(100, meterL * 100)}%`,
                  background:
                    meterL > 0.85
                      ? 'linear-gradient(90deg, #00c853 60%, #ffd600 85%, #ff3b30 100%)'
                      : meterL > 0.65
                      ? 'linear-gradient(90deg, #00c853 75%, #ffd600 100%)'
                      : '#00c853',
                }}
              />
            </div>
            {/* R */}
            <div className="h-[4px] bg-[#1a1b22] rounded-xs overflow-hidden flex">
              <div
                className="h-full transition-all duration-75"
                style={{
                  width: `${Math.min(100, meterR * 100)}%`,
                  background:
                    meterR > 0.85
                      ? 'linear-gradient(90deg, #00c853 60%, #ffd600 85%, #ff3b30 100%)'
                      : meterR > 0.65
                      ? 'linear-gradient(90deg, #00c853 75%, #ffd600 100%)'
                      : '#00c853',
                }}
              />
            </div>
          </div>

          {/* Master volume slider */}
          <input
            type="range"
            min="0"
            max="1.2"
            step="0.02"
            value={masterVolume}
            onChange={(e) => onMasterVolumeChange(parseFloat(e.target.value))}
            className="w-12 h-1 bg-[#22242d] accent-[#00a2ff] cursor-pointer"
            title={`Master Volume: ${Math.round(masterVolume * 100)}%`}
          />
        </div>

        {/* Digital Time display matching screenshot (e.g. 15:21) */}
        <div className="font-mono text-[11.5px] text-neutral-300 pl-1 font-semibold">
          {timeStr}
        </div>
      </div>
    </div>
  );
};
