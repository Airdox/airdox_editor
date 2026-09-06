/**
 * @license
 * Airdox_intelligents_Editor – Tempo und Tonhöhe beim Clip-Austausch
 *
 * Ein Clip stammt aus einer Spur mit eigenem Tempo. Soll er in eine Spur mit einem
 * anderen Tempo, muss seine Spieldauer mit geändert werden – sonst liegen seine
 * Beats danach nicht mehr auf dem Raster der Zielspur, egal wie exakt die Kante
 * gerastert wurde. Zwei Wege, beide ohne externe Abhängigkeit und ohne DOM:
 *
 *   Vocoder    – Zeit stauchen/strecken, Tonhöhe bleibt (in der DJ-Sprache:
 *                „Master Tempo“ bzw. Key-Lock EIN). Rahmenweise Überlagerung mit
 *                weitergetragener Phase; die Länge stimmt auf ±1 Sample.
 *   Resample   – wie eine andere Abspielgeschwindigkeit der Platte: Dauer und
 *                Tonhöhe wandern gemeinsam (Key-Lock AUS)
 *
 * WSOLA (`wsolaStretch`) bleibt als Alternative für stark transientes Material
 * erhalten; für Clips mit Klangcharakter ist der Vocoder die bessere Wahl, weil
 * er – anders als die Suchverfahren – Tonhöhe und Fahrplan nicht gegeneinander
 * ausspielt.
 *
 * Beide Wege erzeugen dieselbe neue Dauer; sie unterscheiden sich nur darin, was
 * mit der Tonhöhe passiert. Deshalb ist die Umschaltung eine einzige Checkbox.
 *
 * Reines PCM: `tests/` prüft exakt diese Funktionen, die App nutzt denselben Code.
 */

import { PcmAudio, pcmDuration, pcmPeak, pcmSampleCount } from './pcm';
import { fftRadix2, ifftRadix2, nextPow2 } from './fft';

// ── Maße ───────────────────────────────────────────────────────────────────

/** Analyse- und Synthesefenster. 46 ms ist lang genug für Tonhöhen, kurz genug für Transienten. */
export const STRETCH_FRAME_SECONDS = 0.046;

/** Überlappung des Vocoders: 4 → 75 % Überdeckung, der Standard für Musik. */
export const STRETCH_OVERLAP = 4;

/** Suchradius für die beste Übereinstimmung. Klein gehalten: große Radien hören sich nach Geblubber an. */
export const STRETCH_SEARCH_SECONDS = 0.016;

/**
 * Gewicht des Fahrplans: so viel darf ein Rahmen höchstens an Ähnlichkeit
 * gewinnen, bevor er vom idealen Zeitplan abweichen darf. Zu klein = die Suche
 * folgt jedem periodischen Signal und ignoriert das Tempo (ein Sinus wird dann
 * gar nicht gestreckt); zu groß = harte Nähte.
 */
export const STRETCH_SCHEDULE_WEIGHT = 0.6;

/** Unterhalb dieser Abweichung wird gerechnet – es lohnt kein Editieren. */
export const TEMPO_EPSILON = 1e-4;

/** Bei dieser Abweichung hört man den Unterschied; darunter melden wir „praktisch gleich”. */
export const TEMPO_AUDIBLE_RATIO = 0.004;

/** Verhältnis Zieltempo zu Quelltempo. > 1 heißt: der Clip muss schneller werden. */
export function tempoSpeed(sourceBpm: number, targetBpm: number): number {
  if (!(sourceBpm > 0) || !(targetBpm > 0)) return Number.NaN;
  return targetBpm / sourceBpm;
}

export function centsFromRatio(ratio: number): number {
  if (!(ratio > 0)) return 0;
  return 1200 * Math.log2(ratio);
}

export function ratioFromCents(cents: number): number {
  return Math.pow(2, cents / 1200);
}

export function semitonesFromRatio(ratio: number): number {
  return centsFromRatio(ratio) / 100;
}

// ── Hilfen ──────────────────────────────────────────────────────────────────

/** Mittelwert aller Kanäle – das Raster für alle Kanäle wird gemeinsam bestimmt. */
function mixDown(channels: Float32Array[], length: number): Float32Array {
  if (channels.length <= 1) return channels[0] ?? new Float32Array(length);
  const out = new Float32Array(length);
  for (let ch = 0; ch < channels.length; ch++) {
    const data = channels[ch];
    for (let i = 0; i < length; i++) out[i] += data[i] ?? 0;
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i++) out[i] *= scale;
  return out;
}

/** Einfache Mitten-Mittelung; dient der Entzerrung der Suche und dem Antialiasing. */
function boxcar(data: Float32Array, width: number): Float32Array {
  if (width <= 1) return data;
  const half = Math.floor(width / 2);
  const out = new Float32Array(data.length);
  let acc = 0;
  for (let i = 0; i < width; i++) acc += data[Math.min(data.length - 1, i)] ?? 0;
  for (let i = 0; i < data.length; i++) {
    out[i] = acc / width;
    const addAt = Math.min(data.length - 1, i + half + 1);
    const dropAt = Math.max(0, i - half);
    acc += (data[addAt] ?? 0) - (data[dropAt] ?? 0);
  }
  return out;
}

/** Normalisierte Kreuzkorrelation eines Fensters gegen eine Referenz (1 = identisch). */
function similarity(data: Float32Array, start: number, reference: Float32Array): number {
  let dot = 0;
  let energyA = 0;
  let energyB = 0;
  for (let i = 0; i < reference.length; i++) {
    const a = data[start + i] ?? 0;
    const b = reference[i] ?? 0;
    dot += a * b;
    energyA += a * a;
    energyB += b * b;
  }
  if (energyA <= 1e-12 || energyB <= 1e-12) return -1;
  return dot / Math.sqrt(energyA * energyB);
}

/**
 * Periodisches Hann-Fenster (Nenner `length`): nur dieses hebt sich bei
 * ganzzahliger Überlappung im Raster exakt auf – das symmetrische Fenster
 * (Nenner `length - 1`) lässt die Summe der Quadrate um ein Prozent wandern.
 */
function hannPeriodic(length: number): Float32Array {
  const win = new Float32Array(length);
  for (let i = 0; i < length; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  return win;
}

function hann(length: number): Float32Array {
  const win = new Float32Array(length);
  for (let i = 0; i < length; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1 || 1));
  return win;
}

// ── Resample (Tonhöhe folgt dem Tempo) ──────────────────────────────────────

/**
 * Liest das Material mit der Geschwindigkeit `speed` neu: Ausgabe wird
 * `1 / speed` so lang, und jede Frequenz wandert um den Faktor `speed`.
 * Catmull-Rom-Interpolation, beim Schnellermachen mit vorgeschaltetem
 * Mittelungsfilter (Antialiasing), damit keine Obertöne umklappen.
 */
export function resamplePcm(pcm: PcmAudio, speed: number, options: { antiAlias?: boolean } = {}): PcmAudio {
  const sampleRate = pcm.sampleRate || 44100;
  const inLen = pcmSampleCount(pcm);
  if (!(speed > 0) || !Number.isFinite(speed)) return pcm;
  if (Math.abs(speed - 1) <= 1e-12) return pcm;
  const outLen = Math.max(1, Math.floor(inLen / speed));
  const antiAlias = options.antiAlias !== false && speed > 1.02;
  const width = antiAlias ? Math.max(1, Math.round(speed) | 1) : 1;
  const channels = pcm.channels.map((channel) => {
    const source = width > 1 ? boxcar(channel, width) : channel;
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const x = i * speed;
      const j = Math.floor(x);
      const t = x - j;
      const p0 = source[j - 1] ?? source[j] ?? 0;
      const p1 = source[j] ?? 0;
      const p2 = source[j + 1] ?? p1;
      const p3 = source[j + 2] ?? p2;
      out[i] =
        0.5 *
        (2 * p1 +
          (-p0 + p2) * t +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
          (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    }
    return out;
  });
  return { sampleRate, channels };
}

// ── Phasenvocoder (Zeit ändern, Tonhöhe halten) ─────────────────────────────

export interface VocodeResult {
  pcm: PcmAudio;
  /** Verarbeitete Rahmen. */
  frames: number;
  /** Analyse- und Syntheseschritt in Samples (Synthese ist float). */
  analysisHop: number;
  synthesisHop: number;
  untouched: boolean;
  reason?: 'ratio 1' | 'kein material' | 'zu kurz';
}

function wrapPi(value: number): number {
  let v = value;
  while (v > Math.PI) v -= 2 * Math.PI;
  while (v < -Math.PI) v += 2 * Math.PI;
  return v;
}

/**
 * Zeitstauchen mit Phasenvocoder – feste Raster, verschobene Lesespalte.
 *
 * Analyse und Synthese teilen sich *einen* Rahmenraster (Sprungweite
 * `size / overlap`). Nur dort heben sich die Fenster exakt auf: Bei
 * periodischem Hann-Fenster ist die Summe der Fensterquadrate je Restklasse
 * konstant, der Pegel bleibt also überall gleich. Ein durch `ratio` geteilter
 * Schreibfahrplan (der erste Entwurf) ergibt eine unteilbare Überlappung –
 * die Lautstärke wird dann im Rahmentakt moduliert (gemessen: einzelne Takte bis
 * zu 60 % zu leise, je nach Fenstergröße andere).
 *
 * Die Zeitlupe kommt deshalb nicht aus einem verschobenen Schreibplan, sondern
 * aus einer interpolierten Lesespalte in der Zeitachse des Spektrogramms:
 * Ausgaberahmen `n` liest Analyse-Rahmen `n · ratio`. Weil Töne dabei nicht
 * umkopiert werden dürfen, wird je Tonne die *wahre* Kreisfrequenz aus dem
 * Phasenfortschritt zweier Rahmen gewonnen, über die Rahmen interpoliert und auf
 * dem Ausgabefahrplan aufintegriert. Dadurch bleibt die Tonhöhe erhalten, während
 * sich die Dauer um `1 / ratio` ändert – ohne dass ein Suchverfahren Tonhöhe
 * gegen Zeitplan ausspielen könnte.
 *
 * `ratio` > 1 heißt: schneller und kürzer (Zieltempo höher).
 */
export function phaseVocodeStretch(
  pcm: PcmAudio,
  ratio: number,
  options: { fftSize?: number; overlap?: number } = {}
): VocodeResult {
  const sampleRate = pcm.sampleRate || 44100;
  const inLen = pcmSampleCount(pcm);
  const base = { pcm, frames: 0, analysisHop: 0, synthesisHop: 0 };
  if (inLen <= 0) return { ...base, untouched: true, reason: 'kein material' };
  if (!(ratio > 0) || Math.abs(ratio - 1) <= 1e-12) return { ...base, untouched: true, reason: 'ratio 1' };

  // Rahmenlänge abgerundet auf eine Zweierpotenz: 2028 Samples sind bei 44,1 kHz
  // 46 ms – die Fensterlänge, mit der der Vocoder sauber zwischen Tonhöhe und
  // Transienten liegt. Aufrunden würde die Arbeit verdoppeln.
  const wanted = Math.max(256, Math.round(options.fftSize ?? STRETCH_FRAME_SECONDS * sampleRate));
  const size = Math.max(256, 2 ** Math.floor(Math.log2(wanted)));
  const overlap = Math.max(2, Math.round(options.overlap ?? STRETCH_OVERLAP));
  const hop = Math.max(1, Math.floor(size / overlap));
  if (inLen < size + hop) return { ...base, untouched: true, reason: 'zu kurz' };

  // Erster und letzter Rahmen liegen absichtlich außerhalb des Materials (dort
  // steht Stille): ohne diese Vorläufer fehlt am Rand die Überlappung, und der
  // Einschwingvorgang des ersten Takts wird vom Hann-Fenster weichgezeichnet
  // (gemessen: 7 % Pegelverlust im ersten Takt, ganz am Anfang noch mehr).
  const edge = overlap - 1;
  const analysisFrames = Math.floor((inLen + 2 * edge * hop) / hop) + 1;
  const outLen = Math.max(1, Math.round(inLen / ratio));
  const outFrames = Math.max(1, Math.floor((outLen + 2 * edge * hop) / hop) + 1);
  const bins = size / 2 + 1;
  const win = hannPeriodic(size);

  // Rückgewinn je Restklasse: exakt die Summe der Fensterquadrate, die im Inneren
  // zusammenlaufen. Ein fester Wert pro Restklasse – nicht lokal pro Sample
  // dividiert –, damit die Ränder sanft auslaufen statt auszubrechen.
  const residueGain = new Float64Array(hop);
  for (let rest = 0; rest < hop; rest++) {
    let sum = 0;
    for (let j = rest; j < size; j += hop) sum += win[j] * win[j];
    residueGain[rest] = sum > 1e-6 ? sum : 1;
  }

  // Phasenfortschritt, den eine exakt auf der Tonnenmitte liegende Frequenz hätte.
  const expectedPhase = new Float64Array(bins);
  for (let k = 0; k < bins; k++) expectedPhase[k] = ((2 * Math.PI * k) / size) * hop;

  const channels = pcm.channels.map((data) => {
    // 1. Analyse: Betrag und wahre Kreisfrequenz (Umläufe pro Sample) je Tonne.
    const magnitude = new Float32Array(analysisFrames * bins);
    const cycles = new Float32Array(analysisFrames * bins);
    const energy = new Float32Array(analysisFrames);
    // Rohe Phasen je Rahmen: Die relativen Phasen *zwischen* den Tonnen eines Peaks
    // beschreiben, wo der Ton im Fenster sitzt. Eine frei laufende Phasenuhr
    // verliert diesen Bezug – die Überlagerung der Rahmen ergibt dann nur noch
    // zwei Drittel des Pegels (gemessen an 220 Hz bei 44,1 kHz).
    const phases = new Float32Array(analysisFrames * bins);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    const previousPhase = new Float64Array(bins);
    for (let frame = 0; frame < analysisFrames; frame++) {
      const pos = (frame - edge) * hop;
      for (let i = 0; i < size; i++) {
        re[i] = (data[pos + i] ?? 0) * win[i];
        im[i] = 0;
      }
      fftRadix2(re, im);
      const offset = frame * bins;
      let frameEnergy = 0;
      for (let k = 0; k < bins; k++) {
        const real = re[k];
        const imag = im[k];
        const value = Math.sqrt(real * real + imag * imag);
        magnitude[offset + k] = value;
        frameEnergy += value;
        const phase = Math.atan2(imag, real);
        phases[offset + k] = phase;
        if (frame === 0) {
          cycles[offset + k] = expectedPhase[k] / (2 * Math.PI * hop);
        } else {
          // Wahre Kreisfrequenz aus dem Phasenfortschritt zweier Rahmen – der
          // eigentliche Trick, und der Grund, warum die Tonhöhe stehen bleibt.
          const deviation = wrapPi(phase - previousPhase[k] - expectedPhase[k]);
          cycles[offset + k] = (expectedPhase[k] + deviation) / (2 * Math.PI * hop);
        }
        previousPhase[k] = phase;
      }
      energy[frame] = frameEnergy;
    }

    // 2. Synthese auf unverändertem Raster: Rahmen n liest n · ratio. Die Phase
    // kommt aus dem gelesenen Rahmen und wird um die Strecke nachgeführt, die
    // dieser Rahmen auf dem Ausgabefahrplan wandert – so bleiben Tonhöhe,
    // Fensterlage und Überlappung gleichzeitig konsistent.
    const out = new Float32Array(outLen);
    for (let frame = 0; frame < outFrames; frame++) {
      const readAt = Math.min(analysisFrames - 1, Math.max(0, edge + (frame - edge) * ratio));
      const low = Math.floor(readAt);
      const high = Math.min(analysisFrames - 1, low + 1);
      // Ein Sprung zwischen zwei Rahmen ist ein Einschwingvorgang: statt zu
      // mitteln, wird gerastert. Sonst verwischt jeder Schlag über zwei Rahmen
      // und sitzt nicht mehr auf dem Raster.
      const jump = Math.abs(energy[low] - energy[high]);
      const limit = 0.35 * Math.max(energy[low], energy[high]);
      const mix = jump > limit ? (readAt - low >= 0.5 ? 1 : 0) : readAt - low;
      const lowOffset = low * bins;
      const highOffset = high * bins;
      const weight = 1 - mix;
      const shiftLow = (frame - low) * hop;
      const shiftHigh = (frame - high) * hop;
      for (let k = 0; k < bins; k++) {
        const magnitudeHere = magnitude[lowOffset + k] * weight + magnitude[highOffset + k] * mix;
        const cyclesLow = cycles[lowOffset + k];
        const cyclesHigh = cycles[highOffset + k];
        const phaseLow = phases[lowOffset + k] + 2 * Math.PI * cyclesLow * shiftLow;
        const phaseHigh = phases[highOffset + k] + 2 * Math.PI * cyclesHigh * shiftHigh;
        const angle = phaseLow + wrapPi(phaseHigh - phaseLow) * mix;
        re[k] = magnitudeHere * Math.cos(angle);
        im[k] = magnitudeHere * Math.sin(angle);
      }
      // Reelles Signal: negatives Spektrum gespiegelt (konjugiert) halten.
      for (let k = bins; k < size; k++) {
        re[k] = re[size - k];
        im[k] = -im[size - k];
      }
      ifftRadix2(re, im);
      const pos = (frame - edge) * hop;
      for (let i = 0; i < size; i++) {
        const at = pos + i;
        if (at >= outLen) break;
        if (at < 0) continue;
        out[at] += re[i] * win[i];
      }
    }
    for (let i = 0; i < outLen; i++) out[i] /= residueGain[i % hop];
    return out;
  });

  return {
    pcm: { sampleRate, channels },
    frames: outFrames,
    analysisHop: hop,
    synthesisHop: hop,
    untouched: false,
  };
}

// ── WSOLA (Zeit ändern, Tonhöhe lassen) ─────────────────────────────────────

export interface WsolaResult {
  pcm: PcmAudio;
  /** Gelegte Rahmen – daraus ergibt sich die neue Länge. */
  frames: number;
  /** Größte Auslenkung der Schnittstellen in Samples (0 = nichts verrückt). */
  maxDeviation: number;
  /** true, wenn das Material zu kurz war und unverändert zurückkam. */
  untouched: boolean;
  reason?: 'ratio 1' | 'zu kurz' | 'kein material';
}

/**
 * Waveform Similarity Overlap-Add: das Material wird in überlappende Rahmen
 * zerlegt, jeder Rahmen im Quellmaterial so verschoben, dass er an der
 * Nahtstelle am besten zum vorherigen passt, und mit Hann-Fenster
 * überlagert. Die Tonhöhe bleibt erhalten, weil kein Rahmen gestreckt wird –
 * es werden nur Wiederholungen eingefügt oder weggelassen.
 *
 * Die Suchpunkte werden aus der Mono-Summe berechnet und auf alle Kanäle
 * gleich angewendet: sonst laufen links und rechts auseinander und das Stereo-
 * bild wandert.
 */
export function wsolaStretch(
  pcm: PcmAudio,
  speed: number,
  options: { frameSeconds?: number; searchSeconds?: number; schedule?: number } = {}
): WsolaResult {
  const sampleRate = pcm.sampleRate || 44100;
  const inLen = pcmSampleCount(pcm);
  if (inLen <= 0) return { pcm, frames: 0, maxDeviation: 0, untouched: true, reason: 'kein material' };
  if (!(speed > 0) || Math.abs(speed - 1) <= 1e-12) {
    return { pcm, frames: 0, maxDeviation: 0, untouched: true, reason: 'ratio 1' };
  }

  const frameLen = Math.max(64, Math.round((options.frameSeconds ?? STRETCH_FRAME_SECONDS) * sampleRate));
  const hop = Math.max(32, Math.floor(frameLen / 2));
  const search = Math.max(1, Math.round((options.searchSeconds ?? STRETCH_SEARCH_SECONDS) * sampleRate));
  if (inLen < frameLen * 2 + hop) {
    return { pcm, frames: 0, maxDeviation: 0, untouched: true, reason: 'zu kurz' };
  }

  const analysis = mixDown(pcm.channels, inLen);
  const decimation = Math.min(8, Math.max(2, Math.round(hop / 128)));
  const coarse = boxcar(analysis, decimation);
  const cFrame = Math.max(8, Math.round(frameLen / decimation));
  const cSearch = Math.max(1, Math.round(search / decimation));
  // Zielänge exakt: die Rahmen werden gleichmäßig über die gewünschte Ausgabe
  // verteilt, damit ein Takt danach wieder ein Takt ist. Die *Inhaltsposition*
  // folgt dagegen dem laufenden Faden (wie bei WSOLA üblich) – nur so bleiben
  // die Nähte phasenrichtig und die Tonhöhe unverändert. Ein Zügel begrenzt
  // beides: der Faden darf vom idealen Zeitplan höchstens eine Rahmenlänge
  // abweichen, sonst läuft das Quellmaterial davon oder weg.
  const targetLen = Math.max(frameLen + 1, Math.round(inLen / speed));
  const frames = Math.max(2, Math.round((inLen - frameLen) / (hop * speed)) + 1);
  // Ein Ausgabeschritt und der zugehörige Verbrauch im Quellmaterial gehören
  // zusammen: nur wenn hopIn = outStep · speed ist, bleibt die Überlappung
  // phasenrichtig und die Tonhöhe ruhig – und die Länge stimmt trotzdem exakt.
  const outStep = (targetLen - frameLen) / (frames - 1);
  const hopIn = outStep * speed;
  const upper = Math.max(0, inLen - frameLen);
  /** Fahrplan-Strafe: pro Sample Abweichung vom idealen Rahmen diese Korrelations-Einbuße. */
  const schedule = (options.schedule ?? STRETCH_SCHEDULE_WEIGHT) / Math.max(1, search);

  const starts: number[] = [];
  let maxDeviation = 0;
  let reference: Float32Array | null = null;
  let coarseReference: Float32Array | null = null;
  let cursor = 0;
  for (let k = 0; k < frames; k++) {
    const ideal = Math.round(k * hopIn);
    const center = Math.max(0, Math.min(upper, k === 0 ? 0 : Math.round(cursor + hopIn)));
    const low = Math.max(0, center - search);
    const high = Math.min(upper, center + search);
    let best = Math.max(low, Math.min(high, ideal));
    if (reference && coarseReference) {
      // Suche zuerst auf entzerrtem Signal (grobes Raster), dann Feinschliff im
      // Vollton – das spart einen Faktor ~16 und trifft dieselben Nähte.
      let bestScore = Number.NEGATIVE_INFINITY;
      const coarseLow = Math.max(0, Math.round(low / decimation));
      const coarseHigh = Math.min(Math.round(upper / decimation), Math.round(high / decimation));
      for (let candidate = coarseLow; candidate <= coarseHigh; candidate++) {
        const at = candidate * decimation;
        if (at + frameLen > inLen || candidate + cFrame > coarse.length) continue;
        const score = similarity(coarse, at, coarseReference) - schedule * Math.abs(at - ideal);
        if (score > bestScore) {
          bestScore = score;
          best = at;
        }
      }
      for (let d = -decimation; d <= decimation; d++) {
        const candidate = Math.max(low, Math.min(high, best + d));
        const score = similarity(analysis, candidate, reference) - schedule * Math.abs(candidate - ideal);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }
    if (k === frames - 1) best = upper; // Rest exakt aufbrauchen, sonst hängt am Ende Material übrig
    starts.push(best);
    cursor = best;
    maxDeviation = Math.max(maxDeviation, Math.abs(best - ideal));
    reference = analysis.subarray(best + hop, best + frameLen);
    coarseReference = coarse.subarray(Math.round((best + hop) / decimation), Math.round((best + frameLen) / decimation));
  }

  if (starts.length < 2) {
    return { pcm, frames: starts.length, maxDeviation: 0, untouched: true, reason: 'zu kurz' };
  }

  const outLen = targetLen;
  const win = hann(frameLen);
  const channels = pcm.channels.map((channel) => {
    const acc = new Float32Array(outLen);
    const weight = new Float32Array(outLen);
    for (let k = 0; k < starts.length; k++) {
      const src = starts[k];
      const dst = Math.min(outLen - 1, Math.round(k * outStep));
      for (let i = 0; i < frameLen; i++) {
        if (dst + i >= outLen) break;
        const value = channel[src + i] ?? 0;
        const w = win[i];
        acc[dst + i] += value * w;
        weight[dst + i] += w;
      }
    }
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) out[i] = weight[i] > 1e-4 ? acc[i] / weight[i] : 0;
    return out;
  });

  return { pcm: { sampleRate, channels }, frames: starts.length, maxDeviation, untouched: false };
}

// ── Die Entscheidung der Bibliothek: Tempo anpassen oder nicht ─────────────

export interface TempoFitReport {
  /** Tempo, aus dem der Clip stammt. */
  sourceBpm: number;
  /** Tempo der Zielspur. */
  targetBpm: number;
  /** speed = targetBpm / sourceBpm; > 1 heißt schneller und kürzer. */
  speed: number;
  /** Wie die Dauer erreicht wurde. */
  method: 'vocoder' | 'wsola' | 'resample' | 'keine';
  /** Durchgereichter Wunsch für den Weg (auto = Vocoder, WSOLA als Ausweg). */
  stretcher?: 'auto' | 'vocoder' | 'wsola';
  /** true = Tonhöhe wandert mit (Key-Lock aus), false = Tonhöhe bleibt (Master Tempo). */
  pitchFollowsTempo: boolean;
  /** Tatsächliche Tonhöhenverschiebung in Cent. */
  pitchCents: number;
  secondsBefore: number;
  secondsAfter: number;
  samplesBefore: number;
  samplesAfter: number;
  /** Rahmen und größte Auslenkung des Stretchers (0 bei resample). */
  frames: number;
  maxDeviation: number;
  /** Analyse-Schrittweite des Vocoders in Samples (0 bei resample/wsola). */
  analysisHop?: number;
  applied: boolean;
  skipped?: 'aus' | 'kein tempo' | 'praktisch gleich' | 'zu kurz' | 'stumm';
  note?: string;
}

/**
 * Bringt Material auf eine genaue Samplezahl: stutzen oder mit Stille auffüllen.
 * Nach dem Zeitstauchen bleibt immer ein Rest unter einer Rahmenlänge – für
 * Clips, die auf einem Taktraster landen sollen, wird daraus die Soll-Länge.
 */
export function fitLength(pcm: PcmAudio, targetSamples: number): PcmAudio {
  const target = Math.max(1, Math.round(targetSamples));
  const current = pcmSampleCount(pcm);
  if (current === target) return pcm;
  const sampleRate = pcm.sampleRate || 44100;
  if (current > target) {
    return { sampleRate, channels: pcm.channels.map((channel) => channel.subarray(0, target)) };
  }
  return {
    sampleRate,
    channels: pcm.channels.map((channel) => {
      const out = new Float32Array(target);
      out.set(channel.subarray(0, Math.min(target, channel.length)), 0);
      return out;
    }),
  };
}

export interface TempoFitOptions {
  sourceBpm: number;
  targetBpm: number;
  /** Standard: an. Ohne dieses Flag bleibt die Dauer, wie sie ist. */
  enabled?: boolean;
  /** Key-Lock aus: Tonhöhe folgt dem Tempo (Vinyl-Weg). */
  pitchFollowsTempo?: boolean;
  /** Material ohne Samples wird nicht angefasst; das ist kein Fehler, sondern nichts zu tun. */
  epsilon?: number;
  /** auto: Vocoder, WSOLA als Ausweg bei sehr kurzem Material. */
  stretcher?: 'auto' | 'vocoder' | 'wsola';
}

/**
 * Passt Material an ein Zieltempo an. Gibt immer neue Samples zurück, das
 * Eingangsmaterial bleibt unverändert (die Bibliothek behält ihr Original).
 */
export function fitToTempo(pcm: PcmAudio, options: TempoFitOptions): { pcm: PcmAudio; report: TempoFitReport } {
  const secondsBefore = pcmDuration(pcm);
  const samplesBefore = pcmSampleCount(pcm);
  const speed = tempoSpeed(options.sourceBpm, options.targetBpm);
  const pitchFollowsTempo = options.pitchFollowsTempo === true;
  const base: TempoFitReport = {
    sourceBpm: options.sourceBpm,
    targetBpm: options.targetBpm,
    speed: Number.isFinite(speed) ? speed : 1,
    method: 'keine',
    pitchFollowsTempo,
    pitchCents: 0,
    secondsBefore,
    secondsAfter: secondsBefore,
    samplesBefore,
    samplesAfter: samplesBefore,
    frames: 0,
    maxDeviation: 0,
    applied: false,
  };
  if (options.enabled === false) return { pcm, report: { ...base, skipped: 'aus' } };
  if (!Number.isFinite(speed) || speed <= 0) {
    return { pcm, report: { ...base, skipped: 'kein tempo', note: 'Ohne Beat-Raster auf einer Seite bleibt die Dauer, wie sie ist.' } };
  }
  const epsilon = options.epsilon ?? TEMPO_EPSILON;
  if (Math.abs(speed - 1) <= epsilon) {
    return {
      pcm,
      report: { ...base, skipped: 'praktisch gleich', note: `Tempo-Abweichung ${(Math.abs(speed - 1) * 100).toFixed(2)} % – unter der Schwelle von ${(epsilon * 100).toFixed(2)} %.` },
    };
  }
  if (!(samplesBefore > 0) || pcmPeak(pcm) <= 0) {
    return { pcm, report: { ...base, skipped: 'stumm', note: 'Der Clip ist still – es gibt nichts zu dehnen.' } };
  }
  if (speed > 1 && secondsBefore < STRETCH_FRAME_SECONDS * 2) {
    return { pcm, report: { ...base, skipped: 'zu kurz', note: `Unter ${(STRETCH_FRAME_SECONDS * 2 * 1000).toFixed(0)} ms lohnt kein Zeitstauchen.` } };
  }
  const stretcher = options.stretcher ?? 'auto';

  if (pitchFollowsTempo) {
    const next = resamplePcm(pcm, speed);
    return {
      pcm: next,
      report: {
        ...base,
        method: 'resample',
        pitchCents: centsFromRatio(speed),
        secondsAfter: pcmDuration(next),
        samplesAfter: pcmSampleCount(next),
        applied: true,
        note: `Tonhöhe folgt dem Tempo (Key-Lock aus): ${semitonesFromRatio(speed) >= 0 ? '+' : '−'}${Math.abs(semitonesFromRatio(speed)).toFixed(2)} Halbtöne.`,
      },
    };
  }
  const wantedSamples = Math.max(1, Math.round(samplesBefore / speed));
  const vocoder = stretcher === 'wsola' ? null : phaseVocodeStretch(pcm, speed);
  if (vocoder && !vocoder.untouched) {
    return {
      pcm: fitLength(vocoder.pcm, wantedSamples),
      report: {
        ...base,
        method: 'vocoder',
        stretcher,
        applied: true,
        pitchCents: 0,
        secondsAfter: pcmDuration(vocoder.pcm),
        samplesAfter: pcmSampleCount(vocoder.pcm),
        frames: vocoder.frames,
        maxDeviation: Math.abs(pcmSampleCount(vocoder.pcm) - wantedSamples),
        analysisHop: vocoder.analysisHop,
        note: `Tonhöhe bleibt (Master Tempo): ${vocoder.frames} Rahmen bei ${vocoder.analysisHop} Samples Schrittwweite; der Längenrest von ${Math.abs(pcmSampleCount(vocoder.pcm) - wantedSamples)} Samples wurde auf exakt ${wantedSamples} Samples gestellt (${(wantedSamples / (pcm.sampleRate || 44100)).toFixed(4)} s).`,
      },
    };
  }
  // Sehr kurzes Material: der Vocoder braucht mindestens einen vollen Rahmen plus
  // Schrittweite. Dann halfen schon immer die überlappenden Rahmen der WSOLA.
  const stretched = wsolaStretch(pcm, speed);
  if (stretched.untouched) {
    return {
      pcm,
      report: {
        ...base,
        stretcher,
        skipped: stretched.reason === 'zu kurz' || vocoder?.reason === 'zu kurz' ? 'zu kurz' : 'praktisch gleich',
        note: `Zeitstauchen nicht möglich (${stretched.reason ?? vocoder?.reason ?? 'unbekannt'}) – der Clip wird in seiner alten Länge abgelegt.`,
      },
    };
  }
  return {
    pcm: stretched.pcm,
    report: {
      ...base,
      method: 'wsola',
      stretcher,
      pitchCents: 0,
      secondsAfter: pcmDuration(stretched.pcm),
      samplesAfter: pcmSampleCount(stretched.pcm),
      frames: stretched.frames,
      maxDeviation: stretched.maxDeviation,
      note: `Tonhöhe bleibt (Master Tempo, WSOLA für kurzes Material): ${stretched.frames} Rahmen, größte Nahtverschiebung ${stretched.maxDeviation} Samples.`,
    },
  };
}

/**
 * Was die Oberfläche vor dem Ablagen anzeigen darf, ohne zu rechnen: das Verhältnis,
 * Dauer und Tonhöhenfolge. `willApply` ist false, wenn nichts passiert.
 */
export function planTempoFit(
  sourceBpm: number,
  targetBpm: number,
  options: { enabled?: boolean; pitchFollowsTempo?: boolean } = {}
): {
  willApply: boolean;
  speed: number;
  percent: number;
  pitchCents: number;
  reason: 'aus' | 'kein tempo' | 'praktisch gleich' | 'angepasst';
} {
  if (options.enabled === false) return { willApply: false, speed: 1, percent: 0, pitchCents: 0, reason: 'aus' };
  const speed = tempoSpeed(sourceBpm, targetBpm);
  if (!Number.isFinite(speed) || speed <= 0) return { willApply: false, speed: 1, percent: 0, pitchCents: 0, reason: 'kein tempo' };
  if (Math.abs(speed - 1) <= TEMPO_EPSILON) return { willApply: false, speed, percent: (speed - 1) * 100, pitchCents: 0, reason: 'praktisch gleich' };
  return {
    willApply: true,
    speed,
    percent: (speed - 1) * 100,
    pitchCents: options.pitchFollowsTempo === true ? centsFromRatio(speed) : 0,
    reason: 'angepasst',
  };
}

// ── Texte ───────────────────────────────────────────────────────────────────

export function fmtSigned(value: number, digits = 1, unit = ''): string {
  const sign = value >= 0 ? '+' : '−';
  return `${sign}${Math.abs(value).toFixed(digits)}${unit}`;
}

/** Ein Satz für Statuszeile und Protokoll; null, wenn es nichts zu melden gibt. */
export function tempoFitNote(report: TempoFitReport): string | null {
  if (report.applied) {
    const dauer = `${report.secondsBefore.toFixed(3)} s → ${report.secondsAfter.toFixed(3)} s`;
    const ton =
      report.method === 'resample'
        ? `Tonhöhe ${fmtSigned(report.pitchCents, 0, ' Cent')} (${fmtSigned(semitonesFromRatio(report.speed), 2, ' Halbtöne')})`
        : 'Tonhöhe bleibt gleich';
    const weg = report.method === 'vocoder' ? 'Phasenvocoder' : report.method === 'wsola' ? 'Überlagerung' : 'neu abgetastet';
    return `Tempo an Zielspur angepasst (${weg}): ${report.sourceBpm.toFixed(1)} → ${report.targetBpm.toFixed(1)} BPM (${dauer}, ${ton})`;
  }
  if (report.skipped === 'praktisch gleich') return null;
  if (report.skipped === 'aus') return 'Tempoangleichung aus – der Clip behält seine alte Dauer';
  if (report.skipped === 'kein tempo') return 'Ohne Beat-Raster in Quell- oder Zielspur keine Tempoangleichung';
  if (report.skipped === 'zu kurz' || report.skipped === 'stumm') return report.note ?? null;
  return null;
}

/** Kurzfassung für Badges und Menüpunkte. */
export function describeTempoFit(report: TempoFitReport): string {
  if (!report.applied) return report.note ?? 'keine Tempoangleichung';
  const parts = [
    `${report.sourceBpm.toFixed(1)} → ${report.targetBpm.toFixed(1)} BPM`,
    `${fmtSigned((report.speed - 1) * 100, 1, ' %')}`,
    report.method === 'resample' ? `Tonhöhe ${fmtSigned(report.pitchCents, 0, ' Cent')}` : 'Tonhöhe gehalten',
    `${report.secondsBefore.toFixed(3)} → ${report.secondsAfter.toFixed(3)} s`,
  ];
  return parts.join(' · ');
}
