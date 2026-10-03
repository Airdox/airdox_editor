/**
 * GENERATED FILE – DO NOT EDIT.
 * Build: npm run build:anlz-structure
 * Source: src/rekordbox/anlzStructure.ts (single source of truth for the
 * Rekordbox ANLZ container structure shared with the renderer parser).
 */
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/rekordbox/anlzStructure.ts
var anlzStructure_exports = {};
__export(anlzStructure_exports, {
  ANLZ_EXTENSIONS: () => ANLZ_EXTENSIONS,
  WAVEFORM_PRIORITY: () => WAVEFORM_PRIORITY,
  WAVEFORM_TAGS: () => WAVEFORM_TAGS,
  decodeAnlzWaveform: () => decodeAnlzWaveform,
  decodeAnlzWaveformColumns: () => decodeAnlzWaveformColumns,
  readAnlzUtf16Be: () => readAnlzUtf16Be,
  readAnlzWaveformSpec: () => readAnlzWaveformSpec,
  scanAnlzSections: () => scanAnlzSections,
  summarizeAnlzWaveformColumns: () => summarizeAnlzWaveformColumns,
  toAnlzDataView: () => toAnlzDataView
});
module.exports = __toCommonJS(anlzStructure_exports);
var WAVEFORM_TAGS = Object.freeze([
  "PWAV",
  "PWV2",
  "PWV3",
  "PWV4",
  "PWV5",
  "PWV6",
  "PWV7"
]);
var ANLZ_EXTENSIONS = Object.freeze([".dat", ".ext", ".2ex"]);
var WAVEFORM_PRIORITY = Object.freeze({
  PWV5: 7,
  PWV7: 6,
  PWV4: 5,
  PWV6: 4,
  PWV3: 3,
  PWAV: 2,
  PWV2: 1
});
function toAnlzDataView(input) {
  if (input instanceof ArrayBuffer) {
    const bytes2 = new Uint8Array(input);
    return { bytes: bytes2, view: new DataView(input) };
  }
  if (ArrayBuffer.isView(input)) {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    return { bytes: new Uint8Array(input.buffer, input.byteOffset, input.byteLength), view };
  }
  const bytes = new Uint8Array(input);
  return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}
function isPrintableTag(value) {
  return /^[\x20-\x7e]{4}$/.test(value);
}
function readAnlzUtf16Be(view, offset, byteLength) {
  if (byteLength < 2) {
    let out = "";
    for (let i = 0; i < byteLength; i++) out += String.fromCharCode(view.getUint8(offset + i));
    return out.replace(/\0+$/, "");
  }
  const chars = [];
  const end = Math.min(offset + byteLength, view.byteLength - 1);
  for (let p = offset; p + 1 <= end; p += 2) {
    const code = view.getUint8(p) << 8 | view.getUint8(p + 1);
    if (code === 0) break;
    chars.push(code);
  }
  return String.fromCharCode(...chars);
}
function readAnlzWaveformSpec(view, offset, tagEnd, tag) {
  if (tag === "PWV5") {
    const legacyCount = view.getUint32(offset + 8, false);
    if (legacyCount > 0 && legacyCount <= 2e4 && offset + 12 + legacyCount * 3 <= tagEnd) {
      return {
        tag,
        entryBytes: 3,
        entryCount: legacyCount,
        dataOffset: offset + 12,
        style: "TRIPLE_BYTE"
      };
    }
  }
  const lenHeader = view.getUint32(offset + 4, false);
  if (tag === "PWAV" || tag === "PWV2") {
    if (lenHeader < 20 || offset + 20 > tagEnd) return null;
    const lenData = view.getUint32(offset + 12, false);
    if (lenData === 0 || offset + 20 + lenData > tagEnd) return null;
    return {
      tag,
      entryBytes: 1,
      entryCount: lenData,
      dataOffset: offset + 20,
      style: tag === "PWAV" ? "MONO_5BIT" : "MONO_4BIT"
    };
  }
  if (tag === "PWV6") {
    if (lenHeader < 20 || offset + 20 > tagEnd) return null;
    const entryBytes2 = view.getUint32(offset + 12, false);
    const entryCount2 = view.getUint32(offset + 16, false);
    if (entryBytes2 !== 3 || entryCount2 === 0 || entryCount2 > 5e5 || offset + 20 + entryBytes2 * entryCount2 > tagEnd) {
      return null;
    }
    return { tag, entryBytes: entryBytes2, entryCount: entryCount2, dataOffset: offset + 20, style: "TRIPLE_BYTE" };
  }
  if (offset + 24 > tagEnd) return null;
  const entryBytes = view.getUint32(offset + 12, false);
  const entryCount = view.getUint32(offset + 16, false);
  const dataOffset = offset + 24;
  if (entryBytes === 0 || entryCount === 0 || entryCount > 5e5 || dataOffset + entryBytes * entryCount > tagEnd) {
    return null;
  }
  if (tag === "PWV3" && entryBytes === 1) {
    return { tag, entryBytes, entryCount, dataOffset, style: "MONO_5BIT" };
  }
  if (tag === "PWV4" && entryBytes === 6) {
    return { tag, entryBytes, entryCount, dataOffset, style: "COLOR_6BYTE" };
  }
  if (tag === "PWV5" && entryBytes === 2) {
    return { tag, entryBytes, entryCount, dataOffset, style: "RGB_5BIT" };
  }
  if (tag === "PWV7" && entryBytes === 3) {
    return { tag, entryBytes, entryCount, dataOffset, style: "TRIPLE_BYTE" };
  }
  return null;
}
function decodeAnlzWaveformColumns(view, spec) {
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
    if (style === "MONO_5BIT") {
      const value = view.getUint8(p);
      peak = (value & 31) / 31;
      low = mid = high = peak;
    } else if (style === "MONO_4BIT") {
      peak = (view.getUint8(p) & 15) / 15;
      low = mid = high = peak;
    } else if (style === "RGB_5BIT") {
      const value = view.getUint16(p, false);
      low = (value >> 13 & 7) / 7;
      mid = (value >> 10 & 7) / 7;
      high = (value >> 7 & 7) / 7;
      peak = (value >> 2 & 31) / 31;
    } else if (style === "TRIPLE_BYTE") {
      mid = view.getUint8(p) / 255;
      high = view.getUint8(p + 1) / 255;
      low = view.getUint8(p + 2) / 255;
      peak = Math.max(low, mid, high);
    } else if (style === "COLOR_6BYTE") {
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
function summarizeAnlzWaveformColumns(columns) {
  let peakMax = 0;
  let nonZeroBuckets = 0;
  for (let i = 0; i < columns.peaks.length; i++) {
    const value = columns.peaks[i];
    if (value > peakMax) peakMax = value;
    if (value > 0) nonZeroBuckets++;
  }
  return { length: columns.length, peakMax, nonZeroBuckets };
}
function scanAnlzSections(input) {
  const { view } = toAnlzDataView(input);
  const len = view.byteLength;
  const base = {
    valid: false,
    tags: [],
    sections: [],
    hasWaveform: false,
    truncated: false,
    byteLength: len
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
  if (firstTag === "PMAI") {
    const headerLength = view.getUint32(4, false);
    offset = headerLength >= 12 && headerLength <= len ? headerLength : 0;
  } else if (!isPrintableTag(firstTag)) {
    return { ...base, reason: "Erstes ANLZ-Sektionstag ist kein lesbares 4-Byte-Tag." };
  }
  const sections = [];
  let ppthPath;
  let waveform;
  let waveformPriority = 0;
  let stopReason;
  const finish = (reason) => {
    if (sections.length === 0) {
      return { ...base, reason: reason || "Keine ANLZ-Sektionen konnten gelesen werden." };
    }
    return {
      valid: true,
      tags: sections.map((section) => section.tag),
      sections,
      hasWaveform: sections.some((section) => WAVEFORM_TAGS.includes(section.tag)),
      truncated: true,
      ppthPath,
      waveform,
      byteLength: len
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
      stopReason = "Unerwartete Bytes statt eines ANLZ-Sektionstags.";
      break;
    }
    if (tag === "PMAI") {
      const pmaiHeaderLen = view.getUint32(offset + 4, false);
      if (pmaiHeaderLen >= 12 && offset + pmaiHeaderLen <= len) {
        offset += pmaiHeaderLen;
        continue;
      }
      stopReason = "Eingebetteter PMAI-Header der ANLZ-Datei ist ung\xFCltig.";
      break;
    }
    const lenHeader = view.getUint32(offset + 4, false);
    const lenTag = view.getUint32(offset + 8, false);
    let chunkSize = lenTag;
    if (tag === "PWV5" && lenTag >= 1 && lenTag <= 2e4 && lenHeader === 12 + lenTag * 3) {
      chunkSize = lenHeader;
    }
    if (chunkSize < 12 || offset + chunkSize > len) chunkSize = lenHeader;
    if (chunkSize < 12 || offset + chunkSize > len) {
      stopReason = "Sektionsl\xE4nge der ANLZ-Datei ist ung\xFCltig.";
      break;
    }
    const section = { tag, offset, size: chunkSize, headerLength: lenHeader, tagLength: lenTag };
    const tagEnd = offset + chunkSize;
    if (tag === "PPTH" && offset + 16 <= tagEnd && !ppthPath) {
      const byteLength = view.getUint32(offset + 12, false);
      if (byteLength > 0 && byteLength <= tagEnd - (offset + 16)) {
        const decoded = readAnlzUtf16Be(view, offset + 16, byteLength);
        if (decoded.trim()) ppthPath = decoded.replace(/\0+$/, "").trim();
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
    return { ...base, reason: stopReason || "Keine ANLZ-Sektionen konnten gelesen werden." };
  }
  return {
    valid: true,
    tags: sections.map((section) => section.tag),
    sections,
    hasWaveform: sections.some((section) => WAVEFORM_TAGS.includes(section.tag)),
    truncated: offset < len,
    ppthPath,
    waveform,
    byteLength: len
  };
}
function decodeAnlzWaveform(input) {
  const { view } = toAnlzDataView(input);
  const scan = scanAnlzSections(input);
  if (!scan.waveform) return { scan };
  const columns = decodeAnlzWaveformColumns(view, scan.waveform);
  return { scan, columns, summary: summarizeAnlzWaveformColumns(columns) };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ANLZ_EXTENSIONS,
  WAVEFORM_PRIORITY,
  WAVEFORM_TAGS,
  decodeAnlzWaveform,
  decodeAnlzWaveformColumns,
  readAnlzUtf16Be,
  readAnlzWaveformSpec,
  scanAnlzSections,
  summarizeAnlzWaveformColumns,
  toAnlzDataView
});
