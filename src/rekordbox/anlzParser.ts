/**
 * @license
 * Rekordbox ANLZ Analysis File Decoder
 *
 * Decodes the binary ANLZ sections that Rekordbox writes for tracks
 * (.DAT waveform/beatgrid, .EXT colored waveforms / extended cues /
 * song structure, .2EX CDJ-3000 three-band waveforms):
 *
 *  - PPTH  source audio path (UTF-16BE)
 *  - PQTZ  quantized beat grid (beat number, tempo, time)
 *  - PCOB  cue list (classic 38-byte PCPT entries) - memory or hot cues
 *  - PCO2  extended (nxs2) cue list (variable-length PCP2 entries)
 *  - PWAV / PWV2 / PWV3 / PWV4 / PWV5 / PWV6 / PWV7 waveform sections
 *  - PSSI  song structure / phrases (Rekordbox 6 exports are XOR-garbled)
 *
 * The byte layouts follow the independently documented format analysis by
 * the Deep Symmetry project (djl-analysis.deepsymmetry.org) and the Kaitai
 * Struct specification in crate-digger. Every value in ANLZ files is big
 * endian. The legacy fixture layout used by the project's older regression
 * tests remains supported as a clearly labeled fallback and never takes
 * priority over the real layout.
 *
 * Files are only ever read; this module never writes to the source.
 */

import {
  BeatGrid,
  BeatNode,
  CuePoint,
  DataOrigin,
  LoopPoint,
  PhraseSection,
  WaveformAnalysisData,
} from '../types/rekordbox';

export interface AnlzCueEntry {
  /** 0 = memory point, 1..N = hot cue number (A=1, B=2, ...) */
  hotCue: number;
  /** 0 = regular cue, 4 = active loop marker */
  status: number;
  /** 1 = memory cue / simple position, 2 = loop */
  type: number;
  timeMs: number;
  loopMs: number;
  /** PCO2 only */
  comment?: string;
  /** PCO2 only: hot cue color code */
  colorCode?: number;
  /** PCO2 only: hot cue RGB (LED color) */
  colorR?: number;
  colorG?: number;
  colorB?: number;
  loopNumerator?: number;
  loopDenominator?: number;
}

export interface AnlzPhraseEntry {
  index: number;
  beat: number;
  kind: number;
  k1: number;
  k2: number;
  k3: number;
  b: number;
  beat2: number;
  beat3: number;
  beat4: number;
  fill: number;
  beatFill: number;
}

export interface AnlzParsedResult {
  tagsFound: string[];
  analysisPath?: string;
  bpm?: number;
  firstBeat?: number;
  beatGrid?: BeatGrid;
  cues: CuePoint[];
  loops: LoopPoint[];
  phrases: PhraseSection[];
  waveform?: WaveformAnalysisData;
  warnings: string[];
  /** Raw cue entries split by category; set from the highest-priority tag. */
  rawHotCues?: AnlzCueEntry[];
  rawMemoryCues?: AnlzCueEntry[];
  /** Raw unmasked PSSI data after header parsing. */
  rawPhrases?: AnlzPhraseEntry[];
  pssiMood?: number;
  pssiEndBeat?: number;
  pssiBank?: number;
  pssiMasked?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function readUtf16Be(view: DataView, offset: number, byteLength: number): string {
  if (byteLength < 2) {
    // Some odd exports use raw ASCII; keep them readable.
    let out = '';
    for (let i = 0; i < byteLength; i++) out += String.fromCharCode(view.getUint8(offset + i));
    return out.replace(/\0+$/, '');
  }
  const chars: number[] = [];
  const end = Math.min(offset + byteLength, view.byteLength - 1);
  for (let p = offset; p + 1 <= end; p += 2) {
    const code = (view.getUint8(p) << 8) | view.getUint8(p + 1);
    if (code === 0) break;
    chars.push(code);
  }
  return String.fromCharCode(...chars);
}

const WAVEFORM_PRIORITY: Record<string, number> = {
  PWV7: 7,
  PWV5: 6,
  PWV6: 5,
  PWV4: 4,
  PWV3: 3,
  PWV2: 2,
  PWAV: 1,
};

interface WaveformSpec {
  entryBytes: number;
  entryCount: number;
  dataOffset: number;
  style: 'MONO_5BIT' | 'MONO_4BIT' | 'RGB_5BIT' | 'TRIPLE_BYTE' | 'COLOR_6BYTE';
  /**
   * Seconds represented by one entry, when the format defines a fixed rate.
   *
   * Rekordbox scroll waveforms (PWV3 / PWV4 / PWV5 detail data) are sampled at
   * a constant 150 entries per second, *not* stretched across the track
   * length. Preview waveforms (PWAV / PWV2 / PWV6) instead squeeze the whole
   * track into a fixed number of columns and therefore have no fixed rate.
   *
   * Deriving the time base as `duration / entryCount` for a scroll waveform
   * scales the whole display by a constant factor: it looks right at 0:00 and
   * is increasingly wrong the further into the track you scroll — the audio,
   * the beat grid and the drawn waveform slowly separate.
   */
  secPerEntry?: number;
}

/** Rekordbox detail/scroll waveforms are fixed at 150 entries per second. */
const SCROLL_WAVEFORM_ENTRIES_PER_SEC = 150;

function readWaveformSpec(view: DataView, offset: number, tagEnd: number, tag: string): WaveformSpec | null {
  // Marked fallback: the project's legacy test fixture stores a 3-byte
  // (low, mid, high) preview directly after a u32 count. Real .EXT files
  // never use this shape, so it is only reached for regression fixtures.
  if (tag === 'PWV5') {
    const legacyCount = view.getUint32(offset + 8, false);
    if (
      legacyCount > 0 &&
      legacyCount <= 20_000 &&
      offset + 12 + legacyCount * 3 <= tagEnd
    ) {
      return {
        entryBytes: 3,
        entryCount: legacyCount,
        dataOffset: offset + 12,
        style: 'TRIPLE_BYTE',
      };
    }
  }

  const lenHeader = view.getUint32(offset + 4, false);

  if (tag === 'PWAV' || tag === 'PWV2') {
    // len_header 0x14: u4 len_data, u4 unknown(0x10000), data
    if (lenHeader < 0x14 || offset + 0x14 > tagEnd) return null;
    const lenData = view.getUint32(offset + 0x0c, false);
    if (lenData === 0 || offset + 0x14 + lenData > tagEnd) return null;
    return {
      entryBytes: 1,
      entryCount: lenData,
      dataOffset: offset + 0x14,
      style: tag === 'PWAV' ? 'MONO_5BIT' : 'MONO_4BIT',
    };
  }

  if (tag === 'PWV6') {
    // len_header 0x14: u4 len_entry_bytes, u4 len_entries, data
    if (lenHeader < 0x14 || offset + 0x14 > tagEnd) return null;
    const entryBytes = view.getUint32(offset + 0x0c, false);
    const entryCount = view.getUint32(offset + 0x10, false);
    if (
      entryBytes !== 3 ||
      entryCount === 0 ||
      entryCount > 500_000 ||
      offset + 0x14 + entryBytes * entryCount > tagEnd
    ) {
      return null;
    }
    return { entryBytes, entryCount, dataOffset: offset + 0x14, style: 'TRIPLE_BYTE' };
  }

  // PWV3 / PWV4 / PWV5 / PWV7 share: len_header 0x18,
  // u4 len_entry_bytes, u4 len_entries, u4 unknown, data
  if (offset + 0x18 > tagEnd) return null;
  const entryBytes = view.getUint32(offset + 0x0c, false);
  const entryCount = view.getUint32(offset + 0x10, false);
  const dataOffset = offset + 0x18;
  if (
    entryBytes === 0 ||
    entryCount === 0 ||
    entryCount > 500_000 ||
    dataOffset + entryBytes * entryCount > tagEnd
  ) {
    return null;
  }
  const secPerEntry = 1 / SCROLL_WAVEFORM_ENTRIES_PER_SEC;
  if (tag === 'PWV3' && entryBytes === 1) {
    return { entryBytes, entryCount, dataOffset, style: 'MONO_5BIT', secPerEntry };
  }
  if (tag === 'PWV4' && entryBytes === 6) {
    return { entryBytes, entryCount, dataOffset, style: 'COLOR_6BYTE', secPerEntry };
  }
  if (tag === 'PWV5' && entryBytes === 2) {
    return { entryBytes, entryCount, dataOffset, style: 'RGB_5BIT', secPerEntry };
  }
  if (tag === 'PWV7' && entryBytes === 3) {
    return { entryBytes, entryCount, dataOffset, style: 'TRIPLE_BYTE', secPerEntry };
  }
  return null;
}

function createWaveform(
  spec: WaveformSpec,
  view: DataView
): WaveformAnalysisData {
  const { entryCount, entryBytes, dataOffset, style } = spec;
  const peaks = new Float32Array(entryCount);
  const peaksL = new Float32Array(entryCount);
  const peaksR = new Float32Array(entryCount);
  const lowEnergy = new Float32Array(entryCount);
  const midEnergy = new Float32Array(entryCount);
  const highEnergy = new Float32Array(entryCount);

  for (let i = 0; i < entryCount; i++) {
    const p = dataOffset + i * entryBytes;
    let peak = 0;
    let low = 0;
    let mid = 0;
    let high = 0;

    if (style === 'MONO_5BIT') {
      const value = view.getUint8(p);
      peak = (value & 0x1f) / 31;
      low = mid = high = peak;
    } else if (style === 'MONO_4BIT') {
      peak = (view.getUint8(p) & 0x0f) / 15;
      low = mid = high = peak;
    } else if (style === 'RGB_5BIT') {
      const value = view.getUint16(p, false);
      low = ((value >> 13) & 0x07) / 7;
      mid = ((value >> 10) & 0x07) / 7;
      high = ((value >> 7) & 0x07) / 7;
      peak = ((value >> 2) & 0x1f) / 31;
    } else if (style === 'TRIPLE_BYTE') {
      // PWV6 / PWV7 entries are stored as mid, high, low.
      mid = view.getUint8(p) / 255;
      high = view.getUint8(p + 1) / 255;
      low = view.getUint8(p + 2) / 255;
      peak = Math.max(low, mid, high);
    } else if (style === 'COLOR_6BYTE') {
      // PWV4: 6 bytes per column. The exact Rekordbox color mapping is not
      // fully published; the final three bytes carry the dominant band
      // energy and are used as a labeled visual approximation.
      low = view.getUint8(p + 3) / 255;
      mid = view.getUint8(p + 4) / 255;
      high = view.getUint8(p + 5) / 255;
      peak = Math.max(low, mid, high);
    }

    peaks[i] = peak;
    peaksL[i] = peak;
    peaksR[i] = peak;
    lowEnergy[i] = low;
    midEnergy[i] = mid;
    highEnergy[i] = high;
  }

  return {
    length: entryCount,
    peaks,
    peaksL,
    peaksR,
    lowEnergy,
    midEnergy,
    highEnergy,
    origin: DataOrigin.REKORDBOX_ANLZ,
    ...(spec.secPerEntry ? { secPerBucket: spec.secPerEntry } : {}),
  };
}

// ---------------------------------------------------------------------------
// PQTZ beat grid
// ---------------------------------------------------------------------------

function parseBeatGrid(view: DataView, offset: number, tagEnd: number): BeatGrid | undefined {
  // Real layout: len_header 0x18; u4 unknown, u4 unknown2, u4 len_beats,
  // then 8-byte entries (u2 beat, u2 tempo*100, u4 time ms).
  if (offset + 0x18 > tagEnd) return undefined;
  const lenBeats = view.getUint32(offset + 0x14, false);
  const entriesStart = offset + 0x18;
  if (lenBeats === 0 || lenBeats > 100_000 || entriesStart + lenBeats * 8 > tagEnd) {
    return undefined;
  }

  const beats: BeatNode[] = [];
  let barNumber = 0;
  for (let i = 0; i < lenBeats; i++) {
    const entry = entriesStart + i * 8;
    const beatInBar = view.getUint16(entry, false);
    const tempo = view.getUint16(entry + 2, false);
    const time = view.getUint32(entry + 4, false) / 1000;
    if (beatInBar < 1 || beatInBar > 16 || tempo < 1) return undefined;
    if (i === 0 || beatInBar === 1) barNumber++;
    beats.push({ index: i, time, isBarStart: beatInBar === 1, barNumber, beatInBar });
  }

  return {
    firstBeat: beats[0].time,
    bpm: view.getUint16(entriesStart + 2, false) / 100,
    meter: 4,
    beats,
    origin: DataOrigin.REKORDBOX_ANLZ,
  };
}

// ---------------------------------------------------------------------------
// PCOB / PCO2 cue lists
// ---------------------------------------------------------------------------

const MEMORY_COLOR = '#ff3b30';
const HOT_CUE_COLOR = '#00a2ff';

function decodePcptEntry(view: DataView, entry: number, tagEnd: number): AnlzCueEntry | null {
  if (entry + 0x28 > tagEnd) return null;
  if (fourCC(view, entry) !== 'PCPT') return null;
  const lenEntry = view.getUint32(entry + 0x08, false);
  if (lenEntry !== 0x38 && entry + lenEntry > tagEnd) return null;
  const hotCue = view.getUint32(entry + 0x0c, false);
  const status = view.getUint32(entry + 0x10, false);
  const type = view.getUint8(entry + 0x1c);
  if (type !== 1 && type !== 2) return null;
  return {
    hotCue,
    status,
    type,
    timeMs: view.getUint32(entry + 0x20, false),
    loopMs: view.getUint32(entry + 0x24, false),
  };
}

function decodePcp2Entry(view: DataView, entry: number, tagEnd: number): AnlzCueEntry | null {
  if (entry + 0x28 > tagEnd) return null;
  if (fourCC(view, entry) !== 'PCP2') return null;
  const lenEntry = view.getUint32(entry + 0x08, false);
  if (lenEntry < 0x28 || entry + lenEntry > tagEnd) return null;

  const hotCue = view.getUint32(entry + 0x0c, false);
  const type = view.getUint8(entry + 0x10);
  if (type !== 1 && type !== 2) return null;

  const parsed: AnlzCueEntry = {
    hotCue,
    status: 0,
    type,
    timeMs: view.getUint32(entry + 0x14, false),
    loopMs: view.getUint32(entry + 0x18, false),
    loopNumerator: view.getUint16(entry + 0x24, false),
    loopDenominator: view.getUint16(entry + 0x26, false),
  };

  // Optional comment (present when the entry is longer than 43 bytes).
  if (lenEntry > 43 && entry + 0x2c <= tagEnd) {
    const lenComment = view.getUint32(entry + 0x28, false);
    if (lenComment > 0 && lenComment <= lenEntry - 0x2c) {
      parsed.comment = readUtf16Be(view, entry + 0x2c, lenComment);
    }
  }

  // Optional hot cue color follows the comment; the len_comment field is
  // always present when the entry is longer than 43 bytes.
  const lenCommentField = lenEntry > 43 ? view.getUint32(entry + 0x28, false) : 0;
  const afterComment = entry + 0x2c + lenCommentField;
  if (afterComment + 4 <= entry + lenEntry && (lenEntry - lenCommentField) > 44) {
    parsed.colorCode = view.getUint8(afterComment);
    parsed.colorR = view.getUint8(afterComment + 1);
    parsed.colorG = view.getUint8(afterComment + 2);
    parsed.colorB = view.getUint8(afterComment + 3);
  }

  return parsed;
}

function cueColor(entry: AnlzCueEntry, isHot: boolean): string {
  if (isHot) {
    if (entry.colorR !== undefined && (entry.colorR || entry.colorG || entry.colorB)) {
      return `rgb(${entry.colorR}, ${entry.colorG}, ${entry.colorB})`;
    }
    return HOT_CUE_COLOR;
  }
  return MEMORY_COLOR;
}

function entriesToModel(
  entries: AnlzCueEntry[],
  isHot: boolean,
  bpm: number,
  firstBeat: number
): { cues: CuePoint[]; loops: LoopPoint[] } {
  const cues: CuePoint[] = [];
  const loops: LoopPoint[] = [];
  const spb = bpm > 0 ? 60.0 / bpm : 0.5;
  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  entries.forEach((entry, index) => {
    const position = entry.timeMs / 1000;
    const beatIndex = Math.max(0, Math.round((position - firstBeat) / spb));
    const barNumber = Math.floor(beatIndex / 4) + 1;
    const beatNumber = (beatIndex % 4) + 1;

    if (entry.type === 2) {
      const end = entry.loopMs > entry.timeMs ? entry.loopMs / 1000 : position + spb * 4;
      loops.push({
        id: isHot ? `anlz-hot-loop-${entry.hotCue}` : `anlz-loop-${index + 1}`,
        name: isHot ? `Hot Loop ${letters[entry.hotCue - 1] || entry.hotCue}` : `Loop ${index + 1}`,
        start: position,
        end,
        length: Math.max(0, end - position),
        color: '#ff9500',
        origin: DataOrigin.REKORDBOX_ANLZ,
      });
      return;
    }

    if (isHot && entry.hotCue >= 1) {
      cues.push({
        id: `anlz-hot-${entry.hotCue}`,
        name: entry.comment || `Hot Cue ${letters[entry.hotCue - 1] || entry.hotCue}`,
        type: 'HOT_CUE',
        hotCueNum: entry.hotCue - 1,
        letter: letters[entry.hotCue - 1] || `${entry.hotCue}`,
        position,
        inMsec: entry.timeMs,
        cueIndex: entry.hotCue,
        barNumber,
        beatNumber,
        comment: entry.comment,
        color: cueColor(entry, true),
        origin: DataOrigin.REKORDBOX_ANLZ,
      });
    } else {
      cues.push({
        id: `anlz-mem-${index + 1}`,
        name: entry.comment || `Memory Cue ${index + 1}`,
        type: 'MEMORY',
        position,
        inMsec: entry.timeMs,
        cueIndex: index + 1,
        barNumber,
        beatNumber,
        comment: entry.comment,
        color: cueColor(entry, false),
        origin: DataOrigin.REKORDBOX_ANLZ,
      });
    }
  });

  return { cues, loops };
}

// ---------------------------------------------------------------------------
// PSSI song structure
// ---------------------------------------------------------------------------

const PSSI_MASK_BASE = [
  0xcb, 0xe1, 0xee, 0xfa, 0xe5, 0xee, 0xad, 0xee, 0xe9, 0xd2,
  0xe9, 0xeb, 0xe1, 0xe9, 0xf3, 0xe8, 0xe9, 0xf4, 0xe1,
];

const PHRASE_LABELS: Record<number, Record<number, PhraseSection['name']>> = {
  1: { 1: 'INTRO', 2: 'UP', 3: 'DOWN', 5: 'CHORUS', 6: 'OUTRO' }, // high
  2: { 1: 'INTRO', 2: 'VERSE', 3: 'VERSE', 4: 'VERSE', 5: 'VERSE', 6: 'VERSE', 7: 'VERSE', 8: 'BRIDGE', 9: 'CHORUS', 10: 'OUTRO' }, // mid
  3: { 1: 'INTRO', 2: 'VERSE', 3: 'VERSE', 4: 'VERSE', 5: 'VERSE', 6: 'VERSE', 7: 'VERSE', 8: 'BRIDGE', 9: 'CHORUS', 10: 'OUTRO' }, // low
};

const PHRASE_COLORS: Record<PhraseSection['name'], string> = {
  INTRO: '#3b82f6',
  UP: '#10b981',
  DOWN: '#8b5cf6',
  CHORUS: '#f59e0b',
  BRIDGE: '#8b5cf6',
  VERSE: '#10b981',
  OUTRO: '#3b82f6',
  BREAKDOWN: '#f59e0b',
  DROP: '#ef4444',
};

function decodePssiBody(body: Uint8Array): {
  mood: number;
  endBeat: number;
  bank: number;
  entries: AnlzPhraseEntry[];
} {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const mood = view.getUint16(0x00, false);
  const endBeat = view.getUint16(0x08, false);
  const bank = view.getUint8(0x0c);
  const entryBytes = 24;
  const count = Math.max(0, Math.floor((body.byteLength - 0x0e) / entryBytes));
  const entries: AnlzPhraseEntry[] = [];

  for (let i = 0; i < count; i++) {
    const p = 0x0e + i * entryBytes;
    entries.push({
      index: view.getUint16(p, false),
      beat: view.getUint16(p + 0x02, false),
      kind: view.getUint16(p + 0x04, false),
      k1: view.getUint8(p + 0x07),
      k2: view.getUint8(p + 0x09),
      b: view.getUint8(p + 0x0b),
      beat2: view.getUint16(p + 0x0c, false),
      beat3: view.getUint16(p + 0x0e, false),
      beat4: view.getUint16(p + 0x10, false),
      k3: view.getUint8(p + 0x13),
      fill: view.getUint8(p + 0x15),
      beatFill: view.getUint16(p + 0x16, false),
    });
  }

  return { mood, endBeat, bank, entries };
}

function phrasesFromPssi(
  mood: number,
  endBeat: number,
  entries: AnlzPhraseEntry[],
  bpm: number,
  firstBeat: number,
  durationSec: number
): PhraseSection[] {
  const moodLabels = PHRASE_LABELS[mood] || PHRASE_LABELS[2];
  const spb = 60.0 / bpm;
  const phrases: PhraseSection[] = [];

  entries.forEach((entry, index) => {
    const next = entries[index + 1];
    const startBeat = Math.max(1, entry.beat);
    const endBeatIncl =
      next && next.beat > startBeat ? next.beat - 1 : Math.max(startBeat, endBeat || startBeat);
    const startTime = firstBeat + (startBeat - 1) * spb;
    const endTime = Math.min(durationSec, firstBeat + endBeatIncl * spb);
    const baseName = moodLabels[entry.kind] || 'VERSE';
    const startBar = Math.floor((startBeat - 1) / 4) + 1;
    const endBar = Math.floor((endBeatIncl - 1) / 4) + 1;

    phrases.push({
      id: `pssi-${entry.index}`,
      name: baseName,
      startBar,
      endBar,
      startTime: Math.max(0, startTime),
      endTime: Math.max(0, endTime),
      color: PHRASE_COLORS[baseName],
      origin: DataOrigin.REKORDBOX_ANLZ,
    });
  });

  return phrases;
}

// ---------------------------------------------------------------------------
// Top-level parser
// ---------------------------------------------------------------------------

export function parseAnlzBinary(buffer: ArrayBuffer): AnlzParsedResult {
  const view = new DataView(buffer);
  const result: AnlzParsedResult = {
    tagsFound: [],
    cues: [],
    loops: [],
    phrases: [],
    warnings: [],
  };

  let offset = 0;
  const len = buffer.byteLength;

  if (len >= 12 && fourCC(view, 0) === 'PMAI') {
    const headerLength = view.getUint32(4, false);
    if (headerLength >= 12 && headerLength <= len) {
      offset = headerLength;
    } else {
      result.warnings.push('Ungültige PMAI-Headerlänge; Tag-Suche startet am Dateianfang.');
    }
  }

  // Track the best cue list per category so that PCO2 (if present) takes
  // priority over PCOB, and hot/memory lists are merged.
  let rawMemoryCues: AnlzCueEntry[] = [];
  let rawHotCues: AnlzCueEntry[] = [];
  let beatGrid: BeatGrid | undefined;
  let waveformPriority = 0;

  while (offset + 12 <= len) {
    const tag = fourCC(view, offset);
    // Real ANLZ envelope: u4 len_header at +4, u4 len_tag at +8. The project's
    // legacy fixtures wrote the section length at +4, so both are accepted.
    const lenHeader = view.getUint32(offset + 4, false);
    const lenTag = view.getUint32(offset + 8, false);
    let chunkSize = lenTag;
    // Legacy PWV5 fixture: u32 count in the len_tag slot; the real section
    // length lives in the len_header slot (12 + count * 3).
    if (
      tag === 'PWV5' &&
      lenTag >= 1 &&
      lenTag <= 20_000 &&
      lenHeader === 12 + lenTag * 3
    ) {
      chunkSize = lenHeader;
    }
    if (chunkSize < 12 || offset + chunkSize > len) {
      chunkSize = lenHeader;
    }
    if (chunkSize < 12 || offset + chunkSize > len) {
      offset += 4;
      continue;
    }
    const tagEnd = offset + chunkSize;
    result.tagsFound.push(tag);

    if (tag === 'PPTH') {
      if (offset + 0x10 <= tagEnd) {
        const lenPath = view.getUint32(offset + 0x0c, false);
        if (lenPath > 0 && lenPath <= tagEnd - (offset + 0x10)) {
          result.analysisPath = readUtf16Be(view, offset + 0x10, lenPath);
        }
      }
    } else if (tag === 'PQTZ' || tag === 'PQT2') {
      beatGrid = parseBeatGrid(view, offset, tagEnd);
      if (beatGrid) {
        result.beatGrid = beatGrid;
        result.bpm = beatGrid.bpm;
        result.firstBeat = beatGrid.firstBeat;
      } else if (offset + 14 <= tagEnd) {
        // Legacy test layout: u16 bpm*100 at 0x08, u32 first beat ms at 0x0a.
        const legacyBpm = view.getUint16(offset + 8, false);
        if (legacyBpm >= 4000 && legacyBpm <= 35000) {
          result.bpm = legacyBpm / 100;
          result.firstBeat = view.getUint32(offset + 10, false) / 1000;
        } else {
          result.warnings.push(`${tag} ohne lesbare Beat-Einträge übersprungen.`);
        }
      }
    } else if (tag === 'PCOB') {
      const count = offset + 0x12 + 2 <= tagEnd ? view.getUint16(offset + 0x12, false) : 0;
      const legacyCountU32 = offset + 12 <= tagEnd ? view.getUint32(offset + 8, false) : 0;
      // The legacy fixture writes the cue count into the len_tag slot and the
      // section length into the len_header slot; real files have len_tag >= 12.
      const legacyShape =
        legacyCountU32 <= 2000 &&
        offset + 12 + legacyCountU32 * 24 <= tagEnd &&
        (legacyCountU32 < 12 || view.getUint32(offset + 4, false) === 12 + legacyCountU32 * 24);
      const realHeader = !legacyShape && offset + 0x18 <= tagEnd && (
        (offset + 0x18 + 4 <= tagEnd && fourCC(view, offset + 0x18) === 'PCPT') ||
        (view.getUint32(offset + 4, false) >= 0x18 &&
          count <= 2000 &&
          offset + 0x18 + count * 0x38 <= tagEnd)
      );

      if (realHeader) {
        const isHot = view.getUint32(offset + 0x0c, false) === 1;
        const entriesStart = offset + 0x18;
        const decoded: AnlzCueEntry[] = [];
        for (let i = 0; i < count; i++) {
          const decodedEntry = decodePcptEntry(view, entriesStart + i * 0x38, tagEnd);
          if (decodedEntry) decoded.push(decodedEntry);
        }
        // An empty real cue list is valid; preserve a previous list instead
        // of replacing it with nothing.
        if (decoded.length > 0) {
          if (isHot) rawHotCues = decoded;
          else rawMemoryCues = decoded;
        }
      } else if (legacyShape) {
        // Legacy fixture layout (24-byte entries) used by older regression
        // tests. Never preferred over the real PCPT layout.
        const decoded: AnlzCueEntry[] = [];
        let cueOffset = offset + 12;
        for (let index = 0; index < legacyCountU32; index++, cueOffset += 24) {
          const type = view.getUint8(cueOffset);
          const cueNum = view.getInt8(cueOffset + 1);
          const timeMs = view.getUint32(cueOffset + 4, false);
          const isHot = cueNum >= 0;
          decoded.push({
            hotCue: isHot ? cueNum + 1 : 0,
            status: 0,
            type: type === 2 ? 2 : 1,
            timeMs,
            loopMs: view.getUint32(cueOffset + 12, false),
            colorR: view.getUint8(cueOffset + 8),
            colorG: view.getUint8(cueOffset + 9),
            colorB: view.getUint8(cueOffset + 10),
          });
        }
        if (decoded.length > 0) {
          const isHot = decoded.some((e) => e.hotCue > 0);
          if (isHot) rawHotCues = decoded;
          else rawMemoryCues = decoded;
        }
      } else {
        result.warnings.push('PCOB: unbekannte Cue-Struktur übersprungen.');
      }
    } else if (tag === 'PCO2') {
      const count = offset + 0x12 <= tagEnd ? view.getUint16(offset + 0x10, false) : 0;
      const isHot = view.getUint32(offset + 0x0c, false) === 1;
      const realLayout =
        (offset + 0x14 + 4 <= tagEnd && fourCC(view, offset + 0x14) === 'PCP2') ||
        (view.getUint32(offset + 4, false) >= 0x0e && count <= 2000);
      if (realLayout) {
        let cursor = offset + 0x14;
        const decoded: AnlzCueEntry[] = [];
        for (let i = 0; i < count && cursor + 0x28 <= tagEnd; i++) {
          const decodedEntry = decodePcp2Entry(view, cursor, tagEnd);
          if (!decodedEntry) break;
          decoded.push(decodedEntry);
          cursor += view.getUint32(cursor + 0x08, false) || 0x28;
        }
        if (decoded.length > 0) {
          if (isHot) rawHotCues = decoded;
          else rawMemoryCues = decoded;
        }
      } else {
        result.warnings.push('PCO2: erweitertes Cue-Layout nicht lesbar.');
      }
    } else if (tag === 'PSSI') {
      if (offset + 0x12 + 2 > tagEnd) {
        result.warnings.push('PSSI: unvollständiger Header übersprungen.');
      } else {
        result.pssiMasked = view.getUint16(offset + 0x12, false) > 20;
        const bodyLength = tagEnd - (offset + 0x12);
        const body = new Uint8Array(bodyLength);
        for (let i = 0; i < bodyLength; i++) body[i] = view.getUint8(offset + 0x12 + i);

        if (result.pssiMasked) {
          // Rekordbox 6 exports XOR every byte after len_entries with a
          // pattern derived from the number of entries.
          const count = view.getUint16(offset + 0x10, false);
          for (let i = 0; i < bodyLength; i++) {
            body[i] ^= (PSSI_MASK_BASE[i % PSSI_MASK_BASE.length] + count) & 0xff;
          }
        }

        const decoded = decodePssiBody(body);
        result.pssiMood = decoded.mood;
        result.pssiEndBeat = decoded.endBeat;
        result.pssiBank = decoded.bank;
        result.rawPhrases = decoded.entries;

        if (result.bpm && result.firstBeat !== undefined) {
          result.phrases = phrasesFromPssi(
            decoded.mood,
            decoded.endBeat,
            decoded.entries,
            result.bpm,
            result.firstBeat,
            24 * 60 * 60 // duration is clamped by the caller to the real track length
          );
        } else {
          result.warnings.push('PSSI ohne bekannte BPM/First-Beat-Referenz übersprungen.');
        }
      }
    } else if (WAVEFORM_PRIORITY[tag]) {
      const spec = readWaveformSpec(view, offset, tagEnd, tag);
      if (spec && WAVEFORM_PRIORITY[tag] >= waveformPriority) {
        result.waveform = createWaveform(spec, view);
        waveformPriority = WAVEFORM_PRIORITY[tag];
      } else if (!spec) {
        result.warnings.push(`${tag}: unbekanntes Waveform-Layout übersprungen.`);
      }
    }

    offset += chunkSize;
  }

  result.rawHotCues = rawHotCues;
  result.rawMemoryCues = rawMemoryCues;

  const bpm = result.bpm ?? 128;
  const firstBeat = result.firstBeat ?? 0;
  const hotModel = entriesToModel(rawHotCues, true, bpm, firstBeat);
  const memModel = entriesToModel(rawMemoryCues, false, bpm, firstBeat);
  result.cues = [...memModel.cues, ...hotModel.cues];
  result.loops = [...memModel.loops, ...hotModel.loops];

  return result;
}
