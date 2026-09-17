/**
 * @license
 * airdox STFT Stem Separator (lokaler Fallback)
 *
 * Ersetzt den früheren Ein-Pol-Filter-Split, dessen gemessene Qualität auf
 * realem Material negativ war (SI-SDR -5.5 bis -10.8 dB auf MUSDB —
 * der Fehler war lauter als das Nutzsignal).
 *
 * Verfahren (klassisches DSP, deterministisch, ohne Modellgewichte):
 *  1. STFT (Hann 4096, Hop 1024) getrennt für Mitte (L+R)/2 und Seite (L-R)/2.
 *  2. Harmonic/Percussive-Separation per Median-Filterung des
 *     Magnituden-Spektrogramms (Fitzgerald 2010): Median über die Zeit ->
 *     harmonisch, Median über die Frequenz -> perkussiv.
 *  3. Weiche, pro Bin auf 1 summierende Wiener-artige Masken:
 *     DRUMS  = perkussiver Anteil,
 *     BASS   = harmonischer Anteil unterhalb der Bass-Grenzfrequenz,
 *     VOCALS = harmonischer, mittiger Anteil im Gesangsband (nur Mitte),
 *     OTHER  = Rest inklusive kompletter Seiten-Anteile.
 *  4. ISTFT mit Overlap-Add; OTHER wird im Zeitbereich als exakter Rest
 *     (source - vocals - drums - bass) gebildet, damit die vier Stems die
 *     Quelle sample-exakt rekonstruieren.
 *
 * Da alle Masken in [0,1] liegen und pro Bin auf 1 summieren, ist kein Stem
 * im Spektrum jemals lauter als der Mix — der frühere Normalisierungs-Blowup
 * (Übersteuern bei Solo/Mute) ist konstruktiv ausgeschlossen.
 *
 * Diese Qualität ist besser als der alte Splitter, bleibt aber unterhalb von
 * Demucs. Sie wird weiterhin ausdrücklich als Fallback gekennzeichnet.
 */

const FFT_SIZE = 4096;
const HOP = 1024;
const MEDIAN_TIME_FRAMES = 17; // Kernel der harmonischen Median-Filterung
const MEDIAN_FREQ_BINS = 17; // Kernel der perkussiven Median-Filterung
const CHUNK_FRAMES = 256; // Frames pro Verarbeitungs-Chunk
const MARGIN = (MEDIAN_TIME_FRAMES - 1) / 2 + 1; // Median-Kontext am Chunk-Rand
const EPS = 1e-12;

/** Iterative Radix-2-FFT mit vorberechneten Twiddles und Bit-Reversal. */
class Fft {
  private readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(size: number) {
    this.size = size;
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
  }

  forward(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const tw = k * step;
          const cr = this.cos[tw];
          const ci = this.sin[tw];
          const a = i + k;
          const b = a + half;
          const br = re[b] * cr - im[b] * ci;
          const bi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - br;
          im[b] = im[a] - bi;
          re[a] += br;
          im[a] += bi;
        }
      }
    }
  }

  /** Inverse FFT inkl. 1/N-Skalierung (Konjugations-Methode). */
  inverse(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this.forward(re, im);
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] = -im[i] / n;
    }
  }
}

/** Gleitender Median (ungerader Kernel) über ein Float32Array. */
function medianFilter(src: Float32Array, dst: Float32Array, kernel: number): void {
  const half = (kernel - 1) / 2;
  const n = src.length;
  const window: number[] = [];
  for (let i = 0; i < n; i++) {
    window.length = 0;
    const from = Math.max(0, i - half);
    const to = Math.min(n - 1, i + half);
    for (let j = from; j <= to; j++) window.push(src[j]);
    window.sort((a, b) => a - b);
    dst[i] = window[window.length >> 1];
  }
}

/** Bass-Gewicht: 1 unter 110 Hz, Cosinus-Übergang auf 0 bis 260 Hz. */
function bassWeight(freq: number): number {
  if (freq <= 110) return 1;
  if (freq >= 260) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * (freq - 110)) / 150));
}

/** Gesangsband: 0 unter 140 Hz, voll ab 320 Hz bis 8 kHz, Ausklang bis 13 kHz. */
function vocalBand(freq: number): number {
  if (freq <= 140 || freq >= 13000) return 0;
  if (freq < 320) return (freq - 140) / 180;
  if (freq <= 8000) return 1;
  return 1 - (freq - 8000) / 5000;
}

export interface StftStemArrays {
  vocals: Float32Array[];
  drums: Float32Array[];
  bass: Float32Array[];
  other: Float32Array[];
}

/**
 * Trennt die Quellkanäle in vier Stems. `other` wird als exakter Zeitbereichs-
 * Rest gebildet, sodass vocals+drums+bass+other === source (sample-exakt).
 */
export async function separateChannelsStft(
  source: Float32Array[],
  sampleRate: number,
  onProgress?: (fraction: number) => void
): Promise<StftStemArrays> {
  const channels = source.length;
  const length = source[0].length;
  const isStereo = channels >= 2;
  const fft = new Fft(FFT_SIZE);

  // Hann-Fenster + Overlap-Add-Normalisierung (Analyse == Synthese-Fenster).
  const win = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / FFT_SIZE));
  }

  // Gepolstertes Signal: FFT_SIZE Nullen vor und nach dem Material, damit
  // Ein-/Ausklang vollständig von Fenstern abgedeckt sind.
  const paddedLength = length + 2 * FFT_SIZE;
  const totalFrames = Math.max(1, Math.floor((paddedLength - FFT_SIZE) / HOP) + 1);

  const mkOut = () => Array.from({ length: channels }, () => new Float32Array(length));
  const vocals = mkOut();
  const drums = mkOut();
  const bassOut = mkOut();
  const other = mkOut();

  // Overlap-Add-Akkumulatoren (float64 gegen Rundungsdrift) + Fenster-Summe.
  const acc = {
    vocals: Array.from({ length: channels }, () => new Float64Array(paddedLength)),
    drums: Array.from({ length: channels }, () => new Float64Array(paddedLength)),
    bass: Array.from({ length: channels }, () => new Float64Array(paddedLength)),
  };
  const winSum = new Float64Array(paddedLength);

  const bins = FFT_SIZE / 2 + 1;
  const binHz = sampleRate / FFT_SIZE;

  // Vorberechnete Frequenzgewichte pro Bin.
  const bwArr = new Float64Array(bins);
  const vbArr = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const f = k * binHz;
    bwArr[k] = bassWeight(f);
    vbArr[k] = vocalBand(f);
  }

  // Wiederverwendbare Frame-Puffer.
  const midRe = new Float64Array(FFT_SIZE);
  const midIm = new Float64Array(FFT_SIZE);
  const sideRe = new Float64Array(FFT_SIZE);
  const sideIm = new Float64Array(FFT_SIZE);

  const readSample = (ch: number, paddedIndex: number): number => {
    const i = paddedIndex - FFT_SIZE;
    return i >= 0 && i < length ? source[ch][i] : 0;
  };

  for (let chunkStart = 0; chunkStart < totalFrames; chunkStart += CHUNK_FRAMES) {
    const chunkEnd = Math.min(totalFrames, chunkStart + CHUNK_FRAMES);
    const extStart = Math.max(0, chunkStart - MARGIN);
    const extEnd = Math.min(totalFrames, chunkEnd + MARGIN);
    const extCount = extEnd - extStart;

    // Pass A: Spektren des erweiterten Chunks berechnen und Magnituden sammeln.
    const specMidRe = new Float32Array(extCount * bins);
    const specMidIm = new Float32Array(extCount * bins);
    const specSideRe = isStereo ? new Float32Array(extCount * bins) : null;
    const specSideIm = isStereo ? new Float32Array(extCount * bins) : null;
    const mag = new Float32Array(extCount * bins);

    for (let m = extStart; m < extEnd; m++) {
      const row = (m - extStart) * bins;
      const frameStart = m * HOP;
      for (let i = 0; i < FFT_SIZE; i++) {
        const l = readSample(0, frameStart + i);
        const r = isStereo ? readSample(1, frameStart + i) : l;
        midRe[i] = 0.5 * (l + r) * win[i];
        midIm[i] = 0;
        if (isStereo) {
          sideRe[i] = 0.5 * (l - r) * win[i];
          sideIm[i] = 0;
        }
      }
      fft.forward(midRe, midIm);
      if (isStereo) fft.forward(sideRe, sideIm);
      for (let k = 0; k < bins; k++) {
        specMidRe[row + k] = midRe[k];
        specMidIm[row + k] = midIm[k];
        const mm = midRe[k] * midRe[k] + midIm[k] * midIm[k];
        let ss = 0;
        if (isStereo) {
          specSideRe![row + k] = sideRe[k];
          specSideIm![row + k] = sideIm[k];
          ss = sideRe[k] * sideRe[k] + sideIm[k] * sideIm[k];
        }
        mag[row + k] = Math.sqrt(mm + ss);
      }
    }

    // Harmonic (Median über Zeit) & Percussive (Median über Frequenz).
    const harm = new Float32Array(extCount * bins);
    const perc = new Float32Array(extCount * bins);
    const timeCol = new Float32Array(extCount);
    const timeMed = new Float32Array(extCount);
    for (let k = 0; k < bins; k++) {
      for (let m = 0; m < extCount; m++) timeCol[m] = mag[m * bins + k];
      medianFilter(timeCol, timeMed, MEDIAN_TIME_FRAMES);
      for (let m = 0; m < extCount; m++) harm[m * bins + k] = timeMed[m];
    }
    const freqRow = new Float32Array(bins);
    const freqMed = new Float32Array(bins);
    for (let m = 0; m < extCount; m++) {
      for (let k = 0; k < bins; k++) freqRow[k] = mag[m * bins + k];
      medianFilter(freqRow, freqMed, MEDIAN_FREQ_BINS);
      for (let k = 0; k < bins; k++) perc[m * bins + k] = freqMed[k];
    }

    // Pass B: Masken anwenden, ISTFT, Overlap-Add — nur für die Kern-Frames.
    const stemMidRe = new Float64Array(FFT_SIZE);
    const stemMidIm = new Float64Array(FFT_SIZE);
    const stemSideRe = new Float64Array(FFT_SIZE);
    const stemSideIm = new Float64Array(FFT_SIZE);

    for (let m = chunkStart; m < chunkEnd; m++) {
      const row = (m - extStart) * bins;
      const frameStart = m * HOP;

      // Fenster-Summe einmalig akkumulieren.
      for (let i = 0; i < FFT_SIZE; i++) {
        winSum[frameStart + i] += win[i] * win[i];
      }

      // Masken pro Bin (Mitte und Seite getrennt; Summe je Raum == 1).
      type StemName = 'vocals' | 'drums' | 'bass';
      const stemNames: StemName[] = ['vocals', 'drums', 'bass'];
      const midMasks = {
        vocals: new Float64Array(bins),
        drums: new Float64Array(bins),
        bass: new Float64Array(bins),
      };
      const sideMasks = {
        vocals: new Float64Array(bins),
        drums: new Float64Array(bins),
        bass: new Float64Array(bins),
      };
      for (let k = 0; k < bins; k++) {
        const h = harm[row + k];
        const p = perc[row + k];
        const hh = h * h;
        const pp = p * p;
        const percShare = pp / (pp + hh + EPS);
        const harmShare = 1 - percShare;
        const bw = bwArr[k];
        const vb = vbArr[k];

        const mr = specMidRe[row + k];
        const mi = specMidIm[row + k];
        const mm = mr * mr + mi * mi;
        let ss = 0;
        if (isStereo) {
          const sr = specSideRe![row + k];
          const si = specSideIm![row + k];
          ss = sr * sr + si * si;
        }
        // Mitten-Dominanz: 1 = strikt mittig (typisch Lead-Vocals).
        const center = mm / (mm + 2 * ss + EPS);

        // Gesangsanteil: harmonischer Mittebereich im Gesangsband; zusätzlich
        // ein Anteil des perkussiven Mitte-Signals oberhalb 2 kHz (Konsonanten
        // und Zischlaute sind breitbandig-perkussiv, gehören aber zur Stimme).
        const sibilant = k * binHz > 2000 ? 0.35 * vb * center : 0;
        midMasks.drums[k] = percShare * (1 - sibilant);
        midMasks.bass[k] = harmShare * bw;
        const rem = harmShare * (1 - bw);
        midMasks.vocals[k] = rem * vb * center + percShare * sibilant;
        // OTHER (Mitte) = rem - vocals — implizit über den Zeitbereichs-Rest.

        sideMasks.drums[k] = percShare;
        sideMasks.bass[k] = harmShare * bw;
        sideMasks.vocals[k] = 0; // Seiten-Anteil gehört zu OTHER (Räumliches/FX)
      }

      for (const stem of stemNames) {
        // Spektrum des Stems zusammensetzen (volles FFT mit Hermitescher Symmetrie).
        for (let k = 0; k < bins; k++) {
          const mMask = midMasks[stem][k];
          stemMidRe[k] = specMidRe[row + k] * mMask;
          stemMidIm[k] = specMidIm[row + k] * mMask;
          if (isStereo) {
            const sMask = sideMasks[stem][k];
            stemSideRe[k] = specSideRe![row + k] * sMask;
            stemSideIm[k] = specSideIm![row + k] * sMask;
          }
        }
        for (let k = bins; k < FFT_SIZE; k++) {
          const mirror = FFT_SIZE - k;
          stemMidRe[k] = stemMidRe[mirror];
          stemMidIm[k] = -stemMidIm[mirror];
          if (isStereo) {
            stemSideRe[k] = stemSideRe[mirror];
            stemSideIm[k] = -stemSideIm[mirror];
          }
        }
        fft.inverse(stemMidRe, stemMidIm);
        if (isStereo) fft.inverse(stemSideRe, stemSideIm);

        const target = stem === 'vocals' ? acc.vocals : stem === 'drums' ? acc.drums : acc.bass;
        for (let i = 0; i < FFT_SIZE; i++) {
          const w = win[i];
          const midVal = stemMidRe[i] * w;
          if (isStereo) {
            const sideVal = stemSideRe[i] * w;
            target[0][frameStart + i] += midVal + sideVal;
            target[1][frameStart + i] += midVal - sideVal;
          } else {
            target[0][frameStart + i] += midVal;
          }
        }
      }
    }

    if (onProgress) onProgress(Math.min(1, chunkEnd / totalFrames));
    // Event-Loop freigeben, damit die UI flüssig bleibt.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Normalisieren (WOLA) und exakten Rest bilden.
  for (let ch = 0; ch < channels; ch++) {
    // Kanäle > 2 (selten): identisch zu Kanal 0 behandelt? Nein — nur die
    // ersten beiden Kanäle wurden getrennt; weitere Kanäle gehen 1:1 in OTHER.
    if (ch >= 2) {
      other[ch].set(source[ch]);
      continue;
    }
    const v = vocals[ch];
    const d = drums[ch];
    const b = bassOut[ch];
    const o = other[ch];
    const src = source[ch];
    const av = acc.vocals[ch];
    const ad = acc.drums[ch];
    const ab = acc.bass[ch];
    for (let i = 0; i < length; i++) {
      const pIdx = i + FFT_SIZE;
      const norm = winSum[pIdx] > EPS ? 1 / winSum[pIdx] : 0;
      const vv = av[pIdx] * norm;
      const dd = ad[pIdx] * norm;
      const bb = ab[pIdx] * norm;
      v[i] = vv;
      d[i] = dd;
      b[i] = bb;
      // OTHER als exakter Rest: Summe rekonstruiert die Quelle sample-genau.
      o[i] = src[i] - vv - dd - bb;
    }
  }

  return { vocals, drums, bass: bassOut, other };
}
