/**
 * @license
 * airdox_SMART_Editor – UI v2.0 Design-Tokens (Drei-Zonen-Architektur).
 *
 * Warum es dieses Modul gibt:
 *   Die Oberfläche ist in drei feste Zonen geteilt (Zone 1 Top-Bar, Zone 2
 *   Viewport, Zone 3 Footer). Damit die Hierarchie nicht in jedem Bauteil neu
 *   erfunden wird – und damit „primär" nicht plötzlich „rot" bedeutet – liegen
 *   die Bedeutungen der Farben und die Klassen der Button-Hierarchie genau hier.
 *
 * Die Hierarchie ist absichtlich *semantisch* und nicht dekorativ:
 *
 *   PRIORITÄT  ROLLE              FARBE                    WO (Beispiele)
 *   1 (hoch)  Primäraktion        Rekordbox-Cyan-Verlauf   „Job jetzt ausführen",
 *                                 (#0088ff → #00c8ff)      „Stems jetzt trennen", Play
 *   2         Sekundäraktion      Neutral erhöht           „Schnell", „High Quality",
 *                                 (#161922 / #232738)      „Lokal (GPU/CPU)", Copy
 *   3         Tertiär / Geist     transparent, Text        Menüpunkte, Reiter,
 *                                 neutral                  „Einklappen", Tabs
 *   4         Umschalter „aktiv"  Cyan-getönt              Fokus-Modus AN,
 *                                 (#0a1a26 / #00a2ff)      Loop/Quantize aktiv
 *   5         Warnung             Amber #f0b429            „nicht erreichbar",
 *                                                          HQ ohne GPU
 *   6         Zerstörend          Rot #ff453a             „Abbrechen", Delete
 *   7         Erfolg / bereit    Grün #00c853/#00e676     „Stem-Separation bereit"
 *
 * Harte Regeln (siehe docs/UI_V2_DREI_ZONEN.md):
 *   - Genau EINE Primäraktion pro Kontext. Nie zwei Cyan-Buttons nebeneinander.
 *   - Zone 1 kennt keine Prozessfarben: dort gibt es keinen Fortschritt, keinen
 *     Status und keine Import-Schaltfläche (deshalb existiert hier auch kein
 *     Token dafür – was nicht existiert, kann nicht verwendet werden).
 *   - Ein Fortschritt ist eine *Linie* (2 px) in einer Zeile, keine Fläche.
 */

/** Oberflächen und Linien der drei Zonen. */
export const UI_SURFACE = {
  /** Fensterhintergrund (alles außerhalb der Zonen). */
  base: '#0a0b0d',
  /** Zonenfläche (Zone 1 / Zone 3). */
  zone: '#0e1015',
  /** Angehobene Fläche innerhalb einer Zone (Panels, Chips). */
  raised: '#16171b',
  /** Eingelassene Fläche (Parameterzeilen, Fortschrittszeile). */
  inset: '#12141c',
  /** Standardlinie. */
  border: '#1c1e26',
  /** Betonte Linie für Panels und Gruppen. */
  borderStrong: '#2b2d35',
} as const;

/** Textfarben. */
export const UI_TEXT = {
  primary: '#e6e7ea',
  secondary: '#a3a6ae',
  muted: '#7c828f',
} as const;

/** Bedeutungstragende Farben (nie dekorativ verwenden). */
export const UI_ACCENT = {
  /** Primäraktion / Markenfarbe. */
  primary: '#0088ff',
  primaryBright: '#00c8ff',
  /** Erfolg, bereit, verbunden. */
  success: '#00c853',
  successBright: '#00e676',
  /** Warnung (erreichbar? Rechenzeit? fehlende Gewichte?). */
  warning: '#f0b429',
  /** Zerstörend (Abbrechen, Löschen). */
  danger: '#ff453a',
} as const;

/**
 * Klassen der Button-Hierarchie. Die Strings sind Tailwind-Klassen, wie sie im
 * Rest der Anwendung üblich sind; sie werden an genau einer Stelle definiert.
 */
export const UI_ACTION = {
  /** Rang 1 – Primäraktion („Job jetzt ausführen"). Höchstens eine pro Kontext. */
  primary:
    'bg-gradient-to-r from-[#0088ff] to-[#00c8ff] text-black font-bold border border-transparent hover:from-[#0099ff] hover:to-[#22d3ee] disabled:opacity-40 disabled:cursor-not-allowed',
  /** Rang 2 – Sekundäraktion (Parameterwahl, Kopieren, Einfügen). */
  secondary:
    'bg-[#161922] border border-[#232738] text-neutral-300 hover:border-[#0088ff] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed',
  /** Rang 2 – als *gewählt* markierte Sekundäraktion (Segment-Schalter). */
  secondarySelected: 'bg-[#00284a] border border-[#00a2ff] text-[#00e5ff] font-semibold',
  /** Rang 3 – Tertiär/Geist (Menüs, Reiter, Einklappen). */
  ghost: 'border border-transparent text-neutral-400 hover:text-white hover:bg-[#1b1d26]',
  /** Rang 4 – Umschalter im aktiven Zustand (Fokus-Modus, Loop, Quantize). */
  toggleOn: 'bg-[#0a1a26] border border-[#00a2ff] text-[#00e5ff]',
  /** Rang 6 – Zerstörend. */
  danger:
    'bg-[#1f1214] border border-[#402024] text-[#ff453a] hover:bg-[#301a1c] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed',
  /** Rang 5 – Warnung als Aktion (z. B. HQ ohne GPU). */
  warning: 'bg-[#20180a] border border-[#3d2e15] text-[#ff9500] hover:bg-[#2b2109]',
} as const;

/**
 * Ein Segment-Schalter („Schnell | High Quality", „Lokal | Google Colab").
 * Wird als zwei bis drei Buttons derselben Gruppe gerendert – nie als Dropdown,
 * damit die Parameter ohne Klick sichtbar sind (Progressive Disclosure: die
 * Parameter erscheinen mit dem Panel, nicht einzeln).
 */
export function segmentClass(selected: boolean, disabled = false): string {
  const base = 'px-2.5 py-1 text-[10.5px] rounded border transition-colors';
  if (disabled) return `${base} bg-[#121419] border-[#1f222c] text-neutral-600 cursor-not-allowed`;
  return selected
    ? `${base} ${UI_ACTION.secondarySelected}`
    : `${base} ${UI_ACTION.secondary}`;
}

/** Rahmenfarbe, die eine Zone nach außen abgrenzt (immer gleich). */
export const ZONE_SHELL = {
  zone1: 'bg-[#0e1015] border-b border-[#1c1e26]',
  zone2: 'bg-[#0a0b0d]',
  zone3: 'bg-[#0e1015] border-t border-[#1c1e26]',
} as const;
