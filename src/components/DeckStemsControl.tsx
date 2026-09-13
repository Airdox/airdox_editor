/**
 * @license
 * Rekordbox Deck Stems Control Component
 * Pioneer DJ authentic Stems Control Bar for Deck A:
 * - 4 interactive Stem buttons: VOCALS, DRUMS, BASS, OTHER
 * - Solo (S) / Mute (M) toggles with LED-like illumination
 * - Direct Clip Extraction to Palette (+ Clip)
 * - Acapella / Instrumental instant presets
 * - Separation progress bar and hardware MIDI controller status badge (DDJ-FLX4 / DDJ-1000)
 */

import React from 'react';
import {
  Mic,
  Disc,
  Activity,
  Music,
  Volume2,
  VolumeX,
  Plus,
  Sparkles,
  Layers,
  Cpu,
  Radio,
} from 'lucide-react';
import {
  StemType,
  StemsMixerState,
  TrackStems,
  StemSeparationProgress,
  STEM_TYPES,
} from '../audio/stemEngine';

interface DeckStemsControlProps {
  stems: TrackStems | null;
  mixerState: StemsMixerState;
  isSeparating: boolean;
  separationProgress: StemSeparationProgress | null;
  onSeparateStems: () => void;
  onToggleStemMute: (stem: StemType) => void;
  onToggleStemSolo: (stem: StemType) => void;
  onStemVolumeChange: (stem: StemType, vol: number) => void;
  onExtractStemToClip: (stem: StemType) => void;
  onSetAcapella: () => void;
  onSetInstrumental: () => void;
  onResetStems: () => void;
  onOpenMidiModal?: () => void;
  midiStatusLabel?: string;
  isMidiConnected?: boolean;
}

interface StemVisualConfig {
  id: StemType;
  label: string;
  sublabel: string;
  color: string;
  activeBg: string;
  activeBorder: string;
  activeText: string;
  glowClass: string;
  icon: React.ReactNode;
  padNumber: number;
}

const STEM_CONFIGS: StemVisualConfig[] = [
  {
    id: 'vocals',
    label: 'VOCALS',
    sublabel: 'Gesang & Formanten',
    color: '#00c8ff',
    activeBg: 'bg-[#002844]',
    activeBorder: 'border-[#00a2ff]',
    activeText: 'text-[#00e5ff]',
    glowClass: 'shadow-[0_0_12px_rgba(0,200,255,0.4)]',
    icon: <Mic size={13} />,
    padNumber: 1,
  },
  {
    id: 'drums',
    label: 'DRUMS',
    sublabel: 'Kicks, Snares & Hi-Hats',
    color: '#ffaa00',
    activeBg: 'bg-[#3b2700]',
    activeBorder: 'border-[#ffaa00]',
    activeText: 'text-[#ffbb33]',
    glowClass: 'shadow-[0_0_12px_rgba(255,170,0,0.4)]',
    icon: <Disc size={13} />,
    padNumber: 2,
  },
  {
    id: 'bass',
    label: 'BASS',
    sublabel: 'Sub-Bass & Low-End',
    color: '#ff3b30',
    activeBg: 'bg-[#3b0d10]',
    activeBorder: 'border-[#ff3b30]',
    activeText: 'text-[#ff5549]',
    glowClass: 'shadow-[0_0_12px_rgba(255,59,48,0.4)]',
    icon: <Activity size={13} />,
    padNumber: 3,
  },
  {
    id: 'other',
    label: 'OTHER',
    sublabel: 'Synths, Melodien & FX',
    color: '#00e676',
    activeBg: 'bg-[#003319]',
    activeBorder: 'border-[#00e676]',
    activeText: 'text-[#33ff99]',
    glowClass: 'shadow-[0_0_12px_rgba(0,230,118,0.4)]',
    icon: <Music size={13} />,
    padNumber: 4,
  },
];

export const DeckStemsControl: React.FC<DeckStemsControlProps> = ({
  stems,
  mixerState,
  isSeparating,
  separationProgress,
  onSeparateStems,
  onToggleStemMute,
  onToggleStemSolo,
  onStemVolumeChange,
  onExtractStemToClip,
  onSetAcapella,
  onSetInstrumental,
  onResetStems,
  onOpenMidiModal,
  midiStatusLabel = 'MIDI bereit',
  isMidiConnected = false,
}) => {
  const hasAnySolo = STEM_TYPES.some((s) => mixerState[s].solo);

  return (
    <div className="bg-[#0e1015] border-b border-[#1c1e26] px-3 py-1.5 flex flex-col select-none z-20">
      {/* Top Header Row: Title, Presets, MIDI Controller Status */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center space-x-2">
          {/* Angled Chamfer Pioneer Badge */}
          <div className="rb-tab-chamfer bg-gradient-to-r from-[#0088ff] to-[#00c8ff] text-black font-extrabold text-[10.5px] px-2.5 py-0.5 tracking-wider uppercase flex items-center space-x-1 shadow-sm">
            <Layers size={12} />
            <span>DECK A • STEMS</span>
          </div>

          {/* Quick Presets: Acapella / Instrumental / Reset */}
          {stems && (
            <div className="flex items-center space-x-1 text-[10px]">
              <button
                onClick={onSetAcapella}
                className="px-2 py-0.5 rounded bg-[#161922] hover:bg-[#00385e] border border-[#232738] hover:border-[#0088ff] text-neutral-300 hover:text-white transition-colors"
                title="Acapella Preset: Isoliert nur die Vocals (Solo Vocals)"
              >
                Acapella
              </button>
              <button
                onClick={onSetInstrumental}
                className="px-2 py-0.5 rounded bg-[#161922] hover:bg-[#3d2500] border border-[#232738] hover:border-[#ffaa00] text-neutral-300 hover:text-white transition-colors"
                title="Instrumental Preset: Schaltet Vocals stumm"
              >
                Instrumental
              </button>
              <button
                onClick={onResetStems}
                className="px-2 py-0.5 rounded bg-[#161922] hover:bg-[#252a3a] border border-[#232738] text-neutral-400 hover:text-white transition-colors"
                title="Alle Stems zurücksetzen (Alle aktiv bei 100%)"
              >
                Reset
              </button>
            </div>
          )}
        </div>

        {/* Right side: Hardware Controller (DDJ-FLX4 / DDJ-1000) Status */}
        <div className="flex items-center space-x-2 text-[10.5px]">
          {onOpenMidiModal && (
            <button
              onClick={onOpenMidiModal}
              className={`flex items-center space-x-1.5 px-2 py-0.5 rounded border transition-all ${
                isMidiConnected
                  ? 'bg-[#002f1d] border-[#00c853] text-[#00e676] shadow-[0_0_8px_rgba(0,200,83,0.3)]'
                  : 'bg-[#14161f] border-[#292c3a] text-neutral-400 hover:text-white hover:border-[#3d4258]'
              }`}
              title="Pioneer DDJ-FLX4 & DDJ-1000 MIDI Controller Status und Pad-Mapping öffnen"
            >
              <Radio size={11} className={isMidiConnected ? 'animate-pulse' : ''} />
              <span className="font-mono font-semibold">{midiStatusLabel}</span>
              <span className="text-[9px] bg-black/40 px-1 rounded font-mono text-neutral-300">
                PADS 1-4
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Main Stems Row: Separator Button or 4 Action Pad Buttons */}
      {!stems ? (
        <div className="flex items-center justify-between p-1.5 bg-[#12141c] rounded border border-[#202330]">
          <div className="flex items-center space-x-2.5">
            <Cpu size={16} className="text-[#00a2ff]" />
            <div className="flex flex-col">
              <span className="text-white text-xs font-semibold">
                Multi-Band Stem-Separation bereit
              </span>
              <span className="text-neutral-400 text-[10px]">
                Teilt das Audio des aktuellen Tracks in 4 isolierte Spuren: Vocals, Drums, Bass &amp; Melodie.
              </span>
            </div>
          </div>

          <button
            onClick={onSeparateStems}
            disabled={isSeparating}
            className="flex items-center space-x-1.5 px-3 py-1 rounded bg-gradient-to-r from-[#0088ff] to-[#00c8ff] hover:from-[#0099ff] hover:to-[#22d3ee] text-black font-bold text-xs shadow-md transition-all disabled:opacity-50 cursor-pointer"
          >
            <Sparkles size={13} className={isSeparating ? 'animate-spin' : ''} />
            <span>{isSeparating ? 'Stems werden getrennt...' : 'Stems jetzt trennen'}</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {STEM_CONFIGS.map((cfg) => {
            const state = mixerState[cfg.id];
            const isAudible = hasAnySolo ? state.solo : !state.muted;

            return (
              <div
                key={cfg.id}
                title={cfg.sublabel}
                className={`p-1.5 rounded border transition-all flex flex-col justify-between ${
                  isAudible
                    ? `${cfg.activeBg} ${cfg.activeBorder} ${cfg.glowClass}`
                    : 'bg-[#101217] border-[#22242f] opacity-65'
                }`}
              >
                {/* Upper: Stem Identifier + Pad Mapping Badge + Solo/Mute Buttons */}
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center space-x-1.5">
                    <span className={isAudible ? cfg.activeText : 'text-neutral-500'}>
                      {cfg.icon}
                    </span>
                    <span
                      className={`text-xs font-bold tracking-wider ${
                        isAudible ? 'text-white' : 'text-neutral-500'
                      }`}
                    >
                      {cfg.label}
                    </span>
                    {/* Hardware Controller Pad Indicator (FLX4 / DDJ-1000) */}
                    <span
                      className={`text-[8.5px] font-mono px-1 rounded border ${
                        isAudible
                          ? 'bg-black/50 border-white/20 text-white'
                          : 'bg-black/30 border-transparent text-neutral-600'
                      }`}
                      title={`Gemappt auf Action Pad ${cfg.padNumber} des Pioneer Controllers`}
                    >
                      PAD {cfg.padNumber}
                    </span>
                  </div>

                  {/* Solo (S) / Mute (M) Toggle Buttons */}
                  <div className="flex items-center space-x-1">
                    <button
                      onClick={() => onToggleStemSolo(cfg.id)}
                      className={`w-5 h-5 rounded flex items-center justify-center text-[9.5px] font-mono font-bold transition-all ${
                        state.solo
                          ? 'bg-[#ff9500] text-black shadow-[0_0_8px_rgba(255,149,0,0.5)]'
                          : 'bg-[#181a24] text-neutral-400 hover:text-white border border-[#2b2e3e]'
                      }`}
                      title={`Solo ${cfg.label} (Shift + Pad ${cfg.padNumber} / Pad ${cfg.padNumber + 4})`}
                    >
                      S
                    </button>

                    <button
                      onClick={() => onToggleStemMute(cfg.id)}
                      className={`w-5 h-5 rounded flex items-center justify-center text-[9.5px] font-mono font-bold transition-all ${
                        state.muted
                          ? 'bg-[#ff3b30] text-white shadow-[0_0_8px_rgba(255,59,48,0.5)]'
                          : 'bg-[#181a24] text-neutral-400 hover:text-white border border-[#2b2e3e]'
                      }`}
                      title={`Stumm / Aktivieren (Pad ${cfg.padNumber})`}
                    >
                      {state.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
                    </button>
                  </div>
                </div>

                {/* Lower: Volume Slider & Extract to Palette Clip Button */}
                <div className="flex items-center justify-between pt-1 border-t border-white/5 text-[10px]">
                  <div className="flex items-center space-x-1.5 flex-1 pr-2">
                    <span className="text-[9px] text-neutral-400 font-mono">VOL</span>
                    <input
                      type="range"
                      min="0"
                      max="1.5"
                      step="0.05"
                      value={state.volume}
                      onChange={(e) => onStemVolumeChange(cfg.id, parseFloat(e.target.value))}
                      className="w-full h-1 bg-[#1a1d28] rounded-lg appearance-none cursor-pointer accent-[#0088ff]"
                      title={`Lautstärke ${cfg.label}: ${Math.round(state.volume * 100)}%`}
                    />
                    <span className="text-[8.5px] font-mono text-neutral-400 w-6 text-right">
                      {Math.round(state.volume * 100)}%
                    </span>
                  </div>

                  <button
                    onClick={() => onExtractStemToClip(cfg.id)}
                    className="flex items-center space-x-0.5 px-1.5 py-0.5 rounded bg-[#1c202d] hover:bg-[#0088ff] text-neutral-300 hover:text-white border border-[#2a2f42] text-[9.5px] font-medium transition-colors"
                    title={`Isolierten ${cfg.label}-Stem als Clip zur Palette hinzufügen`}
                  >
                    <Plus size={10} />
                    <span>Clip</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Separation Progress Bar (when active) */}
      {isSeparating && separationProgress && (
        <div className="mt-1.5 bg-[#12141c] p-2 rounded border border-[#0088ff]/40 flex flex-col space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-[#00e5ff] font-medium animate-pulse">
              {separationProgress.phaseText}
            </span>
            <span className="font-mono text-white font-bold">
              {separationProgress.percent}%
            </span>
          </div>
          <div className="w-full h-1.5 bg-[#1a1c26] rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-[#0088ff] to-[#00e5ff] transition-all duration-150"
              style={{ width: `${separationProgress.percent}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
