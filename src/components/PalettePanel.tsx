/**
 * @license
 * Rekordbox PalettePanel Component
 * Right-hand clip palette matching Screenshot 01 and 02:
 * - Polygon angled tab header "PALETTE"
 * - Trash can icon on top-right
 * - Clip list items with real mini-waveforms, play preview, and clip metadata
 * - Per-clip INSERT @ PLAYHEAD / REPLACE / OVERDUB action buttons
 * - Bottom "+" button to create clip from current selection
 * - Collapse / Expand toggle (< / >) on the divider border
 */

import React, { useState } from 'react';
import { PaletteClip } from '../types/rekordbox';
import { Trash2, Play, Square, Plus, ChevronRight, ChevronLeft, Maximize2, ArrowRightToLine, Replace, Layers } from 'lucide-react';
import { audioEngine } from '../audio/audioEngine';

interface PalettePanelProps {
  isOpen: boolean;
  onToggle: () => void;
  clips: PaletteClip[];
  onAddFromSelection: () => void;
  onDeleteClip: (id: string) => void;
  onSelectClip: (clip: PaletteClip) => void;
  selectedClipId: string | null;
  hasSelection: boolean;
  onExpandToDeckView?: () => void;
  matchPitch?: boolean;
  onToggleMatchPitch?: (match: boolean) => void;
  targetBpm?: number;
  targetKey?: string;
  onInsertClipToDeckA?: (clip: PaletteClip) => void;
  onReplaceDeckAWithClip?: (clip: PaletteClip) => void;
  onOverdubDeckAWithClip?: (clip: PaletteClip) => void;
  hasSelectionInDeckA?: boolean;
}

export const PalettePanel: React.FC<PalettePanelProps> = ({
  isOpen,
  onToggle,
  clips,
  onAddFromSelection,
  onDeleteClip,
  onSelectClip,
  selectedClipId,
  hasSelection,
  onExpandToDeckView,
  matchPitch = true,
  onToggleMatchPitch,
  targetBpm,
  targetKey,
  onInsertClipToDeckA,
  onReplaceDeckAWithClip,
  onOverdubDeckAWithClip,
  hasSelectionInDeckA = false,
}) => {
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);

  const handlePreviewClip = (clip: PaletteClip, e: React.MouseEvent) => {
    e.stopPropagation();
    if (playingClipId === clip.id) {
      audioEngine.stop();
      setPlayingClipId(null);
    } else {
      if (clip.audioBuffer) {
        audioEngine.play(clip.audioBuffer, 0, false);
        setPlayingClipId(clip.id);
      }
    }
  };

  const stopPreview = () => {
    if (playingClipId) {
      audioEngine.stop();
      setPlayingClipId(null);
    }
  };

  React.useEffect(() => () => stopPreview(), []);

  if (!isOpen) {
    // Collapsed state (Screenshot 02): narrow vertical strip with '<' expand button
    return (
      <div className="w-5 bg-[#0e0f13] border-l border-[#1f2129] flex flex-col items-center py-2 select-none z-30">
        <button
          onClick={onToggle}
          className="w-4 h-8 bg-[#181a21] hover:bg-[#252834] text-neutral-400 hover:text-white rounded-xs flex items-center justify-center transition-colors border border-[#2b2d38]"
          title="Palette öffnen"
        >
          <ChevronLeft size={12} />
        </button>
      </div>
    );
  }

  // Open state (Screenshot 01): 22-25% width
  return (
    <div className="w-80 bg-[#0e0f13] border-l border-[#1c1e25] flex flex-col select-none relative z-30 flex-shrink-0">
      {/* Collapse button on the divider */}
      <button
        onClick={onToggle}
        className="absolute -left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-7 bg-[#1c1e25] border border-[#2d303a] hover:bg-[#292c37] text-neutral-400 hover:text-white flex items-center justify-center rounded-xs z-40 transition-colors"
        title="Palette einklappen"
      >
        <ChevronRight size={10} />
      </button>

      {/* Top Header: Angled Polygon "PALETTE" tab & Action buttons */}
      <div className="h-7 bg-[#121318] border-b border-[#20222a] flex items-center justify-between px-2">
        <div className="flex items-center space-x-2">
          <div className="rb-tab-chamfer bg-[#1f2129] text-neutral-200 text-[11px] font-bold px-3 py-1 tracking-wider uppercase">
            PALETTE
          </div>

          {onExpandToDeckView && (
            <button
              onClick={onExpandToDeckView}
              className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-[#1a2333] hover:bg-[#223048] border border-[#263c5c] text-[#00a2ff] text-[10px] font-bold transition-colors"
              title="Clip-Bibliothek zur vollständigen Deck-Ansicht ausklappen"
            >
              <Maximize2 size={10} />
              <span>Deck-Ansicht</span>
            </button>
          )}
        </div>

        <button
          onClick={() => {
            if (selectedClipId) onDeleteClip(selectedClipId);
          }}
          disabled={!selectedClipId}
          className="p-1 text-neutral-400 hover:text-white disabled:opacity-30 transition-colors"
          title="Ausgewählten Clip löschen"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Cross-Track Import Adaptation Bar */}
      <div className="bg-[#11131a] border-b border-[#1f212c] px-2.5 py-1.5 flex flex-col space-y-1 text-[10px]">
        <div className="flex items-center justify-between">
          {onToggleMatchPitch && (
            <label className="flex items-center space-x-1.5 cursor-pointer group select-none">
              <input
                type="checkbox"
                checked={matchPitch}
                onChange={(e) => onToggleMatchPitch(e.target.checked)}
                className="w-3 h-3 rounded-xs accent-[#0088ff] cursor-pointer"
              />
              <span className={`text-[10px] font-medium transition-colors ${
                matchPitch ? 'text-[#00e5ff]' : 'text-neutral-400 group-hover:text-neutral-300'
              }`}>
                Key Sync
              </span>
            </label>
          )}
          {targetKey && (
            <span className="font-mono text-[9px] bg-[#1a1d26] px-1.5 py-0.2 rounded text-neutral-400 border border-[#2b2e3b]">
              Ziel: {targetKey}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between text-[9px] text-neutral-500 font-mono">
          <span>Einsatz:</span>
          <span className="text-[#00c853]">Auto-Sync {targetBpm ? `${targetBpm.toFixed(1)} BPM` : 'an Deck'}</span>
        </div>
      </div>

      {/* Legend / Action hint row */}
      <div className="bg-[#0c0d12] border-b border-[#1a1c23] px-2 py-1 flex items-center justify-between text-[9px] font-mono text-neutral-500">
        <span>INSERT @ ▶</span>
        <span className="text-neutral-600">|</span>
        <span>REPLACE</span>
        <span className="text-neutral-600">|</span>
        <span>OVERDUB</span>
      </div>

      {/* Clips List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {clips.length === 0 ? (
          <div className="h-32 flex flex-col items-center justify-center text-center text-neutral-500 text-xs px-4">
            <span>Keine Clips in der Palette</span>
            <span className="text-[10px] mt-1 text-neutral-600">
              Bereich markieren und CLONE oder + klicken
            </span>
          </div>
        ) : (
          clips.map((clip) => {
            const isSelected = selectedClipId === clip.id;
            const isPlaying = playingClipId === clip.id;

            return (
              <div
                key={clip.id}
                onClick={() => onSelectClip(clip)}
                className={`p-1.5 rounded-xs border transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-[#181a24] border-[#0088ff] shadow-sm'
                    : 'bg-[#14151a] border-[#22242d] hover:border-[#323543]'
                }`}
              >
                {/* Mini Waveform Display */}
                <div className="w-full h-9 bg-[#0b0c0f] rounded-xs mb-1.5 overflow-hidden flex items-center justify-center relative border border-[#1b1c23]">
                  {clip.miniPeaks && clip.miniPeaks.length > 0 ? (
                    <div className="w-full h-full flex items-center px-1">
                      {clip.miniPeaks.map((pk, idx) => {
                        const h = Math.max(2, pk * 28);
                        const col =
                          idx % 3 === 0
                            ? '#ff3b30'
                            : idx % 3 === 1
                            ? '#00e5ff'
                            : '#0088ff';
                        return (
                          <div
                            key={idx}
                            style={{ height: `${h}px`, backgroundColor: col }}
                            className="flex-1 mx-[0.5px] rounded-[0.5px]"
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-[10px] text-neutral-600">Clip Waveform</div>
                  )}
                  {isPlaying && (
                    <div className="absolute inset-0 bg-[#00c853]/10 pointer-events-none animate-pulse" />
                  )}
                </div>

                {/* Name + Meta */}
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center space-x-2 truncate">
                    <button
                      onClick={(e) => handlePreviewClip(clip, e)}
                      className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${
                        isPlaying
                          ? 'bg-[#00c853] text-black'
                          : 'text-neutral-400 hover:text-white hover:bg-[#252834]'
                      }`}
                      title={isPlaying ? 'Stop' : 'Play Preview'}
                    >
                      {isPlaying ? <Square size={9} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
                    </button>
                    <div className="flex flex-col truncate">
                      <span className="text-white text-[11px] font-medium truncate">{clip.name}</span>
                      <span className="text-neutral-500 text-[9px] font-mono">
                        {clip.bars.toFixed(1)} Bars · {clip.beats} Beats · {clip.duration.toFixed(2)}s
                      </span>
                    </div>
                  </div>
                  <div className={`w-2.5 h-2.5 rounded-xs border ${isSelected ? 'bg-[#0088ff] border-[#0088ff]' : 'border-neutral-600'}`} />
                </div>

                {/* Per-clip Action Buttons */}
                <div className="flex items-center space-x-1 pt-1 border-t border-[#1c1e25]">
                  <button
                    onClick={(e) => { e.stopPropagation(); stopPreview(); onInsertClipToDeckA?.(clip); }}
                    className="flex-1 flex items-center justify-center space-x-0.5 py-1 rounded-[3px] bg-[#0f2a1a] hover:bg-[#143d26] border border-[#1a5032] text-[#00c853] text-[9.5px] font-bold transition-colors"
                    title="Clip an Playhead-Position in Deck A einfügen (öffnet Zeit)"
                  >
                    <ArrowRightToLine size={10} />
                    <span>INSERT @ ▶</span>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); stopPreview(); onReplaceDeckAWithClip?.(clip); }}
                    disabled={!hasSelectionInDeckA}
                    className="flex-1 flex items-center justify-center space-x-0.5 py-1 rounded-[3px] bg-[#1a1408] hover:bg-[#2d210d] border border-[#4a3512] text-[#ffb020] text-[9.5px] font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title={hasSelectionInDeckA ? 'Auswahl in Deck A durch diesen Clip ersetzen' : 'Zuerst einen Bereich in Deck A auswählen'}
                  >
                    <Replace size={10} />
                    <span>REPLACE</span>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); stopPreview(); onOverdubDeckAWithClip?.(clip); }}
                    disabled={!hasSelectionInDeckA}
                    className="flex-1 flex items-center justify-center space-x-0.5 py-1 rounded-[3px] bg-[#10162a] hover:bg-[#182244] border border-[#24315c] text-[#7ea7ff] text-[9.5px] font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title={hasSelectionInDeckA ? 'Clip über Auswahl mischen (Overdub)' : 'Zuerst einen Bereich in Deck A auswählen'}
                  >
                    <Layers size={10} />
                    <span>OVERDUB</span>
                  </button>
                </div>
              </div>
            );
          })
        )}

        <button
          onClick={onAddFromSelection}
          disabled={!hasSelection}
          className="w-full py-2 bg-[#16171d] border border-dashed border-[#2d303b] hover:border-[#0088ff] hover:bg-[#1d202a] text-neutral-400 hover:text-white rounded-xs flex items-center justify-center text-xs space-x-1.5 transition-all disabled:opacity-40 disabled:hover:border-[#2d303b]"
          title={hasSelection ? 'Auswahl als Clip zur Palette hinzufügen' : 'Erst Bereich auswählen'}
        >
          <Plus size={13} />
          <span className="text-[11px] font-medium">Clip aus Auswahl hinzufügen</span>
        </button>
      </div>
    </div>
  );
};
