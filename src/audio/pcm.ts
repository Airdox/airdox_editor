/**
 * @license
 * Airdox_intelligents_Editor – reiner PCM-Kern
 *
 * Alle Schnitt-, Einfüge- und Mischoperationen arbeiten auf diesem Modell, das
 * ausschließlich Float32Array-Kanäle und eine Samplingrate braucht. Bewusst frei
 * von AudioContext, DOM und Electron: dieselben Funktionen, die im Editor laufen,
 * laufen damit auch in den Tests unter Node.
 */

export interface PcmAudio {
  sampleRate: number;
  /** Ein Float32Array pro Kanal, alle gleich lang. */
  channels: Float32Array[];
}

export function pcmFromAudioBuffer(buffer: AudioBuffer): PcmAudio {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(Float32Array.from(buffer.getChannelData(ch)));
  }
  return { sampleRate: buffer.sampleRate, channels };
}

export function pcmToAudioBuffer(ctx: BaseAudioContext, pcm: PcmAudio): AudioBuffer {
  const buffer = ctx.createBuffer(pcm.channels.length, pcmSampleCount(pcm), pcm.sampleRate);
  for (let ch = 0; ch < pcm.channels.length; ch++) {
    buffer.getChannelData(ch).set(pcm.channels[ch]);
  }
  return buffer;
}

export function pcmSampleCount(pcm: PcmAudio): number {
  return pcm.channels.length > 0 ? pcm.channels[0].length : 0;
}

export function pcmDuration(pcm: PcmAudio): number {
  return pcmSampleCount(pcm) / pcm.sampleRate;
}

export function pcmClone(pcm: PcmAudio): PcmAudio {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => Float32Array.from(ch)),
  };
}

/** Leere Spur mit gleicher Samplingrate/Kanalzahl (für Einmalfenster). */
export function pcmSilence(pcm: PcmAudio, samples: number): PcmAudio {
  const channels = pcm.channels.map(() => new Float32Array(Math.max(0, samples)));
  return { sampleRate: pcm.sampleRate, channels };
}

/**
 * Sample-Index für eine Zeitangabe. Abgerundet, damit ein Schnitt immer auf
 * einem Sampleende landet und keine halben Samples entstehen.
 */
export function sampleIndex(sampleRate: number, seconds: number): number {
  return Math.max(0, Math.floor(seconds * sampleRate));
}

export function clampRange(
  sampleRate: number,
  totalSamples: number,
  startSec: number,
  endSec: number
): { startSample: number; endSample: number; start: number; end: number; length: number } {
  let startSample = sampleIndex(sampleRate, Math.max(0, startSec));
  let endSample = sampleIndex(sampleRate, Math.max(0, endSec));
  startSample = Math.min(startSample, totalSamples);
  endSample = Math.min(Math.max(endSample, startSample), totalSamples);
  return {
    startSample,
    endSample,
    start: startSample / sampleRate,
    end: endSample / sampleRate,
    length: endSample - startSample,
  };
}

/** Like clampRange, but for values that are already sample indices. */
export function clampSampleRange(
  totalSamples: number,
  startSample: number,
  endSample: number
): { startSample: number; endSample: number; length: number } {
  const a = Math.max(0, Math.min(Math.floor(startSample), totalSamples));
  const b = Math.min(Math.max(Math.floor(endSample), a), totalSamples);
  return { startSample: a, endSample: b, length: b - a };
}

/** Ausschnitt in Sekunden – das Ergebnis enthält genau die Samples [a, b). */
export function pcmSlice(pcm: PcmAudio, startSec: number, endSec: number): PcmAudio {
  const total = pcmSampleCount(pcm);
  const { startSample, length } = clampRange(pcm.sampleRate, total, startSec, endSec);
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((src) => Float32Array.from(src.subarray(startSample, startSample + length))),
  };
}

/** Ausschnitt per Samplebereich (für exakte Blockvergleiche in Tests). */
export function pcmSliceSamples(pcm: PcmAudio, startSample: number, endSample: number): PcmAudio {
  const total = pcmSampleCount(pcm);
  const a = Math.max(0, Math.min(startSample, total));
  const b = Math.max(a, Math.min(endSample, total));
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((src) => Float32Array.from(src.subarray(a, b))),
  };
}

export function pcmConcat(parts: PcmAudio[]): PcmAudio {
  const filled = parts.filter((p) => pcmSampleCount(p) > 0);
  if (filled.length === 0) {
    return { sampleRate: parts[0]?.sampleRate ?? 44100, channels: [new Float32Array(0)] };
  }
  const sampleRate = filled[0].sampleRate;
  const channelCount = Math.max(...filled.map((p) => p.channels.length));
  const total = filled.reduce((sum, p) => sum + pcmSampleCount(p), 0);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(total));
  let at = 0;
  for (const part of filled) {
    for (let ch = 0; ch < channelCount; ch++) {
      const src = part.channels[Math.min(ch, part.channels.length - 1)];
      channels[ch].set(src, at);
    }
    at += pcmSampleCount(part);
  }
  return { sampleRate, channels };
}

/**
 * Blende einen Block an einer Sampleposition ein und schiebe den Rest nach
 * hinten (Ripple). `atSample` darf am Ende liegen, dann wird angehängt.
 */
export function pcmInsertSamples(pcm: PcmAudio, atSample: number, block: PcmAudio): PcmAudio {
  const total = pcmSampleCount(pcm);
  const at = Math.max(0, Math.min(Math.floor(atSample), total));
  const before = pcmSliceSamples(pcm, 0, at);
  const after = pcmSliceSamples(pcm, at, total);
  return pcmConcat([before, block, after]);
}

/** Entfernt einen Samplebereich und zieht den Rest nach (Ripple-Schnitt). */
export function pcmRemoveSamples(pcm: PcmAudio, startSample: number, endSample: number): PcmAudio {
  const total = pcmSampleCount(pcm);
  const { startSample: a, endSample: b } = clampSampleRange(total, startSample, endSample);
  if (b <= a) return pcmClone(pcm);
  return pcmConcat([pcmSliceSamples(pcm, 0, a), pcmSliceSamples(pcm, b, total)]);
}

/**
 * Schreibt einen Block über einen Bereich, ohne die Länge zu ändern.
 * Ein kurzer Block lässt den Rest des Bereichs stumm (echtes Ersetzen),
 * ein langer Block wird auf die Bereichslänge beschnitten.
 */
export function pcmOverwrite(
  pcm: PcmAudio,
  startSample: number,
  endSample: number,
  block: PcmAudio | null,
  options: { gain?: number; extendIfNeeded?: boolean } = {}
): PcmAudio {
  const total = pcmSampleCount(pcm);
  const { startSample: a, endSample: b } = clampSampleRange(total, startSample, endSample);
  const gain = options.gain ?? 1.0;
  const blockLength = block ? pcmSampleCount(block) : 0;
  const needed = options.extendIfNeeded ? Math.max(total, a + blockLength) : total;

  const out: PcmAudio = {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((src) => {
      const ch = new Float32Array(needed);
      ch.set(src);
      ch.fill(0, a, b);
      return ch;
    }),
  };

  if (block && blockLength > 0) {
    for (let ch = 0; ch < out.channels.length; ch++) {
      const dest = out.channels[ch];
      const src = block.channels[Math.min(ch, block.channels.length - 1)];
      const limit = Math.min(blockLength, dest.length - a);
      for (let i = 0; i < limit; i++) {
        dest[a + i] = src[i] * gain;
      }
    }
  }
  return out;
}

/** Bereich auf Null setzen (Clear/Mute), Länge bleibt. */
export function pcmSilenceRange(pcm: PcmAudio, startSample: number, endSample: number): PcmAudio {
  return pcmOverwrite(pcm, startSample, endSample, null);
}

/** Was eine Überlagerung pegeltechnisch getan hat – für Bericht, Oberfläche, Tests. */
export interface MixHeadroomResult {
  pcm: PcmAudio;
  /** tatsächlich genutzte Verstärkung des zugeführten Blocks */
  gainUsed: number;
  /** angeforderte Verstärkung */
  gainRequested: number;
  /** größter Ausschlag des trockenen Materials im Überlappungsbereich vorher */
  dryPeak: number;
  /** Peak des Ergebnisses im Überlappungsbereich */
  peakAfter: number;
  /** < 1, wenn der Bereich wegen vorhandener Übersteuerung gesenkt wurde */
  regionScale: number;
  /** true, wenn der Clip leiser gemischt werden musste */
  attenuated: boolean;
}

/**
 * Lineare Überlagerung mit Kopfraum – der einzige Mischweg des Editors.
 *
 * Früher: `tanh(dry + wet)`. Das begrenzt zwar hartes Clipping, verbiegt aber
 * jedes Sample des Überlappungsbereichs (auch die leisen) und verändert damit
 * vorhandenes Material. Hier bleibt das trockene Material bitgenau:
 *
 *   1. Der zugeführte Block wird höchstens so weit eingemischt, dass
 *      |dry| + |wet| · gain die Obergrenze nicht überschreitet
 *      (Dreiecksungleichung – Übersteuerung ist damit ausgeschlossen, nicht nur gedämpft).
 *   2. Liegt das trockene Material bereits über der Obergrenze, wird der
 *      Überlappungsbereich als Ganzes auf die Obergrenze skaliert (`regionScale`).
 */
export function pcmMixHeadroom(
  pcm: PcmAudio,
  atSample: number,
  block: PcmAudio,
  gain = 1,
  limitSamples?: number,
  ceiling = 0.999
): MixHeadroomResult {
  const out = pcmClone(pcm);
  const blockLength = pcmSampleCount(block);
  const maxByRange = limitSamples === undefined ? blockLength : Math.max(0, limitSamples);
  const destLength = out.channels[0] ? out.channels[0].length - atSample : 0;
  const limit = Math.max(0, Math.min(blockLength, maxByRange, destLength));
  const start = Math.max(0, atSample);
  const end = start + limit;

  const dryPeak = limit > 0 ? pcmPeak(out, start, end) : 0;
  const clipPeak = pcmPeak(block);
  const wetPeak = clipPeak * Math.abs(gain);

  // 1) Bereich, der ohne Zutun schon über der Obergrenze liegt, absenken.
  let regionScale = 1;
  if (dryPeak > ceiling) {
    regionScale = ceiling / dryPeak;
    scaleRange(out, start, end, regionScale);
  }
  const dryAfterScale = dryPeak * regionScale;

  // 2) Zugeführten Block nur so weit einmischen, dass die Summe sicher bleibt.
  let gainUsed = gain;
  if (dryAfterScale + wetPeak > ceiling) {
    gainUsed = clipPeak > 0 && gain !== 0 ? (gain * Math.max(0, ceiling - dryAfterScale)) / wetPeak : 0;
  }
  mixInto(out, start, block, gainUsed, limit);

  return {
    pcm: out,
    gainUsed,
    gainRequested: gain,
    dryPeak,
    peakAfter: limit > 0 ? pcmPeak(out, start, end) : dryAfterScale,
    regionScale,
    attenuated: Math.abs(gainUsed - gain) > 1e-12,
  };
}

function scaleRange(pcm: PcmAudio, start: number, end: number, factor: number): void {
  if (factor === 1) return;
  for (const ch of pcm.channels) {
    for (let i = start; i < end; i++) ch[i] *= factor;
  }
}

function mixInto(pcm: PcmAudio, atSample: number, block: PcmAudio, gain: number, limit: number): void {
  if (gain === 0 || limit <= 0) return;
  for (let ch = 0; ch < pcm.channels.length; ch++) {
    const dest = pcm.channels[ch];
    const src = block.channels[Math.min(ch, block.channels.length - 1)];
    for (let i = 0; i < limit; i++) {
      const at = atSample + i;
      if (at >= dest.length) break;
      dest[at] += src[i] * gain;
    }
  }
}

/** Größter Ausschlag (Maximalbetrag) eines Bereichs, 0 bei leerem Material. */
export function pcmPeak(pcm: PcmAudio, startSample = 0, endSample?: number): number {
  const total = pcmSampleCount(pcm);
  const a = Math.max(0, Math.floor(Number.isFinite(startSample) ? startSample : 0));
  const b = Math.min(total, Math.floor(Number.isFinite(endSample) ? (endSample as number) : total));
  let peak = 0;
  for (const ch of pcm.channels) {
    for (let i = a; i < b; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/** Alles um einen Faktor lauter/leiser – neue Arrays, das Original bleibt unverändert. */
export function pcmScale(pcm: PcmAudio, gain: number): PcmAudio {
  const factor = Number.isFinite(gain) ? gain : 1;
  if (factor === 1) return pcmClone(pcm);
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const out = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) out[i] = ch[i] * factor;
      return out;
    }),
  };
}

/**
 * Prüft, ob zwei Bereiche samplegenau gleich sind (Beweis für Kopien und
 * Verschchiebungen). Relative Toleranz 0: die Operationen kopieren nur.
 */
export function pcmRangesEqual(a: PcmAudio, aStart: number, b: PcmAudio, bStart: number, samples: number): boolean {
  if (a.channels.length !== b.channels.length) return false;
  for (let ch = 0; ch < a.channels.length; ch++) {
    const ca = a.channels[ch];
    const cb = b.channels[ch];
    if (aStart + samples > ca.length || bStart + samples > cb.length) return false;
    for (let i = 0; i < samples; i++) {
      if (ca[aStart + i] !== cb[bStart + i]) return false;
    }
  }
  return true;
}

/** RMS-Energie eines Bereichs – nutzbar, um Inhalt grob zu vergleichen. */
export function pcmRms(pcm: PcmAudio, startSample = 0, endSample?: number): number {
  const total = pcmSampleCount(pcm);
  const a = Math.max(0, startSample);
  const b = Math.min(total, endSample ?? total);
  if (b <= a || pcm.channels.length === 0) return 0;
  let sum = 0;
  for (let ch = 0; ch < pcm.channels.length; ch++) {
    const src = pcm.channels[ch];
    for (let i = a; i < b; i++) sum += src[i] * src[i];
  }
  return Math.sqrt(sum / ((b - a) * pcm.channels.length));
}
