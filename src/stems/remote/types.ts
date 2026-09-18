/**
 * Verträge des High-Quality-Fernpfads (§15–§22).
 *
 * Warum diese Datei existiert
 * ---------------------------
 * Der HQ-Pfad (BS-RoFormer) läuft lokal auf einem Laptop in 60–90 Minuten pro
 * Track und ist damit für den Alltag unbrauchbar. Er bleibt der Qualitätspfad,
 * darf aber auf einem fremden Rechner (Google Colab) rechnen. Transportmittel
 * ist Google Drive – nicht als Datenbank, sondern als *Jobablage* (§16):
 *
 *   Editor ──Arbeitskopie+Manifest──▶ Drive ──▶ Colab-Worker
 *   Editor ◀──Stems+Status─────────── Drive ◀── Colab-Worker
 *
 * Der Editor bedient dabei niemals Colab von Hand. Alles, was beide Seiten
 * über diese Grenze austauschen, steht hier: Manifest, Status, Outputs,
 * Worker-Lease. Es ist bewusst ein **Dateiformat** (JSON + WAV), damit der
 * Worker auf der anderen Seite ein beliebiges Werkzeug sein kann – Python in
 * Colab, ein Node-Skript auf einem Studio-Rechner oder ein Testharness.
 *
 * Statuswerte sind die **vorhandenen** `JobStatus`-Werte aus `../types`
 * (PENDING/PREPARING/RUNNING/…/COMPLETED/FAILED/CANCELLED). Ein zweites,
 * konkurrierendes Statussystem gibt es ausdrücklich nicht (§14): was ein
 * Remote-Job zusätzlich weiß – Gerät, CPU-Rückfall, Worker – steht in eigenen
 * Feldern, nicht in neuen Statusnamen.
 */
import type { BackendKind, ComputeDevice, JobStatus, ModelFamily, QualityProfile, StemId } from '../types';

/** Version des Manifest-Schemas. Erhöhen, wenn Felder brechen (nicht additiv). */
export const REMOTE_JOB_SCHEMA_VERSION = 1;

/** Status eines Fern-Jobs – identisch zu {@link JobStatus} (§14). */
export type RemoteJobStatus = JobStatus;

/** Phasen, die nur im Fernpfad vorkommen (stehen in `phase`, nie im Status). */
export const REMOTE_PHASES = {
  created: 'Job erstellt – Arbeitskopie wird vorbereitet',
  uploading: 'Arbeitskopie wird zu Google Drive hochgeladen',
  waitingWorker: 'Wartet auf den externen Rechner (Google Drive)',
  fallbackCpu: 'Verarbeitung läuft – CPU-Fallback',
  runningGpu: 'Verarbeitung läuft – GPU',
  runningCpu: 'Verarbeitung läuft – CPU',
  downloading: 'Ergebnisse werden geladen',
  importing: 'Ergebnisse werden geprüft und importiert',
  completed: 'Stem-Separation abgeschlossen',
  cancelled: 'Abgebrochen',
} as const;

export interface RemoteJobInput {
  /** Dateiname der Arbeitskopie (nie der Originalpfad des Nutzers). */
  fileName: string;
  /** Pfad **relativ** zur Job-Wurzel, posix-Schreibweise (Drive-tauglich). */
  relativePath: string;
  /** SHA-256 der Arbeitskopie; der Worker prüft ihn vor der Separation (§22). */
  sha256: string;
  bytes: number;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
}

export interface RemoteJobEngineRef {
  /** Backend des Workers: `bs_roformer`, `python-torch`, … */
  backend: BackendKind | string;
  family: ModelFamily;
  /** Model-ID aus dem Katalog – der Worker lädt genau dieses Modell (§25). */
  modelId: string;
  profile: QualityProfile;
  /** Stems, die der Worker liefern muss (Reihenfolge = `stemOrder`). */
  stems: StemId[];
  /** Rechenort-Wunsch: `auto` = GPU wenn möglich, sonst CPU (§7). */
  device?: ComputeDevice;
  /** Checkpoint-Identität, damit der Worker keine „irgendein Modell“-Wahl trifft. */
  checkpoint?: { file: string; sha256?: string; url?: string };
  config?: { file: string; url?: string };
  numOverlap?: number;
  chunkSizeSamples?: number;
}

export interface RemoteStemOutput {
  id: StemId;
  fileName: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  frames: number;
  sampleRate: number;
  channels: number;
  peak?: number;
}

export interface RemoteWorkerLease {
  /** Stabile Worker-Kennung (`colab-<hostname>-<pid>` o. ä.). */
  id: string;
  claimedAt: number;
  /** Lebenszeichen des Workers; ohne frisches Herz gilt der Job als verwaist. */
  heartbeatAt?: number;
  host?: string;
  /** Tatsächlich benutztes Gerät (`cuda`, `cpu`, `dml`, …). */
  device?: string;
  cpuFallback?: boolean;
  fallbackReason?: string;
  version?: string;
  gpu?: string;
  torch?: string;
}

export interface RemoteJobManifest {
  schemaVersion: number;
  /** UUID – niemals nur der Dateiname (§18). */
  jobId: string;
  createdAt: number;
  updatedAt: number;
  /** Zusätzlich ISO-8601 für den Colab-Nutzer (Menschen lesen mit). */
  createdAtIso: string;
  updatedAtIso: string;
  status: RemoteJobStatus;
  phase?: string;
  percent?: number;
  /**
   * Idempotenzschlüssel (§19): identische Arbeit (gleicher Input-Hash, gleiches
   * Modell, gleiches Profil) darf nicht zweimal gerechnet werden.
   */
  idempotencyKey: string;
  origin: { app: string; version: string; host?: string };
  input: RemoteJobInput;
  engine: RemoteJobEngineRef;
  output: {
    stems: RemoteStemOutput[];
    resultFile?: string;
  };
  worker?: RemoteWorkerLease;
  /** Vom Editor gesetzt; der Worker muss laufende Arbeit dann fallen lassen (§37). */
  cancelRequested?: boolean;
  /** Wie oft ein Worker diesen Job begonnen hat (Diagnose, §21 E). */
  attempts?: number;
  error?: { code: string; message: string; at?: number };
  /** Freitext für Support; keine Tokens, keine Zugangsdaten (§23). */
  notes?: string[];
}

/**
 * Lokaler, dauerhafter Zustand eines Fern-Jobs (`<root>/RemoteJobs/<jobId>.json`).
 *
 * Er überlebt den Editor-Neustart – genau dafür existiert er (§21 A, §32):
 * beim Start werden alle Einträge geladen und weiterverfolgt, statt einen
 * zweiten Job für dieselbe Datei zu erzeugen.
 */
export interface RemoteJobRecord {
  schemaVersion: number;
  jobId: string;
  createdAt: number;
  updatedAt: number;
  status: RemoteJobStatus;
  phase: string;
  percent: number;
  trackName: string;
  profile: QualityProfile;
  modelId: string;
  family: ModelFamily;
  backend: string;
  stems: StemId[];
  idempotencyKey: string;
  /** Arbeitskopie im Engine-Datenordner (nie das Original). */
  workingCopyPath: string;
  workingCopySha256: string;
  workingCopyBytes: number;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  /** Original (falls der Job aus einer Datei kam) + Integritätsnachweis. */
  originalPath?: string;
  originalSha256?: string;
  originalBytes?: number;
  originalMtimeMs?: number;
  originalUnchanged?: boolean;
  /** Lokaler Job (StemJobService), über den der Editor die Stems liest. */
  localJobId?: string;
  importedStems?: { id: StemId; filePath: string; bytes: number; sha256: string }[];
  worker?: RemoteWorkerLease;
  uploadedAt?: number;
  lastPollAt?: number;
  /**
   * Zuletzt veröffentlichter Job-Steckbrief. Er erlaubt es, einen
   * unterbrochenen Upload zu wiederholen, ohne die Job-Id oder den
   * Idempotenzschlüssel neu zu erfinden (§21 B). Es ist dieselbe Information
   * wie in `jobs/<jobId>/manifest.json` – nur lokal, damit der Editor sie
   * nach einem Neustart noch hat.
   */
  manifest?: RemoteJobManifest;
  /** Transportfehler in Folge – temporäre Netzprobleme sind kein Job-Fehler (§21 C). */
  transportErrors: number;
  transportDegraded?: boolean;
  cancelRequestedAt?: number;
  attempts?: number;
  device?: ComputeDevice;
  cpuFallback?: boolean;
  fallbackReason?: string;
  workerPercent?: number;
  finishedAt?: number;
  error?: { code: string; message: string };
}

export interface RemoteTransportConfig {
  kind: 'folder' | 'rclone';
  /**
   * `folder`: Pfad zum Google-Drive-Sync-Ordner (oder rclone-Mount).
   * `rclone`: Remote-Ziel, z. B. `gdrive:airdox-stem-jobs`.
   * Es wird nur die Jobablage benutzt – keine Drive-Datenbank (§16).
   */
  root: string;
  /** Nur für `kind: 'rclone'`: abweichende rclone-Konfigurationsdatei. */
  configPath?: string;
  /** Nur für `kind: 'rclone'`: rclone-Binary (Default: PATH). */
  binary?: string;
}
