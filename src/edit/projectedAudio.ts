/**
 * @license
 * Projected (edited) audio rendering — pure channel math.
 *
 * The edit list is the single source of truth: this module turns the projected
 * timeline (see ./editTimeline.ts) into the working AudioBuffer content. It is
 * deliberately free of WebAudio so the follow-up state of every edit (a real
 * insert that MOVES material instead of overwriting it, a delete that closes the
 * gap, a replace that pads short clips with silence, an overdub that mixes) is
 * unit-testable with plain Float32Arrays.
 *
 * It is also the counterpart of the waveform compositor: both consume the SAME
 * span list, which is what keeps picture and sound consistent after an edit.
 */

import { ProjectedTimeline, TimelineSpan, clipBufferTimeOf } from './editTimeline';

/** Minimal audio view used by the renderer (AudioBuffer satisfies it). */
export interface ChannelSource {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

export interface ProjectedAudioInput {
  timeline: ProjectedTimeline;
  /** Target format of the working buffer. */
  sampleRate: number;
  channels: number;
  /** Pristine deck audio; null when the original file is unreadable. */
  original: ChannelSource | null;
  /** Segment id → the clip audio that is actually played (already adapted). */
  clipOf: (segmentId: string, span: TimelineSpan) => ChannelSource | null;
}

export interface ProjectedAudioResult {
  channelData: Float32Array[];
  length: number;
  /** Spans that could not be filled because their audio is unavailable. */
  unresolvedSpans: number;
  /** Spans filled from the pristine original audio. */
  originalSpans: number;
  /** Spans filled from clip material. */
  clipSpans: number;
  /** Silence spans (Clear / padded replace). */
  silenceSpans: number;
  /** Overdub overlays mixed in. */
  overlaysMixed: number;
}

function copyRange(
  dest: Float32Array,
  destStart: number,
  src: Float32Array,
  srcSampleRate: number,
  srcStartSec: number,
  count: number,
  gain: number
): void {
  if (count <= 0) return;
  const spanSrc = src.length / Math.max(1, srcSampleRate);
  for (let i = 0; i < count; i++) {
    const outIdx = destStart + i;
    if (outIdx >= dest.length) break;
    const srcSec = srcStartSec + i / srcSampleRate;
    if (srcSec < 0 || srcSec >= spanSrc) {
      // Beyond the material: real silence, never wrapped-around audio.
      dest[outIdx] = 0;
      continue;
    }
    const sIdx = Math.min(src.length - 1, Math.floor(srcSec * srcSampleRate));
    const value = src[sIdx] * gain;
    dest[outIdx] = value;
  }
}

function mixRange(
  dest: Float32Array,
  destStart: number,
  src: Float32Array,
  srcSampleRate: number,
  srcStartSec: number,
  count: number,
  gain: number
): void {
  if (count <= 0) return;
  const spanSrc = src.length / Math.max(1, srcSampleRate);
  for (let i = 0; i < count; i++) {
    const outIdx = destStart + i;
    if (outIdx >= dest.length) break;
    const srcSec = srcStartSec + i / srcSampleRate;
    if (srcSec < 0 || srcSec >= spanSrc) continue;
    const sIdx = Math.min(src.length - 1, Math.floor(srcSec * srcSampleRate));
    // Same soft-clipped sum as the legacy segment renderer.
    dest[outIdx] = Math.tanh(dest[outIdx] + src[sIdx] * gain * 0.85);
  }
}

/** Renders the projected timeline into channel data (mutating nothing). */
export function renderProjectedChannels(input: ProjectedAudioInput): ProjectedAudioResult {
  const { timeline } = input;
  const sampleRate = input.sampleRate > 0 ? input.sampleRate : 44100;
  const channelCount = Math.max(1, input.channels || 1);
  const length = Math.max(1, Math.round(timeline.duration * sampleRate));
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch++) channelData.push(new Float32Array(length));

  const result: ProjectedAudioResult = {
    channelData,
    length,
    unresolvedSpans: 0,
    originalSpans: 0,
    clipSpans: 0,
    silenceSpans: 0,
    overlaysMixed: 0,
  };

  const spanSourceOf = (span: TimelineSpan): ChannelSource | null =>
    span.kind === 'original' ? input.original : input.clipOf(span.segmentId, span);

  for (const span of timeline.spans) {
    const destStart = Math.floor(span.projectStart * sampleRate);
    const count = Math.max(0, Math.round(span.duration * sampleRate));
    if (count <= 0) continue;

    if (span.kind === 'silence') {
      result.silenceSpans += 1;
      continue; // freshly allocated zeros are the honest representation of Clear
    }

    const source = spanSourceOf(span);
    if (!source) {
      result.unresolvedSpans += 1;
      continue;
    }

    if (span.kind === 'original') {
      const srcStart = span.sourceStart;
      for (let ch = 0; ch < channelCount; ch++) {
        copyRange(
          channelData[ch],
          destStart,
          source.getChannelData(Math.min(ch, source.numberOfChannels - 1)),
          source.sampleRate,
          srcStart,
          count,
          span.gain
        );
      }
      result.originalSpans += 1;
      continue;
    }

    const srcStart = clipBufferTimeOf(span, 0);
    for (let ch = 0; ch < channelCount; ch++) {
      copyRange(
        channelData[ch],
        destStart,
        source.getChannelData(Math.min(ch, source.numberOfChannels - 1)),
        source.sampleRate,
        srcStart,
        count,
        span.gain
      );
    }
    result.clipSpans += 1;
  }

  for (const od of timeline.overdubs) {
    const count = Math.max(0, Math.round(od.duration * sampleRate));
    if (count <= 0) continue;
    const source = input.clipOf(od.segmentId, {
      id: od.id,
      kind: 'clip',
      projectStart: od.projectStart,
      duration: od.duration,
      sourceStart: od.sourceStart,
      segmentId: od.segmentId,
      clipId: od.clipId,
      sourceTrackId: od.sourceTrackId,
      sourceClipStart: od.sourceClipStart,
      tempoRatio: od.tempoRatio,
      pitchShift: od.pitchShift,
      gain: od.gain,
    });
    if (!source) {
      result.unresolvedSpans += 1;
      continue;
    }
    const destStart = Math.floor(od.projectStart * sampleRate);
    for (let ch = 0; ch < channelCount; ch++) {
      mixRange(
        channelData[ch],
        destStart,
        source.getChannelData(Math.min(ch, source.numberOfChannels - 1)),
        source.sampleRate,
        od.sourceStart,
        count,
        od.gain
      );
    }
    result.overlaysMixed += 1;
  }

  return result;
}

/** True when the projection needs no rendering at all (project === original). */
export function timelineNeedsRender(timeline: ProjectedTimeline): boolean {
  return !timeline.isIdentity;
}
