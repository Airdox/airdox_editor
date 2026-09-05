/**
 * @license
 * Airdox_intelligents_Editor – Wellenform-Farben
 *
 * Reine Farbmathematik (kein Canvas, kein DOM), damit die Wellenform auch in
 * Tests geprüft werden kann (tests/waveform-colors.test.ts).
 *
 * AMBER ist der Standard und ist bewusst *gesättigt* gerechnet. Die Rampe läuft
 * über Farbton/Sättigung/Helligkeit (HSL) und nicht über eine RGB-Mischung: eine
 * RGB-Mischung Richtung „helles Gelb“ erhöht den Weißanteil, und genau davon sah
 * die Kurve blass und pastelltonartig aus. Hier bleibt die HSV-Sättigung ab dem
 * leisen Bereich bei ≈0,7…1,0, der Weißanteil liegt im lauten Bereich unter 0,1 –
 * heißes Gold statt Creme.
 *
 * Messwerte (npx tsx tests/waveform-colors.test.ts): Sättigung 0,654 → 0,915 und
 * Weißanteil 0,346 → 0,085 über alle lauten Balken (peak ≥ 0,55).
 */

import { WaveformMode } from '../types/rekordbox';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Hsl {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

/**
 * Hintergrund, vor dem die Wellenform gezeichnet wird. Warmes, fast schwarzes
 * Braun statt kühlem Blauschwarz – das hebt die Sättigung der Kurve.
 */
export const WAVEFORM_BACKGROUNDS: Record<string, string> = {
  AMBER: '#0a0806',
  BLUE: '#080a0e',
  RGB: '#0a0806',
  '3BAND': '#0a0806',
};

/**
 * Anker der Bernstein-Rampe (Farbton, Sättigung, Helligkeit).
 *   leise   → tiefes Brandorange, auf dem dunklen Grund noch klar lesbar
 *   mittel  → reines Sattorange (die Grundfarbe der Spur)
 *   laut    → heißes Goldorange, bewusst NICHT cremeweiß
 * Die weißglühende Spitze ist davon getrennt (AMBER_HOT) und erscheint nur auf
 * den lautesten Balken; sie ersetzt den ehemaligen Hellstreifen über jeder Bar.
 */
const RAMP: Array<{ at: number; h: number; s: number; l: number }> = [
  { at: 0.0, h: 22, s: 0.92, l: 0.22 }, // Brandorange, noch dunkel
  { at: 0.28, h: 24, s: 1.0, l: 0.38 }, // tiefes Sattorange
  { at: 0.55, h: 29, s: 1.0, l: 0.48 }, // Amber – die Grundfarbe der Spur
  { at: 0.78, h: 34, s: 1.0, l: 0.53 }, // helles Orange
  { at: 0.92, h: 40, s: 1.0, l: 0.57 }, // Goldorange
  { at: 1.0, h: 45, s: 1.0, l: 0.63 }, // heißes Gold – bewusst NICHT cremeweiß
];

/** Kontrastkurve: hebt leise Abschnitte an, ohne die lauten flach zu machen. */
export function contrastCurve(peak: number): number {
  const value = clamp01(peak);
  // leichtes Gamma (< 1) + Sockel, damit Stille nicht ins Nichts fällt
  return Math.min(1, 0.08 + 0.94 * Math.pow(value, 0.72));
}

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function rampAt(level: number): Hsl {
  const value = clamp01(level);
  for (let i = 1; i < RAMP.length; i++) {
    const upper = RAMP[i];
    if (value <= upper.at) {
      const lower = RAMP[i - 1];
      const span = upper.at - lower.at || 1;
      const t = (value - lower.at) / span;
      return {
        h: mix(lower.h, upper.h, t),
        s: mix(lower.s, upper.s, t),
        l: mix(lower.l, upper.l, t),
      };
    }
  }
  const last = RAMP[RAMP.length - 1];
  return { h: last.h, s: last.s, l: last.l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const round = (v: number) => Math.max(0, Math.min(255, Math.round((v + m) * 255)));
  return { r: round(r), g: round(g), b: round(b) };
}

export function toRgbCss(color: Rgb): string {
  const round = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${round(color.r)}, ${round(color.g)}, ${round(color.b)})`;
}

/**
 * Bernstein-Farbe für einen Wellenform-Balken.
 * @param peak  Amplitude 0..1 – bestimmt Stelle in der Rampe
 * @param low   Bassanteil 0..1 – zieht den Farbton Richtung Rotorange, ohne zu entsättigen
 * @param high  Höhenanteil 0..1 – lässt die Spitze heiß aufglühen
 */
export function amberColor(peak: number, low = 0, high = 0): Rgb {
  const level = contrastCurve(peak);
  const bass = clamp01(low);
  const air = clamp01(high);
  const color = rampAt(level);

  // Bass: Farbton nach unten Richtung Rot, Sättigung bleibt oben, minimal dunkler.
  const base = hslToRgb({
    h: mix(color.h, 12, bass * 0.5),
    s: Math.min(1, color.s + bass * 0.08),
    l: mix(color.l, Math.max(0.16, color.l * 0.92), bass * 0.55),
  });

  // Höhen: kein Aufhellen mit Weiß (das war der Pastell-Effekt), sondern „heiß"
  // rechnen: Rot und Grün rauf, Blau raus. Die Kurve gewinnt dadurch Sättigung.
  const glow = air * Math.max(0, level - 0.5) * 0.9;
  const heat = clamp01(glow * 1.7);

  return {
    r: Math.min(255, base.r + 30 * heat),
    g: Math.min(255, base.g + 26 * heat),
    b: Math.max(0, base.b * (1 - 0.45 * heat)),
  };
}

export function amberColorCss(peak: number, low = 0, high = 0): string {
  return toRgbCss(amberColor(peak, low, high));
}

/**
 * Deckkraft des hellen Kerns in der Balkenmitte. Früher bekam *jeder* Balken
 * einen fast weißen Streifen (Alpha 0,25…0,80) – das war die Pastelldecke über
 * der ganzen Kurve. Jetzt greift der Kern erst ab kräftigen Spitzen (peak ≥ 0,62)
 * und wird nie blickdichter als 0,42.
 */
export function amberCoreAlpha(peak: number, high: number): number {
  const level = clamp01(peak);
  const air = clamp01(high);
  if (level < 0.62) return 0;
  const strength = (level - 0.62) / 0.38;
  return Math.min(0.42, 0.08 + 0.34 * strength * (0.45 + 0.55 * air));
}

/** Farbe des Kerns: hellglühendes Gold, kein Cremeweiß. */
export function amberCoreColor(peak: number, high: number): string {
  const level = clamp01(Math.max(peak, 0) * 0.6 + clamp01(high) * 0.4);
  return toRgbCss(hslToRgb({ h: mix(42, 50, level), s: 1, l: mix(0.6, 0.68, level) }));
}

/** Akzentfarbe für UI-Elemente, die zur Wellenform passen. */
export const AMBER_ACCENT = '#ff9500';
export const AMBER_ACCENT_SOFT = 'rgba(255, 149, 0, 0.22)';
export const AMBER_ACCENT_LINE = 'rgba(255, 176, 64, 0.92)';
/** Dünner Loop-Ton über der Kurve – bewusst schwach, damit die Balken nicht aufgewaschen wirken. */
export const AMBER_LOOP_TINT = 'rgba(255, 149, 0, 0.08)';
/** Heisse Spitze für Transienten (nur für die lautesten Balken) und ihr Glow. */
export const AMBER_HOT = toRgbCss(hslToRgb({ h: 45, s: 1, l: 0.63 }));
export const AMBER_HOT_GLOW = 'rgba(255, 208, 66, 0.6)';

export const MID_AMBER = toRgbCss(hslToRgb(rampAt(0.55)));
export const DEEP_AMBER = toRgbCss(hslToRgb(rampAt(0.12)));
export const HOT_AMBER = AMBER_HOT;

/** Farbpaletten je Modus – für Legenden, Überschriften und Tests. */
export function waveformPalette(
  mode: WaveformMode
): { label: string; body: string; core: string; bands: [string, string, string] } {
  switch (mode) {
    case 'BLUE':
      return { label: 'Blau (Monochrom)', body: '#0a9dff', core: '#9fe8ff', bands: ['#0b4a78', '#0a9dff', '#9fe8ff'] };
    case 'RGB':
      return { label: 'RGB (Frequenzfarben)', body: '#ff5a1f', core: '#fff2cf', bands: ['#ff2b2b', '#00e676', '#2f7bff'] };
    case '3BAND':
      return { label: '3 Band (Low / Mid / High)', body: '#ff2b2b', core: '#fff2cf', bands: ['#ff2b2b', '#00e5ff', '#ffe9a8'] };
    case 'AMBER':
    default:
      return {
        label: 'Amber (warm, gesättigt)',
        body: MID_AMBER,
        core: HOT_AMBER,
        bands: [DEEP_AMBER, MID_AMBER, HOT_AMBER],
      };
  }
}

export const WAVEFORM_MODES: Array<{ mode: WaveformMode; label: string; hint: string }> = [
  { mode: 'AMBER', label: 'AMBER (warm, gesättigt)', hint: 'Sattes Bernsteinorange, heiße Spitzen – Standard' },
  { mode: 'BLUE', label: 'BLUE (monochrom)', hint: 'Klassisches Elektrikblau' },
  { mode: 'RGB', label: 'RGB (Frequenz)', hint: 'Bass rot, Mitte grün, Höhe blau' },
  { mode: '3BAND', label: '3BAND', hint: 'Drei getrennte Bänder' },
];
