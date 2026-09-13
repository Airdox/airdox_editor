import React, { useEffect } from 'react';
import { MinusCircle, ShieldCheck, Trash2, X } from 'lucide-react';
import { SelectionRange } from '../../types/rekordbox';

interface DeleteModeModalProps {
  selection: SelectionRange;
  onNormalDelete: () => void;
  onRippleDelete: () => void;
  onCancel: () => void;
}

/** Explicit choice between duration-preserving and timeline-closing deletion. */
export const DeleteModeModal: React.FC<DeleteModeModalProps> = ({
  selection,
  onNormalDelete,
  onRippleDelete,
  onCancel,
}) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        onNormalDelete();
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        onRippleDelete();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, onNormalDelete, onRippleDelete]);

  return (
    <div
      className="fixed inset-0 z-[110] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-mode-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-xl bg-[#14161c] border border-[#343743] rounded-md shadow-2xl overflow-hidden select-none">
        <div className="h-11 px-4 flex items-center justify-between border-b border-[#292c35] bg-[#101217]">
          <div className="flex items-center gap-2">
            <Trash2 size={17} className="text-[#ff6259]" />
            <h2 id="delete-mode-title" className="text-sm font-semibold text-white">
              Welche Delete-Variante möchtest du verwenden?
            </h2>
          </div>
          <button onClick={onCancel} className="p-1 text-neutral-500 hover:text-white" title="Abbrechen (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 pt-3 text-[11px] text-neutral-400">
          Auswahl: <span className="text-white font-mono">{selection.duration.toFixed(3)} s</span>
          {' · '}{selection.barsCount.toFixed(1)} Takte · {selection.beatsCount.toFixed(1)} Beats
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
          <button
            autoFocus
            onClick={onNormalDelete}
            className="text-left p-4 rounded border border-[#0088ff] bg-[#102238] hover:bg-[#17304d] focus:outline-none focus:ring-2 focus:ring-[#00a2ff] transition-colors"
          >
            <div className="flex items-center gap-2 text-[#4db8ff] font-bold text-sm">
              <MinusCircle size={17} />
              <span>Normales Delete</span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-300">
              Ersetzt die Auswahl durch Stille. Tracklänge, Cues, Beatgrid und nachfolgendes Audio behalten ihre Position.
            </p>
            <div className="mt-3 text-[9px] uppercase tracking-wider text-[#65c1ff]">Standard · Enter</div>
          </button>

          <button
            onClick={onRippleDelete}
            className="text-left p-4 rounded border border-[#5a3030] bg-[#281719] hover:bg-[#3a2022] focus:outline-none focus:ring-2 focus:ring-[#ff6259] transition-colors"
          >
            <div className="flex items-center gap-2 text-[#ff6259] font-bold text-sm">
              <Trash2 size={17} />
              <span>Ripple Delete</span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-300">
              Entfernt die Auswahl aus der Timeline. Nachfolgendes Audio, Cues und Beatgrid rücken entsprechend nach vorn.
            </p>
            <div className="mt-3 text-[9px] uppercase tracking-wider text-[#ff817a]">Taste R</div>
          </button>
        </div>

        <div className="px-4 py-2.5 border-t border-[#292c35] bg-[#101217] flex items-center gap-2 text-[10px] text-emerald-400">
          <ShieldCheck size={13} />
          <span>Beide Varianten bearbeiten ausschließlich die Arbeitsrepräsentation. Das Original bleibt unverändert.</span>
        </div>
      </div>
    </div>
  );
};
