/**
 * Rekordbox Editing Engine
 *
 * Pure, causal editing operations.  Audio is changed sample-accurately and
 * timeline metadata (cues, loops, beat grid, phrases and the persisted edit
 * decision list) follows the same transformation.  When an ANLZ waveform is
 * available, unchanged regions retain those original Rekordbox buckets.
 */

import {
  AnalysisFileReference,
  BeatGrid,
  BeatNode,
  CuePoint,
  DataOrigin,
  EditSegment,
  LoopPoint,
  PhraseSection,
  SelectionRange,
  TrackModel,
  WaveformAnalysisData,
} from '../types/rekordbox';
import { analyzeAudioBuffer } from '../waveform/analyzer';
import {
  composeMixedWaveform,
  composeWaveformAnalysis,
  getWaveformSecondsPerBucket,
  isNativeRekordboxWaveform,
} from '../waveform/analysisComposer';

export type BufferFactory = (channels: number, length: number, sampleRate: number) => AudioBuffer;

/** Extra source information used to retain native Rekordbox analysis on edits. */
export interface EditCommandContext {
  trackId?: string;
  /** Analysis that belongs to the current working buffer. */
  analysis?: WaveformAnalysisData | null;
  /** Read-only source backing the current track's native ANLZ analysis. */
  analysisSource?: AnalysisFileReference;
  /** Duration of that unedited native source timeline. */
  analysisSourceDuration?: number;
  loops?: LoopPoint[];
  beatGrid?: BeatGrid;
  phrases?: PhraseSection[];
  /** Optional waveform of the inserted/replacement clip. */
  insertedAnalysis?: WaveformAnalysisData | null;
  /** Duration represented by insertedAnalysis before tempo adaptation. */
  insertedAnalysisDuration?: number;
  /** Relative beat times in the inserted/replacement clip. */
  insertedBeatOffsets?: number[];
  /** Original ANLZ source coordinates when the inserted clip is native. */
  insertedAnalysisSource?: AnalysisFileReference;
  insertedAnalysisSourceTrackId?: string;
  insertedClipId?: string;
  insertedAnalysisSourceStart?: number;
  insertedAnalysisSourceEnd?: number;
}

export interface EditExecutionResult {
  newBuffer: AudioBuffer;
  newCues: CuePoint[];
  newSegments: EditSegment[];
  newDuration: number;
  newAnalysis: WaveformAnalysisData;
  newLoops?: LoopPoint[];
  newBeatGrid?: BeatGrid;
  newPhrases?: PhraseSection[];
}

export interface EditSnapshot {
  description: string;
  timestamp: number;
  buffer: AudioBuffer;
  cues: CuePoint[];
  segments: EditSegment[];
  duration: number;
  selection: SelectionRange | null;
  analysis: WaveformAnalysisData;
  loops?: LoopPoint[];
  beatGrid?: BeatGrid;
  phrases?: PhraseSection[];
}

interface SampleRange {
  startSample: number;
  endSample: number;
  start: number;
  end: number;
  duration: number;
}

const EPSILON = 1e-7;
// Floating-point values such as `16.15 * 1000` can become
// `16149.999999999998`. A tiny *sample* epsilon preserves an intended exact
// sample boundary without changing normal sub-sample floor semantics.
const SAMPLE_INDEX_EPSILON = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Converts a timeline position to its intended lower sample boundary safely. */
function timeToSampleFloor(seconds: number, sampleRate: number): number {
  return Math.floor(seconds * sampleRate + SAMPLE_INDEX_EPSILON);
}

function nearlyEqual(a: number, b: number, tolerance = EPSILON): boolean {
  return Math.abs(a - b) <= tolerance;
}

/**
 * Standard buffer creation helper supporting Browser Web Audio and Node/mock
 * environments.  The headless variant keeps the causality suite independent
 * from a browser AudioContext.
 */
export function createAudioBuffer(
  channels: number,
  length: number,
  sampleRate: number,
  factory?: BufferFactory
): AudioBuffer {
  const safeLength = Math.max(1, Math.floor(length));
  if (factory) return factory(channels, safeLength, sampleRate);

  if (
    typeof window !== 'undefined' &&
    (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
  ) {
    const AudioCtx = window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const buf = ctx.createBuffer(channels, safeLength, sampleRate);
    if (ctx.state !== 'closed') {
      try {
        ctx.close();
      } catch {
        // A short-lived helper context can already be closing in some browsers.
      }
    }
    return buf;
  }

  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) channelData.push(new Float32Array(safeLength));
  return {
    duration: safeLength / sampleRate,
    length: safeLength,
    numberOfChannels: channels,
    sampleRate,
    getChannelData: (c: number) => channelData[c] || new Float32Array(safeLength),
    copyFromChannel: (dest: Float32Array, channelNumber: number, startInChannel = 0) => {
      const src = channelData[channelNumber];
      if (src) dest.set(src.subarray(startInChannel, startInChannel + dest.length));
    },
    copyToChannel: (src: Float32Array, channelNumber: number, startInChannel = 0) => {
      const dest = channelData[channelNumber];
      if (dest) dest.set(src, startInChannel);
    },
  } as unknown as AudioBuffer;
}

/** Clones an AudioBuffer completely for immutable history states. */
export function cloneAudioBuffer(source: AudioBuffer, factory?: BufferFactory): AudioBuffer {
  const cloned = createAudioBuffer(source.numberOfChannels, source.length, source.sampleRate, factory);
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    cloned.getChannelData(ch).set(source.getChannelData(ch));
  }
  return cloned;
}

/**
 * Converts a source buffer to the destination sample rate.  Previous code
 * inserted `insertBuffer.length` directly into a destination with a different
 * rate, which changed the physical duration and could leave an apparent empty
 * bar range.  The conversion keeps elapsed time invariant.
 */
export function resampleAudioBufferToRate(
  source: AudioBuffer,
  targetSampleRate: number,
  factory?: BufferFactory
): AudioBuffer {
  if (source.sampleRate === targetSampleRate) return source;

  const targetLength = Math.max(1, Math.round(source.duration * targetSampleRate));
  const result = createAudioBuffer(source.numberOfChannels, targetLength, targetSampleRate, factory);
  const ratio = source.sampleRate / targetSampleRate;

  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    const input = source.getChannelData(channel);
    const output = result.getChannelData(channel);
    for (let i = 0; i < output.length; i++) {
      const position = i * ratio;
      const left = Math.floor(position);
      const right = Math.min(input.length - 1, left + 1);
      const fraction = position - left;
      output[i] = (input[left] || 0) * (1 - fraction) + (input[right] || 0) * fraction;
    }
  }
  return result;
}

function normalizedSelection(buffer: AudioBuffer, selection: SelectionRange): SampleRange {
  const rawStart = Math.min(selection.start, selection.end);
  const rawEnd = Math.max(selection.start, selection.end);
  const startSample = clamp(timeToSampleFloor(rawStart, buffer.sampleRate), 0, buffer.length);
  const endSample = clamp(timeToSampleFloor(rawEnd, buffer.sampleRate), startSample, buffer.length);
  return {
    startSample,
    endSample,
    start: startSample / buffer.sampleRate,
    end: endSample / buffer.sampleRate,
    duration: (endSample - startSample) / buffer.sampleRate,
  };
}

/** Slices a sub-region of an AudioBuffer. */
export function sliceAudioBuffer(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  factory?: BufferFactory
): AudioBuffer {
  const startSample = clamp(timeToSampleFloor(Math.min(startSec, endSec), buffer.sampleRate), 0, buffer.length);
  const endSample = clamp(timeToSampleFloor(Math.max(startSec, endSec), buffer.sampleRate), startSample, buffer.length);
  const length = Math.max(1, endSample - startSample);
  const sliced = createAudioBuffer(buffer.numberOfChannels, length, buffer.sampleRate, factory);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    sliced.getChannelData(ch).set(buffer.getChannelData(ch).subarray(startSample, startSample + length));
  }
  return sliced;
}

/** COPY extracts audio without mutating the source track. */
export function executeCopy(
  buffer: AudioBuffer,
  selection: SelectionRange,
  factory?: BufferFactory
): AudioBuffer {
  return sliceAudioBuffer(buffer, selection.start, selection.end, factory);
}

export interface SameSourceSlotRoundTripInput {
  targetBuffer: AudioBuffer;
  clipBuffer: AudioBuffer;
  targetTrackId: string;
  sourceTrackId: string;
  sourceStart: number;
  sourceEnd: number;
  selection: SelectionRange | null;
  insertTime: number;
  tempoRatio: number;
  semitonesShifted: number;
}

/**
 * Returns true only for a literal identity placement: the clip still matches
 * the currently selected samples byte-for-byte (within Float32 precision), is
 * from the same track/range, and did not need tempo or pitch adaptation. This
 * protects the intuitive "save four bars → place them back in the same slot"
 * workflow without suppressing a legitimate reinsert after that slot changed.
 */
export function isExactSameSourceSlotRoundTrip(input: SameSourceSlotRoundTripInput): boolean {
  const { targetBuffer, clipBuffer, selection } = input;
  if (!selection || input.sourceTrackId !== input.targetTrackId) return false;
  if (Math.abs(input.tempoRatio - 1) > 0.0001 || input.semitonesShifted !== 0) return false;
  const range = normalizedSelection(targetBuffer, selection);
  if (
    !nearlyEqual(input.sourceStart, range.start, 1 / targetBuffer.sampleRate + EPSILON) ||
    !nearlyEqual(input.sourceEnd, range.end, 1 / targetBuffer.sampleRate + EPSILON) ||
    !nearlyEqual(input.insertTime, range.start, 1 / targetBuffer.sampleRate + EPSILON) ||
    clipBuffer.sampleRate !== targetBuffer.sampleRate ||
    clipBuffer.numberOfChannels !== targetBuffer.numberOfChannels ||
    clipBuffer.length !== range.endSample - range.startSample
  ) {
    return false;
  }

  for (let channel = 0; channel < targetBuffer.numberOfChannels; channel++) {
    const source = targetBuffer.getChannelData(channel);
    const clip = clipBuffer.getChannelData(channel);
    for (let index = 0; index < clip.length; index++) {
      if (!nearlyEqual(source[range.startSample + index], clip[index], 1e-6)) return false;
    }
  }
  return true;
}

function withPosition<T extends CuePoint>(cue: T, position: number): T {
  return { ...cue, position, inMsec: Math.round(position * 1000) };
}

/** Uses a half-open edit range [start, end): a marker exactly at end survives. */
function deleteCues(cues: CuePoint[], range: SampleRange): CuePoint[] {
  return cues
    .filter((cue) => cue.position < range.start || cue.position >= range.end)
    .map((cue) => cue.position >= range.end
      ? withPosition(cue, Math.max(0, cue.position - range.duration))
      : { ...cue });
}

function insertCues(cues: CuePoint[], insertTime: number, duration: number): CuePoint[] {
  return cues.map((cue) => cue.position >= insertTime
    ? withPosition(cue, cue.position + duration)
    : { ...cue });
}

function cloneLoop(loop: LoopPoint, start = loop.start, end = loop.end): LoopPoint {
  return { ...loop, start, end, length: Math.max(0, end - start) };
}

function deleteLoops(loops: LoopPoint[], range: SampleRange): LoopPoint[] {
  return loops.flatMap((loop) => {
    const start = mapDeletePosition(loop.start, range);
    const end = mapDeletePosition(loop.end, range);
    return end - start > EPSILON ? [cloneLoop(loop, start, end)] : [];
  });
}

function mapDeletePosition(position: number, range: SampleRange): number {
  if (position < range.start) return position;
  if (position >= range.end) return Math.max(0, position - range.duration);
  return range.start;
}

function insertLoops(loops: LoopPoint[], insertTime: number, duration: number): LoopPoint[] {
  return loops.map((loop) => cloneLoop(
    loop,
    loop.start >= insertTime ? loop.start + duration : loop.start,
    loop.end >= insertTime ? loop.end + duration : loop.end
  ));
}

function mapDeletePhrase(phrase: PhraseSection, range: SampleRange): PhraseSection | null {
  const start = mapDeletePosition(phrase.startTime, range);
  const end = mapDeletePosition(phrase.endTime, range);
  return end - start > EPSILON ? { ...phrase, startTime: start, endTime: end } : null;
}

function deletePhrases(phrases: PhraseSection[], range: SampleRange): PhraseSection[] {
  return phrases.flatMap((phrase) => {
    const mapped = mapDeletePhrase(phrase, range);
    return mapped ? [mapped] : [];
  });
}

function insertPhrases(phrases: PhraseSection[], insertTime: number, duration: number): PhraseSection[] {
  return phrases.map((phrase) => {
    if (phrase.startTime >= insertTime) {
      return { ...phrase, startTime: phrase.startTime + duration, endTime: phrase.endTime + duration };
    }
    if (phrase.endTime > insertTime) {
      return { ...phrase, endTime: phrase.endTime + duration };
    }
    return { ...phrase };
  });
}

function normalizeBeatGrid(
  grid: BeatGrid,
  beats: BeatNode[],
  origin: DataOrigin = DataOrigin.PROJECT
): BeatGrid {
  const sorted = beats
    .filter((beat) => Number.isFinite(beat.time) && beat.time >= 0)
    .sort((a, b) => a.time - b.time)
    .filter((beat, index, list) => index === 0 || Math.abs(beat.time - list[index - 1].time) > EPSILON);

  let barNumber = 0;
  const normalized = sorted.map((beat, index) => {
    const meter = Math.max(1, grid.meter || 4);
    const beatInBar = clamp(Math.round(beat.beatInBar || ((index % meter) + 1)), 1, meter);
    const isBarStart = beat.isBarStart || beatInBar === 1;
    if (index === 0 || isBarStart) barNumber++;
    return {
      ...beat,
      index,
      beatInBar,
      isBarStart,
      barNumber,
    };
  });

  return {
    ...grid,
    firstBeat: normalized[0]?.time ?? grid.firstBeat,
    beats: normalized,
    origin,
  };
}

function deleteBeatGrid(grid: BeatGrid, range: SampleRange): BeatGrid {
  const beats = grid.beats
    .filter((beat) => beat.time < range.start || beat.time >= range.end)
    .map((beat) => beat.time >= range.end
      ? { ...beat, time: Math.max(0, beat.time - range.duration) }
      : { ...beat });
  return normalizeBeatGrid(grid, beats);
}

function generatedInsertedBeatNodes(
  grid: BeatGrid,
  insertTime: number,
  duration: number,
  offsets?: number[]
): BeatNode[] {
  const meter = Math.max(1, grid.meter || 4);
  const spb = 60 / Math.max(1, grid.bpm || 120);
  const targetBeat = Math.round((insertTime - grid.firstBeat) / spb);
  const relativeOffsets = offsets && offsets.length > 0
    ? offsets.filter((offset) => offset >= -EPSILON && offset < duration - EPSILON)
    : Array.from({ length: Math.max(0, Math.ceil(duration / spb)) }, (_, index) => index * spb)
      .filter((offset) => offset < duration - EPSILON);

  return relativeOffsets.map((offset, index) => {
    const beatIndex = targetBeat + index;
    const beatInBar = ((beatIndex % meter) + meter) % meter + 1;
    return {
      index: -1,
      time: insertTime + offset,
      beatInBar,
      isBarStart: beatInBar === 1,
      barNumber: 0,
    };
  });
}

function insertBeatGrid(
  grid: BeatGrid,
  insertTime: number,
  duration: number,
  offsets?: number[]
): BeatGrid {
  const shifted = grid.beats.map((beat) => beat.time >= insertTime
    ? { ...beat, time: beat.time + duration }
    : { ...beat });
  const added = generatedInsertedBeatNodes(grid, insertTime, duration, offsets);
  return normalizeBeatGrid(grid, [...shifted, ...added]);
}

function phraseBars(phrases: PhraseSection[], grid: BeatGrid): PhraseSection[] {
  const meter = Math.max(1, grid.meter || 4);
  const spb = 60 / Math.max(1, grid.bpm || 120);
  return phrases.map((phrase) => {
    const startBeat = Math.max(0, Math.round((phrase.startTime - grid.firstBeat) / spb));
    const endBeat = Math.max(startBeat, Math.round((phrase.endTime - grid.firstBeat) / spb));
    return {
      ...phrase,
      startBar: Math.floor(startBeat / meter) + 1,
      endBar: Math.floor(endBeat / meter) + 1,
    };
  });
}

function segmentEnd(segment: EditSegment): number {
  return segment.projectStart + Math.max(0, segment.projectDuration);
}

function segmentSourceSpan(segment: EditSegment): number {
  return Math.max(0, segment.sourceEnd - segment.sourceStart);
}

function cloneSegmentRange(
  segment: EditSegment,
  projectStart: number,
  projectEnd: number,
  projectShift = 0
): EditSegment | null {
  const originalDuration = segment.projectDuration;
  if (projectEnd - projectStart <= EPSILON || originalDuration <= EPSILON) return null;
  const localStart = clamp((projectStart - segment.projectStart) / originalDuration, 0, 1);
  const localEnd = clamp((projectEnd - segment.projectStart) / originalDuration, localStart, 1);
  const sourceSpan = segmentSourceSpan(segment);
  const analysisSourceStart = segment.analysisSourceStart;
  const analysisSourceEnd = segment.analysisSourceEnd;
  const analysisSourceSpan = analysisSourceStart !== undefined && analysisSourceEnd !== undefined
    ? Math.max(0, analysisSourceEnd - analysisSourceStart)
    : undefined;
  return {
    ...segment,
    sourceStart: segment.sourceStart + sourceSpan * localStart,
    sourceEnd: segment.sourceStart + sourceSpan * localEnd,
    ...(analysisSourceSpan !== undefined
      ? {
          analysisSourceStart: analysisSourceStart! + analysisSourceSpan * localStart,
          analysisSourceEnd: analysisSourceStart! + analysisSourceSpan * localEnd,
        }
      : {}),
    projectStart: projectStart + projectShift,
    projectDuration: projectEnd - projectStart,
  };
}

function defaultOriginalSegment(
  buffer: AudioBuffer,
  trackId: string,
  context?: EditCommandContext
): EditSegment {
  return {
    id: `original-${trackId}`,
    type: 'ORIGINAL',
    trackId,
    sourceStart: 0,
    sourceEnd: buffer.duration,
    projectStart: 0,
    projectDuration: buffer.duration,
    analysisSource: context?.analysisSource,
    analysisSourceTrackId: context?.trackId || trackId,
    analysisSourceStart: 0,
    analysisSourceEnd: context?.analysisSourceDuration ?? buffer.duration,
    gain: 1,
  };
}

function fallbackFlattenedSegment(buffer: AudioBuffer, trackId: string): EditSegment {
  return {
    id: `flattened-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'REPLACE',
    trackId,
    sourceStart: 0,
    sourceEnd: buffer.duration,
    projectStart: 0,
    projectDuration: buffer.duration,
    clipBuffer: cloneAudioBuffer(buffer),
    gain: 1,
  };
}

/**
 * New projects use a non-overlapping edit decision list.  A pre-existing
 * legacy list containing a full ORIGINAL segment plus overlaid INSERT/REPLACE
 * entries cannot be replayed causally.  Flatten it once rather than producing
 * holes or a duplicated silent tail on the next operation.
 */
function canonicalTimeline(
  segments: EditSegment[],
  currentBuffer: AudioBuffer,
  trackId: string,
  context?: EditCommandContext
): EditSegment[] {
  if (!segments || segments.length === 0) return [defaultOriginalSegment(currentBuffer, trackId, context)];
  const relevant = segments
    .filter((segment) => segment.projectDuration > EPSILON)
    .map((segment) => {
      // Older projects did not persist source coordinates. Enrich original
      // pieces on their next edit, but only when a real native source exists.
      if (
        (segment.type === 'ORIGINAL' || segment.type === 'CUT') &&
        !segment.analysisSource &&
        context?.analysisSource &&
        isNativeRekordboxWaveform(context.analysis)
      ) {
        return {
          ...segment,
          analysisSource: context.analysisSource,
          analysisSourceTrackId: context.trackId || trackId,
          analysisSourceStart: segment.sourceStart,
          analysisSourceEnd: segment.sourceEnd,
        };
      }
      return { ...segment };
    });
  if (relevant.length === 0) return [defaultOriginalSegment(currentBuffer, trackId, context)];

  const base = relevant
    .filter((segment) => segment.type !== 'OVERDUB')
    .slice()
    .sort((a, b) => a.projectStart - b.projectStart);
  let previousEnd = -EPSILON;
  let valid = base.length > 0;
  for (const segment of base) {
    if (segment.projectStart < -EPSILON || segmentEnd(segment) > currentBuffer.duration + 1 / currentBuffer.sampleRate + EPSILON) {
      valid = false;
      break;
    }
    if (segment.projectStart < previousEnd - EPSILON) {
      valid = false;
      break;
    }
    previousEnd = Math.max(previousEnd, segmentEnd(segment));
  }
  return valid ? relevant.map((segment) => ({ ...segment })) : [fallbackFlattenedSegment(currentBuffer, trackId)];
}

function deleteTimeline(segments: EditSegment[], range: SampleRange): EditSegment[] {
  const result: EditSegment[] = [];
  for (const segment of segments) {
    const start = segment.projectStart;
    const end = segmentEnd(segment);
    if (end <= range.start + EPSILON) {
      result.push({ ...segment });
      continue;
    }
    if (start >= range.end - EPSILON) {
      result.push({ ...segment, projectStart: start - range.duration });
      continue;
    }
    const before = cloneSegmentRange(segment, start, Math.min(end, range.start));
    const after = cloneSegmentRange(segment, Math.max(start, range.end), end, -range.duration);
    if (before) result.push(before);
    if (after) result.push(after);
  }
  return result;
}

function insertTimeline(
  segments: EditSegment[],
  insertTime: number,
  duration: number,
  insertion: EditSegment
): EditSegment[] {
  const result: EditSegment[] = [];
  for (const segment of segments) {
    const start = segment.projectStart;
    const end = segmentEnd(segment);
    if (end <= insertTime + EPSILON) {
      result.push({ ...segment });
      continue;
    }
    if (start >= insertTime - EPSILON) {
      result.push({ ...segment, projectStart: start + duration });
      continue;
    }
    const before = cloneSegmentRange(segment, start, insertTime);
    const after = cloneSegmentRange(segment, insertTime, end, duration);
    if (before) result.push(before);
    if (after) result.push(after);
  }
  // Rendering is order-sensitive only for OVERDUB.  The new base segment does
  // not overlap other base entries, so appending it keeps existing overlays
  // intact and makes the decision list straightforward to serialize.
  result.push(insertion);
  return result;
}

function operationAnalysis(
  newBuffer: AudioBuffer,
  baseDuration: number,
  context: EditCommandContext | undefined,
  operation: 'CLEAR' | 'INSERT' | 'DELETE' | 'REPLACE' | 'OVERDUB',
  regions: Parameters<typeof composeWaveformAnalysis>[0]['regions']
): WaveformAnalysisData {
  const base = context?.analysis;
  // A prior edit may have produced a mixed waveform. Its unchanged buckets
  // still contain exact ANLZ values, even though it must not be *labelled* as
  // fully native. Keep sampling those values through subsequent operations
  // instead of needlessly replacing the entire lane with a local analyser.
  const retainsNativeBuckets = Boolean(base?.provenance && base.provenance.nativeCoverage > EPSILON);
  if (!isNativeRekordboxWaveform(base) && !retainsNativeBuckets) {
    return analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT);
  }
  return composeWaveformAnalysis({
    duration: newBuffer.duration,
    preferredSecondsPerBucket: getWaveformSecondsPerBucket(base, Math.max(EPSILON, baseDuration)),
    operation,
    regions,
  });
}

function insertedAnalysisFor(
  insertBuffer: AudioBuffer,
  context?: EditCommandContext
): WaveformAnalysisData {
  return context?.insertedAnalysis || analyzeAudioBuffer(insertBuffer, DataOrigin.PROJECT);
}

function insertedSourceDuration(insertBuffer: AudioBuffer, context?: EditCommandContext): number {
  return context?.insertedAnalysisDuration && context.insertedAnalysisDuration > 0
    ? context.insertedAnalysisDuration
    : insertBuffer.duration;
}

/** Persists native source coordinates only when the supplied clip analysis is genuinely ANLZ-backed. */
function insertedNativeSourceFields(context?: EditCommandContext): Pick<
  EditSegment,
  'analysisSource' | 'analysisSourceTrackId' | 'analysisSourceStart' | 'analysisSourceEnd'
> {
  if (!isNativeRekordboxWaveform(context?.insertedAnalysis) || !context?.insertedAnalysisSource) return {};
  const sourceStart = Math.max(0, context.insertedAnalysisSourceStart || 0);
  const sourceEnd = Math.max(sourceStart, context.insertedAnalysisSourceEnd ?? (
    sourceStart + (context.insertedAnalysisDuration || 0)
  ));
  return {
    analysisSource: context.insertedAnalysisSource,
    analysisSourceTrackId: context.insertedAnalysisSourceTrackId,
    analysisSourceStart: sourceStart,
    analysisSourceEnd: sourceEnd,
  };
}

function baseContextSegments(
  buffer: AudioBuffer,
  segments: EditSegment[],
  context?: EditCommandContext
): { timeline: EditSegment[]; trackId: string } {
  const trackId = context?.trackId || segments[0]?.trackId || 'deck-a';
  return { timeline: canonicalTimeline(segments, buffer, trackId, context), trackId };
}

/**
 * Causal DELETE: removes [start,end), shifts subsequent media and all
 * time-bound metadata left by the exact number of deleted samples.
 */
export function executeDelete(
  buffer: AudioBuffer,
  selection: SelectionRange,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory,
  context?: EditCommandContext
): EditExecutionResult {
  const range = normalizedSelection(buffer, selection);
  const channels = buffer.numberOfChannels;
  const newLength = Math.max(1, buffer.length - (range.endSample - range.startSample));
  const newBuffer = createAudioBuffer(channels, newLength, buffer.sampleRate, factory);

  for (let channel = 0; channel < channels; channel++) {
    const source = buffer.getChannelData(channel);
    const destination = newBuffer.getChannelData(channel);
    destination.set(source.subarray(0, range.startSample), 0);
    destination.set(source.subarray(range.endSample), range.startSample);
  }

  const { timeline, trackId } = baseContextSegments(buffer, segments, context);
  const newSegments = deleteTimeline(timeline, range);
  const newCues = deleteCues(cues, range);
  const newLoops = context?.loops ? deleteLoops(context.loops, range) : undefined;
  const newBeatGrid = context?.beatGrid ? deleteBeatGrid(context.beatGrid, range) : undefined;
  const newPhrases = context?.phrases
    ? phraseBars(deletePhrases(context.phrases, range), newBeatGrid || context.beatGrid!)
    : undefined;
  const newAnalysis = operationAnalysis(newBuffer, buffer.duration, context, 'DELETE', [
    { outputStart: 0, outputEnd: range.start, analysis: context?.analysis, sourceDuration: buffer.duration, sourceStart: 0 },
    {
      outputStart: range.start,
      outputEnd: newBuffer.duration,
      analysis: context?.analysis,
      sourceDuration: buffer.duration,
      sourceStart: range.end,
    },
  ]);

  return {
    newBuffer,
    newCues,
    newSegments: newSegments.map((segment) => ({ ...segment, trackId: segment.trackId || trackId })),
    newDuration: newBuffer.duration,
    newAnalysis,
    newLoops,
    newBeatGrid,
    newPhrases,
  };
}

/** CUT combines COPY and DELETE while preserving the copied samples exactly. */
export function executeCut(
  buffer: AudioBuffer,
  selection: SelectionRange,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory,
  context?: EditCommandContext
): { clipboard: AudioBuffer; execution: EditExecutionResult } {
  const clipboard = executeCopy(buffer, selection, factory);
  const execution = executeDelete(buffer, selection, cues, segments, factory, context);
  return { clipboard, execution };
}

/** CLEAR turns the selected range into explicit silence without changing time. */
export function executeClear(
  buffer: AudioBuffer,
  selection: SelectionRange,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory,
  context?: EditCommandContext
): EditExecutionResult {
  const range = normalizedSelection(buffer, selection);
  const newBuffer = createAudioBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate, factory);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const source = buffer.getChannelData(channel);
    const destination = newBuffer.getChannelData(channel);
    destination.set(source);
    destination.fill(0, range.startSample, range.endSample);
  }

  const { timeline, trackId } = baseContextSegments(buffer, segments, context);
  const withoutRange = deleteTimeline(timeline, range);
  const silence: EditSegment = {
    id: `silence-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'SILENCE',
    trackId,
    sourceStart: 0,
    sourceEnd: 0,
    projectStart: range.start,
    projectDuration: range.duration,
    gain: 0,
  };
  const newSegments = insertTimeline(withoutRange, range.start, range.duration, silence);
  const newAnalysis = operationAnalysis(newBuffer, buffer.duration, context, 'CLEAR', [
    { outputStart: 0, outputEnd: range.start, analysis: context?.analysis, sourceDuration: buffer.duration, sourceStart: 0 },
    { outputStart: range.start, outputEnd: range.end, silence: true },
    { outputStart: range.end, outputEnd: newBuffer.duration, analysis: context?.analysis, sourceDuration: buffer.duration, sourceStart: range.end },
  ]);

  return {
    newBuffer,
    newCues: cues.map((cue) => ({ ...cue })),
    newSegments,
    newDuration: newBuffer.duration,
    newAnalysis,
    newLoops: context?.loops?.map((loop) => ({ ...loop })),
    newBeatGrid: context?.beatGrid ? { ...context.beatGrid, beats: context.beatGrid.beats.map((beat) => ({ ...beat })) } : undefined,
    newPhrases: context?.phrases?.map((phrase) => ({ ...phrase })),
  };
}

/** INSERT makes room at insertTime and places the complete clip into that gap. */
export function executeInsert(
  buffer: AudioBuffer,
  insertBuffer: AudioBuffer,
  insertTime: number,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory,
  context?: EditCommandContext
): EditExecutionResult {
  const rate = buffer.sampleRate;
  const preparedInsert = resampleAudioBufferToRate(insertBuffer, rate, factory);
  const channels = Math.max(buffer.numberOfChannels, preparedInsert.numberOfChannels);
  const clampedInsertTime = clamp(insertTime, 0, buffer.duration);
  const insertSample = clamp(timeToSampleFloor(clampedInsertTime, rate), 0, buffer.length);
  const actualInsertTime = insertSample / rate;
  const insertDuration = preparedInsert.duration;
  const newBuffer = createAudioBuffer(channels, buffer.length + preparedInsert.length, rate, factory);

  for (let channel = 0; channel < channels; channel++) {
    const destination = newBuffer.getChannelData(channel);
    const source = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
    const inserted = preparedInsert.getChannelData(Math.min(channel, preparedInsert.numberOfChannels - 1));
    destination.set(source.subarray(0, insertSample), 0);
    destination.set(inserted, insertSample);
    destination.set(source.subarray(insertSample), insertSample + preparedInsert.length);
  }

  const { timeline, trackId } = baseContextSegments(buffer, segments, context);
  const insertion: EditSegment = {
    id: `insert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'INSERT',
    trackId,
    sourceStart: 0,
    sourceEnd: preparedInsert.duration,
    projectStart: actualInsertTime,
    projectDuration: insertDuration,
    clipId: context?.insertedClipId,
    ...insertedNativeSourceFields(context),
    clipBuffer: preparedInsert,
    gain: 1,
  };
  const newSegments = insertTimeline(timeline, actualInsertTime, insertDuration, insertion);
  const newCues = insertCues(cues, actualInsertTime, insertDuration);
  const newLoops = context?.loops ? insertLoops(context.loops, actualInsertTime, insertDuration) : undefined;
  const newBeatGrid = context?.beatGrid
    ? insertBeatGrid(context.beatGrid, actualInsertTime, insertDuration, context.insertedBeatOffsets)
    : undefined;
  const newPhrases = context?.phrases
    ? phraseBars(insertPhrases(context.phrases, actualInsertTime, insertDuration), newBeatGrid || context.beatGrid!)
    : undefined;
  const clipAnalysis = insertedAnalysisFor(preparedInsert, context);
  const clipAnalysisDuration = insertedSourceDuration(insertBuffer, context);
  const newAnalysis = operationAnalysis(newBuffer, buffer.duration, context, 'INSERT', [
    { outputStart: 0, outputEnd: actualInsertTime, analysis: context?.analysis, sourceDuration: buffer.duration, sourceStart: 0 },
    {
      outputStart: actualInsertTime,
      outputEnd: actualInsertTime + insertDuration,
      analysis: clipAnalysis,
      sourceDuration: clipAnalysisDuration,
      sourceStart: 0,
      sourceTimeScale: clipAnalysisDuration / Math.max(EPSILON, insertDuration),
    },
    {
      outputStart: actualInsertTime + insertDuration,
      outputEnd: newBuffer.duration,
      analysis: context?.analysis,
      sourceDuration: buffer.duration,
      sourceStart: actualInsertTime,
    },
  ]);

  return {
    newBuffer,
    newCues,
    newSegments,
    newDuration: newBuffer.duration,
    newAnalysis,
    newLoops,
    newBeatGrid,
    newPhrases,
  };
}

/**
 * PASTE replaces an active selection, otherwise it behaves exactly like an
 * insertion at the playhead.  This makes a copied four-bar selection pasted
 * back into the same selected slot duration-preserving and sample-identical.
 */
export function executePaste(
  buffer: AudioBuffer,
  clipboard: AudioBuffer,
  insertTime: number,
  selection: SelectionRange | null = null,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory,
  context?: EditCommandContext
): EditExecutionResult {
  if (selection && selection.duration > 0) {
    return executeReplace(buffer, clipboard, selection, cues, segments, factory, context);
  }
  return executeInsert(buffer, clipboard, insertTime, cues, segments, factory, context);
}

/** REPLACE removes the selected range then inserts the replacement in its place. */
export function executeReplace(
  buffer: AudioBuffer,
  replaceBuffer: AudioBuffer,
  selection: SelectionRange,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory,
  context?: EditCommandContext
): EditExecutionResult {
  const range = normalizedSelection(buffer, selection);
  const preparedReplacement = resampleAudioBufferToRate(replaceBuffer, buffer.sampleRate, factory);
  const channels = Math.max(buffer.numberOfChannels, preparedReplacement.numberOfChannels);
  const replacementDuration = preparedReplacement.duration;
  const newLength = Math.max(1, buffer.length - (range.endSample - range.startSample) + preparedReplacement.length);
  const newBuffer = createAudioBuffer(channels, newLength, buffer.sampleRate, factory);

  for (let channel = 0; channel < channels; channel++) {
    const destination = newBuffer.getChannelData(channel);
    const source = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
    const replacement = preparedReplacement.getChannelData(Math.min(channel, preparedReplacement.numberOfChannels - 1));
    destination.set(source.subarray(0, range.startSample), 0);
    destination.set(replacement, range.startSample);
    destination.set(source.subarray(range.endSample), range.startSample + preparedReplacement.length);
  }

  const { timeline, trackId } = baseContextSegments(buffer, segments, context);
  const withoutRange = deleteTimeline(timeline, range);
  const replacement: EditSegment = {
    id: `replace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'REPLACE',
    trackId,
    sourceStart: 0,
    sourceEnd: preparedReplacement.duration,
    projectStart: range.start,
    projectDuration: replacementDuration,
    clipId: context?.insertedClipId,
    ...insertedNativeSourceFields(context),
    clipBuffer: preparedReplacement,
    gain: 1,
  };
  const newSegments = insertTimeline(withoutRange, range.start, replacementDuration, replacement);
  const afterDeleteCues = deleteCues(cues, range);
  const newCues = insertCues(afterDeleteCues, range.start, replacementDuration);
  const afterDeleteLoops = context?.loops ? deleteLoops(context.loops, range) : undefined;
  const newLoops = afterDeleteLoops ? insertLoops(afterDeleteLoops, range.start, replacementDuration) : undefined;
  const afterDeleteGrid = context?.beatGrid ? deleteBeatGrid(context.beatGrid, range) : undefined;
  const newBeatGrid = afterDeleteGrid
    ? insertBeatGrid(afterDeleteGrid, range.start, replacementDuration, context?.insertedBeatOffsets)
    : undefined;
  const afterDeletePhrases = context?.phrases ? deletePhrases(context.phrases, range) : undefined;
  const newPhrases = afterDeletePhrases
    ? phraseBars(insertPhrases(afterDeletePhrases, range.start, replacementDuration), newBeatGrid || context?.beatGrid!)
    : undefined;

  const clipAnalysis = insertedAnalysisFor(preparedReplacement, context);
  const clipAnalysisDuration = insertedSourceDuration(replaceBuffer, context);
  const shift = replacementDuration - range.duration;
  const newAnalysis = operationAnalysis(newBuffer, buffer.duration, context, 'REPLACE', [
    { outputStart: 0, outputEnd: range.start, analysis: context?.analysis, sourceDuration: buffer.duration, sourceStart: 0 },
    {
      outputStart: range.start,
      outputEnd: range.start + replacementDuration,
      analysis: clipAnalysis,
      sourceDuration: clipAnalysisDuration,
      sourceStart: 0,
      sourceTimeScale: clipAnalysisDuration / Math.max(EPSILON, replacementDuration),
    },
    {
      outputStart: range.start + replacementDuration,
      outputEnd: newBuffer.duration,
      analysis: context?.analysis,
      sourceDuration: buffer.duration,
      sourceStart: range.end,
    },
  ]);

  // `shift` is intentionally computed from sample-accurate durations.  Keeping
  // it here documents the causal relation and protects against future changes
  // that accidentally use SelectionRange.duration (which may be rounded).
  void shift;

  return {
    newBuffer,
    newCues,
    newSegments,
    newDuration: newBuffer.duration,
    newAnalysis,
    newLoops,
    newBeatGrid,
    newPhrases,
  };
}

/** OVERDUB mixes a clip into the selection while preserving timeline length. */
export function executeOverdub(
  buffer: AudioBuffer,
  overdubBuffer: AudioBuffer,
  selection: SelectionRange,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  gain = 0.85,
  factory?: BufferFactory,
  context?: EditCommandContext
): EditExecutionResult {
  const range = normalizedSelection(buffer, selection);
  const preparedOverdub = resampleAudioBufferToRate(overdubBuffer, buffer.sampleRate, factory);
  const channels = Math.max(buffer.numberOfChannels, preparedOverdub.numberOfChannels);
  const newBuffer = createAudioBuffer(channels, buffer.length, buffer.sampleRate, factory);
  const mixLength = Math.min(range.endSample - range.startSample, preparedOverdub.length);

  for (let channel = 0; channel < channels; channel++) {
    const source = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
    const overdub = preparedOverdub.getChannelData(Math.min(channel, preparedOverdub.numberOfChannels - 1));
    const destination = newBuffer.getChannelData(channel);
    destination.set(source);
    for (let index = 0; index < mixLength; index++) {
      destination[range.startSample + index] = Math.tanh(source[range.startSample + index] + overdub[index] * gain);
    }
  }

  const { timeline, trackId } = baseContextSegments(buffer, segments, context);
  const overdub: EditSegment = {
    id: `overdub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'OVERDUB',
    trackId,
    sourceStart: 0,
    // Only the part that actually fits inside the selected range is mixed.
    // Keeping the full clip duration here corrupts source coordinates when a
    // later delete/replace splits this overlay, causing EDL replay to read a
    // wrong slice of the overdub clip.
    sourceEnd: mixLength / buffer.sampleRate,
    projectStart: range.start,
    projectDuration: mixLength / buffer.sampleRate,
    clipBuffer: preparedOverdub,
    gain,
  };
  const newSegments = [...timeline, overdub];

  let newAnalysis: WaveformAnalysisData;
  if (isNativeRekordboxWaveform(context?.analysis)) {
    const locallyMixed = analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT);
    newAnalysis = composeMixedWaveform(
      context!.analysis!,
      buffer.duration,
      locallyMixed,
      range.start,
      range.start + mixLength / buffer.sampleRate,
      'OVERDUB'
    );
  } else {
    newAnalysis = analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT);
  }

  return {
    newBuffer,
    newCues: cues.map((cue) => ({ ...cue })),
    newSegments,
    newDuration: newBuffer.duration,
    newAnalysis,
    newLoops: context?.loops?.map((loop) => ({ ...loop })),
    newBeatGrid: context?.beatGrid ? { ...context.beatGrid, beats: context.beatGrid.beats.map((beat) => ({ ...beat })), origin: DataOrigin.PROJECT } : undefined,
    newPhrases: context?.phrases?.map((phrase) => ({ ...phrase })),
  };
}

/**
 * Renders the persisted edit decision list without an AudioContext.  The
 * desktop player delegates to this function as well, ensuring project reloads
 * cannot create a different (or silently padded) result than live editing.
 */
export function renderEditSegments(
  originalBuffer: AudioBuffer,
  segments: EditSegment[],
  factory?: BufferFactory
): AudioBuffer {
  if (!segments || segments.length === 0) return cloneAudioBuffer(originalBuffer, factory);

  const totalDuration = segments.reduce((maximum, segment) => Math.max(maximum, segmentEnd(segment)), 0);
  const outputRate = originalBuffer.sampleRate;
  // The edit list is authoritative.  Falling back to originalBuffer.duration
  // here would append the deleted tail as silence after a project reload.
  const totalSamples = Math.max(
    1,
    Math.round((totalDuration > EPSILON ? totalDuration : originalBuffer.duration) * outputRate)
  );
  const channels = Math.max(
    originalBuffer.numberOfChannels,
    ...segments.map((segment) => segment.clipBuffer?.numberOfChannels || 0)
  );
  const output = createAudioBuffer(channels, totalSamples, outputRate, factory);

  const readSourceSample = (
    source: AudioBuffer,
    sourceChannel: number,
    sourceStartSeconds: number,
    destinationSampleOffset: number
  ): number => {
    const sourceData = source.getChannelData(Math.min(sourceChannel, source.numberOfChannels - 1));
    const position = sourceStartSeconds * source.sampleRate + destinationSampleOffset * (source.sampleRate / outputRate);
    const left = Math.floor(position);
    if (left < 0 || left >= sourceData.length) return 0;
    const right = Math.min(sourceData.length - 1, left + 1);
    const fraction = position - left;
    return sourceData[left] * (1 - fraction) + sourceData[right] * fraction;
  };

  for (const segment of segments) {
    if (segment.projectDuration <= EPSILON || segment.type === 'SILENCE') continue;
    const destinationStart = clamp(Math.round(segment.projectStart * outputRate), 0, totalSamples);
    const destinationLength = Math.min(
      Math.round(segment.projectDuration * outputRate),
      totalSamples - destinationStart
    );
    if (destinationLength <= 0) continue;

    const isOriginal = segment.type === 'ORIGINAL' || segment.type === 'CUT';
    const source = isOriginal ? originalBuffer : segment.clipBuffer;
    if (!source) continue;
    const gain = segment.gain ?? 1;

    for (let channel = 0; channel < channels; channel++) {
      const destination = output.getChannelData(channel);
      for (let index = 0; index < destinationLength; index++) {
        const sample = readSourceSample(source, channel, segment.sourceStart, index) * gain;
        const target = destinationStart + index;
        if (segment.type === 'OVERDUB') {
          destination[target] = Math.tanh(destination[target] + sample);
        } else {
          destination[target] = sample;
        }
      }
    }
  }

  return output;
}

/** Synchronizes a TrackModel with every causal output field. */
export function applyExecutionToTrack(track: TrackModel, result: EditExecutionResult): void {
  track.duration = result.newDuration;
  track.cues = result.newCues;
  track.workingSegments = result.newSegments;
  track.analysis = result.newAnalysis;
  if (result.newLoops) track.loops = result.newLoops;
  if (result.newBeatGrid) track.beatGrid = result.newBeatGrid;
  if (result.newPhrases) track.phrases = result.newPhrases;
}

/** High-fidelity complete-state Undo/Redo stack. */
export class CausalHistoryManager {
  private undoStack: EditSnapshot[] = [];
  private redoStack: EditSnapshot[] = [];

  constructor(private maxDepth = 30) {}

  public pushSnapshot(snapshot: EditSnapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.maxDepth) this.undoStack.shift();
    this.redoStack = [];
  }

  public undo(currentSnapshot: EditSnapshot): EditSnapshot | null {
    if (this.undoStack.length === 0) return null;
    const target = this.undoStack.pop()!;
    this.redoStack.push(currentSnapshot);
    return target;
  }

  public redo(currentSnapshot: EditSnapshot): EditSnapshot | null {
    if (this.redoStack.length === 0) return null;
    const target = this.redoStack.pop()!;
    this.undoStack.push(currentSnapshot);
    return target;
  }

  public getUndoCount(): number {
    return this.undoStack.length;
  }

  public getRedoCount(): number {
    return this.redoStack.length;
  }

  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
