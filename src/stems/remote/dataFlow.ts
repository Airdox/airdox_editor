/**
 * Datenfluss-Transparenz für Fern-Jobs (§16, §20, §21, §40).
 *
 * Warum dieses Modul existiert
 * ----------------------------
 * Der Fernpfad führt dieselben Bytes durch vier Reiche: diesen Rechner, die
 * synchronisierte Ablage, die Google-Cloud und den Colab-Worker. Im Fenster
 * stand davon lange nur eine Zahl („Fortschritt 0 %“) – und genau die bleibt
 * stehen, solange **kein Worker gerechnet hat**, also ausgerechnet in der
 * Phase, in der der Nutzer nichts anderes sieht. Dieses Modul macht jede
 * Station einzeln sichtbar und belegt sie mit dem, was der Editor tatsächlich
 * beobachtet hat.
 *
 * Grundregel (§13, §21): **Eine Station gilt nur dann als erledigt, wenn es
 * dafür einen Beleg gibt.** Belege sind entweder ein Prüfpunkt
 * (`RemoteFlowCheckpoint`, vom Editor im Moment der Beobachtung geschrieben)
 * oder ein Feld, das derselbe Lauf ohnehin führt (z. B. `uploadedAt`,
 * `worker.claimedAt`, `localJobId`). Was der Editor **nicht** sehen kann, wird
 * nicht geschätzt und nicht hochgerechnet: die Cloud-Synchronisation ist die
 * einzige Station ohne technischen Beleg und steht deshalb dauerhaft auf
 * `unknown` – es sei denn, der Nutzer bestätigt sie von Hand oder der
 * Rückweg hat sie bewiesen.
 *
 * Alles hier ist eine reine Abbildung (Record + Uhrzeit → Anzeige). Es werden
 * keine Dateien gelesen, kein Netzwerk berührt und kein Status erfunden.
 */
import type { RemoteJobRecord } from './types';
import type { RemoteWorkerHeartbeat } from '../transportTypes';

/** Wo eine Station stattfindet – die Anzeige gruppiert danach. */
export type RemoteFlowWhere = 'local' | 'store' | 'cloud' | 'worker';

/**
 * Zustand einer Station.
 *
 *  - `done`    – es gibt einen Beleg
 *  - `active`  – der Fluss steht hier (der nächste Beleg wird hier erwartet)
 *  - `pending` – noch nicht erreicht
 *  - `unknown` – **nicht messbar**; der Editor hat keine Quelle dafür
 *  - `failed`  – hier ist der Lauf geendet (Fehler oder Abbruch)
 */
export type RemoteFlowState = 'done' | 'active' | 'pending' | 'unknown' | 'failed';

/** Ein benannter Beleg einer Station (Paar aus Bezeichnung und Wert). */
export interface RemoteFlowFact {
  label: string;
  value: string;
}

export interface RemoteFlowStation {
  id: RemoteFlowStationId;
  /** Kurztitel, wie er im Laufzettel steht. */
  title: string;
  where: RemoteFlowWhere;
  state: RemoteFlowState;
  /** Zeitpunkt des Belegs (ms seit Epoch), fehlt bei `pending`/`unknown`. */
  at?: number;
  /** Zeitpunkt der letzten Aktualisierung (nur Fortschritts-Stationen). */
  updatedAt?: number;
  /** Ein Satz, der sagt, was hier feststeht – nie eine Vermutung. */
  detail?: string;
  /** Belege für diese Station. */
  facts?: RemoteFlowFact[];
  /** Handlungs-/Prüfhinweis, wenn der Nutzer etwas tun kann. */
  hint?: string;
  /** Fortschritt in Prozent, soweit die Station einen hat. */
  percent?: number;
}

export interface RemoteJobDataFlow {
  jobId: string;
  stations: RemoteFlowStation[];
  /** Station, an der der Fluss gerade steht (`null`, wenn alles durch ist). */
  currentId: RemoteFlowStationId | null;
  /** Erste Station, für die es keinen Beleg gibt – auch `unknown` zählt. */
  openCount: number;
  doneCount: number;
  totalCount: number;
  /** Zeitpunkt des letzten Belegs überhaupt (für „still seit …“). */
  lastEvidenceAt: number;
  /** `true`, wenn die Cloud-Station auf eine manuelle Bestätigung wartet. */
  awaitingCloudConfirmation: boolean;
}

/**
 * Ein vom Editor beobachteter Beleg. Er wird im Moment der Beobachtung an den
 * Job-Datensatz gehängt und überlebt damit Neustarts (§21 A, §32).
 */
export interface RemoteFlowCheckpoint {
  id: RemoteFlowStationId;
  at: number;
  /** Letzte Aktualisierung (Fortschritt wird fortgeschrieben, `at` bleibt). */
  updatedAt?: number;
  detail?: string;
  facts?: RemoteFlowFact[];
}

/** Persistenter Datenfluss-Zustand am Job-Datensatz. */
export interface RemoteJobFlow {
  checkpoints: RemoteFlowCheckpoint[];
  /**
   * Vom Nutzer bestätigte Cloud-Synchronisation. **Kein technischer Beleg** –
   * der Editor kann den Cloud-Stand nicht prüfen; das ist die Aussage des
   * Nutzers „ich sehe den Job in Drive“ (§13).
   */
  cloudSyncConfirmedAt?: number;
}

/** Die Stationen des Datenflusses in ihrer Reihenfolge. */
export const REMOTE_FLOW_STATIONS = [
  'working_copy',
  'published',
  'cloud_sync',
  'worker_seen',
  'claimed',
  'compute',
  'results_ready',
  'downloaded',
  'validated',
  'imported',
] as const;

export type RemoteFlowStationId = (typeof REMOTE_FLOW_STATIONS)[number];

export const REMOTE_FLOW_TITLES: Record<RemoteFlowStationId, string> = {
  working_copy: 'Arbeitskopie erstellt',
  published: 'In der Jobablage abgelegt',
  cloud_sync: 'In der Google-Cloud angekommen',
  worker_seen: 'Colab-Worker in der Ablage gesehen',
  claimed: 'Job vom Worker angenommen',
  compute: 'Trennung gerechnet',
  results_ready: 'Ergebnisse in der Ablage',
  downloaded: 'Ergebnisse geholt',
  validated: 'Hashes und Geometrie geprüft',
  imported: 'Im Editor verfügbar',
};

export const REMOTE_FLOW_WHERE: Record<RemoteFlowStationId, RemoteFlowWhere> = {
  working_copy: 'local',
  published: 'store',
  cloud_sync: 'cloud',
  worker_seen: 'worker',
  claimed: 'worker',
  compute: 'worker',
  results_ready: 'store',
  downloaded: 'local',
  validated: 'local',
  imported: 'local',
};

export const REMOTE_FLOW_WHERE_LABEL: Record<RemoteFlowWhere, string> = {
  local: 'Dieser Rechner',
  store: 'Jobablage',
  cloud: 'Google-Cloud',
  worker: 'Colab-Worker',
};

/* ------------------------------------------------------------------------- *
 * Anzeige-Helfer (einmal hier, damit UI und Tests dieselben Werte sehen)
 * ------------------------------------------------------------------------- */

export function formatFlowBytes(bytes: number | undefined): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '–';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatFlowDuration(seconds: number | undefined): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '–';
  const total = Math.round(value);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** Kurzform eines Hash – lang genug zum Vergleich, kurz genug für die Zeile. */
export function shortFlowHash(hash: string | undefined, length = 16): string {
  if (!hash) return '–';
  const clean = hash.trim();
  if (clean.length <= length) return clean;
  return `${clean.slice(0, length)}…`;
}

/** „vor 2:05“ – relative Dauer, wie sie im Laufzettel steht. */
export function formatFlowAge(fromMs: number | undefined, now: number): string {
  if (typeof fromMs !== 'number' || !Number.isFinite(fromMs)) return '–';
  const seconds = Math.max(0, Math.floor((now - fromMs) / 1000));
  if (seconds < 60) return `vor ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `vor ${minutes}:${String(rest).padStart(2, '0')} min`;
  const hours = Math.floor(minutes / 60);
  return `vor ${hours}:${String(minutes % 60).padStart(2, '0')} h`;
}

export function formatFlowClock(at: number | undefined): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '–';
  return new Date(at).toLocaleTimeString('de-DE', { hour12: false });
}

/** Dateiname ohne Verzeichnis – Belege nennen nie einen ganzen Nutzerpfad. */
export function flowBaseName(value: string | undefined): string {
  if (!value) return '–';
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '–';
}

/* ------------------------------------------------------------------------- *
 * Prüfpunkte schreiben
 * ------------------------------------------------------------------------- */

/**
 * Schreibt einen Prüfpunkt an den Datensatz.
 *
 * Ein bestehender Prüfpunkt derselben Station wird **fortgeschrieben**, nicht
 * dupliziert: `at` bleibt der erste Beleg, `updatedAt` folgt der letzten
 * Beobachtung. Damit bleibt „wie lange steht das schon?“ ehrlich, während
 * Fortschrittswerte (Prozent, Phase) dennoch aktuell bleiben.
 */
export function upsertFlowCheckpoint(
  flow: RemoteJobFlow | undefined,
  checkpoint: RemoteFlowCheckpoint
): RemoteJobFlow {
  const next: RemoteJobFlow = { ...(flow ?? { checkpoints: [] }) };
  const list = [...(next.checkpoints ?? [])];
  const index = list.findIndex((entry) => entry.id === checkpoint.id);
  if (index === -1) {
    list.push(checkpoint);
  } else {
    const previous = list[index];
    list[index] = {
      ...previous,
      ...checkpoint,
      // Der erste Belegzeitpunkt gewinnt – sonst würde „steht seit …“ bei
      // jedem Poll zurückgesetzt und die Stall-Warnung nie auslösen.
      at: Math.min(previous.at, checkpoint.at),
      updatedAt: checkpoint.updatedAt ?? previous.updatedAt,
    };
  }
  next.checkpoints = list;
  return next;
}

export function flowCheckpoints(flow: RemoteJobFlow | undefined): Map<RemoteFlowStationId, RemoteFlowCheckpoint> {
  const map = new Map<RemoteFlowStationId, RemoteFlowCheckpoint>();
  for (const entry of flow?.checkpoints ?? []) {
    if ((REMOTE_FLOW_STATIONS as readonly string[]).includes(entry.id)) {
      map.set(entry.id, entry);
    }
  }
  return map;
}

/* ------------------------------------------------------------------------- *
 * Abbildung: Datensatz → Laufzettel
 * ------------------------------------------------------------------------- */

export interface RemoteFlowBuildOptions {
  now: number;
  /** Globales Worker-Lebenszeichen aus `worker.status.json` (kann fehlen). */
  worker?: RemoteWorkerHeartbeat | null;
  /** Anzeigename der Ablage, z. B. „Google Drive (Ordner)“. */
  transportLabel?: string;
  /** Wurzel der Ablage – nur Anzeige, nie ein Geheimnis (§23). */
  transportRoot?: string;
}

interface StationContext {
  record: RemoteJobRecord;
  now: number;
  worker: RemoteWorkerHeartbeat | null;
  transportLabel: string;
  transportRoot?: string;
  checkpoints: Map<RemoteFlowStationId, RemoteFlowCheckpoint>;
  cloudSyncConfirmedAt?: number;
  outcome: 'open' | 'completed' | 'failed' | 'cancelled';
}

/** Relative Pfade in der Ablage – der Nutzer findet sie in Drive wieder. */
function jobInputRelative(record: RemoteJobRecord): string {
  const relative = record.manifest?.input?.relativePath;
  if (relative) return relative;
  const file = record.manifest?.input?.fileName ?? flowBaseName(record.workingCopyPath);
  return `jobs/${record.jobId}/input/${file}`;
}

function terminalOutcome(record: RemoteJobRecord): StationContext['outcome'] {
  if (record.status === 'COMPLETED') return 'completed';
  if (record.status === 'CANCELLED') return 'cancelled';
  if (record.status === 'FAILED') return 'failed';
  return 'open';
}

/**
 * Baut den Laufzettel eines Jobs.
 *
 * Die Reihenfolge ist verbindlich: kein späterer Beleg kann einen früheren
 * ersetzen. Fehlt ein Beleg, bleibt die Station `pending` – und die erste
 * Station ohne Beleg ist die, an der der Fluss steht.
 */
export function buildRemoteDataFlow(record: RemoteJobRecord, options: RemoteFlowBuildOptions): RemoteJobDataFlow {
  const now = options.now;
  const checkpoints = flowCheckpoints(record.flow);
  const outcome = terminalOutcome(record);
  const ctx: StationContext = {
    record,
    now,
    worker: options.worker ?? null,
    transportLabel: options.transportLabel ?? record.transportLabel ?? 'Jobablage',
    transportRoot: options.transportRoot ?? record.transportRoot,
    checkpoints,
    cloudSyncConfirmedAt: record.flow?.cloudSyncConfirmedAt,
    outcome,
  };

  const stations: RemoteFlowStation[] = REMOTE_FLOW_STATIONS.map((id) => ({
    id,
    title: REMOTE_FLOW_TITLES[id],
    where: REMOTE_FLOW_WHERE[id],
    state: 'pending' as RemoteFlowState,
    ...stationFacts(ctx, id),
  }));

  /*
   * Die Station, an der der Fluss steht, ist die erste ohne Beleg – **aber**
   * die Cloud-Station zählt hier nicht als Blockade. Sonst würde ein
   * unbestätigter Cloud-Schritt alles dahinter verdecken, selbst wenn der
   * Worker längst rechnet: „Trennung gerechnet“ stünde auf „offen“, obwohl
   * der Fortschritt längst gemeldet wird. Die Cloud-Station bleibt deshalb
   * sichtbar offen (`unknown`) und wartet auf Bestätigung, ohne den Laufzettel
   * anzuhalten.
   */
  const openIndex = stations.findIndex((station) => station.state !== 'done' && station.state !== 'unknown');
  const currentId = openIndex === -1 ? null : stations[openIndex].id;

  // Alles hinter der offenen Station ist „noch nicht erreicht“.
  if (openIndex !== -1) {
    for (let index = openIndex + 1; index < stations.length; index += 1) {
      if (stations[index].state === 'done') continue;
      stations[index] = { ...stations[index], state: 'pending' };
    }
  }

  /*
   * Ein geendeter Lauf bekommt eine Station, an der er geendet ist – sonst
   * stünde im Laufzettel „läuft“ neben „Fehlgeschlagen“ im Kopf. Der Grund
   * kommt aus dem Job (Fehlercode bzw. Abbruch), nicht aus einer Vermutung.
   */
  if (openIndex !== -1 && (ctx.outcome === 'failed' || ctx.outcome === 'cancelled')) {
    const ended = stations[openIndex];
    stations[openIndex] = {
      ...ended,
      state: 'failed',
      at: ended.at ?? record.finishedAt ?? record.updatedAt,
      detail: ended.detail ?? (ctx.outcome === 'cancelled' ? 'Hier wurde der Lauf abgebrochen.' : 'Hier ist der Lauf fehlgeschlagen.'),
      facts: ended.facts ?? (record.error ? [{ label: 'Grund', value: `${record.error.code}: ${record.error.message}` }] : undefined),
    };
  }

  const doneCount = stations.filter((station) => station.state === 'done').length;
  const lastEvidenceAt = stations.reduce((latest, station) => {
    const at = station.updatedAt ?? station.at;
    return typeof at === 'number' ? Math.max(latest, at) : latest;
  }, record.createdAt);

  return {
    jobId: record.jobId,
    stations,
    currentId,
    doneCount,
    openCount: stations.length - doneCount,
    totalCount: stations.length,
    lastEvidenceAt,
    awaitingCloudConfirmation: stations.some((station) => station.id === 'cloud_sync' && station.state === 'unknown'),
  };
}

/** Zustand, Zeitpunkt und Belege einer einzelnen Station. */
function stationFacts(ctx: StationContext, id: RemoteFlowStationId): Omit<RemoteFlowStation, 'id' | 'title' | 'where'> {
  const checkpoint = ctx.checkpoints.get(id);
  const record = ctx.record;

  // Ein Prüfpunkt ist immer der beste Beleg: er wurde im Moment der
  // Beobachtung geschrieben und trägt die damals erhobenen Werte.
  const fromCheckpoint = (): Omit<RemoteFlowStation, 'id' | 'title' | 'where'> | null => {
    if (!checkpoint) return null;
    return { state: 'done', at: checkpoint.at, updatedAt: checkpoint.updatedAt, detail: checkpoint.detail, facts: checkpoint.facts };
  };

  switch (id) {
    case 'working_copy': {
      const checked = fromCheckpoint();
      if (checked) return checked;
      // Ohne Prüfpunkt (Job aus einer älteren Version): die Arbeitskopie ist
      // die Grundvoraussetzung jedes Fern-Jobs – sie existiert immer.
      return {
        state: 'done',
        at: record.createdAt,
        detail: 'Arbeitskopie im Engine-Datenordner; das Original wurde nur gelesen.',
        facts: [
          { label: 'Datei', value: flowBaseName(record.workingCopyPath) },
          { label: 'Größe', value: formatFlowBytes(record.workingCopyBytes) },
          { label: 'SHA-256', value: shortFlowHash(record.workingCopySha256) },
          { label: 'Audio', value: `${formatFlowDuration(record.durationSeconds)} · ${record.sampleRate} Hz · ${record.channels} Kan.` },
        ],
      };
    }

    case 'published': {
      const checked = fromCheckpoint();
      if (checked) return checked;
      if (record.uploadedAt || (record.status !== 'PREPARING' && record.status !== 'PENDING')) {
        return {
          state: 'done',
          at: record.uploadedAt ?? record.updatedAt,
          detail: `Arbeitskopie und Steckbrief liegen in der ${ctx.transportLabel}.`,
          facts: [
            { label: 'Ablage', value: ctx.transportLabel },
            { label: 'Eingabe', value: jobInputRelative(record) },
            { label: 'Steckbrief', value: `jobs/${record.jobId}/manifest.json` },
            { label: 'Größe', value: formatFlowBytes(record.workingCopyBytes) },
          ],
        };
      }
      return {
        state: 'active',
        detail: 'Die Arbeitskopie wird in die Jobablage geschrieben.',
        hint: 'Schlägt dieser Schritt fehl, ist der Ablageordner nicht erreichbar (Drive für Desktop gestartet? Ordner vorhanden?).',
      };
    }

    case 'cloud_sync': {
      if (checkpoint) return fromCheckpoint()!;
      const confirmedAt = ctx.cloudSyncConfirmedAt;
      if (typeof confirmedAt === 'number') {
        return {
          state: 'done',
          at: confirmedAt,
          detail: 'Von Ihnen im Google-Drive-Ordner gesehen – eine Bestätigung, keine technische Prüfung.',
          facts: [
            { label: 'Bestätigt', value: formatFlowClock(confirmedAt) },
            { label: 'Pfad in Drive', value: jobInputRelative(record) },
          ],
        };
      }
      if (ctx.outcome === 'completed') {
        return {
          state: 'done',
          at: record.finishedAt ?? record.updatedAt,
          detail: 'Rückweg bewiesen: die Ergebnisse kamen aus derselben Cloud zurück.',
          facts: [{ label: 'Pfad in Drive', value: jobInputRelative(record) }],
        };
      }
      /*
       * Die ehrliche Antwort: Drive für Desktop meldet dem Editor nicht, was
       * es bereits hochgeladen hat. Wer hier „fertig“ anzeigt, erfindet einen
       * Beleg. Also bleibt die Station offen – mit genau dem Pfad, den man im
       * Browser nachsehen kann.
       */
      return {
        state: 'unknown',
        detail: 'Nicht messbar: Drive für Desktop meldet den Cloud-Stand nicht an den Editor zurück.',
        facts: [
          { label: 'Datei liegt bereit', value: jobInputRelative(record) },
          { label: 'Erwartet in Drive', value: `jobs/${record.jobId}/input/` },
        ],
        hint:
          'In drive.google.com denselben Ordner öffnen und nachsehen, ob jobs/' +
          `${record.jobId}/input/ dort liegt. Wenn ja: „In Drive gesehen“ klicken – ` +
          'dann ist auch dieser Schritt im Laufzettel abgehakt.',
      };
    }

    case 'worker_seen': {
      const checked = fromCheckpoint();
      if (checked) return checked;
      const heartbeatAt = record.worker?.heartbeatAt ?? ctx.worker?.heartbeatAt ?? record.worker?.claimedAt;
      if (typeof heartbeatAt === 'number') {
        const host = record.worker?.host ?? ctx.worker?.host;
        const device = record.worker?.device ?? ctx.worker?.device;
        const gpu = record.worker?.gpu ?? ctx.worker?.gpu;
        return {
          state: 'done',
          at: heartbeatAt,
          updatedAt: heartbeatAt,
          detail: 'Der Worker schreibt ein Lebenszeichen in die Ablage.',
          facts: [
            { label: 'Worker', value: record.worker?.id ?? ctx.worker?.id ?? '–' },
            { label: 'Host', value: host ?? '–' },
            { label: 'Gerät', value: gpu ? `${device ?? '?'} (${gpu})` : (device ?? '–') },
            { label: 'Letztes Zeichen', value: formatFlowAge(heartbeatAt, ctx.now) },
          ],
        };
      }
      return {
        state: 'active',
        detail: 'Noch kein Lebenszeichen eines Workers in der Ablage.',
        hint:
          'Der Worker muss laufen: Colab-Notebook öffnen, Laufzeit starten und Zelle #5 ausführen. ' +
          'Erst dann erscheinen worker.status.json und ein Claim in der Ablage.',
      };
    }

    case 'claimed': {
      const checked = fromCheckpoint();
      if (checked) return checked;
      if (record.worker?.claimedAt) {
        return {
          state: 'done',
          at: record.worker.claimedAt,
          detail: 'Der Worker hat den Job für sich reserviert und rechnet.',
          facts: [
            { label: 'Worker', value: record.worker.id },
            { label: 'Gerät', value: record.worker.gpu ? `${record.worker.device ?? '?'} (${record.worker.gpu})` : (record.worker.device ?? '–') },
            { label: 'Version', value: record.worker.version ?? '–' },
          ],
        };
      }
      return { state: 'pending', detail: 'Der Worker beansprucht den Job, sobald er ihn in der Ablage sieht.' };
    }

    case 'compute': {
      /*
       * „Fertig gerechnet“ heißt: ein Ergebnis liegt in der Ablage (oder der
       * Lauf ist durch). Dass die Prozentzahl 100 erreicht, wäre kein Beleg –
       * sie stammt vom Worker selbst. Also entscheidet der nächste Beleg.
       */
      const finished = ctx.outcome === 'completed' || ctx.checkpoints.has('results_ready');
      const percent = finished ? 100 : Math.round(record.workerPercent ?? record.percent ?? 0);
      const device = record.worker?.device ?? record.device;
      const facts: RemoteFlowFact[] = [
        { label: 'Fortschritt', value: `${percent} %` },
        { label: 'Phase', value: record.phase || '–' },
        { label: 'Gerät', value: device ?? '–' },
        { label: 'Modell', value: record.modelId },
      ];
      if (record.cpuFallback) {
        facts.push({ label: 'Rückfall', value: record.fallbackReason ? `CPU – ${record.fallbackReason}` : 'CPU' });
      }
      const checked = fromCheckpoint();
      if (checked) {
        return {
          ...checked,
          state: finished ? 'done' : 'active',
          percent,
          updatedAt: checked.updatedAt ?? record.phaseUpdatedAt,
          facts,
        };
      }
      if (finished || percent > 0 || (record.worker?.claimedAt && record.status === 'RUNNING')) {
        return {
          state: finished ? 'done' : 'active',
          at: record.phaseUpdatedAt ?? record.updatedAt,
          updatedAt: record.phaseUpdatedAt ?? record.updatedAt,
          percent,
          detail: finished
            ? 'Der Worker hat die Trennung abgeschlossen.'
            : 'Der Worker rechnet und meldet seinen Fortschritt in den Steckbrief.',
          facts,
        };
      }
      return {
        state: 'pending',
        percent,
        detail: 'Noch keine Fortschrittsmeldung des Workers.',
        hint: 'Bleibt das lange so, hat der Worker den Job zwar beansprucht, rechnet aber nicht (Laufzeit getrennt? Zelle beendet?).',
      };
    }

    case 'results_ready': {
      const checked = fromCheckpoint();
      if (checked) return checked;
      if (record.status === 'VALIDATING' || record.status === 'RECONSTRUCTING' || record.status === 'COMPLETED') {
        return {
          state: 'done',
          at: record.finishedAt ?? record.updatedAt,
          detail: 'Die Ergebnisse liegen in der Ablage; der Editor holt sie.',
          facts: [
            { label: 'Ergebnisse', value: `jobs/${record.jobId}/output/` },
            { label: 'Stems', value: (record.stems ?? []).join(', ') },
          ],
        };
      }
      return { state: 'pending', detail: 'Der Worker schreibt die Stems nach dem Rechnen in die Ablage zurück.' };
    }

    case 'downloaded': {
      const checked = fromCheckpoint();
      if (checked) return checked;
      if (record.importedStems?.length || record.localJobId) {
        const bytes = (record.importedStems ?? []).reduce((sum, stem) => sum + (stem.bytes ?? 0), 0);
        return {
          state: 'done',
          at: record.finishedAt ?? record.updatedAt,
          detail: 'Alle Ergebnisdateien wurden aus der Ablage gelesen.',
          facts: [
            { label: 'Dateien', value: `${(record.importedStems ?? []).length}` },
            { label: 'Bytes', value: formatFlowBytes(bytes) },
          ],
        };
      }
      return { state: 'pending', detail: 'Der Editor liest die Ergebnisdateien aus der Ablage.' };
    }

    case 'validated': {
      const checked = fromCheckpoint();
      if (checked) return checked;
      if (record.importedStems?.length || record.localJobId) {
        return {
          state: 'done',
          at: record.finishedAt ?? record.updatedAt,
          detail: 'SHA-256, Abtastrate, Kanäle, Länge und Pegel geprüft.',
          facts: (record.importedStems ?? []).map((stem) => ({
            label: stem.id,
            value: `${shortFlowHash(stem.sha256, 12)} · ${formatFlowBytes(stem.bytes)}`,
          })),
        };
      }
      return { state: 'pending', detail: 'Jede Ergebnisdatei wird gegen den vom Worker gemeldeten Hash geprüft.' };
    }

    case 'imported': {
      const checked = fromCheckpoint();
      if (checked) return checked;
      if (record.localJobId) {
        return {
          state: 'done',
          at: record.finishedAt ?? record.updatedAt,
          detail: 'Die Stems sind im Editor verfügbar und mit dem Original-Track verknüpft.',
          facts: [
            { label: 'Job', value: record.localJobId },
            { label: 'Stems', value: (record.importedStems ?? []).map((stem) => stem.id).join(', ') || '–' },
          ],
        };
      }
      return { state: 'pending', detail: 'Der Editor registriert die geprüften Stems am Track.' };
    }

    default:
      return { state: 'pending' };
  }
}
