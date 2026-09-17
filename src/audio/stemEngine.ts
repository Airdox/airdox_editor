/**
 * Renderer stem engine client
 * Selects profile (HQ via engine, PREVIEW via Demucs), stem list from descriptor, progress + cancel
 */

import { getModelCatalog, selectModelForProfile } from '../stems/modelRegistry';
import type { StemProfile, StemId } from '../stems/types';

export const STEM_TYPES: StemId[] = ['vocals', 'drums', 'bass', 'other'];

export type StemEngineProfile = StemProfile;

export interface StemEngineStatus {
  available: boolean;
  models: { id: string; displayName: string; backend: string; trainedModel: boolean }[];
  bridgeLoaded: boolean;
}

export interface StemSeparationProgress {
  phase: string;
  percent?: number;
  detail?: string;
  chunkIndex?: number;
}

export interface StemEngine {
  getStatus(): Promise<StemEngineStatus>;
  separate(inputPath: string, profile: StemEngineProfile, onProgress?: (p: StemSeparationProgress) => void): Promise<{ stems: { id: StemId; filePath: string }[] }>;
  cancel(): void;
  getAvailableStems(modelId?: string): StemId[];
}

class StemEngineImpl implements StemEngine {
  private cancelRequested = false;

  async getStatus(): Promise<StemEngineStatus> {
    // Try desktop API
    try {
      // @ts-ignore
      if (window.stemEngine && typeof window.stemEngine.getStatus === 'function') {
        // @ts-ignore
        const status = await window.stemEngine.getStatus();
        return status;
      }
    } catch {}
    // Fallback: use catalog
    try {
      const catalog = getModelCatalog();
      return {
        available: true,
        models: catalog.models.map(m => ({ id: m.id, displayName: m.displayName, backend: m.backend, trainedModel: m.trainedModel })),
        bridgeLoaded: false,
      };
    } catch {
      return { available: false, models: [], bridgeLoaded: false };
    }
  }

  getAvailableStems(modelId?: string): StemId[] {
    try {
      const catalog = getModelCatalog();
      const model = modelId ? catalog.models.find(m => m.id === modelId) : selectModelForProfile('HIGH_QUALITY');
      return model?.stemOrder ?? STEM_TYPES;
    } catch {
      return STEM_TYPES;
    }
  }

  async separate(inputPath: string, profile: StemEngineProfile, onProgress?: (p: StemSeparationProgress) => void): Promise<{ stems: { id: StemId; filePath: string }[] }> {
    this.cancelRequested = false;

    // Select model based on profile
    let modelId: string;
    try {
      const catalog = getModelCatalog();
      const selected = selectModelForProfile(profile);
      modelId = selected?.id || (profile === 'PREVIEW' ? 'htdemucs-ft-4stem' : 'bsroformer-musdb18hq-4stem-zfturbo');
    } catch {
      modelId = profile === 'PREVIEW' ? 'htdemucs-ft-4stem' : 'bsroformer-musdb18hq-4stem-zfturbo';
    }

    // Fallback guards: if HQ requested but no trained model available, fallback to PREVIEW with warning
    const status = await this.getStatus();
    const hasTrained = status.models.some(m => m.trainedModel && m.id === modelId);
    if (!hasTrained && profile !== 'PREVIEW') {
      console.warn(`Model ${modelId} not available, falling back to PREVIEW`);
      modelId = 'htdemucs-ft-4stem';
      profile = 'PREVIEW';
    }

    // Try desktop bridge
    try {
      // @ts-ignore
      if (window.stemEngine && typeof window.stemEngine.separate === 'function') {
        // @ts-ignore
        if (window.stemEngine.onJobProgress) {
          // @ts-ignore
          const off = window.stemEngine.onJobProgress((data) => {
            if (this.cancelRequested) return;
            onProgress?.({ phase: data.phase, percent: data.percent, detail: data.detail, chunkIndex: data.chunkIndex });
          });
          // @ts-ignore
          const result = await window.stemEngine.separate({ inputPath, modelId, profile });
          off();
          return { stems: result.stems };
        } else {
          // @ts-ignore
          const result = await window.stemEngine.separate({ inputPath, modelId, profile });
          return { stems: result.stems };
        }
      }
    } catch (e) {
      console.error('Stem separation via desktop bridge failed', e);
      // Fallback to cache check
    }

    // Fallback: no engine available, return empty with error
    throw new Error(`Stem engine not available. Tried model ${modelId} profile ${profile}. Install models via npm run stems:setup`);
  }

  cancel(): void {
    this.cancelRequested = true;
    try {
      // @ts-ignore
      if (window.stemEngine && typeof window.stemEngine.cancelJob === 'function') {
        // @ts-ignore
        window.stemEngine.cancelJob('current');
      }
    } catch {}
  }
}

export const stemEngine: StemEngine = new StemEngineImpl();

// Cache for separated stems
const stemCache = new Map<string, { stems: { id: StemId; filePath: string }[]; timestamp: number }>();

export function getCachedStems(inputPath: string, modelId: string): { id: StemId; filePath: string }[] | null {
  const key = `${inputPath}:${modelId}`;
  const entry = stemCache.get(key);
  if (entry && Date.now() - entry.timestamp < 1000 * 60 * 60) {
    return entry.stems;
  }
  return null;
}

export function setCachedStems(inputPath: string, modelId: string, stems: { id: StemId; filePath: string }[]) {
  const key = `${inputPath}:${modelId}`;
  stemCache.set(key, { stems, timestamp: Date.now() });
}

export async function preflightCheck(): Promise<{ available: boolean; reason?: string }> {
  const status = await stemEngine.getStatus();
  if (!status.available) return { available: false, reason: 'Engine not available' };
  if (status.models.length === 0) return { available: false, reason: 'No models registered' };
  return { available: true };
}
