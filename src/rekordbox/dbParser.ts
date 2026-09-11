/**
 * @license
 * Rekordbox Database Row Mapper (Rekordbox 6/7 & OneLibrary)
 *
 * Converts the read-only row payload delivered by the desktop bridge
 * (electron/dbReader.cjs) into the same Partial<TrackModel>` contract that
 * the XML importer produces, so the collection browser and deck loader can
 * be shared.
 *
 * master.db (local Rekordbox 6/7) and exportLibrary.db (OneLibrary /
 * Device Library Plus) use different column naming; both shapes are
 * normalized here. No audio is decoded, no file is written.
 */

import {
  CuePoint,
  DataOrigin,
  LoopPoint,
  PartialTrackModel,
  TrackModel,
} from '../types/rekordbox';
import { joinAudioPath } from './analysisResolver';

export type RekordboxDbType = 'MASTER_DB' | 'ONE_LIBRARY';

export interface RekordboxDatabaseRows {
  content: Array<Record<string, string | number | null>>;
  cues?: Array<Record<string, string | number | null>>;
  artists?: Array<Record<string, string | number | null>>;
  albums?: Array<Record<string, string | number | null>>;
  genres?: Array<Record<string, string | number | null>>;
  keys?: Array<Record<string, string | number | null>>;
  labels?: Array<Record<string, string | number | null>>;
  playlists?: Array<Record<string, string | number | null>>;
  songPlaylists?: Array<Record<string, string | number | null>>;
}

export interface RekordboxDatabaseMappingResult {
  tracks: PartialTrackModel[];
  stats: {
    tracks: number;
    memoryCues: number;
    hotCues: number;
    loops: number;
  };
  warnings: string[];
}

const HOT_CUE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const MEMORY_CUE_COLOR = '#ff3b30';
const HOT_CUE_COLOR = '#00a2ff';

function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function asNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** master.db stores BPM × 100 (e.g. 12800); OneLibrary bpmx100 too. */
function normalizeBpm(raw: unknown, fallback = 130): number {
  const value = asNumber(raw) ?? fallback;
  return value > 1000 ? value / 100 : value;
}

/** Normalize Rekordbox rating (0..255 master.db, 0..5 OneLibrary) → 0..5. */
function normalizeRating(raw: unknown): number {
  const value = asNumber(raw);
  if (value === undefined || value < 0) return 0;
  return value > 5 ? Math.min(5, Math.max(0, Math.round((value / 255) * 5))) : Math.min(5, value);
}

function joinWindowsPath(folder: string | undefined, fileName: string | undefined): string | undefined {
  return joinAudioPath(folder, fileName) || undefined;
}

interface CueRowNormalized {
  kind: number;
  inMs: number;
  outMs?: number;
  comment?: string;
  activeLoop?: boolean;
}

function normalizeCueRow(row: Record<string, string | number | null>): CueRowNormalized {
  const kind = asNumber(row.Kind ?? row.kind) ?? 0;
  const inMsec = asNumber(row.InMsec);
  const inUsec = asNumber(row.inUsec);
  const inMs = inMsec !== undefined ? inMsec : inUsec !== undefined ? inUsec / 1000 : 0;
  const outMsec = asNumber(row.OutMsec ?? row.outMsec);
  const outUsec = asNumber(row.outUsec);
  const outMs =
    outUsec !== undefined
      ? outUsec / 1000
      : outMsec !== undefined && outMsec >= 0
      ? outMsec
      : undefined;
  return {
    kind,
    inMs,
    outMs,
    comment: asString(row.Comment ?? row.cueComment),
    activeLoop: Boolean(row.ActiveLoop ?? row.isActiveLoop),
  };
}

function buildCues(
  contentId: string,
  cueRows: RekordboxDatabaseRows['cues'],
  bpm: number,
  firstBeat = 0
): { cues: CuePoint[]; loops: LoopPoint[] } {
  const cues: CuePoint[] = [];
  const loops: LoopPoint[] = [];
  const spb = 60.0 / bpm;

  (cueRows || [])
    .filter((row) => String(row.ContentID ?? row.content_id) === contentId)
    .forEach((row, index) => {
      const cue = normalizeCueRow(row);
      const position = cue.inMs / 1000;
      const isLoop = cue.outMs !== undefined && cue.outMs > cue.inMs;
      const beatIndex = Math.max(0, Math.round((position - firstBeat) / spb));
      const barNumber = Math.floor(beatIndex / 4) + 1;
      const beatNumber = (beatIndex % 4) + 1;

      if (isLoop) {
        loops.push({
          id: `db-loop-${index + 1}`,
          name: cue.comment || `Loop ${index + 1}`,
          start: position,
          end: cue.outMs! / 1000,
          length: Math.max(0, (cue.outMs! - cue.inMs) / 1000),
          color: '#ff9500',
          origin: DataOrigin.REKORDBOX_DB,
        });
        return;
      }

      const isHotCue = cue.kind >= 1 && cue.kind <= 8;
      if (isHotCue) {
        const letter = HOT_CUE_LETTERS[cue.kind - 1];
        cues.push({
          id: `db-hot-${cue.kind}`,
          name: cue.comment || `Hot Cue ${letter}`,
          type: 'HOT_CUE',
          hotCueNum: cue.kind - 1,
          letter,
          position,
          inMsec: Math.round(cue.inMs),
          cueIndex: cue.kind,
          barNumber,
          beatNumber,
          comment: cue.comment,
          color: HOT_CUE_COLOR,
          origin: DataOrigin.REKORDBOX_DB,
        });
      } else {
        cues.push({
          id: `db-mem-${index + 1}`,
          name: cue.comment || `Memory Cue ${index + 1}`,
          type: 'MEMORY',
          position,
          inMsec: Math.round(cue.inMs),
          cueIndex: index + 1,
          barNumber,
          beatNumber,
          comment: cue.comment,
          color: MEMORY_CUE_COLOR,
          origin: DataOrigin.REKORDBOX_DB,
        });
      }
    });

  return { cues, loops };
}

/**
 * Maps the raw database rows to collection TrackModels with compact beat
 * grids (no dense grids until a track is loaded into the deck).
 */
export function mapRekordboxDatabaseRows(
  rows: RekordboxDatabaseRows,
  dbType: RekordboxDbType
): RekordboxDatabaseMappingResult {
  const warnings: string[] = [];
  const artists = new Map(
    (rows.artists || []).map((row) => [String(row.ID ?? row.artist_id), asString(row.Name ?? row.name)])
  );
  const albums = new Map(
    (rows.albums || []).map((row) => [String(row.ID ?? row.album_id), asString(row.Name ?? row.name)])
  );
  const genres = new Map(
    (rows.genres || []).map((row) => [String(row.ID ?? row.genre_id), asString(row.Name ?? row.name)])
  );
  const keys = new Map(
    (rows.keys || []).map((row) => [
      String(row.ID ?? row.key_id),
      asString(row.ScaleName ?? row.name) || '2A',
    ])
  );
  const labels = new Map(
    (rows.labels || []).map((row) => [String(row.ID ?? row.label_id), asString(row.Name ?? row.name)])
  );

  const tracks: PartialTrackModel[] = [];
  let memoryCues = 0;
  let hotCues = 0;
  let loops = 0;

  (rows.content || []).forEach((row, index) => {
    const id = String(row.ID ?? row.content_id ?? `db-track-${index + 1}`);
    const artistId = asString(row.ArtistID ?? row.artist_id_artist);
    const albumId = asString(row.AlbumID ?? row.album_id);
    const genreId = asString(row.GenreID ?? row.genre_id);
    const keyId = asString(row.KeyID ?? row.key_id);
    const labelId = asString(row.LabelID ?? row.label_id);

    const bpm = normalizeBpm(row.BPM ?? row.bpmx100);
    const lengthMs = asNumber(row.Length ?? row.length) ?? 0;
    const duration = lengthMs > 0 ? lengthMs / 1000 : 0;
    const folderPath = asString(row.FolderPath ?? row.path);
    const fileName = asString(row.FileNameL ?? row.fileName);

    const cueModel = buildCues(id, rows.cues, bpm, 0);
    memoryCues += cueModel.cues.filter((cue) => cue.type === 'MEMORY').length;
    hotCues += cueModel.cues.filter((cue) => cue.type === 'HOT_CUE').length;
    loops += cueModel.loops.length;

    const track: PartialTrackModel = {
      id,
      title: asString(row.Title ?? row.title) || fileName?.replace(/\.[^/.]+$/, '') || 'Untitled Track',
      artist: artists.get(artistId || '') || 'Unknown Artist',
      album: albums.get(albumId || '') || '',
      genre: genres.get(genreId || '') || undefined,
      label: labels.get(labelId || '') || undefined,
      bpm,
      key: keys.get(keyId || '') || '2A',
      duration,
      sampleRate: asNumber(row.SampleRate ?? row.samplingRate) ?? 44100,
      channels: 2,
      rating: normalizeRating(row.Rating ?? row.rating),
      playCount:
        asNumber(row.DJPlayCount ?? row.djPlayCount) ?? asNumber(row.PlayCount) ?? undefined,
      year: asString(row.ReleaseYear ?? row.releaseYear) || undefined,
      comments: asString(row.Commnt ?? row.djComment) || undefined,
      dateAdded: asString(row.StockDate ?? row.dateCreated ?? row.dateAdded) || undefined,
      isrc: asString(row.ISRC ?? row.isrc) || undefined,
      beatGrid: {
        firstBeat: 0,
        bpm,
        meter: 4,
        beats: [],
        origin: DataOrigin.REKORDBOX_DB,
      },
      cues: cueModel.cues,
      loops: cueModel.loops,
      origin: DataOrigin.REKORDBOX_DB,
      rawXmlAttributes: {
        databaseType: dbType,
        analysisDataPath: asString(row.AnalysisDataPath ?? row.analysisDataFilePath) || '',
        folderPath: folderPath || '',
        fileName: fileName || '',
        fileSize: String(asNumber(row.FileSize ?? row.fileSize) ?? 0),
      },
      originalMedia: folderPath || fileName
        ? {
            location: joinWindowsPath(folderPath, fileName) || fileName!,
            accessMode: 'READ_ONLY',
            status: 'UNVERIFIED',
          }
        : undefined,
    };
    tracks.push(track);
  });

  return { tracks, stats: { tracks: tracks.length, memoryCues, hotCues, loops }, warnings };
}

/**
 * Expands a compact collection track into a full TrackModel (the equivalent
 * of loading the track into the deck from the XML collection).
 */
export function buildDeckTrackFromDatabase(
  partial: PartialTrackModel,
  durationOverride?: number
): TrackModel {
  const duration = durationOverride && durationOverride > 0 ? durationOverride : partial.duration || 300;
  const bpm = partial.bpm || 130;
  return {
    id: partial.id || `rb-db-${Date.now()}`,
    title: partial.title || 'Rekordbox Track',
    artist: partial.artist || 'Unknown Artist',
    album: partial.album || '',
    genre: partial.genre,
    label: partial.label,
    bpm,
    key: partial.key || '2A',
    duration,
    sampleRate: partial.sampleRate || 44100,
    channels: partial.channels || 2,
    originalSha256: 'NOT_COMPUTED_READ_ONLY_SOURCE',
    isOriginalUntouched: true,
    audioBuffer: null,
    beatGrid: partial.beatGrid ?? {
      firstBeat: 0,
      bpm,
      meter: 4,
      beats: [],
      origin: DataOrigin.REKORDBOX_DB,
    },
    cues: partial.cues || [],
    loops: partial.loops || [],
    analysis: null,
    phrases: [],
    origin: DataOrigin.REKORDBOX_DB,
    rawXmlAttributes: partial.rawXmlAttributes,
    originalMedia: partial.originalMedia,
    workingSegments: [
      {
        id: `seg-db-${Date.now()}`,
        type: 'ORIGINAL',
        trackId: partial.id || '1',
        sourceStart: 0,
        sourceEnd: duration,
        projectStart: 0,
        projectDuration: duration,
        gain: 1.0,
      },
    ],
  };
}
