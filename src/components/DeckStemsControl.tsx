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
  StemEngineProfileInfo,
  StemQualityProfile,
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
  /** Bricht einen laufenden Separations-Job ab (nur Engine-Pfad möglich). */
  onCancelSeparation?: () => void;
  /** Profil-Auswahl der neuen Engine – Liste und Stems stammen aus dem Katalog. */
  profiles?: StemEngineProfileInfo[];
  selectedProfile?: StemQualityProfile;
  onProfileChange?: (profile: StemQualityProfile) => void;
}

/** Labels der Qualitätsprofile (Kern-Profile, 1:1 aus `src/stems`). */
const PROFILE_LABELS: Record<StemQualityProfile, string> = {
  PREVIEW: 'Vorschau',
  HIGH_QUALITY: 'HQ',
  MAXIMUM_QUALITY: 'Max',
};

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
  onCancelSeparation,
  profiles = [],
  selectedProfile = 'PREVIEW',
  onProfileChange,
}) => {
  // Die sichtbare Stem-Liste folgt dem Modell-Deskriptor (`stems.stemIds`);
  // STEM_TYPES ist nur der Default, bevor getrennt wurde. Ein Modell mit zwei
  // Stems zeigt also zwei Buttons – ohne dass hier eine Zahl stünde.
  const stemIds: StemType[] = ((stems?.stemIds ?? STEM_TYPES) as string[]) as StemType[];
  const visibleConfigs: StemVisualConfig[] = stemIds.map((id, index) => {
    const known = STEM_CONFIGS.find((cfg) => cfg.id === id);
    return (
      known ?? {
        id,
        label: String(id).toUpperCase(),
        sublabel: 'Stem aus dem Modell-Deskriptor (kein Legacy-Mixer-Slot)',
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

          {/* Engine/Quality badge: never let fallback stems pose as AI stems */}
          {stems && (
            stems.separationMethod === 'DEMUCS_HTDEMUCS_FT' ? (
              <span
                className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#002f1d] border border-[#00c853]/60 text-[#00e676]"
                title="Diese Stems wurden mit dem trainierten KI-Modell Demucs htdemucs_ft erzeugt (Performance-Qualität)."
              >
                KI: DEMUCS
              </span>
            ) : (
              <span
                className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#3a2410] border border-[#f59e0b]/60 text-[#fbbf24] animate-pulse"
                title={`Nur Vorschau-Qualität: lokaler STFT-Fallback (HPSS + Spektralmasken), NICHT performancetauglich.${stems.fallbackReason ? ` Grund: ${stems.fallbackReason}` : ''} Für KI-Qualität "npm run stems:setup" ausführen.`}
              >
                ⚠ FALLBACK-QUALITÄT
              </span>
            )
          )}

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
                Stem-Separation bereit
              </span>
              <span className="text-neutral-400 text-[10px]">
                KI-Modell Demucs htdemucs_ft. Fehlt die Installation, wirst du vor dem Start gewarnt.
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
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${visibleConfigs.length}, minmax(0, 1fr))` }}
        >
          {visibleConfigs.map((cfg) => {
            const state = mixerState[cfg.id] ?? { muted: false, solo: false, volume: 1 };
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

      {/* Qualitaetsprofil (nur die Profile, die der Kern meldet) */}
      {profiles.length > 0 && (
        <div className="mt-1.5 flex items-center space-x-1.5 text-[10px]">
          <span className="uppercase tracking-wider text-neutral-500 font-bold">Profil</span>
          {profiles.map((profile) => {
            const active = profile.profile === selectedProfile;
            return (
              <button
                key={profile.profile}
                onClick={() => onProfileChange?.(profile.profile)}
                disabled={!profile.available && isSeparating}
                title={`${profile.description}
Modell: ${profile.modelId}
Stems: ${profile.stems.map((stem) => stem.displayName).join(', ') || '—'}${profile.available ? '' : `
nicht nutzbar: ${profile.reason}`}`}
                className={`px-2 py-0.5 rounded border font-semibold transition-colors ${
                  active
                    ? 'bg-[#00284a] border-[#00a2ff] text-[#00e5ff]'
                    : profile.available
                      ? 'bg-[#161922] border-[#232738] text-neutral-300 hover:border-[#0088ff] hover:text-white'
                      : 'bg-[#121419] border-[#1f222c] text-neutral-600'
                }`}
              >
                {PROFILE_LABELS[profile.profile]}
                {!profile.available && <span className="ml-1 text-[8.5px] text-neutral-500">keine Gewichte</span>}
              </button>
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
            <span className="flex items-center space-x-2">
              <span className="font-mono text-white font-bold">
                {separationProgress.percent}%
              </span>
              {onCancelSeparation && (
                <button
                  onClick={onCancelSeparation}
                  className="px-2 py-0.5 rounded border border-[#7f1d1d] bg-[#2a1113] hover:bg-[#3f1618] text-[#fca5a5] text-[10px] font-semibold transition-colors"
                  title="Bricht den Separations-Job ab – das Original bleibt unverändert, kein halbfertiger Stem wird übernommen."
                >
                  Abbrechen
                </button>
              )}
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
