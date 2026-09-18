/**
 * ModelRegistry – models are data, never hard wired code (§4, §18).
 *
 * The registry loads a JSON catalog, validates every descriptor strictly and
 * answers questions like "which model serves MAXIMUM_QUALITY for family X?".
 * An invalid catalog or descriptor is rejected loudly (`MODEL_REGISTRY_INVALID`)
 * instead of silently degrading.
 */
import { createHash } from 'node:crypto';
import catalogJson from './modelCatalog.json' with { type: 'json' };
import { StemSeparationError } from './errors';
import {
  QUALITY_PROFILES,
  type BackendKind,
  type ModelDescriptor,
  type ModelFamily,
  type ModelPrecision,
  type QualityProfile,
  type StemId,
} from './types';

export interface RegistryIssue {
  modelId: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface RegistryValidationResult {
  ok: boolean;
  issues: RegistryIssue[];
  accepted: ModelDescriptor[];
}

const KNOWN_FAMILIES: ModelFamily[] = ['bs_roformer', 'mel_band_roformer', 'htdemucs', 'pipeline_double'];
const KNOWN_BACKENDS: BackendKind[] = ['native-cli', 'python-torch', 'in-process'];
const KNOWN_PRECISION: ModelPrecision[] = ['native', 'f32', 'f16', 'bf16', 'q8_0'];
const SHA256_RE = /^[a-f0-9]{64}$/;
/** Synthetic checkpoints (pipeline double) carry a non-downloadable id instead. */
const SYNTHETIC_HASH_RE = /^synthetic:[a-z0-9._-]+$/;

function require(condition: unknown, message: string, issues: RegistryIssue[], modelId: string, code: string) {
  if (!condition) issues.push({ modelId, severity: 'error', code, message });
  return Boolean(condition);
}

/** Strict structural validation of one descriptor (§4, §10, §16). */
export function validateDescriptor(candidate: unknown): { descriptor?: ModelDescriptor; issues: RegistryIssue[] } {
  const issues: RegistryIssue[] = [];
  const d = (candidate ?? {}) as Partial<ModelDescriptor>;
  const modelId = typeof d.id === 'string' && d.id ? d.id : '<ohne id>';

  require(typeof d.id === 'string' && d.id.length > 0, 'model_id fehlt', issues, modelId, 'MISSING_ID');
  require(KNOWN_FAMILIES.includes(d.family as ModelFamily), `unbekannte model_family: ${String(d.family)}`, issues, modelId, 'UNKNOWN_FAMILY');
  require(typeof d.version === 'string' && d.version.length > 0, 'model_version fehlt', issues, modelId, 'MISSING_VERSION');
  require(Boolean(d.checkpoint?.file), 'checkpoint fehlt', issues, modelId, 'MISSING_CHECKPOINT');
  require(typeof d.sampleRate === 'number' && d.sampleRate > 0, 'sample_rate fehlt oder ist ungültig', issues, modelId, 'BAD_SAMPLE_RATE');
  require(d.inputChannels === 1 || d.inputChannels === 2, `input_channels muss 1 oder 2 sein, ist ${String(d.inputChannels)}`, issues, modelId, 'BAD_INPUT_CHANNELS');

  const stems = Array.isArray(d.outputStems) ? d.outputStems : [];
  const order = Array.isArray(d.stemOrder) ? d.stemOrder : [];
  require(stems.length > 0, 'output_stems ist leer', issues, modelId, 'EMPTY_OUTPUT_STEMS');
  require(order.length > 0, 'stem_order ist leer', issues, modelId, 'EMPTY_STEM_ORDER');
  require(new Set(stems).size === stems.length, 'output_stems enthält Duplikate', issues, modelId, 'DUPLICATE_STEMS');
  require(new Set(order).size === order.length, 'stem_order enthält Duplikate', issues, modelId, 'DUPLICATE_STEM_ORDER');
  require(order.length === stems.length, `stem_order (${order.length}) und output_stems (${stems.length}) müssen gleich lang sein`, issues, modelId, 'STEM_COUNT_MISMATCH');
  for (const stem of order) {
    require(stems.includes(stem as StemId), `stem_order enthält unbekannten Stem "${String(stem)}"`, issues, modelId, 'UNKNOWN_STEM_IN_ORDER');
  }
  require(
    Boolean(d.stemDisplayNames) && order.every((s) => typeof d.stemDisplayNames?.[s as StemId] === 'string'),
    'stem_display_names fehlen für mindestens einen Stem',
    issues,
    modelId,
    'MISSING_DISPLAY_NAMES'
  );

  const hash = typeof d.modelHash === 'string' ? d.modelHash : '';
  require(hash.length > 0, 'model_hash fehlt', issues, modelId, 'MISSING_MODEL_HASH');
  if (hash && hash !== 'unverified' && !SHA256_RE.test(hash) && !SYNTHETIC_HASH_RE.test(hash)) {
    issues.push({
      modelId,
      severity: 'error',
      code: 'BAD_MODEL_HASH',
      message: `model_hash muss sha256, "unverified" oder "synthetic:<id>" sein, ist: ${hash}`,
    });
  }
  if (hash === 'unverified') {
    issues.push({
      modelId,
      severity: 'warning',
      code: 'MODEL_HASH_UNVERIFIED',
      message: 'Checkpoint-Hash ist als "unverified" hinterlegt; die Integrität kann nicht geprüft werden.',
    });
  }

  require(typeof d.license === 'string' && d.license.length > 0, 'license fehlt', issues, modelId, 'MISSING_LICENSE');
  const backends = Array.isArray(d.backendSupport) ? d.backendSupport : [];
  require(backends.length > 0, 'backend_support ist leer', issues, modelId, 'NO_BACKEND');
  for (const b of backends) require(KNOWN_BACKENDS.includes(b as BackendKind), `unbekanntes Backend: ${String(b)}`, issues, modelId, 'UNKNOWN_BACKEND');
  const precisions = Array.isArray(d.precision) ? d.precision : [];
  require(precisions.length > 0, 'precision ist leer', issues, modelId, 'NO_PRECISION');
  for (const p of precisions) require(KNOWN_PRECISION.includes(p as ModelPrecision), `unbekannte Präzision: ${String(p)}`, issues, modelId, 'UNKNOWN_PRECISION');

  require(typeof d.recommendedOverlap === 'number' && d.recommendedOverlap >= 1, 'recommended_overlap muss >= 1 sein', issues, modelId, 'BAD_OVERLAP');
  require(typeof d.chunkSizeSamples === 'number' && d.chunkSizeSamples >= 4096, 'chunk_size_samples ist zu klein', issues, modelId, 'BAD_CHUNK_SIZE');

  const qp = d.qualityProfile;
  require(Boolean(qp) && Array.isArray(qp?.serves) && qp!.serves.length > 0, 'quality_profile.serves fehlt', issues, modelId, 'MISSING_QUALITY_PROFILE');
  for (const profile of qp?.serves ?? []) {
    require(QUALITY_PROFILES.includes(profile as QualityProfile), `unbekanntes Profil: ${String(profile)}`, issues, modelId, 'UNKNOWN_PROFILE');
    const overlap = qp?.numOverlap?.[profile as QualityProfile];
    require(typeof overlap === 'number' && overlap >= 1, `numOverlap für Profil ${String(profile)} fehlt`, issues, modelId, 'MISSING_PROFILE_OVERLAP');
  }

  const hasErrors = issues.some((issue) => issue.severity === 'error');
  return { descriptor: hasErrors ? undefined : (d as ModelDescriptor), issues };
}

export interface ModelRegistryOptions {
  /** Extra descriptors registered on top of the bundled catalog. */
  extra?: ModelDescriptor[];
  /** When true an invalid entry aborts the whole registry. */
  strict?: boolean;
}

/**
 * Immutable, validated collection of model descriptors.
 */
export class ModelRegistry {
  private readonly models = new Map<string, ModelDescriptor>();
  public readonly issues: RegistryIssue[] = [];

  private constructor(models: ModelDescriptor[], issues: RegistryIssue[], strict: boolean) {
    this.issues = issues;
    for (const model of models) this.models.set(model.id, model);
    if (strict && issues.some((issue) => issue.severity === 'error')) {
      throw new StemSeparationError('MODEL_REGISTRY_INVALID', 'Model-Registry enthält ungültige Einträge', { issues });
    }
  }

  /** Builds a registry from the bundled catalog plus optional extras. */
  static fromBundledCatalog(options: ModelRegistryOptions = {}): ModelRegistry {
    return ModelRegistry.fromCatalog(catalogJson as unknown as { models: unknown[] }, options);
  }

  static fromCatalog(catalog: { models?: unknown[] }, options: ModelRegistryOptions = {}): ModelRegistry {
    const issues: RegistryIssue[] = [];
    const accepted: ModelDescriptor[] = [];
    const entries = Array.isArray(catalog?.models) ? catalog.models : [];
    if (entries.length === 0) {
      throw new StemSeparationError('MODEL_REGISTRY_INVALID', 'Model-Katalog enthält keine Einträge');
    }
    for (const entry of [...entries, ...(options.extra ?? [])]) {
      const { descriptor, issues: entryIssues } = validateDescriptor(entry);
      issues.push(...entryIssues);
      if (!descriptor) continue;
      if (accepted.some((model) => model.id === descriptor.id)) {
        issues.push({ modelId: descriptor.id, severity: 'error', code: 'DUPLICATE_ID', message: 'model_id ist doppelt vorhanden' });
        continue;
      }
      accepted.push(descriptor);
    }
    return new ModelRegistry(accepted, issues, options.strict ?? false);
  }

  get ids(): string[] {
    return [...this.models.keys()];
  }

  list(): ModelDescriptor[] {
    return [...this.models.values()];
  }

  get(id: string): ModelDescriptor | undefined {
    return this.models.get(id);
  }

  require(id: string): ModelDescriptor {
    const model = this.models.get(id);
    if (!model) {
      throw new StemSeparationError(
        'MODEL_MISSING',
        `Modell "${id}" ist nicht in der Registry registriert (verfügbar: ${this.ids.join(', ') || 'keine'})`
      );
    }
    return model;
  }

  byFamily(family: ModelFamily): ModelDescriptor[] {
    return this.list().filter((model) => model.family === family);
  }

  /** Models allowed to serve a profile, best family first. */
  candidatesForProfile(profile: QualityProfile, family?: ModelFamily): ModelDescriptor[] {
    return this.list().filter(
      (model) => model.qualityProfile.serves.includes(profile) && (!family || model.family === family)
    );
  }

  /**
   * Deterministic model selection:
   * HIGH_QUALITY / MAXIMUM_QUALITY / HIGH / BALANCED always prefer `bs_roformer` (primary engine),
   * then other RoFormer families. PREVIEW prefers the fastest available family.
   */
  selectForProfile(profile: QualityProfile, family?: ModelFamily): ModelDescriptor {
    const candidates = this.candidatesForProfile(profile, family);
    if (candidates.length === 0) {
      throw new StemSeparationError(
        'MODEL_INCOMPATIBLE',
        `Kein registriertes Modell bedient Profil ${profile}${family ? ` für Familie ${family}` : ''}`,
        { profile, family, available: this.list().map((m) => ({ id: m.id, serves: m.qualityProfile.serves })) }
      );
    }
    const familyRank: Record<ModelFamily, number> =
      profile === 'PREVIEW'
        ? { htdemucs: 0, bs_roformer: 1, mel_band_roformer: 2, pipeline_double: 3 }
        : { bs_roformer: 0, mel_band_roformer: 1, htdemucs: 2, pipeline_double: 3 };
    // Prefer the primary 4-stem model for HQ profiles
    return [...candidates].sort((a, b) => {
      const rank = familyRank[a.family] - familyRank[b.family];
      if (rank !== 0) return rank;
      // Primary model first
      if (a.id === 'bsroformer-musdb18hq-4stem-zfturbo') return -1;
      if (b.id === 'bsroformer-musdb18hq-4stem-zfturbo') return 1;
      return a.id.localeCompare(b.id);
    })[0];
  }

  /** Overlap/ensemble parameters of a model for one profile. */
  parametersFor(descriptor: ModelDescriptor, profile: QualityProfile): { numOverlap: number; ensemblePasses: number } {
    const numOverlap = descriptor.qualityProfile.numOverlap[profile] ?? descriptor.recommendedOverlap;
    const ensemblePasses = descriptor.qualityProfile.ensemblePasses?.[profile] ?? 1;
    return { numOverlap, ensemblePasses };
  }

  /** Stable hash over the registry contents – part of the job metadata. */
  contentHash(): string {
    const canonical = JSON.stringify(this.list().map((m) => [m.id, m.version, m.modelHash, m.stemOrder]));
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  /** Full validation report, used by the quality gate and by tests. */
  validate(): RegistryValidationResult {
    return {
      ok: !this.issues.some((issue) => issue.severity === 'error'),
      issues: this.issues,
      accepted: this.list(),
    };
  }
}

/** Loads a catalog from a parsed JSON document (file based deployments). */
export function registryFromJson(json: unknown, options: ModelRegistryOptions = {}): ModelRegistry {
  if (!json || typeof json !== 'object') {
    throw new StemSeparationError('MODEL_REGISTRY_INVALID', 'Model-Katalog ist kein JSON-Objekt');
  }
  return ModelRegistry.fromCatalog(json as { models?: unknown[] }, options);
}

export type { ModelDescriptor };
