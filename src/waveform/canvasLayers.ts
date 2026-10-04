import type { SelectionRange, TrackModel } from '../types/rekordbox';

/**
 * Dynamic overlay drawing for the detailed waveform canvas.
 *
 * The waveform, grid and markers are static between edits/view changes. Keep
 * transient selection, snap guide and playhead paint on transparent layers.
 */
export function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  currentTime: number,
  viewOffset: number,
  viewDuration: number,
  width: number,
  height: number
): void {
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0 || viewDuration <= 0) return;

  const x = ((currentTime - viewOffset) / viewDuration) * width;
  if (!Number.isFinite(x) || x < 0 || x > width) return;

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();

  // Small top triangle pointer, matching the existing Rekordbox-style marker.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(x - 4, 0);
  ctx.lineTo(x + 4, 0);
  ctx.lineTo(x, 6);
  ctx.closePath();
  ctx.fill();
}

export function drawSelectionOverlay(
  ctx: CanvasRenderingContext2D,
  selection: SelectionRange | null,
  viewOffset: number,
  viewDuration: number,
  width: number,
  height: number
): void {
  if (!selection || selection.duration <= 0 || width <= 0 || height <= 0 || viewDuration <= 0) return;

  const selX1 = ((selection.start - viewOffset) / viewDuration) * width;
  const selX2 = ((selection.end - viewOffset) / viewDuration) * width;
  if (selX2 <= 0 || selX1 >= width) return;

  const clampedX1 = Math.max(0, selX1);
  const clampedX2 = Math.min(width, selX2);
  ctx.fillStyle = 'rgba(0, 136, 255, 0.16)';
  ctx.fillRect(clampedX1, 18, clampedX2 - clampedX1, height - 18);

  ctx.strokeStyle = '#0088ff';
  ctx.lineWidth = 2;
  ctx.strokeRect(selX1, 18, selX2 - selX1, height - 20);

  const handleSize = 10;
  ctx.fillStyle = '#0088ff';
  ctx.beginPath();
  ctx.moveTo(selX1, 18);
  ctx.lineTo(selX1 + handleSize, 18);
  ctx.lineTo(selX1, 18 + handleSize);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(selX2, height - 2);
  ctx.lineTo(selX2 - handleSize, height - 2);
  ctx.lineTo(selX2, height - 2 - handleSize);
  ctx.closePath();
  ctx.fill();

  const infoBoxX = Math.min(width - 90, Math.max(selX1 + 10, selX2 - 85));
  ctx.fillStyle = 'rgba(8, 10, 15, 0.85)';
  ctx.fillRect(infoBoxX - 4, 24, 86, 46);
  ctx.strokeStyle = '#0088ff';
  ctx.lineWidth = 1;
  ctx.strokeRect(infoBoxX - 4, 24, 86, 46);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText(`${selection.barsCount.toFixed(1)} Bars`, infoBoxX + 76, 38);
  ctx.fillStyle = '#b0b5c5';
  ctx.font = '10px sans-serif';
  ctx.fillText(`${Math.round(selection.beatsCount)} Beats`, infoBoxX + 76, 52);
  const durationSeconds = Math.floor(selection.duration);
  ctx.fillText(`00:${durationSeconds.toString().padStart(2, '0')}`, infoBoxX + 76, 64);
  ctx.textAlign = 'left';
}

export function drawSnapGuide(
  ctx: CanvasRenderingContext2D,
  rawTime: number | null,
  beatGrid: TrackModel['beatGrid'] | null,
  snapTime: (time: number) => number,
  viewOffset: number,
  viewDuration: number,
  width: number,
  height: number
): void {
  if (rawTime === null || !beatGrid || width <= 0 || height <= 0 || viewDuration <= 0) return;

  const spb = 60.0 / beatGrid.bpm;
  const snappedTime = snapTime(rawTime);
  const snappedX = ((snappedTime - viewOffset) / viewDuration) * width;
  const rawX = ((rawTime - viewOffset) / viewDuration) * width;
  if (snappedX < 0 || snappedX > width) return;

  const beatIndex = Math.round((snappedTime - beatGrid.firstBeat) / spb);
  const isBar = beatIndex % beatGrid.meter === 0;
  const barNumber = Math.floor(beatIndex / beatGrid.meter) + 1;
  const beatInBar = ((beatIndex % beatGrid.meter) + beatGrid.meter) % beatGrid.meter + 1;

  const glowGradient = ctx.createLinearGradient(snappedX - 12, 0, snappedX + 12, 0);
  glowGradient.addColorStop(0, 'rgba(0, 229, 255, 0)');
  glowGradient.addColorStop(0.5, isBar ? 'rgba(0, 229, 255, 0.22)' : 'rgba(0, 229, 255, 0.12)');
  glowGradient.addColorStop(1, 'rgba(0, 229, 255, 0)');
  ctx.fillStyle = glowGradient;
  ctx.fillRect(snappedX - 12, 18, 24, height - 18);

  ctx.strokeStyle = isBar ? '#00e5ff' : '#00b4d8';
  ctx.lineWidth = isBar ? 1.8 : 1.2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(snappedX, 18);
  ctx.lineTo(snappedX, height);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#00e5ff';
  ctx.beginPath();
  ctx.moveTo(snappedX - 4, 18);
  ctx.lineTo(snappedX + 4, 18);
  ctx.lineTo(snappedX, 23);
  ctx.closePath();
  ctx.fill();

  if (Math.abs(rawX - snappedX) > 2) {
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(rawX, height - 12);
    ctx.lineTo(snappedX, height - 12);
    ctx.stroke();
  }

  const badgeText = `${isBar ? `BAR ${barNumber}` : `B${barNumber}.${beatInBar}`} • ${snappedTime.toFixed(2)}s`;
  ctx.font = 'bold 9.5px monospace';
  const badgeWidth = ctx.measureText(badgeText).width + 12;
  const badgeX = Math.max(4, Math.min(width - badgeWidth - 4, snappedX - badgeWidth / 2));
  ctx.fillStyle = 'rgba(10, 15, 24, 0.92)';
  ctx.fillRect(badgeX, 3, badgeWidth, 14);
  ctx.strokeStyle = isBar ? '#00e5ff' : '#0096c7';
  ctx.lineWidth = 1;
  ctx.strokeRect(badgeX, 3, badgeWidth, 14);
  ctx.fillStyle = isBar ? '#ffffff' : '#90e0ef';
  ctx.fillText(badgeText, badgeX + 6, 13.5);
}
