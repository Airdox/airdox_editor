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
  Repeat,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  Scissors,
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
  onCut?: () => void;
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
  matchPitch?: boolean;
  onToggleMatchPitch?: (match: boolean) => void;
  targetKey?: string;
  onClearHistory?: () => void;
  onOpenEditAssistant?: () => void;
  isOpen?: boolean;
  onToggle?: () => void;
}

export const BottomControlBlock: React.FC<BottomControlBlockProps> = ({
  selection,
  onBeatSelect,
  onHalfSelection,
  onDoubleSelection,
  onCancelSelection,
  onClone,
  onCopy,
  onCut,
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
  matchPitch = true,
  onToggleMatchPitch,
  targetKey,
  onClearHistory,
  onOpenEditAssistant,
  isOpen = true,
  onToggle,
}) => {
  const hasSelection = selection !== null && selection.duration > 0;

  // Collapsed Minimal Mode: releases maximum vertical screen real estate for waveforms
  if (isOpen === false) {
    return (
      <div className="h-7 bg-[#0d0e12] border-t border-[#1c1e26] flex items-center justify-between px-3 select-none z-20 transition-all">
        <div className="flex items-center space-x-3">
          <button
            onClick={onToggle}
            className="flex items-center space-x-1.5 px-2.5 py-0.5 bg-[#181a22] hover:bg-[#232634] text-neutral-300 hover:text-white rounded-xs border border-[#2d303f] transition-colors text-[10.5px] font-bold"
            title="Editierpalette ausklappen (BEAT SELECT / SELECT / EDIT) [Taste: E]"
          >
            <ChevronUp size={12} className="text-[#00a2ff]" />
            <span className="tracking-wider uppercase">EDITIERPALETTE</span>
          </button>

          {/* Real-time selection badge */}
          {hasSelection ? (
            <div className="flex items-center space-x-2 text-[10.5px] text-neutral-300">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00a2ff] animate-pulse"></span>
              <span>
                Auswahl: <strong className="text-white">{selection.barsCount.toFixed(1)} Takte</strong>{' '}
                <span className="text-neutral-400">({Math.round(selection.beatsCount)} Beats • {selection.duration.toFixed(3)}s)</span>
              </span>
            </div>
          ) : (
            <div className="text-[10px] text-neutral-500 italic">
              Keine Auswahl • In der Wellenform ziehen oder Taste E drücken
            </div>
          )}
        </div>

        {/* Quick action operations accessible directly even when collapsed */}
        <div className="flex items-center space-x-1.5 text-[10.5px]">
          {hasClipboard && (
            <span className="text-[9.5px] text-[#00c853] bg-[#0c2214] border border-[#164426] px-1.5 py-0.5 rounded-xs mr-1">
              Zwischenablage bereit
            </span>
          )}
          <button
            onClick={onCopy}
            disabled={!hasSelection}
            className="px-2 py-0.5 bg-[#15161c] hover:bg-[#20222a] disabled:opacity-30 rounded-xs border border-[#252732] text-neutral-300 hover:text-white flex items-center space-x-1"
            title="Auswahl in die Zwischenablage (Strg+C)"
          >
            <Copy size={11} />
            <span>Copy</span>
          </button>
          {onCut && (
            <button
              onClick={onCut}
              disabled={!hasSelection}
              className="px-2 py-0.5 bg-[#15161c] hover:bg-[#20222a] disabled:opacity-30 rounded-xs border border-[#252732] text-neutral-300 hover:text-white flex items-center space-x-1"
              title="Ausschneiden (Strg+X)"
            >
              <Scissors size={11} />
              <span>Cut</span>
            </button>
          )}
          <button
            onClick={onPaste}
            disabled={!hasClipboard}
            className="px-2 py-0.5 bg-[#15161c] hover:bg-[#20222a] disabled:opacity-30 rounded-xs border border-[#252732] text-[#00a2ff] hover:text-white disabled:text-neutral-500 flex items-center space-x-1"
            title="Einfügen (Strg+V)"
          >
            <ClipboardPaste size={11} />
            <span>Paste</span>
          </button>
          <button
            onClick={onDelete}
            disabled={!hasSelection}
            className="px-2 py-0.5 bg-[#1f1214] hover:bg-[#301a1c] disabled:opacity-30 rounded-xs border border-[#402024] text-[#ff453a] hover:text-white flex items-center space-x-1"
            title="Löschen (Del)"
          >
            <Trash2 size={11} />
            <span>Delete</span>
          </button>
          <button
            onClick={onUndo}
            disabled={!canUndo}
            className="p-1 bg-[#15161c] hover:bg-[#20222a] disabled:opacity-30 rounded-xs border border-[#252732] text-neutral-300 hover:text-white"
            title="Undo (Ctrl+Z)"
          >
            <RotateCcw size={11} />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo}
            className="p-1 bg-[#15161c] hover:bg-[#20222a] disabled:opacity-30 rounded-xs border border-[#252732] text-neutral-300 hover:text-white"
            title="Redo (Ctrl+Y)"
          >
            <RotateCw size={11} />
          </button>

          {onToggle && (
            <button
              onClick={onToggle}
              className="ml-2 px-2 py-0.5 bg-[#1e2230] hover:bg-[#282d40] text-[#00a2ff] hover:text-white rounded-xs border border-[#353d55] flex items-center space-x-1 text-[10px] font-semibold transition-colors"
              title="Editierpalette vollständig ausklappen (BEAT SELECT / SELECT / EDIT)"
            >
              <ChevronUp size={11} />
              <span>Ausklappen</span>
            </button>
          )}
        </div>
      </div>
    );
  }

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

            {onOpenEditAssistant && (
              <button
                onClick={onOpenEditAssistant}
                className="text-[#00e5ff] hover:text-white px-2 py-0.5 rounded bg-[#0088ff]/15 border border-[#0088ff]/40 flex items-center space-x-1 text-[9px] font-semibold"
                title="Edit Assistant: Puffer- & Bereichs-Integrität prüfen"
              >
                <ShieldCheck size={10} className="text-[#00e5ff]" />
                <span>ASSISTANT</span>
              </button>
            )}

            {onClearHistory && (canUndo || canRedo) && (
              <button
                onClick={onClearHistory}
                className="text-neutral-400 hover:text-[#ff6b62] px-1.5 py-0.5 rounded hover:bg-[#251315] border border-transparent hover:border-[#ff453a]/30 flex items-center space-x-1 text-[9px] transition-colors"
                title="Verlauf leeren (Sicherheitsdialog zur Vermeidung von Datenverlust)"
              >
                <Trash2 size={9} />
                <span>CLEAR HIST</span>
              </button>
            )}

            {onToggle && (
              <button
                onClick={onToggle}
                className="text-neutral-400 hover:text-white px-2 py-0.5 rounded bg-[#181a22] hover:bg-[#242838] flex items-center space-x-1 border border-[#2d3040] transition-colors ml-1 font-medium"
                title="Editierpalette einklappen (für maximale Wellenform-Fläche) [Taste: E]"
              >
                <ChevronDown size={11} className="text-[#00a2ff]" />
                <span className="text-[9.5px]">Einklappen</span>
              </button>
            )}
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
            title="Auswahl in die Zwischenablage (Strg+C)"
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
            title="Einfügen (Strg+V)"
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
