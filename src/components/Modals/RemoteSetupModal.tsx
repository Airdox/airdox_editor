/**
 * @license
 * Einrichtungs-Dialog für die externe Zerlegung (Google Drive + Google Colab).
 *
 * Der Dialog ist die einzige Stelle, an der der Nutzer den Transport
 * (Jobablage) einrichtet: Google-Drive-Sync-Ordner (empfohlen) oder
 * rclone-Remote. Danach ist der Button „Externe Zerlegung (Google Colab)"
 * in der Deck-Stem-Leiste aktiv und der komplette Ablauf läuft ohne weitere
 * Bedienung: Arbeitskopie → Drive → Colab-Worker → Ergebnisse zurück →
 * der Editor prüft, speichert dauerhaft und verknüpft mit dem Original-Track.
 *
 * Read-only-Garantie (§3, §31): Es wird ausschließlich die Arbeitskopie
 * hochgeladen. Rekordbox-Originale, rekordbox.xml und master.db werden nie
 * geschrieben – vom Original werden nur SHA-256, Größe und mtime gelesen.
 */

import React, { useState } from 'react';
import { X, Cloud, CloudUpload, Cpu, FolderDown, ShieldCheck, CheckCircle2, AlertTriangle, FolderOpen, Play } from 'lucide-react';
import { stemEngine, type RemoteServiceStatus } from '../../audio/stemEngine';

interface RemoteSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Aktueller Status (vorherige Einrichtung, falls vorhanden). */
  remoteStatus: RemoteServiceStatus | null;
  /** Nach „Speichern & prüfen": App nimmt den frischen Status an. */
  onStatus: (status: RemoteServiceStatus | null) => void;
}

type TransportKind = 'folder' | 'rclone';

interface ProbeState {
  state: 'idle' | 'testing' | 'ok' | 'error';
  label?: string;
  reason?: string;
  root?: string;
}

export const RemoteSetupModal: React.FC<RemoteSetupModalProps> = ({ isOpen, onClose, remoteStatus, onStatus }) => {
  const [kind, setKind] = useState<TransportKind>(remoteStatus?.kind === 'rclone' ? 'rclone' : 'folder');
  const [root, setRoot] = useState<string>(remoteStatus?.root ?? '');
  const [probe, setProbe] = useState<ProbeState>({ state: 'idle' });
  const [folderBusy, setFolderBusy] = useState(false);

  if (!isOpen) return null;

  const desktop = typeof window !== 'undefined' ? (window as any).rekordboxDesktop : undefined;

  const pickFolder = async () => {
    if (!desktop?.chooseDirectory) return;
    setFolderBusy(true);
    try {
      const picked = await desktop.chooseDirectory({ title: 'Google-Drive-Sync-Ordner für Stem-Jobs auswählen' });
      if (typeof picked === 'string' && picked.length > 0) {
        setRoot(picked);
        setProbe({ state: 'idle' });
      }
    } finally {
      setFolderBusy(false);
    }
  };

  const saveAndTest = async () => {
    const trimmed = root.trim();
    if (kind === 'rclone' && !/^[\w.-]+:.+/.test(trimmed)) {
      setProbe({ state: 'error', reason: 'rclone-Ziel muss das Format remote:pfad haben, z. B. gdrive:airdox-stem-jobs.' });
      return;
    }
    if (kind === 'folder' && trimmed.length === 0) {
      setProbe({ state: 'error', reason: 'Bitte den Drive-Sync-Ordner auswählen (z. B. C:\\Users\\…\\Google Drive\\airdox-stem-jobs).' });
      return;
    }
    setProbe({ state: 'testing' });
    try {
      const status = await stemEngine.configureRemote({ kind, root: trimmed });
      onStatus(status);
      if (status?.configured && status.reachable) {
        setProbe({ state: 'ok', label: status.label, root: status.root });
      } else {
        setProbe({ state: 'error', label: status?.label, root: status?.root, reason: status?.reason ?? 'Der Transport ist nicht erreichbar.' });
      }
    } catch (error: any) {
      setProbe({ state: 'error', reason: error?.message ?? String(error) });
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 select-none animate-in fade-in duration-150">
      <div className="w-full max-w-2xl max-h-[88vh] bg-[#0c0d12] border border-[#232635] rounded-xs shadow-2xl flex flex-col overflow-hidden text-neutral-200 text-xs">
        {/* Header */}
        <div className="h-10 bg-[#12141c] border-b border-[#232635] px-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 rounded bg-[#10b981]/15 border border-[#10b981]/40 flex items-center justify-center text-[#34d399]">
              <Cloud size={13} />
            </div>
            <span className="font-bold text-white text-xs tracking-wide uppercase">
              Externe Zerlegung einrichten – Google Drive + Google Colab
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-neutral-400 hover:text-white" title="Schließen">
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Ablauf */}
          <div className="bg-[#10131c] border border-[#1f2534] rounded p-3 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-bold">So läuft die externe Zerlegung</div>
            {[
              { icon: <CloudUpload size={12} className="text-[#00a2ff]" />, text: 'Der Editor lädt eine Arbeitskopie des Tracks in den Drive-Ordner (Jobablage) und legt den Job-Steckbrief an.' },
              { icon: <Cpu size={12} className="text-[#f0b429]" />, text: 'Der Colab-Worker (Notebook) findet den Job, nimmt ihn an und rechnet mit BS-RoFormer High Quality (GPU, sonst CPU).' },
              { icon: <FolderDown size={12} className="text-[#10b981]" />, text: 'Die 4 Stems (Vocals, Drums, Bass, Other) + Ergebnis-Steckbrief landen wieder im selben Drive-Ordner.' },
              { icon: <CheckCircle2 size={12} className="text-[#00a2ff]" />, text: 'Der Editor zieht die Ergebnisse automatisch, prüft sie (Hash, Geometrie, Pegel), speichert sie dauerhaft und verknüpft sie mit dem Original-Track.' },
            ].map((step, index) => (
              <div key={index} className="flex items-start space-x-2">
                <span className="mt-0.5 shrink-0 w-4 text-center font-mono text-neutral-500">{index + 1}</span>
                <span className="shrink-0 mt-0.5">{step.icon}</span>
                <span className="text-neutral-300 leading-snug">{step.text}</span>
              </div>
            ))}
          </div>

          {/* Read-only-Garantie */}
          <div className="bg-[#002f1d]/60 border border-[#10b981]/40 rounded p-3 flex items-start space-x-2">
            <ShieldCheck size={14} className="text-[#34d399] shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-[#6ee7b7]">Read-only-Garantie</div>
              <div className="text-neutral-300 leading-snug mt-0.5">
                Hochgeladen wird ausschließlich die <span className="font-semibold text-white">Arbeitskopie</span>.
                Rekordbox-Originale, <span className="font-mono">rekordbox.xml</span> und <span className="font-mono">master.db</span>{' '}
                werden nie verändert – vom Original liest der Editor nur SHA-256, Größe und Zeitstempel (vor und nach dem Lauf).
              </div>
            </div>
          </div>

          {/* Transport einrichten */}
          <div className="space-y-2.5">
            <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-bold">
              1 · Jobablage (Google Drive) einrichten
            </div>

            <div className="flex items-center space-x-2">
              <button
                onClick={() => { setKind('folder'); setProbe({ state: 'idle' }); }}
                className={`px-2.5 py-1 rounded border font-semibold transition-colors ${
                  kind === 'folder'
                    ? 'bg-[#00284a] border-[#00a2ff] text-[#00e5ff]'
                    : 'bg-[#161922] border-[#232738] text-neutral-300 hover:border-[#0088ff] hover:text-white'
                }`}
                title="Empfohlen: Google Drive für Desktop installiert; der Ordner wird automatisch synchronisiert. Keine Zugangsdaten im Editor."
              >
                Drive-Sync-Ordner (empfohlen)
              </button>
              <button
                onClick={() => { setKind('rclone'); setProbe({ state: 'idle' }); }}
                className={`px-2.5 py-1 rounded border font-semibold transition-colors ${
                  kind === 'rclone'
                    ? 'bg-[#00284a] border-[#00a2ff] text-[#00e5ff]'
                    : 'bg-[#161922] border-[#232738] text-neutral-300 hover:border-[#0088ff] hover:text-white'
                }`}
                title="rclone-Remote, z. B. gdrive:airdox-stem-jobs (Token liegt bei rclone, nicht im Editor)."
              >
                rclone-Remote
              </button>
            </div>

            <div className="flex items-center space-x-2">
              <input
                type="text"
                value={root}
                onChange={(event) => { setRoot(event.target.value); setProbe({ state: 'idle' }); }}
                placeholder={kind === 'folder' ? 'C:\\Users\\…\\Google Drive\\airdox-stem-jobs' : 'gdrive:airdox-stem-jobs'}
                className="flex-1 bg-[#0a0c12] border border-[#232738] rounded px-2.5 py-1.5 text-neutral-200 font-mono text-[11px] focus:outline-none focus:border-[#0088ff]"
              />
              {kind === 'folder' && desktop?.chooseDirectory && (
                <button
                  onClick={pickFolder}
                  disabled={folderBusy}
                  className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded bg-[#161922] hover:bg-[#00385e] border border-[#232738] hover:border-[#0088ff] text-neutral-300 hover:text-white disabled:opacity-50"
                  title="Ordner im Systemdialog auswählen"
                >
                  <FolderOpen size={12} />
                  <span>{folderBusy ? 'Wählt…' : 'Ordner wählen…'}</span>
                </button>
              )}
            </div>
            {kind === 'folder' && (
              <div className="text-neutral-500 leading-snug">
                Empfohlener Name: <span className="font-mono text-neutral-400">airdox-stem-jobs</span> innerhalb des
                Google-Drive-Ordners (z. B. <span className="font-mono text-neutral-400">My Drive → airdox-stem-jobs</span>).
                Der Editor legt darin selbst <span className="font-mono text-neutral-400">jobs/&lt;JobId&gt;/</span> an.
              </div>
            )}

            <div className="flex items-center space-x-2 pt-0.5">
              <button
                onClick={saveAndTest}
                disabled={probe.state === 'testing'}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-gradient-to-r from-[#0088ff] to-[#00c8ff] hover:from-[#0099ff] hover:to-[#22d3ee] text-black font-bold text-xs disabled:opacity-50"
                title="Speichert die Jobablage und prüft sofort die Verbindung"
              >
                <Cloud size={13} />
                <span>{probe.state === 'testing' ? 'Prüfe Verbindung…' : 'Speichern &amp; Verbindung prüfen'}</span>
              </button>
              {probe.state === 'ok' && (
                <span className="flex items-center space-x-1.5 text-[#34d399] font-semibold">
                  <CheckCircle2 size={13} />
                  <span>Verbunden: {probe.label ?? 'Google Drive'} – {probe.root}</span>
                </span>
              )}
            </div>
            {probe.state === 'error' && (
              <div className="flex items-start space-x-2 bg-[#2a1113] border border-[#7f1d1d] rounded p-2.5">
                <AlertTriangle size={13} className="text-[#fca5a5] shrink-0 mt-0.5" />
                <div className="text-[#fca5a5] leading-snug">
                  {probe.reason}
                  {probe.state === 'error' && probe.label && (
                    <div className="text-neutral-400 mt-0.5">
                      Die Einstellung ist gespeichert – sobald der Ordner wieder erreichbar ist, läuft es automatisch weiter.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Colab-Worker */}
          <div className="space-y-2.5">
            <div className="text-[10px] uppercase tracking-wider text-neutral-500 font-bold">
              2 · Colab-Worker (einmalig, ca. 5 Minuten)
            </div>
            <ol className="space-y-1.5 list-none">
              {[
                'Notebook aus dem Repo öffnen: colab/airdox-stem-remote-worker.ipynb (fehlend: im Repo „npm run stems:remote:notebook" – dann Datei nach Google Drive hochladen).',
                'In Colab öffnen (colab.research.google.com → „Drive öffnen"), Laufzeit → Typ: T4 (GPU, empfohlen) oder CPU wählen, dann „Alles ausführen".',
                'Das Notebook läuft im Hintergrund: es holt neue Jobs aus dem oben gewählten Drive-Ordner, rechnet sie und legt die Stems zurück. Bei „JOB_ORDNER" in der ersten Code-Zelle muss der selbe Ordnername stehen (z. B. airdox-stem-jobs).',
              ].map((line, index) => (
                <div key={index} className="flex items-start space-x-2">
                  <span className="shrink-0 w-4 text-center font-mono text-neutral-500">{index + 1}</span>
                  <span className="text-neutral-300 leading-snug">{line}</span>
                </div>
              ))}
            </ol>
            <div className="flex items-center space-x-1.5 text-neutral-500">
              <Play size={11} className="text-[#f0b429]" />
              <span>
                Danach genügt im Editor ein Klick auf{' '}
                <span className="text-neutral-300 font-semibold">„Externe Zerlegung (Google Colab)"</span> – der Rest
                (Upload, Warten, Rückimport, Speicherung) läuft ohne Bedienung.
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="h-11 bg-[#12141c] border-t border-[#232635] px-4 flex items-center justify-end flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded bg-gradient-to-r from-[#10b981] to-[#34d399] hover:from-[#34d399] hover:to-[#6ee7b7] text-black font-bold text-xs shadow-md"
          >
            Fertig
          </button>
        </div>
      </div>
    </div>
  );
};
