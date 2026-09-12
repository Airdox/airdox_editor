import React from "react";
import {
  Sliders,
  Sparkles,
  GitBranch,
  ShieldCheck,
  Disc3,
  Layers,
} from "lucide-react";

interface HeaderProps {
  decksVisible: boolean;
  onToggleDecks: () => void;
  onOpenMidiModal: () => void;
  onOpenAiChat: () => void;
  onOpenGitModal: () => void;
  activePreset: "ddj-flx4" | "ddj-1000" | "custom";
  connectedMidiDevices: string[];
}

export const Header: React.FC<HeaderProps> = ({
  decksVisible,
  onToggleDecks,
  onOpenMidiModal,
  onOpenAiChat,
  onOpenGitModal,
  activePreset,
  connectedMidiDevices,
}) => {
  const isHardwareConnected = connectedMidiDevices.length > 0;

  return (
    <header className="h-14 border-b border-zinc-800 bg-zinc-950 px-4 flex items-center justify-between select-none z-30 sticky top-0">
      {/* Brand & Identity */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-950/40">
            <Disc3 className="w-5 h-5 text-zinc-950 animate-[spin_8s_linear_infinite]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-sm tracking-wider text-zinc-100">
                AIRDOX
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950/80 border border-cyan-800 text-cyan-400 font-mono font-medium">
                DJ PRO HUB
              </span>
            </div>
            <p className="text-[10px] text-zinc-500 -mt-0.5 hidden sm:block">
              State-of-the-Art Library &amp; Hardware Hub
            </p>
          </div>
        </div>

        {/* Non-Destructive Protection Indicator */}
        <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-950/40 border border-emerald-800/60 text-emerald-400 text-xs font-medium">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span>Originaldateien geschützt (Nur Lesezugriff)</span>
        </div>
      </div>

      {/* Center / Hardware Profile Status */}
      <div className="flex items-center gap-2">
        <button
          onClick={onOpenMidiModal}
          className="group flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors text-xs"
          title="Pioneer DJ Hardware Mapping &amp; Learn konfigurieren"
        >
          <span
            className={`w-2 h-2 rounded-full ${
              isHardwareConnected
                ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]"
                : "bg-cyan-500"
            }`}
          />
          <span className="font-mono text-zinc-300 font-semibold uppercase">
            {activePreset === "ddj-flx4"
              ? "Pioneer DDJ-FLX4"
              : activePreset === "ddj-1000"
              ? "Pioneer DDJ-1000"
              : "Custom MIDI"}
          </span>
          <span className="text-[10px] text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded">
            {isHardwareConnected ? "Verbunden" : "Bereit / Learn"}
          </span>
          <Sliders className="w-3.5 h-3.5 text-zinc-400 group-hover:text-cyan-400 ml-1" />
        </button>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-2">
        {/* Toggle Decks View */}
        <button
          onClick={onToggleDecks}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            decksVisible
              ? "bg-cyan-950/60 border-cyan-800 text-cyan-300"
              : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200"
          }`}
          title="Dual Decks Player ein/ausblenden"
        >
          <Layers className="w-3.5 h-3.5" />
          <span className="hidden md:inline">
            {decksVisible ? "Decks aktiv" : "Decks ausblenden"}
          </span>
        </button>

        {/* AI DJ Assistant */}
        <button
          onClick={onOpenAiChat}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white shadow-md shadow-cyan-950/50 transition-all"
          title="KI DJ Assistant mit Live-Library-Befehlen öffnen"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>AI DJ Assistant</span>
        </button>

        {/* Git Sync & Clean */}
        <button
          onClick={onOpenGitModal}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 transition-colors"
          title="GitHub Push &amp; Quellcodeverwaltung"
        >
          <GitBranch className="w-3.5 h-3.5 text-orange-400" />
          <span className="hidden sm:inline">GitHub</span>
        </button>
      </div>
    </header>
  );
};
