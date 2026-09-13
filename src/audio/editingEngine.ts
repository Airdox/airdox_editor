/**
 * @license
 * Rekordbox Editing Engine
 * Pure, causal audio editing operations with sample-accurate buffer transformations,
 * mathematical Cue marker alignment, and real-time Waveform Analysis synchronization.
 */

import { CuePoint, EditSegment, SelectionRange, TrackModel, WaveformAnalysisData, DataOrigin } from '../types/rekordbox';
import { analyzeAudioBuffer } from '../waveform/analyzer';

export type BufferFactory = (channels: number, length: number, sampleRate: number) => AudioBuffer;

export interface EditExecutionResult {
  newBuffer: AudioBuffer;
  newCues: CuePoint[];
  newSegments: EditSegment[];
  newDuration: number;
  newAnalysis: WaveformAnalysisData;
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
}

/**
 * Standard buffer creation helper supporting both Browser Web Audio and Node/Mock environments.
 */
export function createAudioBuffer(
  channels: number,
  length: number,
  sampleRate: number,
  factory?: BufferFactory
): AudioBuffer {
  const safeLength = Math.max(1, Math.floor(length));
  if (factory) {
    return factory(channels, safeLength, sampleRate);
  }
  if (typeof window !== 'undefined' && (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)) {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const buf = ctx.createBuffer(channels, safeLength, sampleRate);
    if (ctx.state !== 'closed') {
      try { ctx.close(); } catch { /* ignore */ }
    }
    return buf;
  }
  // Node / headless fallback
  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    channelData.push(new Float32Array(safeLength));
  }
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

/**
 * Clones an AudioBuffer completely to ensure immutable history states.
 */
export function cloneAudioBuffer(source: AudioBuffer, factory?: BufferFactory): AudioBuffer {
  const cloned = createAudioBuffer(source.numberOfChannels, source.length, source.sampleRate, factory);
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    cloned.getChannelData(ch).set(source.getChannelData(ch));
  }
  return cloned;
}

/**
 * Slices a sub-region of an AudioBuffer.
 */
export function sliceAudioBuffer(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  factory?: BufferFactory
): AudioBuffer {
  const rate = buffer.sampleRate;
  const startSample = Math.max(0, Math.floor(startSec * rate));
  const endSample = Math.min(buffer.length, Math.floor(endSec * rate));
  const length = Math.max(1, endSample - startSample);
  const channels = buffer.numberOfChannels;

  const sliced = createAudioBuffer(channels, length, rate, factory);
  for (let ch = 0; ch < channels; ch++) {
    const src = buffer.getChannelData(ch);
    const dest = sliced.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      dest[i] = src[startSample + i];
    }
  }
  return sliced;
}

/**
 * Causal COPY:
 * Extracts audio from the selected range without modifying the source track.
 */
export function executeCopy(
  buffer: AudioBuffer,
  selection: SelectionRange,
  factory?: BufferFactory
): AudioBuffer {
  return sliceAudioBuffer(buffer, selection.start, selection.end, factory);
}

/**
 * Causal DELETE:
 * Removes audio in selection range. Subsequent audio moves left.
 * Cues inside selection are deleted. Cues after selection shift left by selection.duration.
 * Recalculates waveform analysis.
 */
export function executeDelete(
  buffer: AudioBuffer,
  selection: SelectionRange,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory
): EditExecutionResult {
  const rate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const startSample = Math.max(0, Math.floor(selection.start * rate));
  const endSample = Math.min(buffer.length, Math.floor(selection.end * rate));
  const delSamples = Math.max(0, endSample - startSample);
  const newLength = Math.max(1, buffer.length - delSamples);
  const delDuration = delSamples / rate;

  const newBuffer = createAudioBuffer(channels, newLength, rate, factory);

  for (let ch = 0; ch < channels; ch++) {
    const src = buffer.getChannelData(ch);
    const dest = newBuffer.getChannelData(ch);
    // Copy region before deletion
    dest.set(src.subarray(0, startSample), 0);
    // Copy region after deletion
    dest.set(src.subarray(endSample), startSample);
  }

  // Shift and filter cues
  const newCues = cues
    .filter((c) => c.position < selection.start || c.position > selection.end)
    .map((c) => {
      if (c.position > selection.end) {
        const shiftedPos = Math.max(0, c.position - delDuration);
        return {
          ...c,
          position: shiftedPos,
          inMsec: Math.round(shiftedPos * 1000),
        };
      }
      return { ...c };
    });

  // Track segment record
  const newSeg: EditSegment = {
    id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'CUT',
    trackId: segments[0]?.trackId || 'deck-a',
    sourceStart: selection.start,
    sourceEnd: selection.end,
    projectStart: selection.start,
    projectDuration: 0,
    gain: 0,
  };

  const newSegments = [...segments, newSeg];
  const newDuration = newBuffer.duration;
  const newAnalysis = analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT);

  return {
    newBuffer,
    newCues,
    newSegments,
    newDuration,
    newAnalysis,
  };
}

/**
 * Causal CUT:
 * Combines COPY and DELETE.
 */
export function executeCut(
  buffer: AudioBuffer,
  selection: SelectionRange,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory
): { clipboard: AudioBuffer; execution: EditExecutionResult } {
  const clipboard = executeCopy(buffer, selection, factory);
  const execution = executeDelete(buffer, selection, cues, segments, factory);
  return { clipboard, execution };
}

/**
 * Causal CLEAR (Silence/Mute):
 * Zeros out the selected range without altering duration or cue positions.
 * Recalculates waveform analysis so the silence shows in waveform display.
 */
export function executeClear(
  buffer: AudioBuffer,
  selection: SelectionRange,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory
): EditExecutionResult {
  const rate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const startSample = Math.max(0, Math.floor(selection.start * rate));
  const endSample = Math.min(buffer.length, Math.floor(selection.end * rate));

  const newBuffer = createAudioBuffer(channels, buffer.length, rate, factory);

  for (let ch = 0; ch < channels; ch++) {
    const src = buffer.getChannelData(ch);
    const dest = newBuffer.getChannelData(ch);
    dest.set(src, 0);
    for (let i = startSample; i < endSample; i++) {
      dest[i] = 0;
    }
  }

  // Cues remain identical in position
  const newCues = cues.map((c) => ({ ...c }));

  const newSeg: EditSegment = {
    id: `clear-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'CUT',
    trackId: segments[0]?.trackId || 'deck-a',
    sourceStart: selection.start,
    sourceEnd: selection.end,
    projectStart: selection.start,
    projectDuration: selection.duration,
    gain: 0,
  };

  const newSegments = [...segments, newSeg];
  const newDuration = newBuffer.duration;
  const newAnalysis = analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT);

  return {
    newBuffer,
    newCues,
    newSegments,
    newDuration,
    newAnalysis,
  };
}

/**
 * Causal INSERT:
 * Slices the buffer at insertTime and inserts insertBuffer.
 * Subsequent audio and cues move right by insertBuffer.duration.
 */
export function executeInsert(
  buffer: AudioBuffer,
  insertBuffer: AudioBuffer,
  insertTime: number,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory
): EditExecutionResult {
  const rate = buffer.sampleRate;
  const channels = Math.max(buffer.numberOfChannels, insertBuffer.numberOfChannels);
  const clampedInsertTime = Math.max(0, Math.min(buffer.duration, insertTime));
  const insertSample = Math.floor(clampedInsertTime * rate);
  const insertLen = insertBuffer.length;
  const newLength = buffer.length + insertLen;
  const shiftDuration = insertBuffer.duration;

  const newBuffer = createAudioBuffer(channels, newLength, rate, factory);

  for (let ch = 0; ch < channels; ch++) {
    const dest = newBuffer.getChannelData(ch);
    const src = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
    const ins = insertBuffer.getChannelData(Math.min(ch, insertBuffer.numberOfChannels - 1));

    // Part 1: before insert point
    dest.set(src.subarray(0, insertSample), 0);
    // Part 2: inserted content
    dest.set(ins, insertSample);
    // Part 3: after insert point
    dest.set(src.subarray(insertSample), insertSample + insertLen);
  }

  // Shift cues occurring at or after insert position
  const newCues = cues.map((c) => {
    if (c.position >= clampedInsertTime) {
      const shifted = c.position + shiftDuration;
      return {
        ...c,
        position: shifted,
        inMsec: Math.round(shifted * 1000),
      };
    }
    return { ...c };
  });

  const newSeg: EditSegment = {
    id: `insert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'INSERT',
    trackId: segments[0]?.trackId || 'deck-a',
    sourceStart: 0,
    sourceEnd: shiftDuration,
    projectStart: clampedInsertTime,
    projectDuration: shiftDuration,
    clipBuffer: insertBuffer,
    gain: 1.0,
  };

  const newSegments = [...segments, newSeg];
  const newDuration = newBuffer.duration;
  const newAnalysis = analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT);

  return {
    newBuffer,
    newCues,
    newSegments,
    newDuration,
    newAnalysis,
  };
}

/**
 * Causal PASTE:
 * - If selection is active: replaces selection with clipboard buffer (executeReplace).
 * - If no selection: inserts clipboard buffer at playhead (executeInsert).
 */
export function executePaste(
  buffer: AudioBuffer,
  clipboard: AudioBuffer,
  insertTime: number,
  selection: SelectionRange | null = null,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory
): EditExecutionResult {
  if (selection && selection.duration > 0) {
    return executeReplace(buffer, clipboard, selection, cues, segments, factory);
  }
  return executeInsert(buffer, clipboard, insertTime, cues, segments, factory);
}

/**
 * Causal REPLACE:
 * Replaces selected range with replaceBuffer.
 * If replaceBuffer duration differs from selection duration, the difference expands/contracts
 * subsequent audio and shifts subsequent cues accordingly.
 */
export function executeReplace(
  buffer: AudioBuffer,
  replaceBuffer: AudioBuffer,
  selection: SelectionRange,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  factory?: BufferFactory
): EditExecutionResult {
  const rate = buffer.sampleRate;
  const channels = Math.max(buffer.numberOfChannels, replaceBuffer.numberOfChannels);
  const startSample = Math.max(0, Math.floor(selection.start * rate));
  const endSample = Math.min(buffer.length, Math.floor(selection.end * rate));
  const replaceLen = replaceBuffer.length;
  const deltaLen = replaceLen - (endSample - startSample);
  const newLength = Math.max(1, buffer.length + deltaLen);
  const deltaSec = replaceBuffer.duration - selection.duration;

  const newBuffer = createAudioBuffer(channels, newLength, rate, factory);

  for (let ch = 0; ch < channels; ch++) {
    const dest = newBuffer.getChannelData(ch);
    const src = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
    const rep = replaceBuffer.getChannelData(Math.min(ch, replaceBuffer.numberOfChannels - 1));

    // 1. Prior audio
    dest.set(src.subarray(0, startSample), 0);
    // 2. Replacement audio
    dest.set(rep, startSample);
    // 3. Trailing audio
    dest.set(src.subarray(endSample), startSample + replaceLen);
  }

  // Remove cues inside replaced region, shift subsequent cues by deltaSec
  const newCues = cues
    .filter((c) => c.position < selection.start || c.position > selection.end)
    .map((c) => {
      if (c.position > selection.end) {
        const shifted = Math.max(0, c.position + deltaSec);
        return {
          ...c,
          position: shifted,
          inMsec: Math.round(shifted * 1000),
        };
      }
      return { ...c };
    });

  const newSeg: EditSegment = {
    id: `replace-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'REPLACE',
    trackId: segments[0]?.trackId || 'deck-a',
    sourceStart: 0,
    sourceEnd: replaceBuffer.duration,
    projectStart: selection.start,
    projectDuration: replaceBuffer.duration,
    clipBuffer: replaceBuffer,
    gain: 1.0,
  };

  const newSegments = [...segments, newSeg];
  const newDuration = newBuffer.duration;
  const newAnalysis = analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT);

  return {
    newBuffer,
    newCues,
    newSegments,
    newDuration,
    newAnalysis,
  };
}

/**
 * Causal OVERDUB:
 * Mixes clip audio into selected range using soft-limiting tanh saturation.
 * Duration and cues remain invariant.
 */
export function executeOverdub(
  buffer: AudioBuffer,
  overdubBuffer: AudioBuffer,
  selection: SelectionRange,
  cues: CuePoint[] = [],
  segments: EditSegment[] = [],
  gain: number = 0.85,
  factory?: BufferFactory
): EditExecutionResult {
  const rate = buffer.sampleRate;
  const channels = Math.max(buffer.numberOfChannels, overdubBuffer.numberOfChannels);
  const startSample = Math.max(0, Math.floor(selection.start * rate));
  const endSample = Math.min(buffer.length, Math.floor(selection.end * rate));
  const mixLen = Math.min(endSample - startSample, overdubBuffer.length);

  const newBuffer = createAudioBuffer(channels, buffer.length, rate, factory);

  for (let ch = 0; ch < channels; ch++) {
    const dest = newBuffer.getChannelData(ch);
    const src = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
    const ovd = overdubBuffer.getChannelData(Math.min(ch, overdubBuffer.numberOfChannels - 1));

    dest.set(src, 0);
    for (let i = 0; i < mixLen; i++) {
      const origSample = src[startSample + i];
      const ovdSample = ovd[i] * gain;
      dest[startSample + i] = Math.tanh(origSample + ovdSample);
    }
  }

  const newCues = cues.map((c) => ({ ...c }));

  const newSeg: EditSegment = {
    id: `overdub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'OVERDUB',
    trackId: segments[0]?.trackId || 'deck-a',
    sourceStart: 0,
    sourceEnd: selection.duration,
    projectStart: selection.start,
    projectDuration: selection.duration,
    clipBuffer: overdubBuffer,
    gain,
  };

  const newSegments = [...segments, newSeg];
  const newDuration = newBuffer.duration;
  const newAnalysis = analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT);

  return {
    newBuffer,
    newCues,
    newSegments,
    newDuration,
    newAnalysis,
  };
}

/**
 * Synchronizes TrackModel state with an execution result, ensuring
 * that duration, waveform analysis, workingSegments, and cues match
 * the exact causal output of the editing command.
 */
export function applyExecutionToTrack(
  track: TrackModel,
  result: EditExecutionResult
): void {
  track.duration = result.newDuration;
  track.cues = result.newCues;
  track.workingSegments = result.newSegments;
  track.analysis = result.newAnalysis;
}

/**
 * High-fidelity Causal History Stack Manager.
 * Preserves complete snapshots of audio, waveform, duration, cues, and selection.
 */
export class CausalHistoryManager {
  private undoStack: EditSnapshot[] = [];
  private redoStack: EditSnapshot[] = [];
  private maxDepth: number = 30;

  constructor(maxDepth: number = 30) {
    this.maxDepth = maxDepth;
  }

  public pushSnapshot(snapshot: EditSnapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
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
