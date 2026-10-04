/**
 * Projektmodell: reine Funktionen rund um Track, Editierkontext und Persistenz.
 *
 * Warum diese Datei existiert:
 *   Diese Zeilen standen als Modul-Ebene über der Komponente in `App.tsx`.
 *   Sie sind frei von React und DOM – reine Umrechnung und Serialisierung – und
 *   waren deshalb im Testgraphen gar nicht erreichbar. Hier sind sie prüfbar,
 *   und `App.tsx` beginnt mit der eigentlichen Komponente.
 *
 *   Zerlegung WP-06 (Vorbereitung Schritt 3/4). Übertragen, nicht umgeschrieben.
 */

import type {
  AnalysisFileReference,
  EditSegment,
  PartialTrackModel,
  TrackModel,
} from '../../types/rekordbox';
import { DataOrigin } from '../../types/rekordbox';
import type { EditCommandContext } from '../../audio/editingEngine';
import { base64ToBytes, type SerializedTrack } from '../../rekordbox/projectFile';
import { buildBeatGridFromTempo } from '../../rekordbox/xmlParser';
import { isNativeRekordboxWaveform, sliceWaveformAnalysis } from '../../waveform/analysisComposer';

/** Ursprung eines kopierten Bereichs – Quelle für Herkunftsnachweis und Rückweg. */
export interface ClipboardProvenance {
  sourceTrackId: string;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  analysis?: ReturnType<typeof sliceWaveformAnalysis>;
  beatOffsets?: number[];
  /** Native source coordinates only when this exact copied range is ANLZ-backed. */
  analysisSource?: AnalysisFileReference;
  analysisSourceTrackId?: string;
  analysisSourceStart?: number;
  analysisSourceEnd?: number;
}

const TIME_EPSILON = 1 / 44100 + 1e-6;

export function beatOffsetsForRange(track: TrackModel, start: number, end: number): number[] {
  return track.beatGrid.beats
    .filter((beat) => beat.time >= start - TIME_EPSILON && beat.time < end - TIME_EPSILON)
    .map((beat) => Math.max(0, beat.time - start));
}

/**
 * Resolves a selected project range back to its unedited ANLZ timeline. The
 * result is deliberately omitted for a mixed/project-derived range, so a
 * reload never makes an unsupported native-origin claim.
 */
export function nativeSourceCoordinatesForRange(
  track: TrackModel,
  start: number,
  end: number
): Pick<ClipboardProvenance, 'analysisSource' | 'analysisSourceTrackId' | 'analysisSourceStart' | 'analysisSourceEnd'> {
  if (!track.analysisSource || !isNativeRekordboxWaveform(track.analysis)) return {};
  const segment = track.workingSegments
    .filter((candidate) => candidate.type !== 'OVERDUB' && candidate.type !== 'SILENCE')
    .find((candidate) => (
      candidate.projectStart <= start + TIME_EPSILON &&
      candidate.projectStart + candidate.projectDuration >= end - TIME_EPSILON
    ));
  if (!segment) return {};

  const nativeStart = segment.analysisSourceStart ?? segment.sourceStart;
  const nativeEnd = segment.analysisSourceEnd ?? segment.sourceEnd;
  const sourceScale = (nativeEnd - nativeStart) / Math.max(TIME_EPSILON, segment.projectDuration);
  return {
    analysisSource: segment.analysisSource || track.analysisSource,
    analysisSourceTrackId: segment.analysisSourceTrackId || track.id,
    analysisSourceStart: nativeStart + (start - segment.projectStart) * sourceScale,
    analysisSourceEnd: nativeStart + (end - segment.projectStart) * sourceScale,
  };
}

export function createEditContext(
  track: TrackModel,
  inserted?: {
    analysis?: ReturnType<typeof sliceWaveformAnalysis>;
    duration: number;
    beatOffsets?: number[];
    adaptedDuration?: number;
    analysisSource?: AnalysisFileReference;
    analysisSourceTrackId?: string;
    analysisSourceStart?: number;
    analysisSourceEnd?: number;
    clipId?: string;
  }
): EditCommandContext {
  const outputDuration = inserted?.adaptedDuration ?? inserted?.duration;
  const beatScale = inserted?.duration && outputDuration
    ? outputDuration / inserted.duration
    : 1;
  return {
    trackId: track.id,
    analysis: track.analysis,
    analysisSource: track.analysisSource,
    analysisSourceDuration: track.analysisSource?.sourceDuration,
    loops: track.loops,
    beatGrid: track.beatGrid,
    phrases: track.phrases,
    insertedAnalysis: inserted?.analysis,
    insertedAnalysisDuration: inserted?.duration,
    insertedBeatOffsets: inserted?.beatOffsets?.map((offset) => offset * beatScale),
    insertedAnalysisSource: inserted?.analysisSource,
    insertedAnalysisSourceTrackId: inserted?.analysisSourceTrackId,
    insertedAnalysisSourceStart: inserted?.analysisSourceStart,
    insertedAnalysisSourceEnd: inserted?.analysisSourceEnd,
    insertedClipId: inserted?.clipId,
  };
}

export const BUNDLED_REKORDBOX_XML_FILENAME = 'rekordbox_export2.xml';

export function buildCollectionTrackModel(
  pt: PartialTrackModel,
  idx: number,
  origin: DataOrigin
): TrackModel {
  const duration = pt.duration && !isNaN(pt.duration) ? pt.duration : 300.0;
  const bpm = pt.bpm && !isNaN(pt.bpm) ? pt.bpm : 130.0;
  const id = pt.id || `${origin === DataOrigin.REKORDBOX_DB ? 'rb-db' : 'rb-xml'}-${Date.now()}-${idx}`;
  return {
    id,
    title: pt.title || 'Untitled Track',
    artist: pt.artist || 'Unknown Artist',
    album: pt.album || 'Rekordbox Collection',
    genre: pt.genre,
    label: pt.label,
    rating: pt.rating,
    playCount: pt.playCount,
    year: pt.year,
    comments: pt.comments,
    dateAdded: pt.dateAdded,
    remixer: pt.remixer,
    isrc: pt.isrc,
    bpm,
    key: pt.key || '2A',
    duration,
    sampleRate: pt.sampleRate || 44100,
    channels: pt.channels || 2,
    originalSha256: pt.originalSha256 || `sha256-rb-${idx}`,
    isOriginalUntouched: true,
    audioBuffer: pt.audioBuffer || null,
    beatGrid: pt.beatGrid || buildBeatGridFromTempo(0.0, bpm, duration),
    cues: pt.cues || [],
    loops: pt.loops || [],
    analysis: pt.analysis || null,
    phrases: pt.phrases || [],
    rawXmlAttributes: pt.rawXmlAttributes,
    originalMedia: pt.originalMedia,
    analysisSource: pt.analysisSource,
    origin,
    workingSegments: [
      {
        id: `seg-${idx}`,
        type: 'ORIGINAL',
        trackId: id,
        sourceStart: 0,
        sourceEnd: duration,
        projectStart: 0,
        projectDuration: duration,
        gain: 1.0,
      },
    ],
  };
}

/**
 * Normalizes Rekordbox file:// URLs and Windows/POSIX paths for the strict
 * media-path-to-ANLZ provenance check used by the bundled collection.
 */
function normalizeMediaPathForComparison(value?: string): string {
  if (!value) return '';
  let normalized = value.trim();
  try {
    if (/^file:/i.test(normalized)) {
      const url = new URL(normalized);
      let path = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') {
        path = `//${url.hostname}${path}`;
      }
      normalized = path;
    }
  } catch {
    // A malformed URL cannot be a positive identity match; retain its text so
    // the caller will fail closed if it differs from the source path.
  }
  normalized = normalized.replace(/^\/([A-Za-z]:\/)/, '$1');
  return normalized.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

/**
 * Rekordbox schreibt in ANLZ-PPTH manchmal "?/Dateiname.mp3", wenn das Laufwerk
 * zum Analysezeitpunkt keinen Buchstaben hatte. Dann ist der Ordner-Prefix nicht
 * vertrauenswuerdig. Spiegelt isSameMediaPath() aus electron/masterDbGate.cjs.
 */
function isUnknownDriveMediaPath(value?: string): boolean {
  return typeof value === 'string' && /^\?[/\\]/.test(value.trim());
}

function mediaFileName(value?: string): string {
  if (!value) return '';
  return (value.replace(/\\/g, '/').split('/').pop() || '').toLowerCase();
}

export function areSameMediaPath(left?: string, right?: string): boolean {
  const normalizedLeft = normalizeMediaPathForComparison(left);
  const normalizedRight = normalizeMediaPathForComparison(right);
  if (normalizedLeft && normalizedRight && normalizedLeft === normalizedRight) return true;
  if (isUnknownDriveMediaPath(left) || isUnknownDriveMediaPath(right)) {
    const leftName = mediaFileName(left);
    const rightName = mediaFileName(right);
    return Boolean(leftName && rightName && leftName === rightName);
  }
  return false;
}

/** Decodes embedded base64 WAV bytes back into an AudioBuffer. */
export async function decodeWavBase64(audioCtx: AudioContext, base64?: string): Promise<AudioBuffer | undefined> {
  if (!base64) return undefined;
  const bytes = base64ToBytes(base64);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return audioCtx.decodeAudioData(ab);
}

/**
 * Rebuilds a persisted project track into a playable TrackModel. The original
 * audio is NOT duplicated here for Rekordbox-sourced tracks (it is re-opened
 * from its read-only path); embedded clip/original audio is decoded on demand.
 */
export async function rebuildTrackFromSerialized(
  st: SerializedTrack,
  audioCtx: AudioContext
): Promise<TrackModel> {
  const segments: EditSegment[] = [];
  for (const seg of st.workingSegments) {
    const clipBuffer = await decodeWavBase64(audioCtx, seg.clipWavBase64);
    segments.push({
      id: seg.id,
      type: seg.type,
      trackId: seg.trackId,
      sourceStart: seg.sourceStart,
      sourceEnd: seg.sourceEnd,
      projectStart: seg.projectStart,
      projectDuration: seg.projectDuration,
      clipId: seg.clipId,
      analysisSource: seg.analysisSource,
      analysisSourceTrackId: seg.analysisSourceTrackId,
      analysisSourceStart: seg.analysisSourceStart,
      analysisSourceEnd: seg.analysisSourceEnd,
      clipBuffer,
      gain: seg.gain,
    });
  }

  const embeddedOriginal = st.originalAudioBase64
    ? await decodeWavBase64(audioCtx, st.originalAudioBase64)
    : undefined;

  return {
    id: st.id,
    title: st.title,
    artist: st.artist,
    album: st.album,
    genre: st.genre,
    label: st.label,
    rating: st.rating,
    playCount: st.playCount,
    year: st.year,
    comments: st.comments,
    dateAdded: st.dateAdded,
    remixer: st.remixer,
    isrc: st.isrc,
    bpm: st.bpm,
    key: st.key,
    duration: st.duration,
    sampleRate: st.sampleRate,
    channels: st.channels,
    originalSha256: st.originalSha256,
    isOriginalUntouched: st.isOriginalUntouched,
    audioBuffer: embeddedOriginal ?? null,
    beatGrid: buildBeatGridFromTempo(
      st.beatGrid.firstBeat,
      st.beatGrid.bpm,
      st.duration,
      st.beatGrid.meter,
      st.origin
    ),
    cues: st.cues,
    loops: st.loops,
    analysis: null,
    origin: st.origin,
    phrases: st.phrases,
    rawXmlAttributes: st.rawXmlAttributes,
    originalMedia: st.originalMedia,
    analysisSource: st.analysisSource,
    workingSegments: segments,
  };
}
