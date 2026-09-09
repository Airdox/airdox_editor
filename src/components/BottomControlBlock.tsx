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
  /** Fallback source: active palette clip name (when clipboard empty) */
  activeClipName?: string | null;
  matchPitch?: boolean;
  onToggleMatchPitch?: (match: boolean) => void;
  targetKey?: string;
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
  activeClipName,
  matchPitch = true,
  onToggleMatchPitch,
  targetKey,
}) => {
  const hasSelection = selection !== null && selection.duration > 0;
  // PASTE/INSERT/REPLACE/OVERDUB source priority:
  //   1. Clipboard (COPY/CUT) – for PASTE/INSERT
  //   2. Selected palette clip – fallback source when no clipboard
  const hasInsertSource = hasClipboard || !!activeClipName;
  const sourceLabel = hasClipboard ? 'Zwischenablage' : activeClipName ? `Palette: ${activeClipName}` : 'Kein Quellmaterial';

  return (
    <div className="h-44 bg-[#0d0e12] border-t border-[#1c1e26] flex select-none z-20">
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
        {/* Workflow guidance strip */}
        <div className="h-5 bg-[#0f141c] border-b border-[#1c2230] flex items-center px-2 text-[10px] font-mono">
          {!hasSelection ? (
            <span className="text-neutral-400">
              <span className="text-[#0088ff] font-bold">SCHRITT 1:</span> Bereich in der Wellenform auswählen (1–128 BEAT) oder Cursor positionieren → dann
              {hasInsertSource ? (
                <span className="text-emerald-400 font-bold ml-1">
                  ▶ INSERT / PASTE
                  {activeClipName ? ` (Quelle: ${hasClipboard ? 'Zwischenablage' : activeClipName})` : ''}
                </span>
              ) : (
                <span className="text-neutral-500 ml-1">erst COPY / CLONE oder Palette-Clip auswählen</span>
              )}
            </span>
          ) : (
            <span className="text-neutral-300">
              <span className="text-[#0088ff] font-bold">BEREICH AUSGEWÄHLT:</span>
              <span className="text-white font-bold mx-1">
                {Math.round(selection!.beatsCount)} Beats / {selection!.barsCount.toFixed(1)} Bars ({selection!.duration.toFixed(2)}s)
              </span>
              →
              <span className="text-[#00a2ff] font-bold mx-1">COPY</span>·
              <span className="text-[#00c853] font-bold mx-1">CLONE</span>·
              <span className="text-[#ffb020] font-bold mx-1">REPLACE</span>·
              <span className="text-[#7ea7ff] font-bold mx-1">OVERDUB</span>·
              <span className="text-neutral-300 mx-1">CLEAR</span>·
              <span className="text-[#ff453a] font-bold mx-1">DELETE</span>
            </span>
          )}
          {canUndo && <span className="ml-auto text-neutral-500">↶ UNDO verfügbar</span>}
        </div>

        {/* Angled Tab Header */}
        <div className="h-6 bg-[#111217] border-b border-[#1f2129] flex items-center justify-between px-2">
          <div className="rb-tab-chamfer bg-[#1e2028] text-neutral-300 text-[10.5px] font-bold px-3 py-0.5 tracking-wider uppercase">
            EDIT
          </div>

          {/* Pitch adaptation checkbox & Quick operations badge (REPLACE / OVERDUB) */}
          <div className="flex items-center space-x-2.5 text-[10px]">
            {onToggleMatchPitch && (
              <label
                className="flex items-center space-x-1 cursor-pointer select-none text-neutral-300 hover:text-white"
                title="Tonhöhe beim Einfügen/Überschreiben an Zieltrack anpassen"
              >
                <input
                  type="checkbox"
                  checked={matchPitch}
                  onChange={(e) => onToggleMatchPitch(e.target.checked)}
                  className="w-3 h-3 rounded-xs accent-[#0088ff] cursor-pointer"
                />
                <span className="text-[9.5px] font-medium text-neutral-300">
                  Tonhöhe anpassen {targetKey ? `(${targetKey})` : ''}
                </span>
              </label>
            )}

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
            title="Auswahl klonen / zur Palette"
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
            disabled={!hasInsertSource}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs relative"
            title={hasInsertSource ? `Einfügen aus ${sourceLabel} (Ctrl+V)` : 'Erst kopieren oder Palette-Clip auswählen'}
          >
            <ClipboardPaste size={16} strokeWidth={1.8} />
            <span className="text-[9.5px] font-semibold tracking-wider mt-1">
              PASTE
            </span>
            {!hasClipboard && activeClipName && (
              <span className="absolute -top-1 -right-1 text-[7px] font-bold bg-[#0088ff] text-white rounded px-1 py-0 shadow">P</span>
            )}
          </button>

          <button
            onClick={onInsert}
            disabled={!hasInsertSource}
            className="rb-button-grid flex flex-col items-center justify-center rounded-xs relative"
            title={hasInsertSource ? `Insert aus ${sourceLabel} (Zeit öffnen)` : 'Erst kopieren oder Palette-Clip auswählen'}
          >
            <ArrowRightLeft size={16} strokeWidth={1.8} />
            <span className="text-[9.5px] font-semibold tracking-wider mt-1">
              INSERT
            </span>
            {!hasClipboard && activeClipName && (
              <span className="absolute -top-1 -right-1 text-[7px] font-bold bg-[#0088ff] text-white rounded px-1 py-0 shadow">P</span>
            )}
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
