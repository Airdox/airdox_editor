/**
 * @license
 * Edit model orchestration (pure — WebAudio only through injected factories).
 *
 * `projectTrackEdits` is the ONE place that answers "what follows from this
 * edit?": it takes the track's append-only edit list plus the pristine
 * (frozen) imported analysis and derives
 *
 *   - the project timeline (spans),
 *   - the working audio (rendered from those spans),
 *   - the projected waveform (verbatim ANLZ columns + only what must be computed),
 *   - the project duration and the provenance telemetry shown in the UI,
 *
 * so no view can show a state that contradicts the audio. Because it always
 * starts from the frozen base arrays, re-deriving after Undo/Redo or after
 * re-opening a project is idempotent — the imported Rekordbox data is never
 * degraded by looking like the previous composite.
 */

import {
  DataOrigin,
  EditSegment,
  PaletteClip,
  TrackModel,
  WaveformAnalysisData,
} from '../types/rekordbox';
import { nextEditId } from '../utils/ids';

/** Re-export: the edit domain owns the name, the counter lives in utils/ids. */
export { nextEditId };

import {
  ProjectedTimeline,
  TimelineSpan,
  projectEditTimeline,
} from './editTimeline';
import {
  ClipColumnSource,
  EditWaveformStats,
  RangeAnalyzer,
  buildEditWaveformVariants,
} from './editWaveform';
import { ChannelSource, ProjectedAudioResult, renderProjectedChannels } from './projectedAudio';

/** Minimal buffer factory contract; `AudioContext.createBuffer` satisfies it. */
export type BufferFactory = (numberOfChannels: number, length: number, sampleRate: number) => AudioBuffer;

export interface EditModelDeps {
  /** WebAudio buffer factory. Omit to derive model state only (unit tests). */
  createBuffer?: BufferFactory;
  analyzeRange?: RangeAnalyzer;
  /** Column duration of a computed-only deck (no ANLZ at all). */
  fallbackBucketSeconds?: number;
  /** Safety cap for composite columns (0 = uncapped). */
  maxColumns?: number;
}

export interface TrackProjection {
  /** Track copy with the derived project state applied. */
  track: TrackModel;
  timeline: ProjectedTimeline;
  /** Projected variants (empty when the deck is unedited: pristine rendering). */
  variants: WaveformAnalysisData[];
  stats: EditWaveformStats | null;
  /** Working audio for playback/export (only when `createBuffer` was provided). */
  workingBuffer: AudioBuffer | null;
  /** Raw channel data of the projection (tests, offline rendering). */
  channels: Float32Array[] | null;
  audioInfo: ProjectedAudioResult | null;
  /** True when nothing is edited and the pristine ANLZ rendering is used. */
  identity: boolean;
}

/**
 * Freezes the pristine analysis of a freshly loaded deck track. Idempotent: the
 * base arrays are only written once, so later edits (which replace
 * `analysis`/`analysisVariants` with composites) can never overwrite the source.
 */
export function withEditBase(track: TrackModel): TrackModel {
  const variants =
    track.analysisVariants && track.analysisVariants.length > 0
      ? track.analysisVariants
      : track.analysis
      ? [track.analysis]
      : [];
  const needsBase = track.baseAnalysis === undefined || track.baseAnalysisVariants === undefined;
  const needsDuration = track.sourceDuration === undefined || !(track.sourceDuration! > 0);
  if (!needsBase && !needsDuration) return track;
  return {
    ...track,
    // The frozen base spans the pristine media, NOT the possibly already
    // edited `duration`: that is what keeps column → time mapping exact.
    sourceDuration: needsDuration ? track.duration : track.sourceDuration,
    baseAnalysis: needsBase ? track.analysis ?? null : track.baseAnalysis,
    baseAnalysisVariants: needsBase ? variants : track.baseAnalysisVariants,
  };
}

/**
 * Drops the frozen base so the NEXT derivation re-freezes it. Required whenever
 * new analysis arrives for an already loaded deck (ANLZ assigned later, a merged
 * DAT/EXT extraction, a re-opened project): keeping the old base would project
 * the edit composite of the previous load instead of the fresh Rekordbox data.
 */
export function rebaseTrackAnalysis(track: TrackModel): TrackModel {
  return {
    ...track,
    sourceDuration: undefined,
    baseAnalysis: undefined,
    baseAnalysisVariants: undefined,
    editInfo: undefined,
  };
}

function baseVariantsOf(track: TrackModel | undefined): WaveformAnalysisData[] {
  if (!track) return [];
  const variants =
    track.baseAnalysisVariants && track.baseAnalysisVariants.length > 0
      ? track.baseAnalysisVariants
      : track.baseAnalysis
      ? [track.baseAnalysis]
      : track.analysisVariants && track.analysisVariants.length > 0
      ? track.analysisVariants
      : track.analysis
      ? [track.analysis]
      : [];
  // A composite is never a source for another composite (no degradation).
  return variants.filter((v) => v && !v.isEditComposite);
}

function channelsOf(buffer: ChannelSource | null): { left: Float32Array; right: Float32Array; sampleRate: number } | null {
  if (!buffer) return null;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  return { left, right, sampleRate: buffer.sampleRate };
}

function materialDurationOf(seg: EditSegment): number {
  const from = seg.sourceStart ?? 0;
  const buffer = seg.clipBuffer as unknown as ChannelSource | undefined;
  if (buffer && buffer.length > 0) {
    return Math.max(0, buffer.length / Math.max(1, buffer.sampleRate) - from);
  }
  return Math.max(0, (seg.sourceEnd ?? 0) - from);
}

/**
 * Derives the full project state of one track from its edit list.
 *
 * @param track   deck track (pristine base analysis already frozen)
 * @param clips   palette clips (clip → source-track provenance)
 * @param tracks  all loaded tracks (to resolve a clip's source analysis)
 */
/**
 * The single factory for an edit segment.
 *
 * Id and the fields derived from the same moment (source window, project window)
 * are produced in ONE step: `id` comes from `nextEditId()`, so it cannot disagree
 * with the rest of the object, and nothing here reads the wall clock. Every call
 * site — paste, drop, cut, clear — therefore produces an addressable segment,
 * which is what `segById` in the projection and Undo/Redo rely on.
 */
export interface SegmentInput {
  type: EditSegment['type'];
  trackId: string;
  projectStart: number;
  projectDuration: number;
  /** Start inside the deck's pristine source (0 for pure timeline operations). */
  sourceStart?: number;
  clipId?: string;
  clipBuffer?: AudioBuffer;
  sourceTrackId?: string;
  sourceClipStart?: number;
  tempoRatio?: number;
  pitchShift?: number;
  gain?: number;
}

export function createSegment(input: SegmentInput): EditSegment {
  const duration = input.projectDuration;
  const sourceStart = input.sourceStart ?? 0;
  return {
    id: nextEditId(),
    type: input.type,
    trackId: input.trackId,
    sourceStart,
    sourceEnd: sourceStart + duration,
    projectStart: input.projectStart,
    projectDuration: duration,
    clipId: input.clipId,
    clipBuffer: input.clipBuffer,
    gain: input.gain ?? 1.0,
    sourceTrackId: input.sourceTrackId,
    sourceClipStart: input.sourceClipStart,
    tempoRatio: input.tempoRatio ?? 1.0,
    pitchShift: input.pitchShift ?? 0,
  };
}

export function projectTrackEdits(
  track: TrackModel,
  clips: PaletteClip[],
  tracks: TrackModel[],
  deps: EditModelDeps = {}
): TrackProjection {
  const frozen = withEditBase(track);
  const sourceDuration = Math.max(0, frozen.sourceDuration ?? frozen.duration);
  const baseVariants = baseVariantsOf(frozen);
  const segments = frozen.workingSegments ?? [];

  const timeline = projectEditTimeline(
    { segments, sourceDuration },
    (seg) => ({ playDuration: materialDurationOf(seg) })
  );

  const byId = new Map<string, TrackModel>();
  for (const t of tracks) byId.set(t.id, t);
  byId.set(frozen.id, frozen);
  const clipById = new Map<string, PaletteClip>();
  for (const c of clips) clipById.set(c.id, c);
  const segById = new Map<string, EditSegment>();
  for (const s of segments) segById.set(s.id, s);

  const clipResolver = (span: TimelineSpan): ClipColumnSource | null => {
    const clip = span.clipId ? clipById.get(span.clipId) : undefined;
    const sourceTrack = span.sourceTrackId ? byId.get(span.sourceTrackId) : undefined;
    const sourceVariants = baseVariantsOf(sourceTrack);
    const seg = segById.get(span.segmentId);
    const play = (seg?.clipBuffer as unknown as ChannelSource | undefined) ?? null;
    if (sourceVariants.length === 0 && !play) return null;
    return {
      sourceVariants,
      sourceDuration: sourceTrack ? sourceTrack.sourceDuration ?? sourceTrack.duration : 0,
      playChannels: channelsOf(play),
    };
  };

  // Identity fast path: an unedited deck renders the imported ANLZ variant and
  // the original buffer directly — no composite arrays, no re-render. Every
  // later edit still derives from the same frozen base.
  if (timeline.isIdentity) {
    const variants =
      frozen.baseAnalysisVariants ?? (frozen.baseAnalysis ? [frozen.baseAnalysis] : []);
    const identityTrack: TrackModel = {
      ...frozen,
      duration: timeline.duration > 0 ? timeline.duration : frozen.duration,
      analysis: frozen.baseAnalysis ?? frozen.analysis,
      analysisVariants: variants.length > 0 ? variants : frozen.analysisVariants,
      editInfo: undefined,
    };
    return {
      track: identityTrack,
      timeline,
      variants: [],
      stats: null,
      workingBuffer: (identityTrack.audioBuffer as AudioBuffer | null) ?? null,
      channels: null,
      audioInfo: null,
      identity: true,
    };
  }

  const sampleRate = frozen.sampleRate > 0 ? frozen.sampleRate : 44100;
  const channelCount = Math.max(1, frozen.channels || (frozen.audioBuffer ? frozen.audioBuffer.numberOfChannels : 2));

  const waveform = buildEditWaveformVariants({
    timeline,
    baseVariants,
    baseSourceDuration: sourceDuration,
    clipResolver,
    analyzeRange: deps.analyzeRange,
    sampleRate,
    fallbackBucketSeconds: deps.fallbackBucketSeconds,
    maxColumns: deps.maxColumns ?? 0,
  });

  const audio = renderProjectedChannels({
    timeline,
    sampleRate,
    channels: channelCount,
    original: (frozen.audioBuffer as unknown as ChannelSource | null) ?? null,
    clipOf: (segmentId) => (segById.get(segmentId)?.clipBuffer as unknown as ChannelSource | undefined) ?? null,
  });

  let workingBuffer: AudioBuffer | null = null;
  if (deps.createBuffer) {
    workingBuffer = deps.createBuffer(channelCount, audio.length, sampleRate);
    for (let ch = 0; ch < channelCount; ch++) {
      workingBuffer.getChannelData(ch).set(audio.channelData[Math.min(ch, audio.channelData.length - 1)]);
    }
  }

  const identity = timeline.isIdentity;

  // The displayed variant: the projected twin of the track's preferred base
  // variant (same PWV tag), so color/mono rules keep applying; longest as a
  // last resort.
  const preferredTag = (frozen.baseAnalysis ?? frozen.analysis)?.sourceTag;
  const best =
    waveform.variants.find((v) => v.sourceTag === preferredTag) ??
    waveform.variants.reduce<WaveformAnalysisData | null>(
      (acc, v) => (!acc || v.length > acc.length ? v : acc),
      null
    );

  const nextTrack: TrackModel = {
    ...frozen,
    // Project duration follows the edit list; the media duration stays in
    // `sourceDuration` and is never touched.
    duration: timeline.duration > 0 ? timeline.duration : frozen.duration,
    analysis: identity ? frozen.baseAnalysis ?? frozen.analysis : best ?? frozen.analysis,
    analysisVariants: identity
      ? frozen.baseAnalysisVariants ?? (frozen.analysis ? [frozen.analysis] : [])
      : waveform.variants,
    editInfo: identity
      ? undefined
      : {
          spans: timeline.spans.length,
          structuralEdits: timeline.structuralEdits,
          overlays: timeline.overdubs.length,
          columns: waveform.stats.columns,
          verbatimColumns: waveform.stats.verbatimColumns,
          retimedColumns: waveform.stats.retimedColumns,
          clipColumns: waveform.stats.clipColumns,
          computedColumns: waveform.stats.computedColumns,
          mixColumns: waveform.stats.mixColumns,
          silenceColumns: waveform.stats.silenceColumns,
          missingColumns: waveform.stats.missingColumns,
          bucketSeconds: waveform.stats.bucketSeconds,
          isIdentity: false,
          sourceTags: waveform.stats.sourceTags,
        },
  };

  return {
    track: nextTrack,
    timeline,
    variants: waveform.variants,
    stats: identity ? null : waveform.stats,
    workingBuffer,
    channels: deps.createBuffer ? null : audio.channelData,
    audioInfo: audio,
    identity,
  };
}

/** Waveform origin shown in the header/status after an edit (never ambiguous). */
export function waveformOriginAfterEdit(projection: TrackProjection): DataOrigin {
  if (projection.identity) {
    return (
      projection.track.baseAnalysis?.origin ??
      projection.track.analysis?.origin ??
      projection.track.origin
    );
  }
  return DataOrigin.USER_EDIT;
}

/**
 * German status line for the waveform footer: exactly which columns are stored
 * data, which are computed, and which stay honestly empty.
 */
export function describeProjection(projection: TrackProjection): string {
  const { stats, timeline } = projection;
  if (projection.identity || !stats) {
    return `Unbearbeitet – Wellenform ${
      (projection.track.baseAnalysis ?? projection.track.analysis)?.sourceTag ?? 'ANLZ'
    } unverändert aus Rekordbox`;
  }
  const stored = stats.verbatimColumns + stats.retimedColumns + stats.clipColumns;
  const bits: string[] = [
    `${timeline.spans.length} Segmente`,
    `${timeline.structuralEdits} strukturelle Edit(s)${timeline.overdubs.length ? ` + ${timeline.overdubs.length} Overdub` : ''}`,
    `${stored} Spalten ANLZ übernommen (${stats.verbatimColumns} unverändert, ${stats.retimedColumns} neu eingesetzt${stats.clipColumns ? `, ${stats.clipColumns} aus Clip-Quelle` : ''})`,
  ];
  if (stats.computedColumns > 0) bits.push(`${stats.computedColumns} Spalten berechnet (USER_EDIT)`);
  if (stats.mixColumns > 0) bits.push(`${stats.mixColumns} Spalten Overdub-Mix`);
  if (stats.silenceColumns > 0) bits.push(`${stats.silenceColumns} Spalten Stille`);
  if (stats.missingColumns > 0) bits.push(`${stats.missingColumns} Spalten ohne Quelle (leer)`);
  bits.push(`Projekt ${timeline.duration.toFixed(3)}s / Original ${projection.track.sourceDuration?.toFixed(3) ?? '?'}s`);
  return bits.join(' • ');
}

/**
 * View model of the projected timeline: the blocks the deck draws under the
 * waveform (and drags) so an edit and its consequences are visible instead of
 * implied. Only material that differs from the pristine original is listed.
 */
export interface ProjectedSpanView {
  id: string;
  segmentId: string;
  clipId?: string;
  kind: 'clip' | 'silence';
  /** Seconds on the project timeline. */
  start: number;
  duration: number;
  label: string;
  color: string;
  /** Inserted clip spans may be dragged to a new position. */
  movable: boolean;
  /** Where the columns of this span come from (provenance, stated openly). */
  note: string;
}

const SPAN_COLORS: Record<string, string> = {
  clip: '#00a2ff',
  silence: '#4a4d5a',
};

export type PaletteClipIndex = Map<string, PaletteClip>;

export function toSpanViews(
  timeline: ProjectedTimeline,
  clips: PaletteClip[] | PaletteClipIndex
): ProjectedSpanView[] {
  const index = clips instanceof Map ? clips : new Map(clips.map((c) => [c.id, c]));
  const views: ProjectedSpanView[] = [];
  for (const span of timeline.spans) {
    if (span.kind === 'original') continue;
    const clip = span.clipId ? index.get(span.clipId) : undefined;
    const stretched = Math.abs(span.tempoRatio - 1) > 0.002;
    const pitch = span.pitchShift !== 0 ? `${span.pitchShift > 0 ? '+' : ''}${span.pitchShift} ST` : null;
    const notes: string[] = [];
    if (span.kind === 'silence') notes.push('stummgeschaltet');
    else notes.push(stretched ? `Tempo ${span.tempoRatio.toFixed(3)}×` : 'Tempo unverändert');
    if (pitch) notes.push(`Pitch ${pitch}`);
    notes.push(
      clip?.sourceTrackName ? `Quelle: ${clip.sourceTrackName}` : 'Quelle: Zwischenablage'
    );
    views.push({
      id: span.id,
      segmentId: span.segmentId,
      clipId: span.clipId,
      kind: span.kind,
      start: span.projectStart,
      duration: span.duration,
      label:
        span.kind === 'silence'
          ? 'CLEAR'
          : (clip?.name ?? 'CLIP').slice(0, 28),
      color: SPAN_COLORS[span.kind] ?? '#00a2ff',
      movable: span.kind === 'clip',
      note: notes.join(' • '),
    });
  }
  return views;
}
