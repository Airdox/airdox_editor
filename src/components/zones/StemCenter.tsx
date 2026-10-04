/**
 * @license
 * airdox_SMART_Editor – ZONE 2: Dynamisches Stem-Center (Modell-Isolation).
 *
 * Ersetzt den früheren, überladenen Zustand (doppelte Start-Buttons, sichtbare
 * Alternativ-Modelle, übereinanderliegende Infoboxen) durch eine strenge
 * Drei-Zustands-Logik (Progressive Disclosure):
 *
 *   A – Ruhezustand (IDLE)
 *       Genau eine schmale Zeile: [ + Stem-Separation starten ]
 *       Keine Qualitätsstufen, keine Modell-Auswahllisten, keine Erklärtexte,
 *       kein Fortschritt. Der visuelle Fokus liegt zu 100 % auf der Wellenform.
 *
 *   B – Konfigurations-Modus (CONFIGURE)
 *       Ein modulares Inline-Panel an Ort und Stelle. Modell-Isolation als
 *       strenges Gesetz: sichtbar ist AUSSCHLIESSLICH das aktive Modell.
 *       Alternative Engines existieren in diesem Panel optisch nicht – sie
 *       liegen hinter dem Zahnrad in der ausgelagerten Modell-Auswahl
 *       (StemModelPicker). Parameter: Qualität, Verarbeitungsziel, Job starten.
 *
 *   C – Job-Monitor (PROCESSING)
 *       Das Konfigurations-Panel schließt sich; an seiner Stelle steht genau
 *       EIN flacher, in die Zeile integrierter Fortschrittsbalken:
 *       [Status: …] [Fortschritt: n%] [Abbrechen]. Keine vollflächigen Boxen,
 *       keine schwebenden Infofenster. Nach Abschluss wird daraus nahtlos die
 *       Ansicht der fertigen Stems (DeckStemsControl).
 */

import React from 'react';
import {
  Plus,
  Play,
  X,
  Settings2,
  Cloud,
  Monitor,
  AlertTriangle,
  Download,
  Cpu,
  ChevronDown,
} from 'lucide-react';
import type { StemSeparationProgress } from '../../audio/stemEngine';
import type { RemoteServiceStatus, RemoteStemJobView } from '../../stems/transportTypes';
import type { StemArchitectureOption } from '../../audio/stemArchitectures';
import { DeckStemsControl } from '../DeckStemsControl';
import type { DeckStemsControlProps } from '../DeckStemsControl';
import { StemModelPicker } from './StemModelPicker';
import { UI_ACTION, UI_ACCENT, UI_SURFACE } from '../../ui/theme';
import type { StemCenterPhase } from '../../ui/workspaceLayout';

/** Betriebsart des Jobs (die zwei sichtbaren Qualitätsstufen, §13). */
export type StemQualityMode = 'fast' | 'hq';
/** Verarbeitungsziel: lokal auf diesem Rechner oder auf dem externen Rechner. */
export type StemTargetMode = 'local' | 'remote';

export interface StemCenterProps {
  phase: StemCenterPhase;

  /* ── Zustand B: Konfiguration ─────────────────────────────────────────── */
  configOpen: boolean;
  onOpenConfig: () => void;
  onCloseConfig: () => void;
  modelPickerOpen: boolean;
  onOpenModelPicker: () => void;
  onCloseModelPicker: () => void;

  /** Aktives Modell (exakt eines – die Isolation ist der Kern dieser Ansicht). */
  activeModelLabel: string;
  activeModelDetail?: string;
  /** Vollständige Auswahlliste – NUR für die ausgelagerte Modell-Auswahl. */
  modelOptions: StemArchitectureOption[];
  selectedArchitectureId: string;
  onSelectArchitecture: (id: string) => void;

  qualityMode: StemQualityMode;
  onQualityModeChange: (mode: StemQualityMode) => void;
  targetMode: StemTargetMode;
  onTargetModeChange: (mode: StemTargetMode) => void;
  remoteConfigured: boolean;
  remoteStatus: RemoteServiceStatus | null;
  onOpenRemoteSetup: () => void;

  /* ── Aktion & Voraussetzung ───────────────────────────────────────────── */
  onStartJob: () => void;
  missingModel: { id: string; label: string; detail?: string } | null;
  onInstallModel: () => void;
  /** Ein-Zeilen-Zustand der Engine (z. B. „nicht installiert"). */
  engineReason?: string | null;
  onShowDiagnostics?: () => void;

  /* ── Zustand C: Job-Monitor ───────────────────────────────────────────── */
  progress: StemSeparationProgress | null;
  onCancelSeparation: () => void;
  remoteCancelPendingJobId?: string | null;
  remoteCancelCooldownJobId?: string | null;

  /* ── Zustand „fertige Stems": der Mixer ───────────────────────────────── */
  deckProps: DeckStemsControlProps;
}

export const StemCenter: React.FC<StemCenterProps> = (props) => {
  const {
    phase,
    configOpen,
    onOpenConfig,
    onCloseConfig,
    modelPickerOpen,
    onOpenModelPicker,
    onCloseModelPicker,
    activeModelLabel,
    activeModelDetail,
    modelOptions,
    selectedArchitectureId,
    onSelectArchitecture,
    qualityMode,
    onQualityModeChange,
    targetMode,
    onTargetModeChange,
    remoteConfigured,
    remoteStatus,
    onOpenRemoteSetup,
    onStartJob,
    missingModel,
    onInstallModel,
    engineReason,
    onShowDiagnostics,
    progress,
    onCancelSeparation,
    remoteCancelPendingJobId = null,
    remoteCancelCooldownJobId = null,
    deckProps,
  } = props;

  const activeRemoteJob = (remoteStatus?.jobs ?? []).find(
    (job) => job.status !== 'COMPLETED' && job.status !== 'FAILED' && job.status !== 'CANCELLED'
  );
  const remoteLabel = remoteStatus?.label ?? 'Google Drive';

  return (
    <section className="flex flex-col select-none" data-zone="2" data-stem-center={phase} aria-label="Stem-Center">
      {/* ── ZUSTAND A: eine einzige, unaufdringliche Zeile ─────────────────── */}
      {phase === 'IDLE' && (
        <button
          type="button"
          onClick={onOpenConfig}
          data-stem-action="start-config"
          className="h-7 w-full flex items-center gap-2 px-3 text-[10.5px] font-semibold tracking-wide text-neutral-500 hover:text-[#00c8ff] bg-[#0c0e12] hover:bg-[#0e1520] border-b border-[#14161c] hover:border-[#0088ff]/40 transition-colors"
          title="Stem-Separation vorbereiten: Modell bestätigen, Qualität und Verarbeitungsziel wählen"
        >
          <Plus size={12} />
          <span>Stem-Separation starten</span>
        </button>
      )}

      {/* ── ZUSTAND B: Konfigurations-Panel (Modell-Isolation) ─────────────── */}
      {phase === 'CONFIGURE' && (
        <div
          className="border-b border-[#1c1e26] bg-[#0e1015] px-3 py-2 flex flex-col gap-2"
          data-stem-panel="configure"
        >
          {/* Kopfzeile: ausschließlich das aktive Modell + Zahnrad + Einklappen */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Cpu size={13} className="text-[#00c8ff] flex-shrink-0" />
              <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-bold flex-shrink-0">
                Aktives Modell:
              </span>
              <span
                className="text-[11.5px] font-semibold text-[#00e5ff] truncate"
                title={activeModelDetail ? `Aktives Modell: ${activeModelLabel}. ${activeModelDetail}` : `Aktives Modell: ${activeModelLabel}`}
                data-stem-active-model={activeModelLabel}
              >
                {activeModelLabel}
              </span>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                type="button"
                onClick={onOpenModelPicker}
                data-stem-action="open-model-picker"
                className={`${UI_ACTION.ghost} flex items-center gap-1.5 px-2 py-1 rounded text-[10.5px]`}
                title="Modell-Auswahl öffnen (ausgelagert): Architektur wechseln, installierte Engines vergleichen"
              >
                <Settings2 size={12} />
                <span>Modell wechseln</span>
              </button>
              <button
                type="button"
                onClick={onCloseConfig}
                className={`${UI_ACTION.ghost} w-6 h-6 flex items-center justify-center rounded`}
                title="Konfiguration einklappen (zurück zum Ruhezustand)"
                aria-label="Konfiguration einklappen"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Parameter-Zeile: linear, ohne Untermenüs */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {/* Qualität */}
            <div className="flex items-center gap-2" role="radiogroup" aria-label="Qualität">
              <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-bold">Qualität</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onQualityModeChange('fast')}
                  data-stem-param="quality-fast"
                  aria-pressed={qualityMode === 'fast'}
                  className={`${qualityMode === 'fast' ? UI_ACTION.secondarySelected : UI_ACTION.secondary} px-2.5 py-1 text-[10.5px] rounded`}
                  title="Schnell: rechnet lokal, in-process, GPU wenn vorhanden – kurze Wartezeit, gute Trennung"
                >
                  Schnell
                </button>
                <button
                  type="button"
                  onClick={() => onQualityModeChange('hq')}
                  data-stem-param="quality-hq"
                  aria-pressed={qualityMode === 'hq'}
                  className={`${qualityMode === 'hq' ? UI_ACTION.secondarySelected : UI_ACTION.secondary} px-2.5 py-1 text-[10.5px] rounded`}
                  title="High Quality: BS-RoFormer-Studio-Trennung – höchste Reinheit, längere Rechenzeit"
                >
                  High Quality
                </button>
              </div>
            </div>

            {/* Verarbeitungsziel */}
            <div className="flex items-center gap-2" role="radiogroup" aria-label="Verarbeitungsziel">
              <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-bold">Verarbeitungsziel</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onTargetModeChange('local')}
                  data-stem-param="target-local"
                  aria-pressed={targetMode === 'local'}
                  className={`${targetMode === 'local' ? UI_ACTION.secondarySelected : UI_ACTION.secondary} px-2.5 py-1 text-[10.5px] rounded flex items-center gap-1.5`}
                  title="Lokal (GPU/CPU): die Trennung läuft auf diesem Rechner"
                >
                  <Monitor size={11} />
                  <span>Lokal (GPU/CPU)</span>
                </button>
                <button
                  type="button"
                  onClick={() => (remoteConfigured ? onTargetModeChange('remote') : onOpenRemoteSetup())}
                  data-stem-param="target-remote"
                  aria-pressed={targetMode === 'remote'}
                  className={`${targetMode === 'remote' ? UI_ACTION.secondarySelected : UI_ACTION.secondary} px-2.5 py-1 text-[10.5px] rounded flex items-center gap-1.5`}
                  title={
                    remoteConfigured
                      ? `Google Colab: die Zerlegung läuft auf dem externen Rechner (${remoteLabel}) – der Editor lädt hoch und importiert die Stems zurück`
                      : 'Noch nicht eingerichtet – Klick öffnet die Einrichtung für den externen Rechner (Drive-Ordner + Colab-Worker)'
                  }
                >
                  <Cloud size={11} />
                  <span>Google Colab</span>
                </button>
              </div>
            </div>

            {/* Bestätigende Aktion – genau eine Primäraktion in diesem Panel */}
            <div className="flex items-center gap-2 ml-auto">
              {missingModel && (
                <button
                  type="button"
                  onClick={onInstallModel}
                  className={`${UI_ACTION.secondary} px-3 py-1.5 text-[10.5px] rounded flex items-center gap-1.5`}
                  title={`Das aktive Modell „${missingModel.label}" ist nicht installiert – jetzt einrichten`}
                >
                  <Download size={12} />
                  <span>Modell installieren</span>
                </button>
              )}
              <button
                type="button"
                onClick={onStartJob}
                disabled={Boolean(missingModel)}
                data-stem-action="run-job"
                className={`${UI_ACTION.primary} px-4 py-1.5 text-[11px] rounded flex items-center gap-1.5 shadow-md`}
                title={
                  missingModel
                    ? 'Erst das aktive Modell installieren – danach startet der Job'
                    : `Job jetzt ausführen: ${qualityMode === 'hq' ? 'High Quality' : 'Schnell'} · ${targetMode === 'remote' ? 'Google Colab' : 'Lokal (GPU/CPU)'}`
                }
              >
                <Play size={12} fill="currentColor" />
                <span>Job jetzt ausführen</span>
              </button>
            </div>
          </div>

          {/* Genau eine Zustandszeile – kein Erklärblock, kein Fortschritt */}
          {(engineReason || remoteStatus?.reachable === false) && (
            <div className="flex items-center gap-2 text-[10px]" style={{ color: UI_ACCENT.warning }}>
              <AlertTriangle size={11} className="flex-shrink-0" />
              <span className="truncate">
                {remoteStatus?.reachable === false
                  ? `${remoteLabel} ist gerade nicht erreichbar – der Job bleibt erhalten und läuft weiter, sobald die Verbindung steht.`
                  : engineReason}
              </span>
              {onShowDiagnostics && (
                <button
                  type="button"
                  onClick={onShowDiagnostics}
                  className="underline decoration-dotted hover:text-white flex-shrink-0"
                  title="System-Diagnose der Stem-Runtime ausführen"
                >
                  Diagnose
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── ZUSTAND C: ein flacher, integrierter Fortschrittsbalken ────────── */}
      {phase === 'PROCESSING' && (
        <div
          className="h-8 border-b border-[#1c1e26] flex items-center gap-3 px-3 text-[10.5px]"
          style={{ backgroundColor: UI_SURFACE.inset }}
          data-stem-panel="processing"
          role="status"
          aria-live="polite"
        >
          <span className="flex items-center gap-1.5 text-[#9fdcff] font-semibold flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-[#00c8ff] animate-pulse" />
            <span>Status:</span>
          </span>
          <span className="text-neutral-200 truncate min-w-0">
            {describeProcessing(progress, activeRemoteJob, remoteLabel)}
          </span>
          {activeRemoteJob && (
            <span className="font-mono text-[9.5px] text-neutral-500 flex-shrink-0">{activeRemoteJob.jobId.slice(0, 8)}…</span>
          )}

          {/* Fortschritt: Linie, keine Fläche */}
          <span className="font-mono font-bold text-white flex-shrink-0 ml-auto">
            Fortschritt: {processingPercent(progress, activeRemoteJob)}%
          </span>
          <div className="w-40 h-[2px] rounded-full overflow-hidden flex-shrink-0" style={{ backgroundColor: '#1a1c26' }}>
            <div
              className="h-full bg-gradient-to-r from-[#0088ff] to-[#00e5ff] transition-all duration-150"
              style={{ width: `${processingPercent(progress, activeRemoteJob)}%` }}
            />
          </div>

          <button
            type="button"
            onClick={onCancelSeparation}
            disabled={
              (activeRemoteJob && remoteCancelPendingJobId === activeRemoteJob.jobId) ||
              (activeRemoteJob && remoteCancelCooldownJobId === activeRemoteJob.jobId)
            }
            data-stem-action="cancel-job"
            className={`${UI_ACTION.danger} px-2.5 py-1 rounded text-[10px] font-semibold flex items-center gap-1.5 flex-shrink-0`}
            title={
              activeRemoteJob && remoteCancelPendingJobId === activeRemoteJob.jobId
                ? 'Abbruchfahne wird in der Jobablage gespeichert; der Worker reagiert nach der Synchronisierung'
                : activeRemoteJob && remoteCancelCooldownJobId === activeRemoteJob.jobId
                  ? 'Die letzte Abbruchanfrage wurde nicht bestätigt – bitte kurz warten'
                  : 'Laufende Stem-Separation abbrechen: keine Stems werden übernommen'
            }
          >
            <X size={11} />
            <span>
              {activeRemoteJob && remoteCancelPendingJobId === activeRemoteJob.jobId
                ? 'Abbruch läuft…'
                : activeRemoteJob && remoteCancelCooldownJobId === activeRemoteJob.jobId
                  ? 'Kurz warten…'
                  : 'Abbrechen'}
            </span>
          </button>
        </div>
      )}

      {/* ── Fertige Stems: der Fortschritt ist in den Mixer übergegangen ─────
          Der Mixer bleibt auch beim Nachkonfigurieren sichtbar (Zustand B
          oberhalb, Ergebnis darunter) – nur während eines laufenden Jobs tritt
          er zurück, weil die Zeile C dann den Zustand führt. */}
      {deckProps.stems && phase !== 'PROCESSING' && <DeckStemsControl {...deckProps} />}

      {/* Der leise Einstieg in den Konfigurations-Modus bei fertigen Stems */}
      {phase === 'STEMS' && !configOpen && (
        <button
          type="button"
          onClick={onOpenConfig}
          data-stem-action="reconfigure"
          className="h-5 w-full flex items-center gap-1.5 px-3 text-[9.5px] text-neutral-600 hover:text-[#00c8ff] bg-[#0b0d11] border-b border-[#14161c] transition-colors"
          title="Stem-Separation erneut konfigurieren (Modell, Qualität, Verarbeitungsziel)"
        >
          <ChevronDown size={10} />
          <span>Separation erneut ausführen…</span>
        </button>
      )}

      {/* Ausgelagerte Modell-Auswahl: hier – und nur hier – existieren Alternativen */}
      <StemModelPicker
        open={modelPickerOpen}
        options={modelOptions}
        selectedId={selectedArchitectureId}
        onSelect={(id) => {
          onSelectArchitecture(id);
          onCloseModelPicker();
        }}
        onClose={onCloseModelPicker}
        remoteConfigured={remoteConfigured}
        onOpenRemoteSetup={onOpenRemoteSetup}
      />
    </section>
  );
};

/**
 * Statustext der Fortschrittszeile. Exakt der im Plan definierte Fall:
 *   „Wartet auf externen Rechner (Google Drive)" | „Fortschritt: 2%"
 */
export function describeProcessing(
  progress: StemSeparationProgress | null,
  remoteJob: RemoteStemJobView | undefined,
  remoteLabel: string
): string {
  if (remoteJob) {
    /*
     * Der im Plan definierte Wartetext – wörtlich, damit der Bediener den
     * Unterschied zwischen „läuft hier" und „wartet auf den externen Rechner"
     * ohne Nachdenken erkennt.
     */
    if (remoteJob.status === 'PENDING' || remoteJob.status === 'PREPARING') {
      return `Wartet auf externen Rechner (${remoteLabel})`;
    }
    const device = remoteJob.cpuFallback ? 'CPU-Fallback' : remoteJob.device ?? 'GPU';
    return `Externer Rechner rechnet (${device}) – ${remoteJob.phase}`;
  }
  return progress?.phaseText ?? 'Job wird gestartet…';
}

/** Fortschritt in Prozent – der Worker-Wert hat Vorrang vor dem Editor-Wert. */
export function processingPercent(
  progress: StemSeparationProgress | null,
  remoteJob: RemoteStemJobView | undefined
): number {
  const raw = remoteJob ? remoteJob.workerPercent ?? remoteJob.percent ?? 0 : progress?.percent ?? 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}
