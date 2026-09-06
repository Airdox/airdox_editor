/**
 * @license
 * Airdox_intelligents_Editor - Type Definitions
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

export type WaveformMode = 'AMBER' | 'BLUE' | 'RGB' | '3BAND';

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
  /**
   * `true`, wenn die Beatliste nicht aus der Datei stammt, sondern aus Anker und
   * Tempo fortgeschrieben wurde. Die Zeiten sind dann eine Rechnung, kein
   * Importwert – und muss so auch dargestellt werden.
   */
  beatsAreDerived?: boolean;
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
  /** Dieselben Samples wie audioBuffer, ohne AudioContext – Bearbeitung und Tests. */
  clipPcm?: import('../audio/pcm').PcmAudio;
  miniPeaks?: number[]; // pre-computed 64 normalized peaks for palette preview
  origin: DataOrigin;
}

export type EditOperationType = 'ORIGINAL' | 'INSERT' | 'REPLACE' | 'OVERDUB' | 'CUT';

export interface EditSegment {
  id: string;
  type: EditOperationType;
  trackId: string;
  sourceStart: number;
  sourceEnd: number;
  projectStart: number;
  projectDuration: number;
  clipId?: string;
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
  /**
   * Bereiche, in denen die Kurve nicht aus der importierten Datei stammt, sondern
   * nach einem Eingriff neu gezeichnet wurde (in Sekunden der aktuellen Timeline).
   * Leer bzw. undefined heißt: jeder Bucket ist ein Importwert.
   */
  recomputed?: { startSec: number; endSec: number }[];
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
  workingSegments: EditSegment[];
  /** Arbeitskopie nach destruktiven Schnitten; audioBuffer bleibt das Original. */
  workingPcm?: import('../audio/pcm').PcmAudio;
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
  startBeat: number;
  endBeat: number;
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
  loops?: LoopPoint[];
  beatGrid?: BeatGrid;
  /** Vollständiger Arbeitsstand vor dem Eingriff: der exakte Rückweg für Undo. */
  audio?: import('../audio/pcm').PcmAudio;
  /** Die dazugehörige Wellenform – ohne sie wäre Undo ein Neuberechnen. */
  analysis?: WaveformAnalysisData | null;
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
