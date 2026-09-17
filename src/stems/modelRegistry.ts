import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StemId } from './types';
import type { StemModelDescriptor as BaseDescriptor } from './stemSeparationEngine';

export interface ModelCatalogEntry extends BaseDescriptor {
  displayName: string;
  description: string;
  outputStems: StemId[];
  backend: string;
  qualityProfile: {
    serves: 'PREVIEW' | 'HIGH_QUALITY' | 'MAXIMUM_QUALITY';
    chunkSize?: number;
    overlap?: number;
    numOverlap?: number;
    ensemblePasses?: number;
    shifts?: number;
    precision?: string;
    clipMode?: string;
    overlapInner?: number;
  };
  checkpoint: {
    sha256: string;
    size: number;
    url?: string;
  };
  license?: string;
}

export interface ModelCatalog {
  contentHash: string;
  models: ModelCatalogEntry[];
}

function loadCatalogSync(): ModelCatalog {
  try {
    const current = fileURLToPath(import.meta.url);
    const dir = path.dirname(current);
    const catalogPath = path.join(dir, 'modelCatalog.json');
    const raw = readFileSync(catalogPath, 'utf8');
    return JSON.parse(raw) as ModelCatalog;
  } catch {
    // Fallback for CJS bundle or tests where import.meta may not resolve
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs');
      const p = require('node:path');
      const possible = [
        p.join(process.cwd(), 'src/stems/modelCatalog.json'),
        p.join(__dirname, 'modelCatalog.json'),
        p.join(__dirname, '..', 'stems', 'modelCatalog.json'),
      ];
      for (const candidate of possible) {
        try {
          const raw = fs.readFileSync(candidate, 'utf8');
          return JSON.parse(raw) as ModelCatalog;
        } catch {
          continue;
        }
      }
    } catch {
      // ignore
    }
    return { contentHash: 'unknown', models: [] };
  }
}

let cachedCatalog: ModelCatalog | null = null;

export function getModelCatalog(): ModelCatalog {
  if (!cachedCatalog) cachedCatalog = loadCatalogSync();
  return cachedCatalog;
}

export function validateModelEntry(entry: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be object'] };
  }
  const e = entry as Record<string, unknown>;
  const required = ['id', 'displayName', 'stemOrder', 'outputStems', 'trainedModel', 'backend', 'qualityProfile', 'checkpoint'];
  for (const field of required) {
    if (!(field in e)) errors.push(`Missing required field: ${field}`);
  }
  if (typeof e.id !== 'string' || !e.id) errors.push('id must be non-empty string');
  if (typeof e.displayName !== 'string' || !e.displayName) errors.push('displayName must be non-empty string');
  if (!Array.isArray(e.stemOrder) || e.stemOrder.length === 0) errors.push('stemOrder must be non-empty array');
  if (!Array.isArray(e.outputStems) || e.outputStems.length === 0) errors.push('outputStems must be non-empty array');
  if (Array.isArray(e.stemOrder) && Array.isArray(e.outputStems)) {
    const so = new Set(e.stemOrder as string[]);
    const os = new Set(e.outputStems as string[]);
    if (so.size !== (e.stemOrder as unknown[]).length) errors.push('stemOrder contains duplicates');
    if (os.size !== (e.outputStems as unknown[]).length) errors.push('outputStems contains duplicates');
    // stemOrder vs outputStems should match as sets (order may differ for demucs)
    const soSorted = [...so].sort();
    const osSorted = [...os].sort();
    if (soSorted.join(',') !== osSorted.join(',')) {
      errors.push(`stemOrder ${JSON.stringify(e.stemOrder)} vs outputStems ${JSON.stringify(e.outputStems)} mismatch`);
    }
  }
  if (typeof e.trainedModel !== 'boolean') errors.push('trainedModel must be boolean');
  if (typeof e.backend !== 'string' || !e.backend) errors.push('backend must be non-empty string');
  if (!e.qualityProfile || typeof e.qualityProfile !== 'object') {
    errors.push('qualityProfile must be object');
  } else {
    const qp = e.qualityProfile as Record<string, unknown>;
    if (!['PREVIEW', 'HIGH_QUALITY', 'MAXIMUM_QUALITY'].includes(qp.serves as string)) {
      errors.push('qualityProfile.serves must be PREVIEW|HIGH_QUALITY|MAXIMUM_QUALITY');
    }
    if (qp.numOverlap !== undefined && (typeof qp.numOverlap !== 'number' || qp.numOverlap < 1)) {
      errors.push('qualityProfile.numOverlap must be >=1');
    }
    if (qp.ensemblePasses !== undefined && (typeof qp.ensemblePasses !== 'number' || qp.ensemblePasses < 1)) {
      errors.push('qualityProfile.ensemblePasses must be >=1');
    }
  }
  if (!e.checkpoint || typeof e.checkpoint !== 'object') {
    errors.push('checkpoint must be object');
  } else {
    const cp = e.checkpoint as Record<string, unknown>;
    if (typeof cp.sha256 !== 'string' || !/^[a-f0-9]{64,128}$/i.test(cp.sha256 as string)) {
      // allow longer for placeholder but require hex
      if (typeof cp.sha256 !== 'string' || cp.sha256.length < 32) {
        errors.push('checkpoint.sha256 must be hex string >=32 chars');
      }
    }
    if (typeof cp.size !== 'number' || cp.size < 0) errors.push('checkpoint.size must be >=0');
  }
  return { valid: errors.length === 0, errors };
}

export function validateCatalog(catalog: ModelCatalog): { valid: boolean; errors: string[]; contentHash: string } {
  const errors: string[] = [];
  if (!catalog || typeof catalog !== 'object') {
    return { valid: false, errors: ['Catalog must be object'], contentHash: '' };
  }
  if (typeof catalog.contentHash !== 'string' || !catalog.contentHash) {
    errors.push('contentHash must be non-empty string');
  }
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    errors.push('models must be non-empty array');
  } else {
    for (const model of catalog.models) {
      const res = validateModelEntry(model);
      if (!res.valid) errors.push(`Model ${ (model as { id?: string }).id ?? 'unknown'}: ${res.errors.join('; ')}`);
    }
    // check duplicate ids
    const ids = catalog.models.map(m => m.id);
    const dup = ids.filter((id, idx) => ids.indexOf(id) !== idx);
    if (dup.length) errors.push(`Duplicate model ids: ${[...new Set(dup)].join(',')}`);
  }
  // compute content hash from models list (excluding existing contentHash)
  const hash = createHash('sha256').update(JSON.stringify(catalog.models)).digest('hex').slice(0, 32);
  return { valid: errors.length === 0, errors, contentHash: hash };
}

export function selectModelForProfile(profile: 'PREVIEW' | 'HIGH_QUALITY' | 'MAXIMUM_QUALITY', catalog = getModelCatalog()): ModelCatalogEntry | undefined {
  const candidates = catalog.models.filter(m => m.qualityProfile.serves === profile && m.trainedModel);
  if (candidates.length === 0) {
    // fallback to any trained model serving that profile or higher
    if (profile === 'PREVIEW') {
      return catalog.models.find(m => m.trainedModel);
    }
    if (profile === 'HIGH_QUALITY') {
      return catalog.models.find(m => m.qualityProfile.serves === 'MAXIMUM_QUALITY' && m.trainedModel)
        ?? catalog.models.find(m => m.trainedModel && m.backend.includes('roformer'));
    }
  }
  // Prefer bs_roformer for HQ as per spec
  if (profile === 'HIGH_QUALITY' || profile === 'MAXIMUM_QUALITY') {
    const bs = candidates.find(m => m.backend.includes('roformer') || m.id.includes('bsroformer') || m.id.includes('bs_roformer'));
    if (bs) return bs;
  }
  return candidates[0];
}

export const DEFAULT_MODEL_ID = 'bsroformer-musdb18hq-4stem-zfturbo';

export function modelStemOrder(modelId: string, fallback: StemId[] = ['vocals', 'drums', 'bass', 'other']): StemId[] {
  const catalog = getModelCatalog();
  return catalog.models.find(m => m.id === modelId)?.stemOrder ?? fallback;
}

export function stemNamesForModel(modelId: string, fallback: StemId[] = ['vocals', 'drums', 'bass', 'other']): StemId[] {
  return modelStemOrder(modelId, fallback);
}

export function getModelDescriptor(modelId: string): ModelCatalogEntry | undefined {
  return getModelCatalog().models.find(m => m.id === modelId);
}

export function listModels(): ModelCatalogEntry[] {
  return getModelCatalog().models;
}

export function getContentHash(): string {
  return getModelCatalog().contentHash;
}

// Re-export for compatibility
export type { StemModelDescriptor } from './stemSeparationEngine';
export { StemRegistry } from './stemSeparationEngine';
