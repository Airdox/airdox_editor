/**
 * @license
 * Statusfenster des Fernpfads – **Laufzettel der Daten** (§16, §20, §21, §40).
 *
 * Was dieses Fenster leisten muss
 * --------------------------------
 * Der Fernpfad führt die Arbeitskopie durch vier Reiche: dieser Rechner, die
 * synchronisierte Ablage, die Google-Cloud und den Colab-Worker. Eine einzelne
 * Prozentzahl kann das nicht abbilden: sie bleibt bei **0 %, solange kein
 * Worker gerechnet hat** – also genau in der Phase, in der der Nutzer nichts
 * anderes sieht. „0 %“ ist dann nicht falsch, aber es beantwortet nicht die
 * Frage, die zählt: _Wo stehen die Daten, und woran ist das festgemacht?_
 *
 * Deshalb zeigt das Fenster drei Dinge gleichzeitig:
 *
 *   1. **Den Weg** – zehn Stationen, jede einzeln, mit Zustand, Uhrzeit, Dauer
 *      und Beleg (`src/stems/remote/dataFlow.ts`).
 *   2. **Die ehrliche Lücke** – die Cloud-Synchronisation ist die einzige
 *      Station ohne technischen Beleg; sie bleibt sichtbar offen, bis sie
 *      bestätigt oder durch den Rückweg bewiesen ist.
 *   3. **Das Protokoll** – Editor und Colab schreiben in dieselbe Jobspur.
 *
 * Grundregel: **Eine Station ist nur belegt, wenn es einen Beleg gibt.** Was
 * der Editor nicht beobachten kann, wird nicht geschätzt, nicht hochgerechnet
 * und nicht „nach Gefühl“ grün gefärbt.
 */
import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  CheckCircle2,
  Clock,
  Clock3,
  ClipboardCopy,
  Cloud,
  CloudUpload,
  Cpu,
  Database,
  Download,
  ExternalLink,
  FileAudio,
  FolderOpen,
  HardDrive,
  HeartPulse,
  HelpCircle,
  Info,
  Laptop,
  LoaderCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import type { RemoteServiceStatus, RemoteStemJobView } from '../../stems/transportTypes';
import type { RemoteFlowStation, RemoteFlowState, RemoteFlowWhere } from '../../stems/remote/dataFlow';
import { REMOTE_FLOW_WHERE_LABEL, formatFlowAge, formatFlowClock } from '../../stems/remote/dataFlow';
import { remoteJobStallWarning } from '../../stems/remote/diagnostics';

interface Props {
  open: boolean;
  onClose: () => void;
  onCancel: () => void;
  onRefresh: () => void;
  /** Bestätigt, dass die Arbeitskopie in Google Drive angekommen ist (§40). */
  onConfirmCloudSync?: (jobId: string) => Promise<void> | void;
  status: RemoteServiceStatus | null;
  job: RemoteStemJobView | null;
  trackName: string;
  running: boolean;
  error: string | null;
  phaseText?: string;
  /** True, während die Abbruchfahne in die konfigurierte Jobablage geschrieben wird. */
  cancelPending?: boolean;
}

/** Alter des Heartbeats in Sekunden – darüber gilt der Worker als „nicht mehr sichtbar“. */
const WORKER_LIVENESS_SECONDS = 90;

const COLAB_NOTEBOOK_URL =
  'https://colab.research.google.com/github/Airdox/airdox_editor/blob/main/colab/airdox-stem-remote-worker.ipynb';

const terminal = (value?: string) => value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED';
const failedStatus = (value?: string) => value === 'FAILED';
const cancelledStatus = (value?: string) => value === 'CANCELLED';

/* ------------------------------------------------------------------------- *
 * Anzeige-Helfer
 * ------------------------------------------------------------------------- */

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

/** Dauer zwischen zwei Stationen – „wie lange hat dieser Schritt gedauert?“. */
function formatStepDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}:${String(rest).padStart(2, '0')} min`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} h`;
}

/* ------------------------------------------------------------------------- *
 * Laufzettel
 * ------------------------------------------------------------------------- */

const WHERE_ICON: Record<RemoteFlowWhere, React.ElementType> = {
  local: HardDrive,
  store: Server,
  cloud: Cloud,
  worker: Cpu,
};

const WHERE_STYLE: Record<RemoteFlowWhere, string> = {
  local: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  store: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  cloud: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
  worker: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
};

const STATE_CHIP: Record<RemoteFlowState, string> = {
  done: 'bg-emerald-400/15 text-emerald-200 border-emerald-400/40',
  active: 'bg-cyan-400/15 text-cyan-100 border-cyan-400/40',
  pending: 'bg-white/5 text-neutral-500 border-white/10',
  unknown: 'bg-amber-400/15 text-amber-200 border-amber-400/40',
  failed: 'bg-red-400/15 text-red-200 border-red-400/40',
  cancelled: 'bg-amber-400/15 text-amber-200 border-amber-400/40',
};

const STATE_LABEL: Record<RemoteFlowState, string> = {
  done: 'belegt',
  active: 'jetzt',
  pending: 'wartet',
  unknown: 'nicht messbar',
  failed: 'hier geendet',
  cancelled: 'abgebrochen',
};

/** Dauer seit der letzten Station mit Beleg (null, wenn es keine vorherige gibt). */
function stepDuration(stations: RemoteFlowStation[], index: number): number | null {
  const current = stations[index];
  const previous = [...stations.slice(0, index)].reverse().find((station) => typeof station.at === 'number');
  if (typeof current.at !== 'number' || !previous || typeof previous.at !== 'number') return null;
  return Math.max(0, current.at - previous.at);
}

/* ------------------------------------------------------------------------- *
 * Kopfbereich: was gerade passiert
 * ------------------------------------------------------------------------- */

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

function traceHas(job: RemoteStemJobView | null, ...steps: string[]): boolean {
  return Boolean(job?.trace?.some((event) => steps.includes(event.step)));
}

function workerHasClaimed(job: RemoteStemJobView | null): boolean {
  return Boolean(job?.worker) || traceHas(job, 'editor.worker_claim_observed', 'worker.claimed');
}

function workerHasCancelled(job: RemoteStemJobView | null): boolean {
  return Boolean(job?.trace?.some((event) => event.source === 'worker' && (event.step === 'worker.cancelled' || event.status === 'CANCELLED')));
}

function usesLocalFolderTransport(job: RemoteStemJobView | null): boolean {
  const transport = job?.transport?.toLocaleLowerCase('de-DE') ?? '';
  return transport.includes('ordner') || transport.includes('folder');
}

/**
 * Eine verständliche Antwort auf „was passiert gerade?“.
 *
 * Aus der Datei exportiert, damit `tests/remote-flow-visibility.test.ts` die
 * Zusagen prüfen kann, ohne das Fenster zu rendern: vor einem Worker-Claim
 * gibt es **keinen** KI-Prozentwert, und der Cloud-Abgleich wird nie als
 * messbar dargestellt.
 */
export function currentExplanation(
  job: RemoteStemJobView | null,
  phaseText: string | undefined,
  done: boolean,
  failed: boolean
): { title: string; description: string; waitingForWorker: boolean } {
  if (cancelledStatus(job?.status)) {
    const workerAcknowledged = workerHasCancelled(job);
    const workerClaimed = workerHasClaimed(job);
    if (workerAcknowledged) {
      return {
        title: 'Abbruch vom Colab-Worker bestätigt',
        description: 'Der Worker hat die Abbruchfahne verarbeitet. Das Ergebnis wird nicht importiert; unvollständige Stems bleiben außen vor.',
        waitingForWorker: false,
      };
    }
    if (!workerClaimed) {
      return {
        title: 'Vor der Übernahme durch Colab abgebrochen',
        description: 'Der Editor hat die Abbruchfahne in die konfigurierte Jobablage geschrieben, aber in diesem Ablauf kam kein Worker-Claim an. Bei einem synchronisierten Ordner beweist das weder den Cloud-Upload noch den Empfang durch Colab. Prüfen Sie, ob die Colab-Notebook-Zelle #5 läuft, Drive gemountet ist und JOB_ORDNER auf denselben Ordner wie die Editor-Jobablage zeigt; danach den Job neu starten.',
        waitingForWorker: false,
      };
    }
    return {
      title: 'Abbruch angefordert · Worker-Bestätigung fehlt',
      description: 'Die Abbruchfahne wurde geschrieben, aber noch kein worker.cancelled-Ereignis empfangen. Das Ergebnis wird nicht importiert. Prüfen Sie, ob die Colab-Zelle noch läuft und der Drive-Ordner synchronisiert wird.',
      waitingForWorker: false,
    };
  }
  if (failed) {
    return {
      title: 'Vorgang wurde unterbrochen',
      description: job?.error?.message || 'Der Ablauf konnte nicht abgeschlossen werden. Die Originaldatei bleibt unverändert.',
      waitingForWorker: false,
    };
  }
  if (done) {
    const count = job?.importedStems?.length ?? job?.stems.length ?? 0;
    return {
      title: 'Stems sind geprüft zurück',
      description: `${count || 'Alle'} Ausgabedateien wurden per Hash, Geometrie und Pegel geprüft und dauerhaft mit dem Track verknüpft.`,
      waitingForWorker: false,
    };
  }
  if (!job) {
    return {
      title: 'Noch kein Job',
      description: 'Der Laufzettel entsteht, sobald die externe Zerlegung gestartet wird.',
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
  if (job.status === 'VALIDATING' || job.status === 'RECONSTRUCTING') {
    return {
      title: 'Ergebnisse kommen zurück',
      description: 'Colab hat gerechnet. Der Editor lädt die vier Ausgabedateien, prüft ihre Hashes und übernimmt sie erst danach.',
      waitingForWorker: false,
    };
  }
  if (!job.worker) {
    return usesLocalFolderTransport(job)
      ? {
        title: 'Dateien im Sync-Ordner geschrieben · warte auf Google Colab',
        description: 'Arbeitskopie und Steckbrief wurden in den lokalen Drive-Sync-Ordner geschrieben. Der Editor kann den Upload in die Google-Cloud nicht messen und wartet auf claim.json vom Colab-Worker. Prüfen Sie die Datei auch in Drive im Web und starten Sie die Worker-Zelle im Notebook.',
        waitingForWorker: true,
      }
      : {
        title: 'Ablage bestätigt · warte auf Google Colab',
        description: 'Arbeitskopie und Steckbrief liegen in der bestätigten Jobablage (Hash wurde zurückgelesen). Jetzt wartet der Editor auf claim.json, also das Lebenszeichen des Colab-Workers.',
        waitingForWorker: true,
      };
  }
  if ((job.workerPercent ?? job.percent ?? 0) <= 0) {
    return {
      title: 'Colab hat übernommen · erste Fortschrittsmeldung steht aus',
      description:
        'Der Worker ist verbunden und hat den Job beansprucht. Die erste Inferenzmeldung ist noch nicht eingetroffen; der Editor wartet weiter und erfindet keinen Prozentwert.',
      waitingForWorker: true,
    };
  }
  return {
    title: 'Google Colab rechnet',
    description: phaseText || job.phase || 'Der Worker verarbeitet die Arbeitskopie und meldet den Fortschritt über die Jobablage.',
    waitingForWorker: false,
  };
}

/** Vom Worker gemeldeter Inferenzfortschritt – `null`, solange er nicht rechnet. */
export function normalisedPercent(job: RemoteStemJobView | null, done: boolean): number | null {
  if (done) return 100;
  if (!job?.worker) return null;
  const value = job.workerPercent ?? job.percent;
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

/** Ein kopierbarer Diagnosebericht – für Support und Nachweiskette. */
function buildReport(job: RemoteStemJobView | null, status: RemoteServiceStatus | null, trackName: string, now: number): string {
  if (!job) return 'Kein Fern-Job ausgewählt.';
  const lines: string[] = [
    'AirDox – Datenfluss-Protokoll der externen Zerlegung',
    `Stand: ${new Date(now).toLocaleString('de-DE')}`,
    `Track: ${trackName}`,
    `Job: ${job.jobId}`,
    `Ablage: ${status?.label ?? job.transport ?? '–'} (erreichbar: ${status?.reachable ? 'ja' : 'nein'})`,
    `Status: ${job.status} · Phase: ${job.phase} · Fortschritt: ${Math.round(job.percent ?? 0)} %`,
    job.worker ? `Worker: ${job.worker.id} (Host ${job.worker.host ?? '?'})` : 'Worker: –',
    '',
    'Stationen:',
  ];
  for (const station of job.flow?.stations ?? []) {
    const at = typeof station.at === 'number' ? formatTime(station.at) : '–';
    lines.push(`  [${STATE_LABEL[station.state].padEnd(13)}] ${station.title} – ${at}${station.detail ? ` – ${station.detail}` : ''}`);
    for (const fact of station.facts ?? []) lines.push(`      ${fact.label}: ${fact.value}`);
  }
  if (job.error) lines.push('', `Fehler: ${job.error.code} – ${job.error.message}`);
  if (job.trace?.length) {
    lines.push('', 'Ablaufprotokoll:');
    for (const event of job.trace.slice(-40)) {
      lines.push(
        `  ${new Date(event.at).toLocaleTimeString('de-DE')} ${event.source === 'worker' ? 'Colab' : 'Editor'} · ${event.step}${
          event.code ? ` [${event.code}]` : ''
        }: ${event.message}`
      );
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------------- *
 * Fenster
 * ------------------------------------------------------------------------- */

export const RemoteFlowModal: React.FC<Props> = ({
  open,
  onClose,
  onCancel,
  onRefresh,
  onConfirmCloudSync,
  status,
  job,
  trackName,
  running,
  error,
  phaseText,
  cancelPending = false,
}) => {
  const [now, setNow] = useState(Date.now());
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [openFolderFeedback, setOpenFolderFeedback] = useState<string | null>(null);

  const openLocalJobFolder = async () => {
    const root = status?.root || job?.transportRoot;
    if (!root || !job?.jobId) return;
    const normalizedRoot = root.replace(/[\\/]+$/, '');
    const target = `${normalizedRoot}/jobs/${job.jobId}/input`;
    setOpeningFolder(true);
    try {
      const bridge = (window as unknown as {
        rekordboxDesktop?: {
          openPath?: (p: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
        };
      }).rekordboxDesktop;
      if (bridge?.openPath) {
        const res = await bridge.openPath(target);
        if (res.ok) {
          setOpenFolderFeedback('Im Dateimanager geöffnet');
        } else {
          setOpenFolderFeedback(res.error || 'Ordner konnte nicht geöffnet werden');
        }
      } else {
        await navigator.clipboard.writeText(target);
        setOpenFolderFeedback('Pfad in Zwischenablage kopiert');
      }
    } catch {
      setOpenFolderFeedback('Fehler beim Öffnen');
    } finally {
      setOpeningFolder(false);
      window.setTimeout(() => setOpenFolderFeedback(null), 3000);
    }
  };

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!open) return null;

  const cancelled = cancelledStatus(job?.status);
  const failed = !cancelled && Boolean(error || failedStatus(job?.status));
  const done = job?.status === 'COMPLETED' && !running && !error;
  const stations = job?.flow?.stations ?? [];
  const current = stations.find((station) => station.id === job?.flow?.currentId) ?? null;
  const workerProgress = normalisedPercent(job, done);
  const explanation = currentExplanation(job, phaseText, done, failed);
  const doneCount = stations.filter((station) => station.state === 'done').length;
  const stallWarning = job ? remoteJobStallWarning(job, now) : null;
  const warning =
    job?.transportDegraded || status?.reachable === false
      ? `Die Jobablage ist derzeit nicht erreichbar. ${
          status?.reason ?? 'Der Ablauf bleibt erhalten und wird beim nächsten erfolgreichen Kontakt fortgesetzt.'
        }`
      : stallWarning;

  const workerStatus = status?.worker && (!job?.worker || status.worker.id === job.worker.id) ? status.worker : null;
  const heartbeatAt = workerStatus?.heartbeatAt ?? job?.worker?.heartbeatAt;
  const heartbeatAge = heartbeatAt ? Math.max(0, Math.floor((now - heartbeatAt) / 1000)) : null;
  const workerAlive = Boolean(job?.worker && (heartbeatAge === null || heartbeatAge < WORKER_LIVENESS_SECONDS));
  const lastContact = job?.flow?.lastEvidenceAt ?? heartbeatAt ?? job?.updatedAt ?? null;
  const visibleTrace = [...(job?.trace ?? [])].slice(-14).reverse();
  const flowStatus = done ? 'complete' : failed ? 'error' : cancelled ? 'cancelled' : 'active';

  const confirmCloud = async () => {
    if (!job || !onConfirmCloudSync) return;
    setConfirming(true);
    try {
      await onConfirmCloudSync(job.jobId);
    } finally {
      setConfirming(false);
    }
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(buildReport(job, status, trackName, now));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-3 sm:p-6" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Live-Datenfluss der externen Zerlegung"
        className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-cyan-400/25 bg-[#0d151f] text-neutral-100 shadow-2xl shadow-cyan-950/50"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 bg-gradient-to-r from-[#101f2b] to-[#10151f] px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[.2em] text-cyan-300">
              <Activity size={13} /> Live-Datenfluss · Google Drive → Colab
              <span
                className={`rounded-full px-2 py-0.5 text-[9px] tracking-[.12em] ${
                  flowStatus === 'complete'
                    ? 'bg-emerald-400/15 text-emerald-200'
                    : flowStatus === 'error'
                      ? 'bg-red-400/15 text-red-200'
                      : flowStatus === 'cancelled'
                        ? 'bg-amber-400/15 text-amber-200'
                        : 'bg-cyan-400/15 text-cyan-100'
                }`}
              >
                {done ? 'fertig' : failed ? 'prüfen' : cancelled ? 'abgebrochen' : 'wird verfolgt'}
              </span>
            </div>
            <h2 className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">Was passiert mit deinen Daten?</h2>
            <p className="mt-1 truncate text-xs text-neutral-400 sm:text-sm" title={trackName}>
              {trackName || 'Aktiver Track'}
              {job ? <span className="ml-2 font-mono text-[10px] text-neutral-600">{job.jobId}</span> : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={COLAB_NOTEBOOK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/20 hover:text-white"
              title="Colab-Notebook direkt in Google Colab öffnen"
            >
              <ExternalLink size={13} />
              <span className="hidden sm:inline">In Google Colab öffnen</span>
              <span className="sm:hidden">Colab</span>
            </a>
            <button
              type="button"
              onClick={onClose}
              aria-label="Datenfluss schließen"
              className="rounded-lg p-2 text-neutral-400 transition hover:bg-white/10 hover:text-white"
            >
              <X size={19} />
            </button>
          </div>
        </header>

        <div className="min-h-0 overflow-y-auto">
          <div className="space-y-5 p-4 sm:p-6">
            {/* ── Stand ───────────────────────────────────────────────────── */}
            <div
              className={`rounded-2xl border p-4 sm:p-5 ${
                failed
                  ? 'border-red-400/40 bg-red-400/[.08]'
                  : done
                    ? 'border-emerald-400/40 bg-emerald-400/[.08]'
                    : cancelled
                      ? 'border-amber-400/40 bg-amber-400/[.08]'
                      : 'border-cyan-400/35 bg-cyan-400/[.07]'
              }`}
              aria-live="polite"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <div
                    className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                      failed
                        ? 'bg-red-400/15 text-red-200'
                        : done
                          ? 'bg-emerald-400/15 text-emerald-200'
                          : cancelled
                            ? 'bg-amber-400/15 text-amber-200'
                            : 'bg-cyan-400/15 text-cyan-100'
                    }`}
                  >
                    {failed ? <AlertTriangle size={20} /> : done ? <CheckCircle2 size={20} /> : cancelled ? <XCircle size={20} /> : <LoaderCircle size={20} className="animate-spin" />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-base font-bold sm:text-lg">{cancelPending ? 'Abbruchfahne wird in die Jobablage geschrieben…' : explanation.title}</div>
                    <p className="mt-1 max-w-2xl text-xs leading-relaxed text-neutral-300 sm:text-sm">{explanation.description}</p>
                    {current ? (
                      <p className="mt-2 text-[11px] text-neutral-400">
                        Station „{current.title}“
                        {typeof current.at === 'number' ? ` · seit ${formatTime(current.at)}` : ''}
                        {typeof job?.flow?.lastEvidenceAt === 'number'
                          ? ` · letzter Beleg ${formatAge(Math.max(0, Math.floor((now - job.flow.lastEvidenceAt) / 1000)))}`
                          : ''}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-2 rounded-xl bg-black/15 px-3 py-2 text-right text-[10px] sm:min-w-[200px]">
                  <span className="text-left text-neutral-500">Datenweg</span>
                  <strong className="text-neutral-100">{stations.length ? `${doneCount}/${stations.length} belegt` : '—'}</strong>
                  <span className="text-left text-neutral-500">Fortschritt (gemeldet)</span>
                  <strong className={workerProgress === null ? 'text-neutral-400' : 'text-cyan-100'}>
                    {workerProgress === null ? 'noch nicht gestartet' : `${workerProgress} %`}
                  </strong>
                  <span className="text-left text-neutral-500">Letzter Kontakt</span>
                  <strong className="text-neutral-300">
                    {lastContact ? formatAge(Math.max(0, Math.floor((now - lastContact) / 1000))) : '—'}
                  </strong>
                  <span className="text-left text-neutral-500">Laufzeit</span>
                  <strong className="text-neutral-300">{job ? formatAge(Math.max(0, Math.floor((now - job.createdAt) / 1000))) : '—'}</strong>
                </div>
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[.14em] text-neutral-500">
                  <span>{statusLabel(job)}</span>
                  <span>{workerProgress === null ? 'Worker meldet noch keinen Wert' : `Worker ${workerProgress}%`}</span>
                </div>
                <div
                  className="mt-1.5 h-2 overflow-hidden rounded-full bg-black/35"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={workerProgress ?? undefined}
                  aria-valuetext={workerProgress === null ? 'Verarbeitung noch nicht gestartet' : `${workerProgress} Prozent`}
                >
                  {workerProgress !== null ? (
                    <div
                      className={`h-full rounded-full transition-[width] duration-500 ${
                        done ? 'bg-gradient-to-r from-emerald-500 to-emerald-300' : 'bg-gradient-to-r from-cyan-600 to-sky-300'
                      }`}
                      style={{ width: `${workerProgress}%` }}
                    />
                  ) : null}
                </div>
              </div>

              {explanation.waitingForWorker && !failed && !cancelled ? (
                <div className="mt-3 flex gap-2 rounded-xl border border-amber-300/25 bg-amber-300/[.08] p-3 text-xs leading-relaxed text-amber-100">
                  <Info size={16} className="mt-0.5 shrink-0" />
                  <div>
                    <strong>Warum steht hier nicht einfach mehr Prozent?</strong>
                    {job?.worker
                      ? ' Colab hat den Job bereits übernommen, aber die erste Inferenzmeldung fehlt noch.'
                      : ' Die Arbeitskopie wurde in die Jobablage geschrieben; der Cloud-Sync ist für den Editor nicht messbar.'}{' '}
                    <span className="font-semibold">0 % ist in dieser Phase korrekt</span> – es wäre unehrlich, den Download oder die
                    KI-Rechnung vorzutäuschen. Der Laufzettel unten zeigt stattdessen Station für Station, was bereits belegt ist.
                    <div className="mt-2.5">
                      <a
                        href={COLAB_NOTEBOOK_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/40 bg-amber-300/15 px-3 py-1.5 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/25"
                      >
                        <ExternalLink size={13} />
                        <span>Colab-Notebook öffnen</span>
                      </a>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {warning && !failed && !cancelled ? (
              <div role="alert" className="flex gap-2 rounded-xl border border-amber-400/40 bg-amber-400/[.08] p-3 text-xs leading-relaxed text-amber-100">
                <AlertTriangle size={17} className="mt-0.5 shrink-0" />
                <span>{warning}</span>
              </div>
            ) : null}

            {/* ── Laufzettel ──────────────────────────────────────────────── */}
            <div>
              <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold">Der Weg deiner Arbeitskopie – Station für Station</h3>
                  <p className="mt-0.5 text-[11px] text-neutral-500">
                    Ein Punkt wird nur grün, wenn es dafür einen Beleg gibt. Was der Editor nicht sehen kann, bleibt sichtbar offen.
                  </p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/[.03] px-2 py-1 text-[10px] font-mono text-neutral-400">
                  {job?.jobId ? `Job ${job.jobId.slice(0, 12)}…` : 'Job wird angelegt'}
                </span>
              </div>

              {stations.length === 0 ? (
                <div className="flex gap-2 rounded-xl border border-dashed border-white/10 p-3 text-xs text-neutral-500">
                  <Clock3 size={15} className="shrink-0" />
                  Noch keine Station belegt – der Laufzettel entsteht mit dem Start der Zerlegung.
                </div>
              ) : (
                <ol className="space-y-1.5" aria-label="Stationen des Datenflusses">
                  {stations.map((station, index) => {
                    const Icon = WHERE_ICON[station.where];
                    const duration = station.state === 'done' ? stepDuration(stations, index) : null;
                    return (
                      <li key={station.id} className="relative flex gap-3 pl-1">
                        {index < stations.length - 1 ? (
                          <span
                            aria-hidden
                            className={`absolute left-[15px] top-8 h-[calc(100%-1rem)] w-px ${
                              station.state === 'done' ? 'bg-emerald-400/40' : 'bg-white/10'
                            }`}
                          />
                        ) : null}
                        <span
                          className={`relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
                            station.state === 'done'
                              ? 'border-emerald-400/50 bg-emerald-400/15 text-emerald-300'
                              : station.state === 'active'
                                ? 'border-cyan-400/60 bg-cyan-400/15 text-cyan-100'
                                : station.state === 'unknown'
                                  ? 'border-amber-400/60 bg-amber-400/10 text-amber-200'
                                  : station.state === 'failed'
                                    ? 'border-red-400/60 bg-red-400/15 text-red-200'
                                    : station.state === 'cancelled'
                                      ? 'border-amber-400/60 bg-amber-400/15 text-amber-200'
                                      : 'border-white/10 bg-white/5 text-neutral-500'
                          }`}
                        >
                          {station.state === 'done' ? (
                            <CheckCircle2 size={15} />
                          ) : station.state === 'active' ? (
                            <LoaderCircle size={14} className="animate-spin" />
                          ) : station.state === 'cancelled' ? (
                            <XCircle size={14} />
                          ) : (
                            <Icon size={14} />
                          )}
                        </span>
                        <div
                          className={`min-w-0 flex-1 rounded-xl border p-3 ${
                            station.state === 'active'
                              ? 'border-cyan-400/40 bg-cyan-400/[.06]'
                              : station.state === 'failed'
                                ? 'border-red-400/40 bg-red-400/[.06]'
                                : station.state === 'cancelled'
                                  ? 'border-amber-400/40 bg-amber-400/[.06]'
                                  : station.state === 'unknown'
                                  ? 'border-amber-400/30 bg-amber-400/[.04]'
                                  : 'border-white/10 bg-white/[.025]'
                          }`}
                          aria-current={station.state === 'active' ? 'step' : undefined}
                        >
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-[13px] font-semibold text-neutral-100">{station.title}</span>
                            <span
                              className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[.12em] ${
                                STATE_CHIP[station.state]
                              }`}
                            >
                              {STATE_LABEL[station.state]}
                            </span>
                            <span
                              className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[.12em] ${
                                WHERE_STYLE[station.where]
                              }`}
                            >
                              {REMOTE_FLOW_WHERE_LABEL[station.where]}
                            </span>
                            {typeof station.percent === 'number' && station.state === 'active' ? (
                              <span className="font-mono text-[11px] text-cyan-100">{station.percent} %</span>
                            ) : null}
                          </div>

                          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-neutral-500">
                            <span className="inline-flex items-center gap-1">
                              <Clock size={11} />
                              {typeof station.at === 'number' ? formatTime(station.at) : '—'}
                              {typeof station.at === 'number' ? ` · ${formatAge(Math.max(0, Math.floor((now - station.at) / 1000)))}` : ''}
                            </span>
                            {duration !== null ? <span>Dauer {formatStepDuration(duration)}</span> : null}
                            {typeof station.updatedAt === 'number' && station.updatedAt !== station.at ? (
                              <span>letzte Meldung {formatAge(Math.max(0, Math.floor((now - station.updatedAt) / 1000)))}</span>
                            ) : null}
                          </div>

                          {station.detail ? <p className="mt-1.5 text-xs leading-relaxed text-neutral-300">{station.detail}</p> : null}

                          {station.facts?.length ? (
                            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                              {station.facts.map((fact) => (
                                <div key={fact.label} className="flex min-w-0 items-baseline justify-between gap-2 text-[10px]">
                                  <dt className="shrink-0 text-neutral-500">{fact.label}</dt>
                                  <dd className="min-w-0 truncate font-mono text-neutral-200" title={fact.value}>
                                    {fact.value}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}

                          {station.hint ? (
                            <p className="mt-2 flex gap-1.5 rounded-lg bg-black/20 p-2 text-[10px] leading-relaxed text-neutral-300">
                              <HelpCircle size={13} className="mt-0.5 shrink-0 text-cyan-300" />
                              {station.hint}
                            </p>
                          ) : null}

                          {/* Station 2: In der Jobablage abgelegt */}
                          {station.id === 'published' && (status?.root || job?.transportRoot) ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void openLocalJobFolder()}
                                disabled={openingFolder}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-1.5 text-[11px] font-semibold text-cyan-200 transition hover:bg-cyan-400/20 hover:text-white disabled:opacity-60"
                                title="Öffnet den lokalen Job-Ordner im Dateimanager"
                              >
                                <FolderOpen size={13} />
                                <span>Lokalen Ablage-Ordner öffnen</span>
                              </button>
                            </div>
                          ) : null}

                          {/* Station 3: In der Google-Cloud angekommen */}
                          {station.id === 'cloud_sync' && job ? (
                            <div className="mt-2.5 space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                {(status?.root || job.transportRoot) ? (
                                  <button
                                    type="button"
                                    onClick={() => void openLocalJobFolder()}
                                    disabled={openingFolder}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/15 px-3 py-1.5 text-[11px] font-semibold text-cyan-200 transition hover:bg-cyan-400/25 hover:text-white disabled:opacity-60"
                                    title="Öffnet den lokalen Job-Eingabeordner in Windows Explorer / Dateimanager"
                                  >
                                    <FolderOpen size={13} />
                                    <span>Lokalen Drive-Ordner öffnen</span>
                                  </button>
                                ) : null}

                                <a
                                  href={`https://drive.google.com/drive/u/0/search?q=${encodeURIComponent(job.jobId)}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-[11px] font-semibold text-neutral-200 transition hover:bg-white/20 hover:text-white"
                                  title="Öffnet Google Drive im Browser und sucht nach diesem Job-Ordner"
                                >
                                  <ExternalLink size={13} />
                                  <span>In Google Drive (Web) öffnen</span>
                                </a>

                                {station.state === 'unknown' && onConfirmCloudSync ? (
                                  <button
                                    type="button"
                                    onClick={() => void confirmCloud()}
                                    disabled={confirming}
                                    className="rounded-lg border border-amber-300/40 bg-amber-300/[.08] px-3 py-1.5 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/[.16] disabled:opacity-60"
                                  >
                                    {confirming ? 'Wird vermerkt…' : 'In Drive gesehen'}
                                  </button>
                                ) : null}
                              </div>

                              {openFolderFeedback ? (
                                <p className="text-[11px] font-medium text-cyan-300">{openFolderFeedback}</p>
                              ) : null}

                              {(status?.root || job.transportRoot) ? (
                                <div className="flex items-center justify-between gap-2 rounded-lg bg-black/30 px-2.5 py-1.5 font-mono text-[10px] text-neutral-300">
                                  <span
                                    className="truncate"
                                    title={`${(status?.root || job.transportRoot || '').replace(/[\\/]+$/, '')}/jobs/${job.jobId}/input/`}
                                  >
                                    Ablagepfad: {(status?.root || job.transportRoot || '').replace(/[\\/]+$/, '')}/jobs/{job.jobId}/input/
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const p = `${(status?.root || job.transportRoot || '').replace(/[\\/]+$/, '')}/jobs/${job.jobId}/input/`;
                                      navigator.clipboard?.writeText(p);
                                      setOpenFolderFeedback('Pfad in Zwischenablage kopiert');
                                      window.setTimeout(() => setOpenFolderFeedback(null), 3000);
                                    }}
                                    className="shrink-0 text-neutral-400 hover:text-cyan-200"
                                    title="Pfad in Zwischenablage kopieren"
                                  >
                                    <ClipboardCopy size={12} />
                                  </button>
                                </div>
                              ) : null}

                              {station.state === 'unknown' && onConfirmCloudSync ? (
                                <span className="block text-[10px] text-neutral-500">
                                  Nur ein Vermerk von Ihnen – der Editor kann die Cloud nicht prüfen.
                                </span>
                              ) : null}
                            </div>
                          ) : null}

                          {/* Station 4: Colab-Worker in der Ablage gesehen */}
                          {station.id === 'worker_seen' ? (
                            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                              <a
                                href={COLAB_NOTEBOOK_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/15 px-3 py-1.5 text-[11px] font-semibold text-cyan-200 transition hover:bg-cyan-400/25 hover:text-white"
                                title="Colab-Notebook direkt in Google Colab öffnen"
                              >
                                <ExternalLink size={13} />
                                <span>In Google Colab öffnen</span>
                              </a>
                              <span className="text-[10px] text-neutral-400">
                                {station.state === 'done'
                                  ? 'Worker-Lebenszeichen gesehen. Colab öffnen, falls der Worker neu gestartet werden muss.'
                                  : 'Öffnet das Notebook direkt in Google Colab zum Starten von Zelle #5.'}
                              </span>
                            </div>
                          ) : null}

                          {/* Station 5: Job vom Worker angenommen */}
                          {station.id === 'claimed' && station.state !== 'done' ? (
                            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                              <a
                                href={COLAB_NOTEBOOK_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/15 px-3 py-1.5 text-[11px] font-semibold text-cyan-200 transition hover:bg-cyan-400/25 hover:text-white"
                                title="Colab-Notebook direkt in Google Colab öffnen"
                              >
                                <ExternalLink size={13} />
                                <span>In Google Colab öffnen</span>
                              </a>
                              <span className="text-[10px] text-neutral-400">
                                Wartet auf Claim. Colab öffnen, um zu prüfen, ob Zelle #5 im Notebook aktiv läuft.
                              </span>
                            </div>
                          ) : null}

                          {/* Station 6: Trennung gerechnet */}
                          {station.id === 'compute' && station.state !== 'done' ? (
                            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                              <a
                                href={COLAB_NOTEBOOK_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/15 px-3 py-1.5 text-[11px] font-semibold text-cyan-200 transition hover:bg-cyan-400/25 hover:text-white"
                                title="Colab-Notebook direkt in Google Colab öffnen"
                              >
                                <ExternalLink size={13} />
                                <span>In Google Colab öffnen</span>
                              </a>
                              <span className="text-[10px] text-neutral-400">
                                {station.state === 'failed'
                                  ? 'Inferenz fehlgeschlagen. In Colab die Konsolenausgabe von Zelle #5 prüfen.'
                                  : 'Inferenz läuft. Fortschritt und Rechenausgabe in Google Colab verfolgen.'}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>

            <div className="grid gap-3 lg:grid-cols-[1.15fr_.85fr]">
              <section className="rounded-xl border border-white/10 bg-white/[.025] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold">Live-Ablaufprotokoll</h3>
                    <p className="mt-0.5 text-[11px] text-neutral-500">Editor und Colab schreiben in dieselbe korrelierbare Jobspur.</p>
                  </div>
                  <Database size={16} className="text-cyan-300/70" />
                </div>
                {visibleTrace.length ? (
                  <ol className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1" aria-label="Live-Ablaufprotokoll">
                    {visibleTrace.map((event) => (
                      <li key={event.id} className="flex gap-2.5 border-l border-white/15 pl-3 text-xs">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-neutral-500">
                            <time dateTime={new Date(event.at).toISOString()}>{formatTime(event.at)}</time>
                            <span
                              className={
                                event.level === 'error'
                                  ? 'text-red-300'
                                  : event.level === 'warning'
                                    ? 'text-amber-200'
                                    : event.source === 'worker'
                                      ? 'text-violet-200'
                                      : 'text-cyan-200'
                              }
                            >
                              {event.source === 'worker' ? 'COLAB' : 'EDITOR'}
                            </span>
                            <span className="font-mono">{event.step}</span>
                            {typeof event.percent === 'number' ? <span>{event.percent}%</span> : null}
                          </div>
                          <p className="mt-0.5 leading-relaxed text-neutral-200">{event.message}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="mt-3 flex gap-2 rounded-lg border border-dashed border-white/10 p-3 text-xs text-neutral-500">
                    <Clock3 size={15} className="shrink-0" />
                    Noch kein Job-Ereignis bestätigt. Während die Arbeitskopie vorbereitet wird, bleibt dieses Protokoll bewusst leer.
                  </div>
                )}
              </section>

              <div className="space-y-3">
                <section className="rounded-xl border border-white/10 bg-white/[.025] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-bold">Was genau wird übertragen?</h3>
                    <FileAudio size={16} className="text-cyan-300/70" />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="text-[10px] uppercase tracking-[.12em] text-neutral-500">Arbeitskopie</div>
                      <div className="mt-1 font-semibold text-neutral-200">{formatBytes(job?.workingCopyBytes)} WAV</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[.12em] text-neutral-500">Dauer</div>
                      <div className="mt-1 font-semibold text-neutral-200">{formatDuration(job?.durationSeconds)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[.12em] text-neutral-500">Ausgabe</div>
                      <div className="mt-1 font-semibold text-neutral-200">{job?.stems.length ?? 4} Stems</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[.12em] text-neutral-500">Original</div>
                      <div className="mt-1 font-semibold text-emerald-200">bleibt unverändert</div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-400/[.06] p-2.5 text-[10px] leading-relaxed text-emerald-100">
                    <ShieldCheck size={14} className="mt-0.5 shrink-0" />
                    Es wird eine Arbeitskopie verarbeitet – nicht die Originaldatei, nicht rekordbox.xml und nicht master.db.
                  </div>
                </section>

                <section className="rounded-xl border border-white/10 bg-white/[.025] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-bold">Verbindung &amp; Rechenort</h3>
                    <HeartPulse size={16} className={workerAlive ? 'text-emerald-300' : 'text-neutral-500'} />
                  </div>
                  <div className="mt-3 space-y-2 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2 text-neutral-400">
                        <Cloud size={14} /> Transport
                      </span>
                      <span className="text-right font-semibold text-neutral-200">{status?.label ?? job?.transport ?? 'Google Drive'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2 text-neutral-400">
                        <HardDrive size={14} /> Jobablage
                      </span>
                      <span className={status?.reachable === false ? 'text-amber-200' : 'text-emerald-200'}>
                        {status?.reachable === false ? 'nicht erreichbar' : job ? 'erreichbar / bestätigt' : 'wird geprüft'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2 text-neutral-400">
                        <Server size={14} /> Worker
                      </span>
                      <span className={workerAlive ? 'text-emerald-200' : 'text-neutral-400'}>
                        {job?.worker ? `${job.worker.id} · ${workerAlive ? 'online' : 'kein aktuelles Signal'}` : 'noch nicht verbunden'}
                      </span>
                    </div>
                    {workerStatus?.device ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2 text-neutral-400">
                          <Cpu size={14} /> Gerät
                        </span>
                        <span className="font-semibold uppercase text-neutral-200">
                          {workerStatus.device}
                          {workerStatus.gpu && workerStatus.gpu !== 'cpu' ? ` · ${workerStatus.gpu}` : ''}
                        </span>
                      </div>
                    ) : null}
                    {heartbeatAt ? (
                      <div className="flex items-center justify-between gap-3 text-[10px] text-neutral-500">
                        <span>Letzter Heartbeat</span>
                        <span>
                          {formatTime(heartbeatAt)} · {formatAge(heartbeatAge ?? 0)}
                        </span>
                      </div>
                    ) : null}
                    <p className="mt-3 border-t border-white/10 pt-2 text-[10px] leading-relaxed text-neutral-500">
                      Cloud-Sync separat nicht messbar: bestätigt ist nur der synchronisierte Drive-Ordner. Der eigentliche
                      Cloud-Abgleich wird nicht vom Editor vorgetäuscht – er ist im Laufzettel die einzige Station ohne Beleg.
                    </p>
                  </div>
                </section>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-neutral-500">
                <span>Job {job?.jobId ?? 'wird angelegt'}</span>
                <span>·</span>
                <span>Status {job?.status ?? 'PREPARING'}</span>
                {job?.updatedAt ? (
                  <>
                    <span>·</span>
                    <span>aktualisiert {formatTime(job.updatedAt)}</span>
                  </>
                ) : null}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void copyReport()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-neutral-300 transition hover:bg-white/10 hover:text-white"
                  title="Kopiert Stationen, Belege und Ablaufprotokoll als Text – für Support und Nachweis."
                >
                  <ClipboardCopy size={13} /> {copied ? 'Kopiert' : 'Protokoll kopieren'}
                </button>
                <button
                  type="button"
                  onClick={onRefresh}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-neutral-300 transition hover:bg-white/10 hover:text-white"
                >
                  <RefreshCw size={13} /> Jetzt prüfen
                </button>
                {running && !terminal(job?.status) ? (
                  <button
                    type="button"
                    onClick={onCancel}
                    disabled={cancelPending}
                    title="Der Ablauf wird abgebrochen. Ein Ergebnis wird nicht übernommen."
                    className="rounded-lg border border-red-400/40 bg-red-400/[.05] px-3 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-400/[.12] disabled:cursor-progress disabled:opacity-60"
                  >
                    {cancelPending ? 'Abbruch läuft…' : job ? 'Job abbrechen' : 'Vorbereitung abbrechen'}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg bg-cyan-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-cyan-500"
                >
                  {running ? 'Im Hintergrund weiter' : 'Schließen'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default RemoteFlowModal;
