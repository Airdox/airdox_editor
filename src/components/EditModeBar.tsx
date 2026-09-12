/**
 * @license
 * Rekordbox EditModeBar Component
 * Sub-toolbar matching screenshots 01, 02, 03:
 * EDIT dropdown, transport controls, quantize, master stereo meters, Free Plus badge.
 */

import React, { useState, useEffect } from 'react';
import {
  ChevronDown,
  RotateCcw,
  Info,
  Radio,
  Volume2,
  FilePlus,
  Save,
  Share2,
  Settings,
  PanelBottom,
  PanelRight,
  Maximize2,
  Minimize2,
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
  onExport: () => void;
  onShowInfo: () => void;
  masterVolume: number;
  onMasterVolumeChange: (vol: number) => void;
  meterL: number;
  meterR: number;
  paletteViewMode?: 'SIDEBAR' | 'FULL_DECK';
  onTogglePaletteViewMode?: () => void;
  bottomControlOpen?: boolean;
  onToggleBottomControl?: () => void;
  paletteOpen?: boolean;
  onTogglePalette?: () => void;
  isMaxWaveform?: boolean;
  onToggleMaxWaveform?: () => void;
  onOpenRecordModal?: () => void;
  isRecordingActive?: boolean;
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
  onExport,
  onShowInfo,
  masterVolume,
  onMasterVolumeChange,
  meterL,
  meterR,
  paletteViewMode = 'SIDEBAR',
  onTogglePaletteViewMode,
  bottomControlOpen = true,
  onToggleBottomControl,
  paletteOpen = true,
  onTogglePalette,
  isMaxWaveform = false,
  onToggleMaxWaveform,
  onOpenRecordModal,
  isRecordingActive = false,
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
    <div className="h-10 bg-[#0d0f14] border-b border-[#1c202b] flex items-center justify-between px-3 text-xs select-none">
      {/* Left section: EDIT mode dropdown, Project Name, Transport, REC */}
      <div className="flex items-center space-x-3">
        {/* EDIT Mode selector */}
        <div className="flex items-center space-x-1 font-bold text-white tracking-wider text-[11px] bg-[#161a24] px-2.5 py-1 border border-[#2a3042] rounded cursor-pointer hover:bg-[#1f2433] transition-colors">
          <span>EDIT</span>
          <ChevronDown size={11} className="text-neutral-400" />
        </div>

        {/* Small project icons */}
        <div className="flex items-center space-x-1 text-neutral-400 pl-1 border-r border-[#202534] pr-2">
          <button
            onClick={onNewProject}
            className="p-1 hover:text-white hover:bg-[#202534] rounded transition-colors"
            title="Neues Projekt"
          >
            <FilePlus size={13} />
          </button>
          <button
            onClick={onSaveProject}
            className="p-1 hover:text-white hover:bg-[#202534] rounded transition-colors"
            title="Projekt speichern"
          >
            <Save size={13} />
          </button>
          <button
            onClick={onExport}
            className="p-1 hover:text-white hover:bg-[#202534] rounded transition-colors"
            title="Exportieren"
          >
            <Share2 size={13} />
          </button>
        </div>

        {/* Project Name */}
        <div className="flex items-center space-x-1.5 text-neutral-300 font-medium text-[11.5px] px-2 py-1 rounded bg-[#13161f] border border-[#202534]">
          <span className="truncate max-w-[140px]">{projectName}</span>
        </div>

        {/* Transport Controls */}
        <div className="flex items-center space-x-1.5 pl-2 border-l border-[#202534]">
          {/* Cue / Return to Start: |< */}
          <button
            onClick={onReturnToStart}
            className="w-7 h-7 flex items-center justify-center text-neutral-300 hover:text-white hover:bg-[#202534] rounded transition-colors"
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
                : 'text-neutral-200 hover:text-white hover:bg-[#202534]'
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
            className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
              loopActive ? 'text-[#ff9500] bg-[#332200] border border-[#ff9500]/40' : 'text-neutral-400 hover:text-white hover:bg-[#202534]'
            }`}
            title="Loop aktiv / inaktiv"
          >
            <RotateCcw size={13} />
          </button>

          {/* Quantize: Q : AUTO */}
          <button
            onClick={onToggleQuantize}
            className={`flex items-center space-x-1 px-2 py-1 rounded text-[11px] font-mono border transition-colors ${
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

          {/* Deck View Layout Toggle: 1-DECK vs 2-DECK */}
          {onTogglePaletteViewMode && (
            <button
              onClick={onTogglePaletteViewMode}
              className={`flex items-center space-x-1 px-2.5 py-1 rounded text-[10.5px] font-bold border transition-colors ${
                paletteViewMode === 'FULL_DECK'
                  ? 'border-[#0088ff] bg-[#0d2238] text-[#00c8ff]'
                  : 'border-[#262c3c] bg-[#141720] text-neutral-400 hover:text-white hover:border-[#353c52]'
              }`}
              title="Zwischen Standard-Ansicht und 2-Deck-Ansicht (Deck A + Clip-Deck B) umschalten"
            >
              <span>{paletteViewMode === 'FULL_DECK' ? '2-DECK AKTIV' : '2-DECK ANSICHT'}</span>
            </button>
          )}

          {/* Dedicated Rekordbox REC Button */}
          {onOpenRecordModal && (
            <button
              onClick={onOpenRecordModal}
              className={`flex items-center space-x-1.5 px-3 py-1 rounded text-[11px] font-bold border transition-all ${
                isRecordingActive
                  ? 'border-red-500 bg-red-950/80 text-red-300 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.5)]'
                  : 'border-[#2d3446] bg-[#151922] text-neutral-200 hover:text-white hover:border-red-500/70 hover:bg-[#20181c]'
              }`}
              title="Audio-Aufnahme öffnen (Rekordbox REC Pop-up)"
            >
              <div className={`w-2 h-2 rounded-full ${isRecordingActive ? 'bg-red-500 animate-ping' : 'bg-red-500'}`} />
              <span>REC</span>
            </button>
          )}

          {/* Divider */}
          <div className="h-4 w-px bg-[#262c3c] mx-0.5" />

          {/* Collapsible Edit Palette (Bottom): EDIT-PANEL */}
          {onToggleBottomControl && (
            <button
              onClick={onToggleBottomControl}
              className={`flex items-center space-x-1 px-2.5 py-1 rounded text-[10.5px] font-semibold border transition-colors ${
                bottomControlOpen
                  ? 'border-[#0088ff] bg-[#0c2035] text-[#00a2ff]'
                  : 'border-[#262c3c] bg-[#141720] text-neutral-400 hover:text-white'
              }`}
              title="Editierpalette unten ein-/ausklappen für maximale Wellenform-Fläche (Taste: E)"
            >
              <PanelBottom size={12} />
              <span>EDIT-PANEL</span>
            </button>
          )}

          {/* Collapsible Clip Palette (Side): CLIPS */}
          {onTogglePalette && (
            <button
              onClick={onTogglePalette}
              className={`flex items-center space-x-1 px-2.5 py-1 rounded text-[10.5px] font-semibold border transition-colors ${
                paletteOpen
                  ? 'border-[#0088ff] bg-[#0c2035] text-[#00a2ff]'
                  : 'border-[#262c3c] bg-[#141720] text-neutral-400 hover:text-white'
              }`}
              title="Clip-Palette rechts ein-/ausklappen (Taste: P)"
            >
              <PanelRight size={12} />
              <span>CLIPS</span>
            </button>
          )}

          {/* Maximize Waveform / MAX ZOOM */}
          {onToggleMaxWaveform && (
            <button
              onClick={onToggleMaxWaveform}
              className={`flex items-center space-x-1 px-2.5 py-1 rounded text-[10.5px] font-bold border transition-colors ${
                isMaxWaveform
                  ? 'border-[#00e5ff] bg-[#003848] text-[#00e5ff] shadow-[0_0_8px_rgba(0,229,255,0.3)]'
                  : 'border-[#262c3c] bg-[#141720] text-neutral-400 hover:text-[#00e5ff] hover:border-[#353c52]'
              }`}
              title="Wellenform maximieren (Zen-Modus: klappt Paletten ein für maximale Bearbeitungsfläche) [Taste: M]"
            >
              {isMaxWaveform ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              <span>{isMaxWaveform ? 'MAX AKTIV' : 'MAX ZOOM'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Right section: Info, Free Plus badge, Settings, Master Meter, Clock */}
      <div className="flex items-center space-x-3">
        {/* Info button */}
        <button
          onClick={onShowInfo}
          className="p-1.5 text-neutral-400 hover:text-white hover:bg-[#202534] rounded transition-colors"
          title="Rekordbox Projekt- & Lizenzinformationen"
        >
          <Info size={14} />
        </button>

        {/* "Free Plus" Rekordbox license badge */}
        <div className="px-2.5 py-0.5 rounded border border-[#2b3142] bg-[#141722] text-neutral-300 font-medium text-[10.5px] tracking-wide">
          Free Plus
        </div>

        {/* Settings gear */}
        <button
          onClick={onShowInfo}
          className="p-1.5 text-neutral-400 hover:text-white hover:bg-[#202534] rounded transition-colors"
          title="Einstellungen"
        >
          <Settings size={14} />
        </button>

        {/* Master Meter & Level */}
        <div className="flex items-center space-x-2 bg-[#12151e] px-2.5 py-1 rounded border border-[#232838]">
          {/* Rotary indicator */}
          <div className="w-4 h-4 rounded-full border border-neutral-600 relative flex items-center justify-center">
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
            <div className="h-[4px] bg-[#191d28] rounded-xs overflow-hidden flex">
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
            <div className="h-[4px] bg-[#191d28] rounded-xs overflow-hidden flex">
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
            className="w-12 h-1 bg-[#232838] accent-[#00a2ff] cursor-pointer"
            title={`Master Volume: ${Math.round(masterVolume * 100)}%`}
          />
        </div>

        {/* Digital Time display */}
        <div className="font-mono text-[11.5px] text-neutral-300 pl-1 font-semibold">
          {timeStr}
        </div>
      </div>
    </div>
  );
};
