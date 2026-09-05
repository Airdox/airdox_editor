/**
 * @license
 * Clip-Bibliothek (ehemals „Palette“)
 * Rechte Seitenleiste nach Screenshot 01 und 02:
 * - abgeschrägter Reiter mit Titel, Papierkorb oben rechts
 * - Clip-Einträge mit echter Mini-Wellenform, Vorschau-Wiedergabe und Metadaten
 * - jeder Eintrag ist eine Drag-Quelle: ziehen auf die Wellenform fügt ein,
 *   Ziehen in den Deck-Spieler (unten) lädt den Clip dort, mit Alt darüberlegen,
 *   mit Umschalt ersetzen, mit Strg in den Spieler
 * - unten „+“: aktuelle Auswahl als Clip hinzufügen
 * - Ein-/Ausklappen (< / >) auf der Trennlinie
 *
 * Die Einträge entstehen und bleiben über src/audio/clipLibrary konsistent –
 * dieses Bauteil erfindet keine Felder, es zeigt nur, was der Kern berechnet hat.
 */

import React, { useState } from 'react';
import { PaletteClip } from '../types/rekordbox';
import {
  Trash2,
  Play,
  Square,
  Plus,
  ChevronRight,
  ChevronLeft,
  Copy,
  Pencil,
  Disc3,
  CornerUpRight,
  ArrowUp,
  ArrowDown,
  GripVertical,
} from 'lucide-react';
import { audioEngine } from '../audio/audioEngine';
import { amberColorCss } from '../waveform/colors';
import { CLIP_DND_MIME, CLIP_LIBRARY_LABEL, encodeClipDragPayload, clipAudioOf } from '../audio/clipLibrary';
import { pcmToAudioBuffer } from '../audio/pcm';

interface PalettePanelProps {
  isOpen: boolean;
  onToggle: () => void;
  clips: PaletteClip[];
  onAddFromSelection: () => void;
  onDeleteClip: (id: string) => void;
  onSelectClip: (clip: PaletteClip) => void;
  selectedClipId: string | null;
  hasSelection: boolean;
  /** Beschriftung der Bibliothek – eine Quelle, überall identisch. */
  libraryLabel?: string;
  /** Clip, der gerade im Deck-Spieler liegt. */
  deckClipId?: string | null;
  onLoadIntoDeck?: (id: string) => void;
  onInsertAtPlayhead?: (id: string) => void;
  onRenameClip?: (id: string, name: string) => void;
  onDuplicateClip?: (id: string) => void;
  onMoveClip?: (id: string, delta: number) => void;
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
  libraryLabel = CLIP_LIBRARY_LABEL,
  deckClipId = null,
  onLoadIntoDeck,
  onInsertAtPlayhead,
  onRenameClip,
  onDuplicateClip,
  onMoveClip,
}) => {
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);

  const bufferOf = (clip: PaletteClip): AudioBuffer | null => {
    if (clip.audioBuffer) return clip.audioBuffer;
    const pcm = clipAudioOf(clip);
    if (!pcm) return null;
    try {
      return pcmToAudioBuffer(audioEngine.getContext(), pcm);
    } catch {
      return null;
    }
  };

  const handlePreviewClip = (clip: PaletteClip, e: React.MouseEvent) => {
    e.stopPropagation();
    if (playingClipId === clip.id) {
      audioEngine.stop();
      setPlayingClipId(null);
      return;
    }
    const buffer = bufferOf(clip);
    if (buffer) {
      audioEngine.play(buffer, 0, false);
      setPlayingClipId(clip.id);
    }
  };

  const commitRename = (clip: PaletteClip) => {
    if (onRenameClip && draftName.trim() && draftName.trim() !== clip.name) {
      onRenameClip(clip.id, draftName);
    }
    setEditingId(null);
  };

  if (!isOpen) {
    // Eingeklappt (Screenshot 02): schmaler Streifen mit >-Knopf
    return (
      <div className="w-5 bg-[#0e0f13] border-l border-[#1f2129] flex flex-col items-center py-2 select-none z-30">
        <button
          onClick={onToggle}
          className="w-4 h-8 bg-[#181a21] hover:bg-[#252834] text-neutral-400 hover:text-white rounded-xs flex items-center justify-center transition-colors border border-[#2b2d38]"
          title={`${libraryLabel} öffnen`}
        >
          <ChevronLeft size={12} />
        </button>
        {clips.length > 0 && (
          <span className="mt-2 text-[9px] font-mono text-neutral-500 [writing-mode:vertical-rl]">
            {clips.length} CLIPS
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="w-72 bg-[#0e0f13] border-l border-[#1c1e25] flex flex-col select-none relative z-30 flex-shrink-0">
      {/* Klappknopf auf der Trennlinie */}
      <button
        onClick={onToggle}
        className="absolute -left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-7 bg-[#1c1e25] border border-[#2d303a] hover:bg-[#292c37] text-neutral-400 hover:text-white flex items-center justify-center rounded-xs z-40 transition-colors"
        title={`${libraryLabel} einklappen`}
      >
        <ChevronRight size={10} />
      </button>

      {/* Kopf: abgeschrägter Reiter + Papierkorb */}
      <div className="h-7 bg-[#121318] border-b border-[#20222a] flex items-center justify-between px-2">
        <div className="rb-tab-chamfer bg-[#1f2129] text-neutral-200 text-[11px] font-bold px-3 py-1 tracking-wider uppercase">
          {libraryLabel}
        </div>
        <div className="flex items-center space-x-1.5">
          <span className="text-[9px] font-mono text-neutral-500">{clips.length}</span>
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
      </div>

      {/* Clip-Liste */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {clips.length === 0 ? (
          <div className="h-36 flex flex-col items-center justify-center text-center text-neutral-500 text-xs px-4">
            <span>Keine Clips in der {libraryLabel}</span>
            <span className="text-[10px] mt-1 text-neutral-600 leading-relaxed">
              Bereich in der Wellenform markieren und unten auf CLONE oder + klicken.
              Fertige Clips hier einfach auf die Wellenform ziehen.
            </span>
          </div>
        ) : (
          clips.map((clip, index) => {
            const isSelected = selectedClipId === clip.id;
            const isPlaying = playingClipId === clip.id;
            const inDeck = deckClipId === clip.id;
            const isDragging = draggedId === clip.id;
            const hasAudio = clipAudioOf(clip) !== null;

            return (
              <div
                key={clip.id}
                draggable={hasAudio}
                onDragStart={(e) => {
                  if (!hasAudio) {
                    e.preventDefault();
                    return;
                  }
                  e.dataTransfer.setData(CLIP_DND_MIME, encodeClipDragPayload(clip.id));
                  e.dataTransfer.setData('text/plain', encodeClipDragPayload(clip.id));
                  e.dataTransfer.effectAllowed = 'copy';
                  setDraggedId(clip.id);
                }}
                onDragEnd={() => setDraggedId(null)}
                onClick={() => onSelectClip(clip)}
                onDoubleClick={() => {
                  setEditingId(clip.id);
                  setDraftName(clip.name);
                }}
                className={`p-1.5 rounded-xs border transition-all cursor-grab active:cursor-grabbing ${
                  isSelected
                    ? 'bg-[#181a24] border-[#ff9500] shadow-sm'
                    : 'bg-[#14151a] border-[#22242d] hover:border-[#323543]'
                } ${isDragging ? 'opacity-40 border-dashed' : ''}`}
                title={
                  hasAudio
                    ? 'Ziehen: auf die Wellenform = einfügen · Alt = darüberlegen · Umschalt = ersetzen · Strg = in den Deck-Spieler'
                    : 'Dieser Clip hat keine Audiodaten'
                }
              >
                {/* Mini-Wellenform in Bernsteintönen (dieselbe Farbrechnung wie die Spur) */}
                <div className="w-full h-9 bg-[#0b0c0f] rounded-xs mb-1.5 overflow-hidden flex items-center justify-center relative border border-[#1b1c23]">
                  {clip.miniPeaks && clip.miniPeaks.length > 0 ? (
                    <div className="w-full h-full flex items-center px-1">
                      {clip.miniPeaks.map((pk, idx) => {
                        const h = Math.max(2, pk * 30);
                        return (
                          <div
                            key={idx}
                            style={{
                              height: `${h}px`,
                              backgroundColor: amberColorCss(pk, pk, pk * 0.45),
                              boxShadow: pk > 0.72 ? '0 0 3px rgba(255, 219, 168, 0.55)' : undefined,
                            }}
                            className="flex-1 mx-[0.5px] rounded-[0.5px]"
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-[10px] text-neutral-600">keine Vorschau</div>
                  )}

                  {hasAudio && (
                    <GripVertical
                      size={11}
                      className="absolute left-1 top-1/2 -translate-y-1/2 text-neutral-600 pointer-events-none"
                    />
                  )}
                  {isPlaying && (
                    <div className="absolute inset-0 bg-[#ff9500]/10 pointer-events-none animate-pulse" />
                  )}
                  {inDeck && (
                    <div className="absolute right-1 top-1 text-[8px] font-mono px-1 bg-[#ff9500] text-black rounded-[2px]">
                      IM DECK
                    </div>
                  )}
                </div>

                {/* Name, Dauer, Herkunft */}
                <div className="flex items-start justify-between gap-1">
                  <div className="flex items-center space-x-1.5 min-w-0">
                    <button
                      onClick={(e) => handlePreviewClip(clip, e)}
                      disabled={!hasAudio}
                      className={`w-5 h-5 flex items-center justify-center rounded transition-colors disabled:opacity-30 ${
                        isPlaying ? 'bg-[#ff9500] text-black' : 'text-neutral-400 hover:text-white hover:bg-[#252834]'
                      }`}
                      title={isPlaying ? 'Vorschau stoppen' : 'Clip kurz anhören'}
                    >
                      {isPlaying ? <Square size={9} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
                    </button>

                    <div className="flex flex-col min-w-0">
                      {editingId === clip.id ? (
                        <input
                          autoFocus
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={() => commitRename(clip)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') commitRename(clip);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          className="w-40 bg-[#0b0c10] border border-[#ff9500] text-white text-[11px] px-1 rounded-xs outline-none"
                        />
                      ) : (
                        <span className="text-white text-[11.5px] font-medium truncate">{clip.name}</span>
                      )}
                      <span className="text-neutral-500 text-[9.5px] font-mono">
                        {clip.bars.toFixed(1)} Takte • {clip.beats} Beats • {clip.duration.toFixed(2)} s
                      </span>
                    </div>
                  </div>
                  <div
                    className="w-2.5 h-2.5 mt-0.5 rounded-xs border flex-shrink-0"
                    style={{
                      backgroundColor: isSelected ? clip.color : 'transparent',
                      borderColor: clip.color || '#ff9500',
                    }}
                    title={`${clip.key} · ${clip.bpm.toFixed(1)} BPM · aus „${clip.sourceTrackName}“ (${index + 1}. Eintrag)`}
                  />
                </div>

                {/* Ablage: in den Spieler, einfügen, duplizieren, umbenennen,_sortieren */}
                <div className="flex items-center justify-between mt-1.5 pt-1 border-t border-[#1d1f27]">
                  <div className="flex items-center space-x-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onLoadIntoDeck?.(clip.id);
                      }}
                      disabled={!hasAudio}
                      className={`px-1.5 h-5 flex items-center space-x-1 rounded-xs text-[9px] font-medium transition-colors disabled:opacity-30 ${
                        inDeck
                          ? 'bg-[#ff9500] text-black'
                          : 'bg-[#1b1d25] hover:bg-[#2a2d38] text-neutral-300 hover:text-white'
                      }`}
                      title={inDeck ? 'Clip liegt im Deck-Spieler' : 'Clip in den Deck-Spieler laden'}
                    >
                      <Disc3 size={10} />
                      <span>INS DECK</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onInsertAtPlayhead?.(clip.id);
                      }}
                      disabled={!hasAudio}
                      className="w-5 h-5 flex items-center justify-center rounded-xs bg-[#1b1d25] hover:bg-[#252834] text-neutral-300 hover:text-white transition-colors disabled:opacity-30"
                      title="Clip an der Markierung bzw. am Spielkopf einfügen"
                    >
                      <CornerUpRight size={10} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDuplicateClip?.(clip.id);
                      }}
                      className="w-5 h-5 flex items-center justify-center rounded-xs text-neutral-400 hover:text-white hover:bg-[#252834] transition-colors"
                      title="Clip duplizieren (eigene Samples)"
                    >
                      <Copy size={10} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(clip.id);
                        setDraftName(clip.name);
                      }}
                      className="w-5 h-5 flex items-center justify-center rounded-xs text-neutral-400 hover:text-white hover:bg-[#252834] transition-colors"
                      title="Umbenennen (Doppelklick)"
                    >
                      <Pencil size={10} />
                    </button>
                  </div>

                  <div className="flex items-center space-x-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onMoveClip?.(clip.id, -1);
                      }}
                      disabled={index === 0}
                      className="w-4 h-4 flex items-center justify-center rounded-xs text-neutral-500 hover:text-white hover:bg-[#252834] transition-colors disabled:opacity-20"
                      title="In der Liste nach oben"
                    >
                      <ArrowUp size={9} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onMoveClip?.(clip.id, 1);
                      }}
                      disabled={index === clips.length - 1}
                      className="w-4 h-4 flex items-center justify-center rounded-xs text-neutral-500 hover:text-white hover:bg-[#252834] transition-colors disabled:opacity-20"
                      title="In der Liste nach unten"
                    >
                      <ArrowDown size={9} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteClip(clip.id);
                      }}
                      className="w-5 h-5 flex items-center justify-center rounded-xs text-neutral-500 hover:text-[#ff6b6b] hover:bg-[#252834] transition-colors"
                      title="Aus der Bibliothek entfernen (Original bleibt unverändert)"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* Neuer Clip aus der Auswahl */}
        <button
          onClick={onAddFromSelection}
          disabled={!hasSelection}
          className="w-full py-2 bg-[#16171d] border border-dashed border-[#2d303b] hover:border-[#ff9500] hover:bg-[#1d202a] text-neutral-400 hover:text-white rounded-xs flex items-center justify-center text-xs space-x-1.5 transition-all disabled:opacity-40 disabled:hover:border-[#2d303b]"
          title={hasSelection ? 'Auswahl als Clip in die Bibliothek legen' : 'Erst Bereich auswählen'}
        >
          <Plus size={13} />
          <span className="text-[11px] font-medium">Clip hinzufügen</span>
        </button>
      </div>
    </div>
  );
};
