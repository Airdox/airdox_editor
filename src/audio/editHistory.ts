import type { EditHistoryEntry, EditSegment, SelectionRange, TrackModel, WaveformAnalysisData } from '../types/rekordbox';

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Captures small timeline metadata by value, but keeps the immutable working
 * AudioBuffer by reference. Every editor edit produces a new AudioBuffer, so
 * cloning the full PCM for every undo step is unnecessary and unboundedly costly.
 */
export function createEditHistoryEntry(
  track: TrackModel,
  selection: SelectionRange | null,
  workingAudioBuffer: AudioBuffer | null,
  description: string,
  timestamp = Date.now()
): EditHistoryEntry {
  return {
    trackId: track.id,
    description,
    timestamp,
    segments: cloneSerializable(track.workingSegments),
    selection: selection ? { ...selection } : null,
    cues: cloneSerializable(track.cues),
    audioBuffer: workingAudioBuffer ?? undefined,
    duration: track.duration,
    analysis: track.analysis ? { ...track.analysis } : undefined,
    loops: track.loops ? cloneSerializable(track.loops) : undefined,
    beatGrid: track.beatGrid ? cloneSerializable(track.beatGrid) : undefined,
    phrases: track.phrases ? cloneSerializable(track.phrases) : undefined,
  };
}

export interface EditHistoryRestoreRuntime {
  renderWorkingAudio: (source: AudioBuffer, segments: EditSegment[]) => AudioBuffer;
  analyzeAudioBuffer: (buffer: AudioBuffer) => WaveformAnalysisData;
}

/** Restore an undo/redo entry without mutating the live TrackModel. */
export function restoreEditHistoryEntry(
  track: TrackModel,
  entry: EditHistoryEntry,
  runtime: EditHistoryRestoreRuntime
): { track: TrackModel; audioBuffer?: AudioBuffer } {
  let restoredTrack: TrackModel = {
    ...track,
    workingSegments: entry.segments,
    cues: entry.cues,
    ...(entry.duration !== undefined ? { duration: entry.duration } : {}),
    ...(entry.analysis ? { analysis: entry.analysis } : {}),
    ...(entry.loops ? { loops: entry.loops } : {}),
    ...(entry.beatGrid ? { beatGrid: entry.beatGrid } : {}),
    ...(entry.phrases ? { phrases: entry.phrases } : {}),
  };
  let restoredBuffer: AudioBuffer | undefined;

  if (entry.audioBuffer) {
    restoredBuffer = entry.audioBuffer;
    if (!entry.analysis) {
      restoredTrack = { ...restoredTrack, analysis: runtime.analyzeAudioBuffer(entry.audioBuffer) };
    }
  } else if (track.audioBuffer) {
    restoredBuffer = runtime.renderWorkingAudio(track.audioBuffer, entry.segments);
    restoredTrack = {
      ...restoredTrack,
      duration: restoredBuffer.duration,
      analysis: runtime.analyzeAudioBuffer(restoredBuffer),
    };
  }

  return { track: restoredTrack, audioBuffer: restoredBuffer };
}
