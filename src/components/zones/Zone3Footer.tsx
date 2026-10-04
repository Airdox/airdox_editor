/**
 * @license
 * airdox_SMART_Editor – ZONE 3: Untere Bearbeitungs- und Selektions-Paletten.
 *
 * Enthält BEAT SELECT, SELECT und EDIT (Clone, Copy, Paste, Delete, Undo …)
 * sowie die erweiterten Optionen der Tonhöhen-Anpassung.
 *
 * Verhalten (Master-Plan, hart):
 *   - Standardmäßig EINGEKLAPPT: am untersten Bildschirmrand steht nur eine
 *     dezente Reiter-Leiste. Erst ein Klick auf einen Bereich klappt ihn auf.
 *   - Immer höchstens EINE Sektion ist offen (Akkordeon, siehe
 *     `workspaceReducer`). Zwei offene Panels waren genau das Problem der
 *     alten unteren Zone.
 *   - Der Fokus-Modus („Max. Platz / Alles einklappen") blendet Zone 3
 *     vollständig aus; die Reiter-Leiste bleibt als einzige Rückfahrt in Zone 1
 *     erreichbar (Fokus-Umschalter ist permanent sichtbar).
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
  ChevronUp,
  ChevronDown,
  Scissors,
} from 'lucide-react';
import { SelectionRange } from '../../types/rekordbox';
import { ZONE3_SECTIONS } from '../../ui/workspaceLayout';
import type { Zone3SectionId } from '../../ui/workspaceLayout';

export interface Zone3FooterProps {
  /** Offene Sektion; `null` = eingeklappt (Standard). */
  activeSection: Zone3SectionId | null;
  onToggleSection: (section: Zone3SectionId) => void;

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
}

export const Zone3Footer: React.FC<Zone3FooterProps> = ({
  activeSection,
  onToggleSection,
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
}) => {
  const hasSelection = selection !== null && selection.duration > 0;

  return (
    <footer className="select-none z-20" data-zone="3" aria-label="Bearbeitungs-Paletten">
      {/* ── Reiter-Leiste: die einzige sichtbare Zeile im eingeklappten Zustand ── */}
      <div className="h-7 bg-[#0d0e12] border-t border-[#1c1e26] flex items-center justify-between px-3 gap-3">
        <div className="flex items-center gap-1" role="tablist" aria-label="Bearbeitungs-Paletten">
          {ZONE3_SECTIONS.map((section) => {
            const open = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                role="tab"
                aria-selected={open}
                onClick={() => onToggleSection(section.id)}
                data-zone3-tab={section.id}
                aria-controls={open ? `zone3-panel-${section.id}` : undefined}
                className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-t text-[10px] font-bold tracking-wider uppercase border transition-colors ${
                  open
                    ? 'bg-[#1e2028] border-[#0088ff]/60 border-b-transparent text-white'
                    : 'bg-[#111217] border-[#24262f] text-neutral-400 hover:text-white hover:border-[#3a3f52]'
                }`}
                title={`${section.hint} (Klick klappt die Palette auf)`}
              >
                {open ? <ChevronDown size={11} className="text-[#00a2ff]" /> : <ChevronUp size={11} className="text-neutral-500" />}
                <span className="rb-tab-chamfer">{section.label}</span>
              </button>
            );
          })}
        </div>

        {/* Auswahl-Zusammenfassung: Kontext der unteren Zone, kein Prozessstatus */}
        <div className="flex items-center gap-2 text-[10px] min-w-0">
          {hasSelection ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-[#00a2ff]" aria-hidden="true" />
              <span className="text-neutral-300 truncate">
                Auswahl: <strong className="text-white">{selection.barsCount.toFixed(1)} Takte</strong>{' '}
                <span className="text-neutral-500">
                  ({Math.round(selection.beatsCount)} Beats • {selection.duration.toFixed(3)} s)
                </span>
              </span>
            </>
          ) : (
            <span className="text-neutral-600 italic">Keine Auswahl – in der Wellenform ziehen oder Taste E drücken</span>
          )}
          {hasClipboard && (
            <span className="text-[9.5px] text-[#00c853] bg-[#0c2214] border border-[#164426] px-1.5 py-[1px] rounded" title="Zwischenablage enthält kopiertes Audio">
              Zwischenablage bereit
            </span>
          )}
        </div>
      </div>

      {/* ── Aufgeklappte Sektion (genau eine) ─────────────────────────────── */}
      {activeSection === 'BEAT_SELECT' && (
        <div className="h-32 bg-[#0d0e12] border-t border-[#1c1e26] flex flex-col" id="zone3-panel-BEAT_SELECT"
          data-zone3-panel="BEAT_SELECT">
          <div className="flex-1 p-2 grid grid-cols-8 gap-1.5 max-w-[900px]">
            {[1, 2, 4, 8, 16, 32, 64, 128].map((beats) => {
              const isCurrentMatch = hasSelection && Math.round(selection.beatsCount) === beats;
              const bars = beats / 4;
              const barLabel = bars >= 1 ? `${bars} ${bars === 1 ? 'Takt' : 'Takte'}` : `${beats}/4 Takt`;
              return (
                <button
                  key={beats}
                  type="button"
                  onClick={() => onBeatSelect(beats)}
                  className={`rb-button-grid flex flex-col items-center justify-center rounded-xs transition-all ${
                    isCurrentMatch ? 'border-[#0088ff] text-[#00a2ff] bg-[#1a2130]' : 'text-neutral-300'
                  }`}
                  title={`Auswahl auf genau ${beats} Beats (${barLabel}) ab aktuellem Beatgrid-Startpunkt setzen`}
                >
                  <span className="text-[15px] font-mono font-bold leading-tight">{beats}</span>
                  <span className="text-[9px] font-semibold text-neutral-400 tracking-wider">BEAT</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {activeSection === 'SELECT' && (
        <div className="h-32 bg-[#0d0e12] border-t border-[#1c1e26] flex flex-col" id="zone3-panel-SELECT"
          data-zone3-panel="SELECT">
          <div className="flex-1 p-2 grid grid-cols-3 gap-1.5 max-w-[420px]">
            <button
              type="button"
              onClick={onHalfSelection}
              disabled={!hasSelection}
              className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
              title="Auswahllänge halbieren (1/2)"
            >
              <span className="text-[15px] font-bold leading-tight">1/2</span>
              <span className="text-[9px] font-semibold text-neutral-400 tracking-wider mt-0.5">HALF</span>
            </button>
            <button
              type="button"
              onClick={onDoubleSelection}
              disabled={!hasSelection}
              className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
              title="Auswahllänge verdoppeln (×2)"
            >
              <span className="text-[15px] font-bold leading-tight">× 2</span>
              <span className="text-[9px] font-semibold text-neutral-400 tracking-wider mt-0.5">DOUBLE</span>
            </button>
            <button
              type="button"
              onClick={onCancelSelection}
              disabled={!hasSelection}
              className="rb-button-grid flex flex-col items-center justify-center rounded-xs text-[#ff453a]"
              title="Auswahl aufheben (Deselect)"
            >
              <XCircle size={16} strokeWidth={2} />
              <span className="text-[9px] font-semibold text-neutral-400 tracking-wider mt-0.5">CANCEL</span>
            </button>
          </div>
        </div>
      )}

      {activeSection === 'EDIT' && (
        <div className="bg-[#0d0e12] border-t border-[#1c1e26] flex flex-col" id="zone3-panel-EDIT"
          data-zone3-panel="EDIT">
          {/* Erweiterte Optionen: Tonhöhen-Anpassung + Schnelloperationen */}
          <div className="h-7 flex items-center justify-between px-2 border-b border-[#181a21]">
            <div className="flex items-center gap-3 text-[10px]">
              {onToggleMatchPitch && (
                <label
                  className="flex items-center gap-1.5 cursor-pointer select-none text-neutral-300 hover:text-white"
                  title="Tonhöhe beim Einfügen/Überschreiben automatisch an die Tonart des Zieltracks anpassen (Pitch Shifting)"
                >
                  <input
                    type="checkbox"
                    checked={matchPitch}
                    onChange={(event) => onToggleMatchPitch(event.target.checked)}
                    className="w-3 h-3 accent-[#0088ff] cursor-pointer"
                  />
                  <span className="text-[9.5px] font-medium">
                    Tonhöhe anpassen {targetKey ? `(${targetKey})` : ''}
                  </span>
                </label>
              )}
              <button
                type="button"
                onClick={onReplace}
                disabled={!hasSelection}
                className="text-[#ff9500] hover:text-[#ffaa33] disabled:opacity-40 px-2 py-0.5 rounded bg-[#20180a] border border-[#3d2e15] flex items-center gap-1"
                title="Replace: ersetzt den markierten Auswahlbereich exakt durch das Audio der Zwischenablage"
              >
                <Repeat size={10} />
                <span>REPLACE</span>
              </button>
              <button
                type="button"
                onClick={onOverdub}
                disabled={!hasSelection}
                className="text-[#00c853] hover:text-[#33d677] disabled:opacity-40 px-2 py-0.5 rounded bg-[#0a2012] border border-[#153d20] flex items-center gap-1"
                title="Overdub: mischt den Inhalt der Zwischenablage additiv über den aktuellen Auswahlbereich"
              >
                <Layers size={10} />
                <span>OVERDUB</span>
              </button>
              {onOpenEditAssistant && (
                <button
                  type="button"
                  onClick={onOpenEditAssistant}
                  className="text-[#00e5ff] hover:text-white px-2 py-0.5 rounded bg-[#0088ff]/15 border border-[#0088ff]/40 flex items-center gap-1 text-[9px] font-semibold"
                  title="Edit Assistant: Puffer- & Bereichs-Integrität prüfen"
                >
                  <ShieldCheck size={10} className="text-[#00e5ff]" />
                  <span>ASSISTANT</span>
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {onClearHistory && (canUndo || canRedo) && (
                <button
                  type="button"
                  onClick={onClearHistory}
                  className="text-neutral-400 hover:text-[#ff6b62] px-1.5 py-0.5 rounded hover:bg-[#251315] border border-transparent hover:border-[#ff453a]/30 flex items-center gap-1 text-[9px] transition-colors"
                  title="Verlauf leeren (Sicherheitsdialog zur Freigabe von Arbeitsspeicher)"
                >
                  <Trash2 size={9} />
                  <span>CLEAR HIST</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => onToggleSection('EDIT')}
                className="text-neutral-400 hover:text-white px-2 py-0.5 rounded bg-[#181a22] hover:bg-[#242838] flex items-center gap-1 border border-[#2d3040] transition-colors font-medium text-[9.5px]"
                title="Bearbeitungs-Palette einklappen (für maximale Wellenform-Fläche) [Taste: E]"
              >
                <ChevronDown size={11} className="text-[#00a2ff]" />
                <span>Einklappen</span>
              </button>
            </div>
          </div>

          {/* Acht Operationen in einer Zeile */}
          <div className="h-24 p-2 grid grid-cols-5 grid-rows-2 gap-1.5">
            <button
              type="button"
              onClick={onClone}
              disabled={!hasSelection}
              className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
              title="Auswahl klonen und direkt als neuen Eintrag in die Clip-Palette legen"
            >
              <PlusSquare size={16} strokeWidth={1.8} className="text-[#00a2ff]" />
              <span className="text-[9.5px] font-semibold tracking-wider mt-1">CLONE</span>
            </button>
            <button
              type="button"
              onClick={onCopy}
              disabled={!hasSelection}
              className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
              title="Auswahl in die verlustfreie Zwischenablage kopieren (Ctrl+C)"
            >
              <Copy size={16} strokeWidth={1.8} />
              <span className="text-[9.5px] font-semibold tracking-wider mt-1">COPY</span>
            </button>
            {onCut && (
              <button
                type="button"
                onClick={onCut}
                disabled={!hasSelection}
                className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
                title="Auswahl ausschneiden und in die Zwischenablage legen (Ctrl+X)"
              >
                <Scissors size={16} strokeWidth={1.8} />
                <span className="text-[9.5px] font-semibold tracking-wider mt-1">CUT</span>
              </button>
            )}
            <button
              type="button"
              onClick={onPaste}
              disabled={!hasClipboard}
              className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
              title="Zwischenablage an aktueller Cursorposition einfügen (Ctrl+V)"
            >
              <ClipboardPaste size={16} strokeWidth={1.8} />
              <span className="text-[9.5px] font-semibold tracking-wider mt-1">PASTE</span>
            </button>
            <button
              type="button"
              onClick={onInsert}
              disabled={!hasClipboard}
              className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
              title="Insert: fügt Audio ein und verschiebt nachfolgendes Audio nach hinten (Ripple Insert)"
            >
              <ArrowRightLeft size={16} strokeWidth={1.8} />
              <span className="text-[9.5px] font-semibold tracking-wider mt-1">INSERT</span>
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={!hasSelection}
              className="rb-button-grid flex flex-col items-center justify-center rounded-xs text-[#ff453a]"
              title="Löschmenü öffnen: normales Löschen (Stille einfügen) oder Ripple Delete (Aufrücken)"
            >
              <Trash2 size={16} strokeWidth={1.8} />
              <span className="text-[9.5px] font-semibold tracking-wider mt-1">DELETE…</span>
            </button>
            <button
              type="button"
              onClick={onClear}
              disabled={!hasSelection}
              className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
              title="Clear: Bereich stummschalten, ohne nachfolgendes Audio zu verschieben"
            >
              <Brush size={16} strokeWidth={1.8} />
              <span className="text-[9.5px] font-semibold tracking-wider mt-1">CLEAR</span>
            </button>
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
              title="Letzten Bearbeitungsschritt rückgängig machen (Ctrl+Z)"
            >
              <RotateCcw size={16} strokeWidth={1.8} />
              <span className="text-[9.5px] font-semibold tracking-wider mt-1">UNDO</span>
            </button>
            <button
              type="button"
              onClick={onRedo}
              disabled={!canRedo}
              className="rb-button-grid flex flex-col items-center justify-center rounded-xs"
              title="Rückgängig gemachten Schritt wiederholen (Ctrl+Y)"
            >
              <RotateCw size={16} strokeWidth={1.8} />
              <span className="text-[9.5px] font-semibold tracking-wider mt-1">REDO</span>
            </button>
          </div>
        </div>
      )}
    </footer>
  );
};
