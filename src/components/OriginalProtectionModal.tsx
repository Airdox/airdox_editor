/**
 * @license
 * Original Protection Modal — the intervention popup of the
 * Original Protection Agent.
 *
 * Opens whenever a work step risks modifying, moving, renaming, or deleting
 * a registered original source (audio, ANLZ, database, XML). The text is
 * deliberately written for a layperson: what almost happened, why it is
 * dangerous, what the consequence would be, and what the safe alternative
 * is. No technical jargon, no ambiguity.
 *
 * Pure presentation: the modal itself never performs any file operation.
 */

import React from 'react';
import { ShieldAlert, FileAudio, Info, AlertOctagon, LifeBuoy } from 'lucide-react';
import { GuardIntervention } from '../agent/originalProtectionAgent';

interface OriginalProtectionModalProps {
  intervention: GuardIntervention;
  onClose: () => void;
  /** Optional: jump straight into the safe alternative (save as NEW file). */
  onSafeAlternative?: () => void;
}

export const OriginalProtectionModal: React.FC<OriginalProtectionModalProps> = ({
  intervention,
  onClose,
  onSafeAlternative,
}) => {
  const { explanation } = intervention;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="original-guard-title"
        className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-md border-2 border-[#f59e0b]/60 bg-[#101216] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[#23252c] bg-[#1a1408] rounded-t-md">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-[#f59e0b]/15 border border-[#f59e0b]/40 shrink-0">
            <ShieldAlert size={22} className="text-[#fbbf24]" />
          </div>
          <div className="min-w-0">
            <h2 id="original-guard-title" className="text-[15px] font-bold text-[#fde68a] leading-tight">
              {explanation.title}
            </h2>
            <p className="text-[11px] text-neutral-400 mt-0.5">
              Originalschutz-Agent · Permanent-Monitoring · Aktion wurde abgebrochen
            </p>
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* What was about to happen */}
          <section className="flex gap-3">
            <FileAudio size={18} className="text-[#00a2ff] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h3 className="text-[12px] font-semibold text-neutral-200 mb-1">
                Was war gerade beinahe passiert?
              </h3>
              <p className="text-[12px] text-neutral-300 leading-relaxed whitespace-pre-wrap">
                {explanation.what}
              </p>
            </div>
          </section>

          {/* Why it is dangerous */}
          <section className="flex gap-3">
            <Info size={18} className="text-[#00a2ff] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h3 className="text-[12px] font-semibold text-neutral-200 mb-1">
                Warum ist das so gefährlich?
              </h3>
              <p className="text-[12px] text-neutral-300 leading-relaxed">{explanation.why}</p>
            </div>
          </section>

          {/* Consequence */}
          <section className="flex gap-3 rounded-sm border border-red-500/40 bg-red-500/10 px-3 py-2.5">
            <AlertOctagon size={18} className="text-red-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h3 className="text-[12px] font-semibold text-red-300 mb-1">Wenn die Aktion trotzdem ausgeführt würde</h3>
              <p className="text-[12px] text-red-200/90 leading-relaxed">{explanation.consequence}</p>
            </div>
          </section>

          {/* Safe alternative */}
          <section className="flex gap-3 rounded-sm border border-[#10b981]/40 bg-[#10b981]/10 px-3 py-2.5">
            <LifeBuoy size={18} className="text-[#34d399] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h3 className="text-[12px] font-semibold text-[#6ee7b7] mb-1">
                Die sichere Alternative (empfohlen)
              </h3>
              <p className="text-[12px] text-[#a7f3d0]/90 leading-relaxed">{explanation.safeAlternative}</p>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2 px-5 py-3.5 border-t border-[#23252c] bg-[#0d0e11] rounded-b-md">
          <p className="sm:mr-auto text-[10px] text-neutral-500 leading-snug">
            Der Originalschutz-Agent überwacht permanent alle Arbeitsschritte:
            Originalquellen werden ausschließlich gelesen, alle Bearbeitung
            findet auf Arbeitskopien statt.
          </p>
          {onSafeAlternative && (
            <button
              onClick={onSafeAlternative}
              className="px-4 py-2 rounded-sm bg-[#10b981]/20 hover:bg-[#10b981]/35 border border-[#10b981]/50 text-[#6ee7b7] hover:text-white text-[12px] font-semibold transition-colors"
            >
              Sichere Alternative nutzen — als neue Datei speichern…
            </button>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-sm bg-[#f59e0b]/20 hover:bg-[#f59e0b]/35 border border-[#f59e0b]/50 text-[#fde68a] hover:text-white text-[12px] font-semibold transition-colors"
          >
            Verstanden — Aktion bleibt abgebrochen
          </button>
        </div>
      </div>
    </div>
  );
};
