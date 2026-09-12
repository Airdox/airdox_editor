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
  /** Explicitly generated test/demo material; never Rekordbox data. */
  GENERATED_TEST = 'GENERATED_TEST',
  /** @deprecated Kept only to read old project files; never create. */
  GENERATED_FALLBACK = 'GENERATED_FALLBACK',
}

export type WaveformMode = 'BLUE' | 'RGB' | '3BAND';

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
  /** Exact tempo stored on this PQTZ beat (tempo_x100 / 100). */
  bpm?: number;
  /**
   * True for beats that only exist because a structural edit opened a gap
   * (inserted material): the interval continues the deck grid and is a
   * USER_EDIT consequence, never imported PQTZ data.
   */
  insertGrid?: boolean;
  /** @deprecated Read-only compatibility for old project files; never generate. */
  tailExtended?: boolean;
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
  origin: DataOrigin;
}

export type EditOperationType = 'ORIGINAL' | 'INSERT' | 'REPLACE' | 'OVERDUB' | 'CUT' | 'CLEAR';

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
  /**
   * Provenance of the clip material, needed to re-use already stored analysis
   * columns instead of re-analysing audio: which track the clip was cut from
   * and where inside that track it starts.
   */
  sourceTrackId?: string;
  sourceClipStart?: number;
  /** Applied tempo factor (destination BPM / clip BPM); 1.0 = timing untouched. */
  tempoRatio?: number;
  /** Applied pitch shift in semitones; 0 = harmonic content untouched. */
  pitchShift?: number;
}

export interface WaveformAnalysisData {
  length: number;
  peaks: Float32Array; // stored column height per bucket (0..1)
  peaksL: Float32Array;
  peaksR: Float32Array;
  /**
   * Per-bucket color/band components exactly as stored in the ANLZ source
   * (0..1): for PWV5/PWV4 these are the red/green/blue components of the
   * column color, for PWV6/PWV7 the low/mid/high band heights. They are
   * visualized verbatim, never recombined.
   */
  lowEnergy: Float32Array; // red (PWV5/PWV4) / low band (PWV6/PWV7)
  midEnergy: Float32Array; // green / mid band
  highEnergy: Float32Array; // blue / high band
  /**
   * PWAV/PWV3 (MONO_5BIT): the three high-order bits, 0 = darkest blue …
   * 7 = near white (documented whiteness of the blue waveform).
   */
  whiteness?: Float32Array;
  /** PWV4 byte 1: luminance boost of the color columns (/127). */
  luminance?: Float32Array;
  /** PWV4: back column height = max(d2, red, green) (/127). */
  backPeaks?: Float32Array;
  /** PWV4: front column height = blue component d5 (/127). */
  frontPeaks?: Float32Array;
  origin: DataOrigin;
  secPerBucket?: number;
  samplesPerBucket?: number;
  /**
   * Column-wise provenance of an EDIT composite (`ColumnSource` codes from
   * src/edit/editWaveform.ts). Absent on pristine imported variants: only the
   * projected waveform of an edited deck carries per-column origins, so the
   * renderer can show which columns are verbatim Rekordbox data and which were
   * computed from user material. Never used to invent amplitudes.
   */
  provenance?: Uint8Array;
  /** True for a composite derived from the edit timeline, never for pure ANLZ. */
  isEditComposite?: boolean;
  /** Display label of the rendered variant (e.g. `PWV5 → EDIT`). */
  label?: string;
  /**
   * ANLZ source tag this variant was decoded from (e.g. 'PWAV', 'PWV2' …'PWV7').
   * Set only for genuine ANLZ variants; never for computed analysis.
   */
  sourceTag?: string;
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
  /**
   * All genuine ANLZ waveform variants decoded from the container (different
   * PWV tags / resolutions). `analysis` remains the best variant; renderers
   * pick the variant that matches the current zoom. Never synthesized.
   */
  analysisVariants?: WaveformAnalysisData[];
  origin: DataOrigin;
  databaseRecord?: ExtractedDatabaseRecord;
  phrases?: PhraseSection[];
  rawXmlAttributes?: Record<string, string>;
  originalMedia?: OriginalMediaReference;
  workingSegments: EditSegment[];
  /**
   * Duration of the PRISTINE source media (seconds). `duration` is the *project*
   * duration and moves with every insert/delete; this value never does, so the
   * ANLZ column → time mapping of the untouched material stays exact across any
   * number of edits. Defaults to `duration` while unedited.
   */
  sourceDuration?: number;
  /**
   * Pristine imported analysis, frozen at deck load and never mutated by edits.
   * Every edit composite is re-derived from these arrays (verbatim column copy),
   * never from the previously displayed composite — repeated edits therefore
   * cannot degrade or drift the Rekordbox waveform.
   */
  baseAnalysis?: WaveformAnalysisData | null;
  baseAnalysisVariants?: WaveformAnalysisData[];
  /** Telemetry of the current edit projection (shown in the UI, never faked). */
  editInfo?: TrackEditInfo;
}

/** Per-column provenance summary of the projected (edited) waveform. */
export interface TrackEditInfo {
  /** Number of layout spans on the project timeline. */
  spans: number;
  /** Structural (length-changing) edits applied. */
  structuralEdits: number;
  /** Overdub overlays applied. */
  overlays: number;
  /** Total columns of the best rendered variant. */
  columns: number;
  /** Columns copied verbatim from ANLZ (identity position). */
  verbatimColumns: number;
  /** Columns copied verbatim from ANLZ but re-timed by an edit. */
  retimedColumns: number;
  /** Columns taken verbatim from another loaded track's ANLZ (clip source). */
  clipColumns: number;
  /** Columns computed from edited user material (peaks only, marked as such). */
  computedColumns: number;
  /** Columns mixed from an overdub overlay. */
  mixColumns: number;
  /** Columns silenced by Clear. */
  silenceColumns: number;
  /** Columns without any source data (never invented, drawn empty). */
  missingColumns: number;
  /** Bucket duration (seconds per column) of the projected variants. */
  bucketSeconds: number;
  /** True when nothing is edited (project === original). */
  isIdentity: boolean;
  /** Tags of the ANLZ variants the composite was projected from. */
  sourceTags: string[];
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
  /**
   * Shallow copy of the edit list: `clipBuffer` references are shared on purpose
   * (a JSON deep copy would silently drop the audio and make Undo destructive).
   */
  segments: EditSegment[];
  selection: SelectionRange | null;
  cues: CuePoint[];
  /** Loops/phrases re-timed by the edit (restored together with the cues). */
  loops?: LoopPoint[];
  phrases?: PhraseSection[];
  /** Pre-edit beat grid (manual grid edits stay reversible and traceable). */
  beatGrid?: BeatGrid;
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
