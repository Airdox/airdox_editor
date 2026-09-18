/**
 * ModelManager – checkpoint acquisition and integrity (§4, §16).
 *
 * Responsibilities:
 *  - resolve a descriptor to concrete local files inside the model store
 *  - verify sha256 (a mismatch is `MODEL_CORRUPT`, never "probably fine")
 *  - download missing weights when a URL is configured and downloads allowed
 *  - report availability in a machine readable form for the UI/CLI
 *
 * The manager never touches audio files and never writes outside the store.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { StemSeparationError } from './errors';
import type { ModelRegistry } from './modelRegistry';
import type { ModelCheckpointRef, ModelDescriptor } from './types';

export interface ModelManagerOptions {
  /** Directory holding checkpoints and configs. */
  storeDir: string;
  /** Allow network downloads of missing weights. */
  allowDownload?: boolean;
  /** Injectable transport (tests, proxies). */
  fetchImpl?: typeof fetch;
  /** Environment overrides: `AIRODOX_STEM_MODEL_DIR` wins over `storeDir`. */
  env?: NodeJS.ProcessEnv;
}

export interface ModelFileStatus {
  role: 'checkpoint' | 'config';
  file: string;
  path: string;
  exists: boolean;
  bytes: number;
  expectedBytes?: number;
  sha256?: string;
  expectedSha256?: string;
  hashVerified: boolean;
  hashVerifiable: boolean;
}

export interface ModelAvailabilityReport {
  modelId: string;
  family: string;
  version: string;
  available: boolean;
  hashVerified: boolean;
  reason?: string;
  checkpoint?: ModelFileStatus;
  config?: ModelFileStatus;
  downloaded: boolean;
}

const SHA256_RE = /^[a-f0-9]{64}$/;

async function hashOfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export class ModelManager {
  private readonly registry: ModelRegistry;
  private readonly options: ModelManagerOptions;

  constructor(registry: ModelRegistry, options: ModelManagerOptions) {
    this.registry = registry;
    this.options = options;
  }

  get storeDir(): string {
    const fromEnv = this.options.env?.AIRODOX_STEM_MODEL_DIR;
    return fromEnv && fromEnv.length > 0 ? fromEnv : this.options.storeDir;
  }

  resolvePath(ref: ModelCheckpointRef): string {
    if (path.isAbsolute(ref.file)) {
      throw new StemSeparationError('MODEL_MISSING', 'Checkpoint-Pfade müssen relativ zum Model-Store sein', { file: ref.file });
    }
    return path.join(this.storeDir, ref.file);
  }

  private async inspect(ref: ModelCheckpointRef | undefined, role: 'checkpoint' | 'config'): Promise<ModelFileStatus | undefined> {
    if (!ref) return undefined;
    const filePath = this.resolvePath(ref);
    let exists = false;
    let bytes = 0;
    try {
      const info = await stat(filePath);
      exists = info.isFile();
      bytes = info.size;
    } catch {
      exists = false;
    }
    const hashVerifiable = Boolean(ref.sha256 && SHA256_RE.test(ref.sha256));
    let sha256: string | undefined;
    if (exists) {
      sha256 = await hashOfFile(filePath);
    }
    return {
      role,
      file: ref.file,
      path: filePath,
      exists,
      bytes,
      expectedBytes: ref.bytes,
      sha256,
      expectedSha256: ref.sha256,
      hashVerified: Boolean(exists && hashVerifiable && sha256 === ref.sha256),
      hashVerifiable,
    };
  }

  /** Downloads one file (checkpoint or config) into the store, verifying it. */
  private async download(ref: ModelCheckpointRef, target: string): Promise<void> {
    if (!ref.url) {
      throw new StemSeparationError('MODEL_MISSING', `Kein Download-URL für ${ref.file} hinterlegt`, { file: ref.file });
    }
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new StemSeparationError('MODEL_MISSING', 'Kein fetch verfügbar – Checkpoint kann nicht geladen werden');
    }
    await mkdir(path.dirname(target), { recursive: true });
    const response = await fetchImpl(ref.url);
    if (!response.ok || !response.body) {
      throw new StemSeparationError('MODEL_MISSING', `Download fehlgeschlagen (HTTP ${response.status}): ${ref.url}`);
    }
    const tmp = `${target}.part`;
    const hash = createHash('sha256');
    const writer = createWriteStream(tmp);
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        hash.update(chunk);
        if (!writer.write(chunk)) await new Promise<void>((resolve) => writer.once('drain', () => resolve()));
      }
    } finally {
      await new Promise<void>((resolve) => {
        writer.end(() => resolve());
      });
    }
    const digest = hash.digest('hex');
    if (ref.sha256 && SHA256_RE.test(ref.sha256) && digest !== ref.sha256) {
      await unlink(tmp).catch(() => undefined);
      throw new StemSeparationError('MODEL_CORRUPT', `sha256 des Downloads stimmt nicht (${digest} != ${ref.sha256})`, { file: ref.file });
    }
    const { rename } = await import('node:fs/promises');
    await rename(tmp, target);
  }

  /**
   * Makes sure checkpoint (and config, when declared) are present and intact.
   * Downloads only when `allowDownload` is set.
   */
  async ensureAvailable(modelId: string): Promise<ModelAvailabilityReport> {
    const descriptor = this.registry.require(modelId);
    return this.ensureDescriptorAvailable(descriptor);
  }

  async ensureDescriptorAvailable(descriptor: ModelDescriptor): Promise<ModelAvailabilityReport> {
    let downloaded = false;
    const targets: { ref: ModelCheckpointRef | undefined; role: 'checkpoint' | 'config' }[] = [
      { ref: descriptor.checkpoint, role: 'checkpoint' },
      { ref: descriptor.config, role: 'config' },
    ];

    for (const target of targets) {
      if (!target.ref) continue;
      const filePath = this.resolvePath(target.ref);
      const status = await this.inspect(target.ref, target.role);
      if (status?.exists && (!status.hashVerifiable || status.hashVerified)) continue;
      if (target.ref.format === 'synthetic' && !status?.exists) {
        // Synthetic checkpoints carry no external weights: the manifest is
        // written locally and identifies the double by id/version.
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(
          filePath,
          JSON.stringify(
            { kind: 'synthetic-checkpoint', modelId: descriptor.id, version: descriptor.version, stemOrder: descriptor.stemOrder },
            null,
            2
          )
        );
        downloaded = false;
        continue;
      }
      if (status?.exists && status.hashVerifiable && !status.hashVerified) {
        throw new StemSeparationError('MODEL_CORRUPT', `Checkpoint ${target.ref.file} ist beschädigt (sha256-Abweichung)`, {
          file: target.ref.file,
          expected: status.expectedSha256,
          actual: status.sha256,
        });
      }
      if (!this.options.allowDownload) {
        throw new StemSeparationError(
          'MODEL_MISSING',
          `Modell ${descriptor.id} ist nicht installiert (${target.ref.file} fehlt in ${this.storeDir}). ` +
            'Installation: npm run stems:setup:bsroformer',
          { file: target.ref.file, store: this.storeDir }
        );
      }
      await this.download(target.ref, filePath);
      downloaded = true;
      const after = await this.inspect(target.ref, target.role);
      if (!after?.exists) {
        throw new StemSeparationError('MODEL_MISSING', `Download von ${target.ref.file} ist fehlgeschlagen`);
      }
    }

    return this.verifyDescriptor(descriptor, downloaded);
  }

  /** Read-only availability/verification report (no downloads, no throwing). */
  async verify(modelId: string): Promise<ModelAvailabilityReport> {
    const descriptor = this.registry.require(modelId);
    return this.verifyDescriptor(descriptor, false);
  }

  private async verifyDescriptor(descriptor: ModelDescriptor, downloaded: boolean): Promise<ModelAvailabilityReport> {
    const checkpoint = await this.inspect(descriptor.checkpoint, 'checkpoint');
    const config = await this.inspect(descriptor.config, 'config');
    const problems: string[] = [];
    if (!checkpoint?.exists) problems.push(`Checkpoint fehlt: ${descriptor.checkpoint.file}`);
    if (checkpoint?.exists && checkpoint.hashVerifiable && !checkpoint.hashVerified) problems.push('Checkpoint-Hash stimmt nicht überein');
    if (descriptor.config && !config?.exists) problems.push(`Config fehlt: ${descriptor.config.file}`);
    if (checkpoint?.exists && checkpoint.expectedBytes && Math.abs(checkpoint.bytes - checkpoint.expectedBytes) > 1024) {
      problems.push(`Checkpoint-Größe ${checkpoint.bytes} != erwartet ${checkpoint.expectedBytes}`);
    }
    if (descriptor.modelHash === 'unverified') {
      problems.push('model_hash ist "unverified" – Integrität kann nicht geprüft werden');
    }
    const fatal = problems.filter((problem) => !problem.startsWith('model_hash'));
    return {
      modelId: descriptor.id,
      family: descriptor.family,
      version: descriptor.version,
      available: fatal.length === 0,
      hashVerified: Boolean(checkpoint?.hashVerified) || descriptor.modelHash === 'unverified' ? checkpoint?.hashVerified ?? false : false,
      reason: problems.length ? problems.join(' | ') : undefined,
      checkpoint,
      config,
      downloaded,
    };
  }

  /** Availability of every registered model – used by the CLI and the gate. */
  async listStatus(): Promise<ModelAvailabilityReport[]> {
    const reports: ModelAvailabilityReport[] = [];
    for (const descriptor of this.registry.list()) {
      reports.push(await this.verifyDescriptor(descriptor, false));
    }
    return reports;
  }

  /**
   * Writes a descriptor to the store as a *synthetic* checkpoint. Only used by
   * tests for the pipeline double; a real model file is never overwritten.
   */
  async installSynthetic(descriptor: ModelDescriptor, content: Record<string, unknown>): Promise<string> {
    if (descriptor.checkpoint.format !== 'synthetic') {
      throw new StemSeparationError('MODEL_INCOMPATIBLE', 'installSynthetic ist nur für synthetische Checkpoints erlaubt');
    }
    const target = this.resolvePath(descriptor.checkpoint);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(content, null, 2));
    return target;
  }

  /** Reads a synthetic checkpoint back (tests). */
  async readSynthetic(descriptor: ModelDescriptor): Promise<Record<string, unknown>> {
    const target = this.resolvePath(descriptor.checkpoint);
    return JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
  }
}
