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
 * The *container envelope* (PMAI header, section walk, PPTH string, waveform
 * layouts and their decoding) lives in ./anlzStructure — the single module
 * shared with the Electron master.db gate, so "the gate accepted this file"
 * and "this parser decodes a waveform from it" describe the same bytes.
 * This file only adds the section *content* decoders on top of that walk.
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
import { logger } from '../utils/logger';
import {
  AnlzSection,
  AnlzWaveformDescriptor,
  decodeAnlzWaveformColumns,
  readAnlzUtf16Be,
  readAnlzWaveformSpec,
  scanAnlzSections,
  WAVEFORM_PRIORITY,
} from './anlzStructure';

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
  /** Section tag the waveform was decoded from (PWAV / PWV2..PWV7). */
  waveformTag?: string;
  /** Highest decoded peak; 0 means the container carried no amplitude data. */
  waveformPeakMax?: number;
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

/** Decoded ANLZ bytes wrapped as the track's native waveform analysis. */
function createWaveform(spec: AnlzWaveformDescriptor, view: DataView): WaveformAnalysisData {
  const columns = decodeAnlzWaveformColumns(view, spec);
  return {
    length: columns.length,
    peaks: columns.peaks,
    peaksL: columns.peaksL,
    peaksR: columns.peaksR,
    lowEnergy: columns.lowEnergy,
    midEnergy: columns.midEnergy,
    highEnergy: columns.highEnergy,
    origin: DataOrigin.REKORDBOX_ANLZ,
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
      parsed.comment = readAnlzUtf16Be(view, entry + 0x2c, lenComment);
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

  const len = buffer.byteLength;
  // The container walk is shared with the Electron master.db gate
  // (./anlzStructure ↔ electron/generated/anlzStructure.cjs).
  const scan = scanAnlzSections(buffer);
  if (!scan.valid) {
    result.warnings.push(scan.reason || 'Ungültige ANLZ-Struktur.');
    logger.warn('XML_IMPORT', `ANLZ-Datei nicht lesbar: ${scan.reason || 'unbekannt'}`, {
      byteLength: len,
    });
    return result;
  }
  if (scan.truncated) {
    result.warnings.push(
      'ANLZ-Sektionen wurden vor dem Dateiende gelesen; der Rest der Datei wurde nicht ausgewertet.'
    );
  }
  result.tagsFound = scan.tags;
  if (scan.ppthPath) result.analysisPath = scan.ppthPath;

  // Track the best cue list per category so that PCO2 (if present) takes
  // priority over PCOB, and hot/memory lists are merged.
  let rawMemoryCues: AnlzCueEntry[] = [];
  let rawHotCues: AnlzCueEntry[] = [];
  let beatGrid: BeatGrid | undefined;

  for (const section of scan.sections as AnlzSection[]) {
    const tag = section.tag;
    const offset = section.offset;
    const tagEnd = offset + section.size;
    const lenHeader = section.headerLength;
    const lenTag = section.tagLength;

    if (tag === 'PPTH') {
      // Already decoded by the shared walk into scan.ppthPath.
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
      const legacyCountU32 = lenTag;
      // The legacy fixture writes the cue count into the len_tag slot and the
      // section length into the len_header slot; real files have len_tag >= 12.
      const legacyShape =
        legacyCountU32 <= 2000 &&
        offset + 12 + legacyCountU32 * 24 <= tagEnd &&
        (legacyCountU32 < 12 || lenHeader === 12 + legacyCountU32 * 24);
      const realHeader = !legacyShape && offset + 0x18 <= tagEnd && (
        (offset + 0x18 + 4 <= tagEnd && fourCC(view, offset + 0x18) === 'PCPT') ||
        (lenHeader >= 0x18 &&
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
        (lenHeader >= 0x0e && count <= 2000);
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
      const spec = readAnlzWaveformSpec(view, offset, tagEnd, tag);
      if (!spec) {
        result.warnings.push(`${tag}: unbekanntes Waveform-Layout übersprungen.`);
      } else if (
        // Decode exactly the section the shared walk selected, so the gate
        // (electron/masterDbGate.cjs) and this parser agree on one waveform.
        scan.waveform &&
        scan.waveform.dataOffset >= offset &&
        scan.waveform.dataOffset < tagEnd
      ) {
        result.waveform = createWaveform(spec, view);
        result.waveformTag = tag;
      }
    }
  }

  result.rawHotCues = rawHotCues;
  result.rawMemoryCues = rawMemoryCues;

  if (result.waveform) {
    let peakMax = 0;
    for (let i = 0; i < result.waveform.peaks.length; i++) {
      const value = result.waveform.peaks[i];
      if (value > peakMax) peakMax = value;
    }
    result.waveformPeakMax = peakMax;
  }

  const bpm = result.bpm ?? 128;
  const firstBeat = result.firstBeat ?? 0;
  const hotModel = entriesToModel(rawHotCues, true, bpm, firstBeat);
  const memModel = entriesToModel(rawMemoryCues, false, bpm, firstBeat);
  result.cues = [...memModel.cues, ...hotModel.cues];
  result.loops = [...memModel.loops, ...hotModel.loops];

  logger.debug('XML_IMPORT', `ANLZ binär geparst (${(len / 1024).toFixed(1)} KB)`, {
    byteLength: len,
    tags: result.tagsFound,
    cues: result.cues.length,
    loops: result.loops.length,
    phrases: result.phrases.length,
    bpm: result.bpm,
    hasWaveform: Boolean(result.waveform),
    waveformTag: result.waveformTag,
    waveformBuckets: result.waveform?.length,
    warnings: result.warnings,
  });

  return result;
}
