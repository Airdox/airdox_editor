/**
 * @license
 * Rekordbox Stem Separation Engine
 * State-of-the-Art Multi-Band Source Separation for Vocals, Drums, Bass, and Other/Instruments.
 *
 * Implements transient-preserving frequency decomposition, stereo-centrality isolation,
 * and exact sum-reconstruction: Vocals + Drums + Bass + Other === Original Mix.
 */

import { BufferFactory } from './editingEngine';

export type StemType = 'vocals' | 'drums' | 'bass' | 'other';

export const STEM_TYPES: StemType[] = ['vocals', 'drums', 'bass', 'other'];

/**
 * Guard rails for the sum-preserving normalization.
 *
 * `sample / rawSum` is mathematically exact but numerically unbounded: whenever the
 * four masks nearly cancel each other (rawSum -> 0 while sample stays finite) the
 * factor explodes and every individual stem is blown far past the source amplitude.
 * The four stems still add back up to the mix — which is why the full mix (Reset)
 * sounds mostly fine — but as soon as one stem is soloed or another muted, the
 * cancellation partner is gone and the overshoot becomes audible digital clipping.
 *
 * Therefore the factor is only trusted inside a sane window; outside of it the
 * sample is distributed by mask *energy*, which is bounded by construction.
 */
export const NORM_FACTOR_MIN = 0.25;
export const NORM_FACTOR_MAX = 4.0;

/**
 * No single stem may ever exceed the peak of the source material. Stems are
 * allowed to be louder than the *instantaneous* mix sample (that is physically
 * normal — partials cancel in the sum), but never louder than the loudest point
 * of the track itself.
 */
export const STEM_PEAK_CEILING = 1.0;

export interface TrackStems {
  trackId: string;
  originalSha256: string;
  duration: number;
  sampleRate: number;
  channels: number;
  vocals: AudioBuffer;
  drums: AudioBuffer;
  bass: AudioBuffer;
  other: AudioBuffer;
  separatedAt: number;
  /** Number of samples where `normFactor` left its trusted window and the
   *  energy-weighted split was used instead. Purely diagnostic. */
  normalizationFallbacks?: number;
  /** Absolute peak of the source material used as per-stem ceiling. */
  sourcePeak?: number;
  /** Actual engine used, surfaced so tests/UI never confuse fallback DSP with Demucs. */
  separationMethod?: 'DEMUCS_HTDEMUCS_FT' | 'LOCAL_SPECTRAL_FALLBACK';
  /** Why Demucs was unavailable when the local fallback produced this result. */
  fallbackReason?: string;
}

/**
 * Availability of the real AI separation engine (Demucs htdemucs_ft).
 * `available: false` means any separation will use the local spectral
 * fallback, whose quality is NOT sufficient for club/performance use.
 */
export interface StemEngineAvailability {
  available: boolean;
  engine: 'DEMUCS_HTDEMUCS_FT' | 'LOCAL_SPECTRAL_FALLBACK';
  model?: string;
  reason?: string;
}

export interface StemChannelState {
  muted: boolean;
  solo: boolean;
  volume: number; // 0.0 - 1.5 (default 1.0)
}

export interface StemsMixerState {
  vocals: StemChannelState;
  drums: StemChannelState;
  bass: StemChannelState;
  other: StemChannelState;
}

export const DEFAULT_STEMS_MIXER_STATE: StemsMixerState = {
  vocals: { muted: false, solo: false, volume: 1.0 },
  drums: { muted: false, solo: false, volume: 1.0 },
  bass: { muted: false, solo: false, volume: 1.0 },
  other: { muted: false, solo: false, volume: 1.0 },
};

export interface StemSeparationProgress {
  percent: number;
  phaseText: string;
  processedSeconds: number;
  totalSeconds: number;
}

export type StemProgressCallback = (progress: StemSeparationProgress) => void;

interface DemucsResponse {
  engine: 'demucs';
  model: string;
  stems: Record<StemType, string | Uint8Array>;
}

function encodeStereoFloatWav(buffer: AudioBuffer): Uint8Array {
  const channels = 2;
  const bytesPerSample = 4;
  const dataSize = buffer.length * channels * bytesPerSample;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); write(8, 'WAVE');
  // IEEE float WAV keeps the decoded source at full Web Audio precision. The
  // former 16-bit transport introduced avoidable quantization before inference.
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 32, true);
  write(36, 'data'); view.setUint32(40, dataSize, true);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (const sample of [left[i], right[i]]) {
      view.setFloat32(offset, Number.isFinite(sample) ? sample : 0, true);
      offset += bytesPerSample;
    }
  }
  return bytes;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Environment-independent AudioBuffer allocation. The Node test harness has no
 * Web Audio API, so a plain Float32-backed double is used there.
 */
function createStemBuffer(
  numChannels: number,
  length: number,
  sampleRate: number,
  factory?: BufferFactory
): AudioBuffer {
  if (factory) return factory(numChannels, length, sampleRate);

  const AudioCtx =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;

  if (AudioCtx) {
    const ctx = new AudioCtx();
    const buf = ctx.createBuffer(numChannels, length, sampleRate);
    ctx.close();
    return buf;
  }

  const channelsData = Array.from({ length: numChannels }, () => new Float32Array(length));
  return {
    sampleRate,
    length,
    duration: length / sampleRate,
    numberOfChannels: numChannels,
    getChannelData: (c: number) => channelsData[c] || channelsData[0],
    copyFromChannel: (dest: Float32Array, c: number, offset = 0) => {
      dest.set((channelsData[c] || channelsData[0]).subarray(offset, offset + dest.length));
    },
    copyToChannel: (src: Float32Array, c: number, offset = 0) => {
      (channelsData[c] || channelsData[0]).set(src, offset);
    },
  } as unknown as AudioBuffer;
}

class StemEngine {
  private stemsCache: Map<string, TrackStems> = new Map();
  private isProcessing: boolean = false;

  /**
   * Retrieves cached stems for a track by its unique checksum or track ID.
   */
  public getCachedStems(trackId: string, originalSha256?: string): TrackStems | undefined {
    const key = originalSha256 || trackId;
    return this.stemsCache.get(key) || this.stemsCache.get(trackId);
  }

  /**
   * Checks whether stems are already cached for a track.
   */
  public hasCachedStems(trackId: string, originalSha256?: string): boolean {
    const key = originalSha256 || trackId;
    return this.stemsCache.has(key) || this.stemsCache.has(trackId);
  }

  /**
   * Stores separated stems in the memory cache.
   */
  public cacheStems(trackId: string, stems: TrackStems, originalSha256?: string): void {
    const key = originalSha256 || trackId;
    this.stemsCache.set(key, stems);
    this.stemsCache.set(trackId, stems);
  }

  /**
   * Clears the stems cache.
   */
  public clearCache(): void {
    this.stemsCache.clear();
  }

  public getIsProcessing(): boolean {
    return this.isProcessing;
  }

  /**
   * Checks BEFORE any separation whether the real AI engine (Demucs
   * htdemucs_ft) is usable. The UI must call this to warn the user honestly
   * that only the low-quality local fallback is available — instead of
   * running the fallback silently and reporting "success".
   */
  public async checkAvailability(): Promise<StemEngineAvailability> {
    try {
      const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop : undefined;
      if (desktop?.getStemEngineStatus) {
        const status = await desktop.getStemEngineStatus();
        if (status.available) {
          return { available: true, engine: 'DEMUCS_HTDEMUCS_FT', model: 'htdemucs_ft' };
        }
        return {
          available: false,
          engine: 'LOCAL_SPECTRAL_FALLBACK',
          reason: status.reason || 'Demucs/Python ist nicht einsatzbereit.',
        };
      }
      // Browser/dev server path: probe the local API without sending audio.
      const response = await fetch('/api/stems/status');
      if (response.ok) {
        const payload = await response.json();
        if (payload.available) {
          return { available: true, engine: 'DEMUCS_HTDEMUCS_FT', model: payload.model || 'htdemucs_ft' };
        }
        return {
          available: false,
          engine: 'LOCAL_SPECTRAL_FALLBACK',
          reason: payload.reason || 'Demucs ist auf dem lokalen Server nicht installiert.',
        };
      }
      return {
        available: false,
        engine: 'LOCAL_SPECTRAL_FALLBACK',
        reason: `Stem-Service antwortet mit HTTP ${response.status}.`,
      };
    } catch (error) {
      return {
        available: false,
        engine: 'LOCAL_SPECTRAL_FALLBACK',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Production-quality separation using the trained Demucs htdemucs_ft model.
   * Only a single finished song mix is sent to inference. This method fails
   * explicitly when the model is unavailable; it never disguises the old
   * frequency splitter as AI separation.
   */
  public async separateAudioBufferWithModel(
    sourceBuffer: AudioBuffer,
    trackId: string,
    originalSha256: string = 'sha256-unverified',
    onProgress?: StemProgressCallback,
    options?: {
      /**
       * When false, a missing Demucs installation aborts with an error instead
       * of silently degrading to the low-quality local spectral fallback.
       */
      allowFallback?: boolean;
    }
  ): Promise<TrackStems> {
    const cached = this.getCachedStems(trackId, originalSha256);
    if (cached) return cached;

    this.isProcessing = true;
    const duration = sourceBuffer.duration;
    try {
      onProgress?.({ percent: 1, phaseText: 'Stem-Engine und Python-Installation prüfen…', processedSeconds: 0, totalSeconds: duration });
      const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop : undefined;
      if (desktop?.getStemEngineStatus) {
        const status = await desktop.getStemEngineStatus();
        if (!status.available) throw new Error(status.reason || 'Demucs/Python ist nicht einsatzbereit.');
      }

      onProgress?.({ percent: 2, phaseText: 'Songmix für Demucs vorbereiten…', processedSeconds: 0, totalSeconds: duration });
      const wav = encodeStereoFloatWav(sourceBuffer);
      let response: DemucsResponse;

      if (desktop?.separateStems) {
        response = await desktop.separateStems(wav);
      } else {
        onProgress?.({ percent: 5, phaseText: 'Demucs htdemucs_ft Max-Qualität (4 Modelle × 10 Shifts) analysiert den Mix…', processedSeconds: 0, totalSeconds: duration });
        const request = await fetch('/api/stems/separate', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: wav,
        });
        const payload = await request.json();
        if (!request.ok) throw new Error(payload.error || `Stem-Service antwortet mit HTTP ${request.status}`);
        response = payload as DemucsResponse;
      }

      if (response.engine !== 'demucs') throw new Error('Ungültige Antwort des Demucs Stem-Service.');
      onProgress?.({ percent: 94, phaseText: `${response.model}: vier WAV-Stems dekodieren…`, processedSeconds: duration, totalSeconds: duration });

      const AudioCtx = window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) throw new Error('Web Audio API ist für das Dekodieren der Demucs-Ausgabe erforderlich.');
      const context = new AudioCtx();
      try {
        const decoded = {} as Record<StemType, AudioBuffer>;
        for (const stem of STEM_TYPES) {
          const encoded = response.stems[stem];
          if (!encoded) throw new Error(`Demucs hat keinen ${stem}-Stem geliefert.`);
          const bytes = typeof encoded === 'string' ? decodeBase64(encoded) : new Uint8Array(encoded);
          const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          decoded[stem] = await context.decodeAudioData(exact);
        }
        const result: TrackStems = {
          trackId,
          originalSha256,
          duration: decoded.vocals.duration,
          sampleRate: decoded.vocals.sampleRate,
          channels: decoded.vocals.numberOfChannels,
          vocals: decoded.vocals,
          drums: decoded.drums,
          bass: decoded.bass,
          other: decoded.other,
          separatedAt: Date.now(),
          separationMethod: 'DEMUCS_HTDEMUCS_FT',
        };
        this.cacheStems(trackId, result, originalSha256);
        onProgress?.({ percent: 100, phaseText: `Echte KI-Stems mit ${response.model} fertig`, processedSeconds: duration, totalSeconds: duration });
        return result;
      } finally {
        await context.close();
      }
    } catch (modelError) {
      const reason = modelError instanceof Error ? modelError.message : String(modelError);
      // Default is now to FAIL honestly: a missing Demucs installation is an
      // actionable setup problem, not something to paper over with a
      // frequency splitter whose output is unusable for real DJ sets.
      if (options?.allowFallback !== true) {
        throw new Error(
          `Demucs (htdemucs_ft) ist nicht verfügbar: ${reason}. ` +
            'Die Stems wurden NICHT erzeugt, weil der lokale Spektral-Fallback ' +
            'keine performancetaugliche Qualität liefert. Installiere die ' +
            'KI-Engine mit "npm run stems:setup" (Windows: "npm run stems:setup:win") ' +
            'oder starte die Trennung ausdrücklich im Fallback-Modus.'
        );
      }
      // Explicitly requested fallback: run the bounded local separator and tag
      // the result so it can never be mistaken for AI separation.
      console.warn('[Stems] Demucs unavailable, using local spectral fallback:', reason);
      onProgress?.({
        percent: 8,
        phaseText: 'Demucs nicht verfügbar – lokale Spektral-Separation läuft…',
        processedSeconds: 0,
        totalSeconds: duration,
      });
      const fallback = await this.separateAudioBuffer(
        sourceBuffer,
        trackId,
        originalSha256,
        onProgress
      );
      fallback.fallbackReason = reason;
      return fallback;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Deterministic local spectral fallback. It is less accurate than Demucs but
   * always produces four playable, sum-preserving stems without external tools.
   */
  public async separateAudioBuffer(
    sourceBuffer: AudioBuffer,
    trackId: string,
    originalSha256: string = 'sha256-unverified',
    onProgress?: StemProgressCallback,
    factory?: BufferFactory
  ): Promise<TrackStems> {
    const cached = this.getCachedStems(trackId, originalSha256);
    if (cached) {
      onProgress?.({
        percent: 100,
        phaseText: 'Stems aus Cache geladen',
        processedSeconds: cached.duration,
        totalSeconds: cached.duration,
      });
      return cached;
    }

    this.isProcessing = true;
    try {
      const sampleRate = sourceBuffer.sampleRate;
      const channels = sourceBuffer.numberOfChannels;
      const length = sourceBuffer.length;
      const duration = sourceBuffer.duration;

      const vocalsBuffer = createStemBuffer(channels, length, sampleRate, factory);
      const drumsBuffer = createStemBuffer(channels, length, sampleRate, factory);
      const bassBuffer = createStemBuffer(channels, length, sampleRate, factory);
      const otherBuffer = createStemBuffer(channels, length, sampleRate, factory);

      const vocalsData: Float32Array[] = [];
      const drumsData: Float32Array[] = [];
      const bassData: Float32Array[] = [];
      const otherData: Float32Array[] = [];
      const sourceData: Float32Array[] = [];

      for (let ch = 0; ch < channels; ch++) {
        vocalsData.push(vocalsBuffer.getChannelData(ch));
        drumsData.push(drumsBuffer.getChannelData(ch));
        bassData.push(bassBuffer.getChannelData(ch));
        otherData.push(otherBuffer.getChannelData(ch));
        sourceData.push(sourceBuffer.getChannelData(ch));
      }

      // Absolute peak of the source material. No stem is allowed to exceed it,
      // because a stem that is louder than the loudest point of the track can
      // only be an artefact of the normalization, never real content.
      let sourcePeak = 0;
      for (let ch = 0; ch < channels; ch++) {
        const data = sourceData[ch];
        for (let i = 0; i < length; i++) {
          const a = Math.abs(data[i]);
          if (a > sourcePeak) sourcePeak = a;
        }
      }
      const peakCeiling = sourcePeak > 0 ? sourcePeak : STEM_PEAK_CEILING;

      // Processing parameters
      const chunkSize = 16384; // ~370ms per chunk at 44.1kHz
      const totalChunks = Math.max(1, Math.ceil(length / chunkSize));

      // Multi-band filter corner frequencies
      // Bass: 0 - ~240 Hz (sub & low fundamental)
      // Vocals: ~260 - 4200 Hz band-pass, weighted by stereo centrality
      // Drums: transients + air above ~4800 Hz
      // Other: harmonic residual and stereo side content
      const bassCutoff = 240; // Hz
      const vocalLow = 260; // Hz
      const vocalHigh = 4200; // Hz
      const drumAir = 4800; // Hz

      const bAlpha = Math.exp((-2.0 * Math.PI * bassCutoff) / sampleRate);
      const vLowAlpha = Math.exp((-2.0 * Math.PI * vocalLow) / sampleRate);
      const vHighAlpha = Math.exp((-2.0 * Math.PI * vocalHigh) / sampleRate);
      const dHighAlpha = Math.exp((-2.0 * Math.PI * drumAir) / sampleRate);

      // Filter states for continuous filtering across chunks
      const bassLp = new Float32Array(channels);
      const vocalLpLow = new Float32Array(channels);
      const vocalLpHigh = new Float32Array(channels);
      const drumLpHigh = new Float32Array(channels);
      const transientEnv = new Float32Array(channels);

      const isStereo = channels >= 2;

      // Diagnostics: how many samples had to fall back to the energy split.
      let normalizationFallbacks = 0;

      for (let c = 0; c < totalChunks; c++) {
        const start = c * chunkSize;
        const end = Math.min(length, start + chunkSize);

        for (let i = start; i < end; i++) {
          const leftSamp = sourceData[0][i];
          const rightSamp = isStereo ? sourceData[1][i] : leftSamp;

          // Stereo Mid / Side calculations for Vocal Centrality.
          // Lead vocals in standard mix engineering sit strictly center.
          const mid = 0.5 * (leftSamp + rightSamp);
          const side = 0.5 * (leftSamp - rightSamp);
          const centerWeight = Math.max(
            0,
            1.0 - Math.min(1.0, Math.abs(side) / (Math.abs(mid) + 1e-4))
          );

          for (let ch = 0; ch < channels; ch++) {
            const sample = sourceData[ch][i];

            // 1. Bass Extraction (sub & low fundamental low-pass)
            bassLp[ch] = bAlpha * bassLp[ch] + (1 - bAlpha) * sample;
            const rawBass = bassLp[ch];

            // 2. Vocal Band-Pass Filter (260Hz - 4200Hz). Both low-passes
            // must operate on the source; LP(4200) - LP(260) is the band.
            // The previous cascaded/reversed subtraction nearly cancelled the
            // complete vocal range and made Vocal Solo effectively silent.
            vocalLpLow[ch] = vLowAlpha * vocalLpLow[ch] + (1 - vLowAlpha) * sample;
            vocalLpHigh[ch] = vHighAlpha * vocalLpHigh[ch] + (1 - vHighAlpha) * sample;
            const midBand = vocalLpHigh[ch] - vocalLpLow[ch];

            // 3. Drum High Band (air / cymbals above ~4800Hz)
            drumLpHigh[ch] = dHighAlpha * drumLpHigh[ch] + (1 - dHighAlpha) * sample;
            const highAir = sample - drumLpHigh[ch];

            // 4. Transient / percussive envelope detection
            const absSamp = Math.abs(sample);
            const diff = Math.max(0, absSamp - transientEnv[ch]);
            transientEnv[ch] = 0.92 * transientEnv[ch] + 0.08 * absSamp;
            const isTransient = Math.min(1.0, diff * 6.0);

            // Spectral / spatial source separation masks
            const bassRatio = Math.min(1.0, Math.abs(rawBass) / (absSamp + 1e-5));
            const bassVal = rawBass * 0.92 + sample * 0.08 * bassRatio;

            // Drum stem: sharp transients + high air + punch
            const drumVal = highAir * 0.75 + isTransient * (sample - rawBass) * 0.65;

            // Vocal stem: center-panned mid-range harmonic presence
            const vocalCoeff = centerWeight * (1.0 - isTransient * 0.65);
            const vocalVal = midBand * vocalCoeff * 0.95;

            // Other / instruments: residual harmonic material
            const allocatedSum = bassVal + drumVal + vocalVal;
            const residualVal = sample - allocatedSum;
            const otherVal = residualVal + side * 0.7;

            // Exact sum-preserving normalization so that
            // vocals + drums + bass + other === sample (sample-exact).
            const rawSum = vocalVal + drumVal + bassVal + otherVal;
            if (rawSum === 0 || !Number.isFinite(rawSum)) {
              // Degenerate allocation: distribute the sample evenly so the sum
              // contract still holds exactly.
              const quarter = sample / 4;
              vocalsData[ch][i] = quarter;
              drumsData[ch][i] = quarter;
              bassData[ch][i] = quarter;
              otherData[ch][i] = sample - 3 * quarter;
              continue;
            }

            const normFactor = sample / rawSum;

            let v: number;
            let d: number;
            let b: number;
            let useEnergySplit =
              !Number.isFinite(normFactor) ||
              Math.abs(normFactor) < NORM_FACTOR_MIN ||
              Math.abs(normFactor) > NORM_FACTOR_MAX ||
              normFactor < 0;

            if (!useEnergySplit) {
              v = vocalVal * normFactor;
              d = drumVal * normFactor;
              b = bassVal * normFactor;

              // Even inside the trusted window a single mask can overshoot the
              // material. Clamp, and if the residual stem would then have to
              // absorb more than the source peak, reject the factor entirely.
              if (v > peakCeiling) v = peakCeiling;
              else if (v < -peakCeiling) v = -peakCeiling;
              if (d > peakCeiling) d = peakCeiling;
              else if (d < -peakCeiling) d = -peakCeiling;
              if (b > peakCeiling) b = peakCeiling;
              else if (b < -peakCeiling) b = -peakCeiling;

              if (Math.abs(sample - v - d - b) > peakCeiling) {
                useEnergySplit = true;
              }
            }

            if (useEnergySplit) {
              // Energy-weighted allocation: each stem receives the share of the
              // sample that matches its mask energy. Every stem is bounded by
              // |sample| by construction, so this can never clip — while the
              // four shares still add up to exactly the source sample.
              const ev = vocalVal * vocalVal;
              const ed = drumVal * drumVal;
              const eb = bassVal * bassVal;
              const eo = otherVal * otherVal;
              const energySum = ev + ed + eb + eo;

              if (energySum > 0 && Number.isFinite(energySum)) {
                v = (sample * ev) / energySum;
                d = (sample * ed) / energySum;
                b = (sample * eb) / energySum;
              } else {
                const quarter = sample / 4;
                v = quarter;
                d = quarter;
                b = quarter;
              }
              normalizationFallbacks++;
            }

            vocalsData[ch][i] = v;
            drumsData[ch][i] = d;
            bassData[ch][i] = b;
            // The residual stem absorbs floating point error so the four stems
            // always reconstruct the source sample exactly.
            otherData[ch][i] = sample - v - d - b;
          }
        }

        // Yield event loop every few chunks for smooth UI updates
        if (c % 8 === 0 || c === totalChunks - 1) {
          const percent = Math.min(100, Math.round(((c + 1) / totalChunks) * 100));
          const processedSec = ((c + 1) * chunkSize) / sampleRate;
          onProgress?.({
            percent,
            phaseText: `Multi-Band Stem-Separation (${percent}%)...`,
            processedSeconds: Math.min(duration, processedSec),
            totalSeconds: duration,
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      const result: TrackStems = {
        trackId,
        originalSha256,
        duration,
        sampleRate,
        channels,
        vocals: vocalsBuffer,
        drums: drumsBuffer,
        bass: bassBuffer,
        other: otherBuffer,
        separatedAt: Date.now(),
        normalizationFallbacks,
        sourcePeak: peakCeiling,
        separationMethod: 'LOCAL_SPECTRAL_FALLBACK',
      };

      this.cacheStems(trackId, result, originalSha256);

      onProgress?.({
        percent: 100,
        phaseText: 'Stems erfolgreich getrennt',
        processedSeconds: duration,
        totalSeconds: duration,
      });

      return result;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Slices a sub-region across all 4 stems for creating palette clips.
   */
  public sliceStems(
    stems: TrackStems,
    startSec: number,
    endSec: number,
    factory?: BufferFactory
  ): {
    vocals: AudioBuffer;
    drums: AudioBuffer;
    bass: AudioBuffer;
    other: AudioBuffer;
    duration: number;
  } {
    const sampleRate = stems.sampleRate;
    const channels = stems.channels;
    const totalSamples = Math.round(stems.duration * sampleRate);
    const startSample = Math.max(0, Math.min(totalSamples, Math.round(startSec * sampleRate)));
    const endSample = Math.max(startSample, Math.min(totalSamples, Math.round(endSec * sampleRate)));
    const length = Math.max(1, endSample - startSample);
    const duration = length / sampleRate;

    const sliceSingle = (srcBuffer: AudioBuffer): AudioBuffer => {
      const dest = createStemBuffer(channels, length, sampleRate, factory);
      for (let ch = 0; ch < channels; ch++) {
        const src = srcBuffer.getChannelData(ch);
        const dst = dest.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          dst[i] = src[startSample + i] || 0;
        }
      }
      return dest;
    };

    return {
      vocals: sliceSingle(stems.vocals),
      drums: sliceSingle(stems.drums),
      bass: sliceSingle(stems.bass),
      other: sliceSingle(stems.other),
      duration,
    };
  }
}

export const stemEngine = new StemEngine();
