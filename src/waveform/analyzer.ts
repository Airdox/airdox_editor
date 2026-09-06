/**
 * @license
 * Wellenform-Analyse für die Anzeige.
 *
 * Wichtig für die Projektregel „100 % Rekordbox-Daten“: Diese Datei ist die
 * EIZIGE Stelle im Projekt, die selbst Kurven berechnet. Sie ist der Behelf für
 * Material, zu dem Rekordbox nichts geliefert hat (eigene WAV-Dateien, Demospur)
 * und für die Fenster, die ein Eingriff neu erzeugt. Sie erkennt kein Tempo,
 * keine Beats und ersetzt keine importierte Kurve, solange es sie gibt – die
 * Herkunft jeder Kurve steht als `origin` an den Daten und ist im Editor lesbar.
 */

import { DataOrigin, WaveformAnalysisData } from '../types/rekordbox';
import { PcmAudio, pcmSampleCount } from '../audio/pcm';

export function analyzeAudioBuffer(
  buffer: AudioBuffer,
  origin: DataOrigin = DataOrigin.LOCAL_ANALYSIS
): WaveformAnalysisData {
  const pcm: PcmAudio = {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch)),
  };
  return analyzePcm(pcm, origin);
}

/**
 * Dieselbe Analyse auf dem reinen PCM-Modell – ohne AudioContext, damit nach
 * jedem Schnitt dieselbe Berechnung läuft, die auch die Tests prüfen.
 */
export function analyzePcm(
  pcm: PcmAudio,
  origin: DataOrigin = DataOrigin.LOCAL_ANALYSIS
): WaveformAnalysisData {
  const sampleRate = pcm.sampleRate || 44100;
  if (pcmSampleCount(pcm) === 0) {
    return emptyAnalysis(0, origin);
  }
  const left = pcm.channels[0] ?? new Float32Array(0);
  const right = pcm.channels.length > 1 ? pcm.channels[1] : left;
  const length = left.length;

  // Aim for ~150-200 buckets per second of audio for ultra-crisp DJ zoom levels
  const bucketsPerSecond = 180;
  const totalBuckets = Math.max(100, Math.floor((length / sampleRate) * bucketsPerSecond));
  const samplesPerBucket = Math.max(1, Math.floor(length / totalBuckets));

  const out = emptyBuckets(totalBuckets);
  fillBuckets(left, right, sampleRate, 0, length, samplesPerBucket, out, 0, totalBuckets);

  return {
    length: totalBuckets,
    peaks: out.peaks,
    peaksL: out.peaksL,
    peaksR: out.peaksR,
    lowEnergy: out.lowEnergy,
    midEnergy: out.midEnergy,
    highEnergy: out.highEnergy,
    origin,
  };
}

/**
 * Dieselbe Rechnung auf einem Zeitfenster und mit vorgegebener Bucketbreite.
 * Nötig, damit nach einem Eingriff nur die betroffene Stelle neu gezeichnet wird
 * – in der Auflösung, die die Spur ohnehin hat, statt die ganze importierte
 * Kurve wegzuwerfen (`Bearbeiten ≠ neu analysieren`).
 */
export function analyzePcmWindow(
  pcm: PcmAudio,
  fromSec: number,
  toSec: number,
  bucketDurationSec: number,
  origin: DataOrigin = DataOrigin.LOCAL_ANALYSIS
): WaveformAnalysisData {
  const sampleRate = pcm.sampleRate || 44100;
  const left = pcm.channels[0] ?? new Float32Array(0);
  const right = pcm.channels.length > 1 ? pcm.channels[1] : left;
  const length = left.length;
  const from = Math.max(0, Math.min(length, Math.floor(fromSec * sampleRate)));
  const to = Math.max(from, Math.min(length, Math.ceil(toSec * sampleRate)));
  if (to <= from) return emptyAnalysis(1, origin);
  const samplesPerBucket = Math.max(1, Math.round(bucketDurationSec * sampleRate));
  const totalBuckets = Math.max(1, Math.ceil((to - from) / samplesPerBucket));
  const out = emptyBuckets(totalBuckets);
  fillBuckets(left, right, sampleRate, from, to, samplesPerBucket, out, 0, totalBuckets);
  return {
    length: totalBuckets,
    peaks: out.peaks,
    peaksL: out.peaksL,
    peaksR: out.peaksR,
    lowEnergy: out.lowEnergy,
    midEnergy: out.midEnergy,
    highEnergy: out.highEnergy,
    origin,
  };
}

interface BucketArrays {
  peaks: Float32Array;
  peaksL: Float32Array;
  peaksR: Float32Array;
  lowEnergy: Float32Array;
  midEnergy: Float32Array;
  highEnergy: Float32Array;
}

function emptyBuckets(count: number): BucketArrays {
  return {
    peaks: new Float32Array(count),
    peaksL: new Float32Array(count),
    peaksR: new Float32Array(count),
    lowEnergy: new Float32Array(count),
    midEnergy: new Float32Array(count),
    highEnergy: new Float32Array(count),
  };
}

function emptyAnalysis(count: number, origin: DataOrigin): WaveformAnalysisData {
  const buckets = emptyBuckets(count);
  return {
    length: count,
    peaks: buckets.peaks,
    peaksL: buckets.peaksL,
    peaksR: buckets.peaksR,
    lowEnergy: buckets.lowEnergy,
    midEnergy: buckets.midEnergy,
    highEnergy: buckets.highEnergy,
    origin,
  };
}

/**
 * Bucket für Bucket über das Material – dieselbe Arithmetik, die `analyzePcm`
 * immer benutzt hat, nur aus dem Ganzen herausgelöst, damit `analyzePcm` und
 * `analyzePcmWindow` garantiert identische Kurven liefern.
 */
function fillBuckets(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  startSample: number,
  endSample: number,
  samplesPerBucket: number,
  out: BucketArrays,
  bucketOffset: number,
  bucketCount: number
): void {
  // Simplified Butterworth-style IIR filter coefficients for real-time 3-band separation
  // Low-pass ~250 Hz, Band-pass 250-3500 Hz, High-pass >3500 Hz
  const dt = 1.0 / sampleRate;
  const rcLow = 1.0 / (2.0 * Math.PI * 260.0);
  const alphaLow = dt / (rcLow + dt);

  const rcHigh = 1.0 / (2.0 * Math.PI * 3500.0);
  const alphaHigh = rcHigh / (rcHigh + dt);

  let lowPrevL = 0;
  let highPrevL = 0;
  let inPrevL = 0;

  const { peaks, peaksL, peaksR, lowEnergy, midEnergy, highEnergy } = out;

  for (let b = 0; b < bucketCount; b++) {
    const startIdx = startSample + b * samplesPerBucket;
    const endIdx = Math.min(startIdx + samplesPerBucket, endSample);
    const o = bucketOffset + b;
    if (o >= peaks.length) break;

    let maxL = 0;
    let maxR = 0;
    let lowSum = 0;
    let midSum = 0;
    let highSum = 0;
    let count = 0;

    for (let i = startIdx; i < endIdx; i += 2) {
      const sL = left[i];
      const sR = right[i];
      const absL = Math.abs(sL);
      const absR = Math.abs(sR);
      if (absL > maxL) maxL = absL;
      if (absR > maxR) maxR = absR;

      // Low pass
      lowPrevL = lowPrevL + alphaLow * (sL - lowPrevL);
      const lowVal = Math.abs(lowPrevL);

      // High pass
      const highVal = Math.abs(alphaHigh * (highPrevL + sL - inPrevL));
      highPrevL = highVal;
      inPrevL = sL;

      // Mid band: difference
      const midVal = Math.max(0, absL - lowVal * 0.7 - highVal * 0.7);

      lowSum += lowVal;
      midSum += midVal;
      highSum += highVal;
      count++;
    }

    peaksL[o] = Math.min(1.0, maxL);
    peaksR[o] = Math.min(1.0, maxR);
    peaks[o] = Math.min(1.0, Math.max(maxL, maxR));

    if (count > 0) {
      // Kein Nachheben: die Band-Energien sind die gemittelten Beträge dieses
      // Filters. Diese Rechnung ist unser Eigenbehelf für Material ohne
      // Rekordbox-Daten – eine „vibrante“ Skala wäre eine erfundene Aussage.
      lowEnergy[o] = Math.min(1.0, lowSum / count);
      midEnergy[o] = Math.min(1.0, midSum / count);
      highEnergy[o] = Math.min(1.0, highSum / count);
    }
  }
}

/**
 * Klartext für die Herkunft der Wellenform. Steht im Editor sichtbar neben den
 * Buckets – eine Eigenberechnung soll nie als Rekordbox-Wert gelesen werden.
 */
export function analysisSourceLabel(origin: DataOrigin | undefined): string {
  switch (origin) {
    case DataOrigin.REKORDBOX_ANLZ:
      return 'AUS DER ANALYSE-DATEI';
    case DataOrigin.REKORDBOX_XML:
    case DataOrigin.REKORDBOX_DB:
      return 'AUS DER BIBLIOTHEK';
    case DataOrigin.ANALYSIS_CACHE:
      return 'AUS DEM ANALYSE-CACHE';
    case DataOrigin.PROJECT:
      return 'NACH DEM SCHNITT NEU GEZEICHNET';
    case DataOrigin.USER_EDIT:
      return 'NUTZERBEARBEITUNG';
    case DataOrigin.GENERATED_FALLBACK:
      return 'EIGENBERECHNUNG – KEINE REKORDBOX-DATEN';
    case DataOrigin.LOCAL_ANALYSIS:
      return 'EIGENBERECHNUNG';
    default:
      return 'HERKUNFT UNBEKANNT';
  }
}

/**
 * Welche Anzeigeverfahren die vorliegenden Daten wirklich tragen. Eine Wellenform
 * aus einer Lage (PWAV/PWV2: low = mid = high = peak) kann kein RGB- oder
 * 3Band-Bild liefern – anzubieten wäre eine erfundene Farbe.
 */
export function waveformModesFor(
  analysis: WaveformAnalysisData
): ('BLUE' | 'RGB' | '3BAND')[] {
  const modes: ('BLUE' | 'RGB' | '3BAND')[] = [];
  if (analysis.length <= 0) return modes;
  let peak = false;
  for (let i = 0; i < analysis.length; i++) if (analysis.peaks[i] > 0) { peak = true; break; }
  if (peak) modes.push('BLUE');
  const bands =
    analysis.lowEnergy.length === analysis.length &&
    analysis.midEnergy.length === analysis.length &&
    analysis.highEnergy.length === analysis.length;
  let bandsDiffer = false;
  if (bands) {
    for (let i = 0; i < analysis.length; i++) {
      if (
        Math.abs(analysis.lowEnergy[i] - analysis.midEnergy[i]) > 1e-6 ||
        Math.abs(analysis.midEnergy[i] - analysis.highEnergy[i]) > 1e-6
      ) {
        bandsDiffer = true;
        break;
      }
    }
  }
  if (bandsDiffer) {
    modes.push('3BAND');
    let stereo = false;
    for (let i = 0; i < analysis.length; i++) {
      if (Math.abs(analysis.peaksL[i] - analysis.peaksR[i]) > 1e-6) {
        stereo = true;
        break;
      }
    }
    if (stereo) modes.push('RGB');
  }
  return modes;
}

/**
 * Extracts mini peak profile (e.g. 64 buckets) for Palette clips
 */
export function extractMiniPeaks(buffer: AudioBuffer, numBuckets: number = 64): number[] {
  const pcm: PcmAudio = {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch)),
  };
  return extractMiniPeaksPcm(pcm, numBuckets);
}

/**
 * Mini-Peaks auf dem PCM-Modell – dieselbe Rechnung ohne AudioContext, damit
 * Bibliothek, Clips und Tests dieselben Profile sehen.
 */
export function extractMiniPeaksPcm(pcm: PcmAudio, numBuckets: number = 64): number[] {
  const left = pcm.channels[0] ?? new Float32Array(0);
  const len = left.length;
  const step = Math.max(1, Math.floor(len / Math.max(1, numBuckets)));
  const result: number[] = [];

  for (let b = 0; b < numBuckets; b++) {
    const start = b * step;
    if (start >= len) {
      result.push(0);
      continue;
    }
    const end = Math.min(start + step, len);
    let max = 0;
    for (let i = start; i < end; i += 4) {
      const val = Math.abs(left[i]);
      if (val > max) max = val;
    }
    result.push(Math.min(1.0, max));
  }

  return result;
}
