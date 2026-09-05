/**
 * @license
 * Airdox_intelligents_Editor – Wellenform-Farben
 *
 * Reine Farbmathematik (kein Canvas, kein DOM), damit die Wellenform auch in
 * Tests geprüft werden kann. AMBER ist der Standard: warmes Bernstein wie in
 * Rekordbox, mit hellen Spitzen bei Transienten und tieferem Orange bei Bass.
 */

import { WaveformMode } from '../types/rekordbox';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Ruhevollage des Detail-Wellenformulars. */
/** Hintergrund, vor dem die Wellenform gezeichnet wird. */
export const WAVEFORM_BACKGROUNDS: Record<string, string> = {
  AMBER: '#0b0c0f',
  BLUE: '#0b0c0f',
  RGB: '#0b0c0f',
  '3BAND': '#0b0c0f',
};

const QUIET: Rgb = { r: 122, g: 58, b: 10 }; // dunkles Bernstein
const MID: Rgb = { r: 255, g: 149, b: 0 }; // Amber
const LOUD: Rgb = { r: 255, g: 219, b: 168 }; // warmes Hellgelb
const BASS_SHIFT: Rgb = { r: 255, g: 86, b: 0 }; // satteres Orange für Bass

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function toRgb(color: Rgb): string {
  const round = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${round(color.r)}, ${round(color.g)}, ${round(color.b)})`;
}

/**
 * Bernstein-Farbe für einen Wellenform-Balken.
 * @param peak  Amplitude 0..1
 * @param low   Bassanteil 0..1 – schiebt in Richtung sattes Orange
 * @param high  Höhenanteil 0..1 – hebt die Spitzen ins Warmhelle
 */
export function amberColor(peak: number, low = 0, high = 0): Rgb {
  const level = clamp01(peak);
  const bass = clamp01(low) * 0.55;
  const air = clamp01(high);

  // Zwei-Stufen-Interpolation: leise → mittel → laut
  const first = level <= 0.5 ? level / 0.5 : 1;
  const second = level <= 0.5 ? 0 : (level - 0.5) / 0.5;

  let r = mix(mix(QUIET.r, MID.r, first), LOUD.r, second);
  let g = mix(mix(QUIET.g, MID.g, first), LOUD.g, second);
  let b = mix(mix(QUIET.b, MID.b, first), LOUD.b, second);

  // Bass zieht Richtung Orange (weniger Gelb, mehr Rotanteil), Höhen aufhellen
  r = mix(r, BASS_SHIFT.r, bass * 0.6);
  g = mix(g, BASS_SHIFT.g, bass);
  b = mix(b, BASS_SHIFT.b, bass);
  const lift = air * 0.35 * level;
  r = mix(r, 255, lift);
  g = mix(g, 248, lift);
  b = mix(b, 232, lift);

  return { r, g, b };
}

export function amberColorCss(peak: number, low = 0, high = 0): string {
  return toRgb(amberColor(peak, low, high));
}

/** Kern einer Transiente: heller Strich in der Mitte des Balkens. */
export function amberCoreAlpha(peak: number, high: number): number {
  return 0.25 + 0.55 * clamp01(Math.max(peak, high));
}

/** Akzentfarbe für UI-Elemente, die zur Wellenform passen. */
export const AMBER_ACCENT = '#ff9500';
export const AMBER_ACCENT_SOFT = 'rgba(255, 149, 0, 0.18)';
export const AMBER_ACCENT_LINE = 'rgba(255, 179, 71, 0.85)';

/** Farbpaletten je Modus – für Überschriften, Legenden und Tests. */
export function waveformPalette(mode: WaveformMode): { label: string; body: string; core: string; bands: [string, string, string] } {
  switch (mode) {
    case 'BLUE':
      return { label: 'Blau (Monochrom)', body: '#00a2ff', core: '#b3e5fc', bands: ['#00a2ff', '#4fc3f7', '#e1f5fe'] };
    case 'RGB':
      return { label: 'RGB (Frequenzfarben)', body: 'rgb(255, 240, 255)', core: '#ffffff', bands: ['#ff2b2b', '#00e676', '#2979ff'] };
    case '3BAND':
      return { label: '3 Band (Low / Mid / High)', body: '#ff2b2b', core: '#ffffff', bands: ['#ff2b2b', '#00e5ff', '#ffffff'] };
    case 'AMBER':
    default:
      return {
        label: 'Amber (warm, Rekordbox-ähnlich)',
        body: toRgb(MID),
        core: toRgb(LOUD),
        bands: [toRgb(QUIET), toRgb(MID), toRgb(LOUD)],
      };
    }
}

export const WAVEFORM_MODES: Array<{ mode: WaveformMode; label: string; hint: string }> = [
  { mode: 'AMBER', label: 'AMBER (warm)', hint: 'Bernstein wie Rekordbox, helle Transienten' },
  { mode: 'BLUE', label: 'BLUE (monochrom)', hint: 'Klassisches Elektrikblau' },
  { mode: 'RGB', label: 'RGB (Frequenz)', hint: 'Bass rot, Mitte grün, Höhe blau' },
  { mode: '3BAND', label: '3BAND', hint: 'Drei getrennte Bänder' },
];
