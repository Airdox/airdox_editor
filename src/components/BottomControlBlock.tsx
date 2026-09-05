/**
 * @license
 * Rekordbox BottomControlBlock Component
 * Lower control blocks matching screenshots 01, 02, and 03:
 * - 3 interconnected panels with angled polygonal tabs: BEAT SELECT, SELECT, EDIT
 * - BEAT SELECT: 1, 2, 4, 8, 16, 32, 64, 128 BEAT buttons
 * - SELECT (Screenshot 03 Select Mode): 1/2 HALF, ×2 DOUBLE, ⊗ CANCEL
 * - EDIT: CLONE, COPY, PASTE, INSERT, DELETE, CLEAR, UNDO, REDO (+ REPLACE, OVERDUB)
 */

import React from 'react';
import {
  Copy,
  PlusSquare,
  ClipboardPaste,
  ArrowRightLeft,
  Trash2,
  Brush,
  RotateCcw,
  RotateCw,
  XCircle,
  Layers,
  Repeat
} from 'lucide-react';
import { SelectionRange } from '../types/rekordbox';
import { CLIP_DND_MIME, readClipDragPayload } from '../audio/clipLibrary';
import { Disc3, X } from 'lucide-react';

interface BottomControlBlockProps {
  selection: SelectionRange | null;
  onBeatSelect: (beats: number) => void;
  onHalfSelection: () => void;
  onDoubleSelection: () => void;
  onCancelSelection: () => void;
  onClone: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onInsert: () => void;
  onReplace: () => void;
  onOverdub: () => void;
  onDelete: () => void;
  onClear: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  hasClipboard: boolean;
  /** Clip, der gerade im Deck-Spieler liegt (sonst läuft die ganze Spur). */
  deckClip?: { id: string; name: string; duration: number; position: number } | null;
  onDropClipIntoDeck?: (clipId: string) => void;
  onUnloadDeckClip?: () => void;
}

export const BottomControlBlock: React.FC<BottomControlBlockProps> = ({
  selection,
  onBeatSelect,
  onHalfSelection,
  onDoubleSelection,
  onCancelSelection,
  onClone,
  onCopy,
  onPaste,
  onInsert,
  onReplace,
  onOverdub,
  onDelete,
  onClear,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  hasClipboard,
  deckClip = null,
  onDropClipIntoDeck,
  onUnloadDeckClip,
}) => {
  const hasSelection = selection !== null && selection.duration > 0;
  const [clipDropArmed, setClipDropArmed] = React.useState(false);
  const isClipDrag = (transfer: DataTransfer) =>
    Array.from(transfer.types || []).some((type) => type === CLIP_DND_MIME);
  const progress = deckClip && deckClip.duration > 0 ? Math.min(1, deckClip.position / deckClip.duration) : 0;

  return (
    <div className="h-44 bg-[#0d0e12] border-t border-[#1c1e26] flex select-none z-20">
      {/* 0. Deck-Spieler: Ablageziel für Clips aus der Bibliothek */}
      <div
        onDragOver={(e) => {
          if (!isClipDrag(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          if (!clipDropArmed) setClipDropArmed(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setClipDropArmed(false);
        }}
        onDrop={(e) => {
          const payload = readClipDragPayload(e.dataTransfer);
          setClipDropArmed(false);
          if (!payload) return;
          e.preventDefault();
          e.stopPropagation();
          onDropClipIntoDeck?.(payload.clipId);
        }}
        className={`w-[210px] border-r border-[#1a1b22] flex flex-col transition-colors ${
          clipDropArmed ? 'bg-[#1a1206] ring-2 ring-[#ff9500] ring-inset' : 'bg-[#0d0e12]'
        }`}
      >
        <div className="h-6 bg-[#111217] border-b border-[#1f2129] flex items-center justify-between px-2">
          <div className="rb-tab-chamfer bg-[#1e2028] text-neutral-300 text-[10.5px] font-bold px-3 py-0.5 tracking-wider uppercase">
            DECK-CLIP
          </div>
          {deckClip && (
            <button
              onClick={onUnloadDeckClip}
              className="text-neutral-500 hover:text-white p-0.5 rounded transition-colors"
              title="Clip aus dem Spieler nehmen (Strg+Shift+X) – die ganze Spur ist wieder hörbar"
            >
              <X size={11} />
            </button>
          )}
        </div>

        <div className="flex-1 p-2 flex flex-col justify-between gap-1.5">
          {deckClip ? (
            <>
              <div className="min-w-0">
                <div className="flex items-center space-x-1.5 min-w-0">
                  <Disc3 size={11} className="text-[#ff9500] flex-shrink-0" />
                  <span className="text-white text-[11px] font-medium truncate" title={deckClip.name}>
                    {deckClip.name}
                  </span>
                </div>
                <div className="text-[9.5px] font-mono text-neutral-500 mt-0.5">
                  {deckClip.position.toFixed(3)} / {deckClip.duration.toFixed(3)} s
                </div>
              </div>
              <div className="h-1.5 bg-[#1a1c24] rounded-xs overflow-hidden border border-[#242734]">
                <div className="h-full bg-[#ff9500]" style={{ width: `${(progress * 100).toFixed(2)}%` }} />
              </div>
              <div className="text-[8.5px] text-neutral-500 leading-tight">
                TRANSPORT, LOOP und Zeitachse beziehen sich auf diesen Clip. Die Spur
                selbst bleibt unverändert.
              </div>
            </>
          ) : (
            <>
              <div className="text-[10px] text-neutral-500 leading-snug">
                Clip aus der Bibliothek hierher ziehen – er läuft dann im Spieler, ohne
                die Spur zu verändern.
              </div>
              <div
                className={`border border-dashed rounded-xs flex-1 flex items-center justify-center text-[9.5px] font-mono transition-colors ${
                  clipDropArmed ? 'border-[#ff9500] text-[#ffb74d]' : 'border-[#2b2e3a] text-neutral-600'
                }`}
              >
                {clipDropArmed ? 'loslassen: ins Deck' : 'Ablagefläche für Clips'}
              </div>
              <div className="text-[8.5px] text-neutral-600 leading-tight">
                Auf der Wellenform: einfügen · Alt darüberlegen · Umschalt ersetzen
              </div>
            </>
          )}
        </div>
      </div>

      {/* 1. BEAT SELECT Panel */}
      <div className="w-[320px] border-r border-[#1a1b22] flex flex-col">
        {/* Angled Tab Header */}
        <div className="h-6 bg-[#111217] border-b border-[#1f2129] flex items-center px-2">
          <div className="rb-tab-chamfer bg-[#1e2028] text-neutral-300 text-[10.5px] font-bold px-3 py-0.5 tracking-wider uppercase">
            BEAT SELECT
          </div>
        </div>

        {/* 8 Buttons in 2 rows of 4 matching screenshots */}
        <div className="flex-1 p-2 grid grid-cols-4 grid-rows-2 gap-1.5">
          {[1, 2, 4, 8, 16, 32, 64, 128].map((beats) => {
            const isCurrentMatch =
              hasSelection && Math.round(selection.beatsCount) === beats;

            return (
              <button
                key={beats}
                onClick={() => onBeatSelect(beats)}
                className={`rb-button-grid flex flex-col items-center justify-center rounded-xs transition-all ${
                  isCurrentMatch
                    ? 'border-[#0088ff] text-[#00a2ff] bg-[#1a2130]'
                    : 'text-neutral-300'
                }`}
              >
                <span className="text-[15px] font-mono font-bold leading-tight">
                  {beats}
                </span>
                <span className="text-[9px] font-semibold text-neutral-400 tracking-wider">
                  BEAT
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. SELECT Panel (Screenshot 03 Select Mode: HALF, DOUBLE, CANCEL) */}
      <div className="w-[210px] border-r border-[#1a1b22] flex flex-col">
        {/* Angled Tab Header */}
        <div className="h-6 bg-[#111217] border-b border-[#1f2129] flex items-center px-2">
          <div className="rb-tab-chamfer bg-[#1e2028] text-neutral-300 text-[10.5px] font-bold px-3 py-0.5 tracking-wider uppercase">
            SELECT
          </div>
        </div>

        {/* 3 Select Buttons: 1/2 HALF, ×2 DOUBLE, ⊗ CANCEL */}
        <div className="flex-1 p-2 grid grid-cols-3 gap-1.5">
          {/* HALF (1/2) */}
          <button
            onClick={onHalfSelection}
            disabled={!hasSelection}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
            title="Auswahl halbieren"
          >
            <span className="text-[15px] font-bold leading-tight">1/2</span>
            <span className="text-[9px] font-semibold text-neutral-400 tracking-wider mt-0.5">
              HALF
            </span>
          </button>

          {/* DOUBLE (×2) */}
          <button
            onClick={onDoubleSelection}
            disabled={!hasSelection}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
            title="Auswahl verdoppeln"
          >
            <span className="text-[15px] font-bold leading-tight">× 2</span>
            <span className="text-[9px] font-semibold text-neutral-400 tracking-wider mt-0.5">
              DOUBLE
            </span>
          </button>

          {/* CANCEL (⊗) */}
          <button
            onClick={onCancelSelection}
            disabled={!hasSelection}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs text-[#ff453a]"
            title="Auswahl aufheben"
          >
            <XCircle size={16} strokeWidth={2} />
            <span className="text-[9px] font-semibold text-neutral-400 tracking-wider mt-0.5">
              CANCEL
            </span>
          </button>
        </div>
      </div>

      {/* 3. EDIT Panel */}
      <div className="flex-1 flex flex-col">
        {/* Angled Tab Header */}
        <div className="h-6 bg-[#111217] border-b border-[#1f2129] flex items-center justify-between px-2">
          <div className="rb-tab-chamfer bg-[#1e2028] text-neutral-300 text-[10.5px] font-bold px-3 py-0.5 tracking-wider uppercase">
            EDIT
          </div>

          {/* Quick operations badge (REPLACE / OVERDUB) */}
          <div className="flex items-center space-x-2 text-[10px]">
            <button
              onClick={onReplace}
              disabled={!hasSelection}
              className="text-[#ff9500] hover:text-[#ffaa33] disabled:opacity-40 px-2 py-0.5 rounded bg-[#20180a] border border-[#3d2e15] flex items-center space-x-1"
              title="Replace (Clip ersetzt Bereich)"
            >
              <Repeat size={10} />
              <span>REPLACE</span>
            </button>
            <button
              onClick={onOverdub}
              disabled={!hasSelection}
              className="text-[#00c853] hover:text-[#33d677] disabled:opacity-40 px-2 py-0.5 rounded bg-[#0a2012] border border-[#153d20] flex items-center space-x-1"
              title="Overdub (Clip wird überlagert)"
            >
              <Layers size={10} />
              <span>OVERDUB</span>
            </button>
          </div>
        </div>

        {/* 8 Action Buttons in 2 rows matching screenshots */}
        <div className="flex-1 p-2 grid grid-cols-4 grid-rows-2 gap-1.5">
          {/* Row 1: CLONE, COPY, PASTE, INSERT */}
          <button
            onClick={onClone}
            disabled={!hasSelection}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
            title="Auswahl klonen / in die Clip-Bibliothek"
          >
            <PlusSquare size={16} strokeWidth={1.8} className="text-[#00a2ff]" />
            <span className="text-[9.5px] font-semibold tracking-wider mt-1">
              CLONE
            </span>
          </button>

          <button
            onClick={onCopy}
            disabled={!hasSelection}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
            title="Kopieren (Ctrl+C)"
          >
            <Copy size={16} strokeWidth={1.8} />
            <span className="text-[9.5px] font-semibold tracking-wider mt-1">
              COPY
            </span>
          </button>

          <button
            onClick={onPaste}
            disabled={!hasClipboard}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
            title="Einfügen (Ctrl+V)"
          >
            <ClipboardPaste size={16} strokeWidth={1.8} />
            <span className="text-[9.5px] font-semibold tracking-wider mt-1">
              PASTE
            </span>
          </button>

          <button
            onClick={onInsert}
            disabled={!hasClipboard}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
            title="Einfügen mit Zeittransformation (Insert)"
          >
            <ArrowRightLeft size={16} strokeWidth={1.8} />
            <span className="text-[9.5px] font-semibold tracking-wider mt-1">
              INSERT
            </span>
          </button>

          {/* Row 2: DELETE, CLEAR, UNDO, REDO */}
          <button
            onClick={onDelete}
            disabled={!hasSelection}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs text-[#ff453a]"
            title="Löschen mit Zeitanpassung (Delete)"
          >
            <Trash2 size={16} strokeWidth={1.8} />
            <span className="text-[9.5px] font-semibold tracking-wider mt-1">
              DELETE
            </span>
          </button>

          <button
            onClick={onClear}
            disabled={!hasSelection}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
            title="Stumm schalten / leeren (Clear)"
          >
            <Brush size={16} strokeWidth={1.8} />
            <span className="text-[9.5px] font-semibold tracking-wider mt-1">
              CLEAR
            </span>
          </button>

          <button
            onClick={onUndo}
            disabled={!canUndo}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
            title="Rückgängig (Ctrl+Z)"
          >
            <RotateCcw size={16} strokeWidth={1.8} />
            <span className="text-[9.5px] font-semibold tracking-wider mt-1">
              UNDO
            </span>
          </button>

          <button
            onClick={onRedo}
            disabled={!canRedo}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
            title="Wiederholen (Ctrl+Y)"
          >
            <RotateCw size={16} strokeWidth={1.8} />
            <span className="text-[9.5px] font-semibold tracking-wider mt-1">
              REDO
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
