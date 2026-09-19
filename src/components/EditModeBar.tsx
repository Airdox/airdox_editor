/**
 * @license
 * Rekordbox EditModeBar Component
 * Sub-toolbar matching screenshots 01, 02, 03:
 * EDIT dropdown, transport controls, quantize, master stereo meters, Free Plus badge.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronDown,
  RotateCcw,
  Info,
  Settings,
  Volume2,
  CircleStop,
} from 'lucide-react';
import { playbackClock } from '../audio/playbackClock';

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
  onOpenSettings?: () => void;
  masterVolume: number;
  onMasterVolumeChange: (vol: number) => void;
  /** Nur noch Initialwert – live Pegel kommen imperativ über den playbackClock. */
  meterL?: number;
  meterR?: number;
  paletteViewMode?: 'SIDEBAR' | 'FULL_DECK';
  onTogglePaletteViewMode?: () => void;
  bottomControlOpen?: boolean;
  onToggleBottomControl?: () => void;
  paletteOpen?: boolean;
  onTogglePalette?: () => void;
  isMaxWaveform?: boolean;
  onToggleMaxWaveform?: () => void;
  onOpenRecorder?: () => void;
  recorderActive?: boolean;
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
  onOpenSettings,
  masterVolume,
  onMasterVolumeChange,
  meterL = 0,
  meterR = 0,
  paletteViewMode = 'SIDEBAR',
  onTogglePaletteViewMode,
  bottomControlOpen = true,
  onToggleBottomControl,
  paletteOpen = true,
  onTogglePalette,
  isMaxWaveform = false,
  onToggleMaxWaveform,
  onOpenRecorder,
  recorderActive = false,
}) => {
  const [timeStr, setTimeStr] = useState<string>('15:21');

  // Master-Pegel (L/R) imperativ über den zentralen playbackClock aktualisieren.
  // Vorher kamen die Werte als React-State aus App.tsx – 60 State-Updates/Sekunde
  // haben die komplette App neu gerendert und die Bedienung blockiert.
  const meterFillLRef = useRef<HTMLDivElement>(null);
  const meterFillRRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const applyMeter = (fill: HTMLDivElement | null, value: number) => {
      if (!fill) return;
      const v = Math.max(0, Math.min(1, value));
      fill.style.width = `${Math.min(100, v * 100)}%`;
      fill.style.background =
        v > 0.85
          ? 'linear-gradient(90deg, #00c853 60%, #ffd600 85%, #ff3b30 100%)'
          : v > 0.65
          ? 'linear-gradient(90deg, #00c853 75%, #ffd600 100%)'
          : '#00c853';
      if (fill.parentElement) {
        fill.parentElement.title = `Peak ${fill.dataset.side || ''}: ${Math.round(v * 100)}%`;
      }
    };
    return playbackClock.subscribe((frame) => {
      applyMeter(meterFillLRef.current, frame.meter.left);
      applyMeter(meterFillRRef.current, frame.meter.right);
    });
  }, []);

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
        <div
          className="flex items-center space-x-1 font-bold text-white tracking-wider text-[12px] bg-[#16171d] px-2 py-1 border border-[#2b2d38] rounded-sm cursor-pointer hover:bg-[#1f2027]"
          title="Aktiver Arbeitsmodus: EDIT (Nicht-destruktiver DJ-Audio-Editor für Rekordbox)"
        >
          <span>EDIT</span>
          <ChevronDown size={12} className="text-neutral-400" />
        </div>

        {/* Project Name dropdown */}
        <div
          className="flex items-center space-x-1 text-neutral-200 font-medium text-[12px] hover:text-white cursor-pointer px-2 py-1 rounded hover:bg-[#191b22]"
          title={`Aktuelles Projekt: ${projectName}`}
        >
          <span>{projectName}</span>
          <ChevronDown size={11} className="text-neutral-500" />
        </div>

        {/* Transport Controls */}
        <div className="flex items-center space-x-2 pl-4">
          {/* Cue / Return to Start: |< */}
          <button
            onClick={onReturnToStart}
            className="w-6 h-6 flex items-center justify-center text-neutral-300 hover:text-white hover:bg-[#242630] rounded transition-colors"
            title="Zum CUE-Startpunkt zurückkehren (Taste: Pos1 / C)"
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
            title={isPlaying ? 'Wiedergabe pausieren (Leertaste)' : 'Wiedergabe starten (Leertaste)'}
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

          {onOpenRecorder && (
            <button
              onClick={onOpenRecorder}
              className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-bold tracking-wide transition-colors ${
                recorderActive
                  ? 'border-[#ff3b30] bg-[#3a1517] text-[#ff625b] animate-pulse'
                  : 'border-[#3b2830] bg-[#21151a] text-[#ff5147] hover:bg-[#3a1517] hover:text-white'
              }`}
              title="Pro Recorder für Rekordbox- und DJ-Set-Aufnahmen öffnen (Taste: F9)"
            >
              <CircleStop size={12} /> REC
            </button>
          )}

          {/* Loop toggle */}
          <button
            onClick={onToggleLoop}
            className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${
              loopActive ? 'text-[#ff9500] bg-[#332200]' : 'text-neutral-400 hover:text-white hover:bg-[#242630]'
            }`}
            title={loopActive ? 'Loop-Wiedergabe aktiv (Taste: L)' : 'Loop-Wiedergabe des Auswahlbereichs aktivieren (Taste: L)'}
          >
            <RotateCcw size={13} />
          </button>

          {/* Quantize: Q : AUTO */}
          <button
            onClick={onToggleQuantize}
            className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
              quantizeActive
                ? 'border-[#ff3b30]/60 bg-[#281414] text-neutral-200 shadow-[0_0_8px_rgba(255,59,48,0.2)]'
                : 'border-transparent text-neutral-500 hover:text-neutral-300'
            }`}
            title={
              quantizeActive
                ? 'Quantisierung AKTIV: Alle Schnitte und Loops rasten automatisch am Rekordbox Beatgrid ein'
                : 'Quantisierung INAKTIV: Freie Bearbeitung ohne Taktraster-Bindung'
            }
          >
            <span className="text-[#ff3b30] font-bold">Q</span>
            <span className="text-neutral-300 font-sans text-[11px]">: AUTO</span>
            <ChevronDown size={10} className="text-neutral-400" />
          </button>

        </div>
      </div>

      {/* Right section: Settings, Master Meter, Clock */}
      <div className="flex items-center space-x-3">
        {/* Settings gear */}
        <button
          onClick={onOpenSettings}
          className="p-1.5 text-neutral-400 hover:text-white hover:bg-[#242630] rounded transition-colors"
          title="Workspace Settings & KI-Stem-Architekturen öffnen"
        >
          <Settings size={14} />
        </button>

        {/* Master Meter & Level */}
        <div
          className="flex items-center space-x-2 bg-[#121317] px-2.5 py-1 rounded border border-[#22242d]"
          title={`Master-Lautstärke: ${Math.round(masterVolume * 100)}% · Stereo Pegelanzeige`}
        >
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

          {/* Dual Stereo LED Meter (Left / Right) – Live-Update via playbackClock */}
          <div className="flex flex-col space-y-[2px] w-14">
            {/* L */}
            <div className="h-[4px] bg-[#1a1b22] rounded-xs overflow-hidden flex" title={`Peak L: ${Math.round(meterL * 100)}%`}>
              <div
                ref={meterFillLRef}
                data-side="L"
                className="h-full"
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
            <div className="h-[4px] bg-[#1a1b22] rounded-xs overflow-hidden flex" title={`Peak R: ${Math.round(meterR * 100)}%`}>
              <div
                ref={meterFillRRef}
                data-side="R"
                className="h-full"
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
        <div className="font-mono text-[11.5px] text-neutral-300 pl-1 font-semibold" title="Systemzeit">
          {timeStr}
        </div>
      </div>
    </div>
  );
};
