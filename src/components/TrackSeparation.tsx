/**
 * ACTIVE PART / Stem-Mischer im Pioneer-Look.
 *
 * Die Beschriftung kommt aus der tatsächlichen Separation (stemLabels/stemIds)
 * und wird nicht mehr über die Array-Position geraten: ein externes Modell kann
 * 2 Stems (Vocals/Instrumental) liefern, ein 4-Stem-Modell Vocals/Drums/Bass/
 * Other, die eingebaute Heuristik immer vier.
 */
import React from 'react';

export interface StemColorConfig {
  name: string;
  color: string;
  bg: string;
  border: string;
}

const STEM_COLORS: Record<string, StemColorConfig> = {
  vocals: { name: 'VOCAL', color: '#ff3b8d', bg: 'rgba(255,59,141,0.2)', border: 'rgba(255,59,141,0.5)' },
  drums: { name: 'DRUMS', color: '#00d0ff', bg: 'rgba(0,208,255,0.2)', border: 'rgba(0,208,255,0.5)' },
  bass: { name: 'BASS', color: '#ff9500', bg: 'rgba(255,149,0,0.2)', border: 'rgba(255,149,0,0.5)' },
  other: { name: 'INST', color: '#34c759', bg: 'rgba(52,199,89,0.2)', border: 'rgba(52,199,89,0.5)' },
};

const FALLBACK_COLORS: StemColorConfig[] = [
  STEM_COLORS.vocals,
  STEM_COLORS.drums,
  STEM_COLORS.bass,
  STEM_COLORS.other,
  { name: 'STEM 5', color: '#bf5af2', bg: 'rgba(191,90,242,0.2)', border: 'rgba(191,90,242,0.5)' },
  { name: 'STEM 6', color: '#ffd60a', bg: 'rgba(255,214,10,0.2)', border: 'rgba(255,214,10,0.5)' },
];

export interface TrackSeparationProps {
  stemsActive: boolean;
  stemVolumes: number[];
  onStemVolumeChange: (index: number, vol: number) => void;
  stemsAvailable: boolean;
  /** Klarnamen der Stems, wie die Engine sie geliefert hat. */
  stemLabels?: string[];
  /** Stem-Ids (vocals/drums/bass/other …) für die Farbzuordnung. */
  stemIds?: string[];
  /** Ehrliche Kennzeichnung der Quelle: trainiertes Modell oder Heuristik. */
  qualityTier?: 'TRAINED' | 'HEURISTIC';
  /** Kompakte Darstellung (z. B. im TrackHeader). */
  compact?: boolean;
}

export function stemColorFor(id: string | undefined, index: number): StemColorConfig {
  const byId = id ? STEM_COLORS[String(id).toLowerCase()] : undefined;
  if (byId) return byId;
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

export const TrackSeparation: React.FC<TrackSeparationProps> = ({
  stemVolumes,
  onStemVolumeChange,
  stemsAvailable,
  stemLabels = [],
  stemIds = [],
  qualityTier,
  compact = false,
}) => {
  if (!stemsAvailable) return null;

  return (
    <div
      className={`flex items-center space-x-2 ${compact ? '' : 'ml-4'} px-2 py-1 bg-[#1a1c23] border border-[#2b2d35] rounded`}
      title={
        qualityTier === 'TRAINED'
          ? 'Stems aus einem trainierten Modell (externe Inferenz)'
          : 'Stems aus der eingebauten Heuristik (Mid/Side + Transienten-Gate) – kein KI-Modell'
      }
    >
      <div className="text-[9px] font-bold text-neutral-500 uppercase tracking-wider mr-1">Active Part</div>
      {qualityTier && (
        <span
          className={`text-[8.5px] font-mono px-1 py-px rounded border ${
            qualityTier === 'TRAINED'
              ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
              : 'text-amber-300 border-amber-500/40 bg-amber-500/10'
          }`}
        >
          {qualityTier === 'TRAINED' ? 'KI-MODELL' : 'DSP-HEURISTIK'}
        </span>
      )}
      <div className="flex items-center space-x-1">
        {stemVolumes.map((vol, idx) => {
          const id = stemIds[idx];
          const config = stemColorFor(id, idx);
          const label = (stemLabels[idx] ?? config.name).toUpperCase();
          const isActive = vol > 0;
          return (
            <button
              key={`${id ?? 'stem'}-${idx}`}
              onClick={() => onStemVolumeChange(idx, isActive ? 0 : 1)}
              className="relative px-3 py-1 rounded-[3px] text-[10px] font-bold tracking-wider transition-all cursor-pointer"
              style={{
                backgroundColor: isActive ? config.color : 'transparent',
                color: isActive ? '#fff' : config.color,
                border: `1px solid ${isActive ? config.color : config.border}`,
              }}
              title={`${label} ${isActive ? 'stummschalten' : 'aktivieren'}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
};
