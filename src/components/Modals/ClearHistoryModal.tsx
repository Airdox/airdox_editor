/**
 * @license
 * ClearHistoryModal Component for airdox_SMART_Editor
 * Confirmation dialog to prevent accidental data loss from clearing the edit history stack.
 */

import React, { useEffect } from 'react';
import { AlertTriangle, Trash2, X, RotateCcw, ShieldAlert, History } from 'lucide-react';

interface ClearHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  undoCount: number;
  redoCount: number;
  recentActions: string[];
  trackTitle?: string;
}

export const ClearHistoryModal: React.FC<ClearHistoryModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  undoCount,
  redoCount,
  recentActions,
  trackTitle,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const totalSteps = undoCount + redoCount;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-50 select-none p-4">
      <div className="w-full max-w-md bg-[#13151c] border border-[#ff453a]/40 rounded shadow-2xl overflow-hidden flex flex-col text-neutral-200 text-xs animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="h-10 bg-[#1c1819] border-b border-[#3a1d1d] flex items-center justify-between px-3">
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 rounded bg-[#ff453a]/20 border border-[#ff453a]/50 flex items-center justify-center text-[#ff453a]">
              <AlertTriangle size={14} />
            </div>
            <span className="font-bold text-white text-xs tracking-wide">
              Bearbeitungsverlauf leeren (Clear History)
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors"
            title="Schließen (ESC)"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3.5">
          {/* Warning Banner */}
          <div className="bg-[#241314] border border-[#ff453a]/30 p-3 rounded flex items-start space-x-2.5">
            <ShieldAlert size={18} className="text-[#ff453a] flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="font-bold text-[#ff6b62] text-xs block">
                Vorsicht vor Datenverlust bei Wiederherstellung!
              </span>
              <p className="text-[11.5px] text-neutral-300 leading-relaxed">
                Das Leeren des Verlaufs entfernt alle temporären Snapshots aus dem Arbeitsspeicher. Frühere Bearbeitungsschritte können anschließend <span className="text-white font-semibold underline">nicht mehr rückgängig</span> gemacht werden.
              </p>
            </div>
          </div>

          {/* Details Card */}
          <div className="bg-[#0e1015] border border-[#232530] p-3 rounded space-y-2 font-mono text-[11px]">
            <div className="flex justify-between items-center text-neutral-300 border-b border-[#1c1e28] pb-1.5">
              <span className="text-neutral-400">Aktiver Track:</span>
              <span className="text-white font-semibold truncate max-w-[200px]">
                {trackTitle || 'Deck A'}
              </span>
            </div>

            <div className="flex justify-between items-center text-neutral-300">
              <span className="flex items-center space-x-1 text-neutral-400">
                <RotateCcw size={12} className="text-[#00a2ff]" />
                <span>Rückgängig-Schritte (Undo):</span>
              </span>
              <span className="text-[#00e5ff] font-bold">{undoCount} Schritte</span>
            </div>

            <div className="flex justify-between items-center text-neutral-300">
              <span className="flex items-center space-x-1 text-neutral-400">
                <History size={12} className="text-neutral-400" />
                <span>Wiederholen-Schritte (Redo):</span>
              </span>
              <span className="text-neutral-300 font-bold">{redoCount} Schritte</span>
            </div>

            {recentActions.length > 0 && (
              <div className="pt-2 border-t border-[#1c1e28] space-y-1">
                <span className="text-[10px] uppercase text-neutral-500 block">
                  Letzte Aktionen im Speicher:
                </span>
                <div className="space-y-0.5">
                  {recentActions.map((act, idx) => (
                    <div
                      key={idx}
                      className="text-[10.5px] text-neutral-400 flex items-center space-x-1.5 bg-[#141620] px-2 py-0.5 rounded"
                    >
                      <span className="text-[#00a2ff]">•</span>
                      <span className="text-neutral-200">{act}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Workflow Note */}
          <p className="text-[11px] text-neutral-400 leading-normal">
            Hinweis: Der gegenwärtige Zustand deiner Wellenform, Cues und Beatgrids bleibt vollständig erhalten. Nur die Historie wird zurückgesetzt.
          </p>
        </div>

        {/* Footer Buttons */}
        <div className="h-12 bg-[#171922] border-t border-[#252834] px-4 flex items-center justify-end space-x-2.5">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded bg-[#252834] hover:bg-[#323646] text-neutral-200 text-xs font-medium transition-colors"
          >
            Abbrechen
          </button>
          <button
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="px-4 py-1.5 rounded bg-[#b82525] hover:bg-[#d32f2f] text-white text-xs font-semibold flex items-center space-x-1.5 transition-colors shadow-lg shadow-red-950/40"
          >
            <Trash2 size={13} />
            <span>Verlauf jetzt leeren ({totalSteps})</span>
          </button>
        </div>
      </div>
    </div>
  );
};
