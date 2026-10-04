/**
 * @license
 * airdox_SMART_Editor – Zone 1 / Transport-Cluster (UI v2.0).
 *
 * Der kompakte Player der globalen Top-Bar: Pos1/Stop, Play/Pause, Loop,
 * Quantize sowie Master-Pegel und -Lautstärke.
 *
 * Warum eigener Bauteil:
 *   Diese Bedienelemente gehörten vor der Drei-Zonen-Architektur zu einer
 *   eigenen Zeile (`EditModeBar`). Zone 1 ist eine einzige permanente Leiste;
 *   der Player ist darin ein Cluster – keine zweite Zeile, kein eigenes Band.
 *
 * Abgrenzung (harte Regel aus docs/UI_V2_DREI_ZONEN.md):
 *   Dieser Bauteil kennt keinen Prozessstatus. Er bekommt keine Fortschritte,
 *   keine Ladezustände und keine Import-Schaltfläche – die Signatur macht das
 *   unmöglich, nicht bloß unüblich.
 */

import React, { useEffect, useState } from 'react';
import { useThrottledMeters } from '../../state/transportStore';
import { RotateCcw, Play, Pause, Square, Volume2, SkipBack } from 'lucide-react';
import { UI_ACTION, UI_SURFACE } from '../../ui/theme';

interface Zone1TransportProps {
  isPlaying: boolean;
  onTogglePlay: () => void;
  /** Stop: Wiedergabe beenden und an den Cue-Start zurückkehren. */
  onStop: () => void;
  /** „|<" – zurück zum Cue-Startpunkt, ohne die Wiedergabe umzuschalten. */
  onReturnToStart: () => void;
  loopActive: boolean;
  onToggleLoop: () => void;
  quantizeActive: boolean;
  onToggleQuantize: () => void;
  masterVolume: number;
  onMasterVolumeChange: (volume: number) => void;
}

export const Zone1Transport: React.FC<Zone1TransportProps> = ({
  isPlaying,
  onTogglePlay,
  onStop,
  onReturnToStart,
  loopActive,
  onToggleLoop,
  quantizeActive,
  onToggleQuantize,
  masterVolume,
  onMasterVolumeChange,
}) => {
  /*
   * Die Pegel kommen aus dem Transport-Store (der Playhead-Treiber schreibt sie
   * mit 20 Hz, gelesen wird gedrosselt auf 20 Hz). Vorher hing die Leiste an
   * den App-Props und erzwang damit 60 Re-Renders pro Sekunde des gesamten
   * Baums – für eine Pegelanzeige.
   */
  const { left: meterL, right: meterR } = useThrottledMeters(50);

  return (
    <div
      className="flex items-center gap-1"
      data-zone="1"
      data-zone1-cluster="transport"
      role="group"
      aria-label="Transport-Player"
    >
      {/* |< – zurück zum Cue-Start */}
      <button
        type="button"
        onClick={onReturnToStart}
        className="w-7 h-7 flex items-center justify-center rounded text-neutral-300 hover:text-white hover:bg-[#1b1d26] transition-colors"
        title="Zum Cue-Startpunkt zurückkehren (Taste: C)"
        aria-label="Zum Cue-Startpunkt zurückkehren"
      >
        <SkipBack size={13} />
      </button>

      {/* Play / Pause – Rang 1, weil es die Hauptaktion des Players ist */}
      <button
        type="button"
        onClick={onTogglePlay}
        data-transport="play-pause"
        className={`w-8 h-7 flex items-center justify-center rounded transition-all border ${
          isPlaying
            ? 'bg-[#00c853] border-transparent text-black shadow-[0_0_10px_rgba(0,200,83,0.35)]'
            : 'bg-[#161922] border-[#232738] text-neutral-100 hover:border-[#00c853] hover:text-[#00e676]'
        }`}
        title={isPlaying ? 'Wiedergabe pausieren (Leertaste)' : 'Wiedergabe starten (Leertaste)'}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" className="ml-0.5" />}
      </button>

      {/* Stop – beendet die Wiedergabe und kehrt an den Start zurück */}
      <button
        type="button"
        onClick={onStop}
        data-transport="stop"
        className="w-7 h-7 flex items-center justify-center rounded text-neutral-300 hover:text-white hover:bg-[#1b1d26] transition-colors"
        title="Wiedergabe stoppen und an den Cue-Start zurücksetzen (Taste: S)"
        aria-label="Stop"
      >
        <Square size={11} fill="currentColor" />
      </button>

      <span className="w-px h-5 bg-[#23252f] mx-1" aria-hidden="true" />

      {/* Loop */}
      <button
        type="button"
        onClick={onToggleLoop}
        className={`w-7 h-7 flex items-center justify-center rounded transition-colors border ${
          loopActive ? UI_ACTION.toggleOn : 'border-transparent text-neutral-400 hover:text-white hover:bg-[#1b1d26]'
        }`}
        title={loopActive ? 'Loop-Wiedergabe aktiv (Taste: L)' : 'Loop-Wiedergabe des Auswahlbereichs aktivieren (Taste: L)'}
        aria-pressed={loopActive}
      >
        <RotateCcw size={13} />
      </button>

      {/* Quantize */}
      <button
        type="button"
        onClick={onToggleQuantize}
        className={`flex items-center gap-1 px-2 py-1 rounded text-[10.5px] font-mono border transition-colors ${
          quantizeActive
            ? UI_ACTION.toggleOn
            : 'border-transparent text-neutral-500 hover:text-neutral-300 hover:bg-[#1b1d26]'
        }`}
        title={
          quantizeActive
            ? 'Quantisierung AKTIV: Schnitte und Loops rasten am Rekordbox-Beatgrid ein'
            : 'Quantisierung INAKTIV: freie Bearbeitung ohne Taktraster'
        }
        aria-pressed={quantizeActive}
      >
        <span className="text-[#ff3b30] font-bold">Q</span>
        <span className="hidden xl:inline font-sans text-[10.5px]">: AUTO</span>
      </button>

      <span className="w-px h-5 bg-[#23252f] mx-1 hidden lg:block" aria-hidden="true" />

      {/* Master-Pegel + Lautstärke (entfällt in sehr schmalen Fenstern) */}
      <div
        className="hidden lg:flex items-center gap-2 px-2 py-1 rounded border"
        style={{ backgroundColor: UI_SURFACE.inset, borderColor: UI_SURFACE.borderStrong }}
        title={`Master-Lautstärke: ${Math.round(masterVolume * 100)}% · Stereo-Pegelanzeige`}
      >
        <Volume2 size={11} className="text-neutral-500" />
        <div className="flex flex-col gap-[2px] w-14" aria-hidden="true">
          <div className="h-[4px] bg-[#1a1b22] rounded-sm overflow-hidden">
            <div
              className="h-full transition-all duration-75"
              style={{
                width: `${Math.min(100, meterL * 100)}%`,
                background: meterGradient(meterL),
              }}
            />
          </div>
          <div className="h-[4px] bg-[#1a1b22] rounded-sm overflow-hidden">
            <div
              className="h-full transition-all duration-75"
              style={{
                width: `${Math.min(100, meterR * 100)}%`,
                background: meterGradient(meterR),
              }}
            />
          </div>
        </div>
        <input
          type="range"
          min="0"
          max="1.2"
          step="0.02"
          value={masterVolume}
          onChange={(event) => onMasterVolumeChange(parseFloat(event.target.value))}
          className="w-14 h-1 bg-[#22242d] accent-[#00a2ff] cursor-pointer"
          title={`Master Volume: ${Math.round(masterVolume * 100)}%`}
          aria-label="Master-Lautstärke"
        />
      </div>
    </div>
  );
};

/** Grün → Gelb → Rot, wie die Pegelanzeige eines Mischpults. */
function meterGradient(level: number): string {
  if (level > 0.85) return 'linear-gradient(90deg, #00c853 60%, #ffd600 85%, #ff3b30 100%)';
  if (level > 0.65) return 'linear-gradient(90deg, #00c853 75%, #ffd600 100%)';
  return UI_ACCENT_GREEN;
}

const UI_ACCENT_GREEN = '#00c853';

/** Systemzeit für die rechte Sektion von Zone 1 (Minutentakt, kein Sekunden-Tick). */
export const useSystemClock = (): string => {
  const [time, setTime] = useState<string>(() => formatClock(new Date()));
  useEffect(() => {
    const update = () => setTime(formatClock(new Date()));
    update();
    const interval = window.setInterval(update, 10_000);
    return () => window.clearInterval(interval);
  }, []);
  return time;
};

function formatClock(now: Date): string {
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
}
