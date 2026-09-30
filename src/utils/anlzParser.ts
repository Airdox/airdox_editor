export interface WaveformRGBFrame {
  low: number;   // Bässe (Rot) 0-255
  mid: number;   // Mitten (Grün) 0-255
  high: number;  // Höhen (Blau) 0-255
}

export interface BeatGridEntry {
  beatNumber: number;
  sampleOffset: number;
  bpm: number;
}

export interface ParsedANLZData {
  waveform3Band: WaveformRGBFrame[];
  beatGrid: BeatGridEntry[];
}

export class ANLZParser {
  static parse(buffer: ArrayBuffer): ParsedANLZData {
    const view = new DataView(buffer);
    let offset = 0;

    if (buffer.byteLength >= 8) {
      const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
      if (magic === 'PQA8' || magic === 'PQAI') {
        offset = 8;
      }
    }

    const waveform3Band: WaveformRGBFrame[] = [];
    const beatGrid: BeatGridEntry[] = [];

    while (offset + 8 <= buffer.byteLength) {
      const tagName = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
      const tagLength = view.getUint32(offset + 4, false);

      if (tagLength < 8 || offset + tagLength > buffer.byteLength) break;

      if (tagName === 'PWV5') {
        const entryCount = view.getUint32(offset + 16, false);
        const dataOffset = offset + 20;
        for (let i = 0; i < entryCount && (dataOffset + i * 3 + 2) < offset + tagLength; i++) {
          waveform3Band.push({
            low: view.getUint8(dataOffset + i * 3),
            mid: view.getUint8(dataOffset + i * 3 + 1),
            high: view.getUint8(dataOffset + i * 3 + 2),
          });
        }
      }

      offset += tagLength;
    }

    return { waveform3Band, beatGrid };
  }
}
