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
 * - Rechtsklick auf einen Clip: was mit ihm passieren soll (Ablage, Pflege, Export)
 * - „Deck-Ansicht“: die Bibliothek lässt sich zu einem vollständigen Spieler für
 *   den ausgewählten Clip aufklappen – dieselben Funktionen wie der zentrale
 *   Deck-Spieler, weil es *derselbe* Spieler ist (Transport, Schleife, Vorschau
 *   „wie eingefügt“ mit Tempo- und Pegelangleichung).
 *
 * Die Einträge entstehen und bleiben über src/audio/clipLibrary konsistent –
 * dieses Bauteil erfindet keine Felder, es zeigt nur, was der Kern berechnet hat.
 */

import React, { useEffect, useState } from 'react';
import { PaletteClip } from '../types/rekordbox';
import {
  Trash2,
  Play,
  Pause,
  Square,
  Plus,
  ChevronRight,
  ChevronLeft,
  Copy,
  Pencil,
  Download,
  Gauge,
  Layers,
  Replace,
  Disc3,
  CornerUpRight,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  ArrowDownToLine,
  GripVertical,
  Maximize2,
  Minimize2,
  Repeat,
  SkipBack,
  Eraser,
  Check,
  X,
} from 'lucide-react';
import { audioEngine } from '../audio/audioEngine';
import { AMBER_HOT_GLOW, amberColorCss } from '../waveform/colors';
import {
  CLIP_DND_MIME,
  CLIP_DROP_LABELS,
  CLIP_LIBRARY_LABEL,
  ClipDropMode,
  clipAudioOf,
  describeClip,
  describeClipFit,
  describeClipLevel,
  encodeClipDragPayload,
} from '../audio/clipLibrary';
import { pcmToAudioBuffer } from '../audio/pcm';

/** Kommandos der Deck-Ansicht – die App bleibt der einzige Besitzer des Spielers. */
export type ClipDeckCommand =
  | { type: 'load'; clipId: string }
  | { type: 'togglePlay' }
  | { type: 'stop' }
  | { type: 'returnToStart' }
  | { type: 'seek'; seconds: number }
  | { type: 'loopToggle' }
  | { type: 'loopEdge'; edge: 'in' | 'out' }
  | { type: 'loopClear' }
  | { type: 'preview'; fitted: boolean }
  | { type: 'apply'; clipId: string; mode: 'insert' | 'replace' | 'overdub' }
  | { type: 'toggleTempoMatch' }
  | { type: 'togglePitchFollow' };

/** Stand des Spielers, wie ihn die Deck-Ansicht zeigt. */
export interface ClipDeckState {
  clipId: string;
  clipName: string;
  /** Tempo, aus dem der Clip stammt. */
  clipBpm: number;
  position: number;
  duration: number;
  isPlaying: boolean;
  loopActive: boolean;
  loop: { start: number; end: number } | null;
  loopMark: number | null;
  /** true: es läuft der angeglichene Vorschau-Puffer, nicht das Clip-Original. */
  previewFitted: boolean;
  /** ratio Zieltempo / Quelltempo (1, wenn nichts angepasst wird). */
  fitSpeed: number;
  peaks: number[];
  /** Klartext, was die Anpassung tut – aus dem Kern, nicht erfunden. */
  level: string;
}

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
  /**
   * Clip aus dem Kontextmenü an der aktuellen Zielzeit ablegen – dieselben
   * Modi wie beim Ablage-Weg per Drag & Drop (einfügen / darüberlegen / ersetzen).
   */
  onApplyClipAt?: (id: string, mode: Exclude<ClipDropMode, 'deck'>) => void;
  /** Clip als WAV-Datei speichern (Dialog in der Desktop-App, Download im Browser). */
  onExportClip?: (id: string) => void;
  /** Clip aus dem Deck-Spieler entladen. */
  onUnloadFromDeck?: () => void;
  /** Tempoangleichung beim Ablagen (Schalter der Oberfläche). */
  tempoMatch?: boolean;
  /** Tonhöhe folgt dem Tempo. */
  pitchFollow?: boolean;
  /** Tempo der Zielspur; 0 = kein Raster, dann ist nichts anzupassen. */
  targetBpm?: number;
  targetTrackName?: string | null;
  /** Aufgeklappte Deck-Ansicht. */
  deckViewOpen?: boolean;
  onToggleDeckView?: () => void;
  deck?: ClipDeckState | null;
  onDeckCommand?: (command: ClipDeckCommand) => void;
}

/** Aktionen des Kontextmenüs – Reihenfolge ist zugleich die Tastenreihenfolge. */
type ClipMenuAction =
  | 'insert'
  | 'overdub'
  | 'replace'
  | 'deck'
  | 'unload'
  | 'export'
  | 'duplicate'
  | 'rename'
  | 'up'
  | 'down'
  | 'delete'
  | 'deckView'
  | 'tempoMatch'
  | 'pitchFollow';

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
  onApplyClipAt,
  onExportClip,
  onUnloadFromDeck,
  tempoMatch = true,
  pitchFollow = false,
  targetBpm = 0,
  targetTrackName = null,
  deckViewOpen = false,
  onToggleDeckView,
  deck = null,
  onDeckCommand,
}) => {
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  /** Offenes Kontextmenü (rechte Maustaste) – Position in Kundenkoordinaten. */
  const [menu, setMenu] = useState<{ x: number; y: number; clipId: string } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const openMenu = (clip: PaletteClip, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSelectClip(clip);
    const width = 252;
    const height = 430;
    setMenu({
      x: Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(event.clientY, Math.max(6, window.innerHeight - height - 6))),
      clipId: clip.id,
    });
  };

  const runMenuAction = (action: ClipMenuAction) => {
    const clip = menu ? clips.find((entry) => entry.id === menu.clipId) ?? null : null;
    setMenu(null);
    if (!clip) return;
    switch (action) {
      case 'insert':
      case 'overdub':
      case 'replace':
        onApplyClipAt?.(clip.id, action);
        break;
      case 'deck':
        // Direkt mit aufgeklappter Deck-Ansicht, falls die App das anbietet.
        if (onDeckCommand) onDeckCommand({ type: 'load', clipId: clip.id });
        else onLoadIntoDeck?.(clip.id);
        break;
      case 'deckView':
        if (!deckViewOpen) onDeckCommand?.({ type: 'load', clipId: clip.id });
        else onToggleDeckView?.();
        break;
      case 'tempoMatch':
        onDeckCommand?.({ type: 'toggleTempoMatch' });
        break;
      case 'pitchFollow':
        onDeckCommand?.({ type: 'togglePitchFollow' });
        break;
      case 'unload':
        onUnloadFromDeck?.();
        break;
      case 'export':
        onExportClip?.(clip.id);
        break;
      case 'duplicate':
        onDuplicateClip?.(clip.id);
        break;
      case 'rename':
        setEditingId(clip.id);
        setDraftName(clip.name);
        break;
      case 'up':
        onMoveClip?.(clip.id, -1);
        break;
      case 'down':
        onMoveClip?.(clip.id, 1);
        break;
      case 'delete':
        onDeleteClip(clip.id);
        break;
    }
  };

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

  const deckBtn =
    'h-5 px-1.5 flex items-center gap-1 rounded-xs bg-[#1b1d25] hover:bg-[#2a2d38] text-neutral-300 hover:text-white transition-colors text-[9px] font-medium disabled:opacity-30 disabled:hover:bg-[#1b1d25]';
  const deckBtnOn = 'h-5 px-1.5 flex items-center gap-1 rounded-xs bg-[#ff9500] text-black text-[9px] font-medium';

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
              if (!deckViewOpen && !deck && selectedClipId) onDeckCommand?.({ type: 'load', clipId: selectedClipId });
              onToggleDeckView?.();
            }}
            disabled={clips.length === 0}
            className={`p-1 transition-colors disabled:opacity-30 ${
              deckViewOpen ? 'text-[#ff9500] hover:text-white' : 'text-neutral-400 hover:text-white'
            }`}
            title={deckViewOpen ? 'Deck-Ansicht einklappen' : 'Deck-Ansicht aufklappen (Spieler für den ausgewählten Clip)'}
          >
            {deckViewOpen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
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


      {/* Anpassung beim Ablagen: Pegel rechnet der Kern immer, Tempo und Tonhöhe sind Schalter */}
      <div className="px-2 py-1.5 border-b border-[#20222a] bg-[#101116] space-y-1">
        <label
          className="flex items-start gap-1.5 cursor-pointer group"
          title="Clip-Dauer auf das Tempo der Zielspur bringen (Phasenvocoder, Tonhöhe bleibt). Betrifft nur Clips aus einer anderen Spur bzw. einem anderen Tempo."
        >
          <input
            type="checkbox"
            checked={tempoMatch}
            onChange={() => onDeckCommand?.({ type: 'toggleTempoMatch' })}
            className="mt-0.5 w-3 h-3 accent-[#ff9500]"
          />
          <span className="text-[10px] leading-tight text-neutral-300 group-hover:text-white">
            Tempo an Zielspur anpassen
            <span className="block text-[9px] font-mono text-neutral-500" title={targetTrackName ?? ''}>
              {targetBpm > 0
                ? `Ziel: ${targetTrackName ? `${targetTrackName.slice(0, 18)} · ` : ''}${targetBpm.toFixed(1)} BPM`
                : 'Zielspur ohne Beat-Raster'}
            </span>
          </span>
        </label>
        <label
          className="flex items-center gap-1.5 cursor-pointer group"
          title="Key-Lock aus: Tonhöhe wandert mit dem Tempo wie beim Plattenspieler. Aus lassen heißt: Tonhöhe halten."
        >
          <input
            type="checkbox"
            checked={pitchFollow}
            disabled={!tempoMatch}
            onChange={() => onDeckCommand?.({ type: 'togglePitchFollow' })}
            className="w-3 h-3 accent-[#ff9500] disabled:opacity-30"
          />
          <span
            className={`text-[10px] leading-tight disabled:opacity-40 ${
              pitchFollow && tempoMatch ? 'text-[#ffb74d]' : 'text-neutral-300 group-hover:text-white'
            }`}
          >
            Tonhöhe mit anpassen <span className="text-[9px] font-mono text-neutral-500">(Key-Lock aus)</span>
          </span>
        </label>
      </div>

      {/* Deck-Ansicht: derselbe Spieler, hier vollständig bedienbar */}
      {deckViewOpen && (
        <div className="border-b border-[#20222a] bg-[#0b0c10] px-2 py-2 space-y-1.5" aria-label="Deck-Ansicht der Clip-Bibliothek">
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-1 min-w-0 text-[10px] font-bold text-neutral-200">
              <Disc3 size={11} className={deck ? 'text-[#ff9500]' : 'text-neutral-600'} />
              <span className="truncate" title={deck?.clipName ?? ''}>{deck ? deck.clipName : 'kein Clip geladen'}</span>
            </div>
            <button onClick={onToggleDeckView} className="p-0.5 text-neutral-400 hover:text-white transition-colors" title="Deck-Ansicht einklappen">
              <Minimize2 size={12} />
            </button>
          </div>

          {deck ? (
            (() => {
              const duration = Math.max(0.001, deck.duration);
              const bpmEff = deck.clipBpm > 0 ? deck.clipBpm * (deck.previewFitted ? deck.fitSpeed || 1 : 1) : 0;
              const beats = bpmEff > 0 ? deck.position / (60 / bpmEff) : 0;
              const pct = (value: number) => `${Math.max(0, Math.min(100, (value / duration) * 100))}%`;
              const seek = (event: React.MouseEvent<HTMLDivElement>) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const fraction = (event.clientX - rect.left) / Math.max(1, rect.width);
                onDeckCommand?.({ type: 'seek', seconds: Math.max(0, Math.min(duration - 0.001, fraction * duration)) });
              };
              return (
                <>
                  <div
                    className="relative h-11 bg-[#0a0806] border border-[#22242d] rounded-xs overflow-hidden cursor-pointer"
                    onClick={seek}
                    title="Klicken = im Clip springen · Schatten = Schleifenregion"
                  >
                    <div className="absolute inset-0 flex items-center px-px">
                      {(deck.peaks.length > 0 ? deck.peaks : [0]).map((pk, i) => (
                        <div
                          key={i}
                          style={{ height: `${Math.max(2, pk * 34)}px`, backgroundColor: amberColorCss(pk, pk, pk * 0.45) }}
                          className="flex-1 mx-[0.5px] rounded-[0.5px]"
                        />
                      ))}
                    </div>
                    {deck.loopActive && deck.loop && (
                      <div
                        className="absolute inset-y-0 bg-[#ff9500]/15 border-x border-[#ff9500]/60 pointer-events-none"
                        style={{ left: pct(deck.loop.start), width: pct(Math.max(0, deck.loop.end - deck.loop.start)) }}
                      />
                    )}
                    <div className="absolute inset-y-0 w-px bg-white pointer-events-none" style={{ left: pct(deck.position) }} />
                  </div>

                  <div className="flex items-center gap-1">
                    <button onClick={() => onDeckCommand?.({ type: 'returnToStart' })} className={deckBtn} title="An den Clip-Anfang">
                      <SkipBack size={10} />
                    </button>
                    <button
                      onClick={() => onDeckCommand?.({ type: 'togglePlay' })}
                      className={deck.isPlaying ? deckBtnOn : deckBtn}
                      title={deck.isPlaying ? 'Pause' : 'Wiedergabe (der Spur-Transport stoppt dabei)'}
                    >
                      {deck.isPlaying ? <Pause size={10} /> : <Play size={10} fill="currentColor" />}
                    </button>
                    <button onClick={() => onDeckCommand?.({ type: 'stop' })} className={deckBtn} title="Stop">
                      <Square size={10} fill="currentColor" />
                    </button>
                    <div className="ml-auto text-right font-mono text-[9px] leading-tight text-neutral-400">
                      <div className="text-white">{deck.position.toFixed(3)} / {duration.toFixed(3)} s</div>
                      <div>
                        {bpmEff > 0
                          ? `Takt ${Math.floor(beats / 4) + 1}.${Math.floor(beats % 4) + 1} · ${bpmEff.toFixed(1)} BPM`
                          : 'ohne Raster'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onDeckCommand?.({ type: 'loopToggle' })}
                      className={deck.loopActive ? deckBtnOn : deckBtn}
                      title="Schleife an/aus – ohne gesetzte Region loopt der ganze Clip"
                    >
                      <Repeat size={10} />
                      <span>LOOP</span>
                    </button>
                    <button onClick={() => onDeckCommand?.({ type: 'loopEdge', edge: 'in' })} className={deckBtn} title="Schleifenanfang an der aktuellen Position">
                      <span>IN</span>
                    </button>
                    <button onClick={() => onDeckCommand?.({ type: 'loopEdge', edge: 'out' })} className={deckBtn} title="Schleifenende an der aktuellen Position">
                      <span>OUT</span>
                    </button>
                    <button onClick={() => onDeckCommand?.({ type: 'loopClear' })} className={deckBtn} title="Schleifenregion löschen">
                      <Eraser size={10} />
                    </button>
                    <span className="ml-auto font-mono text-[9px] text-neutral-500 truncate" title="Länge der Schleife in Sekunden und Takten">
                      {deck.loop
                        ? `${deck.loop.start.toFixed(2)}–${deck.loop.end.toFixed(2)} s (${(deck.loop.end - deck.loop.start).toFixed(3)} s)`
                        : deck.loopMark !== null
                          ? `IN bei ${deck.loopMark.toFixed(3)} s`
                          : 'ganzer Clip'}
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    <button onClick={() => onDeckCommand?.({ type: 'preview', fitted: false })} className={deck.previewFitted ? deckBtn : deckBtnOn} title="Originalsamples des Clips">
                      CLIP
                    </button>
                    <button
                      onClick={() => onDeckCommand?.({ type: 'preview', fitted: true })}
                      className={deck.previewFitted ? deckBtnOn : deckBtn}
                      title="Dasselbe Material, so vorgerechnet, wie die Ablage es in die aktive Spur schreiben würde (Pegel und Tempo)"
                    >
                      WIE EINGEFÜGT
                    </button>
                  </div>
                  <div className="text-[9px] font-mono leading-snug text-[#ffb74d]/90" title="Pegel und Tempo laut Kernrechnung">
                    {deck.level}
                  </div>

                  <div className="flex items-center gap-1 pt-1 border-t border-[#1d1f27]">
                    <button onClick={() => onDeckCommand?.({ type: 'apply', clipId: deck.clipId, mode: 'insert' })} className={deckBtn} title={CLIP_DROP_LABELS.insert}>
                      <CornerUpRight size={10} />
                      <span>EINFÜGEN</span>
                    </button>
                    <button onClick={() => onDeckCommand?.({ type: 'apply', clipId: deck.clipId, mode: 'replace' })} className={deckBtn} title={CLIP_DROP_LABELS.replace}>
                      <Replace size={10} />
                      <span>ERSETZEN</span>
                    </button>
                    <button onClick={() => onDeckCommand?.({ type: 'apply', clipId: deck.clipId, mode: 'overdub' })} className={deckBtn} title={CLIP_DROP_LABELS.overdub}>
                      <Layers size={10} />
                      <span>DARÜBER</span>
                    </button>
                    <button onClick={() => onUnloadFromDeck?.()} className={`${deckBtn} ml-auto`} title="Clip aus dem Deck-Spieler entladen">
                      <X size={10} />
                    </button>
                  </div>
                </>
              );
            })()
          ) : (
            <div className="text-[10px] text-neutral-500 leading-relaxed">
              Kein Clip im Spieler. Alles hier bezieht sich auf den Clip, nicht auf die Spur –
              derselbe Spieler wie unten am Fenster, nur am Clip.
              <button
                onClick={() => selectedClipId && onDeckCommand?.({ type: 'load', clipId: selectedClipId })}
                disabled={!selectedClipId}
                className={`${deckBtn} mt-1.5`}
              >
                <Disc3 size={10} />
                <span>AUSGEWÄHLTEN CLIP LADEN</span>
              </button>
            </div>
          )}
        </div>
      )}

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
                onContextMenu={(event) => openMenu(clip, event)}
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
                    ? 'Ziehen: auf die Wellenform = einfügen · Alt = darüberlegen · Umschalt = ersetzen · Strg = in den Deck-Spieler · Rechtsklick = Aktionen'
                    : 'Dieser Clip hat keine Audiodaten'
                }
              >
                {/* Mini-Wellenform in Bernsteintönen (dieselbe Farbrechnung wie die Spur) */}
                <div className="w-full h-9 bg-[#0a0806] rounded-xs mb-1.5 overflow-hidden flex items-center justify-center relative border border-[#1b1c23]">
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
                              boxShadow: pk > 0.72 ? `0 0 3px ${AMBER_HOT_GLOW}` : undefined,
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
                        {tempoMatch && targetBpm > 0 && clip.bpm > 0 && Math.abs(clip.bpm - targetBpm) > 0.05 && (
                          <span
                            className="text-[#ffb74d]"
                            title={describeClipFit(clip, targetBpm, { tempoMatch, pitchFollowsTempo: pitchFollow })}
                          >
                            {' '}→ {targetBpm.toFixed(1)} BPM
                          </span>
                        )}
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

      {/* Kontextmenü (rechte Maustaste auf einen Clip): was mit dem Clip passieren soll */}
      {menu &&
        (() => {
          const clip = clips.find((entry) => entry.id === menu.clipId);
          if (!clip) return null;
          const clipHasAudio = clipAudioOf(clip) !== null;
          const clipIndex = clips.findIndex((entry) => entry.id === menu.clipId);
          const isDeckClip = deckClipId === clip.id;
          const item = (
            action: ClipMenuAction,
            label: string,
            options: { icon?: React.ReactNode; disabled?: boolean; hint?: string; danger?: boolean } = {}
          ) => (
            <button
              key={action}
              onClick={() => runMenuAction(action)}
              disabled={options.disabled}
              title={options.hint}
              className={`w-full flex items-center gap-2 px-2 py-1 text-left text-[11px] rounded-xs transition-colors disabled:opacity-30 ${
                options.danger
                  ? 'text-[#ff8a8a] hover:bg-[#2a1416] hover:text-white'
                  : 'text-neutral-300 hover:bg-[#20222c] hover:text-white'
              } disabled:hover:bg-transparent`}
            >
              <span className="w-3 flex-shrink-0 text-center">{options.icon}</span>
              <span className="truncate">{label}</span>
            </button>
          );
          return (
            <>
              {/* Fläche dahinter: jeder Klick außerhalb schließt das Menü */}
              <div
                className="fixed inset-0 z-[70]"
                onMouseDown={() => setMenu(null)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu(null);
                }}
              />
              <div
                className="fixed z-[71] w-64 bg-[#14151a] border border-[#2b2d38] rounded-sm shadow-2xl py-1 select-none"
                style={{ left: menu.x, top: menu.y }}
                role="menu"
                aria-label={`Aktionen für Clip ${clip.name}`}
              >
                <div className="px-2 pb-1.5 mb-1 border-b border-[#22242d]">
                  <div className="text-[11px] font-bold text-white truncate" title={clip.name}>
                    {clip.name}
                  </div>
                  <div className="text-[9px] font-mono text-neutral-500 truncate" title={describeClip(clip)}>
                    {clip.duration.toFixed(3)} s · {clip.beats} Beats · {clip.bpm.toFixed(1)} BPM
                  </div>
                  <div className="text-[9px] font-mono text-[#ffb74d] flex items-center gap-1 mt-0.5" title="Pegel vor und nach der Einfüge-Normalisierung">
                    <Gauge size={9} className="flex-shrink-0" />
                    <span className="truncate">{describeClipLevel(clip)}</span>
                  </div>
                </div>

                {item('insert', 'In die Spur einfügen', {
                  icon: <CornerUpRight size={11} />,
                  disabled: !clipHasAudio,
                  hint: CLIP_DROP_LABELS.insert,
                })}
                {item('overdub', 'Darüberlegen (Pegel wird angepasst)', {
                  icon: <Layers size={11} />,
                  disabled: !clipHasAudio,
                  hint: `${CLIP_DROP_LABELS.overdub} – der Clip wird maximal so laut gemischt, dass nichts übersteuert`,
                })}
                {item('replace', 'Auswahl ersetzen', {
                  icon: <Replace size={11} />,
                  disabled: !clipHasAudio,
                  hint: CLIP_DROP_LABELS.replace,
                })}
                {isDeckClip
                  ? item('unload', 'Aus dem Deck-Spieler entladen', { icon: <Square size={11} />, hint: 'Strg+Shift+X' })
                  : item('deck', 'In den Deck-Spieler laden', {
                      icon: <Disc3 size={11} />,
                      disabled: !clipHasAudio,
                      hint: CLIP_DROP_LABELS.deck,
                    })}

                <div className="my-1 border-t border-[#22242d]" />

                {item('export', 'Als WAV-Datei exportieren', {
                  icon: <Download size={11} />,
                  disabled: !clipHasAudio,
                  hint: 'Nur die Samples dieses Clips – die Quellspur bleibt unverändert',
                })}
                {item('duplicate', 'Duplizieren', { icon: <Copy size={11} />, hint: 'Kopie direkt unter dem Original' })}
                {item('rename', 'Umbenennen', { icon: <Pencil size={11} />, hint: 'Name in der Bibliothek ändern' })}
                {item('up', 'In der Liste nach oben', { icon: <ArrowUp size={11} />, disabled: clipIndex <= 0 })}
                {item('down', 'In der Liste nach unten', { icon: <ArrowDown size={11} />, disabled: clipIndex >= clips.length - 1 })}

                {item('deckView', deckViewOpen ? 'Deck-Ansicht einklappen' : 'In Deck-Ansicht öffnen', {
                  icon: deckViewOpen ? <Minimize2 size={11} /> : <Maximize2 size={11} />,
                  disabled: !clipHasAudio,
                  hint: 'Voller Spieler für diesen Clip: Transport, Schleife, Vorschau „wie eingefügt“',
                })}

                <div className="my-1 border-t border-[#22242d]" />

                {item('tempoMatch', tempoMatch ? 'Tempo an Zielspur anpassen ✓' : 'Tempo an Zielspur anpassen', {
                  icon: tempoMatch ? <Check size={11} /> : undefined,
                  hint:
                    targetBpm > 0
                      ? `Clip-Dauer von ${clip.bpm.toFixed(1)} auf ${targetBpm.toFixed(1)} BPM bringen – Tonhöhe bleibt`
                      : 'Ohne Beat-Raster in der Zielspur ist nichts anzupassen',
                })}
                {item('pitchFollow', pitchFollow ? 'Tonhöhe mit anpassen ✓' : 'Tonhöhe mit anpassen (Key-Lock aus)', {
                  icon: pitchFollow ? <Check size={11} /> : undefined,
                  disabled: !tempoMatch,
                  hint: 'Tonhöhe wandert mit dem Tempo wie auf dem Plattenteller; sonst hält der Vocoder die Tonhöhe',
                })}

                <div className="my-1 border-t border-[#22242d]" />

                {item('delete', 'Aus der Bibliothek entfernen', {
                  icon: <Trash2 size={11} />,
                  danger: true,
                  hint: 'Nur der Bibliotheks-Eintrag – Originaldatei und Spur bleiben unberührt',
                })}
              </div>
            </>
          );
        })()}
    </div>
  );
};
