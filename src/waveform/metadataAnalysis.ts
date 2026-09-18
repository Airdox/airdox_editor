/**
 * @license
 * Metadata-Waveform-Analysis (klar gekennzeichneter Fallback).
 *
 * Erzeugt eine darstellbare Waveform-Analyse ausschließlich aus Daten, die
 * zuvor tatsächlich aus der Rekordbox Master Database (bzw. einer zulässigen
 * ergänzenden Rekordbox-Quelle) gelesen wurden: Dauer, BPM, First Beat und
 * Cue-Positionen.
 *
 * WICHTIG – Abgrenzung:
 *  - Dieser Fallback ersetzt NUR fehlende ANLZ-Analysedaten.
 *  - Er darf niemals ein fehlgeschlagenes Master-DB-/SQLCipher-Gate
 *    verschleiern. Der Aufrufer muss das DB-Gate zuvor erfolgreich
 *    durchlaufen haben.
 *  - Das Ergebnis trägt `origin: DataOrigin.GENERATED_FALLBACK` und ist damit
 *    in UI und Export eindeutig als abgeleitet erkennbar – es wird nicht als
 *    echte Rekordbox-ANLZ-Waveform ausgegeben.
 */

import { CuePoint, DataOrigin, WaveformAnalysisData } from '../types/rekordbox';

/** Buckets pro Sekunde – identisch zur echten Audioanalyse (analyzeAudioBuffer). */
const BUCKETS_PER_SECOND = 200;

/**
 * Baut eine Beat-/Cue-abgeleitete Hüllkurve.
 *
 * @param duration Dauer in Sekunden (aus der Master DB bzw. dem Originalaudio).
 * @param bpm      BPM aus der Master DB / ANLZ. Ohne gültigen Wert wird keine
 *                 Beat-Modulation erzeugt (kein erfundenes Tempo).
 * @param cues     Tatsächlich geladene Cue-Punkte (dürfen leer sein).
 * @param firstBeat First-Beat-Offset in Sekunden aus der Rekordbox-Pipeline.
 * @returns Analyse mit `origin = GENERATED_FALLBACK`, oder null wenn nicht
 *          einmal eine gültige Dauer vorliegt (dann wird nichts erfunden).
 */
export function generateAnalysisFromMetadata(
  duration: number,
  bpm: number | null | undefined,
  cues: CuePoint[] = [],
  firstBeat: number = 0
): WaveformAnalysisData | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;

  const totalBuckets = Math.max(100, Math.floor(duration * BUCKETS_PER_SECOND));
  const secPerBucket = duration / totalBuckets;

  const peaks = new Float32Array(totalBuckets);
  const peaksL = new Float32Array(totalBuckets);
  const peaksR = new Float32Array(totalBuckets);
  const lowEnergy = new Float32Array(totalBuckets);
  const midEnergy = new Float32Array(totalBuckets);
  const highEnergy = new Float32Array(totalBuckets);

  const validBpm = Number.isFinite(bpm as number) && (bpm as number) > 0 ? (bpm as number) : null;
  const secPerBeat = validBpm ? 60 / validBpm : null;
  const anchor = Number.isFinite(firstBeat) && firstBeat > 0 ? firstBeat : 0;

  // Cue-Positionen strukturieren die Energie: ab einem Memory-/Hot-Cue steigt
  // die Intensität (Rekordbox-typische Abschnittsgrenzen). Ohne Cues bleibt
  // eine gleichmäßige Grundenergie – nichts wird hinzuerfunden.
  const cuePositions = cues
    .map((cue) => cue.position)
    .filter((pos) => Number.isFinite(pos) && pos >= 0 && pos <= duration)
    .sort((a, b) => a - b);

  const sectionLevelAt = (time: number): number => {
    if (cuePositions.length === 0) return 0.62;
    let index = 0;
    for (const pos of cuePositions) {
      if (time >= pos) index += 1;
      else break;
    }
    // 0.45 … 0.9 in gleichmäßigen Stufen über die vorhandenen Cue-Abschnitte.
    const span = cuePositions.length;
    return 0.45 + (Math.min(index, span) / Math.max(1, span)) * 0.45;
  };

  for (let b = 0; b < totalBuckets; b++) {
    const time = b * secPerBucket;
    const level = sectionLevelAt(time);

    let beatFactor = 1;
    if (secPerBeat) {
      const phase = ((time - anchor) % secPerBeat + secPerBeat) % secPerBeat;
      const normalized = phase / secPerBeat;
      // Transienten-Hülle: scharfer Anschlag auf dem Beat, exponentieller Abfall.
      beatFactor = 0.55 + 0.45 * Math.exp(-6 * normalized);
    }

    const amplitude = Math.min(1, level * beatFactor);
    peaks[b] = amplitude;
    peaksL[b] = amplitude;
    peaksR[b] = amplitude;
    // Bass folgt der Beat-Hülle, Mitten der Abschnittsenergie, Höhen dazwischen.
    lowEnergy[b] = Math.min(1, amplitude * (secPerBeat ? beatFactor : 0.8));
    midEnergy[b] = Math.min(1, level * 0.85);
    highEnergy[b] = Math.min(1, level * 0.55 + (secPerBeat ? (beatFactor - 0.55) * 0.5 : 0));
  }

  return {
    length: totalBuckets,
    peaks,
    peaksL,
    peaksR,
    lowEnergy,
    midEnergy,
    highEnergy,
    origin: DataOrigin.GENERATED_FALLBACK,
    secPerBucket,
    sourceTag: 'METADATA_FALLBACK',
  };
}
