/**
 * @license
 * Rekordbox Project File (Phase 4) – versioned, non-destructive project persistence.
 *
 * A saved project is a plain, versioned JSON document (`.airdox.json`) that
 * captures the *editable* state of a session: project name, deck tracks with
 * their metadata, cues, loops, beatgrid anchor, edit segments, palette clips
 * and the current selection. Original Rekordbox sources are never embedded in
 * a way that could be written back – instead a project references the original
 * media by its read-only path and re-opens it on load. Only audio that cannot
 * be re-opened from a known source (e.g. a locally imported file without a
 * path, or inserted/replaced clip material) is embedded as base64 WAV.
 *
 * This module is pure and DOM/Electron-free so it can be exercised by the
 * Node-based test suite; the UI layer supplies the actual AudioBuffer objects
 * and the Electron bridge supplies the read/write operations.
 */

import {
  CuePoint,
  DataOrigin,
  EditSegment,
  LoopPoint,
  OriginalMediaReference,
  PaletteClip,
  PhraseSection,
  SelectionRange,
  TrackModel,
} from '../types/rekordbox';

export const PROJECT_FORMAT = 'airdox-project';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = '.airdox.json';

/** Minimal structural contract the WAV encoder needs; `AudioBuffer` satisfies it. */
interface AudioBufferLike {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** Chunked binary→base64 so large buffers never overflow the argument stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 → raw bytes (used when re-hydrating embedded clip/original audio). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encodes an AudioBuffer-like object as a standard 16-bit stereo PCM WAV and
 * returns it as a base64 string. Mirrors the export encoder in the audio
 * engine but stays free of browser-only APIs (no Blob).
 */
export function audioBufferToWavBase64(buffer: AudioBufferLike): string {
  const numChannels = 2;
  const sampleRate = buffer.sampleRate;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const numSamples = buffer.length;
  const dataSize = numSamples * blockAlign;

  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const sL = Math.max(-1, Math.min(1, left[i]));
    const sR = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, sL < 0 ? sL * 0x8000 : sL * 0x7fff, true);
    offset += 2;
    view.setInt16(offset, sR < 0 ? sR * 0x8000 : sR * 0x7fff, true);
    offset += 2;
  }

  return bytesToBase64(out);
}

// ---------------------------------------------------------------------------
// Serialized (persisted) shapes
// ---------------------------------------------------------------------------

export interface SerializedBeatNode {
  time: number;
  isBarStart: boolean;
  barNumber: number;
  beatInBar: number;
  bpm?: number;
  /** @deprecated Legacy project compatibility only. */
  tailExtended?: boolean;
}

export interface SerializedBeatGrid {
  firstBeat: number;
  bpm: number;
  meter: number;
  /**
   * Grid provenance (may differ from the track origin, e.g. an ANLZ grid on
   * an XML track). Absent in files saved before beat persistence existed.
   */
  origin?: DataOrigin;
  /**
   * Verbatim beat nodes. Absent in older files (uniform rebuild fallback) and
   * for tracks whose grid was never expanded beyond its scalars.
   */
  beats?: SerializedBeatNode[];
}

export interface SerializedSegment {
  id: string;
  type: EditSegment['type'];
  trackId: string;
  sourceStart: number;
  sourceEnd: number;
  projectStart: number;
  projectDuration: number;
  clipId?: string;
  gain: number;
  /** Inserted/replaced/overdubbed clip material, embedded as base64 WAV. */
  clipWavBase64?: string;
}

export interface SerializedTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre?: string;
  label?: string;
  rating?: number;
  playCount?: number;
  year?: string;
  comments?: string;
  dateAdded?: string;
  remixer?: string;
  isrc?: string;
  bpm: number;
  key: string;
  duration: number;
  sampleRate: number;
  channels: number;
  originalSha256: string;
  isOriginalUntouched: boolean;
  origin: DataOrigin;
  beatGrid: SerializedBeatGrid;
  cues: CuePoint[];
  loops: LoopPoint[];
  phrases?: PhraseSection[];
  rawXmlAttributes?: Record<string, string>;
  originalMedia?: OriginalMediaReference;
  workingSegments: SerializedSegment[];
  /** Original audio for tracks without a re-openable source path (local imports). */
  originalAudioBase64?: string;
}

export interface SerializedPaletteClip {
  id: string;
  name: string;
  sourceTrackId: string;
  sourceTrackName: string;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  beats: number;
  bars: number;
  bpm: number;
  key: string;
  color: string;
  miniPeaks?: number[];
  origin: DataOrigin;
  clipWavBase64?: string;
}

export interface SerializedProjectDocument {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: string;
  projectName: string;
  activeTrackId: string;
  selection: SelectionRange | null;
  tracks: SerializedTrack[];
  paletteClips: SerializedPaletteClip[];
}

/** In-memory snapshot handed to the serializer by the application state. */
export interface ProjectSnapshot {
  projectName: string;
  activeTrackId: string;
  selection: SelectionRange | null;
  tracks: TrackModel[];
  paletteClips: PaletteClip[];
}

function serializeSegment(segment: EditSegment): SerializedSegment {
  const out: SerializedSegment = {
    id: segment.id,
    type: segment.type,
    trackId: segment.trackId,
    sourceStart: segment.sourceStart,
    sourceEnd: segment.sourceEnd,
    projectStart: segment.projectStart,
    projectDuration: segment.projectDuration,
    clipId: segment.clipId,
    gain: segment.gain ?? 1.0,
  };
  if (segment.clipBuffer) {
    out.clipWavBase64 = audioBufferToWavBase64(segment.clipBuffer);
  }
  return out;
}

function serializeTrack(track: TrackModel): SerializedTrack {
  const out: SerializedTrack = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    label: track.label,
    rating: track.rating,
    playCount: track.playCount,
    year: track.year,
    comments: track.comments,
    dateAdded: track.dateAdded,
    remixer: track.remixer,
    isrc: track.isrc,
    bpm: track.bpm,
    key: track.key,
    duration: track.duration,
    sampleRate: track.sampleRate,
    channels: track.channels,
    originalSha256: track.originalSha256,
    isOriginalUntouched: track.isOriginalUntouched,
    origin: track.origin,
    beatGrid: {
      firstBeat: track.beatGrid?.firstBeat ?? 0.0,
      bpm: track.beatGrid?.bpm ?? track.bpm,
      meter: track.beatGrid?.meter ?? 4,
      // Verbatim persistence: PQTZ/USER_EDIT node times and the grid origin
      // must survive the save/load cycle (never a silent uniform rebuild).
      origin: track.beatGrid?.origin,
      beats: (track.beatGrid?.beats?.length ?? 0) > 0
        ? track.beatGrid.beats.map((node) => ({
            time: node.time,
            isBarStart: node.isBarStart,
            barNumber: node.barNumber,
            beatInBar: node.beatInBar,
            ...(node.bpm !== undefined ? { bpm: node.bpm } : {}),
            ...(node.tailExtended === true ? { tailExtended: true as const } : {}),
          }))
        : undefined,
    },
    cues: track.cues ?? [],
    loops: track.loops ?? [],
    phrases: track.phrases,
    rawXmlAttributes: track.rawXmlAttributes,
    originalMedia: track.originalMedia,
    workingSegments: (track.workingSegments ?? []).map(serializeSegment),
  };

  // A track whose original audio can't be re-opened from a source path (e.g. a
  // locally imported file) keeps its original audio embedded so the project
  // stays fully reconstructable. Rekordbox-sourced tracks reference their
  // read-only location instead and are never duplicated.
  const hasSourcePath = Boolean(track.originalMedia?.location);
  if (track.audioBuffer && !hasSourcePath) {
    out.originalAudioBase64 = audioBufferToWavBase64(track.audioBuffer);
  }

  return out;
}

function serializeClip(clip: PaletteClip): SerializedPaletteClip {
  const out: SerializedPaletteClip = {
    id: clip.id,
    name: clip.name,
    sourceTrackId: clip.sourceTrackId,
    sourceTrackName: clip.sourceTrackName,
    sourceStart: clip.sourceStart,
    sourceEnd: clip.sourceEnd,
    duration: clip.duration,
    beats: clip.beats,
    bars: clip.bars,
    bpm: clip.bpm,
    key: clip.key,
    color: clip.color,
    miniPeaks: clip.miniPeaks,
    origin: clip.origin,
  };
  if (clip.audioBuffer) {
    out.clipWavBase64 = audioBufferToWavBase64(clip.audioBuffer);
  }
  return out;
}

/**
 * Serializes a project snapshot to a versioned JSON string.
 */
export function serializeProject(snapshot: ProjectSnapshot): string {
  const doc: SerializedProjectDocument = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    projectName: snapshot.projectName,
    activeTrackId: snapshot.activeTrackId,
    selection: snapshot.selection ?? null,
    tracks: snapshot.tracks.map(serializeTrack),
    paletteClips: snapshot.paletteClips.map(serializeClip),
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Parses and validates a persisted project document. Throws with a clear
 * German message when the payload is not a supported Airdox project.
 */
export function deserializeProject(json: string): SerializedProjectDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Die Projektdatei ist kein gültiges JSON-Dokument.');
  }

  const doc = parsed as Partial<SerializedProjectDocument>;
  if (!doc || doc.format !== PROJECT_FORMAT) {
    throw new Error('Die Datei ist kein Airdox-Projekt (format-Feld fehlt oder ungültig).');
  }
  if (typeof doc.version !== 'number' || doc.version > PROJECT_VERSION) {
    throw new Error(
      `Die Projektdatei hat eine nicht unterstützte Version (${doc.version}). Diese App unterstützt Version ≤ ${PROJECT_VERSION}.`
    );
  }
  if (!Array.isArray(doc.tracks)) {
    throw new Error('Die Projektdatei enthält keine Track-Liste.');
  }

  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: typeof doc.savedAt === 'string' ? doc.savedAt : new Date().toISOString(),
    projectName: typeof doc.projectName === 'string' ? doc.projectName : 'New Project',
    activeTrackId: typeof doc.activeTrackId === 'string' ? doc.activeTrackId : '',
    selection: (doc.selection as SelectionRange | null | undefined) ?? null,
    tracks: doc.tracks as SerializedTrack[],
    paletteClips: (doc.paletteClips as SerializedPaletteClip[] | undefined) ?? [],
  };
}
