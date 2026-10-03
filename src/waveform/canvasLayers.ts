/**
 * Dynamic overlay drawing for the detailed waveform canvas.
 *
 * The waveform, grid and markers are static between edits/view changes. Keep
 * the playhead on a separate, transparent canvas so transport ticks do not
 * require repainting the full waveform.
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
