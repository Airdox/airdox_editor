/**
 * @license
 * Airdox_intelligents_Editor – Nachweis-Suite: Wellenform-Farben
 *
 * Die Farbrechnung in src/waveform/colors.ts ist bewusst reine Mathematik (kein
 * Canvas, kein DOM). Genau deshalb kann hier gemessen werden, was das Auge am
 * Bildschirm sonst nur vermutet: die Kurve darf nicht blass/pastelltonartig
 * werden. Die Suite prüft Sättigung, Weißanteil, Farbtonbereich, Helligkeits-
 * verlauf, den Kontrast zum Hintergrund und dass der helle Kern kein
 * Dauerweißschleier ist. Zum Vergleich wird die frühere RGB-Mischung
 * (Cremeweiß-Rampe) mitgerechnet.
 *
 * Als Beweis wird tests/artifacts/waveform-colors/vorschau.png gerendert – mit
 * einem eigenen Mini-PNG-Schreiber (nur zlib, kein Canvas, keine Zusätze), damit
 * der Vergleich auf jeder Maschine identisch erzeugbar ist.
 *
 * Ausführen: npx tsx tests/waveform-colors.test.ts
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';

import {
  AMBER_ACCENT,
  AMBER_HOT,
  DEEP_AMBER,
  HOT_AMBER,
  MID_AMBER,
  Rgb,
  WAVEFORM_BACKGROUNDS,
  WAVEFORM_MODES,
  amberColor,
  amberColorCss,
  amberCoreAlpha,
  amberCoreColor,
  contrastCurve,
  toRgbCss,
  waveformPalette,
} from '../src/waveform/colors';

const ARTIFACT_DIR = path.join('tests', 'artifacts', 'waveform-colors');

type ColorFn = (peak: number, low: number, high: number) => Rgb;

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

function runTest(suite: string, name: string, testFn: () => void) {
  const t0 = performance.now();
  try {
    testFn();
    results.push({ suite, name, passed: true, durationMs: Math.round(performance.now() - t0) });
  } catch (error) {
    results.push({
      suite,
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Math.round(performance.now() - t0),
    });
  }
}

// ── Farb-Messwerkzeug ──────────────────────────────────────────────────────

/**
 * Sättigung im HSV-Sinn: 1 = reine Farbe, 0 = grau oder weiß.
 * Das ist hier das richtige Maß, nicht die HSL-Sättigung – Cremeweiß hat bei
 * HSL formal 100 % Sättigung und wirkt trotzdem blass. HSV misst genau den
 * Weißanteil, der die Kurve pastellig macht.
 */
function saturation({ r, g, b }: Rgb): number {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  if (mx <= 0) return 0;
  return (mx - mn) / mx;
}

/** Weißanteil einer Farbe – der direkte Messwert für „pastelltonartig". */
function whiteness(c: Rgb): number {
  return Math.min(c.r, c.g, c.b) / 255;
}

function hue({ r, g, b }: Rgb): number {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  const d = mx - mn;
  if (d === 0) return 0;
  const rr = (r / 255 - mn) / d;
  const gg = (g / 255 - mn) / d;
  const bb = (b / 255 - mn) / d;
  let h = 0;
  if (mx === r / 255) h = ((gg - bb) / 6) % 6;
  else if (mx === g / 255) h = (bb - rr) / 6 + 2 / 6;
  else h = (rr - gg) / 6 + 4 / 6;
  return (h * 360 + 360) % 360;
}

function luminance({ r, g, b }: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function parseCss(css: string): Rgb {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css.trim());
  assert.ok(m, `keine gültige rgb()-Angabe: ${css}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `keine gültige hex-Angabe: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Referenz: die frühere Implementierung (RGB-Mischung über drei Anker, dazu ein
 * heller Streifen auf jeder Bar). Nur für den Vergleich hier abgetippt, damit
 * die Suite eine Rückentwicklung meldet, falls jemand wieder Richtung
 * Cremeweiß mischt.
 */
function legacyAmber(peak: number, low = 0, high = 0): Rgb {
  const c01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
  const mixv = (a: number, b: number, t: number) => a + (b - a) * t;
  const QUIET = { r: 122, g: 58, b: 10 };
  const MID = { r: 255, g: 149, b: 0 };
  const LOUD = { r: 255, g: 219, b: 168 };
  const BASS = { r: 255, g: 86, b: 0 };
  const level = c01(peak);
  const bass = c01(low) * 0.55;
  const air = c01(high);
  const first = level <= 0.5 ? level / 0.5 : 1;
  const second = level <= 0.5 ? 0 : (level - 0.5) / 0.5;
  const r = mixv(mixv(QUIET.r, MID.r, first), LOUD.r, second);
  const g = mixv(mixv(QUIET.g, MID.g, first), LOUD.g, second);
  const b = mixv(mixv(QUIET.b, MID.b, first), LOUD.b, second);
  const rb = mixv(r, BASS.r, bass * 0.6);
  const gb = mixv(g, BASS.g, bass);
  const bb = mixv(b, BASS.b, bass);
  const lift = air * 0.35 * level;
  return { r: mixv(rb, 255, lift), g: mixv(gb, 248, lift), b: mixv(bb, 232, lift) };
}

/** Alter Kern: 0.25 … 0.80 Deckkraft Weiß über jeder einzelnen Bar. */
function legacyCore(peak: number, high: number): number {
  return 0.25 + 0.55 * Math.max(0, Math.min(1, Math.max(peak, high)));
}

const LEVELS = [0, 0.06, 0.12, 0.2, 0.3, 0.42, 0.55, 0.7, 0.8, 0.9, 1];

function allSamples(): Array<{ peak: number; low: number; high: number }> {
  const out: Array<{ peak: number; low: number; high: number }> = [];
  for (const peak of LEVELS) {
    for (const low of [0, 0.35, 0.7, 1]) {
      for (const high of [0, 0.3, 0.6, 1]) {
        out.push({ peak, low, high });
      }
    }
  }
  return out;
}

/** Mittlere Werte über den lauten Bereich – dort entscheidet sich „blass oder nicht". */
function avgOver(fn: (c: Rgb) => number, color: ColorFn, peaks = [0.55, 0.7, 0.85, 1]): number {
  let acc = 0;
  let n = 0;
  for (const peak of peaks) {
    for (const low of [0, 0.5, 1]) {
      for (const high of [0, 0.5, 1]) {
        acc += fn(color(peak, low, high));
        n++;
      }
    }
  }
  return acc / n;
}

// ── 1. Rampe: gesättigt statt pastell ──────────────────────────────────────

runTest('Rampe', 'Sättigung bleibt ab leisen Bereichen hoch (kein Pastell)', () => {
  for (const s of allSamples()) {
    if (s.peak < 0.12) continue; // ganz leise darf dunkel, aber nicht grau sein
    const c = amberColor(s.peak, s.low, s.high);
    const sat = saturation(c);
    assert.ok(sat >= 0.7, `zu entsättigt bei peak=${s.peak} low=${s.low} high=${s.high}: ${sat.toFixed(2)}`);
    assert.ok(whiteness(c) <= 0.42, `zu viel Weiß bei peak=${s.peak}: ${whiteness(c).toFixed(2)} (${toRgbCss(c)})`);
  }
});

runTest('Rampe', 'deutlich gesättigter als die frühere Cremerechnung', () => {
  const avgNew = avgOver(saturation, amberColor);
  const avgOld = avgOver(saturation, legacyAmber);
  assert.ok(avgNew >= 0.8, `mittlere Sättigung im lauten Bereich zu niedrig: ${avgNew.toFixed(2)}`);
  assert.ok(avgNew - avgOld > 0.15, `keine sichtbare Verbesserung (${avgNew.toFixed(2)} vs. ${avgOld.toFixed(2)})`);
});

runTest('Rampe', 'der Weißanteil sinkt unter das alte Niveau', () => {
  const neu = avgOver(whiteness, amberColor);
  const alt = avgOver(whiteness, legacyAmber);
  assert.ok(neu <= 0.2, `Weißanteil zu hoch: ${neu.toFixed(3)}`);
  assert.ok(alt - neu > 0.15, `kaum weniger Weiß als vorher (${alt.toFixed(3)} → ${neu.toFixed(3)})`);
  for (const s of allSamples()) {
    if (s.peak < 0.5) continue;
    assert.ok(
      whiteness(amberColor(s.peak, s.low, s.high)) <= whiteness(legacyAmber(s.peak, s.low, s.high)),
      `Weißanteil bei peak=${s.peak} nicht gesenkt`
    );
  }
});

runTest('Rampe', 'Farbton durchgehend im warmen Bernsteinfenster', () => {
  for (const s of allSamples()) {
    if (s.peak < 0.12) continue;
    const h = hue(amberColor(s.peak, s.low, s.high));
    assert.ok(h >= 8 && h <= 58, `Farbton ${h.toFixed(0)}° verlässt die Bernstein-Familie`);
  }
});

runTest('Rampe', 'laut wird heißes Gold, kein Cremeweiß', () => {
  // Unterhalb der Spitze darf kein Kanal nahe an 255 laufen, sonst wirkt alles milchig.
  for (let peak = 0; peak <= 0.72; peak += 0.02) {
    const c = amberColor(peak, 0.5, 0.35);
    assert.ok(Math.min(c.r, c.g, c.b) <= 170, `zu near-white bei peak=${peak.toFixed(2)}: ${toRgbCss(c)}`);
  }
  const top = amberColor(1, 0.2, 0.9);
  assert.ok(luminance(top) > luminance(parseCss(amberColorCss(0.5, 0.2, 0.2))), 'Spitze nicht heller als Mitte');
  assert.ok(saturation(top) >= 0.7, `Spitze zu weiß: ${saturation(top).toFixed(2)}`);
  assert.ok(whiteness(top) <= 0.35, `Spitze pastellig: Weißanteil ${whiteness(top).toFixed(2)}`);
});

runTest('Rampe', 'Helligkeit steigt monoton mit der Amplitude', () => {
  let prev = -1;
  for (let peak = 0; peak <= 1.0001; peak += 0.01) {
    const lum = luminance(amberColor(Math.min(1, peak), 0, 0));
    assert.ok(lum >= prev - 1e-9, `Knick bei peak=${peak.toFixed(2)}`);
    prev = lum;
  }
  assert.ok(prev > 0.5, `Spitzenluminanz zu dunkel: ${prev.toFixed(3)}`);
});

runTest('Rampe', 'Kontrastkurve ist gequetscht, aber begrenzt', () => {
  assert.equal(contrastCurve(0), 0.08);
  assert.equal(contrastCurve(1), 1);
  assert.equal(contrastCurve(0.5) > 0.5, true, 'Gamma < 1 muss die Mitte anheben');
  for (const bad of [NaN, Infinity, -Infinity, -3, 42]) {
    const v = contrastCurve(bad);
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `Ausreißer nicht abgefangen: ${bad} -> ${v}`);
  }
  assert.equal(toRgbCss({ r: 300, g: -5, b: 12.6 }), 'rgb(255, 0, 13)');
});

// ── 2. Bass und Höhen ──────────────────────────────────────────────────────

runTest('Bänder', 'Bass zieht Richtung Rotorange, ohne zu entsättigen', () => {
  const neutral = amberColor(0.62, 0, 0);
  const bass = amberColor(0.62, 1, 0);
  assert.ok(hue(bass) < hue(neutral) - 4, `Farbton nicht wärmer/roter: ${hue(bass).toFixed(0)} vs ${hue(neutral).toFixed(0)}`);
  assert.ok(saturation(bass) >= 0.85, `Bass zu grau: ${saturation(bass).toFixed(2)}`);
  assert.ok(bass.r > bass.g && bass.g > bass.b, 'Bass muss eine Warmabstufung behalten');
});

runTest('Bänder', 'Höhen glühen nur laute Balken heiß, nie blass', () => {
  // Unterhalb der Gate-Schwelle (Kontrastwert 0.5) darf der Höhenanteil nichts ändern.
  for (const peak of [0, 0.1, 0.2, 0.3]) {
    assert.deepEqual(amberColor(peak, 0.2, 1), amberColor(peak, 0.2, 0), `Höhen wirken bei peak=${peak} schon`);
  }
  for (const peak of [0.6, 0.8, 0.95, 1]) {
    const lifted = amberColor(peak, 0.3, 1);
    const plain = amberColor(peak, 0.3, 0);
    assert.ok(luminance(lifted) > luminance(plain), `Spitzen-Transiente bei ${peak} bleibt dunkel`);
    assert.ok(lifted.b <= plain.b, 'Höhen erhöhen den Blaukanal – das ist Waschen');
    assert.ok(saturation(lifted) >= saturation(plain) - 0.02, `Höhen entsättigen bei ${peak}`);
    assert.ok(whiteness(lifted) <= 0.3, `Spitze bei ${peak} pastellig: ${whiteness(lifted).toFixed(2)}`);
  }
});

// ── 3. Kern / Spitze ───────────────────────────────────────────────────────

runTest('Kern', 'amberCoreAlpha ist unterhalb der Schwelle 0', () => {
  assert.equal(amberCoreAlpha(0, 1), 0);
  assert.equal(amberCoreAlpha(0.61, 1), 0);
  assert.equal(amberCoreAlpha(0.4, 0.4), 0, 'früherer Dauerweißschleier ist zurück');
  let prev = -1;
  for (let peak = 0.62; peak <= 1.0001; peak += 0.02) {
    const a = amberCoreAlpha(Math.min(1, peak), 1);
    assert.ok(a >= prev - 1e-9, 'Kern Alphawert nicht monoton');
    assert.ok(a <= 0.45, `Kern zu deckend: ${a.toFixed(2)}`);
    prev = a;
  }
  // Gegenprobe: die alte Rechnung begann bei 0.25 und endete bei 0.80.
  assert.ok(amberCoreAlpha(1, 1) < legacyCore(1, 1), 'Kern immer noch so deckend wie vorher');
  assert.ok(legacyCore(0.3, 0.3) >= 0.4, 'Referenzwert des alten Schleiers unplausibel');
});

runTest('Kern', 'Kernfarbe ist Gold, nicht Reinweiß', () => {
  const c = parseCss(amberCoreColor(1, 1));
  assert.ok(c.r >= 240 && c.g >= 200, `Kern zu blass: ${toRgbCss(c)}`);
  assert.ok(c.b <= 160, `Kern ist weiß geworden: ${toRgbCss(c)}`);
  assert.ok(saturation(c) >= 0.45, `Kern entsättigt: ${saturation(c).toFixed(2)}`);
  assert.ok(whiteness(c) <= 0.7, `Kern zu weiß: ${whiteness(c).toFixed(2)}`);
  assert.equal(amberCoreColor(NaN, NaN).startsWith('rgb('), true);
});

runTest('Kern', 'AMBER_HOT ist die heisse Spitze der Balken', () => {
  const hot = parseCss(AMBER_HOT);
  assert.ok(hot.r >= 245 && hot.g >= 195 && hot.b <= 150, `AMBER_HOT: ${AMBER_HOT}`);
  assert.ok(saturation(hot) >= 0.6, `AMBER_HOT blass: ${saturation(hot).toFixed(2)}`);
  assert.equal(HOT_AMBER, AMBER_HOT);
  assert.equal(AMBER_ACCENT, '#ff9500', 'UI-Akzent muss zur Kurve passen');
});

// ── 4. Hintergrund & Legende ───────────────────────────────────────────────

runTest('Hintergrund', 'warmer Fast-Schwarzton, und Kontrast stimmt', () => {
  const bg = parseHex(WAVEFORM_BACKGROUNDS.AMBER);
  assert.ok(Math.max(bg.r, bg.g, bg.b) <= 24, `Hintergrund zu hell: ${WAVEFORM_BACKGROUNDS.AMBER}`);
  assert.ok(bg.r > bg.b, `Hintergrund muss warm sein, nicht bläulich: ${WAVEFORM_BACKGROUNDS.AMBER}`);
  for (const peak of [0.12, 0.2, 0.3, 0.45, 0.6, 0.8, 1]) {
    const ratio = contrastRatio(amberColor(peak, 0.3, 0.2), bg);
    const need = peak >= 0.7 ? 4.5 : 2;
    assert.ok(ratio >= need, `Kontrast bei peak=${peak} nur ${ratio.toFixed(2)} (min. ${need})`);
  }
});

runTest('Palette', 'waveformPalette leitet Amber aus der Rampe ab', () => {
  const amber = waveformPalette('AMBER');
  assert.equal(amber.body, MID_AMBER);
  assert.equal(amber.core, HOT_AMBER);
  assert.deepEqual(amber.bands, [DEEP_AMBER, MID_AMBER, HOT_AMBER]);
  const body = parseCss(amber.body);
  const deep = parseCss(amber.bands[0]);
  const hot = parseCss(amber.core);
  assert.ok(luminance(deep) < luminance(body) && luminance(body) < luminance(hot), 'Legende nicht nach Helligkeit sortiert');
  assert.ok(saturation(body) >= 0.9, `Körperfarbe der Legende zu blass: ${saturation(body).toFixed(2)}`);
  assert.ok(/amber/i.test(amber.label), 'Label muss Amber nennen');
  assert.equal(amber.bands.length, 3);
  for (const css of [amber.body, amber.core, ...amber.bands]) {
    const c = parseCss(css);
    assert.ok(c.r >= c.g && c.g >= c.b, `Amber-Legende nicht warm: ${css}`);
    assert.ok(c.b <= 200, `Amber-Legende near-white: ${css}`);
  }
});

runTest('Palette', 'andere Modi haben eigene, kräftige Farben', () => {
  const modes = WAVEFORM_MODES.map((m) => m.mode);
  assert.deepEqual(modes, ['AMBER', 'BLUE', 'RGB', '3BAND'], 'AMBER muss Standard sein');
  const bodies = modes.map((m) => waveformPalette(m).body);
  assert.equal(new Set(bodies).size, 4, 'Modi teilen sich eine Körperfarbe');
  const blue = parseHex(waveformPalette('BLUE').body);
  assert.ok(blue.b > blue.r + 60, 'BLUE ist nicht mehr blau');
  assert.ok(!bodies.some((b) => /^#(ffffff|fff)$/i.test(b) || b === 'rgb(255, 255, 255)'), 'weiße Körperfarbe in einer Legende');
});

// ── 5. Verdrahtung in den Renderern ────────────────────────────────────────

runTest('Renderer', 'Detail-Wellenform nutzt Hintergrund, Kernschwelle und Spitze', () => {
  const src = fs.readFileSync(path.join('src', 'components', 'DetailWaveform.tsx'), 'utf-8');
  assert.ok(src.includes('WAVEFORM_BACKGROUNDS[waveformMode]'), 'Hintergrund immer noch hartkodiert');
  assert.ok(src.includes('if (coreA > 0)'), 'Kern wird wieder ohne Schwelle gezeichnet');
  assert.ok(src.includes('amberCoreColor(peak, high)'), 'Kernfarbe kommt nicht aus colors.ts');
  assert.ok(src.includes('peak >= 0.82'), 'heiße Spitze fehlt');
  assert.ok(!src.includes('rgba(255, 246, 226'), 'alter Weißschleier über jeder Bar ist zurück');
  assert.ok(!/#0b0c0f/.test(src), 'kühler Hintergrund noch im Renderer hartkodiert');
  assert.ok(!/rgba\(255, 149, 0, 0\.15\)/.test(src), 'Loop-Schleier wäscht die Kurve wieder zu');
  assert.ok(src.includes('AMBER_LOOP_TINT'), 'Loop-Ton nicht aus colors.ts');
});

runTest('Renderer', 'Übersicht und Clip-Minis nutzen dieselbe Rechnung', () => {
  const overview = fs.readFileSync(path.join('src', 'components', 'TrackOverview.tsx'), 'utf-8');
  assert.ok(overview.includes('amberColorCss(peak, low, high)'), 'Übersicht rechnet eigene Farben');
  assert.ok(overview.includes('WAVEFORM_BACKGROUNDS[mode]'), 'Übersichts-Hintergrund passt nicht zum Modus');
  assert.ok(overview.includes('AMBER_HOT'), 'Übersicht hat keine heiße Spitze');
  assert.ok(!/#a35a00/.test(overview), 'alter graubrauner Rückfallbalken');
  const palette = fs.readFileSync(path.join('src', 'components', 'PalettePanel.tsx'), 'utf-8');
  assert.ok(palette.includes('amberColorCss('), 'Clip-Minis nutzen die Rampenmathematik nicht');
  assert.ok(!/rgba\(255, 219, 168/.test(palette), 'Pastellglühen in den Clip-Minis');
  assert.ok(!/bg-\[#0b0c0f\]/.test(palette), 'Minis liegen auf kühlem Blauschwarz');
});

runTest('Renderer', 'colors.ts bleibt reine Mathematik ohne DOM', () => {
  const src = fs.readFileSync(path.join('src', 'waveform', 'colors.ts'), 'utf-8');
  for (const forbidden of ['document', 'canvas', 'getContext', 'window.', 'useEffect']) {
    assert.ok(!src.includes(forbidden), `colors.ts benutzt ${forbidden}`);
  }
  assert.ok(!src.includes('219, 168'), 'CREAM-Anker der alten Rampe ist zurück');
  assert.ok(!src.includes('248, 232'), 'Aufhell-Anker der alten Rampe ist zurück');
  assert.ok(!/l:\s*0\.[7-9]/.test(src.split('export function amberColor')[1]?.split('export function amberColorCss')[0] ?? ''),
    'amberColor hellt mit zu viel Luminanz auf (Pastellgefahr)');
});

// ── 6. Robustheit & Performance ────────────────────────────────────────────

runTest('Robust', 'ungültige Eingaben produzieren kein NaN', () => {
  for (const args of [[NaN, 0, 0], [0.5, NaN, NaN], [undefined, undefined, undefined], [-1, 2, 0.5]] as number[][]) {
    const css = amberColorCss(args[0] as number, args[1] as number, args[2] as number);
    const c = parseCss(css);
    for (const v of [c.r, c.g, c.b]) {
      assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `Kanal ungültig: ${css}`);
    }
    assert.ok(amberCoreAlpha(args[0] as number, args[2] as number) >= 0);
  }
});

runTest('Performance', 'Farben für 200 000 Balken in einem Frame-Schnitt', () => {
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < 200000; i++) {
    const peak = (i % 977) / 977;
    const c = amberColor(peak, (i % 31) / 31, (i % 53) / 53);
    acc += c.r + c.g + c.b;
  }
  const ms = performance.now() - t0;
  assert.ok(acc > 0);
  assert.ok(ms < 400, `Farbberechnung zu langsam: ${ms.toFixed(0)} ms`);
});

// ── 7. Beweise: PNG-Vorschau (alt vs. neu) + NACHWEIS.md ───────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGB-Raster als PNG (8 Bit, kein Filter) – nur zlib, damit der Beweis portabel bleibt. */
function writePng(file: string, width: number, height: number, rgb: Buffer): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bitdepth
  ihdr[9] = 2; // Farbtyp RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // Filter: None
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
  );
}

/** Deterministisches Testsignal – identisch für beide Zeilen. */
const BARS = 560;
const AMPLITUDES: number[] = [];
for (let i = 0; i < BARS; i++) {
  const t = i / BARS;
  const base = Math.abs(Math.sin(t * 21)) * 0.55 + Math.abs(Math.sin(t * 4.3)) * 0.35;
  const transient = i % 17 === 0 ? 0.35 : 0;
  AMPLITUDES.push(Math.min(1, base * (0.55 + 0.45 * Math.sin(t * Math.PI)) + transient));
}

/**
 * Eine Zeile des Vergleichsbildes. Links steht eine 6 px breite Marke:
 * grau = „Vorher“, amber = „Nachher“ (das Bild hat keine Schrift, weil hier kein
 * Font gerastert werden kann – die Marke ist die Legende).
 */
function renderRow(
  rgb: Buffer,
  width: number,
  rowY: number,
  rowH: number,
  bg: Rgb,
  color: ColorFn,
  core: (peak: number, high: number) => { alpha: number; color: Rgb },
  tipThreshold: number | null,
  marker: Rgb
): void {
  for (let y = 0; y < rowH; y++) {
    for (let x = 0; x < width; x++) {
      const i = ((rowY + y) * width + x) * 3;
      rgb[i] = bg.r;
      rgb[i + 1] = bg.g;
      rgb[i + 2] = bg.b;
    }
  }
  for (let y = 0; y < rowH; y++) {
    for (let x = 0; x < 6; x++) {
      const i = ((rowY + y) * width + x) * 3;
      rgb[i] = marker.r;
      rgb[i + 1] = marker.g;
      rgb[i + 2] = marker.b;
    }
  }
  const centerY = rowY + rowH / 2;
  const maxHalf = rowH * 0.46;
  const barWidth = width / BARS;
  for (let i = 0; i < BARS; i++) {
    const peak = AMPLITUDES[i];
    const low = (i % 7) / 7;
    const high = (i % 11) / 11;
    const barH = Math.max(1.5, peak * maxHalf);
    const c = color(peak, low, high);
    const x0 = Math.round(i * barWidth);
    const x1 = Math.max(x0 + 1, Math.round((i + 1) * barWidth - 0.2));
    for (let y = Math.round(centerY - barH); y <= Math.round(centerY + barH); y++) {
      if (y < rowY || y >= rowY + rowH) continue;
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * 3;
        rgb[idx] = c.r;
        rgb[idx + 1] = c.g;
        rgb[idx + 2] = c.b;
      }
    }
    if (tipThreshold !== null && peak >= tipThreshold) {
      const hot = parseCss(AMBER_HOT);
      const tipH = Math.max(1, Math.round(barH * 0.3));
      for (let y = 0; y < tipH; y++) {
        for (let x = x0; x < x1; x++) {
          for (const target of [Math.round(centerY - barH) + y, Math.round(centerY + barH) - y]) {
            if (target < rowY || target >= rowY + rowH) continue;
            const idx = (target * width + x) * 3;
            rgb[idx] = hot.r;
            rgb[idx + 1] = hot.g;
            rgb[idx + 2] = hot.b;
          }
        }
      }
    }
    const k = core(peak, high);
    if (k.alpha > 0) {
      for (let dy = -1; dy <= 1; dy++) {
        const y = Math.round(centerY + dy);
        if (y < rowY || y >= rowY + rowH) continue;
        for (let x = x0; x < x1; x++) {
          const idx = (y * width + x) * 3;
          for (let ch = 0; ch < 3; ch++) {
            const src = ch === 0 ? k.color.r : ch === 1 ? k.color.g : k.color.b;
            rgb[idx + ch] = Math.round(rgb[idx + ch] * (1 - k.alpha) + src * k.alpha);
          }
        }
      }
    }
  }
}

/** Mittelwerte über das exakt gleiche Testsignal wie in der Vorschau. */
function measureRow(color: ColorFn): { sat: number; white: number } {
  let sat = 0;
  let white = 0;
  let n = 0;
  for (const peak of AMPLITUDES) {
    for (const low of [0, 0.5, 1]) {
      const c = color(peak, low, 0.5);
      sat += saturation(c);
      white += whiteness(c);
      n++;
    }
  }
  return { sat: sat / n, white: white / n };
}

runTest('Beweis', 'PNG-Vorschau und NACHWEIS.md werden geschrieben', () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const width = 900;
  const rowH = 78;
  const gap = 20;
  const height = rowH * 2 + gap;
  const rgb = Buffer.alloc(width * height * 3);

  const oldBg = parseHex('#0b0c0f');
  const newBg = parseHex(WAVEFORM_BACKGROUNDS.AMBER);
  const oldCore = parseHex('#fff6e2');

  renderRow(
    rgb,
    width,
    0,
    rowH,
    oldBg,
    legacyAmber,
    (peak, high) => ({ alpha: legacyCore(peak, high), color: oldCore }),
    null,
    { r: 128, g: 130, b: 140 }
  );
  renderRow(
    rgb,
    width,
    rowH + gap,
    rowH,
    newBg,
    amberColor,
    (peak, high) => ({ alpha: amberCoreAlpha(peak, high), color: parseCss(amberCoreColor(peak, high)) }),
    0.82,
    parseHex(AMBER_ACCENT)
  );

  const pngFile = path.join(ARTIFACT_DIR, 'vorschau.png');
  writePng(pngFile, width, height, rgb);
  const png = fs.readFileSync(pngFile);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG-Signatur fehlt');
  assert.equal(png.readUInt32BE(16), width, 'PNG-Breite falsch');
  assert.equal(png.readUInt32BE(20), height, 'PNG-Höhe falsch');
  assert.ok(png.length > 2000, 'PNG ungewöhnlich klein');
  // Beide Zeilen tragen ihren eigenen Hintergrund (alt kühl, neu warm).
  const rightEdge = (width - 1) * 3;
  assert.deepEqual([rgb[rightEdge], rgb[rightEdge + 1], rgb[rightEdge + 2]], [oldBg.r, oldBg.g, oldBg.b], 'Hintergrund Zeile 1 falsch');
  const secondRowStart = (rowH + gap) * width * 3 + rightEdge;
  assert.deepEqual(
    [rgb[secondRowStart], rgb[secondRowStart + 1], rgb[secondRowStart + 2]],
    [newBg.r, newBg.g, newBg.b],
    'Hintergrund Zeile 2 falsch'
  );

  const neu = measureRow(amberColor);
  const alt = measureRow(legacyAmber);

  const notes = [
    '# Nachweis: Wellenform-Farben (überarbeitet)',
    '',
    'Anlass: die Kurve wirkte blass und pastelltonartig. Ursache war die RGB-Mischung',
    'der alten Rampe in Richtung `rgb(255, 219, 168)` (Cremeweiß) plus ein heller',
    'Weißstreifen auf *jeder* Bar (Alpha ab 0,25) und ein 15%iger Loop-Schleier.',
    '',
    'Gemessen mit `npx tsx tests/waveform-colors.test.ts` – reine Farbmathematik, kein',
    'Screenshot. Sättigung = HSV-Sättigung (1 = reine Farbe, 0 = grau/weiß);',
    'Weißanteil = kleinster Kanal ÷ 255 (direktes Maß für „pastellig“).',
    '',
    '| Bereich (Testsignal, alle Amplituden) | Sättigung vorher | Sättigung nachher | Weißanteil vorher | Weißanteil nachher |',
    '| --- | --- | --- | --- | --- |',
    `| gesamtes Signal | ${alt.sat.toFixed(3)} | ${neu.sat.toFixed(3)} | ${alt.white.toFixed(3)} | ${neu.white.toFixed(3)} |`,
    `| laute Balken (peak ≥ 0.55) | ${avgOver(saturation, legacyAmber).toFixed(3)} | ${avgOver(saturation, amberColor).toFixed(3)} | ${avgOver(whiteness, legacyAmber).toFixed(3)} | ${avgOver(whiteness, amberColor).toFixed(3)} |`,
    '',
    'Neue Rampe (`src/waveform/colors.ts`):',
    '',
    '* HSL-Anker 22°→45°, Sättigung 0,92…1,0; Luminanz 0,22→0,63 (heißes Gold statt Creme)',
    `* Hintergrund \`${WAVEFORM_BACKGROUNDS.AMBER}\` (warmes Fast-Schwarz) statt Blauschwarz`,
    `* heiße Balkenspitze ab peak ≥ 0,82 in \`${AMBER_HOT}\``,
    '* Höhen erhöhen den Blaukanal nicht: „heiß“ heißt Rot/Grün rauf, Blau runter',
    '* Kern erst ab peak ≥ 0,62, max. 0,42 Deckkraft (vorher: ab 0,25 bis 0,80 auf jeder Bar)',
    '* Loop-Schleier von 0,15 auf 0,08 gesenkt',
    '* Übersichtsspur, Detailspur und Clip-Minis rechnen alle mit `amberColor`',
    '',
    'Vorschau: `vorschau.png` (900×176) – identisches Signal, zwei Zeilen:',
  '* oben, graue Marke: alte Rechnung (Creme-Rampe + Weißstreifen auf jeder Bar)',
  '* unten, amber Marke: neue Rechnung (gesättigte Rampe, heiße Spitzen, Kern nur noch bei lauten Balken)',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'NACHWEIS.md'), notes, 'utf-8');

  // Über das ganze Signal (auch die leisen Bereiche) ist der Unterschied kleiner als
  // im lauten Bereich – 0.1 Sättigungspunkte sind hier trotzdem deutlich sichtbar.
  assert.ok(neu.sat - alt.sat > 0.1, `keine Sättigungs-Verbesserung (${alt.sat.toFixed(3)} → ${neu.sat.toFixed(3)})`);
  assert.ok(alt.white - neu.white > 0.1, `kein geringerer Weißanteil (${alt.white.toFixed(3)} → ${neu.white.toFixed(3)})`);
  assert.ok(avgOver(saturation, amberColor) - avgOver(saturation, legacyAmber) > 0.15, 'laute Balken nicht satter');
  assert.ok(fs.readFileSync(path.join(ARTIFACT_DIR, 'NACHWEIS.md'), 'utf-8').includes('Wellenform-Farben'), 'Nachweis nicht geschrieben');
});

// ── Auswertung ─────────────────────────────────────────────────────────────

let passedCount = 0;
let failedCount = 0;
console.log('\n═══ Wellenform-Farben: Nachweis-Suite ═══\n');
results.forEach((r) => {
  console.log(`${r.passed ? '✓' : '✗'} [${r.suite}] ${r.name} (${r.durationMs} ms)`);
  if (!r.passed) {
    console.log(`    Fehler: ${r.error}`);
    failedCount++;
  } else {
    passedCount++;
  }
});
console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Total: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
console.log(`Beweise: ${path.join(ARTIFACT_DIR, 'NACHWEIS.md')} und vorschau.png`);
console.log('═══════════════════════════════════════════════════════════════════\n');

if (failedCount > 0) process.exit(1);
process.exit(0);
