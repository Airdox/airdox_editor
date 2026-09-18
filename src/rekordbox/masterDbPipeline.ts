/**
 * @license
 * Renderer-Seite des verbindlichen Rekordbox-Master-DB-Pipeline-Gates.
 *
 *   Rekordbox → Master Database → SQLCipher → DB geöffnet → Schema erkannt →
 *   Track gefunden → Trackdaten gelesen → normalisierte interne Trackdaten →
 *   Waveform-/Analysis-Pipeline → UI
 *
 * Regeln:
 *  - Die Master DB ist PRIMARY SOURCE für Rekordbox-Trackidentität und
 *    -Metadaten. ANLZ/XML/Audiodatei sind SUPPLEMENTARY SOURCES.
 *  - Scheitert ein Gate, gibt es KEINEN stillen Fallback: das Ergebnis trägt
 *    `ok: false` und einen eindeutigen Fehlercode. Der Aufrufer darf dann
 *    nichts als "Rekordbox-Daten" ausgeben.
 *  - Es werden keine Werte erfunden: nicht vorhandene DB-Felder bleiben
 *    `null`/`undefined`.
 */

import { CuePoint, DataOrigin, LoopPoint, PartialTrackModel } from '../types/rekordbox';

export type MasterDbGateErrorCode =
  | 'MASTER_DB_NOT_FOUND'
  | 'SQLCIPHER_UNAVAILABLE'
  | 'MASTER_DB_OPEN_FAILED'
  | 'MASTER_DB_SCHEMA_INVALID'
  | 'TRACK_NOT_FOUND_IN_MASTER_DB'
  | 'MASTER_DB_QUERY_FAILED'
  | 'MASTER_DB_BRIDGE_UNAVAILABLE';

/** Rohdatensatz, wie ihn das Gate aus der Master DB liest. */
export interface MasterDbTrackRecord {
  trackId: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  key: string | null;
  label: string | null;
  bpm: number | null;
  duration: number | null;
  sampleRate: number | null;
  fileSize: number | null;
  comment: string | null;
  rating: number | string | null;
  playCount: number | string | null;
  year: number | string | null;
  analysisDataPath: string | null;
  folderPath: string | null;
  fileName: string | null;
  audioPath: string | null;
  dbDir: string | null;
  cues: Array<{
    id: string;
    kind: number | string;
    inMsec: number | null;
    outMsec: number | null;
    comment: string | null;
    color: number | string | null;
    activeLoop: boolean;
  }>;
}

export interface MasterDbGateSuccess {
  ok: true;
  source: 'rekordbox-master-db';
  sqlcipher: true;
  masterDbFound: true;
  sqlcipherAvailable: true;
  databaseOpened: true;
  schemaValidated: true;
  trackQueryExecuted: true;
  trackFound: true;
  dbPath: string;
  dbType: 'MASTER_DB' | 'ONE_LIBRARY';
  matchedBy: 'TRACK_ID' | 'AUDIO_PATH' | 'UNIQUE_FILENAME';
  trackId: string;
  track: MasterDbTrackRecord;
}

export interface MasterDbGateFailure {
  ok: false;
  source: 'rekordbox-master-db';
  errorCode: MasterDbGateErrorCode;
  reason: string;
  masterDbFound: boolean;
  sqlcipherAvailable: boolean;
  databaseOpened: boolean;
  schemaValidated: boolean;
  trackQueryExecuted: boolean;
  trackFound: boolean;
  dbPath?: string | null;
  dbType?: string;
}

export type MasterDbGateResult = MasterDbGateSuccess | MasterDbGateFailure;

export interface MasterDbGateRequest {
  dbPath?: string;
  trackId?: string | number | null;
  audioPath?: string | null;
  location?: string | null;
}

const HOT_CUE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/**
 * Führt das Master-DB-Gate über die Desktop-Bridge aus.
 * Fehlt die Bridge komplett (Browser), ist das ebenfalls ein Gate-Fehler –
 * nicht etwa ein Grund, auf XML auszuweichen.
 */
export async function runMasterDbGate(request: MasterDbGateRequest): Promise<MasterDbGateResult> {
  const bridge = window.rekordboxDesktop;
  if (!bridge || typeof bridge.resolveTrackFromMasterDb !== 'function') {
    return {
      ok: false,
      source: 'rekordbox-master-db',
      errorCode: 'MASTER_DB_BRIDGE_UNAVAILABLE',
      reason:
        'Der Zugriff auf die Rekordbox Master Database ist nur in der Desktop-App verfügbar (SQLCipher-Bridge fehlt).',
      masterDbFound: false,
      sqlcipherAvailable: false,
      databaseOpened: false,
      schemaValidated: false,
      trackQueryExecuted: false,
      trackFound: false,
    };
  }
  try {
    return (await bridge.resolveTrackFromMasterDb({
      dbPath: request.dbPath,
      trackId: request.trackId ?? undefined,
      audioPath: request.audioPath ?? undefined,
      location: request.location ?? undefined,
    })) as MasterDbGateResult;
  } catch (error) {
    return {
      ok: false,
      source: 'rekordbox-master-db',
      errorCode: 'MASTER_DB_QUERY_FAILED',
      reason: error instanceof Error ? error.message : String(error),
      masterDbFound: false,
      sqlcipherAvailable: false,
      databaseOpened: false,
      schemaValidated: false,
      trackQueryExecuted: false,
      trackFound: false,
    };
  }
}

/**
 * Überführt den DB-Datensatz in normalisierte interne Trackdaten.
 * Ausschließlich tatsächlich gelesene Werte – keine Defaults, keine
 * erfundenen BPM/Cues/Dauern.
 */
export function normalizeMasterDbTrack(record: MasterDbTrackRecord): PartialTrackModel & {
  masterDbTrackId: string;
  analysisDataPath: string | null;
  dbDir: string | null;
} {
  const bpm = typeof record.bpm === 'number' && Number.isFinite(record.bpm) && record.bpm > 0 ? record.bpm : undefined;
  const duration =
    typeof record.duration === 'number' && Number.isFinite(record.duration) && record.duration > 0
      ? record.duration
      : undefined;

  const cues: CuePoint[] = [];
  const loops: LoopPoint[] = [];
  let hotIndex = 0;

  for (const raw of record.cues || []) {
    if (raw.inMsec === null || raw.inMsec === undefined || !Number.isFinite(raw.inMsec)) continue;
    const position = raw.inMsec / 1000;
    const kind = Number(raw.kind) || 0;
    if (raw.outMsec !== null && raw.outMsec !== undefined && Number.isFinite(raw.outMsec) && raw.outMsec > raw.inMsec) {
      const end = raw.outMsec / 1000;
      loops.push({
        id: `db-loop-${record.trackId}-${raw.id || loops.length}`,
        name: raw.comment || `Loop ${loops.length + 1}`,
        start: position,
        end,
        length: end - position,
        color: '#ffb300',
        origin: DataOrigin.REKORDBOX_DB,
      });
      continue;
    }
    if (kind > 0) {
      const letter = HOT_CUE_LETTERS[Math.min(hotIndex, HOT_CUE_LETTERS.length - 1)];
      cues.push({
        id: `db-hot-${record.trackId}-${raw.id || hotIndex}`,
        name: raw.comment || `Hot Cue ${letter}`,
        type: 'HOT_CUE',
        hotCueNum: hotIndex,
        letter,
        position,
        color: '#00a2ff',
        origin: DataOrigin.REKORDBOX_DB,
      });
      hotIndex += 1;
    } else {
      cues.push({
        id: `db-mem-${record.trackId}-${raw.id || cues.length}`,
        name: raw.comment || `Memory Cue ${cues.length + 1}`,
        type: 'MEMORY',
        position,
        color: '#ff3b30',
        origin: DataOrigin.REKORDBOX_DB,
      });
    }
  }

  cues.sort((a, b) => a.position - b.position);

  // Nur tatsächlich vorhandene Werte übernehmen – null/undefined bleibt leer.
  const rating = record.rating === null || record.rating === undefined ? NaN : Number(record.rating);
  const playCount = record.playCount === null || record.playCount === undefined ? NaN : Number(record.playCount);

  return {
    id: record.trackId,
    masterDbTrackId: record.trackId,
    title: record.title ?? undefined,
    artist: record.artist ?? undefined,
    album: record.album ?? undefined,
    genre: record.genre ?? undefined,
    label: record.label ?? undefined,
    key: record.key ?? undefined,
    bpm,
    duration,
    sampleRate:
      typeof record.sampleRate === 'number' && Number.isFinite(record.sampleRate) && record.sampleRate > 0
        ? record.sampleRate
        : undefined,
    rating: Number.isFinite(rating) ? (rating > 5 ? Math.round((rating / 255) * 5) : rating) : undefined,
    playCount: Number.isFinite(playCount) ? playCount : undefined,
    year: record.year !== null && record.year !== undefined ? String(record.year) : undefined,
    comments: record.comment ?? undefined,
    fileSize:
      typeof record.fileSize === 'number' && Number.isFinite(record.fileSize) ? record.fileSize : undefined,
    cues,
    loops,
    origin: DataOrigin.REKORDBOX_DB,
    analysisDataPath: record.analysisDataPath,
    dbDir: record.dbDir,
    rawXmlAttributes: {
      databaseType: 'MASTER_DB',
      masterDbTrackId: record.trackId,
      analysisDataPath: record.analysisDataPath || '',
      folderPath: record.folderPath || '',
      fileName: record.fileName || '',
    },
    originalMedia: record.audioPath
      ? { location: record.audioPath, accessMode: 'READ_ONLY', status: 'UNVERIFIED' }
      : undefined,
  };
}

/**
 * Datenpriorität für einen Track nach erfolgreichem DB-Gate:
 *
 *   1. MASTER DB   – Trackidentität + DB-Metadaten (primär)
 *   2. ANLZ        – hochwertige Rekordbox-Analyse-/Waveform-Daten
 *   3. XML u. a.   – ergänzende Metadaten (nur wo die DB nichts liefert)
 *
 * Widersprüche zwischen DB und XML werden zugunsten der DB aufgelöst.
 */
export function mergeRekordboxSources(
  dbTrack: PartialTrackModel,
  supplementary: PartialTrackModel | null | undefined
): PartialTrackModel {
  if (!supplementary) return { ...dbTrack };
  const merged: PartialTrackModel = { ...supplementary, ...stripUndefined(dbTrack) };
  // Cues/Loops: die DB gewinnt, sobald sie überhaupt welche liefert.
  merged.cues = (dbTrack.cues && dbTrack.cues.length > 0 ? dbTrack.cues : supplementary.cues) || [];
  merged.loops = (dbTrack.loops && dbTrack.loops.length > 0 ? dbTrack.loops : supplementary.loops) || [];
  merged.origin = DataOrigin.REKORDBOX_DB;
  return merged;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Request-Guard gegen Race Conditions bei schnellen Trackwechseln:
 * nur das Ergebnis der jeweils zuletzt gestarteten Anfrage darf angewendet
 * werden (Generationszähler).
 */
export class TrackRequestGuard {
  private generation = 0;

  /** Startet eine neue Anfrage und liefert deren Generationsnummer. */
  public begin(): number {
    this.generation += 1;
    return this.generation;
  }

  /** True, wenn diese Generation noch die aktuelle ist. */
  public isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  public get current(): number {
    return this.generation;
  }
}
