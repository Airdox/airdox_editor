/**
 * Ablage-Layout der Fern-Jobs auf Google Drive (§16, §17).
 *
 * Bewusst ein flaches, selbsterklärendes Dateilayout: der Colab-Worker liest
 * es mit Standardmitteln (Drive-Mount + `os.listdir`), ohne dass irgendwo ein
 * Schema versteckt ist. Alle Pfade in dieser Datei sind **relativ zur
 * Job-Wurzel** und in POSIX-Schreibweise – so funktionieren sie auf Windows,
 * Linux und auf dem gemounteten Drive-Laufwerk gleichermaßen.
 *
 *   <root>/
 *     jobs/<jobId>/manifest.json        ← Quelle der Wahrheit für den Status
 *     jobs/<jobId>/input/<datei.wav>    ← Arbeitskopie (nie das Original)
 *     jobs/<jobId>/claim.json           ← Worker-Lease (wer rechnet gerade)
 *     jobs/<jobId>/cancel.flag          ← Editor: „brich ab“
 *     jobs/<jobId>/logs/worker.log      ← Worker-Log (Text, kein Token)
 *     jobs/<jobId>/output/<stem>.wav    ← Ergebnisse
 *     jobs/<jobId>/output/result.json   ← Ergebnisliste mit Hashes
 *     jobs/<jobId>/error.json           ← letzter Fehler (maschinenlesbar)
 */
import path from 'node:path';

export const REMOTE_JOBS_DIR = 'jobs';
export const REMOTE_MANIFEST_FILE = 'manifest.json';
export const REMOTE_CLAIM_FILE = 'claim.json';
export const REMOTE_CANCEL_FILE = 'cancel.flag';
export const REMOTE_ERROR_FILE = 'error.json';
export const REMOTE_INPUT_DIR = 'input';
export const REMOTE_OUTPUT_DIR = 'output';
export const REMOTE_LOGS_DIR = 'logs';
export const REMOTE_RESULT_FILE = 'result.json';
export const REMOTE_WORKER_LOG_FILE = 'worker.log';

/** Erlaubte Job-Id-Form. Verhindert Pfad-Ausbrüche aus einem manipulierten Manifest. */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;

export function isSafeJobId(jobId: unknown): jobId is string {
  return typeof jobId === 'string' && JOB_ID_PATTERN.test(jobId) && !jobId.includes('..');
}

/**
 * Prüft einen relativen Pfad aus einem Manifest, bevor er benutzt wird.
 * Ein fremdes Manifest darf den Editor niemals aus der Job-Wurzel führen.
 */
export function assertSafeRelative(relative: unknown): string {
  const value = typeof relative === 'string' ? relative : '';
  if (!value || value.startsWith('/') || value.includes('\\') || value.split('/').includes('..')) {
    throw new Error(`Unsicherer relativer Pfad im Manifest: ${JSON.stringify(relative)}`);
  }
  return value;
}

export function jobDir(jobId: string): string {
  if (!isSafeJobId(jobId)) throw new Error(`Ungültige Job-Id: ${JSON.stringify(jobId)}`);
  return `${REMOTE_JOBS_DIR}/${jobId}`;
}

export function jobManifestPath(jobId: string): string {
  return `${jobDir(jobId)}/${REMOTE_MANIFEST_FILE}`;
}

export function jobClaimPath(jobId: string): string {
  return `${jobDir(jobId)}/${REMOTE_CLAIM_FILE}`;
}

export function jobCancelPath(jobId: string): string {
  return `${jobDir(jobId)}/${REMOTE_CANCEL_FILE}`;
}

export function jobErrorPath(jobId: string): string {
  return `${jobDir(jobId)}/${REMOTE_ERROR_FILE}`;
}

export function jobInputPath(jobId: string, fileName: string): string {
  const safe = path.posix.basename(fileName).replace(/[^A-Za-z0-9._-]+/g, '_') || 'input.wav';
  return `${jobDir(jobId)}/${REMOTE_INPUT_DIR}/${safe}`;
}

export function jobOutputPath(jobId: string, stemFileName: string): string {
  const safe = path.posix.basename(stemFileName).replace(/[^A-Za-z0-9._-]+/g, '_') || 'stem.wav';
  return `${jobDir(jobId)}/${REMOTE_OUTPUT_DIR}/${safe}`;
}

export function jobResultPath(jobId: string): string {
  return `${jobDir(jobId)}/${REMOTE_OUTPUT_DIR}/${REMOTE_RESULT_FILE}`;
}

export function jobWorkerLogPath(jobId: string): string {
  return `${jobDir(jobId)}/${REMOTE_LOGS_DIR}/${REMOTE_WORKER_LOG_FILE}`;
}

/** Ein WAV-Name für einen Stem – dieselbe Konvention wie im lokalen Pfad. */
export function stemFileName(stemId: string): string {
  return `${stemId.replace(/[^A-Za-z0-9._-]+/g, '_')}.wav`;
}
