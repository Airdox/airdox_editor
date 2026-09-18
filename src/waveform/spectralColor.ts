/**
 * Rekordbox-authentic RGB spectral colouring.
 *
 * In original rekordbox the RGB waveform derives every column's colour from
 * the actual frequency content at that position:
 *   - low band (kicks/bass)      -> red
 *   - mid band (vocals/synths)   -> green (mixes with red to orange/yellow)
 *   - high band (hats/air)       -> blue (vocal/airy breaks look blue/violet)
 *
 * A drop therefore reads as a saturated red body while a break or vocal-only
 * intro reads blue/pink — exactly the visual language DJs rely on to spot
 * song sections at a glance. A single static gradient can never show this.
 */
export function spectralRgb(low: number, mid: number, high: number): string {
  const r = Math.min(255, Math.round(low * 255 + mid * 70));
  const g = Math.min(255, Math.round(mid * 240 + high * 60));
  const b = Math.min(255, Math.round(high * 255 + low * 30));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Brighter core tone of the same spectral mix, used for the inner highlight
 * pass that gives the rekordbox waveform its glowing centre.
 */
export function spectralRgbCore(low: number, mid: number, high: number): string {
  const r = Math.min(255, Math.round(low * 255 + mid * 70 + 90));
  const g = Math.min(255, Math.round(mid * 240 + high * 60 + 90));
  const b = Math.min(255, Math.round(high * 255 + low * 30 + 90));
  return `rgb(${r}, ${g}, ${b})`;
}
