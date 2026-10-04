import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Cloud,
  CloudUpload,
  Cpu,
  Database,
  Download,
  FileAudio,
  HardDrive,
  HeartPulse,
  Info,
  Laptop,
  LoaderCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { RemoteServiceStatus, RemoteStemJobView } from '../../stems/transportTypes';
import { remoteJobStallWarning } from '../../stems/remote/diagnostics';

interface Props {
  open: boolean;
  onClose: () => void;
  onCancel: () => void;
  onRefresh: () => void;
  status: RemoteServiceStatus | null;
  job: RemoteStemJobView | null;
  trackName: string;
  running: boolean;
  error: string | null;
  phaseText?: string;
  /** True, während der Abbruch gerade an den externen Rechner gemeldet wird. */
  cancelPending?: boolean;
}

/** Alter des Heartbeats in Sekunden – darüber gilt der Worker als „nicht mehr sichtbar". */
const WORKER_LIVENESS_SECONDS = 90;

const terminal = (value?: string) => value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED';
const failedStatus = (value?: string) => value === 'FAILED' || value === 'CANCELLED';

type FlowStepState = 'complete' | 'active' | 'waiting' | 'error';

type FlowStep = {
  id: 'copy' | 'drive' | 'worker' | 'inference' | 'import';
  title: string;
  icon: React.ElementType;
};

const FLOW_STEPS: FlowStep[] = [
  { id: 'copy', title: 'Arbeitskopie im Editor', icon: Laptop },
  { id: 'drive', title: 'Google Drive · Ablage bestätigt', icon: CloudUpload },
  { id: 'worker', title: 'Google Colab übernimmt', icon: Server },
  { id: 'inference', title: 'KI-Trennung läuft', icon: Cpu },
  { id: 'import', title: 'Geprüft zurück im Editor', icon: Download },
];

function traceHas(job: RemoteStemJobView | null, ...steps: string[]): boolean {
  if (!job?.trace?.length) return false;
  return steps.some((step) => job.trace?.some((event) => event.step === step));
}

/**
 * Zustände der fünf bestätigten Stationen (exportiert für die Vertragsprüfung
 * in `tests/remote-flow-visibility.test.ts`).
 */
export function deriveStepStates(job: RemoteStemJobView | null, running: boolean, hasError: boolean): FlowStepState[] {
  if (!job) {
    return [hasError ? 'error' : running ? 'active' : 'waiting', 'waiting', 'waiting', 'waiting', 'waiting'];
  }

  const driveConfirmed = traceHas(job, 'editor.input_published', 'editor.transport_recovered') ||
    (job.status !== 'PREPARING' && job.status !== 'PENDING');
  const workerClaimed = Boolean(job.worker) || traceHas(job, 'editor.worker_claim_observed', 'worker.claimed');
  const inferenceFinished = traceHas(job, 'worker.inference_completed', 'worker.completed') ||
    job.status === 'RECONSTRUCTING' || job.status === 'VALIDATING' || job.status === 'COMPLETED';
  const imported = traceHas(job, 'editor.result_imported') || job.status === 'COMPLETED';

  /*
   * Bestätigungen sind unumkehrbar und können nicht übersprungen werden: Ist
   * eine spätere Station bestätigt (z. B. der Import), dann müssen alle
   * vorherigen stattgefunden haben. Ohne diese Monotonie könnte ein fertiger
   * Job mit fehlendem Worker-Eintrag eine „aktive" Colab-Station mitten in der
   * abgeschlossenen Kette zeigen.
   */
  const complete: boolean[] = [true, driveConfirmed, workerClaimed, inferenceFinished, imported];
  for (let index = complete.length - 2; index >= 0; index -= 1) {
    if (complete[index + 1]) complete[index] = true;
  }
  const firstOpen = complete.findIndex((value) => !value);
  const activeIndex = firstOpen >= 0 ? firstOpen : running ? 4 : -1;
  return complete.map((isComplete, index) => {
    if (isComplete) return 'complete';
    if (hasError && index === activeIndex) return 'error';
    if (index === activeIndex) return 'active';
    return 'waiting';
  });
}

function formatBytes(value?: number): string {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return '—';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function formatDuration(value?: number): string {
  if (!Number.isFinite(value) || value === undefined || value < 0) return '—';
  const seconds = Math.round(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} min`;
}

function formatTime(value?: number): string {
  if (!value || !Number.isFinite(value)) return '—';
  return new Date(value).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'gerade eben';
  if (seconds < 60) return `vor ${seconds} s`;
  return `vor ${Math.floor(seconds / 60)} min`;
}

/**
 * Inferenzfortschritt des Workers – oder `null`, solange kein Worker den Job
 * beansprucht hat. Vor dem Claim gibt es keinen KI-Wert; der Upload- und
 * Wartefortschritt wird nie als Rechenfortschritt ausgegeben (exportiert für
 * die Vertragsprüfung in `tests/remote-flow-visibility.test.ts`).
 */
export function normalisedPercent(job: RemoteStemJobView | null, done: boolean): number | null {
  if (done) return 100;
  if (!job?.worker) return null;
  const value = job.workerPercent ?? job.percent;
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function statusLabel(job: RemoteStemJobView | null): string {
  if (!job) return 'wird vorbereitet';
  switch (job.status) {
    case 'PREPARING':
      return 'Arbeitskopie wird übertragen';
    case 'PENDING':
      return 'wartet auf Veröffentlichung';
    case 'RUNNING':
      return job.worker ? 'Colab aktiv' : 'in Drive · wartet auf Colab';
    case 'RECONSTRUCTING':
      return 'Stems werden zusammengesetzt';
    case 'VALIDATING':
      return 'Ergebnisse werden geprüft';
    case 'COMPLETED':
      return 'fertig importiert';
    case 'CANCELLED':
      return 'abgebrochen';
    case 'FAILED':
      return 'fehlgeschlagen';
    default:
      return job.phase || 'unbekannter Status';
  }
}

/**
 * Ehrliche Erklärung des aktuellen Zustands – inklusive der Begründung, warum
 * 0 % vor dem Worker-Claim korrekt ist (exportiert für den Vertragstest).
 */
export function currentExplanation(
  job: RemoteStemJobView | null,
  phaseText: string | undefined,
  done: boolean,
  failed: boolean
): { title: string; description: string; waitingForWorker: boolean } {
  if (failed) {
    return {
      title: job?.status === 'CANCELLED' ? 'Abbruch ist bestätigt' : 'Vorgang wurde unterbrochen',
      description: job?.status === 'CANCELLED'
        ? 'Der externe Rechner verwirft die Rechnung. Es werden keine unvollständigen Stems übernommen.'
        : job?.error?.message || 'Der Ablauf konnte nicht abgeschlossen werden. Die Originaldatei bleibt unverändert.',
      waitingForWorker: false,
    };
  }
  if (done) {
    const count = job?.importedStems?.length ?? job?.stems.length ?? 0;
    return {
      title: 'Ergebnis geprüft und importiert',
      description: `${count || 'Alle'} Stems wurden per Hash geprüft und dauerhaft mit dem Track verknüpft.`,
      waitingForWorker: false,
    };
  }
  if (!job) {
    return {
      title: 'Arbeitskopie wird vorbereitet',
      description: 'Der Editor erstellt eine WAV-Arbeitskopie. Das Original bleibt lokal und wird nicht überschrieben.',
      waitingForWorker: false,
    };
  }
  if (job.transportDegraded) {
    return {
      title: 'Google Drive ist gerade nicht erreichbar',
      description: 'Der Job bleibt gespeichert. Sobald die Jobablage wieder erreichbar ist, wird genau dieser Ablauf fortgesetzt – ohne neuen Upload.',
      waitingForWorker: false,
    };
  }
  if (!job.worker) {
    return {
      title: 'Ablage bestätigt · warte auf Google Colab',
      description: 'Arbeitskopie und Manifest liegen in der bestätigten Jobablage. Jetzt wartet der Editor auf claim.json, also das Lebenszeichen des Colab-Workers.',
      waitingForWorker: true,
    };
  }
  if (job.status === 'VALIDATING' || job.status === 'RECONSTRUCTING') {
    return {
      title: 'Ergebnisse kommen zurück',
      description: 'Colab hat gerechnet. Der Editor lädt die vier Ausgabedateien, prüft ihre Hashes und übernimmt sie erst danach.',
      waitingForWorker: false,
    };
  }
  if (job.status === 'RUNNING' && !traceHas(job, 'worker.inference_started', 'worker.inference_progress') && (job.workerPercent ?? job.percent ?? 0) <= 0) {
    return {
      title: 'Colab hat übernommen · erste Fortschrittsmeldung steht aus',
      description: 'Der Worker ist verbunden. Die erste Inferenzmeldung ist noch nicht in der Jobablage eingetroffen; der Editor wartet weiter und erfindet keinen Prozentwert.',
      waitingForWorker: true,
    };
  }
  return {
    title: 'Google Colab rechnet',
    description: phaseText || job.phase || 'Der Worker verarbeitet die Arbeitskopie und meldet den Fortschritt über die Jobablage.',
    waitingForWorker: false,
  };
}

function flowStepDetail(
  step: FlowStep['id'],
  state: FlowStepState,
  job: RemoteStemJobView | null,
  workerPercent: number | null,
  status: RemoteServiceStatus | null
): string {
  switch (step) {
    case 'copy':
      return job ? `${formatBytes(job.workingCopyBytes)} WAV · Original read-only` : 'Nur die Arbeitskopie wird vorbereitet';
    case 'drive':
      return state === 'complete'
        ? `Arbeitskopie + manifest.json bestätigt${job?.uploadedAt ? ` · ${formatTime(job.uploadedAt)}` : ''}${status?.kind === 'folder' ? ' · Cloud-Sync separat nicht messbar' : ''}`
        : 'Noch nicht in der Jobablage bestätigt';
    case 'worker':
      if (job?.worker) return `Worker ${job.worker.id}${status?.worker?.device ? ` · ${String(status.worker.device).toUpperCase()}` : ''}`;
      return 'Noch kein Colab-Worker hat den Job beansprucht';
    case 'inference':
      if (workerPercent !== null) return `${workerPercent}% gemeldet · ${job?.phase || 'laufend'}`;
      return 'Startet nach dem Worker-Claim';
    case 'import':
      if (state === 'complete') return `${job?.importedStems?.length ?? job?.stems.length ?? 0} Stems geprüft und registriert`;
      return 'Wartet auf geprüfte Ausgabedateien';
  }
}

interface FlowStepCardProps {
  step: FlowStep;
  state: FlowStepState;
  detail: string;
  index: number;
  workerPercent: number | null;
}

const FlowStepCard: React.FC<FlowStepCardProps> = ({ step, state, detail, index, workerPercent }) => {
  const Icon = step.icon;
  const stateLabel = state === 'complete' ? 'bestätigt' : state === 'active' ? 'jetzt' : state === 'error' ? 'Problem' : 'wartet';
  const NodeIcon = state === 'complete' ? CheckCircle2 : state === 'active' ? LoaderCircle : state === 'error' ? AlertTriangle : Icon;
  return (
    <div
      className={`min-w-0 flex-1 rounded-xl border p-3 transition-colors ${
        state === 'complete'
          ? 'border-emerald-400/35 bg-emerald-400/[.07]'
          : state === 'active'
            ? 'border-cyan-400/60 bg-cyan-400/[.09] shadow-[0_0_24px_rgba(34,211,238,.08)]'
            : state === 'error'
              ? 'border-red-400/50 bg-red-400/[.08]'
              : 'border-white/10 bg-white/[.025]'
      }`}
      aria-current={state === 'active' ? 'step' : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          state === 'complete' ? 'bg-emerald-400/15 text-emerald-300' : state === 'active' ? 'bg-cyan-400/15 text-cyan-200' : state === 'error' ? 'bg-red-400/15 text-red-200' : 'bg-white/5 text-neutral-500'
        }`}>
          <NodeIcon size={17} className={state === 'active' ? 'animate-spin' : undefined} />
        </div>
        <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[.12em] ${
          state === 'complete' ? 'bg-emerald-400/15 text-emerald-200' : state === 'active' ? 'bg-cyan-400/15 text-cyan-100' : state === 'error' ? 'bg-red-400/15 text-red-200' : 'bg-white/5 text-neutral-500'
        }`}>{stateLabel}</span>
      </div>
      <div className="mt-3 text-[11px] font-semibold leading-tight text-neutral-100">{index + 1}. {step.title}</div>
      <div className="mt-1 min-h-[2.25rem] text-[10px] leading-relaxed text-neutral-400">{detail}</div>
      {step.id === 'inference' && state === 'active' && workerPercent !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/30" aria-label={`KI-Fortschritt ${workerPercent} Prozent`}>
          <div className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-sky-300 transition-[width] duration-500" style={{ width: `${workerPercent}%` }} />
        </div>
      )}
    </div>
  );
};

/**
 * Transparenter Monitor für den externen Stem-Workflow.
 *
 * Wichtig: Der Prozentwert ist ausschließlich der vom Worker gemeldete
 * Inferenzfortschritt. Upload, Drive-Synchronisierung, Worker-Claim und
 * Rückimport werden als eigene, bestätigte Stationen dargestellt. So wird aus
 * „0 %" keine scheinbar hängende Gesamtanzeige.
 */
export const RemoteFlowModal: React.FC<Props> = ({ open, onClose, onCancel, onRefresh, status, job, trackName, running, error, phaseText, cancelPending = false }) => {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  const failed = Boolean(error || failedStatus(job?.status));
  const done = job?.status === 'COMPLETED' && !running && !error;
  const stepStates = useMemo(() => deriveStepStates(job, running, failed), [job, running, failed]);
  const workerProgress = normalisedPercent(job, done);
  const explanation = currentExplanation(job, phaseText, done, failed);
  const completedSteps = stepStates.filter((state) => state === 'complete').length;
  const stallWarning = job ? remoteJobStallWarning(job, now) : null;
  const warning = job?.transportDegraded
    ? `Die Jobablage ist derzeit nicht erreichbar. ${status?.reason ?? 'Der Ablauf bleibt erhalten und wird beim nächsten erfolgreichen Kontakt fortgesetzt.'}`
    : status?.reachable === false
      ? `Die Jobablage ist derzeit nicht erreichbar. ${status.reason ?? 'Der Job bleibt aktiv und wird weiter geprüft.'}`
      : stallWarning;
  const workerStatus = status?.worker && (!job?.worker || status.worker.id === job.worker.id) ? status.worker : null;
  const heartbeatAt = workerStatus?.heartbeatAt ?? job?.worker?.heartbeatAt;
  const heartbeatAge = heartbeatAt ? Math.max(0, Math.floor((now - heartbeatAt) / 1000)) : null;
  const workerAlive = Boolean(job?.worker && (heartbeatAge === null || heartbeatAge < WORKER_LIVENESS_SECONDS));
  const visibleTrace = [...(job?.trace ?? [])].slice(-12).reverse();
  const flowStatus = done ? 'complete' : failed ? 'error' : 'active';

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-3 sm:p-6" role="presentation">
      <section role="dialog" aria-modal="true" aria-label="Live-Datenfluss der externen Zerlegung" className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-cyan-400/25 bg-[#0d151f] text-neutral-100 shadow-2xl shadow-cyan-950/50">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 bg-gradient-to-r from-[#101f2b] to-[#10151f] px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[.2em] text-cyan-300">
              <Activity size={13} /> Live-Datenfluss · Google Drive → Colab
              <span className={`rounded-full px-2 py-0.5 text-[9px] tracking-[.12em] ${flowStatus === 'complete' ? 'bg-emerald-400/15 text-emerald-200' : flowStatus === 'error' ? 'bg-red-400/15 text-red-200' : 'bg-cyan-400/15 text-cyan-100'}`}>
                {done ? 'fertig' : failed ? 'prüfen' : 'wird verfolgt'}
              </span>
            </div>
            <h2 className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">Was passiert mit deinen Daten?</h2>
            <p className="mt-1 truncate text-xs text-neutral-400 sm:text-sm" title={trackName}>{trackName || 'Aktiver Track'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Datenfluss schließen" className="shrink-0 rounded-lg p-2 text-neutral-400 transition hover:bg-white/10 hover:text-white"><X size={19} /></button>
        </header>

        <div className="min-h-0 overflow-y-auto">
          <div className="space-y-5 p-4 sm:p-6">
            <div className={`rounded-2xl border p-4 sm:p-5 ${failed ? 'border-red-400/40 bg-red-400/[.08]' : done ? 'border-emerald-400/40 bg-emerald-400/[.08]' : 'border-cyan-400/35 bg-cyan-400/[.07]'}`} aria-live="polite">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${failed ? 'bg-red-400/15 text-red-200' : done ? 'bg-emerald-400/15 text-emerald-200' : 'bg-cyan-400/15 text-cyan-100'}`}>
                    {failed ? <AlertTriangle size={20} /> : done ? <CheckCircle2 size={20} /> : <LoaderCircle size={20} className="animate-spin" />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-base font-bold sm:text-lg">{cancelPending ? 'Abbruch wird an Colab gemeldet…' : explanation.title}</div>
                    <p className="mt-1 max-w-2xl text-xs leading-relaxed text-neutral-300 sm:text-sm">{explanation.description}</p>
                  </div>
                </div>
                <div className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-2 rounded-xl bg-black/15 px-3 py-2 text-right text-[10px] sm:min-w-[190px]">
                  <span className="text-left text-neutral-500">Datenweg</span><strong className="text-neutral-100">{completedSteps}/5 bestätigt</strong>
                  <span className="text-left text-neutral-500">KI-Fortschritt</span><strong className={workerProgress === null ? 'text-neutral-400' : 'text-cyan-100'}>{workerProgress === null ? 'noch nicht gestartet' : `${workerProgress} %`}</strong>
                  <span className="text-left text-neutral-500">Letzter Kontakt</span><strong className="text-neutral-300">{heartbeatAge === null ? '—' : formatAge(heartbeatAge)}</strong>
                </div>
              </div>
              <div className="mt-4">
                <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[.14em] text-neutral-500"><span>{statusLabel(job)}</span><span>{workerProgress === null ? 'Worker meldet noch keinen Wert' : `Worker ${workerProgress}%`}</span></div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-black/35" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={workerProgress ?? undefined} aria-valuetext={workerProgress === null ? 'Verarbeitung noch nicht gestartet' : `${workerProgress} Prozent`}>
                  {workerProgress !== null && <div className={`h-full rounded-full transition-[width] duration-500 ${done ? 'bg-gradient-to-r from-emerald-500 to-emerald-300' : 'bg-gradient-to-r from-cyan-600 to-sky-300'}`} style={{ width: `${workerProgress}%` }} />}
                </div>
              </div>
              {explanation.waitingForWorker && !failed && (
                <div className="mt-3 flex gap-2 rounded-xl border border-amber-300/25 bg-amber-300/[.08] p-3 text-xs leading-relaxed text-amber-100">
                  <Info size={16} className="mt-0.5 shrink-0" />
                  <div><strong>Warum steht hier nicht einfach mehr Prozent?</strong>{job?.worker ? ' Colab hat den Job bereits übernommen, aber die erste Inferenzmeldung fehlt noch.' : ' Der Upload ist bestätigt, aber Colab hat noch nicht übernommen.'} <span className="font-semibold">0 % ist in dieser Phase korrekt</span> – es wäre unehrlich, den Download oder die KI-Rechnung vorzutäuschen. {job?.worker ? 'Sobald die nächste Worker-Meldung eintrifft, erscheint hier der echte Inferenzfortschritt.' : 'Sobald claim.json und ein Worker-Heartbeat eintreffen, erscheint hier der echte Inferenzfortschritt.'}</div>
                </div>
              )}
            </div>

            {warning && !failed && (
              <div role="alert" className="flex gap-2 rounded-xl border border-amber-400/40 bg-amber-400/[.08] p-3 text-xs leading-relaxed text-amber-100">
                <AlertTriangle size={17} className="mt-0.5 shrink-0" />
                <span>{warning}</span>
              </div>
            )}

            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div><h3 className="text-sm font-bold">Der Weg deiner Arbeitskopie</h3><p className="mt-0.5 text-[11px] text-neutral-500">Jede Karte wird erst bei einer bestätigten Station grün.</p></div>
                <span className="hidden rounded-full border border-white/10 bg-white/[.03] px-2 py-1 text-[10px] font-mono text-neutral-400 sm:inline-flex">{job?.jobId ? `Job ${job.jobId.slice(0, 12)}…` : 'Job wird angelegt'}</span>
              </div>
              <div className="flex flex-col gap-2 md:flex-row md:items-stretch md:gap-1.5">
                {FLOW_STEPS.map((step, index) => (
                  <React.Fragment key={step.id}>
                    <FlowStepCard
                      step={step}
                      state={stepStates[index]}
                      index={index}
                      detail={flowStepDetail(step.id, stepStates[index], job, workerProgress, status)}
                      workerPercent={workerProgress}
                    />
                    {index < FLOW_STEPS.length - 1 && <div className="flex shrink-0 items-center justify-center text-neutral-600"><ArrowRight size={16} className="hidden md:block" /><ArrowDown size={16} className="md:hidden" /></div>}
                  </React.Fragment>
                ))}
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1.15fr_.85fr]">
              <section className="rounded-xl border border-white/10 bg-white/[.025] p-4">
                <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-bold">Live-Ablaufprotokoll</h3><p className="mt-0.5 text-[11px] text-neutral-500">Editor und Colab schreiben in dieselbe korrelierbare Jobspur.</p></div><Database size={16} className="text-cyan-300/70" /></div>
                {visibleTrace.length ? (
                  <ol className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1" aria-label="Live-Ablaufprotokoll">
                    {visibleTrace.map((event) => (
                      <li key={event.id} className="flex gap-2.5 border-l border-white/15 pl-3 text-xs">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-neutral-500"><time dateTime={new Date(event.at).toISOString()}>{formatTime(event.at)}</time><span className={event.level === 'error' ? 'text-red-300' : event.level === 'warning' ? 'text-amber-200' : event.source === 'worker' ? 'text-violet-200' : 'text-cyan-200'}>{event.source === 'worker' ? 'COLAB' : 'EDITOR'}</span><span className="font-mono">{event.step}</span>{typeof event.percent === 'number' && <span>{event.percent}%</span>}</div>
                          <p className="mt-0.5 leading-relaxed text-neutral-200">{event.message}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="mt-3 flex gap-2 rounded-lg border border-dashed border-white/10 p-3 text-xs text-neutral-500"><Clock3 size={15} className="shrink-0" />Noch kein Job-Ereignis bestätigt. Während die Arbeitskopie vorbereitet wird, bleibt dieses Protokoll bewusst leer.</div>
                )}
              </section>

              <div className="space-y-3">
                <section className="rounded-xl border border-white/10 bg-white/[.025] p-4">
                  <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-bold">Was genau wird übertragen?</h3><FileAudio size={16} className="text-cyan-300/70" /></div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                    <div><div className="text-[10px] uppercase tracking-[.12em] text-neutral-500">Arbeitskopie</div><div className="mt-1 font-semibold text-neutral-200">{formatBytes(job?.workingCopyBytes)} WAV</div></div>
                    <div><div className="text-[10px] uppercase tracking-[.12em] text-neutral-500">Dauer</div><div className="mt-1 font-semibold text-neutral-200">{formatDuration(job?.durationSeconds)}</div></div>
                    <div><div className="text-[10px] uppercase tracking-[.12em] text-neutral-500">Ausgabe</div><div className="mt-1 font-semibold text-neutral-200">{job?.stems.length ?? 4} Stems</div></div>
                    <div><div className="text-[10px] uppercase tracking-[.12em] text-neutral-500">Original</div><div className="mt-1 font-semibold text-emerald-200">bleibt unverändert</div></div>
                  </div>
                  <div className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-400/[.06] p-2.5 text-[10px] leading-relaxed text-emerald-100"><ShieldCheck size={14} className="mt-0.5 shrink-0" />Es wird eine Arbeitskopie verarbeitet – nicht die Originaldatei, nicht rekordbox.xml und nicht master.db.</div>
                </section>

                <section className="rounded-xl border border-white/10 bg-white/[.025] p-4">
                  <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-bold">Verbindung & Rechenort</h3><HeartPulse size={16} className={workerAlive ? 'text-emerald-300' : 'text-neutral-500'} /></div>
                  <div className="mt-3 space-y-2 text-xs">
                    <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-neutral-400"><Cloud size={14} />Transport</span><span className="text-right font-semibold text-neutral-200">{status?.label ?? job?.transport ?? 'Google Drive'}</span></div>
                    <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-neutral-400"><HardDrive size={14} />Jobablage</span><span className={status?.reachable === false ? 'text-amber-200' : 'text-emerald-200'}>{status?.reachable === false ? 'nicht erreichbar' : job ? 'erreichbar / bestätigt' : 'wird geprüft'}</span></div>
                    <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-neutral-400"><Server size={14} />Worker</span><span className={workerAlive ? 'text-emerald-200' : 'text-neutral-400'}>{job?.worker ? `${job.worker.id} · ${workerAlive ? 'online' : 'kein aktuelles Signal'}` : 'noch nicht verbunden'}</span></div>
                    {workerStatus?.device && <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-neutral-400"><Cpu size={14} />Gerät</span><span className="font-semibold uppercase text-neutral-200">{workerStatus.device}{workerStatus.gpu && workerStatus.gpu !== 'cpu' ? ` · ${workerStatus.gpu}` : ''}</span></div>}
                    {heartbeatAt && <div className="flex items-center justify-between gap-3 text-[10px] text-neutral-500"><span>Letzter Heartbeat</span><span>{formatTime(heartbeatAt)} · {formatAge(heartbeatAge ?? 0)}</span></div>}
                    {status?.kind === 'folder' && <p className="mt-3 border-t border-white/10 pt-2 text-[10px] leading-relaxed text-neutral-500">Bestätigt ist der synchronisierte Drive-Ordner. Der eigentliche Cloud-Abgleich von Google Drive wird nicht vom Editor vorgetäuscht und kann hier separat nicht gemessen werden.</p>}
                  </div>
                </section>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-neutral-500">
                <span>Job {job?.jobId ?? 'wird angelegt'}</span>
                <span>·</span><span>Status {job?.status ?? 'PREPARING'}</span>
                {job?.updatedAt && <><span>·</span><span>aktualisiert {formatTime(job.updatedAt)}</span></>}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={onRefresh} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-neutral-300 transition hover:bg-white/10 hover:text-white"><RefreshCw size={13} /> Jetzt prüfen</button>
                {running && !terminal(job?.status) && <button type="button" onClick={onCancel} disabled={cancelPending} title="Der Ablauf wird abgebrochen. Ein Ergebnis wird nicht übernommen." className="rounded-lg border border-red-400/40 bg-red-400/[.05] px-3 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-400/[.12] disabled:cursor-progress disabled:opacity-60">{cancelPending ? 'Abbruch läuft…' : job ? 'Job abbrechen' : 'Vorbereitung abbrechen'}</button>}
                <button type="button" onClick={onClose} className="rounded-lg bg-cyan-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-cyan-500">{running ? 'Im Hintergrund weiter' : 'Schließen'}</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
