import React from 'react';

export interface TrackSeparationProps {
  stemsActive: boolean;
  stemVolumes: number[];
  onStemVolumeChange: (index: number, vol: number) => void;
  stemsAvailable: boolean;
}

export const TrackSeparation: React.FC<TrackSeparationProps> = ({
  stemsActive,
  stemVolumes,
  onStemVolumeChange,
  stemsAvailable
}) => {
  if (!stemsAvailable) return null;

  // Rekordbox Active Part standard mapping:
  // Usually 3 buttons: VOCAL (Pink), INST (Green), DRUMS (Blue)
  // Our audio-separator often yields 4 stems: Vocals, Drums, Bass, Other.
  // We'll map them dynamically but maintain the Pioneer aesthetic.

  const getStemNameAndColor = (idx: number) => {
    // Assuming order or we can just use generic labels if we don't know the exact names.
    // In our App.tsx we passed stemVolumes which corresponds to the array of stems.
    // We don't have the names here directly unless we pass them.
    // For now, let's use generic Active Part styling.
    const colors = [
      { name: 'VOCAL', color: '#ff3b8d', bg: 'rgba(255,59,141,0.2)', border: 'rgba(255,59,141,0.5)' },
      { name: 'DRUMS', color: '#00d0ff', bg: 'rgba(0,208,255,0.2)', border: 'rgba(0,208,255,0.5)' },
      { name: 'BASS',  color: '#ff9500', bg: 'rgba(255,149,0,0.2)', border: 'rgba(255,149,0,0.5)' },
      { name: 'INST',  color: '#34c759', bg: 'rgba(52,199,89,0.2)', border: 'rgba(52,199,89,0.5)' },
    ];
    return colors[idx % colors.length];
  };

  return (
    <div className="flex items-center space-x-2 ml-4 px-2 py-1 bg-[#1a1c23] border border-[#2b2d35] rounded">
      <div className="text-[9px] font-bold text-neutral-500 uppercase tracking-wider mr-1">
        Active Part
      </div>
      <div className="flex items-center space-x-1">
        {stemVolumes.map((vol, idx) => {
          const config = getStemNameAndColor(idx);
          const isActive = vol > 0;
          return (
            <button
              key={idx}
              onClick={() => onStemVolumeChange(idx, isActive ? 0 : 1)}
              className="relative px-3 py-1 rounded-[3px] text-[10px] font-bold tracking-wider transition-all"
              style={{
                backgroundColor: isActive ? config.color : 'transparent',
                color: isActive ? '#fff' : config.color,
                border: `1px solid ${isActive ? config.color : config.border}`
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
