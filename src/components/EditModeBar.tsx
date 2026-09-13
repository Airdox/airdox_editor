/**
 * @license
 * Rekordbox EditModeBar Component
 * Streamlined Pioneer DJ Transport & Layout Control Bar:
 * - Compact 32px height (maximum vertical workspace for waveforms)
 * - Free of redundant buttons and non-functional badges
 * - Essential transport controls, quantize, segmented view toggles, and master stereo meters
 */

import React from 'react';
import {
  ChevronDown,
  RotateCcw,
  Volume2,
  PanelBottom,
  PanelRight,
  Maximize2,
  Minimize2,
  Columns,
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
  onNewProject?: () => void;
  onSaveProject?: () => void;
  onExport?: () => void;
  onShowInfo?: () => void;
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
  masterVolume,
  onMasterVolumeChange,
  meterL,
  meterR,
  paletteViewMode = 'SIDEBAR',
  onTogglePaletteViewMode,
  bottomControlOpen = false,
  onToggleBottomControl,
  paletteOpen = false,
  onTogglePalette,
  isMaxWaveform = false,
  onToggleMaxWaveform,
}) => {
  return (
    <div className="h-8 bg-[#0e0f12] border-b border-[#1c1d23] flex items-center justify-between px-2.5 text-xs select-none">
      {/* Left section: EDIT Mode indicator & Transport Controls */}
      <div className="flex items-center space-x-2.5">
        {/* EDIT Mode indicator tag */}
        <div className="flex items-center space-x-1 font-bold text-white tracking-wider text-[11px] bg-[#16171d] px-2 py-0.5 border border-[#2b2d38] rounded-xs cursor-default shadow-xs">
          <span className="text-[#00a2ff]">EDIT</span>
          <span className="text-neutral-500 font-normal">|</span>
          <span className="text-neutral-300 font-medium text-[10.5px] truncate max-w-[120px]" title={projectName}>
            {projectName}
          </span>
        </div>

        {/* Transport Controls */}
        <div className="flex items-center space-x-1.5 pl-1 border-l border-[#20222a]">
          {/* Cue / Return to Start: |< */}
          <button
            onClick={onReturnToStart}
            className="w-6 h-6 flex items-center justify-center text-neutral-300 hover:text-white hover:bg-[#242630] rounded-xs transition-colors"
            title="Return to Cue / Start (|<)"
          >
            <div className="flex items-center">
              <div className="w-[2px] h-3 bg-current mr-[1px]"></div>
              <div className="w-0 h-0 border-y-[4.5px] border-y-transparent border-r-[7px] border-r-current"></div>
            </div>
          </button>

          {/* Play / Pause: > */}
          <button
            onClick={onTogglePlay}
            className={`w-6 h-6 flex items-center justify-center rounded-xs transition-all ${
              isPlaying
                ? 'bg-[#00c853] text-black shadow-[0_0_8px_rgba(0,200,83,0.4)]'
                : 'text-neutral-200 hover:text-white hover:bg-[#282a34]'
            }`}
            title="Play / Pause (Leertaste)"
          >
            {isPlaying ? (
              <div className="flex space-x-[2px]">
                <div className="w-[2.5px] h-3 bg-black rounded-[0.5px]" />
                <div className="w-[2.5px] h-3 bg-black rounded-[0.5px]" />
              </div>
            ) : (
              <div className="w-0 h-0 border-y-[5px] border-y-transparent border-l-[8px] border-l-current ml-0.5"></div>
            )}
          </button>

          {/* Loop toggle */}
          <button
            onClick={onToggleLoop}
            className={`w-6 h-6 flex items-center justify-center rounded-xs transition-colors ${
              loopActive ? 'text-[#ff9500] bg-[#332200]' : 'text-neutral-400 hover:text-white hover:bg-[#242630]'
            }`}
            title="Loop aktiv / inaktiv"
          >
            <RotateCcw size={12} />
          </button>

          {/* Quantize: Q : AUTO */}
          <button
            onClick={onToggleQuantize}
            className={`flex items-center space-x-1 px-1.5 py-0.5 rounded-xs text-[10.5px] font-mono border transition-colors ${
              quantizeActive
                ? 'border-[#ff3b30]/60 bg-[#281414] text-neutral-200'
                : 'border-transparent text-neutral-500 hover:text-neutral-300'
            }`}
            title="Quantize Modus umschalten"
          >
            <span className="text-[#ff3b30] font-bold">Q</span>
            <span className="text-neutral-300 font-sans text-[10px]">: AUTO</span>
          </button>
        </div>
      </div>

      {/* Center/Right section: Sleek Segmented View Toggles & Master Meter */}
      <div className="flex items-center space-x-3">
        {/* Sleek Segmented Layout Controls */}
        <div className="flex items-center bg-[#13141a] p-0.5 rounded-xs border border-[#232530] space-x-0.5">
          {onTogglePaletteViewMode && (
            <button
              onClick={onTogglePaletteViewMode}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded-xs text-[10px] font-semibold transition-colors ${
                paletteViewMode === 'FULL_DECK'
                  ? 'bg-[#0088ff] text-white shadow-xs'
                  : 'text-neutral-400 hover:text-neutral-200 hover:bg-[#1c1d25]'
              }`}
              title="2-Deck Clip-Ansicht umschalten"
            >
              <Columns size={11} />
              <span>2-DECK</span>
            </button>
          )}

          {onToggleBottomControl && (
            <button
              onClick={onToggleBottomControl}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded-xs text-[10px] font-semibold transition-colors ${
                bottomControlOpen
                  ? 'bg-[#0088ff] text-white shadow-xs'
                  : 'text-neutral-400 hover:text-neutral-200 hover:bg-[#1c1d25]'
              }`}
              title="Editierpalette (Taste: E)"
            >
              <PanelBottom size={11} />
              <span>EDIT</span>
            </button>
          )}

          {onTogglePalette && (
            <button
              onClick={onTogglePalette}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded-xs text-[10px] font-semibold transition-colors ${
                paletteOpen
                  ? 'bg-[#0088ff] text-white shadow-xs'
                  : 'text-neutral-400 hover:text-neutral-200 hover:bg-[#1c1d25]'
              }`}
              title="Clip-Palette (Taste: P)"
            >
              <PanelRight size={11} />
              <span>CLIPS</span>
            </button>
          )}

          {onToggleMaxWaveform && (
            <button
              onClick={onToggleMaxWaveform}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded-xs text-[10px] font-bold transition-colors ${
                isMaxWaveform
                  ? 'bg-[#00e5ff] text-black shadow-[0_0_8px_rgba(0,229,255,0.4)]'
                  : 'text-neutral-400 hover:text-[#00e5ff] hover:bg-[#1c1d25]'
              }`}
              title="Wellenform maximieren (Zen-Modus, Taste: M)"
            >
              {isMaxWaveform ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
              <span>ZEN</span>
            </button>
          )}
        </div>

        {/* Master Volume & Dual Stereo LED Meter */}
        <div className="flex items-center space-x-2 bg-[#121317] px-2 py-0.5 rounded-xs border border-[#22242d]">
          <Volume2 size={12} className="text-neutral-400" />

          {/* Dual Stereo LED Meter (Left / Right) */}
          <div className="flex flex-col space-y-[2px] w-12">
            {/* L */}
            <div className="h-[3px] bg-[#1a1b22] rounded-xs overflow-hidden flex">
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
            <div className="h-[3px] bg-[#1a1b22] rounded-xs overflow-hidden flex">
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
      </div>
    </div>
  );
};

