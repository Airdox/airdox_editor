/**
 * @license
 * Airdox_intelligents_Editor – deterministische Demospur
 *
 * Erzeugt einen gutmütigen Test-Track (Kick, Bass, Hi-Hat, Snare) mit einem
 * Beatgrid, auf dem alle Takte sauber sitzen. Jeder Takt enthält zusätzlich
 * eine eigene Anzahl an hochfrequente Blips (Takt 1 = 1 Blip, Takt 2 = 2 …) und
 * eine eigene Basstonfrequenz. Damit lässt sich ein Schnitt nicht nur über
 * Samplezahlen prüfen, sondern auch inhaltlich: „welcher Takt liegt jetzt wo“.
 *
 * Zusätzlich enthält jeder Takt im letzten Drittel einen eigenen Identifikations-
 * ton (höhere Frequenz, klar von Kick/Bass/Hi-Hat getrennt). Damit kann ein Test
 * inhaltlich sagen: „Takt 5 steht jetzt an Position 4“ – nicht nur „Samplezahl stimmt“.
 *
 * Der Generator ist vollständig deterministisch (kein Zufall), die Dateien
 * haben daher bei jedem Lauf dieselbe Prüfsumme.
 */

import { PcmAudio, pcmDuration } from './pcm';

export interface DemoTrackOptions {
  bars?: number;
  bpm?: number;
  sampleRate?: number;
  meter?: number;
  /** Gain der Gesamtabmischung (0..1). */
  level?: number;
}

export interface DemoTrack {
  pcm: PcmAudio;
  bpm: number;
  sampleRate: number;
  meter: number;
  bars: number;
  firstBeat: number;
  duration: number;
  /** Frequenz des Identifikationstons pro Takt. */
  barFrequencies: number[];
}

const IDENTIFIER_LEVEL = 0.45;

export function generateDemoTrack(options: DemoTrackOptions = {}): DemoTrack {
  const bars = Math.max(1, Math.floor(options.bars ?? 8));
  const bpm = options.bpm ?? 128;
  const sampleRate = options.sampleRate ?? 44100;
  const meter = Math.max(1, Math.floor(options.meter ?? 4));
  const level = options.level ?? 0.9;

  const secondsPerBeat = 60 / bpm;
  const beatSamples = Math.round(secondsPerBeat * sampleRate);
  const totalSamples = beatSamples * meter * bars;
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);

  const barFrequencies: number[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * meter * beatSamples;
    const bassFreq = 60 + bar * 18; // eigener Basston pro Takt
    const identifierFreq = 900 + bar * 140; // eigener Identifikationston pro Takt
    barFrequencies.push(identifierFreq);

    for (let beat = 0; beat < meter; beat++) {
      const beatStart = barStart + beat * beatSamples;

      for (let i = 0; i < beatSamples && beatStart + i < totalSamples; i++) {
        const pos = i / beatSamples; // 0..1 innerhalb des Beats
        const t = i / sampleRate;

        // Kick auf jedem Beat: Durchziehender Sinus 150 -> 45 Hz, exponentiell ausklingend
        const kickFreq = 45 + 105 * Math.exp(-pos * 18);
        const kickEnv = Math.exp(-pos * 7);
        const kick = Math.sin(2 * Math.PI * kickFreq * t) * kickEnv * 0.72;

        // Hi-Hat auf der Off-Beat-Achtel
        const off = Math.abs(pos - 0.5);
        const hatEnv = off < 0.14 ? Math.exp(-off * 60) : 0;
        const hat = Math.sin(2 * Math.PI * 9500 * t) * hatEnv * 0.16;

        // Snare auf Beat 2 und 4
        const snare =
          (beat === 1 || beat === 3) && pos < 0.3
            ? (Math.sin(2 * Math.PI * 190 * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t)) * Math.exp(-pos * 14) * 0.3
            : 0;

        left[beatStart + i] += kick + hat * 0.7 + snare;
        right[beatStart + i] += kick + hat * 1.25 + snare * 0.85;
      }
    }

    // Durationsbedingter Basston über den ganzen Takt (identifiziert den Takt)
    const barLen = meter * beatSamples;
    for (let i = 0; i < barLen && barStart + i < totalSamples; i++) {
      const t = i / sampleRate;
      const env = 0.6 + 0.4 * Math.sin((2 * Math.PI * i) / barLen);
      const bass = Math.sin(2 * Math.PI * bassFreq * t) * 0.22 * env;
      left[barStart + i] += bass;
      right[barStart + i] += bass * 0.9;
    }

    // Identifikationston im letzten Tritteld – leise Ein-/Ausblendung gegen Klicks
    const idStart = barStart + Math.floor(barLen * 0.62);
    const idLen = Math.floor(barLen * 0.33);
    const ramp = Math.max(1, Math.floor(sampleRate * 0.01));
    for (let i = 0; i < idLen && idStart + i < totalSamples; i++) {
      const env = Math.min(1, Math.min(i, idLen - i) / ramp);
      const value = Math.sin(2 * Math.PI * identifierFreq * ((idStart + i) / sampleRate)) * env * IDENTIFIER_LEVEL;
      left[idStart + i] += value;
      right[idStart + i] += value * 0.95;
    }
  }

  // Auf level normalisieren, damit nichts clippt
  let peak = 0;
  for (let i = 0; i < totalSamples; i++) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  if (peak > 0) {
    const scale = level / peak;
    for (let i = 0; i < totalSamples; i++) {
      left[i] *= scale;
      right[i] *= scale;
    }
  }

  const pcm: PcmAudio = { sampleRate, channels: [left, right] };
  return {
    pcm,
    bpm,
    sampleRate,
    meter,
    bars,
    firstBeat: 0,
    duration: pcmDuration(pcm),
    barFrequencies,
  };
}

/**
 * Erkennt, welchen Takt ein Bereich enthält: korreliert die Samples mit jedem
 * der Identifikationstöne und liefert den stärksten Treffer. `strength` ist die
 * normierte Korrelation (0..1) und erlaubt eine Aussage über die Sicherheit.
 */
export function dominantBarTone(
  pcm: PcmAudio,
  startSample: number,
  endSample: number,
  frequencies: number[]
): { index: number; strength: number; secondStrength: number } {
  const ch = pcm.channels[0];
  if (!ch) return { index: -1, strength: 0, secondStrength: 0 };
  const a = Math.max(0, Math.floor(startSample));
  const b = Math.min(ch.length, Math.floor(endSample));
  if (b - a < 64) return { index: -1, strength: 0, secondStrength: 0 };

  const scores = frequencies.map((freq, index) => {
    let re = 0;
    let im = 0;
    for (let i = a; i < b; i++) {
      const phase = (2 * Math.PI * freq * i) / pcm.sampleRate;
      re += ch[i] * Math.cos(phase);
      im += ch[i] * Math.sin(phase);
    }
    const n = b - a;
    return { index, magnitude: (2 * Math.sqrt(re * re + im * im)) / n };
  });
  scores.sort((x, y) => y.magnitude - x.magnitude);
  const best = scores[0] ?? { index: -1, magnitude: 0 };
  const second = scores[1] ?? { magnitude: 0 };
  return {
    index: best.index,
    strength: Math.round(best.magnitude * 1e6) / 1e6,
    secondStrength: Math.round(second.magnitude * 1e6) / 1e6,
  };
}

/** Beatgrid für die Demospur (erster Beat bei 0, Takt = meter Beats). */
export function demoBeatNodes(demo: DemoTrack) {
  const secondsPerBeat = 60 / demo.bpm;
  const total = Math.floor(demo.duration / secondsPerBeat);
  return Array.from({ length: total + 1 }, (_, i) => ({
    index: i,
    time: demo.firstBeat + i * secondsPerBeat,
    isBarStart: i % demo.meter === 0,
    barNumber: Math.floor(i / demo.meter) + 1,
    beatInBar: (i % demo.meter) + 1,
  }));
}
