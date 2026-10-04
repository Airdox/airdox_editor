/**
 * Dynamic overlay drawing for the detailed waveform canvas.
 *
 * The waveform, grid and markers are static between edits/view changes. Keep
 * the playhead on a separate, transparent canvas so transport ticks do not
 * require repainting the full waveform.
 *
 * Einzige Implementierung des Playhead-Strichs: sowohl die reine Playhead-Ebene
 * als auch das zusammengesetzte Overlay der Detail-Wellenform nutzen sie
 * (`clear: false`), damit die Linie nicht an zwei Stellen leicht abweichend
 * gezeichnet wird.
 */
export interface DrawPlayheadOptions {
  /**
   * Vor dem Zeichnen die Ebene leeren. Standard `true` (eigene Overlay-Ebene).
   * Im zusammengesetzten Overlay der Detail-Wellenform wird vorher schon einmal
   * geleert – dort wird die Funktion mit `clear: false` aufgerufen, weil sonst
   * Auswahl, Hover-Führung und Snap-Badge überschrieben würden.
   */
  clear?: boolean;
}

export function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  currentTime: number,
  viewOffset: number,
  viewDuration: number,
  width: number,
  height: number,
  options: DrawPlayheadOptions = {}
): void {
  if (options.clear !== false) ctx.clearRect(0, 0, width, height);
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
