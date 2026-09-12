/**
 * @license
 * Shared fixtures for component and workflow tests (test-only file).
 *
 * One place builds a *believable* deck track: real typed models, a beat grid with
 * imported nodes, and an ANLZ stand-in whose column values encode their own index.
 * The index-as-value trick is what lets a test prove that a column was copied (not
 * re-analysed, not smoothed): the value is the index of the source column it came from.
 */

import {
  DataOrigin,
  PaletteClip,
  TrackModel,
  WaveformAnalysisData,
} from '../../src/types/rekordbox';
import { createFakeAudioBuffer, createIndexedBuffer } from './fakeAudioContext';

export const SR = 44100;
export const DECK_SECONDS = 10;
export const DECK_COLUMNS = 100;
export const DECK_BUCKET = DECK_SECONDS / DECK_COLUMNS; // 0.1 s per column
export const DECK_BPM = 120; // 0.5 s per beat

export interface DeckFixture {
  /** Amplitude factor of the stand-in columns; defaults to 1. */
  multiplier?: number;
  columns?: number;
  seconds?: number;
  withAnalysis?: boolean;
  withBeatNodes?: boolean;
  id?: string;
  title?: string;
}

/** ANLZ stand-in: `peaks[i] = multiplier · (i + 1)` — a copy is provable by value. */
export function makeVariant(multiplier: number, columns = DECK_COLUMNS, seconds = DECK_SECONDS, tag = 'PWV5'): WaveformAnalysisData {
  const peaks = new Float32Array(columns);
  for (let i = 0; i < columns; i++) peaks[i] = multiplier * (i + 1);
  return {
    length: columns,
    peaks,
    peaksL: peaks,
    peaksR: peaks,
    lowEnergy: peaks.map((v) => v / 3),
    midEnergy: peaks.map((v) => v / 3),
    highEnergy: peaks.map((v) => v / 3),
    origin: DataOrigin.REKORDBOX_ANLZ,
    secPerBucket: seconds / columns,
    sourceTag: tag,
  };
}

export function makeDeckTrack(fixture: DeckFixture = {}): TrackModel {
  const {
    multiplier = 1,
    columns = DECK_COLUMNS,
    seconds = DECK_SECONDS,
    withAnalysis = true,
    withBeatNodes = true,
    id = 'deck',
    title = 'Deck Track',
  } = fixture;
  const analysis = withAnalysis ? makeVariant(multiplier, columns, seconds) : null;
  const beats = withBeatNodes
    ? Array.from({ length: Math.round(seconds / (60 / DECK_BPM)) }, (_v, i) => ({
        time: i * (60 / DECK_BPM),
        isDownbeat: i % 4 === 0,
      }))
    : [];
  const audioBuffer = createIndexedBuffer(seconds, SR, multiplier) as unknown as AudioBuffer;
  return {
    id,
    title,
    artist: 'Artist',
    album: 'Album',
    bpm: DECK_BPM,
    key: '1A',
    duration: seconds,
    sourceDuration: seconds,
    sampleRate: SR,
    channels: 2,
    originalSha256: `sha256-${id}`,
    isOriginalUntouched: true,
    audioBuffer,
    originalMedia: {
      location: `file:///C:/Music/${title}.mp3`,
      status: 'AVAILABLE',
      resolvedPath: `C:\\Music\\${title}.mp3`,
      size: 1_000_000,
      modifiedAt: 0,
    },
    beatGrid: {
      firstBeat: 0,
      bpm: DECK_BPM,
      meter: 4,
      beats,
      origin: DataOrigin.REKORDBOX_ANLZ,
    },
    cues: [
      { id: 'cue-1', name: 'IN', type: 'MEMORY', position: 2, color: '#ff2a2a', origin: DataOrigin.REKORDBOX_ANLZ },
      { id: 'cue-2', name: 'OUT', type: 'MEMORY', position: 7, color: '#ff2a2a', origin: DataOrigin.REKORDBOX_ANLZ },
    ],
    loops: [
      {
        id: 'loop-1',
        name: 'LOOP',
        start: 4,
        end: 5,
        length: 1,
        color: '#ff9500',
        origin: DataOrigin.REKORDBOX_ANLZ,
      },
    ],
    phrases: [{ id: 'phrase-1', index: 1, name: 'Phrase 1', startTime: 0, endTime: 8, type: 'PHRASE', kind: 'BRIDGE', energy: 2, mood: 0 }],
    analysis,
    analysisVariants: analysis ? [analysis] : [],
    baseAnalysis: analysis ?? undefined,
    baseAnalysisVariants: analysis ? [analysis] : [],
    origin: withAnalysis ? DataOrigin.REKORDBOX_ANLZ : DataOrigin.REKORDBOX_XML,
    workingSegments: [],
    waveformDataUrl: undefined,
  } as unknown as TrackModel;
}

export function makePaletteClip(overrides: Partial<PaletteClip> = {}): PaletteClip {
  const seconds = overrides.duration ?? 2;
  return {
    id: 'clip-1',
    name: 'Kick Loop',
    sourceTrackId: 'clip-source',
    sourceTrackName: 'Clip Quelle',
    sourceStart: 0,
    sourceEnd: seconds,
    duration: seconds,
    beats: Math.round(seconds / (60 / DECK_BPM)),
    bars: Math.round(seconds / (60 / DECK_BPM) / 4),
    bpm: DECK_BPM,
    key: '1A',
    color: '#00a2ff',
    audioBuffer: createIndexedBuffer(seconds, SR, 2) as unknown as AudioBuffer,
    miniPeaks: Array.from({ length: 64 }, (_v, i) => (i % 8) / 8),
    origin: DataOrigin.REKORDBOX_XML,
    ...overrides,
  };
}

/** A source track whose ANLZ a clip can inherit (same bucket duration as the deck). */
export function makeClipSourceTrack(): TrackModel {
  return makeDeckTrack({ multiplier: 2, id: 'clip-source', title: 'Clip Quelle' });
}

export function makeEmptyBuffer(seconds: number, channels = 2): AudioBuffer {
  return createFakeAudioBuffer(channels, Math.round(seconds * SR), SR) as unknown as AudioBuffer;
}

/** Collects every `fillText` string the canvas draws (labels, hints, ghost text). */
export function drawnTexts(log: { calls: Array<{ op: string; args: unknown[] }> } | undefined): string[] {
  if (!log) return [];
  return log.calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
}
