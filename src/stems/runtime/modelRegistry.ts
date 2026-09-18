/**
 * Model Registry v2 – implements requirements §4, §5, §6.
 *
 * Must contain at least:
 * modelId, architecture, version, checkpoint, config,
 * checkpointSha256, sampleRate, supportedStems, sourceUrl,
 * license, weightLicense, status
 *
 * Status:
 * AVAILABLE
 * MISSING_CHECKPOINT
 * MISSING_CONFIG
 * HASH_MISMATCH
 * INVALID_CONFIG
 * LICENSE_UNVERIFIED
 * NOT_INSTALLED
 *
 * Only AVAILABLE may be used for real separation.
 */

import { ModelRegistry as LegacyRegistry } from '../modelRegistry';
import { verifyCheckpointIntegrity, verifyConfigIntegrity, getKnownCheckpointHash } from './checkpointIntegrity';
import { resolveStemModel } from './pathResolver';
import type { ModelDescriptor } from '../types';

export type ModelStatus =
  | 'AVAILABLE'
  | 'MISSING_CHECKPOINT'
  | 'MISSING_CONFIG'
  | 'HASH_MISMATCH'
  | 'INVALID_CONFIG'
  | 'LICENSE_UNVERIFIED'
  | 'NOT_INSTALLED';

export interface ModelRegistryEntry {
  modelId: string;
  architecture: string;
  version: string;
  checkpoint: string; // file name
  config: string; // file name
  checkpointSha256: string;
  sampleRate: number;
  supportedStems: string[];
  sourceUrl: string;
  license: string;
  weightLicense: string;
  status: ModelStatus;
  // Extended
  checkpointPath: string | null;
  configPath: string | null;
  checkpointVerified: boolean;
  configValid: boolean;
  reason?: string;
  // Legacy descriptor for compatibility
  legacyDescriptor?: ModelDescriptor;
}

export interface ModelRegistryOptions {
  env?: NodeJS.ProcessEnv;
  modelStoreDir?: string;
  /** Extra descriptors on top of bundled catalog */
  extraDescriptors?: ModelDescriptor[];
}

function mapLegacyToNew(descriptor: ModelDescriptor, modelStoreDir: string): Omit<ModelRegistryEntry, 'status' | 'checkpointPath' | 'configPath' | 'checkpointVerified' | 'configValid' | 'reason'> {
  const checkpointFile = descriptor.checkpoint.file;
  const configFile = descriptor.config?.file ?? '';
  const sourceUrl = descriptor.checkpoint.url ?? '';
  // Architecture from family
  const architectureMap: Record<string, string> = {
    bs_roformer: 'BS-RoFormer',
    mel_band_roformer: 'Mel-Band RoFormer',
    htdemucs: 'HTDemucs',
    pipeline_double: 'Pipeline Double (Synthetic)',
  };
  // Weight license – infer from notes/license
  const weightLicense = descriptor.license.includes('MIT') ? 'MIT' : descriptor.license;

  return {
    modelId: descriptor.id,
    architecture: architectureMap[descriptor.family] ?? descriptor.family,
    version: descriptor.version,
    checkpoint: checkpointFile,
    config: configFile,
    checkpointSha256: descriptor.modelHash !== 'unverified' ? descriptor.modelHash : getKnownCheckpointHashForModel(descriptor.id),
    sampleRate: descriptor.sampleRate,
    supportedStems: [...descriptor.outputStems],
    sourceUrl,
    license: descriptor.license,
    weightLicense,
    legacyDescriptor: descriptor,
  };
}

function getKnownCheckpointHashForModel(modelId: string): string {
  // For the primary model, use the known hash from live test
  if (modelId === 'bsroformer-musdb18hq-4stem-zfturbo') {
    return getKnownCheckpointHash();
  }
  // For others, return placeholder that will be validated as unverified unless overridden
  return 'unverified';
}

export class ModelRegistryV2 {
  private entries: Map<string, ModelRegistryEntry> = new Map();
  private legacy: LegacyRegistry;

  private constructor(legacy: LegacyRegistry, entries: ModelRegistryEntry[]) {
    this.legacy = legacy;
    for (const e of entries) this.entries.set(e.modelId, e);
  }

  static async create(options: ModelRegistryOptions = {}): Promise<ModelRegistryV2> {
    const legacy = LegacyRegistry.fromBundledCatalog({ extra: options.extraDescriptors });
    const entries: ModelRegistryEntry[] = [];

    for (const descriptor of legacy.list()) {
      const base = mapLegacyToNew(descriptor, options.modelStoreDir ?? '');

      // Resolve actual paths
      const resolved = resolveStemModel({
        env: options.env,
        checkpointFile: base.checkpoint,
        configFile: base.config,
      });

      const checkpointPath = resolved.checkpointPath;
      const configPath = base.config ? resolved.configPath : null;

      // Initial status – will be updated by verify()
      const entry: ModelRegistryEntry = {
        ...base,
        checkpointPath,
        configPath,
        checkpointVerified: false,
        configValid: false,
        status: 'NOT_INSTALLED',
        reason: 'Not yet verified',
      };
      entries.push(entry);
    }

    const registry = new ModelRegistryV2(legacy, entries);
    await registry.verifyAll(options);
    return registry;
  }

  static fromLegacy(legacy: LegacyRegistry, modelStoreDir?: string): ModelRegistryV2 {
    const entries: ModelRegistryEntry[] = legacy.list().map((d) => {
      const base = mapLegacyToNew(d, modelStoreDir ?? '');
      const resolved = resolveStemModel({ checkpointFile: base.checkpoint, configFile: base.config });
      return {
        ...base,
        checkpointPath: resolved.checkpointPath,
        configPath: base.config ? resolved.configPath : null,
        checkpointVerified: false,
        configValid: false,
        status: 'NOT_INSTALLED' as ModelStatus,
        reason: 'Not yet verified',
      };
    });
    return new ModelRegistryV2(legacy, entries);
  }

  async verifyAll(options: ModelRegistryOptions = {}): Promise<void> {
    for (const entry of this.entries.values()) {
      await this.verifyEntry(entry, options);
    }
  }

  async verifyEntry(entry: ModelRegistryEntry, options: ModelRegistryOptions = {}): Promise<ModelRegistryEntry> {
    const resolved = resolveStemModel({
      env: options.env,
      checkpointFile: entry.checkpoint,
      configFile: entry.config,
    });
    entry.checkpointPath = resolved.checkpointPath;
    entry.configPath = entry.config ? resolved.configPath : null;

    // Check checkpoint
    if (!entry.checkpointPath) {
      entry.status = 'MISSING_CHECKPOINT';
      entry.reason = 'Checkpoint path could not be resolved';
      entry.checkpointVerified = false;
      return entry;
    }

    const checkpointResult = await verifyCheckpointIntegrity(entry.checkpointPath, entry.checkpointSha256);
    if (!checkpointResult.exists) {
      entry.status = 'MISSING_CHECKPOINT';
      entry.reason = checkpointResult.reason;
      entry.checkpointVerified = false;
      return entry;
    }

    // Check if hash is unverified
    if (entry.checkpointSha256 === 'unverified' || !entry.checkpointSha256) {
      entry.status = 'LICENSE_UNVERIFIED';
      entry.reason = `model_hash is unverified – integrity cannot be verified. Computed: ${checkpointResult.sha256}`;
      entry.checkpointVerified = false;
      return entry;
    }

    if (!checkpointResult.verified) {
      entry.status = 'HASH_MISMATCH';
      entry.reason = checkpointResult.reason;
      entry.checkpointVerified = false;
      return entry;
    }

    entry.checkpointVerified = true;

    // Check config if present
    if (entry.config) {
      if (!entry.configPath) {
        entry.status = 'MISSING_CONFIG';
        entry.reason = 'Config path could not be resolved';
        entry.configValid = false;
        return entry;
      }
      const configResult = await verifyConfigIntegrity(entry.configPath);
      if (!configResult.exists) {
        entry.status = 'MISSING_CONFIG';
        entry.reason = configResult.reason;
        entry.configValid = false;
        return entry;
      }
      if (!configResult.valid) {
        entry.status = 'INVALID_CONFIG';
        entry.reason = configResult.reason;
        entry.configValid = false;
        return entry;
      }
      entry.configValid = true;
    } else {
      // No config required (e.g., demucs)
      entry.configValid = true;
    }

    // Check license
    if (!entry.license || entry.license.trim().length === 0) {
      entry.status = 'LICENSE_UNVERIFIED';
      entry.reason = 'License missing';
      return entry;
    }

    // All good
    entry.status = 'AVAILABLE';
    entry.reason = undefined;
    return entry;
  }

  get(modelId: string): ModelRegistryEntry | undefined {
    return this.entries.get(modelId);
  }

  list(): ModelRegistryEntry[] {
    return [...this.entries.values()];
  }

  listAvailable(): ModelRegistryEntry[] {
    return this.list().filter((e) => e.status === 'AVAILABLE');
  }

  getPrimary(): ModelRegistryEntry | undefined {
    // Primary is bsroformer-musdb18hq-4stem-zfturbo
    return this.get('bsroformer-musdb18hq-4stem-zfturbo') ?? this.listAvailable().find((e) => e.architecture.includes('BS-RoFormer'));
  }

  requireAvailable(modelId: string): ModelRegistryEntry {
    const entry = this.get(modelId);
    if (!entry) throw new Error(`Model ${modelId} not found in registry`);
    if (entry.status !== 'AVAILABLE') {
      throw new Error(`Model ${modelId} not AVAILABLE (status: ${entry.status}, reason: ${entry.reason})`);
    }
    return entry;
  }

  getLegacyRegistry(): LegacyRegistry {
    return this.legacy;
  }

  toJSON() {
    return {
      models: this.list().map((e) => ({
        modelId: e.modelId,
        architecture: e.architecture,
        version: e.version,
        checkpoint: e.checkpoint,
        config: e.config,
        checkpointSha256: e.checkpointSha256,
        sampleRate: e.sampleRate,
        supportedStems: e.supportedStems,
        sourceUrl: e.sourceUrl,
        license: e.license,
        weightLicense: e.weightLicense,
        status: e.status,
        checkpointPath: e.checkpointPath,
        configPath: e.configPath,
        checkpointVerified: e.checkpointVerified,
        reason: e.reason,
      })),
    };
  }
}

export async function createModelRegistry(options: ModelRegistryOptions = {}): Promise<ModelRegistryV2> {
  return ModelRegistryV2.create(options);
}
