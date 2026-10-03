/**
 * @license
 * Rekordbox ANLZ container structure — single source of truth.
 *
 * This module owns the *envelope* of a Rekordbox analysis file
 * (.DAT / .EXT / .2EX): the PMAI file header, the 4-byte section tag walk,
 * the per-section length rules, the PPTH source-path decoding and the
 * PWAV / PWV2..PWV7 waveform layout recognition.
 *
 * It is deliberately free of any application type (no `DataOrigin`, no
 * `TrackModel`, no `logger`, no DOM and no Node API) so that exactly one
 * implementation can be used by
 *
 *   a) the renderer parser  → `src/rekordbox/anlzParser.ts` (TypeScript), and
 *   b) the Electron master.db gate → `electron/masterDbGate.cjs` through the
 *      generated CommonJS mirror `electron/generated/anlzStructure.cjs`
 *      (`npm run build:anlz-structure`).
 *
 * The byte layouts follow the independently documented format analysis by the
 * Deep Symmetry project (djl-analysis.deepsymmetry.org) and the Kaitai Struct
 * specification in crate-digger. Every value in an ANLZ file is big endian.
 * The legacy fixture layout used by the project's older regression tests
 * (section length only in the len_header slot) stays supported as an explicitly
 * labelled fallback and never takes priority over the real layout.
 *
 * Nothing here computes a waveform from audio: decoding only turns bytes that
 * Rekordbox wrote into columns. There is no FFT, no beat detection and no
 * analysis of any kind in this file.
 */

/** Waveform sections of the documented ANLZ format (Deep Symmetry). */
export const WAVEFORM_TAGS: readonly string[] = Object.freeze([
  'PWAV',
  'PWV2',
  'PWV3',
  'PWV4',
  'PWV5',
  'PWV6',
  'PWV7',
]);

/** Rekordbox analysis file extensions written to `djmdContent.AnalysisDataPath`. */
export const ANLZ_EXTENSIONS: readonly string[] = Object.freeze(['.dat', '.ext', '.2ex']);

/** Highest priority wins when a container carries more than one waveform. */
export const WAVEFORM_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  PWV5: 7,
  PWV7: 6,
  PWV4: 5,
  PWV6: 4,
  PWV3: 3,
  PWAV: 2,
  PWV2: 1,
});

export type WaveformStyle =
  | 'MONO_5BIT'
  | 'MONO_4BIT'
  | 'RGB_5BIT'
  | 'TRIPLE_BYTE'
  | 'COLOR_6BYTE';

export interface AnlzSection {
  /** 4-byte ASCII tag. */
  tag: string;
  /** Byte offset of the section inside the file. */
  offset: number;
  /** Total section length actually used for the walk (len_tag, or len_header). */
  size: number;
  /** u32-BE at +4. */
  headerLength: number;
  /** u32-BE at +8. */
  tagLength: number;
}

export interface AnlzWaveformDescriptor {
  tag: string;
  entryBytes: number;
  entryCount: number;
  /** Absolute byte offset of the first waveform entry. */
  dataOffset: number;
  style: WaveformStyle;
}

export interface AnlzScanResult {
  /** True when at least one section could be walked. */
  valid: boolean;
  /** Present when the walk stopped early or found nothing. */
  reason?: string;
  /** Walked section tags in file order (the PMAI file header is not a section). */
  tags: string[];
  sections: AnlzSection[];
  /** True when a PWAV/PWV2..PWV7 tag is present, independent of decodability. */
  hasWaveform: boolean;
  /** True when the walk stopped before the end of the file. */
  truncated: boolean;
  /** Source audio path recorded by Rekordbox in the PPTH section (UTF-16BE). */
  ppthPath?: string;
  /** Highest-priority waveform section whose layout could be read. */
  waveform?: AnlzWaveformDescriptor;
  byteLength: number;
}

export interface AnlzWaveformColumns {
  length: number;
  peaks: Float32Array;
  peaksL: Float32Array;
  peaksR: Float32Array;
  lowEnergy: Float32Array;
  midEnergy: Float32Array;
  highEnergy: Float32Array;
}

export interface AnlzWaveformSummary {
  length: number;
  /** Highest decoded peak value; 0 means "no usable amplitude data". */
  peakMax: number;
  /** Number of buckets with an amplitude above zero. */
  nonZeroBuckets: number;
}

/** Normalizes ArrayBuffer / TypedArray / Buffer into a byte view + DataView. */
export function toAnlzDataView(input: ArrayBuffer | ArrayBufferView | Uint8Array): {
  bytes: Uint8Array;
  view: DataView;
} {
  if (input instanceof ArrayBuffer) {
    const bytes = new Uint8Array(input);
    return { bytes, view: new DataView(input) };
  }
  if (ArrayBuffer.isView(input)) {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    return { bytes: new Uint8Array(input.buffer, input.byteOffset, input.byteLength), view };
  }
  const bytes = new Uint8Array(input as Uint8Array);
  return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

function isPrintableTag(value: string): boolean {
  return /^[\x20-\x7e]{4}$/.test(value);
}

/** UTF-16BE string used by PPTH (source path) and PCP2 (cue comment). */
export function readAnlzUtf16Be(view: DataView, offset: number, byteLength: number): string {
  if (byteLength < 2) {
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

/**
 * Reads the PWAV/PWV2..PWV7 payload layout of one section.
 *
 * Returns null when the section does not carry a waveform layout this module
 * understands; the caller decides what that means for the gate/parse result.
 */
export function readAnlzWaveformSpec(
  view: DataView,
  offset: number,
  tagEnd: number,
  tag: string
): AnlzWaveformDescriptor | null {
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
        tag,
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
      tag,
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
    return { tag, entryBytes, entryCount, dataOffset: offset + 0x14, style: 'TRIPLE_BYTE' };
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
  if (tag === 'PWV3' && entryBytes === 1) {
    return { tag, entryBytes, entryCount, dataOffset, style: 'MONO_5BIT' };
  }
  if (tag === 'PWV4' && entryBytes === 6) {
    return { tag, entryBytes, entryCount, dataOffset, style: 'COLOR_6BYTE' };
  }
  if (tag === 'PWV5' && entryBytes === 2) {
    return { tag, entryBytes, entryCount, dataOffset, style: 'RGB_5BIT' };
  }
  if (tag === 'PWV7' && entryBytes === 3) {
    return { tag, entryBytes, entryCount, dataOffset, style: 'TRIPLE_BYTE' };
  }
  return null;
}

/**
 * Decodes the Rekordbox-written waveform bytes into normalized columns.
 * This is a pure reinterpretation of the container payload – no audio is read
 * and no spectral data is computed.
 */
export function decodeAnlzWaveformColumns(
  view: DataView,
  spec: AnlzWaveformDescriptor
): AnlzWaveformColumns {
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

  return { length: entryCount, peaks, peaksL, peaksR, lowEnergy, midEnergy, highEnergy };
}

/** Cheap numeric proof that a decoded waveform really carries amplitude data. */
export function summarizeAnlzWaveformColumns(columns: AnlzWaveformColumns): AnlzWaveformSummary {
  let peakMax = 0;
  let nonZeroBuckets = 0;
  for (let i = 0; i < columns.peaks.length; i++) {
    const value = columns.peaks[i];
    if (value > peakMax) peakMax = value;
    if (value > 0) nonZeroBuckets++;
  }
  return { length: columns.length, peakMax, nonZeroBuckets };
}

/**
 * Walks the ANLZ section envelope of a complete analysis file.
 *
 * Envelope per section: 4-byte tag, u32-BE len_header @+4, u32-BE len_tag @+8,
 * with len_header used as fallback for writers that only fill one slot. An
 * optional PMAI file header is skipped first. The walk is strict: a byte range
 * that cannot be a section ends the walk, and everything read so far is
 * reported with `truncated: true`.
 */
export function scanAnlzSections(
  input: ArrayBuffer | ArrayBufferView | Uint8Array
): AnlzScanResult {
  const { view } = toAnlzDataView(input);
  const len = view.byteLength;
  const base: AnlzScanResult = {
    valid: false,
    tags: [],
    sections: [],
    hasWaveform: false,
    truncated: false,
    byteLength: len,
  };

  if (len < 12) {
    return { ...base, reason: `ANLZ-Datei ist kleiner als 12 Bytes (${len}).` };
  }

  let offset = 0;
  const firstTag = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (firstTag === 'PMAI') {
    const headerLength = view.getUint32(4, false);
    offset = headerLength >= 12 && headerLength <= len ? headerLength : 0;
  } else if (!isPrintableTag(firstTag)) {
    return { ...base, reason: 'Erstes ANLZ-Sektionstag ist kein lesbares 4-Byte-Tag.' };
  }

  const sections: AnlzSection[] = [];
  let ppthPath: string | undefined;
  let waveform: AnlzWaveformDescriptor | undefined;
  let waveformPriority = 0;
  let stopReason: string | undefined;

  const finish = (reason?: string): AnlzScanResult => {
    if (sections.length === 0) {
      return { ...base, reason: reason || 'Keine ANLZ-Sektionen konnten gelesen werden.' };
    }
    return {
      valid: true,
      tags: sections.map((section) => section.tag),
      sections,
      hasWaveform: sections.some((section) => WAVEFORM_TAGS.includes(section.tag)),
      truncated: true,
      ppthPath,
      waveform,
      byteLength: len,
    };
  };

  while (offset + 12 <= len) {
    const tag = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    if (!isPrintableTag(tag)) {
      stopReason = 'Unerwartete Bytes statt eines ANLZ-Sektionstags.';
      break;
    }
    if (tag === 'PMAI') {
      // Multi-container ANLZ bundle (.DAT + .EXT + .2EX concatenated in memory):
      // skip the 28/32-byte PMAI file header of the companion container so its
      // sections (PWV5, PCO2, PSSI, PWV7) are walked in the same pass.
      const pmaiHeaderLen = view.getUint32(offset + 4, false);
      if (pmaiHeaderLen >= 12 && offset + pmaiHeaderLen <= len) {
        offset += pmaiHeaderLen;
        continue;
      }
      stopReason = 'Eingebetteter PMAI-Header der ANLZ-Datei ist ungültig.';
      break;
    }
    const lenHeader = view.getUint32(offset + 4, false);
    const lenTag = view.getUint32(offset + 8, false);
    let chunkSize = lenTag;
    // Legacy PWV5 fixture: u32 entry count in the len_tag slot; the real
    // section length lives in the len_header slot (12 + count * 3).
    if (tag === 'PWV5' && lenTag >= 1 && lenTag <= 20_000 && lenHeader === 12 + lenTag * 3) {
      chunkSize = lenHeader;
    }
    if (chunkSize < 12 || offset + chunkSize > len) chunkSize = lenHeader;
    if (chunkSize < 12 || offset + chunkSize > len) {
      stopReason = 'Sektionslänge der ANLZ-Datei ist ungültig.';
      break;
    }

    const section: AnlzSection = { tag, offset, size: chunkSize, headerLength: lenHeader, tagLength: lenTag };
    const tagEnd = offset + chunkSize;

    if (tag === 'PPTH' && offset + 0x10 <= tagEnd && !ppthPath) {
      const byteLength = view.getUint32(offset + 0x0c, false);
      if (byteLength > 0 && byteLength <= tagEnd - (offset + 0x10)) {
        const decoded = readAnlzUtf16Be(view, offset + 0x10, byteLength);
        if (decoded.trim()) ppthPath = decoded.replace(/\0+$/, '').trim();
      }
    }

    const priority = WAVEFORM_PRIORITY[tag];
    if (priority && priority >= waveformPriority) {
      const spec = readAnlzWaveformSpec(view, offset, tagEnd, tag);
      if (spec) {
        waveform = spec;
        waveformPriority = priority;
      }
    }

    sections.push(section);
    offset += chunkSize;
  }

  if (sections.length === 0) {
    return { ...base, reason: stopReason || 'Keine ANLZ-Sektionen konnten gelesen werden.' };
  }
  return {
    valid: true,
    tags: sections.map((section) => section.tag),
    sections,
    hasWaveform: sections.some((section) => WAVEFORM_TAGS.includes(section.tag)),
    truncated: offset < len,
    ppthPath,
    waveform,
    byteLength: len,
  };
}

/**
 * Decodes the waveform the editor will actually display and reports the numeric
 * proof of the decode. The master.db gate uses this so that "the gate accepted
 * this ANLZ" and "the renderer could decode a waveform from it" are the same
 * statement about the same bytes.
 */
export function decodeAnlzWaveform(
  input: ArrayBuffer | ArrayBufferView | Uint8Array
): { scan: AnlzScanResult; columns?: AnlzWaveformColumns; summary?: AnlzWaveformSummary } {
  const { view } = toAnlzDataView(input);
  const scan = scanAnlzSections(input);
  if (!scan.waveform) return { scan };
  const columns = decodeAnlzWaveformColumns(view, scan.waveform);
  return { scan, columns, summary: summarizeAnlzWaveformColumns(columns) };
}
