import React from "react";
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  Disc,
  Link2,
} from "lucide-react";
import { DeckState, MixerState, DJTrack } from "../types";
import { getCamelotColor } from "../utils/harmonicUtils";

interface DualDeckPlayerProps {
  deck1: DeckState;
  deck2: DeckState;
  mixer: MixerState;
  onPlayPause: (deckId: 1 | 2) => void;
  onCue: (deckId: 1 | 2) => void;
  onHotCue: (deckId: 1 | 2, slot: number) => void;
  onPitchChange: (deckId: 1 | 2, rate: number) => void;
  onVolumeChange: (deckId: 1 | 2, volume: number) => void;
  onEqChange: (deckId: 1 | 2, band: "low" | "mid" | "high", value: number) => void;
  onFilterChange: (deckId: 1 | 2, value: number) => void;
  onCrossfaderChange: (value: number) => void;
  onMasterVolumeChange: (value: number) => void;
  onQuickLoadMatchedPair?: () => void;
}

export const DualDeckPlayer: React.FC<DualDeckPlayerProps> = ({
  deck1,
  deck2,
  mixer,
  onPlayPause,
  onCue,
  onHotCue,
  onPitchChange,
  onVolumeChange,
  onEqChange,
  onFilterChange,
  onCrossfaderChange,
  onMasterVolumeChange,
}) => {
  return (
    <div className="bg-zinc-950 border-b border-zinc-800 px-3 py-3 select-none">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px_1fr] gap-3 items-stretch max-w-[1600px] mx-auto">
        {/* DECK 1 (CYAN ACCENT) */}
        <DeckPanel
          deck={deck1}
          deckNumber={1}
          accentColor="cyan"
          onPlayPause={() => onPlayPause(1)}
          onCue={() => onCue(1)}
          onHotCue={(slot) => onHotCue(1, slot)}
          onPitchChange={(val) => onPitchChange(1, val)}
        />

        {/* CENTER DJ MIXER */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-3 flex flex-col justify-between shadow-inner">
          <div className="flex items-center justify-between pb-2 border-b border-zinc-800/80">
            <span className="text-[11px] font-bold tracking-widest text-zinc-400 uppercase">
              DJ Mixer
            </span>
            <div className="flex items-center gap-1.5">
              <Volume2 className="w-3.5 h-3.5 text-zinc-500" />
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={mixer.masterVolume}
                onChange={(e) => onMasterVolumeChange(parseFloat(e.target.value))}
                className="w-16 h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                title="Master Volume"
              />
            </div>
          </div>

          {/* 3-Band EQ & Filter Section */}
          <div className="grid grid-cols-2 gap-2 my-2">
            {/* Ch 1 EQ */}
            <div className="flex flex-col gap-1.5 items-center bg-zinc-950/60 p-2 rounded-lg border border-zinc-800/40">
              <span className="text-[10px] font-semibold text-cyan-400">CH 1 EQ</span>
              <KnobControl
                label="HI"
                value={deck1.eqHigh}
                onChange={(v) => onEqChange(1, "high", v)}
                accent="cyan"
              />
              <KnobControl
                label="MID"
                value={deck1.eqMid}
                onChange={(v) => onEqChange(1, "mid", v)}
                accent="cyan"
              />
              <KnobControl
                label="LOW"
                value={deck1.eqLow}
                onChange={(v) => onEqChange(1, "low", v)}
                accent="cyan"
              />
              <KnobControl
                label="COLOR"
                value={(deck1.filter + 1) / 2}
                onChange={(v) => onFilterChange(1, v * 2 - 1)}
                accent="cyan"
                isFilter
              />
            </div>

            {/* Ch 2 EQ */}
            <div className="flex flex-col gap-1.5 items-center bg-zinc-950/60 p-2 rounded-lg border border-zinc-800/40">
              <span className="text-[10px] font-semibold text-amber-400">CH 2 EQ</span>
              <KnobControl
                label="HI"
                value={deck2.eqHigh}
                onChange={(v) => onEqChange(2, "high", v)}
                accent="amber"
              />
              <KnobControl
                label="MID"
                value={deck2.eqMid}
                onChange={(v) => onEqChange(2, "mid", v)}
                accent="amber"
              />
              <KnobControl
                label="LOW"
                value={deck2.eqLow}
                onChange={(v) => onEqChange(2, "low", v)}
                accent="amber"
              />
              <KnobControl
                label="COLOR"
                value={(deck2.filter + 1) / 2}
                onChange={(v) => onFilterChange(2, v * 2 - 1)}
                accent="amber"
                isFilter
              />
            </div>
          </div>

          {/* Level Faders & VU Meters */}
          <div className="grid grid-cols-2 gap-4 items-end px-2 py-1">
            {/* Ch 1 Fader */}
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-20 bg-zinc-950 rounded overflow-hidden flex flex-col-reverse p-0.5 border border-zinc-800">
                <div
                  className="w-full bg-cyan-500 rounded-sm transition-all duration-75"
                  style={{ height: `${deck1.isPlaying ? (deck1.volume * 80 + Math.random() * 20) : 0}%` }}
                />
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={deck1.volume}
                onChange={(e) => onVolumeChange(1, parseFloat(e.target.value))}
                className="h-20 -rotate-90 w-20 appearance-none bg-zinc-800 rounded-lg cursor-pointer accent-cyan-500 origin-center"
              />
            </div>

            {/* Ch 2 Fader */}
            <div className="flex items-center gap-2 justify-end">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={deck2.volume}
                onChange={(e) => onVolumeChange(2, parseFloat(e.target.value))}
                className="h-20 -rotate-90 w-20 appearance-none bg-zinc-800 rounded-lg cursor-pointer accent-amber-500 origin-center"
              />
              <div className="w-2.5 h-20 bg-zinc-950 rounded overflow-hidden flex flex-col-reverse p-0.5 border border-zinc-800">
                <div
                  className="w-full bg-amber-500 rounded-sm transition-all duration-75"
                  style={{ height: `${deck2.isPlaying ? (deck2.volume * 80 + Math.random() * 20) : 0}%` }}
                />
              </div>
            </div>
          </div>

          {/* Magvel Crossfader */}
          <div className="mt-2 pt-2 border-t border-zinc-800">
            <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 px-1 mb-1">
              <span className="text-cyan-400 font-bold">DECK 1</span>
              <span>CROSSFADER</span>
              <span className="text-amber-400 font-bold">DECK 2</span>
            </div>
            <input
              type="range"
              min="-1"
              max="1"
              step="0.02"
              value={mixer.crossfader}
              onChange={(e) => onCrossfaderChange(parseFloat(e.target.value))}
              className="w-full h-3 bg-zinc-950 border border-zinc-700 rounded-md appearance-none cursor-pointer accent-zinc-200"
            />
          </div>
        </div>

        {/* DECK 2 (AMBER/ORANGE ACCENT) */}
        <DeckPanel
          deck={deck2}
          deckNumber={2}
          accentColor="amber"
          onPlayPause={() => onPlayPause(2)}
          onCue={() => onCue(2)}
          onHotCue={(slot) => onHotCue(2, slot)}
          onPitchChange={(val) => onPitchChange(2, val)}
        />
      </div>
    </div>
  );
};

// Deck Panel Component
interface DeckPanelProps {
  deck: DeckState;
  deckNumber: 1 | 2;
  accentColor: "cyan" | "amber";
  onPlayPause: () => void;
  onCue: () => void;
  onHotCue: (slot: number) => void;
  onPitchChange: (rate: number) => void;
}

const DeckPanel: React.FC<DeckPanelProps> = ({
  deck,
  deckNumber,
  accentColor,
  onPlayPause,
  onCue,
  onHotCue,
  onPitchChange,
}) => {
  const isCyan = accentColor === "cyan";
  const track = deck.track;

  return (
    <div
      className={`rounded-xl border p-3.5 bg-zinc-900/80 flex flex-col justify-between shadow-lg relative overflow-hidden ${
        isCyan
          ? "border-cyan-900/60 shadow-cyan-950/20"
          : "border-amber-900/60 shadow-amber-950/20"
      }`}
    >
      {/* Top Deck Info Bar */}
      <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-zinc-800">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`text-xs font-black px-2 py-0.5 rounded font-mono ${
              isCyan ? "bg-cyan-500/20 text-cyan-300" : "bg-amber-500/20 text-amber-300"
            }`}
          >
            DECK {deckNumber}
          </span>
          <div className="truncate">
            <h4 className="text-sm font-bold text-zinc-100 truncate">
              {track ? track.title : "Kein Track geladen"}
            </h4>
            <p className="text-xs text-zinc-400 truncate">
              {track ? `${track.artist} ${track.remix ? `(${track.remix})` : ""}` : "Wähle einen Track aus der Library"}
            </p>
          </div>
        </div>

        {/* Key & BPM Indicators */}
        {track && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className="text-xs font-mono font-bold px-2 py-0.5 rounded border"
              style={{
                backgroundColor: `${getCamelotColor(track.camelotKey)}20`,
                borderColor: `${getCamelotColor(track.camelotKey)}80`,
                color: getCamelotColor(track.camelotKey),
              }}
            >
              {track.camelotKey} ({track.musicalKey})
            </span>
            <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700">
              {track.bpm} BPM
            </span>
          </div>
        )}
      </div>

      {/* Waveform Visualization Strip */}
      <div className="my-2.5 bg-zinc-950 rounded-lg p-2 border border-zinc-800 relative h-14 flex items-center overflow-hidden">
        {track?.waveformPeaks ? (
          <div className="w-full h-full flex items-center gap-0.5">
            {track.waveformPeaks.map((peak, idx) => {
              const heightPct = Math.max(10, peak * 100);
              const isPast = idx < (track.waveformPeaks.length * 0.35);
              return (
                <div
                  key={idx}
                  className={`flex-1 rounded-full transition-colors ${
                    isPast
                      ? isCyan
                        ? "bg-cyan-400"
                        : "bg-amber-400"
                      : "bg-zinc-700"
                  }`}
                  style={{ height: `${heightPct}%` }}
                />
              );
            })}
            {/* Playhead Marker */}
            <div
              className={`absolute top-0 bottom-0 w-0.5 shadow-md ${
                isCyan ? "bg-cyan-300 shadow-cyan-400" : "bg-amber-300 shadow-amber-400"
              }`}
              style={{ left: "35%" }}
            />
          </div>
        ) : (
          <div className="w-full text-center text-xs text-zinc-600 font-mono">
            Track laden für Wellenform &amp; Beatgrid
          </div>
        )}
      </div>

      {/* Main Deck Controls: Jog Wheel & Performance Controls */}
      <div className="grid grid-cols-[140px_1fr_60px] gap-3 items-center">
        {/* Animated Pioneer Jog Wheel */}
        <div className="relative w-32 h-32 mx-auto flex items-center justify-center">
          <div
            className={`w-32 h-32 rounded-full border-4 flex items-center justify-center transition-transform duration-200 shadow-xl ${
              isCyan
                ? "border-zinc-700 bg-zinc-950 shadow-cyan-950/40"
                : "border-zinc-700 bg-zinc-950 shadow-amber-950/40"
            } ${deck.isPlaying ? "animate-[spin_4s_linear_infinite]" : ""}`}
          >
            {/* Center LCD Ring */}
            <div
              className={`w-16 h-16 rounded-full border-2 flex flex-col items-center justify-center text-center select-none ${
                isCyan ? "border-cyan-500/80 bg-zinc-900" : "border-amber-500/80 bg-zinc-900"
              }`}
            >
              <Disc
                className={`w-5 h-5 ${
                  isCyan ? "text-cyan-400" : "text-amber-400"
                }`}
              />
              <span className="text-[10px] font-mono text-zinc-300 font-bold">
                {track ? track.bpm : "---"}
              </span>
            </div>
            {/* Jog Marker */}
            <div
              className={`absolute top-1 w-2 h-2 rounded-full ${
                isCyan ? "bg-cyan-400 shadow-[0_0_8px_cyan]" : "bg-amber-400 shadow-[0_0_8px_orange]"
              }`}
            />
          </div>
        </div>

        {/* Performance Controls: Cue, Play, Hot Cues */}
        <div className="flex flex-col justify-between h-full gap-2">
          {/* Main Round Pioneer Cue & Play Buttons */}
          <div className="flex items-center gap-3">
            {/* CUE Button */}
            <button
              onClick={onCue}
              className={`w-12 h-12 rounded-full border-2 font-bold font-mono text-xs flex items-center justify-center transition-all shadow-md active:scale-95 ${
                isCyan
                  ? "border-cyan-500/80 bg-cyan-950/60 text-cyan-300 hover:bg-cyan-900/60"
                  : "border-amber-500/80 bg-amber-950/60 text-amber-300 hover:bg-amber-900/60"
              }`}
              title="CUE Punkt setzen / anspringen"
            >
              CUE
            </button>

            {/* PLAY / PAUSE Button */}
            <button
              onClick={onPlayPause}
              className={`w-12 h-12 rounded-full border-2 font-bold text-xs flex items-center justify-center transition-all shadow-lg active:scale-95 ${
                deck.isPlaying
                  ? "border-emerald-500 bg-emerald-950 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.5)]"
                  : isCyan
                  ? "border-cyan-500 bg-zinc-900 text-cyan-400 hover:bg-zinc-800"
                  : "border-amber-500 bg-zinc-900 text-amber-400 hover:bg-zinc-800"
              }`}
              title="Play / Pause"
            >
              {deck.isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
            </button>
          </div>

          {/* Hot Cue Pads 1 to 4 */}
          <div>
            <span className="text-[10px] text-zinc-500 font-mono uppercase mb-1 block">
              Performance Pads (Hot Cue)
            </span>
            <div className="grid grid-cols-4 gap-1.5">
              {[1, 2, 3, 4].map((slot) => {
                const cue = track?.hotCues?.find((c) => c.slot === slot);
                return (
                  <button
                    key={slot}
                    onClick={() => onHotCue(slot)}
                    className="h-8 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 active:scale-95 transition-all text-xs font-bold font-mono flex flex-col items-center justify-center"
                    style={{
                      borderBottomColor: cue?.color || "#52525b",
                      borderBottomWidth: "3px",
                    }}
                    title={cue ? `${cue.name} (${cue.time}s)` : `Hot Cue ${slot}`}
                  >
                    <span>{slot}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Pitch / Tempo Fader Slider */}
        <div className="flex flex-col items-center h-full justify-between">
          <span className="text-[9px] font-mono text-zinc-400 font-semibold">
            {((deck.pitchRate - 1) * 100).toFixed(1)}%
          </span>
          <input
            type="range"
            min="0.92"
            max="1.08"
            step="0.001"
            value={deck.pitchRate}
            onChange={(e) => onPitchChange(parseFloat(e.target.value))}
            className="h-24 -rotate-90 w-24 appearance-none bg-zinc-800 rounded-md cursor-pointer accent-zinc-300 origin-center"
            title="Tempo / Pitch Fader"
          />
          <button
            onClick={() => onPitchChange(1.0)}
            className="text-[9px] font-mono bg-zinc-800 hover:bg-zinc-700 px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400"
            title="Pitch auf 0% zurücksetzen"
          >
            0%
          </button>
        </div>
      </div>
    </div>
  );
};

// Mini Rotary Knob Control with Center Detent
interface KnobControlProps {
  label: string;
  value: number; // 0 to 1
  onChange: (v: number) => void;
  accent: "cyan" | "amber";
  isFilter?: boolean;
}

const KnobControl: React.FC<KnobControlProps> = ({
  label,
  value,
  onChange,
  accent,
  isFilter = false,
}) => {
  // Map value 0..1 to angle -135deg to +135deg
  const angle = (value - 0.5) * 270;

  return (
    <div className="flex flex-col items-center select-none">
      <div
        className="w-8 h-8 rounded-full bg-zinc-900 border border-zinc-700 shadow-sm flex items-center justify-center relative cursor-pointer group"
        onClick={() => {
          // Double click or click reset to center
          if (Math.abs(value - 0.5) > 0.05) {
            onChange(0.5);
          }
        }}
      >
        {/* Notch indicator */}
        <div
          className="w-full h-full rounded-full flex items-start justify-center p-0.5"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <div
            className={`w-1 h-2 rounded-full ${
              isFilter
                ? value < 0.48
                  ? "bg-blue-400"
                  : value > 0.52
                  ? "bg-amber-400"
                  : "bg-zinc-400"
                : accent === "cyan"
                ? "bg-cyan-400"
                : "bg-amber-400"
            }`}
          />
        </div>
      </div>
      <span className="text-[9px] font-mono text-zinc-500 font-bold mt-0.5">
        {label}
      </span>
    </div>
  );
};
