/**
 * Per-column RGB spectral color for waveform
 */

export interface SpectralColor {
  r: number;
  g: number;
  b: number;
}

export function getSpectralColor(low: number, mid: number, high: number): SpectralColor {
  // Map low/mid/high to RGB (Rekordbox style: low=red, mid=green, high=blue with some mixing)
  const r = Math.min(255, Math.floor((low * 0.8 + mid * 0.2) * 255));
  const g = Math.min(255, Math.floor((mid * 0.7 + low * 0.3) * 255));
  const b = Math.min(255, Math.floor((high * 0.8 + mid * 0.2) * 255));
  return { r, g, b };
}

export function getSpectralColorString(low: number, mid: number, high: number): string {
  const c = getSpectralColor(low, mid, high);
  return `rgb(${c.r},${c.g},${c.b})`;
}

export function getEnergyColor(peak: number, low: number, mid: number, high: number): string {
  if (peak < 0.01) return 'rgba(0,0,0,0)'; // honest empty state
  const intensity = Math.min(1, peak * 1.2);
  const color = getSpectralColor(low, mid, high);
  return `rgba(${color.r},${color.g},${color.b},${intensity})`;
}

export function interpolateColor(c1: SpectralColor, c2: SpectralColor, t: number): SpectralColor {
  return {
    r: Math.round(c1.r * (1 - t) + c2.r * t),
    g: Math.round(c1.g * (1 - t) + c2.g * t),
    b: Math.round(c1.b * (1 - t) + c2.b * t),
  };
}
