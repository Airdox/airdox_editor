import React from 'react';

export interface TrackSeparationProps {
  stemsActive: boolean;
  stemVolumes: number[];
  onStemVolumeChange: (index: number, vol: number) => void;
  stemsAvailable: boolean;
  /**
   * Real stem ids from the engine, parallel to `stemVolumes`.
   * Labels are derived from these — never from the array index, because the
   * stem order depends on the model and a positional guess silently mislabels
   * (e.g. showing "VOCAL" on the drums stem).
   */
  stemIds?: string[];
}

interface StemStyle { name: string; color: string; border: string; }

const STEM_STYLES: Record<string, StemStyle> = {
  vocals: { name: 'VOCAL', color: '#ff3b8d', border: 'rgba(255,59,141,0.5)' },
  drums: { name: 'DRUMS', color: '#00d0ff', border: 'rgba(0,208,255,0.5)' },
  bass: { name: 'BASS', color: '#ff9500', border: 'rgba(255,149,0,0.5)' },
  other: { name: 'INST', color: '#34c759', border: 'rgba(52,199,89,0.5)' },
  instrumental: { name: 'INST', color: '#34c759', border: 'rgba(52,199,89,0.5)' },
  guitar: { name: 'GTR', color: '#c084fc', border: 'rgba(192,132,252,0.5)' },
  piano: { name: 'PIANO', color: '#fbbf24', border: 'rgba(251,191,36,0.5)' },
  percussion: { name: 'PERC', color: '#38bdf8', border: 'rgba(56,189,248,0.5)' },
  synth: { name: 'SYNTH', color: '#a3e635', border: 'rgba(163,230,53,0.5)' },
  fx: { name: 'FX', color: '#f472b6', border: 'rgba(244,114,182,0.5)' },
};

const FALLBACK: StemStyle = { name: 'STEM', color: '#9ca3af', border: 'rgba(156,163,175,0.5)' };

/** Unknown ids still get a readable label instead of a wrong one. */
function styleFor(stemId: string | undefined): StemStyle {
  if (!stemId) return FALLBACK;
  const known = STEM_STYLES[stemId.toLowerCase()];
  if (known) return known;
  return { ...FALLBACK, name: stemId.slice(0, 6).toUpperCase() };
}

export const TrackSeparation: React.FC<TrackSeparationProps> = ({
  stemVolumes,
  onStemVolumeChange,
  stemsAvailable,
  stemIds = [],
}) => {
  if (!stemsAvailable) return null;

  return (
    <div className="flex items-center space-x-2 ml-4 px-2 py-1 bg-[#1a1c23] border border-[#2b2d35] rounded">
      <div className="text-[9px] font-bold text-neutral-500 uppercase tracking-wider mr-1">
        Active Part
      </div>
      <div className="flex items-center space-x-1">
        {stemVolumes.map((vol, idx) => {
          const stemId = stemIds[idx];
          const config = styleFor(stemId);
          const isActive = vol > 0;
          return (
            <button
              key={stemId ?? idx}
              onClick={() => onStemVolumeChange(idx, isActive ? 0 : 1)}
              title={stemId ? `${stemId}${isActive ? ' (aktiv)' : ' (stumm)'}` : undefined}
              aria-pressed={isActive}
              className="relative px-3 py-1 rounded-[3px] text-[10px] font-bold tracking-wider transition-all"
              style={{
                backgroundColor: isActive ? config.color : 'transparent',
                color: isActive ? '#fff' : config.color,
                border: `1px solid ${isActive ? config.color : config.border}`,
              }}
            >
              {config.name}
            </button>
          );
        })}
      </div>
    </div>
  );
};
