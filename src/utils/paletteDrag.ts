export const PALETTE_CLIP_MIME = 'application/x-airdox-palette-clip';
const TEXT_PREFIX = 'airdox-palette-clip:';

/** Writes both a private MIME payload and a text fallback for Electron/Chromium. */
export function writePaletteClipDrag(dataTransfer: DataTransfer, clipId: string): void {
  if (!clipId) throw new Error('A palette drag requires a clip id.');
  dataTransfer.effectAllowed = 'copy';
  dataTransfer.setData(PALETTE_CLIP_MIME, clipId);
  dataTransfer.setData('text/plain', `${TEXT_PREFIX}${clipId}`);
}

/** Reads only app-owned palette payloads; arbitrary text drops are ignored. */
export function readPaletteClipDrag(dataTransfer: DataTransfer): string | null {
  const privateId = dataTransfer.getData(PALETTE_CLIP_MIME).trim();
  if (privateId) return privateId;
  const text = dataTransfer.getData('text/plain').trim();
  return text.startsWith(TEXT_PREFIX) && text.length > TEXT_PREFIX.length
    ? text.slice(TEXT_PREFIX.length)
    : null;
}

export function hasPaletteClipDrag(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(dataTransfer.types || []).some(
    (type) => type === PALETTE_CLIP_MIME || type === 'text/plain'
  );
}

/** Converts the pointer to the visible timeline and clamps it to the track. */
export function paletteDropTime(
  clientX: number,
  canvasLeft: number,
  canvasWidth: number,
  viewOffset: number,
  viewDuration: number,
  trackDuration: number
): number {
  if (!Number.isFinite(canvasWidth) || canvasWidth <= 0) return Math.max(0, Math.min(trackDuration, viewOffset));
  const ratio = Math.max(0, Math.min(1, (clientX - canvasLeft) / canvasWidth));
  return Math.max(0, Math.min(trackDuration, viewOffset + ratio * viewDuration));
}
