/**
 * @license
 * Rekordbox BottomControlBlock Component
 * Minimalist & Context-Aware Audio Editing Command Bar:
 * - Auto-collapses into a sleek 28px mini-strip when no editing is required
 * - Auto-reveals editing operations when an audio range is selected or beats are picked
 * - Contextually dims/hides operations that cannot be performed
 * - Compact 112px expanded height (reduced from bulky 176px)
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
  Zap,
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
  autoCollapse?: boolean;
  onToggleAutoCollapse?: () => void;
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
  onOpenEditAssistant,
  isOpen = false,
  onToggle,
  autoCollapse = true,
  onToggleAutoCollapse,
}) => {
  const hasSelection = selection !== null && selection.duration > 0;

  // Minimal Collapsed Strip (Height: 28px)
  // Provides 100% full vertical canvas for waveforms while retaining 1-click beat triggers
  if (!isOpen) {
    return (
      <div className="h-7 bg-[#0c0d11] border-t border-[#1a1b22] flex items-center justify-between px-2.5 select-none z-20">
        {/* Left: Expand toggle & Direct 1-Click Beat Selector Pills */}
        <div className="flex items-center space-x-2">
          {onToggle && (
            <button
              onClick={onToggle}
              className="flex items-center space-x-1 px-2 py-0.5 bg-[#161820] hover:bg-[#202330] text-[#00a2ff] hover:text-white rounded-xs border border-[#262a3c] transition-colors text-[10px] font-bold tracking-wider uppercase"
              title="Editierpalette ausklappen [Taste: E]"
            >
              <ChevronUp size={11} />
              <span>WERKZEUGE</span>
            </button>
          )}

          {/* Direct 1-click beat selection pills directly accessible in collapsed mode */}
          <div className="flex items-center space-x-0.5 pl-1 border-l border-[#1f212a]">
            <span className="text-[9px] text-neutral-500 font-mono uppercase mr-1 hidden sm:inline">
              Beat:
            </span>
            {[1, 2, 4, 8, 16, 32, 64].map((beats) => {
              const isMatch = hasSelection && Math.round(selection.beatsCount) === beats;
              return (
                <button
                  key={beats}
                  onClick={() => onBeatSelect(beats)}
                  className={`px-1.5 py-0.5 rounded-xs text-[10px] font-mono font-semibold transition-colors ${
                    isMatch
                      ? 'bg-[#0088ff] text-white'
                      : 'bg-[#14151c] text-neutral-400 hover:text-white hover:bg-[#222532] border border-[#20222e]'
                  }`}
                  title={`${beats} Beats auswählen & Werkzeuge öffnen`}
                >
                  {beats}
                </button>
              );
            })}
          </div>

          {/* Status or Active Selection readout */}
          {hasSelection && (
            <div className="hidden md:flex items-center space-x-1.5 text-[10.5px] text-neutral-300 pl-2 border-l border-[#1f212a]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00a2ff] animate-pulse" />
              <span>
                <strong className="text-white">{selection.barsCount.toFixed(1)} Takte</strong>{' '}
                <span className="text-neutral-500">({Math.round(selection.beatsCount)} Beats)</span>
              </span>
              <button
                onClick={onCancelSelection}
                className="text-neutral-400 hover:text-[#ff453a] ml-1 p-0.5"
                title="Auswahl aufheben"
              >
                <XCircle size={11} />
              </button>
            </div>
          )}
        </div>

        {/* Right: Quick Clipboard, Undo/Redo & Fast Action Buttons */}
        <div className="flex items-center space-x-1.5 text-[10.5px]">
          {hasClipboard && (
            <span className="text-[9px] text-[#00c853] bg-[#0c2214] border border-[#164426] px-1.5 py-0.2 rounded-xs">
              Puffer aktiv
            </span>
          )}

          {hasSelection && (
            <>
              <button
                onClick={onCopy}
                className="px-1.5 py-0.5 bg-[#15161c] hover:bg-[#20222a] text-neutral-300 hover:text-white rounded-xs border border-[#252732] flex items-center space-x-1 text-[10px]"
                title="Kopieren (Ctrl+C)"
              >
                <Copy size={10} />
                <span>Copy</span>
              </button>
              {onCut && (
                <button
                  onClick={onCut}
                  className="px-1.5 py-0.5 bg-[#15161c] hover:bg-[#20222a] text-neutral-300 hover:text-white rounded-xs border border-[#252732] flex items-center space-x-1 text-[10px]"
                  title="Ausschneiden (Ctrl+X)"
                >
                  <Scissors size={10} />
                  <span>Cut</span>
                </button>
              )}
              <button
                onClick={onDelete}
                className="px-1.5 py-0.5 bg-[#201214] hover:bg-[#30161a] text-[#ff453a] hover:text-white rounded-xs border border-[#401f24] flex items-center space-x-1 text-[10px]"
                title="Löschen (Del)"
              >
                <Trash2 size={10} />
                <span>Del</span>
              </button>
            </>
          )}

          <button
            onClick={onPaste}
            disabled={!hasClipboard}
            className="px-1.5 py-0.5 bg-[#15161c] hover:bg-[#20222a] disabled:opacity-30 text-[#00a2ff] hover:text-white rounded-xs border border-[#252732] flex items-center space-x-1 text-[10px]"
            title="Einfügen (Ctrl+V)"
          >
            <ClipboardPaste size={10} />
            <span>Paste</span>
          </button>

          <div className="flex items-center space-x-0.5 pl-1 border-l border-[#20222e]">
            <button
              onClick={onUndo}
              disabled={!canUndo}
              className="p-1 bg-[#15161c] hover:bg-[#20222a] disabled:opacity-25 rounded-xs border border-[#252732] text-neutral-300 hover:text-white"
              title="Undo (Ctrl+Z)"
            >
              <RotateCcw size={10} />
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              className="p-1 bg-[#15161c] hover:bg-[#20222a] disabled:opacity-25 rounded-xs border border-[#252732] text-neutral-300 hover:text-white"
              title="Redo (Ctrl+Y)"
            >
              <RotateCw size={10} />
            </button>
          </div>

          {onToggle && (
            <button
              onClick={onToggle}
              className="ml-1 px-1.5 py-0.5 bg-[#1b1e2a] hover:bg-[#252a3c] text-neutral-300 hover:text-white rounded-xs border border-[#2d3348] text-[9.5px] font-medium"
              title="Werkzeuge vollständig öffnen"
            >
              Mehr...
            </button>
          )}
        </div>
      </div>
    );
  }

  // Compact Expanded Panel (Height: 112px ~ h-28)
  return (
    <div className="h-28 bg-[#0c0d11] border-t border-[#1a1b22] flex select-none z-20">
      {/* 1. BEAT SELECT Panel */}
      <div className="w-[280px] border-r border-[#1a1b22] flex flex-col flex-shrink-0">
        {/* Header */}
        <div className="h-5 bg-[#111217] border-b border-[#1f2129] flex items-center px-2">
          <span className="text-neutral-300 text-[10px] font-bold tracking-wider uppercase font-mono">
            BEAT SELECT
          </span>
        </div>

        {/* 8 Buttons in 2 rows of 4 */}
        <div className="flex-1 p-1.5 grid grid-cols-4 grid-rows-2 gap-1">
          {[1, 2, 4, 8, 16, 32, 64, 128].map((beats) => {
            const isMatch = hasSelection && Math.round(selection.beatsCount) === beats;

            return (
              <button
                key={beats}
                onClick={() => onBeatSelect(beats)}
                className={`flex flex-col items-center justify-center rounded-xs transition-colors border ${
                  isMatch
                    ? 'border-[#0088ff] text-white bg-[#0c2238] shadow-xs'
                    : 'border-[#20222c] bg-[#14151b] text-neutral-300 hover:text-white hover:bg-[#1f212b]'
                }`}
              >
                <span className="text-[12px] font-mono font-bold leading-tight">
                  {beats}
                </span>
                <span className="text-[8px] font-medium text-neutral-500 tracking-wider">
                  BEAT
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. SELECT Panel: Only active when selection exists, otherwise shows helpful guidance */}
      <div className="w-[180px] border-r border-[#1a1b22] flex flex-col flex-shrink-0">
        {/* Header */}
        <div className="h-5 bg-[#111217] border-b border-[#1f2129] flex items-center justify-between px-2">
          <span className="text-neutral-300 text-[10px] font-bold tracking-wider uppercase font-mono">
            SELECT
          </span>
          {hasSelection && (
            <span className="text-[9px] font-mono text-[#00a2ff]">
              {selection.barsCount.toFixed(1)} Bar
            </span>
          )}
        </div>

        {hasSelection ? (
          <div className="flex-1 p-1.5 grid grid-cols-3 gap-1">
            {/* HALF (1/2) */}
            <button
              onClick={onHalfSelection}
              className="flex flex-col items-center justify-center rounded-xs border border-[#20222c] bg-[#14151b] text-neutral-200 hover:text-white hover:bg-[#1f212b] transition-colors"
              title="Auswahl halbieren"
            >
              <span className="text-[12px] font-bold leading-tight">1/2</span>
              <span className="text-[8px] font-medium text-neutral-400">HALF</span>
            </button>

            {/* DOUBLE (×2) */}
            <button
              onClick={onDoubleSelection}
              className="flex flex-col items-center justify-center rounded-xs border border-[#20222c] bg-[#14151b] text-neutral-200 hover:text-white hover:bg-[#1f212b] transition-colors"
              title="Auswahl verdoppeln"
            >
              <span className="text-[12px] font-bold leading-tight">×2</span>
              <span className="text-[8px] font-medium text-neutral-400">DOUBLE</span>
            </button>

            {/* CANCEL (⊗) */}
            <button
              onClick={onCancelSelection}
              className="flex flex-col items-center justify-center rounded-xs border border-[#35191c] bg-[#1c1214] text-[#ff453a] hover:bg-[#2b1619] hover:text-white transition-colors"
              title="Auswahl aufheben"
            >
              <XCircle size={13} strokeWidth={2} />
              <span className="text-[8px] font-medium text-[#ff6660]">CANCEL</span>
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-2 text-center">
            <span className="text-[9.5px] text-neutral-500 font-sans leading-tight">
              Keine Auswahl aktiv
            </span>
            <span className="text-[8.5px] text-neutral-600 mt-1">
              Wähle BEAT oder ziehe in Wellenform
            </span>
          </div>
        )}
      </div>

      {/* 3. EDIT Panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header Bar */}
        <div className="h-5 bg-[#111217] border-b border-[#1f2129] flex items-center justify-between px-2">
          <span className="text-neutral-300 text-[10px] font-bold tracking-wider uppercase font-mono">
            EDIT
          </span>

          <div className="flex items-center space-x-2 text-[9.5px]">
            {onToggleMatchPitch && (
              <label
                className="flex items-center space-x-1 cursor-pointer select-none text-neutral-400 hover:text-white"
                title="Tonhöhe bei Einfügen an Zieltrack anpassen"
              >
                <input
                  type="checkbox"
                  checked={matchPitch}
                  onChange={(e) => onToggleMatchPitch(e.target.checked)}
                  className="w-2.5 h-2.5 rounded-xs accent-[#0088ff] cursor-pointer"
                />
                <span>Tonhöhe anpassen {targetKey ? `(${targetKey})` : ''}</span>
              </label>
            )}

            {onOpenEditAssistant && (
              <button
                onClick={onOpenEditAssistant}
                className="text-[#00e5ff] hover:text-white px-1.5 py-0.2 rounded-xs bg-[#0088ff]/15 border border-[#0088ff]/30 flex items-center space-x-1 text-[9px] font-semibold"
                title="Edit Assistant: Puffer- & Bereichs-Integrität prüfen"
              >
                <ShieldCheck size={10} />
                <span>ASSISTANT</span>
              </button>
            )}

            {/* Auto-collapse toggle */}
            {onToggleAutoCollapse && (
              <button
                onClick={onToggleAutoCollapse}
                className={`px-1.5 py-0.2 rounded-xs border text-[9px] font-mono transition-colors flex items-center space-x-1 ${
                  autoCollapse
                    ? 'border-[#0088ff]/40 bg-[#0c2035] text-[#00a2ff]'
                    : 'border-[#262832] bg-[#14151b] text-neutral-500 hover:text-neutral-300'
                }`}
                title="Automatisch einklappen, wenn keine Auswahl aktiv ist"
              >
                <Zap size={9} />
                <span>Auto-Fold</span>
              </button>
            )}

            {onToggle && (
              <button
                onClick={onToggle}
                className="text-neutral-400 hover:text-white px-1.5 py-0.2 rounded-xs bg-[#161820] hover:bg-[#202330] flex items-center space-x-0.5 border border-[#282b3a] transition-colors"
                title="Editierpalette einklappen [Taste: E]"
              >
                <ChevronDown size={10} className="text-[#00a2ff]" />
                <span className="text-[9px]">Einklappen</span>
              </button>
            )}
          </div>
        </div>

        {/* 8 Action Buttons in 2 rows of 4 */}
        <div className="flex-1 p-1.5 grid grid-cols-4 grid-rows-2 gap-1">
          {/* Row 1: CLONE, COPY, CUT, PASTE */}
          <button
            onClick={onClone}
            disabled={!hasSelection}
            className="flex items-center justify-center space-x-1.5 rounded-xs border border-[#20222c] bg-[#14151b] text-neutral-200 hover:text-white hover:bg-[#1f212b] disabled:opacity-25 disabled:pointer-events-none transition-colors"
            title="Auswahl klonen / zur Clip-Palette hinzufügen"
          >
            <PlusSquare size={13} className="text-[#00a2ff]" />
            <span className="text-[10px] font-semibold tracking-wider">CLONE</span>
          </button>

          <button
            onClick={onCopy}
            disabled={!hasSelection}
            className="flex items-center justify-center space-x-1.5 rounded-xs border border-[#20222c] bg-[#14151b] text-neutral-200 hover:text-white hover:bg-[#1f212b] disabled:opacity-25 disabled:pointer-events-none transition-colors"
            title="Kopieren (Ctrl+C)"
          >
            <Copy size={13} />
            <span className="text-[10px] font-semibold tracking-wider">COPY</span>
          </button>

          <button
            onClick={onCut}
            disabled={!hasSelection}
            className="flex items-center justify-center space-x-1.5 rounded-xs border border-[#20222c] bg-[#14151b] text-neutral-200 hover:text-white hover:bg-[#1f212b] disabled:opacity-25 disabled:pointer-events-none transition-colors"
            title="Ausschneiden (Ctrl+X)"
          >
            <Scissors size={13} />
            <span className="text-[10px] font-semibold tracking-wider">CUT</span>
          </button>

          <button
            onClick={onPaste}
            disabled={!hasClipboard}
            className="flex items-center justify-center space-x-1.5 rounded-xs border border-[#20222c] bg-[#14151b] text-[#00a2ff] hover:text-white hover:bg-[#1f212b] disabled:opacity-25 disabled:pointer-events-none transition-colors"
            title="Einfügen (Ctrl+V)"
          >
            <ClipboardPaste size={13} />
            <span className="text-[10px] font-semibold tracking-wider">PASTE</span>
          </button>

          {/* Row 2: DELETE, CLEAR, REPLACE, INSERT/OVERDUB */}
          <button
            onClick={onDelete}
            disabled={!hasSelection}
            className="flex items-center justify-center space-x-1.5 rounded-xs border border-[#35191c] bg-[#1c1214] text-[#ff453a] hover:bg-[#2b1619] hover:text-white disabled:opacity-25 disabled:pointer-events-none transition-colors"
            title="Löschen mit Zeitanpassung (Del)"
          >
            <Trash2 size={13} />
            <span className="text-[10px] font-semibold tracking-wider">DELETE</span>
          </button>

          <button
            onClick={onClear}
            disabled={!hasSelection}
            className="flex items-center justify-center space-x-1.5 rounded-xs border border-[#20222c] bg-[#14151b] text-neutral-200 hover:text-white hover:bg-[#1f212b] disabled:opacity-25 disabled:pointer-events-none transition-colors"
            title="Stumm schalten (Clear / Stille)"
          >
            <Brush size={13} />
            <span className="text-[10px] font-semibold tracking-wider">CLEAR</span>
          </button>

          <button
            onClick={onReplace}
            disabled={!hasSelection || !hasClipboard}
            className="flex items-center justify-center space-x-1.5 rounded-xs border border-[#352514] bg-[#1c150e] text-[#ff9500] hover:bg-[#2a1d12] hover:text-white disabled:opacity-25 disabled:pointer-events-none transition-colors"
            title="Replace: Puffer ersetzt Auswahl bei gleicher Länge"
          >
            <Repeat size={13} />
            <span className="text-[10px] font-semibold tracking-wider">REPLACE</span>
          </button>

          <button
            onClick={onInsert}
            disabled={!hasClipboard}
            className="flex items-center justify-center space-x-1.5 rounded-xs border border-[#20222c] bg-[#14151b] text-neutral-200 hover:text-white hover:bg-[#1f212b] disabled:opacity-25 disabled:pointer-events-none transition-colors"
            title="Insert: Puffer an Cursor / Auswahl einfügen"
          >
            <ArrowRightLeft size={13} />
            <span className="text-[10px] font-semibold tracking-wider">INSERT</span>
          </button>
        </div>
      </div>
    </div>
  );
};

