/**
 * @license
 * airdox_SMART_Editor – Deck-Mixer der fertigen Stems (Zustand „STEMS", Zone 2).
 *
 * Was dieser Bauteil seit UI v2.0 NICHT mehr ist:
 *   Er war früher ein Alles-Könner – Start-Button, Qualitätsprofile, externe
 *   Zerlegung, Expertenprofile, Fortschrittsbox und Installationshinweis lagen
 *   alle in ihm, teils doppelt. Genau daraus entstand der überladene Zustand mit
 *   übereinanderliegenden Infoboxen.
 *
 *   Jetzt zeigt er ausschließlich das Ergebnis: vier Kanalzüge (Vocals, Drums,
 *   Bass, Other) mit Solo/Mute/Volume, Pad-Zuordnung, Acapella-/Instrumental-
 *   Presets und den Export eines isolierten Stems in die Clip-Palette. Die
 *   Vorstufen (Modell, Qualität, Verarbeitungsziel, Fortschritt) liegen im
 *   Stem-Center (src/components/zones/StemCenter.tsx).
 *
 * Der Dateiname bleibt bewusst erhalten: Vertragstests und Dokumentation
 * referenzieren diesen Pfad (tests/stem-engine-ipc-contract.test.ts).
 */

import React from 'react';
import { Mic, Disc, Activity, Music, Volume2, VolumeX, Plus, Layers, Cpu, Radio } from 'lucide-react';
import {
  StemType,
  StemsMixerState,
  TrackStems,
  STEM_TYPES,
} from '../audio/stemEngine';

export interface DeckStemsControlProps {
  /** Fertige Stems des aktiven Tracks (null = nichts zu mischen). */
  stems: TrackStems | null;
  mixerState: StemsMixerState;
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
  /** Aktives Modell, mit dem diese Stems gerechnet wurden. */
  activeArchitectureLabel?: string;
}

interface StemVisualConfig {
  id: StemType;
  label: string;
  tooltipText: string;
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
    tooltipText: 'Vocals (Gesangsspur): Haupt- und Hintergrundgesang, isoliert mit höchster spektraler Reinheit.',
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
    tooltipText: 'Drums (Schlagzeug & Percussion): Kick, Snare, Claps, Hi-Hats und perkussive Transienten.',
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
    tooltipText: 'Bass (Tieftonfundament): Sub-Bass, Bassgitarren, Synth-Bässe und tieffrequente Oszillationen.',
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
    tooltipText: 'Other (Melodie & Begleitung): Synthesizer, Klaviere, Gitarren, Streicher, Bläser und Fahnen.',
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
  activeArchitectureLabel = 'Automatisch',
}) => {
  /*
   * Die Kanalzahl folgt dem Deskriptor des Jobs – nicht einer festen Vier.
   * Ein Modell mit drei oder sechs Stems zeigt genau seine Stems; `STEM_TYPES`
   * ist nur der Default, wenn kein Deskriptor vorliegt.
   */
  const stemIds: StemType[] = ((stems?.stemIds ?? STEM_TYPES) as string[]) as StemType[];
  const visibleConfigs: StemVisualConfig[] = stemIds.map((id, index) => {
    const known = STEM_CONFIGS.find((config) => config.id === id);
    return (
      known ?? {
        id,
        label: String(id).toUpperCase(),
        tooltipText: `Stem-Kanal: ${id}`,
        activeBg: 'bg-[#1b2030]',
        activeBorder: 'border-[#5b6a92]',
        activeText: 'text-[#c8d4f0]',
        glowClass: 'shadow-[0_0_12px_rgba(139,152,184,0.25)]',
        icon: <Layers size={13} />,
        padNumber: index + 1,
      }
    );
  });
  const hasAnySolo = stemIds.some((stem) => mixerState[stem]?.solo);

  return (
    <div
      className="bg-[#0e1015] border-b border-[#1c1e26] px-3 py-1.5 flex flex-col select-none"
      data-zone="2"
      data-stem-mixer="true"
    >
      {/* Kopfzeile: Ergebnis-Kontext, Presets, MIDI – keine Prozessbedienung */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <div
            className="rb-tab-chamfer bg-gradient-to-r from-[#0088ff] to-[#00c8ff] text-black font-extrabold text-[10.5px] px-2.5 py-0.5 tracking-wider uppercase flex items-center gap-1"
            title="Fertige Stems dieses Tracks: separate Spuren für Vocals, Drums, Bass und Other"
          >
            <Layers size={12} />
            <span>DECK A • STEMS</span>
          </div>

          <span
            className="text-[9.5px] font-mono px-2 py-0.5 rounded bg-[#121622] border border-[#232a3d] text-neutral-300 flex items-center gap-1.5"
            title={`Gerechnet mit: ${activeArchitectureLabel}`}
          >
            <Cpu size={10} className="text-[#00c8ff]" />
            <span className="text-neutral-400">Modell:</span>
            <span className="text-[#00e5ff] font-bold">{activeArchitectureLabel}</span>
          </span>

          <div className="flex items-center gap-1 text-[10px]">
            <button
              type="button"
              onClick={onSetAcapella}
              className="px-2 py-0.5 rounded bg-[#161922] hover:bg-[#00385e] border border-[#232738] hover:border-[#0088ff] text-neutral-300 hover:text-white transition-colors"
              title="Acapella: alle Instrumente stumm, nur Vocals aktiv"
            >
              Acapella
            </button>
            <button
              type="button"
              onClick={onSetInstrumental}
              className="px-2 py-0.5 rounded bg-[#161922] hover:bg-[#3d2500] border border-[#232738] hover:border-[#ffaa00] text-neutral-300 hover:text-white transition-colors"
              title="Instrumental: Gesang stumm, Drums/Bass/Other aktiv"
            >
              Instrumental
            </button>
            <button
              type="button"
              onClick={onResetStems}
              className="px-2 py-0.5 rounded bg-[#161922] hover:bg-[#252a3a] border border-[#232738] text-neutral-400 hover:text-white transition-colors"
              title="Stems zurücksetzen: alle Kanäle auf 100 %, ungemutet"
            >
              Reset
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[10.5px]">
          {onOpenMidiModal && (
            <button
              type="button"
              onClick={onOpenMidiModal}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded border transition-all ${
                isMidiConnected
                  ? 'bg-[#002f1d] border-[#00c853] text-[#00e676]'
                  : 'bg-[#14161f] border-[#292c3a] text-neutral-400 hover:text-white hover:border-[#3d4258]'
              }`}
              title={`${midiStatusLabel} – Pioneer DDJ-FLX4 / DDJ-1000 Stem-Pads 1-4 zuweisen`}
            >
              <Radio size={11} className={isMidiConnected ? 'animate-pulse' : ''} />
              <span>{isMidiConnected ? 'MIDI verbunden' : 'MIDI zuweisen'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Kanalzüge: Grid folgt der Anzahl der Deskriptor-Stems */}
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${visibleConfigs.length}, minmax(0, 1fr))` }}>
        {visibleConfigs.map((cfg) => {
          const state = mixerState[cfg.id] ?? { muted: false, solo: false, volume: 1 };
          const isAudible = hasAnySolo ? state.solo : !state.muted;
          return (
            <div
              key={cfg.id}
              title={cfg.tooltipText}
              className={`p-1.5 rounded border transition-all flex flex-col justify-between ${
                isAudible ? `${cfg.activeBg} ${cfg.activeBorder} ${cfg.glowClass}` : 'bg-[#101217] border-[#22242f] opacity-65'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className={isAudible ? cfg.activeText : 'text-neutral-500'}>{cfg.icon}</span>
                  <span className={`text-xs font-bold tracking-wider ${isAudible ? 'text-white' : 'text-neutral-500'}`}>
                    {cfg.label}
                  </span>
                  <span
                    className={`text-[8.5px] font-mono px-1 rounded border ${
                      isAudible ? 'bg-black/50 border-white/20 text-white' : 'bg-black/30 border-transparent text-neutral-600'
                    }`}
                    title={`Pioneer Hardware Controller Pad ${cfg.padNumber}`}
                  >
                    PAD {cfg.padNumber}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onToggleStemSolo(cfg.id)}
                    className={`w-5 h-5 rounded flex items-center justify-center text-[9.5px] font-mono font-bold transition-all ${
                      state.solo ? 'bg-[#ff9500] text-black' : 'bg-[#181a24] text-neutral-400 hover:text-white border border-[#2b2e3e]'
                    }`}
                    title={`Solo: schaltet alle anderen Stems stumm, sodass nur ${cfg.label} zu hören ist`}
                    aria-pressed={state.solo}
                  >
                    S
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleStemMute(cfg.id)}
                    className={`w-5 h-5 rounded flex items-center justify-center transition-all ${
                      state.muted ? 'bg-[#ff3b30] text-white' : 'bg-[#181a24] text-neutral-400 hover:text-white border border-[#2b2e3e]'
                    }`}
                    title={`Mute: schaltet den ${cfg.label}-Kanal stumm`}
                    aria-pressed={state.muted}
                  >
                    {state.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between pt-1 border-t border-white/5 text-[10px]">
                <div className="flex items-center gap-1.5 flex-1 pr-2">
                  <span className="text-[9px] text-neutral-400 font-mono">VOL</span>
                  <input
                    type="range"
                    min="0"
                    max="1.5"
                    step="0.05"
                    value={state.volume}
                    onChange={(event) => onStemVolumeChange(cfg.id, parseFloat(event.target.value))}
                    className="w-full h-1 bg-[#1a1d28] rounded-lg appearance-none cursor-pointer accent-[#0088ff]"
                    title={`Lautstärke für ${cfg.label}: ${Math.round(state.volume * 100)}%`}
                  />
                  <span className="text-[8.5px] font-mono text-neutral-400 w-6 text-right">
                    {Math.round(state.volume * 100)}%
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onExtractStemToClip(cfg.id)}
                  className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#1c202d] hover:bg-[#0088ff] text-neutral-300 hover:text-white border border-[#2a2f42] text-[9.5px] font-medium transition-colors"
                  title={`Diesen isolierten ${cfg.label}-Stem als eigenen Clip in die Clip-Palette exportieren`}
                >
                  <Plus size={10} />
                  <span>Clip</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
