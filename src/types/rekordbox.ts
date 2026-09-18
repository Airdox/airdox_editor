/**
 * @license
 * Rekordbox DJ Audio Editor - Type Definitions
 */

export enum DataOrigin {
  REKORDBOX_DB = 'REKORDBOX_DB',
  REKORDBOX_XML = 'REKORDBOX_XML',
  REKORDBOX_ANLZ = 'REKORDBOX_ANLZ',
  PROJECT = 'PROJECT',
  ANALYSIS_CACHE = 'ANALYSIS_CACHE',
  LOCAL_ANALYSIS = 'LOCAL_ANALYSIS',
  USER_EDIT = 'USER_EDIT',
  /** Own calculation used as a clearly labeled fallback when no Rekordbox
   * source (ANLZ/DB/audio) provides the data. */
  GENERATED_FALLBACK = 'GENERATED_FALLBACK',
}

export type WaveformMode = 'BLUE' | 'RGB' | '3BAND';

/**
 * Explains how a displayed waveform was assembled.  In particular, a project
 * edit can retain original Rekordbox ANLZ buckets for all untouched material
 * instead of silently replacing the complete view with a browser analysis.
 */
export interface WaveformProvenance {
  sourceOrigins: DataOrigin[];
  /** Fraction of the visible timeline backed by original ANLZ values. */
  nativeCoverage: number;
  /** Fraction that required project/local analysis (e.g. an overdub). */
  projectCoverage: number;
  operation: 'DIRECT' | 'SPLICED' | 'MIXED' | 'CLEAR' | 'INSERT' | 'DELETE' | 'REPLACE' | 'OVERDUB';
}

/**
 * Read-only reference to an actual Rekordbox ANLZ container.  The file is
 * never modified; its path is kept so the native waveform can be reopened
 * without querying master.db again.
 */
export interface AnalysisFileReference {
  path: string;
  accessMode: 'READ_ONLY';
  status: 'AVAILABLE' | 'MISSING' | 'UNVERIFIED';
  size?: number;
  modifiedAt?: number;
  /** Audio path reported by PPTH, when available. */
  sourceMediaPath?: string;
  /**
   * Duration of the unedited source audio represented by the ANLZ buckets.
   * It keeps an edited project timeline from accidentally stretching the
   * original native waveform after a project reload.
   */
  sourceDuration?: number;
  format?: 'DAT' | 'EXT' | '2EX' | 'ANLZ';
}

export interface SourcedValue<T> {
  value: T;
  origin: DataOrigin;
  importedAt: number;
  confidence?: number;
  verified?: boolean;
}

export interface BeatNode {
  index: number;
  time: number; // in seconds
  isBarStart: boolean;
  barNumber: number;
  beatInBar: number; // 1, 2, 3, 4
}

export interface BeatGrid {
  firstBeat: number; // seconds
  bpm: number;
  meter: number; // 4/4 = 4
  beats: BeatNode[];
  origin: DataOrigin;
}

export interface CuePoint {
  id: string;
  name: string;
  type: 'MEMORY' | 'HOT_CUE';
  hotCueNum?: number; // 0=A, 1=B, 2=C, etc.
  letter?: string; // 'A', 'B', 'C'
  position: number; // in seconds
  inMsec?: number; // exact database millisecond timestamp
  cueIndex?: number; // 1, 2, 3...
  barNumber?: number;
  beatNumber?: number;
  comment?: string;
  color: string;
  origin?: DataOrigin;
}

export interface PhraseSection {
  id: string;
  name: 'INTRO' | 'UP' | 'DOWN' | 'CHORUS' | 'BREAKDOWN' | 'DROP' | 'OUTRO' | 'VERSE' | 'BRIDGE';
  startBar: number;
  endBar: number;
  startTime: number;
  endTime: number;
  color: string;
  /** Where the phrase data came from; own templates are GENERATED_FALLBACK. */
  origin?: DataOrigin;
}

export interface ExtractedDatabaseRecord {
  trackId: string;
  databaseSource: 'REKORDBOX_XML' | 'REKORDBOX_DB' | 'REKORDBOX_ANLZ' | 'LOCAL_EXTRACT';
  anlzTagsFound: string[];
  /** Non-fatal notices produced while decoding the analysis source. */
  anlzWarnings?: string[];
  memoryCuesCount: number;
  hotCuesCount: number;
  loopsCount: number;
  waveformBuckets: number;
  waveformModeSupported: ('BLUE' | 'RGB' | '3BAND')[];
  sampleRate: number;
  checksum: string;
  extractedAt: number;
  filePath?: string;
}

export interface LoopPoint {
  id: string;
  name: string;
  start: number;
  end: number;
  length: number;
  color: string;
  origin: DataOrigin;
}

export interface PaletteClip {
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
  audioBuffer?: AudioBuffer;
  miniPeaks?: number[]; // pre-computed 64 normalized peaks for palette preview
  /** Native Rekordbox waveform range carried with the clip when available. */
  analysis?: WaveformAnalysisData;
  /** Beat times relative to sourceStart; used to preserve an ANLZ beat grid. */
  beatOffsets?: number[];
  /** Read-only ANLZ source used for this clip's native analysis. */
  analysisSource?: AnalysisFileReference;
  analysisSourceTrackId?: string;
  analysisSourceStart?: number;
  analysisSourceEnd?: number;
  origin: DataOrigin;
}

export type EditOperationType = 'ORIGINAL' | 'INSERT' | 'REPLACE' | 'OVERDUB' | 'CUT' | 'SILENCE';

export interface EditSegment {
  id: string;
  type: EditOperationType;
  trackId: string;
  sourceStart: number;
  sourceEnd: number;
  projectStart: number;
  projectDuration: number;
  clipId?: string;
  /**
   * Optional native source identity for this timeline region. It contains only
   * a read-only ANLZ reference and source coordinates, never waveform bytes.
   * This lets project reload reconstruct original ANLZ buckets for an inserted
   * clip when it came from the same known Rekordbox source.
   */
  analysisSource?: AnalysisFileReference;
  analysisSourceTrackId?: string;
  analysisSourceStart?: number;
  analysisSourceEnd?: number;
  clipBuffer?: AudioBuffer;
  gain: number;
}

export interface WaveformAnalysisData {
  length: number;
  peaks: Float32Array; // max amplitude per bucket
  peaksL: Float32Array;
  peaksR: Float32Array;
  // Spectral energies for RGB and 3BAND modes
  lowEnergy: Float32Array; // 20 - 250 Hz (bass/kicks - RED)
  midEnergy: Float32Array; // 250 - 4000 Hz (vocals/synths - GREEN)
  highEnergy: Float32Array; // 4000 - 20000 Hz (hihats/air - BLUE)
  origin: DataOrigin;
  secPerBucket?: number;
  samplesPerBucket?: number;
  /** Optional coverage information for a native/project composite waveform. */
  provenance?: WaveformProvenance;
}

/**
 * The physical source referenced by Rekordbox XML. It is never a writable
 * target: edits exist only in the application's working copy and exports.
 */
export interface OriginalMediaReference {
  location: string;
  resolvedPath?: string;
  accessMode: 'READ_ONLY';
  status: 'UNVERIFIED' | 'AVAILABLE' | 'MISSING' | 'UNSUPPORTED';
  size?: number;
  modifiedAt?: number;
}

export interface TrackModel {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre?: string;
  label?: string;
  rating?: number; // 0 to 5 stars
  playCount?: number; // Rekordbox DJ-Play Count
  year?: string;
  comments?: string;
  dateAdded?: string;
  remixer?: string;
  isrc?: string;
  bpm: number;
  key: string; // e.g. "2A" or "Fm"
  duration: number; // seconds
  sampleRate: number;
  channels: number;
  originalSha256: string;
  isOriginalUntouched: boolean;
  audioBuffer: AudioBuffer | null;
  beatGrid: BeatGrid;
  cues: CuePoint[];
  loops: LoopPoint[];
  analysis: WaveformAnalysisData | null;
  origin: DataOrigin;
  databaseRecord?: ExtractedDatabaseRecord;
  phrases?: PhraseSection[];
  rawXmlAttributes?: Record<string, string>;
  originalMedia?: OriginalMediaReference;
  /** Optional persistent, read-only pointer to the native Rekordbox analysis. */
  analysisSource?: AnalysisFileReference;
  workingSegments: EditSegment[];
}

/**
 * Compact collection entry shared by the XML importer and the Rekordbox
 * database importer (no dense beat grids, no audio buffer until loaded).
 */
export type PartialTrackModel = Partial<TrackModel> & {
  label?: string;
  fileSize?: number;
};

export interface SelectionRange {
  start: number; // seconds
  end: number; // seconds
  startBeat?: number;
  endBeat?: number;
  beatsCount: number;
  barsCount: number;
  duration: number;
}

export interface EditHistoryEntry {
  description: string;
  timestamp: number;
  segments: EditSegment[];
  selection: SelectionRange | null;
  cues: CuePoint[];
  audioBuffer?: AudioBuffer;
  duration?: number;
  analysis?: WaveformAnalysisData;
}

export interface MultiTrackLayer {
  id: string;
  name: string;
  trackId: string;
  muted: boolean;
  solo: boolean;
  volume: number; // 0..1
  pan: number; // -1..1
  color: string;
}

export * from './editAssistant';
