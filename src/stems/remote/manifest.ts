/**
 * Job-Manifest: bauen, serialisieren, prüfen (§17, §22, §34).
 *
 * Das Manifest ist die einzige Quelle der Wahrheit über einen Fern-Job. Beide
 * Seiten (Editor und Worker) schreiben es – deshalb wird beim **Lesen** streng
 * validiert: eine unbekannte Schema-Version, eine fehlende Id oder ein Pfad,
 * der aus der Job-Wurzel führt, sind harte Fehler und keine Warnung. Ein Job,
 * der nicht sauber gelesen werden kann, gilt als fehlgeschlagen, nicht als
 * „irgendwie fertig“.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  ModelFamily,
  QualityProfile,
  StemId,
} from '../types';
import type {
  RemoteJobEngineRef,
  RemoteJobInput,
  RemoteJobManifest,
  RemoteJobStatus,
  RemoteStemOutput,
} from './types';
import { REMOTE_JOB_SCHEMA_VERSION } from './types';
import { assertSafeRelative, isSafeJobId } from './layout';

/** Maschinenlesbare Fehler des Fern-Protokolls. */
export class RemoteProtocolError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RemoteProtocolError';
    this.code = code;
    this.details = details;
  }
}

export const REMOTE_STATUSES: RemoteJobStatus[] = [
  'PENDING',
  'PREPARING',
  'RUNNING',
  'RECONSTRUCTING',
  'VALIDATING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
];

export const TERMINAL_STATUSES: RemoteJobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export function isTerminalStatus(status: RemoteJobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Neue Job-Id: UUID, nicht Dateiname (§18). */
export function createRemoteJobId(): string {
  return randomUUID();
}

/**
 * Idempotenzschlüssel (§19): gleicher Input-Hash + gleiches Modell + gleiches
 * Profil = dieselbe Arbeit. Der Editor legt dafür keinen zweiten Job an,
 * unabhängig davon, wie oft neu gepollt, neu gestartet oder neu geklickt wird.
 */
export function idempotencyKeyFor(input: {
  sha256: string;
  modelId: string;
  profile: QualityProfile;
  family?: ModelFamily;
  stems?: StemId[];
}): string {
  const material = [input.sha256, input.modelId, input.profile, input.family ?? '', (input.stems ?? []).join(',')].join('|');
  return createHash('sha256').update(material).digest('hex');
}

export function buildManifest(input: {
  jobId: string;
  trackName: string;
  appVersion: string;
  host?: string;
  input: RemoteJobInput;
  engine: RemoteJobEngineRef;
  idempotencyKey: string;
  status?: RemoteJobStatus;
  phase?: string;
}): RemoteJobManifest {
  const now = Date.now();
  return {
    schemaVersion: REMOTE_JOB_SCHEMA_VERSION,
    jobId: input.jobId,
    createdAt: now,
    updatedAt: now,
    createdAtIso: new Date(now).toISOString(),
    updatedAtIso: new Date(now).toISOString(),
    status: input.status ?? 'PENDING',
    phase: input.phase,
    percent: 0,
    idempotencyKey: input.idempotencyKey,
    origin: { app: 'airdox_SMART_Editor', version: input.appVersion, host: input.host },
    input: input.input,
    engine: input.engine,
    output: { stems: [] },
    attempts: 0,
    notes: [`track=${input.trackName}`],
  };
}

/** Aktualisiert Status/Phase/Worker und stempelt `updatedAt` neu. */
export function withStatus(
  manifest: RemoteJobManifest,
  patch: {
    status?: RemoteJobStatus;
    phase?: string;
    percent?: number;
    worker?: RemoteJobManifest['worker'];
    output?: RemoteJobManifest['output'];
    error?: RemoteJobManifest['error'];
    cancelRequested?: boolean;
    attempts?: number;
    notes?: string[];
  }
): RemoteJobManifest {
  const now = Date.now();
  return {
    ...manifest,
    ...patch,
    status: patch.status ?? manifest.status,
    output: patch.output ?? manifest.output,
    updatedAt: now,
    updatedAtIso: new Date(now).toISOString(),
  };
}

export function serializeManifest(manifest: RemoteJobManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function requireString(value: unknown, field: string, jobId: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RemoteProtocolError('REMOTE_MANIFEST_INVALID', `Manifest ${jobId}: Feld "${field}" fehlt oder ist leer`);
  }
  return value;
}

/**
 * Liest ein Manifest und prüft es gegen das Schema.
 *
 * `expectedJobId` kommt aus dem Verzeichnisnamen: weicht die Id *im* Manifest
 * davon ab, ist die Ablage inkonsistent (zwei Jobs in einem Ordner) und der
 * Job wird abgelehnt, statt Ergebnisse der falschen Datei zuzuordnen.
 */
export function parseManifest(raw: string | Uint8Array, expectedJobId?: string): RemoteJobManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  } catch (error) {
    throw new RemoteProtocolError('REMOTE_MANIFEST_INVALID', `Manifest ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new RemoteProtocolError('REMOTE_MANIFEST_INVALID', 'Manifest ist kein Objekt');
  }
  const manifest = parsed as RemoteJobManifest;
  if (manifest.schemaVersion !== REMOTE_JOB_SCHEMA_VERSION) {
    throw new RemoteProtocolError(
      'REMOTE_SCHEMA_UNSUPPORTED',
      `Manifest-Schema ${manifest.schemaVersion} wird nicht unterstützt (erwartet ${REMOTE_JOB_SCHEMA_VERSION})`
    );
  }
  if (!isSafeJobId(manifest.jobId)) {
    throw new RemoteProtocolError('REMOTE_MANIFEST_INVALID', `Ungültige jobId im Manifest: ${JSON.stringify(manifest.jobId)}`);
  }
  if (expectedJobId && manifest.jobId !== expectedJobId) {
    throw new RemoteProtocolError(
      'REMOTE_MANIFEST_INVALID',
      `Manifest-Id ${manifest.jobId} passt nicht zum Verzeichnis ${expectedJobId}`
    );
  }
  if (!REMOTE_STATUSES.includes(manifest.status)) {
    throw new RemoteProtocolError('REMOTE_MANIFEST_INVALID', `Unbekannter Status ${JSON.stringify(manifest.status)}`);
  }
  if (!manifest.input || typeof manifest.input !== 'object') {
    throw new RemoteProtocolError('REMOTE_MANIFEST_INVALID', 'Manifest ohne input-Block');
  }
  requireString(manifest.input.sha256, 'input.sha256', manifest.jobId);
  requireString(manifest.input.fileName, 'input.fileName', manifest.jobId);
  assertSafeRelative(manifest.input.relativePath);
  if (!manifest.engine || typeof manifest.engine !== 'object') {
    throw new RemoteProtocolError('REMOTE_MANIFEST_INVALID', 'Manifest ohne engine-Block');
  }
  requireString(manifest.engine.modelId, 'engine.modelId', manifest.jobId);
  requireString(manifest.engine.profile, 'engine.profile', manifest.jobId);
  if (!Array.isArray(manifest.engine.stems) || manifest.engine.stems.length === 0) {
    throw new RemoteProtocolError('REMOTE_MANIFEST_INVALID', 'Manifest ohne engine.stems');
  }
  const output = manifest.output ?? { stems: [] };
  if (!Array.isArray(output.stems)) {
    throw new RemoteProtocolError('REMOTE_MANIFEST_INVALID', 'Manifest output.stems ist keine Liste');
  }
  for (const stem of output.stems) {
    if (!stem || typeof stem !== 'object') {
      throw new RemoteProtocolError('REMOTE_MANIFEST_INVALID', 'Manifest enthält einen ungültigen Stem-Eintrag');
    }
    requireString(stem.id, 'output.stems[].id', manifest.jobId);
    requireString(stem.fileName, 'output.stems[].fileName', manifest.jobId);
    assertSafeRelative(stem.relativePath);
    requireString(stem.sha256, `output.stems[${stem.id}].sha256`, manifest.jobId);
  }
  return { ...manifest, output, attempts: manifest.attempts ?? 0 };
}

/**
 * Prüft die Vollständigkeit eines als COMPLETED gemeldeten Ergebnisses (§34).
 * Fehlt ein Stem, ist der Job **nicht** fertig – egal was im Status steht.
 */
export function verifyCompletedManifest(manifest: RemoteJobManifest): { ok: true } | { ok: false; code: string; message: string } {
  if (manifest.status !== 'COMPLETED') {
    return { ok: false, code: 'REMOTE_NOT_COMPLETED', message: `Job ${manifest.jobId} ist ${manifest.status}, nicht COMPLETED` };
  }
  const expected = manifest.engine.stems ?? [];
  const delivered = manifest.output?.stems ?? [];
  const deliveredIds = delivered.map((stem) => stem.id);
  const missing = expected.filter((stem) => !deliveredIds.includes(stem));
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'REMOTE_OUTPUT_INCOMPLETE',
      message: `Job ${manifest.jobId} meldet COMPLETED, aber es fehlen: ${missing.join(', ')} (geliefert: ${deliveredIds.join(', ') || 'nichts'})`,
    };
  }
  const empty = delivered.filter((stem) => !Number.isFinite(stem.bytes) || stem.bytes <= 44);
  if (empty.length > 0) {
    return {
      ok: false,
      code: 'REMOTE_OUTPUT_EMPTY',
      message: `Job ${manifest.jobId}: Stem-Datei(en) ohne Inhalt: ${empty.map((stem) => stem.id).join(', ')}`,
    };
  }
  return { ok: true };
}

export function stemOutputFor(input: {
  id: StemId;
  fileName: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  frames: number;
  sampleRate: number;
  channels: number;
  peak?: number;
}): RemoteStemOutput {
  return { ...input };
}

/** Ergebnissatz, den der Worker zusätzlich zum Manifest schreibt (menschenlesbar). */
export function buildResultDocument(manifest: RemoteJobManifest, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      schemaVersion: REMOTE_JOB_SCHEMA_VERSION,
      jobId: manifest.jobId,
      status: manifest.status,
      modelId: manifest.engine.modelId,
      profile: manifest.engine.profile,
      completedAtIso: new Date().toISOString(),
      stems: manifest.output?.stems ?? [],
      worker: manifest.worker,
      ...extra,
    },
    null,
    2
  )}\n`;
}
