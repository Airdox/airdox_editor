import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudUpload, Cpu, Download, FolderCheck, HeartPulse, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { RemoteServiceStatus, RemoteStemJobView } from '../../stems/transportTypes';

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
const stages = [
  { title: 'Arbeitskopie vorbereiten', icon: ShieldCheck, detail: 'Das Original bleibt auf Ihrem Rechner unverändert.' },
  { title: 'An Drive-Ordner übergeben', icon: CloudUpload, detail: 'Der Editor schreibt die Arbeitskopie und das Job-Manifest in den synchronisierten Ordner.' },
  { title: 'Auf Worker warten', icon: FolderCheck, detail: 'Drive für Desktop synchronisiert eigenständig; der Editor kann den Cloud-Upload nicht direkt bestätigen.' },
  { title: 'Extern verarbeiten', icon: Cpu, detail: 'Der Colab-Worker beansprucht den Job und berechnet die Stems.' },
  { title: 'Zurückholen und prüfen', icon: Download, detail: 'Die Ergebnisse werden anhand ihrer Hashes geprüft und im Editor importiert.' },
];

function stageFor(job: RemoteStemJobView | null, running: boolean): number {
  if (!job) return running ? 0 : 0;
  if (job.status === 'COMPLETED' || job.status === 'VALIDATING' || job.status === 'RECONSTRUCTING') return 4;
  if (job.status === 'RUNNING' || job.worker) return 3;
  return 2;
}

export const RemoteFlowModal: React.FC<Props> = ({ open, onClose, onCancel, onRefresh, status, job, trackName, running, error, phaseText, cancelPending = false }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);
  if (!open) return null;
  const stage = stageFor(job, running);
  const done = job?.status === 'COMPLETED' && !running && !error;
  const failed = Boolean(error || job?.status === 'FAILED' || job?.status === 'CANCELLED');
  const age = job ? Math.max(0, Math.floor((now - (job.worker?.heartbeatAt ?? job.updatedAt)) / 1000)) : 0;
  const waiting = Boolean(job && !terminal(job.status) && age > (job.worker ? 90 : 120));
  const warning = status?.reachable === false || job?.transportDegraded
    ? `Die Jobablage ist derzeit nicht erreichbar. ${status?.reason ?? 'Bitte Drive für Desktop, Anmeldung, Internetverbindung und den gewählten Ordner prüfen.'} Der Job wird nicht automatisch als fehlgeschlagen gewertet.`
    : waiting
      ? job?.worker
        ? `Seit ${Math.floor(age / 60)} Minuten kein neues Worker-Lebenszeichen. Bitte die Colab-Laufzeit und den Drive-Mount prüfen; der Job bleibt aktiv. Ein Neustart von Zelle 5 genügt – der Job wird weiterverfolgt.`
        : `Seit ${Math.floor(age / 60)} Minuten keine Statusänderung – der Job ist noch von keinem Rechner beansprucht. Bitte drei Dinge prüfen: (1) Läuft im Colab-Notebook Zelle 5, und ist dort derselbe JOB_ORDNER wie hier eingestellt? (2) Ist Drive für Desktop angemeldet und synchronisiert? (3) MODELL_ID im Notebook leer lassen – ein anderes Modell als im Steckbrief lässt den Worker den Job überspringen. Auf dem Rechner der Jobablage zeigt \`--check-store\` den Grund im Klartext.`
      : null;
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/75 p-4" role="presentation">
      <section role="dialog" aria-modal="true" aria-label="Datenfluss der externen Zerlegung" className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-cyan-500/30 bg-[#111923] text-neutral-100 shadow-2xl shadow-cyan-950/50">
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div><div className="text-xs font-semibold uppercase tracking-[.2em] text-cyan-400">Google Drive · Colab</div><h2 className="mt-1 text-xl font-bold">Datenfluss der Zerlegung</h2><p className="mt-1 truncate text-sm text-neutral-400" title={trackName}>{trackName}</p></div>
          <button type="button" onClick={onClose} aria-label="Statusfenster schließen" className="rounded-lg p-2 hover:bg-white/10"><X size={18} /></button>
        </header>
        <div className="space-y-5 p-6">
          <div aria-live="polite" className={`rounded-xl border p-4 ${failed ? 'border-red-500/40 bg-red-500/10' : done ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-cyan-500/30 bg-cyan-500/10'}`}>
            <div className="flex items-center gap-2 font-semibold">{failed ? <AlertTriangle size={18} /> : done ? <CheckCircle2 size={18} /> : <RefreshCw size={18} className="animate-spin" />}{cancelPending ? 'Abbruch wird an den externen Rechner gemeldet…' : failed ? job?.status === 'CANCELLED' ? 'Abgebrochen – keine Stems übernommen' : 'Vorgang unterbrochen' : done ? 'Ergebnisse geprüft und importiert' : phaseText || job?.phase || 'Arbeitskopie wird vorbereitet…'}</div>
            {job?.status === 'CANCELLED' && !error ? <p className="mt-1 text-xs text-neutral-400">Der Abbruch ist in der Jobablage hinterlegt. Ein bereits gerechnetes Ergebnis wird nicht übernommen – Original, <span className="font-mono">rekordbox.xml</span> und <span className="font-mono">master.db</span> bleiben unverändert.</p> : null}
            {error || job?.error?.message ? <p className="mt-2 text-sm">{error || job?.error?.message}</p> : null}
            {job && <div className="mt-3 text-xs text-neutral-300">Job {job.jobId} · Status {job.status} · gemeldeter Fortschritt {Math.round(job.percent ?? 0)} %</div>}
          </div>
          {warning && !failed && <div role="alert" className="flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100"><AlertTriangle size={18} className="shrink-0" />{warning}</div>}
          {status?.worker ? (() => {
            const ageMs = now - (status.worker.heartbeatAt ?? now);
            const ageSec = Math.max(0, Math.floor(ageMs / 1000));
            const alive = ageSec < WORKER_LIVENESS_SECONDS;
            return (
              <div className={`flex gap-2 rounded-xl border p-3 text-xs ${alive ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100' : 'border-amber-500/40 bg-amber-500/10 text-amber-100'}`}>
                <HeartPulse size={16} className="shrink-0 mt-0.5" />
                <div className="flex-1 leading-relaxed">
                  <div className="font-semibold">
                    {alive ? 'Colab-Worker online' : 'Colab-Worker gesehen, aber kein aktuelles Lebenszeichen'}
                  </div>
                  <div className="mt-0.5 opacity-90">
                    {status.worker.id} · Host {status.worker.host ?? '?'} · Gerät {status.worker.device ?? '?'}
                    {status.worker.gpu && status.worker.gpu !== 'cpu' ? ` (${status.worker.gpu})` : ''}
                    {status.worker.phase ? ` · ${status.worker.phase}` : ''}
                    {' · zuletzt gesehen vor '}{Math.floor(ageSec / 60)}:{String(ageSec % 60).padStart(2, '0')}
                  </div>
                </div>
              </div>
            );
          })() : !failed && !done ? (
            <div className="flex gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-3 text-xs text-cyan-100">
              <HeartPulse size={16} className="shrink-0 mt-0.5 opacity-70" />
              <div className="leading-relaxed">
                <div className="font-semibold">Warte auf Lebenszeichen des Workers …</div>
                <div className="mt-0.5 opacity-80">Bis ein gestartetes Colab-Notebook den Drive-Ordner erreicht, steht hier noch nichts. Prüfe: (1) Drive ist gemountet, (2) derselbe Jobordner ist gewählt, (3) die Worker-Zelle läuft. In der Ablage erscheint nach dem Start die Datei <code className="font-mono">worker.status.json</code>.</div>
              </div>
            </div>
          ) : null}
          <ol className="space-y-1" aria-label="Stationen des Datenflusses">{stages.map((item, index) => {
            const Icon = item.icon;
            const complete = index < stage || (done && index === 4);
            return <li key={item.title} className={`flex gap-3 rounded-xl p-3 ${index === stage && !done ? 'bg-white/10' : ''}`}><div className={`mt-0.5 ${complete ? 'text-emerald-400' : index === stage ? 'text-cyan-400' : 'text-neutral-600'}`}>{complete ? <CheckCircle2 size={20} /> : <Icon size={20} />}</div><div><div className="text-sm font-semibold">{item.title} <span className="font-normal text-neutral-400">{complete ? '· abgeschlossen' : index === stage && !failed ? '· aktuell' : ''}</span></div><p className="mt-1 text-xs leading-relaxed text-neutral-400">{item.detail}</p></div></li>;
          })}</ol>
          <div className="rounded-xl bg-white/5 p-3 text-xs leading-relaxed text-neutral-400">Transport: {status?.label ?? job?.transport ?? 'Google Drive (Ordner)'} · Rechenort: {job?.device ?? 'noch nicht gemeldet'}{job?.cpuFallback ? ' (CPU-Fallback)' : ''}{job?.worker ? ` · Worker ${job.worker.id}` : ''}<br />Die Anzeige meldet nur vom Editor bestätigte Schritte. Synchronisierung in die Google-Cloud ist nicht separat messbar.</div>
          <div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={onRefresh} className="rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10">Jetzt prüfen</button>{running && job && !terminal(job.status) && <button type="button" onClick={onCancel} disabled={cancelPending} title="Der Worker beendet die laufende Rechnung beim nächsten Arbeitsschritt; ein Ergebnis wird nicht übernommen." className="rounded-lg border border-red-500/40 px-3 py-2 text-sm text-red-200 hover:bg-red-500/10 disabled:cursor-progress disabled:opacity-60">{cancelPending ? 'Abbruch läuft…' : 'Job abbrechen'}</button>}<button type="button" onClick={onClose} className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold hover:bg-cyan-500">{running ? 'Im Hintergrund weiter' : 'Schließen'}</button></div>
        </div>
      </section>
    </div>
  );
};
