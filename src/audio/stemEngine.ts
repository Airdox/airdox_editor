/**
 * @license
 * Rekordbox Stem Separation Engine
 * State-of-the-Art Multi-Band Source Separation for Vocals, Drums, Bass, and Other/Instruments.
 *
 * Implements transient-preserving frequency decomposition, stereo-centrality isolation,
 * and exact sum-reconstruction: Vocals + Drums + Bass + Other === Original Mix.
 */

import { BufferFactory } from './editingEngine';
import { logger } from '../utils/logger';
import { separateChannelsStft } from './stftSeparator';

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
    if (cached) {
      logger.debug('STEMS', `Stems für Track ${trackId} aus Cache geladen.`);
      return cached;
    }

    this.isProcessing = true;
    const duration = sourceBuffer.duration;
    const startedAt = Date.now();
    logger.info('STEMS', `KI-Stem-Separation gestartet für Track ${trackId}`, {
      trackId,
      duration,
      sampleRate: sourceBuffer.sampleRate,
      channels: sourceBuffer.numberOfChannels,
    });
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
        logger.info('STEMS', `Echte KI-Stems mit ${response.model} fertig (${Date.now() - startedAt} ms)`, {
          trackId,
          model: response.model,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } finally {
        await context.close();
      }
    } catch (modelError) {
      const reason = modelError instanceof Error ? modelError.message : String(modelError);
      logger.warn('STEMS', `Demucs nicht verfügbar, nutze lokale Spektral-Fallback-Separation: ${reason}`, {
        trackId,
        reason,
      });
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
   * Deterministic local spectral fallback (STFT median-filter HPSS + soft
   * masks). Less accurate than Demucs, but measurably better than the former
   * one-pole splitter and free of the normalization blow-up by construction:
   * all masks live in [0,1] per bin, so no stem can exceed the mix spectrum.
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

    const spectralStartedAt = Date.now();
    logger.info('STEMS', `Lokale Spektral-Stemseparierung gestartet für Track ${trackId}`, {
      trackId,
      duration: sourceBuffer.duration,
      sampleRate: sourceBuffer.sampleRate,
    });
    this.isProcessing = true;
    try {
      const sampleRate = sourceBuffer.sampleRate;
      const channels = sourceBuffer.numberOfChannels;
      const length = sourceBuffer.length;
      const duration = sourceBuffer.duration;

      const sourceData: Float32Array[] = [];
      for (let ch = 0; ch < channels; ch++) {
        // Copy: the separator must stay strictly read-only on the source.
        sourceData.push(sourceBuffer.getChannelData(ch).slice());
      }

      // Absolute peak of the source material, kept as diagnostic ceiling.
      let sourcePeak = 0;
      for (let ch = 0; ch < channels; ch++) {
        const data = sourceData[ch];
        for (let i = 0; i < length; i++) {
          const a = Math.abs(data[i]);
          if (a > sourcePeak) sourcePeak = a;
        }
      }
      const peakCeiling = sourcePeak > 0 ? sourcePeak : STEM_PEAK_CEILING;

      const separated = await separateChannelsStft(sourceData, sampleRate, (fraction) => {
        const percent = Math.min(99, Math.max(1, Math.round(fraction * 100)));
        onProgress?.({
          percent,
          phaseText: `STFT Spektral-Separation (${percent}%)...`,
          processedSeconds: Math.min(duration, fraction * duration),
          totalSeconds: duration,
        });
      });

      const vocalsBuffer = createStemBuffer(channels, length, sampleRate, factory);
      const drumsBuffer = createStemBuffer(channels, length, sampleRate, factory);
      const bassBuffer = createStemBuffer(channels, length, sampleRate, factory);
      const otherBuffer = createStemBuffer(channels, length, sampleRate, factory);
      for (let ch = 0; ch < channels; ch++) {
        vocalsBuffer.getChannelData(ch).set(separated.vocals[ch]);
        drumsBuffer.getChannelData(ch).set(separated.drums[ch]);
        bassBuffer.getChannelData(ch).set(separated.bass[ch]);
        otherBuffer.getChannelData(ch).set(separated.other[ch]);
      }

      // The mask construction cannot blow up, so no per-sample energy-split
      // rescue is required anymore. Kept at 0 for diagnostic compatibility.
      const normalizationFallbacks = 0;

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

      logger.info('STEMS', `Lokale Stems fertig (${Date.now() - spectralStartedAt} ms, Normalisierungs-Fallbacks: ${normalizationFallbacks})`, {
        trackId,
        durationMs: Date.now() - spectralStartedAt,
        normalizationFallbacks,
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
