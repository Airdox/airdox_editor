/**
 * @license
 * StemQualityWarningModal for airdox_SMART_Editor
 *
 * Shown BEFORE a stem separation when the real AI engine (Demucs htdemucs_ft)
 * is not available. The user decides explicitly whether to run the low-quality
 * local spectral fallback anyway — it is never chosen silently, because its
 * output is not usable for club/performance sets.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, X, Cpu, Sparkles, ShieldAlert, Download, CheckCircle2, Loader2 } from 'lucide-react';
import {
  installStemEngineWithProgress,
  StemInstallProgressUpdate,
} from '../../audio/stemEngineInstaller';

interface StemQualityWarningModalProps {
  isOpen: boolean;
  /** Why Demucs is unavailable (Python missing, module missing, weights…). */
  reason: string;
  onClose: () => void;
  /** User explicitly accepts the low-quality local fallback. */
  onProceedWithFallback: () => void;
  /** Called after a successful in-app installation of the AI engine. */
  onEngineInstalled?: () => void;
  /** Closes the dialog and immediately re-runs the separation with Demucs. */
  onRunWithInstalledEngine?: () => void;
}

type InstallState =
  | { phase: 'IDLE' }
  | { phase: 'RUNNING'; progress: StemInstallProgressUpdate | null; lastLog: string }
  | { phase: 'DONE' }
  | { phase: 'FAILED'; error: string };

export const StemQualityWarningModal: React.FC<StemQualityWarningModalProps> = ({
  isOpen,
  reason,
  onClose,
  onProceedWithFallback,
  onEngineInstalled,
  onRunWithInstalledEngine,
}) => {
  const [install, setInstall] = useState<InstallState>({ phase: 'IDLE' });
  const installing = install.phase === 'RUNNING';

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !installing) onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose, installing]);

  const handleInstall = useCallback(async () => {
    setInstall({ phase: 'RUNNING', progress: null, lastLog: '' });
    try {
      const result = await installStemEngineWithProgress((progress) => {
        setInstall((prev) => ({
          phase: 'RUNNING',
          progress,
          lastLog: progress.logLine || (prev.phase === 'RUNNING' ? prev.lastLog : ''),
        }));
      });
      if (result.ok) {
        setInstall({ phase: 'DONE' });
        onEngineInstalled?.();
      } else {
        setInstall({ phase: 'FAILED', error: result.error || 'Unbekannter Installationsfehler.' });
      }
    } catch (error) {
      setInstall({
        phase: 'FAILED',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [onEngineInstalled]);

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

          {/* One-click installation (primary path) */}
          {install.phase === 'IDLE' && (
            <div className="bg-[#0b1a12] border border-[#10b981]/30 rounded-xs p-2.5 space-y-2">
              <div className="flex items-center space-x-1.5 text-[#34d399]">
                <Download size={12} />
                <span className="font-bold text-[10.5px] uppercase tracking-wider">
                  Empfohlen: KI-Engine jetzt automatisch installieren
                </span>
              </div>
              <p className="text-[11px] text-neutral-300 leading-relaxed">
                Ein Klick erledigt alles: Python-Umgebung, PyTorch, Demucs 4.0.1 und die
                htdemucs_ft-Modellgewichte (~2–3 GB Download, einmalig). Danach läuft jede
                Trennung lokal in echter KI-Qualität — keine Audiodaten verlassen deinen Rechner.
              </p>
              <p className="text-[10px] text-neutral-500">
                Voraussetzung: Python 3.9–3.13 ist installiert (Windows: python.org, 64-Bit).
                Alternativ manuell im Projektordner: <span className="font-mono text-[#4ade80]">{setupCommand}</span>
              </p>
            </div>
          )}

          {/* Live installation progress */}
          {install.phase === 'RUNNING' && (
            <div className="bg-[#0b1a12] border border-[#10b981]/40 rounded-xs p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-1.5 text-[#34d399]">
                  <Loader2 size={12} className="animate-spin" />
                  <span className="font-bold text-[10.5px] uppercase tracking-wider">
                    Installation läuft — Schritt {install.progress?.step ?? 1}/{install.progress?.totalSteps ?? 6}
                  </span>
                </div>
                <span className="font-mono text-[10.5px] text-[#34d399]">
                  {install.progress?.percent ?? 0}%
                </span>
              </div>
              <div className="h-1.5 bg-black/50 rounded overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#10b981] to-[#34d399] transition-all duration-500"
                  style={{ width: `${install.progress?.percent ?? 0}%` }}
                />
              </div>
              <p className="text-[11px] text-neutral-200">{install.progress?.label || 'Wird vorbereitet…'}</p>
              {install.lastLog && (
                <p className="font-mono text-[9.5px] text-neutral-500 truncate" title={install.lastLog}>
                  {install.lastLog}
                </p>
              )}
              <p className="text-[10px] text-neutral-500">
                PyTorch und die Modellgewichte sind große Downloads — das kann einige Minuten dauern.
                Dieses Fenster bitte geöffnet lassen.
              </p>
            </div>
          )}

          {/* Success */}
          {install.phase === 'DONE' && (
            <div className="bg-[#0b1a12] border border-[#10b981]/60 rounded-xs p-2.5 space-y-1.5">
              <div className="flex items-center space-x-1.5 text-[#34d399]">
                <CheckCircle2 size={14} />
                <span className="font-bold text-[11px]">
                  KI-Engine erfolgreich installiert und verifiziert!
                </span>
              </div>
              <p className="text-[11px] text-neutral-300">
                Demucs htdemucs_ft ist einsatzbereit. Starte die Stem-Trennung jetzt erneut —
                sie läuft ab sofort in echter KI-Qualität.
              </p>
            </div>
          )}

          {/* Installation failure with diagnostic */}
          {install.phase === 'FAILED' && (
            <div className="bg-[#241314] border border-[#ff453a]/40 rounded-xs p-2.5 space-y-1.5">
              <div className="flex items-center space-x-1.5 text-[#ff6b62]">
                <AlertTriangle size={12} />
                <span className="font-bold text-[10.5px] uppercase tracking-wider">
                  Installation fehlgeschlagen
                </span>
              </div>
              <p className="font-mono text-[10px] text-[#ff8a80] leading-relaxed break-all">
                {install.error}
              </p>
              {/^.*(kein unterst|python).*$/i.test(install.error ?? '') ? (
                <p className="text-[10.5px] text-neutral-400">
                  Die App installiert Python normalerweise selbst. Klappt das nicht (kein
                  Internet, gesperrte Firmen-Installation), bitte{' '}
                  <span className="font-mono text-[#4ade80]">Python 3.12 (64-Bit)</span> von
                  python.org installieren — Haken bei „Add python.exe to PATH“ — und hier erneut
                  auf Installieren klicken.
                </p>
              ) : null}
              <p className="text-[10.5px] text-neutral-400">
                Manuelle Alternative im Projektordner:{' '}
                <span className="font-mono text-[#4ade80]">{setupCommand}</span>
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="h-12 bg-[#10121a] border-t border-[#1e2130] flex items-center justify-end px-3 space-x-2">
          {install.phase === 'DONE' ? (
            <button
              onClick={() => (onRunWithInstalledEngine ? onRunWithInstalledEngine() : onClose())}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded bg-[#10b981] hover:bg-[#34d399] text-black text-xs font-bold transition-colors"
            >
              <CheckCircle2 size={13} />
              <span>Fertig — jetzt in KI-Qualität trennen</span>
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={installing}
                className="px-3 py-1.5 rounded bg-[#1e2230] hover:bg-[#272d40] border border-[#343b52] text-neutral-200 text-xs font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                Abbrechen
              </button>
              <button
                onClick={onProceedWithFallback}
                disabled={installing}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-[#3a2f14] hover:bg-[#f59e0b] border border-[#f59e0b]/50 text-[#fbbf24] hover:text-black text-xs font-semibold transition-colors disabled:opacity-40 disabled:pointer-events-none"
                title="Nur zur groben Vorschau geeignet — deutliche Übersprecher zwischen den Stems"
              >
                <Sparkles size={12} />
                <span>Fallback (Vorschau-Qualität)</span>
              </button>
              <button
                onClick={handleInstall}
                disabled={installing}
                className="flex items-center space-x-1.5 px-4 py-1.5 rounded bg-gradient-to-r from-[#10b981] to-[#34d399] hover:from-[#34d399] hover:to-[#6ee7b7] text-black text-xs font-bold shadow-md transition-all disabled:opacity-60 disabled:pointer-events-none"
                title="Installiert Python-venv, PyTorch, Demucs und die htdemucs_ft-Gewichte automatisch — komplett lokal"
              >
                {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                <span>{installing ? 'Installiert…' : 'KI-Engine jetzt installieren'}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
