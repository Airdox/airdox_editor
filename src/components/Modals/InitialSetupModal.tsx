/**
 * @license
 * InitialSetupModal – Ersteinrichtungs- & Installationsassistent
 *
 * Fragt beim ersten Start:
 *  1. Wohin die Anwendung / Projekte gespeichert werden sollen
 *  2. Wohin die Stem-bedingten Daten (Modelle, Checkpoints, Python-Runtime, Cache) installiert werden
 *  3. Bietet die automatische Vollinstallation aller KI-Stem-Modelle & Runtimes an,
 *     damit der Nutzer beim ersten Öffnen direkt loslegen kann.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Folder,
  HardDrive,
  Cpu,
  Download,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Sparkles,
  Layers,
  ArrowRight,
  ShieldCheck,
  Zap,
  Info,
  Check,
  X,
} from 'lucide-react';
import {
  installStemEngineWithProgress,
  type StemInstallProgressUpdate,
} from '../../audio/stemEngineInstaller';
import {
  APP_PROJECTS_PRESETS,
  STEM_DATA_PRESETS,
  DEFAULT_WORKSPACE_PATH_SETTINGS,
  loadWorkspacePathSettings,
  saveWorkspacePathSettings,
  type WorkspacePathSettings,
} from '../../audio/stemArchitectures';
import { Tooltip, HelpBadge } from '../Tooltip';
import { DirectorySelector } from '../DirectorySelector';

interface InitialSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (paths: WorkspacePathSettings) => void;
}

type InstallPhase = 'IDLE' | 'RUNNING' | 'DONE' | 'FAILED';

export const InitialSetupModal: React.FC<InitialSetupModalProps> = ({
  isOpen,
  onClose,
  onComplete,
}) => {
  const [paths, setPaths] = useState<WorkspacePathSettings>(() =>
    loadWorkspacePathSettings(typeof window === 'undefined' ? null : window.localStorage)
  );

  const [installPhase, setInstallPhase] = useState<InstallPhase>('IDLE');
  const [installProgress, setInstallProgress] = useState<StemInstallProgressUpdate | null>(null);
  const [installLog, setInstallLog] = useState<string>('');
  const [installError, setInstallError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState<boolean>(false);
  const [autoInstallChecked, setAutoInstallChecked] = useState<boolean>(true);

  useEffect(() => {
    if (isOpen) {
      setPaths(loadWorkspacePathSettings(typeof window === 'undefined' ? null : window.localStorage));
    }
  }, [isOpen]);

  const handleStartInstallation = useCallback(async () => {
    setInstallPhase('RUNNING');
    setInstallError(null);
    setInstallLog('');
    setInstallProgress({
      step: 1,
      totalSteps: 6,
      percent: 5,
      label: 'Initialisiere Installationsumgebung…',
    });

    try {
      const result = await installStemEngineWithProgress((progress) => {
        setInstallProgress(progress);
        if (progress.logLine) {
          setInstallLog(progress.logLine);
        }
      });

      if (result.ok) {
        setInstallPhase('DONE');
        setRestartRequired(Boolean(result.restartRequired));
      } else {
        setInstallPhase('FAILED');
        setInstallError(result.error || 'Unbekannter Installationsfehler aufgetreten.');
      }
    } catch (err) {
      setInstallPhase('FAILED');
      setInstallError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleFinish = () => {
    const updated: WorkspacePathSettings = {
      ...paths,
      setupCompleted: true,
    };
    saveWorkspacePathSettings(typeof window === 'undefined' ? null : window.localStorage, updated);
    onComplete(updated);
  };

  const handleSkip = () => {
    const updated: WorkspacePathSettings = {
      ...paths,
      setupCompleted: true,
    };
    saveWorkspacePathSettings(typeof window === 'undefined' ? null : window.localStorage, updated);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-[110] p-4 select-none animate-in fade-in duration-200">
      <div className="bg-[#101218] border border-[#262a3a] rounded-sm shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden text-neutral-200 max-h-[92vh]">
        {/* Header */}
        <div className="h-12 bg-gradient-to-r from-[#141722] via-[#181c2b] to-[#12141c] border-b border-[#252a3d] flex items-center justify-between px-4">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#0088ff] to-[#00d2ff] flex items-center justify-center text-black font-extrabold shadow-sm">
              <Sparkles size={14} />
            </div>
            <div>
              <div className="font-bold text-white text-[13px] tracking-wide flex items-center gap-1.5">
                <span>airdox_SMART_Editor</span>
                <span className="text-[9.5px] px-1.5 py-0.2 rounded bg-[#0088ff]/20 text-[#00c8ff] font-mono border border-[#0088ff]/40">
                  Ersteinrichtung
                </span>
              </div>
              <div className="text-[10px] text-neutral-400">
                Installationspfade &amp; KI-Stem-Engine Setup
              </div>
            </div>
          </div>
          <button
            onClick={handleSkip}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#202434] rounded transition-colors"
            title="Assistent schließen / Später fortsetzen"
          >
            <X size={15} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-4 space-y-4 overflow-y-auto min-h-0 text-xs">
          
          {/* Welcome Banner */}
          <div className="bg-gradient-to-r from-[#0d2238] to-[#0e1626] border border-[#1b436e]/60 rounded-xs p-3 flex items-start space-x-3">
            <ShieldCheck size={20} className="text-[#00c8ff] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-bold text-white text-[12px]">
                Willkommen beim DJ-Audio-Editor mit nativer AI-Quelltrennung!
              </div>
              <p className="text-[11px] text-neutral-300 leading-relaxed">
                Um beim ersten Öffnen sofort loslegen zu können, konfigurieren Sie bitte kurz die Speicherorte
                für Ihre Projekte und die hochpräzisen KI-Stem-Modelle (BS-RoFormer SDR 9.65 &amp; HT-Demucs ONNX).
              </p>
            </div>
          </div>

          {/* Section 1: Pfade festlegen */}
          <div className="space-y-3 bg-[#13151f] border border-[#1e2230] rounded-xs p-3.5">
            <div className="flex items-center justify-between border-b border-[#202538] pb-1.5">
              <div className="flex items-center space-x-2 text-white font-bold text-[11.5px] uppercase tracking-wider">
                <Folder size={13} className="text-[#00a2ff]" />
                <span>1. Installations- &amp; Speicherorte</span>
              </div>
              <HelpBadge
                title="Speicherort-Verwaltung"
                text="Legen Sie fest, wo Projektdateien, Exporte und die KI-Modelldateien abgelegt werden. Wählen Sie einen Preset-Ordner aus dem Dropdown-Menü oder wählen Sie einen beliebigen Ordner über den Datei-Explorer."
              />
            </div>

            {/* Path 1: App & Projects */}
            <DirectorySelector
              label="Anwendungs- & Projektverzeichnis:"
              value={paths.appProjectsPath}
              onChange={(newPath) => setPaths((prev) => ({ ...prev, appProjectsPath: newPath }))}
              presets={APP_PROJECTS_PRESETS}
              dialogTitle="Projekt- & Anwendungsverzeichnis auswählen"
              helperText="Hier werden bearbeitete Projekte (.airdox.json), Audioexporte (WAV, FLAC, MP3) und Aufnahmen gespeichert."
              icon={<HardDrive size={12} className="text-[#0088ff]" />}
              badgeText="Projekte"
            />

            {/* Path 2: Stem Data & Models */}
            <DirectorySelector
              label="Stem-Daten- & KI-Modellverzeichnis:"
              value={paths.stemDataPath}
              onChange={(newPath) => setPaths((prev) => ({ ...prev, stemDataPath: newPath }))}
              presets={STEM_DATA_PRESETS}
              dialogTitle="Stem- & KI-Modellverzeichnis auswählen"
              helperText="Speicherort für KI-Gewichte (BS-RoFormer ~503 MB, ONNX-Netze), isoliertes Python-Environment und Stem-Cache."
              icon={<Cpu size={12} className="text-[#00e5ff]" />}
              badgeText="SSD empfohlen"
            />
          </div>

          {/* Section 2: Automatische Vollinstallation */}
          <div className="space-y-3 bg-[#13151f] border border-[#1e2230] rounded-xs p-3.5">
            <div className="flex items-center justify-between border-b border-[#202538] pb-1.5">
              <div className="flex items-center space-x-2 text-white font-bold text-[11.5px] uppercase tracking-wider">
                <Zap size={13} className="text-[#10b981]" />
                <span>2. Vollautomatische KI-Installation</span>
              </div>
              <span className="text-[9.5px] font-mono text-[#10b981] bg-[#10b981]/15 px-1.5 py-0.2 rounded border border-[#10b981]/30">
                Empfohlen für Sofortstart
              </span>
            </div>

            {installPhase === 'IDLE' && (
              <div className="space-y-3">
                <div className="bg-[#0b1612] border border-[#10b981]/30 rounded-xs p-3 space-y-2">
                  <div className="flex items-start space-x-2.5">
                    <Download size={16} className="text-[#10b981] shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <div className="font-bold text-[#6ee7b7] text-[11.5px]">
                        Alle KI-Stem-Modelle &amp; Runtimes jetzt automatisch einrichten
                      </div>
                      <p className="text-[10.5px] text-neutral-300 leading-relaxed">
                        Richtet die isolierte Python-Runtime, PyTorch (mit GPU/DirectML-Unterstützung), den BS-RoFormer
                        Studio-Master-Checkpoint (~503 MB, SDR 9.65) und das in-process ONNX Live-Modell ein.
                        Verifiziert alle SHA256-Prüfsummen und führt eine kurze Test-Inferenz durch.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-1 text-[10px] text-neutral-400">
                    <div className="flex items-center space-x-1.5 bg-black/30 p-1.5 rounded">
                      <Check size={11} className="text-[#10b981]" />
                      <span>BS-RoFormer (Studio Master · 4 Stems)</span>
                    </div>
                    <div className="flex items-center space-x-1.5 bg-black/30 p-1.5 rounded">
                      <Check size={11} className="text-[#10b981]" />
                      <span>HT-Demucs ONNX (Live-DJ in-process)</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <label className="flex items-center space-x-2 cursor-pointer text-neutral-300 text-[11px]">
                    <input
                      type="checkbox"
                      checked={autoInstallChecked}
                      onChange={(e) => setAutoInstallChecked(e.target.checked)}
                      className="w-3.5 h-3.5 rounded accent-[#10b981] cursor-pointer"
                    />
                    <span>Sofortige automatische Vollinstallation aktivieren</span>
                  </label>

                  <button
                    onClick={handleStartInstallation}
                    className="flex items-center space-x-2 px-4 py-2 rounded bg-gradient-to-r from-[#10b981] to-[#00c853] hover:from-[#34d399] hover:to-[#00e676] text-black font-extrabold text-xs shadow-lg transition-all cursor-pointer"
                  >
                    <Download size={13} />
                    <span>Jetzt alles automatisch installieren</span>
                  </button>
                </div>
              </div>
            )}

            {installPhase === 'RUNNING' && (
              <div className="bg-[#0b1612] border border-[#10b981]/40 rounded-xs p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2 text-[#6ee7b7]">
                    <Loader2 size={14} className="animate-spin text-[#10b981]" />
                    <span className="font-bold text-[11px]">
                      Installation läuft — Schritt {installProgress?.step ?? 1}/{installProgress?.totalSteps ?? 6}
                    </span>
                  </div>
                  <span className="font-mono font-bold text-[#10b981] text-[11.5px]">
                    {installProgress?.percent ?? 0}%
                  </span>
                </div>

                <div className="w-full h-2 bg-black/60 rounded-full overflow-hidden border border-white/10">
                  <div
                    className="h-full bg-gradient-to-r from-[#10b981] via-[#34d399] to-[#00e5ff] transition-all duration-300"
                    style={{ width: `${installProgress?.percent ?? 5}%` }}
                  />
                </div>

                <div className="text-[11px] text-white font-medium">
                  {installProgress?.label || 'Vorbereitung der KI-Komponenten…'}
                </div>

                {installLog && (
                  <div className="bg-black/60 border border-white/5 rounded p-2 font-mono text-[9.5px] text-neutral-400 truncate">
                    {installLog}
                  </div>
                )}
              </div>
            )}

            {installPhase === 'DONE' && (
              <div className="bg-[#0b1c12] border border-[#10b981]/60 rounded-xs p-3 space-y-2">
                <div className="flex items-center space-x-2 text-[#34d399]">
                  <CheckCircle2 size={16} />
                  <span className="font-bold text-[12px]">
                    Alle KI-Stem-Modelle und Runtimes erfolgreich installiert und verifiziert!
                  </span>
                </div>
                <p className="text-[11px] text-neutral-300 leading-relaxed">
                  Die BS-RoFormer Engine (ep17 SDR 9.6568) und die HT-Demucs Live Engine sind voll funktionsfähig.
                  Beim Klick auf den Stem-Trennungs-Button wird direkt der in den Einstellungen gewählte
                  Architekturmodus ausgeführt.
                </p>
                {restartRequired && (
                  <div className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 p-1.5 rounded">
                    Hinweis: Ein Neustart der Anwendung wird empfohlen, um die neue Python-Runtime vollständig zu laden.
                  </div>
                )}
              </div>
            )}

            {installPhase === 'FAILED' && (
              <div className="bg-[#241214] border border-[#ff453a]/40 rounded-xs p-3 space-y-2">
                <div className="flex items-center space-x-2 text-[#ff6b62]">
                  <AlertTriangle size={15} />
                  <span className="font-bold text-[11.5px]">Installation fehlgeschlagen</span>
                </div>
                <p className="font-mono text-[10.5px] text-[#ff8a80] break-all">{installError}</p>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[10px] text-neutral-400">
                    Sie können die Installation jederzeit später über das Einstellungsmenü wiederholen.
                  </span>
                  <button
                    onClick={handleStartInstallation}
                    className="px-3 py-1 bg-[#ff453a]/20 hover:bg-[#ff453a]/30 border border-[#ff453a]/50 text-white rounded text-xs font-semibold"
                  >
                    Erneut versuchen
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Summary Info */}
          <div className="bg-[#0e1017] border border-[#1e2130] rounded-xs p-2.5 flex items-center justify-between text-[10.5px] text-neutral-400">
            <div className="flex items-center space-x-2">
              <Info size={13} className="text-[#00c8ff]" />
              <span>Sie können diese Einstellungen jederzeit unter „Workspace Settings" anpassen.</span>
            </div>
            <span className="font-mono text-neutral-500">v0.4.2</span>
          </div>

        </div>

        {/* Footer Buttons */}
        <div className="h-14 bg-[#0e1017] border-t border-[#1e2232] flex items-center justify-between px-4">
          <button
            onClick={handleSkip}
            disabled={installPhase === 'RUNNING'}
            className="px-3.5 py-1.5 rounded bg-[#181a24] hover:bg-[#222534] border border-[#2d3144] text-neutral-300 hover:text-white text-xs font-medium disabled:opacity-40 transition-colors"
          >
            Später einrichten / Überspringen
          </button>

          <div className="flex items-center space-x-2">
            {installPhase === 'DONE' ? (
              <button
                onClick={handleFinish}
                className="flex items-center space-x-2 px-5 py-2 rounded bg-gradient-to-r from-[#10b981] to-[#00e5ff] hover:from-[#34d399] hover:to-[#22d3ee] text-black font-extrabold text-xs shadow-lg transition-all cursor-pointer"
              >
                <CheckCircle2 size={14} />
                <span>Einrichtung abschließen &amp; Loslegen</span>
              </button>
            ) : (
              <button
                onClick={handleFinish}
                disabled={installPhase === 'RUNNING'}
                className="flex items-center space-x-2 px-4 py-1.5 rounded bg-[#0088ff] hover:bg-[#00a2ff] text-white font-bold text-xs disabled:opacity-50 transition-colors cursor-pointer"
              >
                <span>Pfade speichern &amp; Editor öffnen</span>
                <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
