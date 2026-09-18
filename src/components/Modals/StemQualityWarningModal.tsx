/**
 * @license
 * StemQualityWarningModal – REFACTORED per §25, §38
 * - Zeigt STEM AI UNAVAILABLE statt Fallback-Option
 * - BS-RoFormer primär, kein spektraler Pseudo-Stem
 * - Diagnose, Preflight, Installation
 */

import React, { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, X, Cpu, ShieldAlert, Download, CheckCircle2, Loader2 } from 'lucide-react';
import {
  installStemEngineWithProgress,
  StemInstallProgressUpdate,
} from '../../audio/stemEngineInstaller';

interface StemQualityWarningModalProps {
  isOpen: boolean;
  reason: string;
  onClose: () => void;
  onProceedWithFallback: () => void;
  onEngineInstalled?: () => void;
  onRunWithInstalledEngine?: () => void;
}

type InstallState =
  | { phase: 'IDLE' }
  | { phase: 'RUNNING'; progress: StemInstallProgressUpdate | null; lastLog: string }
  | { phase: 'DONE'; restartRequired?: boolean }
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
        setInstall({ phase: 'DONE', restartRequired: result.restartRequired });
        if (!result.restartRequired) onEngineInstalled?.();
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

  const isUnavailable = reason.includes('STEM_ENGINE_UNAVAILABLE') || reason.includes('BS-RoFormer') || reason.includes('nicht verfügbar');

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-50 select-none p-4">
      <div className="w-full max-w-lg max-h-[calc(100dvh-2rem)] bg-[#13151c] border border-[#ef4444]/40 rounded shadow-2xl overflow-hidden flex flex-col text-neutral-200 text-xs animate-in fade-in zoom-in-95 duration-150">
        <div className="h-10 shrink-0 bg-[#1d1010] border-b border-[#3a1414] flex items-center justify-between px-3">
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 rounded bg-[#ef4444]/20 border border-[#ef4444]/50 flex items-center justify-center text-[#ef4444]">
              <AlertTriangle size={14} />
            </div>
            <span className="font-bold text-white text-xs tracking-wide">
              {isUnavailable ? 'STEM AI UNAVAILABLE – BS-RoFormer nicht bereit' : 'KI-Stem-Engine nicht verfügbar'}
            </span>
          </div>
          <button onClick={onClose} disabled={installing} aria-label="Schließen" className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded">
            <X size={14} />
          </button>
        </div>

        <div className="p-4 space-y-3.5 overflow-y-auto min-h-0">
          <div className="bg-[#241010] border border-[#ef4444]/30 p-3 rounded flex items-start space-x-2.5">
            <ShieldAlert size={18} className="text-[#ef4444] flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="font-bold text-[#fca5a5] text-xs block">
                {isUnavailable ? 'Kein Pseudo-Stem wird erzeugt – echte AI erforderlich' : 'Ohne AI-Modell keine performancetaugliche Qualität'}
              </span>
              <p className="text-[11.5px] text-neutral-300 leading-relaxed">
                Spektraler Fallback (EQ, HPSS, Bandpass) ist <span className="text-white font-semibold">KEINE echte AI-Separation</span> und wird nicht als "Stem Separation" angeboten. Echte Trennqualität liefert ausschließlich das trainierte Modell{' '}
                <span className="font-mono text-[#00c8ff]">model_bs_roformer_ep_17_sdr_9.6568.ckpt</span> (BS-RoFormer, 4 Stems, SDR 9.65).
                <br />
                <br />
                Nachinstallation: im beschreibbaren Benutzerdatenordner unter <span className="font-mono text-[#4ade80]">stems/stem-runtime</span> und <span className="font-mono text-[#4ade80]">stems/Models</span>. Bestehende gebündelte Modelle werden ebenfalls erkannt.
                <br />
                Installer: Python 3.10–3.12 (64-Bit), empfohlen 3.11. PyTorch/torchaudio 2.5.1.
              </p>
            </div>
          </div>

          <div className="bg-[#0b0c10] border border-[#1d1f2a] rounded-xs p-2.5 space-y-1.5">
            <div className="flex items-center space-x-1.5 text-neutral-400">
              <Cpu size={12} />
              <span className="font-bold text-[10.5px] uppercase tracking-wider">Diagnose</span>
            </div>
            <p className="font-mono text-[10.5px] text-[#ff8a80] leading-relaxed break-all">{reason}</p>
            <p className="text-[10px] text-neutral-500 mt-2">
              SHA256 Modell: 3e9daecd70aaed5b5a0d1f861cc4d77eaa45afb3fc6301b1cf32c1be0f5868fb (wird beim Start verifiziert)
            </p>
          </div>

          {install.phase === 'IDLE' && (
            <div className="bg-[#0b1a12] border border-[#10b981]/30 rounded-xs p-2.5 space-y-2">
              <div className="flex items-center space-x-1.5 text-[#34d399]">
                <Download size={12} />
                <span className="font-bold text-[10.5px] uppercase tracking-wider">Empfohlen: BS-RoFormer jetzt installieren</span>
              </div>
              <p className="text-[11px] text-neutral-300 leading-relaxed">
                Installiert eine isolierte Python-Umgebung, PyTorch (CPU), die BS-RoFormer-Architektur, Checkpoint (~503 MiB) und Config. Internet und mehrere GB freier Speicher werden benötigt. Anschließend werden SHA256 und eine kurze Test-Inferenz geprüft.
              </p>
              <p className="text-[10px] text-neutral-500">
                Kein Terminal erforderlich. Falls Python fehlt, zuerst Python 3.11 (64-Bit) installieren.
              </p>
            </div>
          )}

          {install.phase === 'RUNNING' && (
            <div className="bg-[#0b1a12] border border-[#10b981]/40 rounded-xs p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-1.5 text-[#34d399]">
                  <Loader2 size={12} className="animate-spin" />
                  <span className="font-bold text-[10.5px] uppercase tracking-wider">
                    Installation läuft — Schritt {install.progress?.step ?? 1}/{install.progress?.totalSteps ?? 6}
                  </span>
                </div>
                <span className="font-mono text-[10.5px] text-[#34d399]">{install.progress?.percent ?? 0}%</span>
              </div>
              <div className="h-1.5 bg-black/50 rounded overflow-hidden">
                <div className="h-full bg-gradient-to-r from-[#10b981] to-[#34d399] transition-all duration-500" style={{ width: `${install.progress?.percent ?? 0}%` }} />
              </div>
              <p className="text-[11px] text-neutral-200">{install.progress?.label || 'Wird vorbereitet…'}</p>
              {install.lastLog && <p className="font-mono text-[9.5px] text-neutral-500 truncate">{install.lastLog}</p>}
            </div>
          )}

          {install.phase === 'DONE' && (
            <div className="bg-[#0b1a12] border border-[#10b981]/60 rounded-xs p-2.5 space-y-1.5">
              <div className="flex items-center space-x-1.5 text-[#34d399]">
                <CheckCircle2 size={14} />
                <span className="font-bold text-[11px]">BS-RoFormer erfolgreich installiert und verifiziert!</span>
              </div>
              <p className="text-[11px] text-neutral-300">{install.restartRequired ? 'Bitte laufende Arbeiten speichern und die App bzw. den Server neu starten, damit die neue Runtime übernommen wird.' : 'Modell SHA256 geprüft, kurze Test-Inferenz erfolgreich. Starte jetzt erneut.'}</p>
            </div>
          )}

          {install.phase === 'FAILED' && (
            <div className="bg-[#241314] border border-[#ff453a]/40 rounded-xs p-2.5 space-y-1.5">
              <div className="flex items-center space-x-1.5 text-[#ff6b62]">
                <AlertTriangle size={12} />
                <span className="font-bold text-[10.5px] uppercase tracking-wider">Installation fehlgeschlagen</span>
              </div>
              <p className="font-mono text-[10px] text-[#ff8a80] break-all">{install.error}</p>
              <p className="text-[10.5px] text-neutral-400">
                Internetverbindung, freien Speicher und Python 3.11 (64-Bit) prüfen, dann erneut versuchen.
              </p>
            </div>
          )}
        </div>

        <div className="h-12 shrink-0 bg-[#10121a] border-t border-[#1e2130] flex items-center justify-end px-3 space-x-2">
          {install.phase === 'DONE' ? (
            <button
              onClick={() => (!install.restartRequired && onRunWithInstalledEngine ? onRunWithInstalledEngine() : onClose())}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded bg-[#10b981] hover:bg-[#34d399] text-black text-xs font-bold"
            >
              <CheckCircle2 size={13} />
              <span>{install.restartRequired ? 'Fertig — Schließen' : 'Fertig — jetzt in KI-Qualität trennen'}</span>
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={installing}
                className="px-3 py-1.5 rounded bg-[#1e2230] hover:bg-[#272d40] border border-[#343b52] text-neutral-200 text-xs font-medium disabled:opacity-40"
              >
                Schließen
              </button>
              <button
                onClick={handleInstall}
                disabled={installing}
                className="flex items-center space-x-1.5 px-4 py-1.5 rounded bg-gradient-to-r from-[#10b981] to-[#34d399] text-black text-xs font-bold disabled:opacity-60"
              >
                {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                <span>{installing ? 'Installiert…' : 'BS-RoFormer installieren'}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
