/**
 * @license
 * StemModelInstallModal – installiert exakt das im Einstellungsmenü gewählte
 * KI-Modell.
 *
 * Wird geöffnet, wenn der Nutzer ein Modell im Einstellungsmenü ausgewählt
 * hat, das noch nicht installiert ist, und auf den Installations-Button
 * (Hauptfenster, Deck-Stem-Leiste oder Einstellungsmenü) drückt. Der Aufruf
 * übergibt die gewählte Modell-ID an den Installer – es wird nichts anderes
 * und nichts zusätzlich installiert. Fortschritt wird Schritt für Schritt
 * gemeldet (Python-Modelle: Runtime, Abhängigkeiten, Gewichte, Verifizierung;
 * ONNX-Modelle: Download, Hash-Prüfung).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Cpu, Download, Loader2, X } from 'lucide-react';
import {
  installStemEngineWithProgress,
  type StemInstallProgressUpdate,
  type StemInstallResult,
} from '../../audio/stemEngineInstaller';

export interface StemInstallModelInfo {
  id: string;
  label: string;
  detail?: string;
}

interface StemModelInstallModalProps {
  isOpen: boolean;
  model: StemInstallModelInfo | null;
  onClose: () => void;
  /** Nach erfolgreicher Installation aufrufen (Architekturliste neu prüfen). */
  onInstalled?: (modelId: string, result?: StemInstallResult) => void;
}

type InstallState =
  | { phase: 'IDLE' }
  | { phase: 'RUNNING'; progress: StemInstallProgressUpdate | null; lastLog: string }
  | { phase: 'DONE'; modelId: string; restartRequired?: boolean; label?: string; warning?: string }
  | { phase: 'FAILED'; error: string };

export const StemModelInstallModal: React.FC<StemModelInstallModalProps> = ({
  isOpen,
  model,
  onClose,
  onInstalled,
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
    if (!model) return;
    setInstall({ phase: 'RUNNING', progress: null, lastLog: '' });
    try {
      const result = await installStemEngineWithProgress(
        (progress) => {
          setInstall((prev) => ({
            phase: 'RUNNING',
            progress,
            lastLog: progress.logLine || (prev.phase === 'RUNNING' ? prev.lastLog : ''),
          }));
        },
        { modelId: model.id }
      );
      if (result.ok) {
        setInstall({
          phase: 'DONE',
          modelId: result.model || model.id,
          restartRequired: result.restartRequired,
          label: result.label,
          warning: result.warning,
        });
        onInstalled?.(result.model || model.id, result);
      } else {
        setInstall({ phase: 'FAILED', error: result.error || 'Unbekannter Installationsfehler.' });
      }
    } catch (error) {
      setInstall({
        phase: 'FAILED',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [model, onInstalled]);

  if (!isOpen || !model) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[110] select-none p-4">
      <div className="w-full max-w-lg bg-[#12141a] border border-[#272935] rounded-sm shadow-2xl overflow-hidden flex flex-col text-neutral-200 text-xs">
        <div className="h-10 bg-[#171922] border-b border-[#252834] flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center space-x-2 min-w-0">
            <Cpu size={15} className="text-[#0088ff] shrink-0" />
            <span className="font-bold text-white text-xs tracking-wide truncate">
              Modell installieren – {model.label}
            </span>
          </div>
          <button
            onClick={onClose}
            disabled={installing}
            aria-label="Schließen"
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors disabled:opacity-40"
          >
            <X size={14} />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto max-h-[70vh]">
          <div className="bg-[#0b1420] border border-[#0088ff]/30 rounded-xs p-2.5 space-y-1.5">
            <div className="text-[11px] text-neutral-200">
              <span className="font-bold text-white">{model.label}</span>
              <span className="font-mono text-[10px] text-neutral-400 ml-2">{model.id}</span>
            </div>
            {model.detail && <div className="text-[10px] text-neutral-500">{model.detail}</div>}
            <div className="text-[10px] text-neutral-400 leading-relaxed">
              Installiert <span className="text-white font-semibold">genau dieses Modell</span> aus dem
              Einstellungsmenü: Gewichte werden heruntergeladen und geprüft. PyTorch-Modelle
              richten bei Bedarf eine lokale Python-Runtime ein; ONNX-Modelle benötigen nur die
              Modelldatei. Internet und freier Speicher werden benötigt.
            </div>
          </div>

          {install.phase === 'IDLE' && (
            <div className="bg-[#0b1a12] border border-[#10b981]/30 rounded-xs p-2.5 space-y-1.5">
              <div className="flex items-center space-x-1.5 text-[#34d399]">
                <Download size={12} />
                <span className="font-bold text-[10.5px] uppercase tracking-wider">
                  {model.label} jetzt installieren
                </span>
              </div>
              <p className="text-[11px] text-neutral-300 leading-relaxed">
                Nach Abschluss ist das gewählte Modell einsatzbereit und neue Separationen
                laufen mit genau dieser Architektur.
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
                <div
                  className="h-full bg-gradient-to-r from-[#10b981] to-[#34d399] transition-all duration-500"
                  style={{ width: `${install.progress?.percent ?? 0}%` }}
                />
              </div>
              <p className="text-[11px] text-neutral-200">{install.progress?.label || 'Wird vorbereitet…'}</p>
              {install.lastLog && <p className="font-mono text-[9.5px] text-neutral-500 truncate">{install.lastLog}</p>}
            </div>
          )}

          {install.phase === 'DONE' && (
            <div className="bg-[#0b1a12] border border-[#10b981]/60 rounded-xs p-2.5 space-y-1.5">
              <div className="flex items-center space-x-1.5 text-[#34d399]">
                <CheckCircle2 size={14} />
                <span className="font-bold text-[11px]">
                  {/* Wortlaut kommt aus dem Installer: PyTorch = verifiziert (Test-Inferenz),
                      ONNX = Datei + SHA256, ggf. ohne Katalog-Pin. */}
                  {install.label ?? `${model.label} installiert und verifiziert!`}
                </span>
              </div>
              <p className="text-[11px] text-neutral-300">
                {install.restartRequired
                  ? 'Bitte laufende Arbeiten speichern und die App bzw. den Server neu starten, damit die neue Runtime übernommen wird.'
                  : <>Modell <span className="font-mono text-[10px]">{install.modelId}</span> ist bereit – neue Separationen laufen mit genau dieser Architektur.</>}
              </p>
              {install.warning && (
                <p className="text-[10.5px] text-[#f5d78e] font-mono break-all leading-relaxed">{install.warning}</p>
              )}
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
                Internetverbindung, freien Speicher und (bei PyTorch-Modellen) Python 3.11 (64-Bit)
                prüfen, dann erneut versuchen.
              </p>
            </div>
          )}
        </div>

        <div className="h-12 bg-[#10121a] border-t border-[#1e2130] flex items-center justify-end px-4 space-x-2 shrink-0">
          {install.phase === 'DONE' ? (
            <button
              onClick={onClose}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded bg-[#10b981] hover:bg-[#34d399] text-black text-xs font-bold"
            >
              <CheckCircle2 size={13} />
              <span>Fertig</span>
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={installing}
                className="px-3 py-1.5 rounded bg-[#1e2230] hover:bg-[#272d40] border border-[#343b52] text-neutral-200 text-xs font-medium disabled:opacity-40"
              >
                {install.phase === 'FAILED' ? 'Abbrechen' : 'Schließen'}
              </button>
              <button
                onClick={() => void handleInstall()}
                disabled={installing}
                className="flex items-center space-x-1.5 px-4 py-1.5 rounded bg-gradient-to-r from-[#10b981] to-[#34d399] text-black text-xs font-bold disabled:opacity-60"
              >
                {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                <span>{installing ? 'Installiert…' : install.phase === 'FAILED' ? 'Erneut installieren' : 'Modell installieren'}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
