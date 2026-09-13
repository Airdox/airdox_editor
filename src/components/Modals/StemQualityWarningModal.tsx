/**
 * @license
 * StemQualityWarningModal for airdox_SMART_Editor
 *
 * Shown BEFORE a stem separation when the real AI engine (Demucs htdemucs_ft)
 * is not available. The user decides explicitly whether to run the low-quality
 * local spectral fallback anyway — it is never chosen silently, because its
 * output is not usable for club/performance sets.
 */

import React, { useEffect } from 'react';
import { AlertTriangle, X, Cpu, Terminal, Sparkles, ShieldAlert } from 'lucide-react';

interface StemQualityWarningModalProps {
  isOpen: boolean;
  /** Why Demucs is unavailable (Python missing, module missing, weights…). */
  reason: string;
  onClose: () => void;
  /** User explicitly accepts the low-quality local fallback. */
  onProceedWithFallback: () => void;
}

export const StemQualityWarningModal: React.FC<StemQualityWarningModalProps> = ({
  isOpen,
  reason,
  onClose,
  onProceedWithFallback,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const setupCommand =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
      ? 'npm run stems:setup:win'
      : 'npm run stems:setup';

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-50 select-none p-4">
      <div className="w-full max-w-lg bg-[#13151c] border border-[#f59e0b]/40 rounded shadow-2xl overflow-hidden flex flex-col text-neutral-200 text-xs animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="h-10 bg-[#1d1810] border-b border-[#3a2f14] flex items-center justify-between px-3">
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 rounded bg-[#f59e0b]/20 border border-[#f59e0b]/50 flex items-center justify-center text-[#f59e0b]">
              <AlertTriangle size={14} />
            </div>
            <span className="font-bold text-white text-xs tracking-wide">
              KI-Stem-Engine (Demucs) nicht verfügbar
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors"
            title="Abbrechen (ESC)"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3.5">
          <div className="bg-[#241d10] border border-[#f59e0b]/30 p-3 rounded flex items-start space-x-2.5">
            <ShieldAlert size={18} className="text-[#f59e0b] flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="font-bold text-[#fbbf24] text-xs block">
                Ohne Demucs gibt es keine performancetaugliche Stem-Qualität
              </span>
              <p className="text-[11.5px] text-neutral-300 leading-relaxed">
                Vocals, Synths und Snares überlappen sich im Frequenzbereich. Der lokale
                STFT-Fallback (Median-HPSS + Spektralmasken) trennt Drums brauchbar,
                lässt aber hörbare Übersprecher zwischen Vocals und Instrumenten — er ist{' '}
                <span className="text-white font-semibold">nicht für Club-/Live-Einsatz geeignet</span>.
                Echte Trennqualität liefert ausschließlich das trainierte KI-Modell{' '}
                <span className="font-mono text-[#00c8ff]">htdemucs_ft</span>.
              </p>
            </div>
          </div>

          {/* Diagnostic reason */}
          <div className="bg-[#0b0c10] border border-[#1d1f2a] rounded-xs p-2.5 space-y-1.5">
            <div className="flex items-center space-x-1.5 text-neutral-400">
              <Cpu size={12} />
              <span className="font-bold text-[10.5px] uppercase tracking-wider">Diagnose</span>
            </div>
            <p className="font-mono text-[10.5px] text-[#ff8a80] leading-relaxed break-all">
              {reason}
            </p>
          </div>

          {/* Fix instructions */}
          <div className="bg-[#0b0c10] border border-[#1d1f2a] rounded-xs p-2.5 space-y-1.5">
            <div className="flex items-center space-x-1.5 text-neutral-400">
              <Terminal size={12} />
              <span className="font-bold text-[10.5px] uppercase tracking-wider">
                So installierst du die KI-Engine (einmalig)
              </span>
            </div>
            <ol className="list-decimal list-inside space-y-1 text-[11px] text-neutral-300">
              <li>
                Python <span className="font-mono text-white">3.11</span> oder{' '}
                <span className="font-mono text-white">3.12</span> installieren
              </li>
              <li>
                Im Projektordner ausführen:{' '}
                <span className="font-mono bg-black/50 border border-[#2a2d3a] rounded px-1.5 py-0.5 text-[#4ade80]">
                  {setupCommand}
                </span>
              </li>
              <li>Editor neu starten — der erste Lauf lädt die Modellgewichte herunter</li>
            </ol>
            <p className="text-[10px] text-neutral-500 pt-0.5">
              Die Inference läuft danach komplett lokal; es werden keine Audiodaten hochgeladen.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="h-12 bg-[#10121a] border-t border-[#1e2130] flex items-center justify-end px-3 space-x-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded bg-[#1e2230] hover:bg-[#272d40] border border-[#343b52] text-neutral-200 text-xs font-medium transition-colors"
          >
            Abbrechen (empfohlen: erst Demucs installieren)
          </button>
          <button
            onClick={onProceedWithFallback}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-[#3a2f14] hover:bg-[#f59e0b] border border-[#f59e0b]/50 text-[#fbbf24] hover:text-black text-xs font-semibold transition-colors"
            title="Nur zur groben Vorschau geeignet — deutliche Übersprecher zwischen den Stems"
          >
            <Sparkles size={12} />
            <span>Trotzdem Fallback nutzen (niedrige Qualität)</span>
          </button>
        </div>
      </div>
    </div>
  );
};
