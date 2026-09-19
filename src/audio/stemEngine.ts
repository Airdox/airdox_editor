/**
 * StemSeparationEngine – REFACTORED per §2, §8, §26, §38
 *
 * PRODUKTREGEL:
 * - Echte modellbasierte AI/ML Separation ist Pflicht (BS-RoFormer primär)
 * - KEIN EQ, Low-Pass, High-Pass, Bandpass, Mid/Side, Center Cancellation,
 *   Frequenzmaskierung als alleinige Methode, einfache Spektral-Separation
 *   oder sonstige reine DSP-Filterlösungen als eigentliche Stem-Separation.
 * - DSP nur als optionale Nachbearbeitung.
 * - Spektral-Fallback darf NICHT als "Stem Separation" angeboten werden.
 *
 * WICHTIGSTE ÄNDERUNG (§2):
 * AI Engine nicht verfügbar -> STEM_ENGINE_UNAVAILABLE -> klarer UI-Status
 * -> kein künstlich erzeugter "Vocal Stem".
 *
 * Demucs darf nicht mehr zentrale Voraussetzung sein (§26).
 */

import { BufferFactory } from './editingEngine';
import { logger } from '../utils/logger';
import type { StemComputeDevice, StemJobView, StemServiceStatus, StemValidationMode } from '../stems/transportTypes';
// Fernpfad (High Quality extern): eigene Importzeile, damit der bestehende
// Vertragstest („Renderer importiert den Vertrag typ-only“) unverändert gilt.
import type { RemoteServiceStatus, RemoteSettings, RemoteStemJobView } from '../stems/transportTypes';
import type { ModelFamily } from '../stems/types';
import { describeArchitectures, type StemArchitectureOption } from './stemArchitectures';

export type { ModelFamily } from '../stems/types';
export type { RemoteServiceStatus, RemoteSettings, RemoteStemJobView } from '../stems/transportTypes';

export type StemType = 'vocals' | 'drums' | 'bass' | 'other';
export const STEM_TYPES: StemType[] = ['vocals', 'drums', 'bass', 'other'];

export const NORM_FACTOR_MIN = 0.25;
export const NORM_FACTOR_MAX = 4.0;
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
  normalizationFallbacks?: number;
  sourcePeak?: number;
  /** Engine that produced these stems – must be real AI, never spectral */
  separationMethod: 'BS_ROFORMER' | 'MEL_BAND_ROFORMER' | 'DEMUCS_HTDEMUCS_FT' | 'STEM_ENGINE_MODEL';
  /** Model id from catalog */
  modelId?: string;
  /** Quality profile */
  profile?: StemQualityProfile;
  /** Engine job id */
  jobId?: string;
  /** Validation */
  validationPass?: boolean;
  recombinationErrorDb?: number;
  trainedModel?: boolean;
  stemIds?: string[];
  stemsById?: Record<string, AudioBuffer>;
  // Legacy fields kept for compatibility but no longer set to fallback
  fallbackReason?: never;
}

export type StemQualityProfile = 'PREVIEW' | 'BALANCED' | 'HIGH' | 'HIGH_QUALITY' | 'MAXIMUM_QUALITY';
export const STEM_QUALITY_PROFILES: StemQualityProfile[] = ['PREVIEW', 'BALANCED', 'HIGH', 'HIGH_QUALITY', 'MAXIMUM_QUALITY'];

/** Selectable architectures, mirrored here so the settings menu has labels even offline. */
export const SELECTABLE_MODEL_FAMILIES: ModelFamily[] = ['bs_roformer', 'mel_band_roformer', 'htdemucs'];

const FAMILY_LABEL: Record<ModelFamily, string> = {
  bs_roformer: 'BS-RoFormer',
  mel_band_roformer: 'Mel-Band-RoFormer',
  htdemucs: 'HTDemucs',
  pipeline_double: 'Pipeline-Double (Test)',
};

const FAMILY_DESCRIPTION: Record<ModelFamily, string> = {
  bs_roformer: 'Primäre Engine – beste Trennqualität für Vocals/Drums/Bass/Other.',
  mel_band_roformer: 'Alternative RoFormer-Architektur für A/B-Vergleiche, v. a. Vocals/Other.',
  htdemucs: 'Legacy-Engine, schneller aber weniger präzise als BS-RoFormer.',
  pipeline_double: 'Test-Double – kein trainiertes Modell.',
};

/** Used whenever the engine cannot be reached at all: every family is "unavailable" with the same reason. */
function fallbackFamilies(reason?: string): StemEngineFamilyInfo[] {
  return SELECTABLE_MODEL_FAMILIES.map((family) => ({
    family,
    label: FAMILY_LABEL[family],
    description: FAMILY_DESCRIPTION[family],
    available: false,
    reason,
    serves: [],
    modelIds: [],
  }));
}

export interface StemEngineProfileInfo {
  profile: StemQualityProfile;
  modelId: string;
  family?: ModelFamily;
  stems: { id: string; displayName: string }[];
  available: boolean;
  reason?: string;
  description: string;
}

/** One selectable stem-separation architecture, as shown in the settings menu. */
export interface StemEngineFamilyInfo {
  family: ModelFamily;
  label: string;
  description: string;
  available: boolean;
  reason?: string;
  serves: StemQualityProfile[];
  modelIds: string[];
}

export interface StemEngineInfo {
  ok: boolean;
  usable: boolean;
  profiles: StemEngineProfileInfo[];
  /** Selectable architectures (model families) for the settings menu. */
  families: StemEngineFamilyInfo[];
  defaultProfile: StemQualityProfile;
  transport: 'desktop-ipc' | 'http' | 'none';
  reason?: string;
  code?: string;
  /** New: diagnostics */
  diagnostics?: {
    pythonVersion?: string;
    pythonPath?: string;
    torchVersion?: string;
    cudaAvailable?: boolean;
    modelStatus?: string;
    engineStatus?: string;
  };
}

export interface EngineSeparationOptions {
  profile?: StemQualityProfile;
  /** Fest gewählte Architektur (Modell-ID). Ohne Angabe entscheidet das Profil. */
  modelId?: string;
  /** Explicit architecture (model family) to use; ignored when `modelId` is set. */
  family?: ModelFamily;
  /** Rechengerät der in-process-Engine (ONNX): auto/cpu/directml/cuda/coreml. */
  device?: StemComputeDevice;
  /** Validierungstiefe: live (fast_dj) oder Studio (volle Grenzanalyse). */
  mode?: StemValidationMode;
  onProgress?: StemProgressCallback;
  signal?: { aborted: boolean };
  chunkSizeSamples?: number;
}

export interface StemEngineAvailability {
  available: boolean;
  engine: 'BS_ROFORMER' | 'DEMUCS_HTDEMUCS_FT';
  model?: string;
  reason?: string;
  code?: string;
}

export interface StemChannelState {
  muted: boolean;
  solo: boolean;
  volume: number;
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

/** New error codes per §4, §30 */
export type StemEngineErrorCode =
  | 'STEM_ENGINE_UNAVAILABLE'
  | 'CHECKPOINT_MISSING'
  | 'CONFIG_MISSING'
  | 'MODEL_HASH_MISMATCH'
  | 'PYTHON_MISSING'
  | 'PYTHON_VERSION_UNSUPPORTED'
  | 'TORCH_MISSING'
  | 'MODEL_NOT_AVAILABLE';

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
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 32, true);
  write(36, 'data'); view.setUint32(40, dataSize, true);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  let offset = 44;
  // Explizit L/R: die frühere Schreibweise legte pro Frame ein kleines
  // `[left, right]`-Array an (17 Mio Arrays pro 6-Minuten-Track) – reiner
  // GC-Druck ohne Nutzen.
  for (let i = 0; i < buffer.length; i++) {
    const l = left[i];
    const r = right[i];
    view.setFloat32(offset, Number.isFinite(l) ? l : 0, true);
    view.setFloat32(offset + bytesPerSample, Number.isFinite(r) ? r : 0, true);
    offset += bytesPerSample * 2;
  }
  return bytes;
}

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
  private activeJobId?: string;

  public getCachedStems(trackId: string, originalSha256?: string): TrackStems | undefined {
    const key = originalSha256 || trackId;
    return this.stemsCache.get(key) || this.stemsCache.get(trackId);
  }

  public hasCachedStems(trackId: string, originalSha256?: string): boolean {
    const key = originalSha256 || trackId;
    return this.stemsCache.has(key) || this.stemsCache.has(trackId);
  }

  public cacheStems(trackId: string, stems: TrackStems, originalSha256?: string): void {
    const key = originalSha256 || trackId;
    this.stemsCache.set(key, stems);
    this.stemsCache.set(trackId, stems);
  }

  public clearCache(): void {
    this.stemsCache.clear();
  }

  public getIsProcessing(): boolean {
    return this.isProcessing;
  }

  /**
   * Checks BEFORE any separation whether the real AI engine (BS-RoFormer) is usable.
   * §14 Preflight – must not say "Demucs not available" when BS-RoFormer is desired.
   * Returns STEM_ENGINE_UNAVAILABLE if not ready, never falls back to spectral.
   */
  public async checkAvailability(): Promise<StemEngineAvailability> {
    try {
      const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop : undefined;
      // New engine path first
      if (desktop?.stemEngine?.getStemEngineStatus) {
        const result = await desktop.stemEngine.getStemEngineStatus();
        if (result.ok === true) {
          const data = result.data;
          if (data.usable) {
            const chosen = data.profiles.find((p) => p.profile === data.defaultProfile && p.available)
              ?? data.profiles.find((p) => p.available);
            const engine = chosen?.family === 'htdemucs' ? 'DEMUCS_HTDEMUCS_FT' : 'BS_ROFORMER';
            return { available: true, engine, model: chosen?.modelId ?? 'htdemucs-onnx-4stem-fp16' };
          }
          return {
            available: false,
            engine: 'BS_ROFORMER',
            reason: data.profiles.map((p) => `${p.profile}: ${p.reason}`).join(' | ') || 'BS-RoFormer Engine nicht verfügbar',
            code: 'STEM_ENGINE_UNAVAILABLE',
          };
        }
        return {
          available: false,
          engine: 'BS_ROFORMER',
          reason: result.message || 'Stem Engine nicht verfügbar',
          code: result.code ?? 'STEM_ENGINE_UNAVAILABLE',
        };
      }

      // Browser/dev path: probe new engine via HTTP
      try {
        const response = await fetch('/api/stems/engine');
        if (response.ok) {
          const payload = await response.json().catch(() => ({})) as { ok?: boolean; data?: StemServiceStatus; message?: string };
          if (payload.ok && payload.data?.usable) {
            const data = payload.data;
            const chosen = data.profiles.find((p) => p.profile === data.defaultProfile && p.available)
              ?? data.profiles.find((p) => p.available);
            const engine = chosen?.family === 'htdemucs' ? 'DEMUCS_HTDEMUCS_FT' : 'BS_ROFORMER';
            return { available: true, engine, model: chosen?.modelId ?? 'htdemucs-onnx-4stem-fp16' };
          }
          return {
            available: false,
            engine: 'BS_ROFORMER',
            reason: payload.message || 'BS-RoFormer Engine nicht verfügbar (HTTP)',
            code: 'STEM_ENGINE_UNAVAILABLE',
          };
        }
      } catch {
        // Fall through to legacy check
      }

      // Legacy Demucs check – kept only for diagnostics, not as primary
      if (desktop?.getStemEngineStatus) {
        const status = await desktop.getStemEngineStatus();
        if (status.available) {
          return { available: true, engine: 'DEMUCS_HTDEMUCS_FT', model: 'htdemucs_ft' };
        }
        return {
          available: false,
          engine: 'BS_ROFORMER',
          reason: status.reason || 'BS-RoFormer nicht verfügbar, Demucs ebenfalls nicht einsatzbereit.',
          code: 'STEM_ENGINE_UNAVAILABLE',
        };
      }

      return {
        available: false,
        engine: 'BS_ROFORMER',
        reason: 'Stem Engine nicht erreichbar – weder BS-RoFormer noch Demucs verfügbar.',
        code: 'STEM_ENGINE_UNAVAILABLE',
      };
    } catch (error) {
      return {
        available: false,
        engine: 'BS_ROFORMER',
        reason: error instanceof Error ? error.message : String(error),
        code: 'STEM_ENGINE_UNAVAILABLE',
      };
    }
  }

  /**
   * DEPRECATED: The old Demucs path that used spectral fallback.
   * Now throws STEM_ENGINE_UNAVAILABLE instead of falling back.
   * Kept for backward compatibility but never returns spectral.
   */
  public async separateAudioBufferWithModel(
    _sourceBuffer: AudioBuffer,
    trackId: string,
    _originalSha256: string = 'sha256-unverified',
    _onProgress?: StemProgressCallback,
    _options?: { allowFallback?: boolean }
  ): Promise<TrackStems> {
    // This method is now legacy. If called, it must NOT do spectral fallback.
    // It should check availability and throw STEM_ENGINE_UNAVAILABLE.
    const availability = await this.checkAvailability();
    if (!availability.available) {
      logger.error('STEMS', `STEM_ENGINE_UNAVAILABLE: ${availability.reason}`, { code: availability.code });
      throw Object.assign(
        new Error(`STEM AI UNAVAILABLE: ${availability.reason ?? 'Engine nicht verfügbar'}. Echte AI-Stem-Separation erfordert BS-RoFormer mit verifiziertem Checkpoint.`),
        { code: 'STEM_ENGINE_UNAVAILABLE' }
      );
    }

    // If engine is available, delegate to new engine path (BS-RoFormer)
    // For legacy callers that expected Demucs, we now route to BS-RoFormer
    logger.warn('STEMS', `Legacy separateAudioBufferWithModel called for ${trackId} – routing to BS-RoFormer engine`);
    throw Object.assign(
      new Error('Legacy Demucs Pfad ist deprecated – nutze separateWithEngine mit BS-RoFormer.'),
      { code: 'STEM_ENGINE_UNAVAILABLE' }
    );
  }

  /**
   * REMOVED: Deterministic local spectral fallback.
   * This method now throws instead of producing fake stems.
   * Kept as stub to catch accidental usage – never returns audio.
   */
  public async separateAudioBuffer(
    _sourceBuffer: AudioBuffer,
    _trackId: string,
    _originalSha256: string = 'sha256-unverified',
    _onProgress?: StemProgressCallback,
    _factory?: BufferFactory
  ): Promise<TrackStems> {
    logger.error('STEMS', 'Versuch, spektrale Fallback-Separation als Stem Separation zu verwenden – BLOCKIERT');
    throw Object.assign(
      new Error('STEM_ENGINE_UNAVAILABLE: Spektrale Fallback-Separation ist KEINE echte AI-Stem-Separation und darf nicht als Stem ausgegeben werden (§2, §38). BS-RoFormer Engine erforderlich.'),
      { code: 'STEM_ENGINE_UNAVAILABLE' }
    );
  }

  /**
   * Status der neuen Engine (BS-RoFormer primär).
   */
  public async getEngineInfo(): Promise<StemEngineInfo> {
    const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop?.stemEngine : undefined;
    if (desktop?.getStemEngineStatus) {
      const result = await desktop.getStemEngineStatus();
      if (result.ok === false) {
        // Still provide BALANCED/HIGH profiles as unavailable per §23
        return {
          ok: false,
          usable: false,
          profiles: [
            {
              profile: 'BALANCED',
              modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
              family: 'bs_roformer',
              stems: [{ id: 'vocals', displayName: 'Vocals' }, { id: 'drums', displayName: 'Drums' }, { id: 'bass', displayName: 'Bass' }, { id: 'other', displayName: 'Other' }],
              available: false,
              reason: result.message,
              description: 'Ausgewogen – gute Qualität bei moderater Geschwindigkeit (BS-RoFormer)',
            },
            {
              profile: 'HIGH',
              modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
              family: 'bs_roformer',
              stems: [{ id: 'vocals', displayName: 'Vocals' }, { id: 'drums', displayName: 'Drums' }, { id: 'bass', displayName: 'Bass' }, { id: 'other', displayName: 'Other' }],
              available: false,
              reason: result.message,
              description: 'High Quality – BS-RoFormer, best quality',
            },
            {
              profile: 'MAXIMUM_QUALITY',
              modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
              family: 'bs_roformer',
              stems: [{ id: 'vocals', displayName: 'Vocals' }, { id: 'drums', displayName: 'Drums' }, { id: 'bass', displayName: 'Bass' }, { id: 'other', displayName: 'Other' }],
              available: false,
              reason: result.message,
              description: 'Maximum Quality – BS-RoFormer with verification',
            },
          ],
          families: fallbackFamilies(result.message),
          defaultProfile: 'HIGH',
          transport: 'desktop-ipc',
          reason: result.message,
          code: result.code ?? 'STEM_ENGINE_UNAVAILABLE',
        };
      }
      return this.mapEngineStatus(result.data, 'desktop-ipc');
    }
    try {
      const response = await fetch('/api/stems/engine');
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        data?: StemServiceStatus;
      };
      if (!response.ok || payload.ok !== true || !payload.data) {
        const reason = payload.message ?? `Stem-Service HTTP ${response.status}`;
        return {
          ok: false,
          usable: false,
          profiles: [
            {
              profile: 'BALANCED',
              modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
              family: 'bs_roformer',
              stems: [{ id: 'vocals', displayName: 'Vocals' }, { id: 'drums', displayName: 'Drums' }, { id: 'bass', displayName: 'Bass' }, { id: 'other', displayName: 'Other' }],
              available: false,
              reason,
              description: 'Balanced – BS-RoFormer',
            },
            {
              profile: 'HIGH',
              modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
              family: 'bs_roformer',
              stems: [{ id: 'vocals', displayName: 'Vocals' }, { id: 'drums', displayName: 'Drums' }, { id: 'bass', displayName: 'Bass' }, { id: 'other', displayName: 'Other' }],
              available: false,
              reason,
              description: 'High – BS-RoFormer',
            },
          ],
          families: fallbackFamilies(reason),
          defaultProfile: 'HIGH',
          transport: 'http',
          reason: payload.message ?? `Stem-Service antwortet mit HTTP ${response.status}.`,
          code: 'STEM_ENGINE_UNAVAILABLE',
        };
      }
      return this.mapEngineStatus(payload.data, 'http');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        usable: false,
        profiles: [
          {
            profile: 'BALANCED',
            modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
            family: 'bs_roformer',
            stems: [{ id: 'vocals', displayName: 'Vocals' }, { id: 'drums', displayName: 'Drums' }, { id: 'bass', displayName: 'Bass' }, { id: 'other', displayName: 'Other' }],
            available: false,
            reason,
            description: 'Balanced – BS-RoFormer (Engine not reachable)',
          },
          {
            profile: 'HIGH',
            modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
            family: 'bs_roformer',
            stems: [{ id: 'vocals', displayName: 'Vocals' }, { id: 'drums', displayName: 'Drums' }, { id: 'bass', displayName: 'Bass' }, { id: 'other', displayName: 'Other' }],
            available: false,
            reason,
            description: 'High – BS-RoFormer (Engine not reachable)',
          },
          {
            profile: 'MAXIMUM_QUALITY',
            modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
            family: 'bs_roformer',
            stems: [{ id: 'vocals', displayName: 'Vocals' }, { id: 'drums', displayName: 'Drums' }, { id: 'bass', displayName: 'Bass' }, { id: 'other', displayName: 'Other' }],
            available: false,
            reason,
            description: 'Max – BS-RoFormer (Engine not reachable)',
          },
        ],
        families: fallbackFamilies(reason),
        defaultProfile: 'HIGH',
        transport: 'none',
        reason,
        code: 'STEM_ENGINE_UNAVAILABLE',
      };
    }
  }

  private mapEngineStatus(status: StemServiceStatus, transport: 'desktop-ipc' | 'http'): StemEngineInfo {
    // Ensure BALANCED, HIGH are present
    const profiles = status.profiles.map((profile) => ({
      profile: profile.profile as StemQualityProfile,
      modelId: profile.modelId,
      family: profile.family as ModelFamily,
      stems: profile.stems.map((stem) => ({ id: stem.id, displayName: stem.displayName })),
      available: profile.available,
      reason: profile.reason,
      description: profile.description,
    }));

    // If BALANCED missing, derive from HIGH
    const hasBalanced = profiles.some((p) => p.profile === 'BALANCED');
    if (!hasBalanced) {
      const high = profiles.find((p) => p.profile === 'HIGH' || p.profile === 'HIGH_QUALITY');
      if (high) {
        profiles.push({ ...high, profile: 'BALANCED', description: 'Ausgewogen – gute Qualität bei moderater Geschwindigkeit' });
      }
    }

    const families: StemEngineFamilyInfo[] = (status.families ?? []).map((family) => ({
      family: family.family as ModelFamily,
      label: family.label,
      description: family.description,
      available: family.available,
      reason: family.reason,
      serves: family.serves as StemQualityProfile[],
      modelIds: [...family.modelIds],
    }));

    return {
      ok: status.ok,
      usable: status.usable,
      defaultProfile: (status.defaultProfile as StemQualityProfile) ?? 'HIGH',
      transport,
      profiles,
      families,
    };
  }

  /**
   * Architekturen für das Einstellungsmenü: dieselbe Statusquelle wie die
   * Profilanzeige (Desktop-IPC oder HTTP), aber in eine Auswahlliste
   * übersetzt. Der Aufruf braucht keine Gewichte und startet keine Inferenz.
   */
  public async listArchitectures(): Promise<{ options: StemArchitectureOption[]; onnx?: StemServiceStatus['onnx']; transport: 'desktop-ipc' | 'http' | 'unavailable'; reason?: string }> {
    let status: StemServiceStatus | undefined;
    let transport: 'desktop-ipc' | 'http' | 'unavailable' = 'unavailable';
    let reason: string | undefined;
    try {
      const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop : undefined;
      if (desktop?.stemEngine?.getStemEngineStatus) {
        const result = await desktop.stemEngine.getStemEngineStatus();
        if (result.ok === true) {
          status = result.data;
          transport = 'desktop-ipc';
        } else {
          reason = result.message;
        }
      } else if (typeof fetch === 'function') {
        const response = await fetch('/api/stems/engine');
        const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; data?: StemServiceStatus; message?: string };
        if (response.ok && payload.data) {
          status = payload.data;
          transport = 'http';
        } else {
          reason = payload.message ?? `Stem-Service antwortet mit HTTP ${response.status}.`;
        }
      } else {
        reason = 'Kein Transport zum Stem-Service (weder Desktop-IPC noch HTTP).';
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (!status) {
      return { options: describeArchitectures([]), transport, reason };
    }
    return { options: describeArchitectures(status.models ?? []), onnx: status.onnx, transport };
  }

  /**
   * Separation über die neue Engine (BS-RoFormer).
   * Job-basiert, echte AI-Inference, Original unverändert.
   */
  public async separateWithEngine(
    sourceBuffer: AudioBuffer,
    trackId: string,
    originalSha256: string,
    options: EngineSeparationOptions = {}
  ): Promise<TrackStems> {
    const cached = this.getCachedStems(trackId, originalSha256);
    if (cached) {
      options.onProgress?.({ percent: 100, phaseText: 'Stems aus Cache geladen', processedSeconds: cached.duration, totalSeconds: cached.duration });
      return cached;
    }
    if (this.isProcessing) throw new Error('Es läuft bereits eine Separation.');

    const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop?.stemEngine : undefined;
    const duration = sourceBuffer.duration;
    const profile = options.profile ?? 'HIGH';
    this.isProcessing = true;
    const startedAt = Date.now();
    try {
      options.onProgress?.({ percent: 1, phaseText: `Arbeitskopie für Profil ${profile} vorbereiten…`, processedSeconds: 0, totalSeconds: duration });
      const wav = encodeStereoFloatWav(sourceBuffer);
      const trackName = `track_${trackId}`.replace(/[^a-zA-Z0-9._-]+/g, '_');

      let job: StemJobView;
      if (desktop?.startStemJob) {
        const started = await desktop.startStemJob({
          bytes: wav,
          trackName,
          profile,
          modelId: options.modelId,
          family: options.modelId ? undefined : options.family,
          device: options.device,
          mode: options.mode,
        });
        if (started.ok === false) throw Object.assign(new Error(`${started.code}: ${started.message}`), { code: started.code });
        job = started.data;
        this.activeJobId = job.jobId;
        const detach = desktop.onStemJobProgress?.((event) => {
          if (!event || event.job.jobId !== job.jobId) return;
          options.onProgress?.({
            percent: Math.round(event.job.percent),
            phaseText: event.job.phase,
            processedSeconds: event.job.processedSeconds,
            totalSeconds: event.job.totalSeconds || duration,
          });
        });
        try {
          const waited = await desktop.waitStemJob(job.jobId);
          if (waited.ok === false) throw Object.assign(new Error(`${waited.code}: ${waited.message}`), { code: waited.code });
          job = waited.data;
        } finally {
          detach?.();
        }
      } else {
        const response = await fetch('/api/stems/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bytes: base64FromBytes(wav),
            trackName,
            profile,
            modelId: options.modelId,
            family: options.modelId ? undefined : options.family,
            device: options.device,
            mode: options.mode,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; code?: string; data?: StemJobView };
        if (!response.ok || !payload.ok || !payload.data) {
          const code = payload.code ?? 'STEM_ENGINE_UNAVAILABLE';
          throw Object.assign(new Error(payload.message ?? `Stem-Service antwortet mit HTTP ${response.status}.`), { code });
        }
        job = payload.data;
        this.activeJobId = job.jobId;
        for (;;) {
          if (options.signal?.aborted) {
            await fetch(`/api/stems/jobs/${encodeURIComponent(job.jobId)}/cancel`, { method: 'POST' }).catch(() => undefined);
          }
          const poll = await fetch(`/api/stems/jobs/${encodeURIComponent(job.jobId)}`);
          const polled = (await poll.json().catch(() => ({}))) as { ok?: boolean; data?: StemJobView; message?: string; code?: string };
          if (!poll.ok || !polled.ok || !polled.data) {
            throw Object.assign(new Error(polled.message ?? `Stem-Job-Abfrage fehlgeschlagen (HTTP ${poll.status}).`), { code: polled.code ?? 'STEM_ENGINE_UNAVAILABLE' });
          }
          job = polled.data;
          options.onProgress?.({
            percent: Math.round(job.percent),
            phaseText: job.phase,
            processedSeconds: job.processedSeconds,
            totalSeconds: job.totalSeconds || duration,
          });
          if (job.status === 'COMPLETED' || job.status === 'CANCELLED' || job.status === 'FAILED') break;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }

      if (job.status === 'CANCELLED') {
        throw Object.assign(new Error(job.error?.message ?? 'Die Separation wurde abgebrochen; es wurden keine Stems übernommen.'), { code: 'INFERENCE_CANCELLED' });
      }
      if (job.status !== 'COMPLETED') {
        const code = job.error?.code ?? 'STEM_ENGINE_UNAVAILABLE';
        throw Object.assign(new Error(`Stem-Job endete mit Status ${job.status}${job.error ? ` (${job.error.code}: ${job.error.message})` : ''}`), { code });
      }
      const stemIds = job.stems;
      if (!stemIds.length) throw new Error(`Modell ${job.modelId} meldet keine Stems – Deskriptor unvollständig?`);

      options.onProgress?.({ percent: 96, phaseText: `${stemIds.length} Stems dekodieren…`, processedSeconds: duration, totalSeconds: duration });
      const stemsById: Record<string, AudioBuffer> = {};
      for (const stemId of stemIds) {
        if (desktop) {
          const read = await desktop.readStemJobStem!(job.jobId, stemId);
          if (read.ok === false) throw Object.assign(new Error(`${read.code}: ${read.message}`), { code: read.code });
          stemsById[stemId] = await decodeWavToAudioBuffer(read.data.wav);
        } else {
          const response = await fetch(
            `/api/stems/jobs/${encodeURIComponent(job.jobId)}/stems/${encodeURIComponent(stemId)}`
          );
          if (!response.ok) throw new Error(`Stem ${stemId} konnte nicht geladen werden (HTTP ${response.status}).`);
          stemsById[stemId] = await decodeWavToAudioBuffer(new Uint8Array(await response.arrayBuffer()));
        }
      }

      const result = buildTrackStems({ trackId, originalSha256, job, stemsById, profile });
      this.cacheStems(trackId, result, originalSha256);
      options.onProgress?.({
        percent: 100,
        phaseText: `${stemIds.length} Stems mit ${result.modelId} fertig`,
        processedSeconds: duration,
        totalSeconds: duration,
      });
      logger.info('STEMS', `Stem-Job ${job.jobId} fertig (${Date.now() - startedAt} ms)`, {
        trackId,
        profile,
        model: result.modelId,
        stems: stemIds,
        cacheHit: job.cacheHit,
        validation: result.validationPass,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } finally {
      this.activeJobId = undefined;
      this.isProcessing = false;
    }
  }

  /* --------------------------------------------------------------------- *
   * High Quality extern (Google Drive + Colab-Worker, §15–§22)
   * --------------------------------------------------------------------- */

  /** Fern-Job-Status für die UI (konfiguriert? erreichbar? welche Jobs?). */
  public async remoteStatus(): Promise<RemoteServiceStatus | null> {
    const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop?.stemEngine : undefined;
    try {
      if (desktop?.remoteStatus) {
        const result = await desktop.remoteStatus();
        if (result.ok === true) return result.data;
        return {
          configured: false,
          reachable: false,
          jobs: [],
          active: 0,
          completed: 0,
          failed: 0,
          pollIntervalMs: 15_000,
          reason: result.message,
        };
      }
      const response = await fetch('/api/stems/remote/status');
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; data?: RemoteServiceStatus; message?: string };
      if (payload.ok && payload.data) return payload.data;
      return null;
    } catch (error) {
      logger.warn('STEMS', `Fern-Status nicht abrufbar: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** Konfiguriert die Jobablage (Drive-Ordner bzw. rclone-Remote). */
  public async configureRemote(settings: RemoteSettings): Promise<RemoteServiceStatus | null> {
    const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop?.stemEngine : undefined;
    if (desktop?.configureRemoteStemJobs) {
      const result = await desktop.configureRemoteStemJobs(settings);
      return result.ok === true ? result.data : null;
    }
    const response = await fetch('/api/stems/remote/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; data?: RemoteServiceStatus };
    return payload.ok && payload.data ? payload.data : null;
  }

  /**
   * Ein Poll-Zyklus: erkennt fertige Jobs, lädt die Ergebnisse herunter, prüft
   * sie und importiert sie über den bestehenden Stem-Pfad. Wird beim App-Start
   * aufgerufen (Job-Wiederaufnahme nach Neustart, §32).
   */
  public async pollRemoteJobs(): Promise<RemoteServiceStatus | null> {
    const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop?.stemEngine : undefined;
    try {
      if (desktop?.pollRemoteStemJobs) {
        const result = await desktop.pollRemoteStemJobs();
        return result.ok === true ? result.data : null;
      }
      const response = await fetch('/api/stems/remote/poll', { method: 'POST' });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; data?: RemoteServiceStatus };
      return payload.ok && payload.data ? payload.data : null;
    } catch (error) {
      logger.warn('STEMS', `Fern-Job-Poll fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  public async resumeRemoteJobs(): Promise<RemoteServiceStatus | null> {
    const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop?.stemEngine : undefined;
    try {
      if (desktop?.resumeRemoteStemJobs) {
        const result = await desktop.resumeRemoteStemJobs();
        return result.ok === true ? result.data : null;
      }
      const response = await fetch('/api/stems/remote/resume', { method: 'POST' });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; data?: RemoteServiceStatus };
      return payload.ok && payload.data ? payload.data : null;
    } catch (error) {
      logger.warn('STEMS', `Fern-Jobs konnten nicht fortgesetzt werden: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  public async cancelRemoteJob(jobId: string, reason = 'Abbruch durch Benutzer'): Promise<boolean> {
    const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop?.stemEngine : undefined;
    if (desktop?.cancelRemoteStemJob) {
      const result = await desktop.cancelRemoteStemJob(jobId, reason);
      return result.ok === true && result.data.accepted;
    }
    const response = await fetch(`/api/stems/remote/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; data?: { accepted?: boolean } };
    return Boolean(payload.ok && payload.data?.accepted);
  }

  /**
   * High-Quality-Separation auf einem externen Worker (Colab).
   *
   * Der Editor bildet eine Arbeitskopie, lädt sie in die Drive-Ablage und
   * verfolgt den Job. Das Ergebnis kommt über denselben Stem-Lesepfad zurück
   * wie ein lokaler Lauf (der Fern-Dienst trägt es als fertigen Job ein), also
   * ist `TrackStems` hier exakt dasselbe wie aus `separateWithEngine`.
   */
  public async separateRemoteWithEngine(
    sourceBuffer: AudioBuffer,
    trackId: string,
    originalSha256: string,
    options: EngineSeparationOptions = {}
  ): Promise<TrackStems> {
    if (this.isProcessing) throw new Error('Es läuft bereits eine Separation.');
    const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop?.stemEngine : undefined;
    const duration = sourceBuffer.duration;
    const profile = options.profile ?? 'HIGH_QUALITY';
    this.isProcessing = true;
    const startedAt = Date.now();
    try {
      const wav = encodeStereoFloatWav(sourceBuffer);
      const trackName = `track_${trackId}`.replace(/[^a-zA-Z0-9._-]+/g, '_');
      options.onProgress?.({
        percent: 1,
        phaseText: 'Stem-Separation wird vorbereitet (Arbeitskopie für Google Drive)…',
        processedSeconds: 0,
        totalSeconds: duration,
      });

      let job: RemoteStemJobView;
      if (desktop?.startRemoteStemJob) {
        const started = await desktop.startRemoteStemJob({
          bytes: wav,
          trackName,
          profile,
          modelId: options.modelId,
          family: options.modelId ? undefined : options.family,
          device: options.device,
          mode: options.mode,
        });
        if (started.ok === false) throw Object.assign(new Error(`${started.code}: ${started.message}`), { code: started.code });
        job = started.data;
      } else {
        const response = await fetch('/api/stems/remote/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bytes: base64FromBytes(wav),
            trackName,
            profile,
            modelId: options.modelId,
            family: options.modelId ? undefined : options.family,
            device: options.device,
            mode: options.mode,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; code?: string; data?: RemoteStemJobView };
        if (!response.ok || !payload.ok || !payload.data) {
          throw Object.assign(new Error(payload.message ?? `Fern-Job konnte nicht angelegt werden (HTTP ${response.status}).`), {
            code: payload.code ?? 'REMOTE_UNAVAILABLE',
          });
        }
        job = payload.data;
      }
      logger.info('STEM-REMOTE', `Fern-Job ${job.jobId} angelegt (${job.modelId}, ${profile}, ${job.trackName})`, {
        jobId: job.jobId,
        model: job.modelId,
      });

      // Polling (§20): fertig wird der Job erst, wenn der Editor die Ergebnisse
      // geprüft und importiert hat – nicht, wenn der Worker „fertig“ meldet.
      const pollInterval = 5_000;
      for (;;) {
        if (options.signal?.aborted) {
          await this.cancelRemoteJob(job.jobId, 'Abbruch über das Deck');
          throw Object.assign(new Error('Die Fern-Separation wurde abgebrochen.'), { code: 'INFERENCE_CANCELLED' });
        }
        const status = await this.pollRemoteJobs();
        const current = status?.jobs.find((entry) => entry.jobId === job.jobId) ?? job;
        job = current;
        options.onProgress?.({
          percent: Math.max(2, Math.round(current.percent || 0)),
          phaseText: current.phase || 'Stem-Separation läuft (extern)…',
          processedSeconds: duration * ((current.percent || 0) / 100),
          totalSeconds: duration,
        });
        if (current.status === 'COMPLETED') break;
        if (current.status === 'FAILED' || current.status === 'CANCELLED') break;
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      if (job.status === 'CANCELLED') {
        throw Object.assign(new Error(job.error?.message ?? 'Die Fern-Separation wurde abgebrochen; es wurden keine Stems übernommen.'), {
          code: 'INFERENCE_CANCELLED',
        });
      }
      if (job.status !== 'COMPLETED') {
        throw Object.assign(
          new Error(
            `Stem-Separation konnte nicht abgeschlossen werden (${job.error?.code ?? 'REMOTE_FAILED'}): ${job.error?.message ?? job.phase}`
          ),
          { code: job.error?.code ?? 'REMOTE_FAILED' }
        );
      }

      // Ergebnisse liegen lokal (Import durch den Fern-Dienst) und werden über
      // denselben Job-Kanal gelesen wie bei einem lokalen Lauf.
      const jobId = job.localJobId ?? job.jobId;
      options.onProgress?.({ percent: 97, phaseText: `${job.stems.length} Stems übernehmen…`, processedSeconds: duration, totalSeconds: duration });
      const stemsById: Record<string, AudioBuffer> = {};
      for (const stemId of job.stems) {
        if (desktop?.readStemJobStem) {
          const read = await desktop.readStemJobStem(jobId, stemId);
          if (read.ok === false) throw Object.assign(new Error(`${read.code}: ${read.message}`), { code: read.code });
          stemsById[stemId] = await decodeWavToAudioBuffer(read.data.wav);
        } else {
          const response = await fetch(`/api/stems/jobs/${encodeURIComponent(jobId)}/stems/${encodeURIComponent(stemId)}`);
          if (!response.ok) throw new Error(`Stem ${stemId} konnte nicht geladen werden (HTTP ${response.status}).`);
          stemsById[stemId] = await decodeWavToAudioBuffer(new Uint8Array(await response.arrayBuffer()));
        }
      }

      const result = buildTrackStems({
        trackId,
        originalSha256,
        job: {
          jobId,
          status: 'COMPLETED',
          percent: 100,
          phase: job.phase,
          processedSeconds: duration,
          totalSeconds: duration,
          profile: job.profile,
          modelId: job.modelId,
          family: job.family,
          stems: job.stems,
          chunkCount: 0,
          cacheHit: false,
          trackName: job.trackName,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          device: job.device,
          cpuFallback: job.cpuFallback,
          fallbackReason: job.fallbackReason,
          result: { outputDir: '', metadataPath: '', stems: [], validationPass: true, originalUnchanged: true, trainedModel: true },
        },
        stemsById,
        profile,
      });
      this.cacheStems(trackId, result, originalSha256);
      const deviceText = job.cpuFallback ? 'CPU-Fallback' : job.device ? String(job.device).toUpperCase() : 'externer Worker';
      options.onProgress?.({
        percent: 100,
        phaseText: `Stem-Separation abgeschlossen (${job.modelId}, ${deviceText})`,
        processedSeconds: duration,
        totalSeconds: duration,
      });
      logger.info('STEM-REMOTE', `Fern-Job ${job.jobId} importiert (${Date.now() - startedAt} ms)`, {
        jobId: job.jobId,
        model: job.modelId,
        device: job.device,
        cpuFallback: job.cpuFallback ?? false,
        stems: job.stems,
      });
      return result;
    } finally {
      this.isProcessing = false;
    }
  }

  public cancelActiveEngineJob(reason = 'Abbruch durch Benutzer'): boolean {
    const jobId = this.activeJobId;
    if (!jobId) return false;
    const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop?.stemEngine : undefined;
    if (desktop?.cancelStemJob) {
      void desktop.cancelStemJob(jobId, reason);
      return true;
    }
    void fetch(`/api/stems/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).catch(() => undefined);
    return true;
  }

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

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function decodeWavToAudioBuffer(bytes: Uint8Array): Promise<AudioBuffer> {
  const AudioCtx =
    typeof window !== 'undefined'
      ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!AudioCtx) throw new Error('Web Audio API ist für das Dekodieren der Stem-Ausgabe erforderlich.');
  const context = new AudioCtx();
  try {
    const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return await context.decodeAudioData(exact);
  } finally {
    await context.close();
  }
}

function buildTrackStems(input: {
  trackId: string;
  originalSha256: string;
  job: StemJobView;
  stemsById: Record<string, AudioBuffer>;
  profile: StemQualityProfile;
}): TrackStems {
  const { trackId, originalSha256, job, stemsById, profile } = input;
  const slots = ['vocals', 'drums', 'bass', 'other'];
  const unmapped = job.stems.filter((stem) => !slots.includes(stem));
  if (unmapped.length) {
    throw new Error(
      `Modell ${job.modelId} liefert Stems, die der Deck-Mixer nicht darstellen kann: ${unmapped.join(', ')}. ` +
        'Der Mixer kennt aktuell die vier Slots vocals/drums/bass/other.'
    );
  }
  const missing = slots.filter((stem) => !stemsById[stem]);
  if (missing.length) {
    throw new Error(`Modell ${job.modelId} liefert nicht die vier Stems des Deck-Mixers (es fehlen: ${missing.join(', ')}).`);
  }
  const first = stemsById[job.stems[0]];
  return {
    trackId,
    originalSha256,
    duration: first.duration,
    sampleRate: first.sampleRate,
    channels: first.numberOfChannels,
    vocals: stemsById.vocals,
    drums: stemsById.drums,
    bass: stemsById.bass,
    other: stemsById.other,
    separatedAt: Date.now(),
    separationMethod: job.modelId.includes('bsroformer') ? 'BS_ROFORMER' : 'STEM_ENGINE_MODEL',
    stemIds: [...job.stems],
    stemsById,
    modelId: job.modelId,
    profile,
    jobId: job.jobId,
    validationPass: job.result?.validationPass,
    recombinationErrorDb: job.result?.recombinationErrorDb,
    trainedModel: job.result?.trainedModel,
  };
}

export const stemEngine = new StemEngine();
