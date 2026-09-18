import assert from 'node:assert/strict';
import {
  PALETTE_CLIP_MIME,
  hasPaletteClipDrag,
  paletteDropTime,
  readPaletteClipDrag,
  writePaletteClipDrag,
} from '../src/utils/paletteDrag';

class DataTransferDouble {
  effectAllowed = 'uninitialized';
  private values = new Map<string, string>();
  get types(): string[] { return Array.from(this.values.keys()); }
  setData(type: string, value: string): void { this.values.set(type, value); }
  getData(type: string): string { return this.values.get(type) || ''; }
}

const transfer = new DataTransferDouble();
writePaletteClipDrag(transfer as unknown as DataTransfer, 'clip-42');
assert.equal(transfer.effectAllowed, 'copy', 'palette drag advertises copy semantics');
assert.equal(transfer.getData(PALETTE_CLIP_MIME), 'clip-42', 'private MIME carries clip identity');
assert.equal(readPaletteClipDrag(transfer as unknown as DataTransfer), 'clip-42');
assert.equal(hasPaletteClipDrag(transfer as unknown as DataTransfer), true);

const fallback = new DataTransferDouble();
fallback.setData('text/plain', 'airdox-palette-clip:fallback-7');
assert.equal(readPaletteClipDrag(fallback as unknown as DataTransfer), 'fallback-7', 'text fallback survives Electron drag boundary');

const arbitraryText = new DataTransferDouble();
arbitraryText.setData('text/plain', 'not an airdox clip');
assert.equal(readPaletteClipDrag(arbitraryText as unknown as DataTransfer), null, 'untrusted text is not interpreted as a clip');

assert.equal(paletteDropTime(350, 100, 500, 20, 10, 120), 25, 'pointer midpoint maps into visible timeline');
assert.equal(paletteDropTime(0, 100, 500, 20, 10, 120), 20, 'drop before canvas clamps to visible start');
assert.equal(paletteDropTime(900, 100, 500, 20, 10, 27), 27, 'drop after canvas clamps to track duration');
assert.equal(paletteDropTime(100, 100, 0, 20, 10, 120), 20, 'zero-width canvas safely uses view start');

console.log('palette drag/drop: payload, fallback and timeline mapping OK');
