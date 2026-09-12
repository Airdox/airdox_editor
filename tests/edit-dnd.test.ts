/**
 * @license
 * Drag & drop contract and drop consequences (Phase 6): the payload protocol,
 * the mode semantics, and what a drop does to the projected follow-up state.
 *
 * D1–D8  – payload round trips, foreign drags are never mistaken for internal ones,
 *          the live-preview fallback while `getData` is blocked, modifier semantics.
 * P1–P8  – the drop planner: insert shifts, replace/overdub keep the length,
 *          out-of-range drops are clamped, short clip material is padded.
 * E1–E4  – consequence of an actual drop through the real projection: cues move,
 *          the waveform of inserted clip material comes from stored ANLZ columns
 *          (no new analysis), overdub mixes columns, and removing the segment again
 *          restores the identity state.
 *
 * Run with: npx tsx tests/edit-dnd.test.ts
 */

import {
  DRAG_MIME_CLIP,
  DRAG_MIME_KIND,
  DRAG_MIME_SELECTION,
  DRAG_MIME_TRACK,
  beginDrag,
  dropEffectFor,
  endDrag,
  isFileDrag,
  isInternalDrag,
  readDragPayload,
  resolveDragPayload,
  structuralDropMode,
  writeDragPayload,
  type DataTransferLike,
} from '../src/dnd/dragPayload';
import { MIN_DROP_WINDOW, planClipDrop } from '../src/edit/editDrop';
import { projectTrackEdits, waveformOriginAfterEdit } from '../src/edit/editModel';
import { retimeCues } from '../src/edit/editTimeline';
import { ColumnSource } from '../src/edit/editWaveform';
import type { RangeAnalyzer } from '../src/edit/editWaveform';
import {
  DataOrigin,
  EditSegment,
  PaletteClip,
  TrackModel,
  WaveformAnalysisData,
} from '../src/types/rekordbox';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

function runTest(suite: string, name: string, testFn: () => void) {
  const t0 = performance.now();
  try {
    testFn();
    results.push({ suite, name, passed: true, durationMs: Math.round((performance.now() - t0) * 100) / 100 });
  } catch (err: any) {
    results.push({ suite, name, passed: false, error: err?.message || String(err), durationMs: 0 });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

function near(a: number, b: number, message: string, tol = 1e-6) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Assertion Failed: ${message} (got ${a}, want ${b})`);
}

// ── fake DataTransfer ───────────────────────────────────────────────────────

class FakeDataTransfer implements DataTransferLike {
  types: string[] = [];
  private store = new Map<string, string>();
  files?: ArrayLike<{ name?: string; type?: string }>;
  items?: ArrayLike<{ kind?: string; type?: string }>;
  dropEffect = 'none';
  effectAllowed = 'uninitialized';
  /** The browser hides payloads during dragover — modelled with this flag. */
  readingBlocked = false;

  getData(format: string): string {
    if (this.readingBlocked) return '';
    return this.store.get(format) ?? '';
  }
  setData(format: string, value: string): void {
    this.store.set(format, value);
    if (!this.types.includes(format)) this.types.push(format);
  }
}

// ── fixtures for the projection part ────────────────────────────────────────

const SR = 1000;
const COLUMNS = 100;
const SECONDS = 10;
const BUCKET = SECONDS / COLUMNS;

function indexedBuffer(seconds: number, scale = 1): AudioBuffer {
  const length = Math.round(seconds * SR);
  const data: Float32Array[] = [new Float32Array(length), new Float32Array(length)];
  for (let i = 0; i < length; i++) {
    data[0][i] = ((i % 97) / 97) * scale;
    data[1][i] = ((i % 89) / 89) * scale;
  }
  return {
    sampleRate: SR,
    numberOfChannels: 2,
    length,
    duration: length / SR,
    getChannelData: (ch: number) => data[Math.min(ch, 1)],
  } as unknown as AudioBuffer;
}

function emptyBufferFactory(channels: number, length: number, sampleRate: number): AudioBuffer {
  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) data.push(new Float32Array(length));
  return {
    sampleRate,
    numberOfChannels: channels,
    length,
    duration: length / sampleRate,
    getChannelData: (ch: number) => data[Math.min(ch, channels - 1)],
  } as unknown as AudioBuffer;
}

/**
 * ANLZ stand-in: every column value encodes its own index, so a copy can be
 * recognised by its value (1·index → unedited material, 2·index → clip source).
 */
function makeVariant(multiplier: number, tag: string): WaveformAnalysisData {
  const peaks = new Float32Array(COLUMNS);
  for (let i = 0; i < COLUMNS; i++) peaks[i] = multiplier * (i + 1);
  return {
    length: COLUMNS,
    peaks,
    peaksL: peaks,
    peaksR: peaks,
    lowEnergy: peaks,
    midEnergy: peaks,
    highEnergy: peaks,
    origin: DataOrigin.REKORDBOX_ANLZ,
    secPerBucket: BUCKET,
    sourceTag: tag,
  };
}

/** Recording range analyzer: every call is visible to the assertions below. */
const analysisCalls: Array<{ start: number; end: number }> = [];
const recordingAnalyzer: RangeAnalyzer = (_c, start, end, bucket) => {
  analysisCalls.push({ start, end });
  const n = Math.max(1, Math.ceil((end - start) / bucket - 1e-9));
  const v = new Float32Array(n).fill(0.9);
  return { peaks: v, peaksL: v, peaksR: v, lowEnergy: v, midEnergy: v, highEnergy: v };
};

function assertNoAnalysis(message: string) {
  if (analysisCalls.length > 0) {
    throw new Error(
      `Assertion Failed: ${message} (analysed ${analysisCalls
        .map((c) => `${c.start.toFixed(3)}–${c.end.toFixed(3)} s`)
        .join(', ')})`
    );
  }
}

function makeTrack(id: string, title: string, multiplier: number): TrackModel {
  const analysis = makeVariant(multiplier, 'PWV5');
  return {
    id,
    title,
    artist: 'Artist',
    album: 'Album',
    bpm: 120,
    key: '1A',
    duration: SECONDS,
    sourceDuration: SECONDS,
    sampleRate: SR,
    channels: 2,
    originalSha256: `sha256-${id}`,
    isOriginalUntouched: true,
    audioBuffer: indexedBuffer(SECONDS, multiplier),
    beatGrid: {
      firstBeat: 0,
      bpm: 120,
      meter: 4,
      beats: Array.from({ length: 40 }, (_v, i) => ({ time: i * 0.5, isDownbeat: i % 4 === 0 })),
      origin: DataOrigin.REKORDBOX_ANLZ,
    },
    cues: [
      { id: 'cue-before', label: 'IN', position: 2.0, type: 'MEMORY' as const },
      { id: 'cue-after', label: 'OUT', position: 7.0, type: 'MEMORY' as const },
    ],
    loops: [],
    analysis,
    analysisVariants: [analysis],
    baseAnalysis: analysis,
    baseAnalysisVariants: [analysis],
    origin: DataOrigin.REKORDBOX_ANLZ,
    workingSegments: [],
  } as unknown as TrackModel;
}

interface DropOutcome {
  track: TrackModel;
  clips: PaletteClip[];
  segments: EditSegment[];
}

/**
 * The same sequence the deck performs on a drop: plan → segment → retime markers →
 * re-derive audio, waveform and duration from the segment list.
 */
function performDrop(
  deck: TrackModel,
  clip: PaletteClip,
  sourceTrackId: string,
  mode: 'insert' | 'replace' | 'overdub',
  dropTime: number,
  windowEnd?: number
): DropOutcome {
  const timelineDuration = deck.workingSegments?.length
    ? deck.duration
    : deck.sourceDuration ?? deck.duration;
  const plan = planClipDrop({
    mode,
    dropTime,
    clipDuration: clip.duration,
    timelineDuration,
    windowEnd,
  });
  const segment: EditSegment = {
    id: `${plan.segmentType.toLowerCase()}-${deck.workingSegments?.length ?? 0}`,
    type: plan.segmentType,
    trackId: deck.id,
    sourceStart: clip.sourceStart,
    sourceEnd: clip.sourceEnd,
    projectStart: plan.projectStart,
    projectDuration: plan.projectDuration,
    clipId: clip.id,
    clipBuffer: clip.audioBuffer,
    gain: 1.0,
    sourceTrackId,
    sourceClipStart: clip.sourceStart,
    tempoRatio: 1.0,
    pitchShift: 0,
  };
  const segments = [...(deck.workingSegments ?? []), segment];
  const retimed = retimeCues(deck.cues, plan.delta ?? { mode: 'replace', start: 0, end: 0, delta: 0 });
  const track: TrackModel = {
    ...deck,
    workingSegments: segments,
    cues: retimed.cues,
  };
  const projection = projectTrackEdits(track, [clip], [track, makeSourceTrack(sourceTrackId)], {
    createBuffer: emptyBufferFactory,
    analyzeRange: recordingAnalyzer,
  });
  Object.assign(track, {
    duration: projection.track.duration,
    analysis: projection.track.analysis,
    analysisVariants: projection.track.analysisVariants,
  });
  return { track, clips: [clip], segments };
}

const sourceTrackCache = new Map<string, TrackModel>();
function makeSourceTrack(id: string): TrackModel {
  if (!sourceTrackCache.has(id)) sourceTrackCache.set(id, makeTrack(id, 'Clip Quelle', 2));
  return sourceTrackCache.get(id)!;
}

function makeClip(deckMultiplier = 2): { clip: PaletteClip; sourceTrackId: string } {
  const sourceTrackId = 'clip-source';
  const clip: PaletteClip = {
    id: 'clip-1',
    name: 'Drop Clip',
    sourceTrackId,
    sourceTrackName: 'Clip Quelle',
    sourceStart: 0,
    sourceEnd: 2,
    duration: 2,
    beats: 4,
    bars: 1,
    bpm: 120,
    key: '1A',
    color: '#00a2ff',
    audioBuffer: indexedBuffer(2, deckMultiplier),
    origin: DataOrigin.REKORDBOX_XML,
  };
  return { clip, sourceTrackId };
}

// ══════════════════════════════════════════════════════════════════════════
// D — payload protocol
// ══════════════════════════════════════════════════════════════════════════

runTest('DragPayload', 'D1: clip / track / selection payloads survive a round trip', () => {
  const clip = new FakeDataTransfer();
  writeDragPayload(clip, { kind: 'clip', clipId: 'clip-1', label: 'Drop Clip' });
  assert(clip.types.includes(DRAG_MIME_CLIP), 'clip MIME type must be advertised');
  const readClip = readDragPayload(clip);
  assert(readClip?.kind === 'clip', 'clip payload must be recognised');
  assert(readClip.kind === 'clip' && readClip.clipId === 'clip-1', 'clip id must survive');

  const track = new FakeDataTransfer();
  writeDragPayload(track, { kind: 'track', trackId: 'deck-2', label: 'Artist – Title' });
  const readTrack = readDragPayload(track);
  assert(readTrack?.kind === 'track', 'track payload must be recognised');
  assert(readTrack.kind === 'track' && readTrack.trackId === 'deck-2', 'track id must survive');
  assert(track.getData('text/plain').includes('Artist'), 'a readable text mirror must exist');

  const selection = new FakeDataTransfer();
  writeDragPayload(selection, { kind: 'selection', start: 1.5, end: 3.25 });
  const readSelection = readDragPayload(selection);
  assert(readSelection?.kind === 'selection', 'selection payload must be recognised');
  if (readSelection?.kind === 'selection') {
    near(readSelection.start, 1.5, 'selection start must survive');
    near(readSelection.end, 3.25, 'selection end must survive');
  }
});

runTest('DragPayload', 'D2: foreign and broken payloads read as null instead of throwing', () => {
  assert(readDragPayload(null) === null, 'a missing dataTransfer is not ours');
  const empty = new FakeDataTransfer();
  assert(readDragPayload(empty) === null, 'an empty drag is not ours');
  assert(readDragPayload({ types: [], getData: () => { throw new Error('nope'); }, setData: () => {} }) === null,
    'a dataTransfer that refuses getData must not break the drop target');

  const foreign = new FakeDataTransfer();
  foreign.setData('text/plain', 'some text from another app');
  assert(readDragPayload(foreign) === null, 'plain text alone is never an internal payload');

  const broken = new FakeDataTransfer();
  broken.setData(DRAG_MIME_SELECTION, '{not json');
  assert(readDragPayload(broken) === null, 'a malformed selection payload must be rejected');
});

runTest('DragPayload', 'D3: live preview works while the browser blocks getData (dragover)', () => {
  const dt = new FakeDataTransfer();
  const clip = makeClip();
  beginDrag(dt, { kind: 'clip', clipId: clip.clip.id, label: clip.clip.name });
  dt.readingBlocked = true; // what a real browser does during dragover
  assert(readDragPayload(dt) === null, 'readDragPayload alone cannot see the payload during dragover');
  const live = resolveDragPayload(dt);
  assert(live?.kind === 'clip', 'the in-flight gesture must be resolvable for the preview');
  assert(live?.kind === 'clip' && live.clipId === clip.clip.id, 'the live payload must carry the clip id');
  assert(isInternalDrag(), 'an internal drag must be detectable without reading data');
  endDrag();
  assert(!isInternalDrag(), 'the gesture must be cleared on dragend');
  assert(resolveDragPayload(dt) === null, 'after dragend nothing may remain "in flight"');
});

runTest('DragPayload', 'D4: file drags are recognised as imports, internal drags are not', () => {
  const files = new FakeDataTransfer();
  files.types = ['Files', 'text/plain'];
  files.files = [{ name: 'track.wav', type: 'audio/wav' }];
  assert(isFileDrag(files), 'a desktop file drag must be routed to the import path');

  const itemsOnly = new FakeDataTransfer();
  itemsOnly.items = [{ kind: 'file', type: 'text/uri-list' }];
  assert(isFileDrag(itemsOnly), 'items with kind=file are a file drag even without types');

  const internal = new FakeDataTransfer();
  writeDragPayload(internal, { kind: 'clip', clipId: 'clip-1' });
  assert(!isFileDrag(internal), 'an internal clip drag must never be mistaken for a file import');
  const internalTrack = new FakeDataTransfer();
  writeDragPayload(internalTrack, { kind: 'track', trackId: 't1' });
  assert(!isFileDrag(internalTrack), 'an internal track drag must never be mistaken for a file import');
  assert(!internalTrack.types.includes('Files'), 'internal drags must not advertise Files');
});

runTest('DragPayload', 'D5: modifiers decide insert vs replace vs overdub', () => {
  assert(structuralDropMode({}).mode === 'insert', 'a plain drop inserts');
  assert(structuralDropMode({ shiftKey: true }).mode === 'replace', 'Shift replaces');
  assert(structuralDropMode({ ctrlKey: true }).mode === 'replace', 'Ctrl replaces');
  assert(structuralDropMode({ metaKey: true }).mode === 'replace', 'Meta replaces');
  assert(structuralDropMode({ altKey: true }).mode === 'overdub', 'Alt overlays');
  assert(structuralDropMode({ altKey: true, shiftKey: true }).mode === 'overdub',
    'Alt wins over Shift: overdub is the more explicit intent');
  assert(structuralDropMode({ shiftKey: true }).label.length > 0, 'the mode needs a human readable label');
});

runTest('DragPayload', 'D6: cursor feedback matches the mode', () => {
  assert(dropEffectFor('insert') === 'copy', 'an insert copies material into the timeline');
  assert(dropEffectFor('replace') === 'move', 'a replace moves material into a window');
  assert(dropEffectFor('overdub') === 'link', 'an overdub links two sources together');
  assert(dropEffectFor('load') === 'copy', 'loading a track reads as a copy');
});

runTest('DragPayload', 'D7: kind marker lets a partially readable payload still be understood', () => {
  const dt = new FakeDataTransfer();
  dt.setData(DRAG_MIME_KIND, 'clip');
  dt.setData('text/plain', 'clip-9');
  const payload = readDragPayload(dt);
  assert(payload?.kind === 'clip' && payload.kind === 'clip' && payload.clipId === 'clip-9',
    'the text mirror must be usable when the typed entry is unavailable');
  const other = new FakeDataTransfer();
  other.setData(DRAG_MIME_KIND, 'track');
  other.setData('text/plain', 'C:\\Music\\Ghost.mp3');
  assert(readDragPayload(other)?.kind === 'track', 'track kind marker is honoured too');
  const unknown = new FakeDataTransfer();
  unknown.setData(DRAG_MIME_KIND, 'whatever');
  assert(readDragPayload(unknown) === null, 'an unknown kind stays unknown');
  assert(dt.types.includes(DRAG_MIME_KIND) && other.types.includes(DRAG_MIME_SELECTION) === false,
    'kind marker must be advertised for the fallback path');
});

runTest('DragPayload', 'D8: an unresolved clip id is a no-op, not a crash (drag ended elsewhere)', () => {
  const dt = new FakeDataTransfer();
  writeDragPayload(dt, { kind: 'clip', clipId: 'deleted-clip' });
  const payload = readDragPayload(dt);
  assert(payload?.kind === 'clip', 'the payload is still readable');
  const clips = new Map([['clip-1', {} as PaletteClip]]);
  const clip = payload?.kind === 'clip' ? clips.get(payload.clipId) : undefined;
  assert(clip === undefined, 'a clip that vanished from the palette resolves to nothing');
});

// ══════════════════════════════════════════════════════════════════════════
// P — drop planner
// ══════════════════════════════════════════════════════════════════════════

runTest('DropPlan', 'P1: an insert takes the clip length and shifts the tail', () => {
  const plan = planClipDrop({ mode: 'insert', dropTime: 5, clipDuration: 2, timelineDuration: 10 });
  assert(plan.segmentType === 'INSERT', 'insert drops create INSERT segments');
  near(plan.projectStart, 5, 'drop position is kept');
  near(plan.projectDuration, 2, 'the clip gets exactly its own length');
  assert(plan.window !== null && plan.window.start === 5 && plan.window.end === 7, 'window spans the clip');
  assert(plan.delta !== null && plan.delta.mode === 'insert' && plan.delta.delta === 2,
    'everything behind the window must shift by the clip length');
  assert(!plan.clamped && !plan.truncated, 'a drop inside the timeline needs no correction');
});

runTest('DropPlan', 'P2: a replace keeps the timeline length and truncates too long material', () => {
  const plan = planClipDrop({
    mode: 'replace',
    dropTime: 4,
    clipDuration: 5,
    timelineDuration: 10,
    windowEnd: 7,
  });
  assert(plan.segmentType === 'REPLACE', 'replace drops create REPLACE segments');
  near(plan.projectDuration, 3, 'the replaced window is what the drop addressed');
  assert(plan.delta !== null && plan.delta.delta === 0, 'a replace never changes the timeline length');
  assert(plan.truncated, 'a 5 s clip in a 3 s window is truncated — and says so');
  assert(plan.note.includes('abgeschnitten'), 'the note must state the truncation');
});

runTest('DropPlan', 'P3: an overdub never reports a length change', () => {
  const plan = planClipDrop({ mode: 'overdub', dropTime: 1, clipDuration: 2, timelineDuration: 10 });
  assert(plan.segmentType === 'OVERDUB', 'overdub drops create OVERDUB segments');
  assert(plan.delta === null, 'an overdub must not produce a structural delta');
  near(plan.projectDuration, 2, 'the mix window is the clip length by default');
});

runTest('DropPlan', 'P4: a drop past the end is clamped onto the timeline', () => {
  const plan = planClipDrop({ mode: 'insert', dropTime: 12.5, clipDuration: 2, timelineDuration: 10 });
  near(plan.projectStart, 10, 'a drop beyond the end lands at the end');
  assert(plan.clamped, 'the clamp must be visible to the caller');
  const replace = planClipDrop({ mode: 'replace', dropTime: 9.9, clipDuration: 4, timelineDuration: 10 });
  near(replace.projectStart, 9.9, 'a replace keeps its start');
  near(replace.projectDuration, 0.1, 'a replace only addresses the material that is actually there');
  assert(replace.truncated, 'the longer clip material is cut, not appended');
  assert(replace.window !== null && replace.window.end <= 10 + 1e-9, 'the window may not exceed the timeline');
  const atZero = planClipDrop({ mode: 'replace', dropTime: 0, clipDuration: 4, timelineDuration: 0 });
  near(atZero.projectDuration, MIN_DROP_WINDOW, 'an empty timeline still yields a valid minimum window');
});

runTest('DropPlan', 'P5: a short clip pads the window instead of shortening the track', () => {
  const plan = planClipDrop({ mode: 'replace', dropTime: 2, clipDuration: 1, timelineDuration: 10, windowEnd: 6 });
  near(plan.projectDuration, 4, 'the addressed window stays 4 s long');
  assert(!plan.truncated, 'a short clip is padded, not truncated');
  assert(plan.note.includes('Stille'), 'the note must promise silence padding');
});

runTest('DropPlan', 'P6: nonsense input degrades to a harmless minimum window', () => {
  const negative = planClipDrop({ mode: 'insert', dropTime: -3, clipDuration: 2, timelineDuration: 10 });
  near(negative.projectStart, 0, 'a negative drop position clamps to the start');
  const nan = planClipDrop({ mode: 'insert', dropTime: Number.NaN, clipDuration: 2, timelineDuration: 10 });
  near(nan.projectStart, 0, 'a NaN drop position must not corrupt the timeline');
  const noClip = planClipDrop({ mode: 'replace', dropTime: 3, clipDuration: 0, timelineDuration: 10 });
  near(noClip.projectDuration, MIN_DROP_WINDOW, 'an empty clip still yields a valid window');
  const emptyTimeline = planClipDrop({ mode: 'insert', dropTime: 0, clipDuration: 2, timelineDuration: 0 });
  near(emptyTimeline.projectStart, 0, 'a drop on an empty timeline starts at zero');
  near(emptyTimeline.projectDuration, 2, 'the inserted material still defines its own length');
});

runTest('DropPlan', 'P7: the insert window end follows the adapted clip length', () => {
  const plan = planClipDrop({ mode: 'insert', dropTime: 5, clipDuration: 2.5, timelineDuration: 10 });
  assert(plan.window !== null && plan.window.end === 7.5, 'window end = start + duration');
  near(plan.delta!.end, 7.5, 'the delta must use the same window as the segment');
});

runTest('DropPlan', 'P8: replace window defaults to the clip length when no range is given', () => {
  const plan = planClipDrop({ mode: 'replace', dropTime: 1, clipDuration: 3, timelineDuration: 10 });
  near(plan.projectDuration, 3, 'without an explicit range the clip replaces its own length');
  const overdub = planClipDrop({ mode: 'overdub', dropTime: 1, clipDuration: 3, timelineDuration: 10 });
  near(overdub.projectDuration, 3, 'the overdub window matches the clip length by default');
});

// ══════════════════════════════════════════════════════════════════════════
// E — the drop's follow-up state, through the real projection
// ══════════════════════════════════════════════════════════════════════════

runTest('DropConsequence', 'E1: an inserted clip reuses stored ANLZ columns and shifts the tail', () => {
  analysisCalls.length = 0;
  const deck = makeTrack('deck', 'Deck Track', 1);
  const { clip, sourceTrackId } = makeClip();
  const { track } = performDrop(deck, clip, sourceTrackId, 'insert', 5.0);

  const projection = projectTrackEdits(
    track,
    [clip],
    [track, makeSourceTrack(sourceTrackId)],
    { createBuffer: emptyBufferFactory, analyzeRange: recordingAnalyzer }
  );
  assertNoAnalysis('an inserted clip with a stored ANLZ ancestor must never be re-analysed');
  near(projection.timeline.duration, SECONDS + 2, 'the project grows by the clip length');
  assert(!projection.identity, 'an edited deck is no longer the identity state');
  const stats = projection.stats!;
  assert(stats.computedColumns === 0, 'a drop of analysed clip material must never compute columns');
  assert(stats.clipColumns === Math.round(2 / BUCKET), 'the clip window takes its columns from the source ANLZ');
  near(
    stats.verbatimColumns + stats.retimedColumns + stats.clipColumns,
    Math.round((SECONDS + 2) / BUCKET),
    'every column of the projected timeline is accounted for by stored data'
  );
  const peaks = projection.variants[0].peaks;
  near(peaks[Math.round(4.0 / BUCKET)], 1 * (Math.round(4.0 / BUCKET) + 1), 'material before the drop is untouched');
  near(peaks[Math.round(6.0 / BUCKET)], 2 * (Math.round(1.0 / BUCKET) + 1), 'the drop window shows the clip source columns');
  near(
    peaks[Math.round(8.0 / BUCKET)],
    1 * (Math.round(6.0 / BUCKET) + 1),
    'material after the drop keeps its original column value at its new place'
  );
  assert(
    projection.variants.some((v) => v.provenance && v.provenance[Math.round(6.0 / BUCKET)] === ColumnSource.CLIP_ANLZ),
    'the clip window must be labelled as clip ANLZ'
  );
  assert(
    projection.variants.some((v) => v.provenance && v.provenance[Math.round(8.0 / BUCKET)] === ColumnSource.ANLZ_RETIMED),
    'shifted original material must be labelled as re-timed ANLZ'
  );
  near(waveformOriginAfterEdit(projection) === DataOrigin.USER_EDIT ? 1 : 0, 1,
    'an edited composite is always labelled as a user edit');
});

runTest('DropConsequence', 'E2: cues follow the drop exactly like the audio', () => {
  analysisCalls.length = 0;
  const deck = makeTrack('deck', 'Deck Track', 1);
  const { clip, sourceTrackId } = makeClip();
  const { track } = performDrop(deck, clip, sourceTrackId, 'insert', 5.0);
  const before = track.cues.find((c) => c.id === 'cue-before')!;
  const after = track.cues.find((c) => c.id === 'cue-after')!;
  near(before.position, 2.0, 'a cue in front of the drop stays where it is');
  near(after.position, 9.0, 'a cue behind the drop moves by the clip length');

  const replaceTrack = makeTrack('deck2', 'Deck Track', 1);
  const { clip: clip2, sourceTrackId: src2 } = makeClip();
  const replaced = performDrop(replaceTrack, clip2, src2, 'replace', 5.0);
  near(
    replaced.track.cues.find((c) => c.id === 'cue-after')!.position,
    7.0,
    'a replace must not move markers behind the window'
  );
  near(replaced.track.duration, SECONDS, 'a replace keeps the timeline length');
  assertNoAnalysis('a replace of analysed material never needs own analysis');
});

runTest('DropConsequence', 'E3: an overdub drop mixes columns and leaves length and markers alone', () => {
  // A quiet original (0.01 per column) so the louder overlay wins the maximum.
  const deck = makeTrack('deck', 'Deck Track', 0.01);
  const { clip, sourceTrackId } = makeClip();
  analysisCalls.length = 0;
  const { track } = performDrop(deck, clip, sourceTrackId, 'overdub', 5.0);
  // A mix has no stored ancestor: only the OVERLAID window is read from the clip
  // audio (labelled MIX), never the untouched original material.
  const ranges = [...analysisCalls];
  const projection = projectTrackEdits(
    track,
    [clip],
    [track, makeSourceTrack(sourceTrackId)],
    { createBuffer: emptyBufferFactory, analyzeRange: recordingAnalyzer }
  );
  assert(ranges.length > 0, 'the overlaid window must be measured from the clip audio');
  for (const range of ranges) {
    assert(
      range.start >= clip.sourceStart - 1e-9 && range.end <= clip.sourceEnd + 1e-9,
      `analysis must stay inside the clip material (got ${range.start}–${range.end})`
    );
  }
  near(projection.timeline.duration, SECONDS, 'an overdub never changes the project length');
  const peaks = projection.variants[0].peaks;
  const mixedIdx = Math.round(5.5 / BUCKET);
  const own = 0.01 * (mixedIdx + 1);
  const overlay = Math.min(1, 0.9 * 0.85);
  near(peaks[mixedIdx], Math.max(own, overlay), 'a mixed column takes the louder of both sources');
  assert(peaks[mixedIdx] > own, 'the overlay must actually be visible in the mix');
  const loudIdx = COLUMNS - 1;
  near(peaks[loudIdx], Math.max(0.01 * (loudIdx + 1), 0.0), 'a column outside the mix window stays untouched');
  assert(
    projection.variants.some((v) => v.provenance && v.provenance[Math.round(5.5 / BUCKET)] === ColumnSource.MIX),
    'mixed columns must be labelled as a mix, not as ANLZ'
  );
  assert(projection.stats!.mixColumns > 0, 'the mix must be counted as MIX, not silently folded in');
  assert(projection.stats!.computedColumns === 0, 'the underlying original needs no new analysis');
  assert(projection.variants[0].provenance![loudIdx] !== ColumnSource.MIX,
    'only the overlaid window may be marked as a mix');
});

runTest('DropConsequence', 'E4: dropping a clip without ANLZ provenance computes — and labels — its columns', () => {
  const deck = makeTrack('deck', 'Deck Track', 1);
  const bare: PaletteClip = {
    id: 'clip-bare',
    name: 'Clipboard',
    sourceTrackId: 'unknown',
    sourceTrackName: 'Zwischenablage',
    sourceStart: 0,
    sourceEnd: 2,
    duration: 2,
    beats: 4,
    bars: 1,
    bpm: 120,
    key: '1A',
    color: '#00a2ff',
    audioBuffer: indexedBuffer(2, 3),
    origin: DataOrigin.USER_EDIT,
  };
  const plan = planClipDrop({ mode: 'insert', dropTime: 5, clipDuration: bare.duration, timelineDuration: SECONDS });
  const segment: EditSegment = {
    id: 'insert-bare',
    type: plan.segmentType,
    trackId: deck.id,
    sourceStart: 0,
    sourceEnd: 2,
    projectStart: plan.projectStart,
    projectDuration: plan.projectDuration,
    clipId: bare.id,
    clipBuffer: bare.audioBuffer,
    gain: 1.0,
    tempoRatio: 1.0,
    pitchShift: 0,
  };
  const track: TrackModel = { ...deck, workingSegments: [segment] };
  let computed = 0;
  const analyzer: RangeAnalyzer = (_c, _s, _e, bucket) => {
    computed += 1;
    const n = Math.max(1, Math.ceil(2 / bucket - 1e-9));
    const v = new Float32Array(n).fill(0.5);
    return { peaks: v, peaksL: v, peaksR: v, lowEnergy: v, midEnergy: v, highEnergy: v };
  };
  const projection = projectTrackEdits(track, [bare], [track], {
    createBuffer: emptyBufferFactory,
    analyzeRange: analyzer,
  });
  assert(computed > 0, 'material without a stored source must be analysed once');
  assert(projection.stats!.computedColumns === Math.round(2 / BUCKET), 'exactly the clip window is computed');
  assert(
    projection.variants.some((v) => v.provenance && v.provenance[Math.round(6.0 / BUCKET)] === ColumnSource.COMPUTED),
    'computed columns must be labelled COMPUTED'
  );
  near(
    projection.stats!.verbatimColumns + projection.stats!.retimedColumns,
    Math.round(SECONDS / BUCKET),
    'the untouched original keeps its stored columns'
  );
});

runTest('DropConsequence', 'E5: removing the dropped segment restores the untouched state', () => {
  analysisCalls.length = 0;
  const deck = makeTrack('deck', 'Deck Track', 1);
  const { clip, sourceTrackId } = makeClip();
  const { track, segments } = performDrop(deck, clip, sourceTrackId, 'insert', 5.0);
  assert(segments.length === 1, 'the drop added exactly one segment');
  assertNoAnalysis('the drop itself must not have re-analysed stored material');
  const restored: TrackModel = { ...track, workingSegments: [], cues: deck.cues };
  const projection = projectTrackEdits(restored, [clip], [restored, makeSourceTrack(sourceTrackId)], {
    createBuffer: emptyBufferFactory,
    analyzeRange: recordingAnalyzer,
  });
  assert(projection.identity, 'undoing the drop must return to the identity projection');
  near(projection.timeline.duration, SECONDS, 'the project length returns to the original');
  near(projection.variants.length, 0, 'the identity state renders the pristine ANLZ variant, not a composite');
  near(restored.cues.find((c) => c.id === 'cue-after')!.position, 7.0, 'markers return to their positions');
});

// ── summary ─────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;
console.log('\n' + '═'.repeat(78));
console.log('  TEST SUMMARY — Drag & Drop protocol, drop planner and drop consequences');
console.log('═'.repeat(78));
const bySuite: Record<string, TestResult[]> = {};
for (const r of results) (bySuite[r.suite] ??= []).push(r);
for (const [suite, list] of Object.entries(bySuite)) {
  console.log(`\n  [${suite}]`);
  for (const r of list) {
    const mark = r.passed ? '✓' : '✗';
    console.log(
      `    ${r.passed ? '\x1b[32m' : '\x1b[31m'}${mark}\x1b[0m ${r.name} [${r.durationMs.toFixed(1)} ms]${
        r.error ? ` — ERROR: ${r.error}` : ''
      }`
    );
  }
}
console.log('\n' + '─'.repeat(78));
console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
console.log('─'.repeat(78) + '\n');
if (failed > 0) process.exit(1);
