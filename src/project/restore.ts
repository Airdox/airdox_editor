/**
 * @license
 * Project restore — turning a saved project document back into live state.
 *
 * Kept out of the component on purpose: these are the rules that decide whether a
 * re-opened project still describes the SAME material as before, and they must be
 * testable without a DOM:
 *
 *  - embedded base64 WAV audio is decoded on demand, a Rekordbox track's original
 *    is *re-opened read-only* instead of being duplicated,
 *  - beat nodes are adopted verbatim (a project never re-derives a grid that was
 *    imported from PQTZ),
 *  - a palette clip may only claim a source window when the project file says that
 *    window was verified (`sourceMapped === true`); everything else comes back as
 *    edit material. An old project that predates the flag therefore claims nothing.
 */

import type {
  EditSegment,
  OriginalMediaReference,
  PaletteClip,
  TrackModel,
} from '../types/rekordbox';
import {
  adoptSerializedGrid,
  ensureArrayBuffer,
} from '../rekordbox/trackGuards';
import {
  base64ToBytes,
  type SerializedPaletteClip,
  type SerializedTrack,
} from '../rekordbox/projectFile';
import { logger, type LogCategory } from '../utils/logger';

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
      clipBuffer,
      gain: seg.gain,
      ...(seg.sourceTrackId ? { sourceTrackId: seg.sourceTrackId } : {}),
      ...(seg.sourceClipStart !== undefined ? { sourceClipStart: seg.sourceClipStart } : {}),
      ...(seg.tempoRatio !== undefined ? { tempoRatio: seg.tempoRatio } : {}),
      ...(seg.pitchShift !== undefined ? { pitchShift: seg.pitchShift } : {}),
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
    // Verbatim adoption of persisted nodes (grid origin included); a uniform
    // rebuild happens only for projects saved before beat persistence.
    beatGrid: adoptSerializedGrid(st.beatGrid, st.duration, st.origin),
    cues: st.cues,
    loops: st.loops,
    analysis: null,
    origin: st.origin,
    phrases: st.phrases,
    rawXmlAttributes: st.rawXmlAttributes,
    originalMedia: st.originalMedia,
    workingSegments: segments,
  };
}

/**
 * The palette half of a restore. Strict by design: `sourceStart`/`sourceEnd` are
 * only trusted for the audible window, and the claim that they describe a position
 * INSIDE the original file is taken over only when the file says it was verified.
 */
export async function restorePaletteClips(
  clips: SerializedPaletteClip[],
  audioCtx: AudioContext
): Promise<PaletteClip[]> {
  const restored: PaletteClip[] = [];
  for (const clip of clips ?? []) {
    const audioBuffer = await decodeWavBase64(audioCtx, clip.clipWavBase64);
    restored.push({
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
      audioBuffer,
      miniPeaks: clip.miniPeaks,
      previewOrigin: clip.previewOrigin,
      previewNote: clip.previewNote,
      // Strenge Übernahme: nur ein explizit verifiziertes Fenster aus einem
      // Projekt dieser Version darf wieder als Quellfenster gelesen werden.
      sourceMapped: clip.sourceMapped === true,
      origin: clip.origin,
    });
  }
  return restored;
}

/**
 * Read-only re-open of a track's original audio through the desktop bridge.
 *
 * Used by both entry points that can face a missing file (project load and XML
 * collection selection), so the rule "no replacement audio is ever generated — the
 * track loads metadata-only and says what is missing" exists exactly once.
 */
export async function reopenTrackSourceAudio(
  source: { audioBuffer?: AudioBuffer | null; originalMedia?: OriginalMediaReference },
  audioCtx: AudioContext,
  log: { category: LogCategory; message: string }
): Promise<{ audioBuffer: AudioBuffer | null; originalMedia?: OriginalMediaReference }> {
  let audioBuffer = source.audioBuffer || null;
  let originalMedia = source.originalMedia;

  // Already in memory, or nothing re-openable on record: nothing to do.
  if (audioBuffer || !originalMedia?.location || !window.rekordboxDesktop) {
    return { audioBuffer, originalMedia };
  }

  try {
    const file = await window.rekordboxDesktop.readOriginalAudio(originalMedia.location);
    audioBuffer = await audioCtx.decodeAudioData(ensureArrayBuffer(file.data as ArrayBuffer | Uint8Array));
    originalMedia = {
      ...originalMedia,
      resolvedPath: file.path,
      size: file.size,
      modifiedAt: file.modifiedAt,
      status: 'AVAILABLE',
    };
  } catch (error) {
    logger.warn(log.category, log.message, {
      error: error instanceof Error ? error.message : String(error),
    });
    originalMedia = { ...originalMedia, status: 'MISSING' };
  }

  return { audioBuffer, originalMedia };
}
