/**
 * @license
 * Rekordbox Deck Stems Control Component – REFACTORED per §25
 * - Echte modellbasierte AI-Separation (BS-RoFormer primär, HT-Demucs ONNX für Live)
 * - Bei nicht installierter Engine: Öffnet Installations-Popup mit Install-Button
 * - Bei installierter Engine: Führt direkt den im Einstellungsmenü ausgewählten Architekturmodus aus
 * - Zeigt ausgewählten Architekturmodus und 5-Minuten-Referenzzeiten
 * - Vollständige deutsche Tooltips für alle Bedienelemente
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
  AlertTriangle,
  Download,
  Timer,
} from 'lucide-react';
import {
  StemEngineProfileInfo,
  StemQualityProfile,
  StemType,
  StemsMixerState,
  TrackStems,
  StemSeparationProgress,
  STEM_TYPES,
} from '../audio/stemEngine';
import { Tooltip, HelpBadge } from './Tooltip';

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
  onCancelSeparation?: () => void;
  profiles?: StemEngineProfileInfo[];
  selectedProfile?: StemQualityProfile;
  onProfileChange?: (profile: StemQualityProfile) => void;
  /** Engine unavailable reason */
  engineUnavailableReason?: string | null;
  /** Show diagnostics button */
  onShowDiagnostics?: () => void;
  /** Active architecture mode label from settings */
  activeArchitectureLabel?: string;
  /** Active architecture 5-min benchmark info */
  activeArchitectureBenchmark?: string;
  /** Direct trigger to open installer modal */
  onOpenInstaller?: () => void;
}

const PROFILE_LABELS: Record<StemQualityProfile, string> = {
  PREVIEW: 'Vorschau',
  BALANCED: 'Balanced',
  HIGH: 'High',
  HIGH_QUALITY: 'HQ',
  MAXIMUM_QUALITY: 'Max',
};

interface StemVisualConfig {
  id: StemType;
  label: string;
  sublabel: string;
  tooltipText: string;
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
    sublabel: 'Gesang – echte AI Separation via BS-RoFormer',
    tooltipText: 'Vocals (Gesangsspur): Haupt- und Hintergrundgesang, isoliert mit höchster spektraler Reinheit (9.65 dB SDR).',
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
    sublabel: 'Drums – echte AI Separation',
    tooltipText: 'Drums (Schlagzeug & Percussion): Kick-Drum, Snare, Claps, Hi-Hats und perkussive Transienten.',
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
    sublabel: 'Bass – echte AI Separation',
    tooltipText: 'Bass (Tieftonfundament): Sub-Bass, Bassgitarren, Synth-Bässe und tieffrequente Oszillationen.',
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
    sublabel: 'Other/Instruments – echte AI Separation',
    tooltipText: 'Other (Melodie & Begleitung): Synthesizer, Klaviere, Gitarren, Streicher, Bläser und Hall-/Delay-Fahnen.',
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
  onCancelSeparation,
  profiles = [],
  selectedProfile = 'HIGH',
  onProfileChange,
  engineUnavailableReason,
  onShowDiagnostics,
  activeArchitectureLabel = 'BS-RoFormer (Studio Master)',
  activeArchitectureBenchmark = '5-Min. Track: GPU ~45–75s | CPU ~3–5 Min.',
  onOpenInstaller,
}) => {
  const stemIds: StemType[] = ((stems?.stemIds ?? STEM_TYPES) as string[]) as StemType[];
  const visibleConfigs: StemVisualConfig[] = stemIds.map((id, index) => {
    const known = STEM_CONFIGS.find((cfg) => cfg.id === id);
    return (
      known ?? {
        id,
        label: String(id).toUpperCase(),
        sublabel: 'Stem aus Modell-Deskriptor',
        tooltipText: `Stem-Kanal: ${id}`,
        color: '#8b98b8',
        activeBg: 'bg-[#1b2030]',
        activeBorder: 'border-[#5b6a92]',
        activeText: 'text-[#c8d4f0]',
        glowClass: 'shadow-[0_0_12px_rgba(139,152,184,0.25)]',
        icon: <Layers size={13} />,
        padNumber: index + 1,
      }
    );
  });
  const hasAnySolo = stemIds.some((s) => mixerState[s]?.solo);

  const hasUsableEngine = profiles.some((p) => p.available);
  const showUnavailable = !hasUsableEngine && !stems && !isSeparating;

  return (
    <div className="bg-[#0e1015] border-b border-[#1c1e26] px-3 py-1.5 flex flex-col select-none z-20">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center space-x-2">
          <div
            className="rb-tab-chamfer bg-gradient-to-r from-[#0088ff] to-[#00c8ff] text-black font-extrabold text-[10.5px] px-2.5 py-0.5 tracking-wider uppercase flex items-center space-x-1 shadow-sm"
            title="Pioneer DJ Deck Stems: 4 isolierte Spuren (Vocals, Drums, Bass, Other)"
          >
            <Layers size={12} />
            <span>DECK A • STEMS</span>
          </div>

          {/* Active Settings Architecture Badge */}
          <span
            className="text-[9.5px] font-mono px-2 py-0.5 rounded bg-[#121622] border border-[#232a3d] text-neutral-300 flex items-center gap-1.5"
            title={`Im Einstellungsmenü gewählter Architekturmodus: ${activeArchitectureLabel}. ${activeArchitectureBenchmark}`}
          >
            <Cpu size={10} className="text-[#00c8ff]" />
            <span className="text-neutral-400">Architektur:</span>
            <span className="text-[#00e5ff] font-bold">{activeArchitectureLabel}</span>
          </span>

          {stems && (
            <span
              className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#002f1d] border border-[#00c853]/60 text-[#00e676]"
              title={`Echte AI-Stems mit ${stems.modelId} (${stems.profile}) – BS-RoFormer`}
            >
              KI: {stems.separationMethod === 'BS_ROFORMER' ? 'BS-ROFORMER' : stems.separationMethod}
            </span>
          )}

          {showUnavailable && (
            <span
              className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#3a1111] border border-[#ef4444]/60 text-[#fca5a5] flex items-center gap-1 cursor-pointer hover:bg-[#4a1818]"
              title={engineUnavailableReason || 'KI Stem Engine nicht installiert. Klicken zum Installieren.'}
              onClick={onOpenInstaller || onSeparateStems}
            >
              <AlertTriangle size={10} />
              STEM AI NICHT INSTALLIERT
            </span>
          )}

          {stems && (
            <div className="flex items-center space-x-1 text-[10px]">
              <button
                onClick={onSetAcapella}
                className="px-2 py-0.5 rounded bg-[#161922] hover:bg-[#00385e] border border-[#232738] hover:border-[#0088ff] text-neutral-300 hover:text-white transition-colors"
                title="Acapella-Modus: Schaltet alle Instrumente stumm, nur Vocals aktiv"
              >
                Acapella
              </button>
              <button
                onClick={onSetInstrumental}
                className="px-2 py-0.5 rounded bg-[#161922] hover:bg-[#3d2500] border border-[#232738] hover:border-[#ffaa00] text-neutral-300 hover:text-white transition-colors"
                title="Instrumental-Modus: Schaltet Gesang stumm, Drums/Bass/Other aktiv"
              >
                Instrumental
              </button>
              <button
                onClick={onResetStems}
                className="px-2 py-0.5 rounded bg-[#161922] hover:bg-[#252a3a] border border-[#232738] text-neutral-400 hover:text-white transition-colors"
                title="Stems zurücksetzen: Alle 4 Kanäle auf 100% Lautstärke und ungemutet"
              >
                Reset
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center space-x-2 text-[10.5px]">
          {onOpenMidiModal && (
            <button
              onClick={onOpenMidiModal}
              className={`flex items-center space-x-1.5 px-2 py-0.5 rounded border transition-all ${
                isMidiConnected
                  ? 'bg-[#002f1d] border-[#00c853] text-[#00e676] shadow-[0_0_8px_rgba(0,200,83,0.3)]'
                  : 'bg-[#14161f] border-[#292c3a] text-neutral-400 hover:text-white hover:border-[#3d4258]'
              }`}
              title="Pioneer DJ DDJ-FLX4 / DDJ-1000 Hardware Controller & Stem-Pads 1-4 zuweisen"
            >
              <Radio size={11} className={isMidiConnected ? 'animate-pulse' : ''} />
              <span className="font-mono font-semibold">{midiStatusLabel}</span>
              <span className="text-[9px] bg-black/40 px-1 rounded font-mono text-neutral-300">PADS 1-4</span>
            </button>
          )}
        </div>
      </div>

      {!stems ? (
        showUnavailable ? (
          <div className="flex items-center justify-between p-2 bg-[#1a1212] rounded border border-[#7f1d1d]/50">
            <div className="flex items-center space-x-2.5">
              <AlertTriangle size={18} className="text-[#ef4444] shrink-0" />
              <div className="flex flex-col">
                <span className="text-[#fca5a5] text-xs font-bold">
                  KI Stem-Engine ist noch nicht installiert
                </span>
                <span className="text-neutral-400 text-[10.5px] max-w-[650px]">
                  {engineUnavailableReason || 'BS-RoFormer & ONNX Modelle fehlen. Klicken Sie auf „Jetzt installieren", um alle Komponenten einzurichten.'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {onShowDiagnostics && (
                <button
                  onClick={onShowDiagnostics}
                  className="px-2.5 py-1 rounded bg-[#2a1212] hover:bg-[#3a1818] border border-[#7f1d1d] text-[#fca5a5] text-xs font-semibold"
                  title="System-Diagnose für Stem-Runtime ausführen"
                >
                  Diagnose
                </button>
              )}
              <button
                onClick={onOpenInstaller || onSeparateStems}
                disabled={isSeparating}
                className="flex items-center space-x-1.5 px-3.5 py-1 rounded bg-gradient-to-r from-[#10b981] to-[#00c853] hover:from-[#34d399] hover:to-[#00e676] text-black font-extrabold text-xs shadow-md disabled:opacity-50 cursor-pointer"
                title="Öffnet das Installationsfenster zur automatischen Einrichtung aller Stem-Modelle"
              >
                <Download size={13} />
                <span>Jetzt installieren</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between p-1.5 bg-[#12141c] rounded border border-[#202330]">
            <div className="flex items-center space-x-2.5">
              <Cpu size={16} className="text-[#00a2ff]" />
              <div className="flex flex-col">
                <div className="flex items-center space-x-2">
                  <span className="text-white text-xs font-semibold">
                    Stem-Separation bereit – Modus: {activeArchitectureLabel}
                  </span>
                  <span className="text-[9px] font-mono text-[#00e5ff] bg-[#0088ff]/15 px-1.5 py-0.2 rounded border border-[#0088ff]/30">
                    {activeArchitectureBenchmark}
                  </span>
                </div>
                <span className="text-neutral-400 text-[10px]">
                  Echte modellbasierte AI-Separation gemäß Einstellung. Kein spektraler Fallback.
                </span>
              </div>
            </div>
            <button
              onClick={onSeparateStems}
              disabled={isSeparating}
              className="flex items-center space-x-1.5 px-3.5 py-1 rounded bg-gradient-to-r from-[#0088ff] to-[#00c8ff] hover:from-[#0099ff] hover:to-[#22d3ee] text-black font-bold text-xs shadow-md disabled:opacity-50 cursor-pointer transition-all"
              title={`Startet die KI-Separation des geladenen Tracks mit dem gewählten Architekturmodus (${activeArchitectureLabel}).`}
            >
              <Sparkles size={13} className={isSeparating ? 'animate-spin' : ''} />
              <span>{isSeparating ? 'Stems werden getrennt...' : 'Stems jetzt trennen'}</span>
            </button>
          </div>
        )
      ) : (
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
                  <div className="flex items-center space-x-1.5">
                    <span className={isAudible ? cfg.activeText : 'text-neutral-500'}>{cfg.icon}</span>
                    <span className={`text-xs font-bold tracking-wider ${isAudible ? 'text-white' : 'text-neutral-500'}`}>{cfg.label}</span>
                    <span
                      className={`text-[8.5px] font-mono px-1 rounded border ${
                        isAudible ? 'bg-black/50 border-white/20 text-white' : 'bg-black/30 border-transparent text-neutral-600'
                      }`}
                      title={`Pioneer Hardware Controller Performance Pad ${cfg.padNumber}`}
                    >
                      PAD {cfg.padNumber}
                    </span>
                  </div>
                  <div className="flex items-center space-x-1">
                    <button
                      onClick={() => onToggleStemSolo(cfg.id)}
                      className={`w-5 h-5 rounded flex items-center justify-center text-[9.5px] font-mono font-bold transition-all ${
                        state.solo ? 'bg-[#ff9500] text-black' : 'bg-[#181a24] text-neutral-400 hover:text-white border border-[#2b2e3e]'
                      }`}
                      title={`Solo: Schaltet alle anderen Stems stumm, sodass nur ${cfg.label} zu hören ist`}
                    >
                      S
                    </button>
                    <button
                      onClick={() => onToggleStemMute(cfg.id)}
                      className={`w-5 h-5 rounded flex items-center justify-center text-[9.5px] font-mono font-bold transition-all ${
                        state.muted ? 'bg-[#ff3b30] text-white' : 'bg-[#181a24] text-neutral-400 hover:text-white border border-[#2b2e3e]'
                      }`}
                      title={`Mute: Schaltet den ${cfg.label}-Kanal stumm`}
                    >
                      {state.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
                    </button>
                  </div>
                </div>
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
                      title={`Lautstärke für ${cfg.label}: ${Math.round(state.volume * 100)}%`}
                    />
                    <span className="text-[8.5px] font-mono text-neutral-400 w-6 text-right">{Math.round(state.volume * 100)}%</span>
                  </div>
                  <button
                    onClick={() => onExtractStemToClip(cfg.id)}
                    className="flex items-center space-x-0.5 px-1.5 py-0.5 rounded bg-[#1c202d] hover:bg-[#0088ff] text-neutral-300 hover:text-white border border-[#2a2f42] text-[9.5px] font-medium transition-colors"
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
      )}

      {profiles.length > 0 && (
        <div className="mt-1.5 flex items-center space-x-1.5 text-[10px]">
          <span className="uppercase tracking-wider text-neutral-500 font-bold">Qualitätsprofil:</span>
          {profiles.map((profile) => {
            const active = profile.profile === selectedProfile;
            return (
              <button
                key={profile.profile}
                onClick={() => onProfileChange?.(profile.profile)}
                disabled={!profile.available && isSeparating}
                title={`${profile.description}\nModell: ${profile.modelId}\nStems: ${profile.stems.map((s) => s.displayName).join(', ') || '—'}${profile.available ? '' : `\nnicht nutzbar: ${profile.reason}`}`}
                className={`px-2 py-0.5 rounded border font-semibold transition-colors ${
                  active
                    ? 'bg-[#00284a] border-[#00a2ff] text-[#00e5ff]'
                    : profile.available
                    ? 'bg-[#161922] border-[#232738] text-neutral-300 hover:border-[#0088ff] hover:text-white'
                    : 'bg-[#121419] border-[#1f222c] text-neutral-600'
                }`}
              >
                {PROFILE_LABELS[profile.profile] ?? profile.profile}
                {!profile.available && <span className="ml-1 text-[8.5px] text-neutral-500">keine Gewichte</span>}
              </button>
            );
          })}
        </div>
      )}

      {isSeparating && separationProgress && (
        <div className="mt-1.5 bg-[#12141c] p-2 rounded border border-[#0088ff]/40 flex flex-col space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-[#00e5ff] font-medium animate-pulse">{separationProgress.phaseText}</span>
            <span className="flex items-center space-x-2">
              <span className="font-mono text-white font-bold">{separationProgress.percent}%</span>
              {onCancelSeparation && (
                <button
                  onClick={onCancelSeparation}
                  className="px-2 py-0.5 rounded border border-[#7f1d1d] bg-[#2a1113] hover:bg-[#3f1618] text-[#fca5a5] text-[10px] font-semibold transition-colors"
                  title="Laufenden Stem-Separationsprozess abbrechen"
                >
                  Abbrechen
                </button>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 bg-[#1a1c26] rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-[#0088ff] to-[#00e5ff] transition-all duration-150" style={{ width: `${separationProgress.percent}%` }} />
          </div>
        </div>
      )}
    </div>
  );
};
