import type { RemoteStemJobView } from '../transportTypes';

export const REMOTE_NO_WORKER_WARNING_MS = 120_000;
export const REMOTE_WORKER_HEARTBEAT_WARNING_MS = 90_000;

/**
 * Liefert nur einen Diagnosehinweis, nie einen künstlichen Job-Fehler.
 * `updatedAt` ist absichtlich ausgeschlossen: die Ablage wird bei jedem Poll
 * gespeichert, auch wenn sich am externen Job nichts geändert hat.
 */
export function remoteJobStallWarning(job: RemoteStemJobView, now = Date.now()): string | null {
  if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') return null;

  const lastActivityAt = job.worker?.heartbeatAt ?? job.worker?.claimedAt ?? job.phaseUpdatedAt ?? job.createdAt;
  const ageMs = Math.max(0, now - lastActivityAt);
  const hasWorker = Boolean(job.worker?.id);
  const limit = hasWorker ? REMOTE_WORKER_HEARTBEAT_WARNING_MS : REMOTE_NO_WORKER_WARNING_MS;
  if (ageMs < limit) return null;

  const minutes = Math.max(1, Math.floor(ageMs / 60_000));
  if (hasWorker) {
    return `Seit ${minutes} Minuten kein Worker-Lebenszeichen. Prüfen Sie, ob die Colab-Laufzeit und die Worker-Zelle noch laufen; im Jobordner zeigen claim.json und logs/worker.jsonl den letzten Worker-Schritt. Der Job bleibt aktiv.`;
  }

  if (job.status === 'RUNNING') {
    return `Seit ${minutes} Minuten kein Worker-Claim. Prüfen Sie, ob Colab noch Abhängigkeiten/Modell lädt oder die Worker-Zelle #5 läuft, ob JOB_ORDNER und Drive-Mount stimmen und ob manifest.json sowie input/ im selben Jobordner sichtbar sind. Drive-Sync startet Colab nicht. Der Job bleibt aktiv.`;
  }

  return `Seit ${minutes} Minuten keine Phasenänderung beim Upload. Prüfen Sie Drive für Desktop, die Synchronisierung und den gewählten Jobordner. Der Job bleibt aktiv.`;
}
