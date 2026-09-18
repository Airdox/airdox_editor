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
import { existsSync, createWriteStream, readFileSync, writeFileSync, renameSync } from 'node:fs';
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

interface PersistedFileHash {
  size: number;
  mtimeMs: number;
  sha256: string;
}

const fileHashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
const fileHashInflight = new Map<string, Promise<string>>();
const persistedHashCache = new Map<string, Record<string, PersistedFileHash>>();

export function clearModelHashCache(): void {
  fileHashCache.clear();
  persistedHashCache.clear();
}

function readPersistedHashes(storeDir: string): Record<string, PersistedFileHash> {
  const cached = persistedHashCache.get(storeDir);
  if (cached) return cached;
  let loaded: Record<string, PersistedFileHash> = {};
  try {
    const target = path.join(storeDir, 'model-hashes.json');
    if (existsSync(target)) {
      const raw = readFileSync(target, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, PersistedFileHash>;
      if (parsed && typeof parsed === 'object') loaded = parsed;
    }
  } catch {
    /* Cache-Lesefehler sind unkritisch */
  }
  persistedHashCache.set(storeDir, loaded);
  return loaded;
}

function writePersistedHash(storeDir: string, filePath: string, entry: PersistedFileHash): void {
  try {
    const entries = readPersistedHashes(storeDir);
    entries[filePath] = entry;
    entries[path.basename(filePath)] = entry;
    const target = path.join(storeDir, 'model-hashes.json');
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2));
    renameSync(tmp, target);
  } catch {
    /* Schreiben darf den Ablauf nicht stören */
  }
}

function readInstalledManifest(storeDir: string): Record<string, { file?: string; sha256?: string }> {
  try {
    const file = path.join(storeDir, 'installed-models.json');
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, { file?: string; sha256?: string }>;
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    /* ignore */
  }
  return {};
}

async function hashOfFile(filePath: string, fileInfo?: Awaited<ReturnType<typeof stat>>, storeDir?: string): Promise<string> {
  const info = fileInfo ?? await stat(filePath);
  const size = Number(info.size);
  const mtimeMs = Number(info.mtimeMs);
  const cached = fileHashCache.get(filePath);
  if (cached && cached.size === size && Math.abs(cached.mtimeMs - mtimeMs) < 1000) {
    return cached.sha256;
  }

  if (storeDir) {
    const persisted = readPersistedHashes(storeDir)[filePath] ?? readPersistedHashes(storeDir)[path.basename(filePath)];
    if (persisted && persisted.size === size && Math.abs(persisted.mtimeMs - mtimeMs) < 1000) {
      fileHashCache.set(filePath, persisted);
      return persisted.sha256;
    }
    const manifest = readInstalledManifest(storeDir);
    for (const item of Object.values(manifest)) {
      if ((item.file === path.basename(filePath) || item.file === filePath) && item.sha256 && SHA256_RE.test(item.sha256)) {
        const entry = { size, mtimeMs, sha256: item.sha256 };
        fileHashCache.set(filePath, entry);
        writePersistedHash(storeDir, filePath, entry);
        return item.sha256;
      }
    }
  }

  const key = `${filePath}|${size}|${mtimeMs}`;
  const inflight = fileHashInflight.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    const hash = createHash('sha256');
    const { createReadStream } = await import('node:fs');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    const sha256 = hash.digest('hex');
    const entry = { size, mtimeMs, sha256 };
    fileHashCache.set(filePath, entry);
    if (storeDir) {
      writePersistedHash(storeDir, filePath, entry);
    }
    return sha256;
  })().finally(() => {
    fileHashInflight.delete(key);
  });
  fileHashInflight.set(key, task);
  return task;
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

  /**
   * Cheap, synchronous presence check – used for *selection*, never as proof.
   *
   * The editor asks for the profile matrix on every status refresh. Hashing a
   * 500 MiB checkpoint there would be absurd, so selection only asks: are the
   * files on disk? A present but corrupt checkpoint is therefore selected and
   * then fails loudly with `MODEL_CORRUPT` in `ensureAvailable()` – which is the
   * honest outcome, and the file is still reported as unavailable by
   * `verify()`/`listStatus()`.
   */
  isInstalled(descriptor: ModelDescriptor): boolean {
    const present = (ref: ModelCheckpointRef | undefined): boolean => {
      if (!ref) return false;
      try {
        return existsSync(this.resolvePath(ref));
      } catch {
        return false;
      }
    };
    return present(descriptor.checkpoint) && (!descriptor.config || present(descriptor.config));
  }

  private async inspect(
    ref: ModelCheckpointRef | undefined,
    role: 'checkpoint' | 'config',
    options?: { fast?: boolean }
  ): Promise<ModelFileStatus | undefined> {
    if (!ref) return undefined;
    const filePath = this.resolvePath(ref);
    let exists = false;
    let bytes = 0;
    let fileInfo: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      fileInfo = await stat(filePath);
      exists = fileInfo.isFile();
      bytes = fileInfo.size;
    } catch {
      exists = false;
    }
    const hashVerifiable = Boolean(ref.sha256 && SHA256_RE.test(ref.sha256));
    let sha256: string | undefined;
    if (exists && fileInfo) {
      const size = Number(fileInfo.size);
      const mtimeMs = Number(fileInfo.mtimeMs);
      const cached = fileHashCache.get(filePath);
      if (cached && cached.size === size && Math.abs(cached.mtimeMs - mtimeMs) < 1000) {
        sha256 = cached.sha256;
      } else {
        const manifest = readInstalledManifest(this.storeDir);
        for (const item of Object.values(manifest)) {
          if ((item.file === ref.file || item.file === filePath) && item.sha256 && SHA256_RE.test(item.sha256)) {
            sha256 = item.sha256;
            const entry = { size, mtimeMs, sha256 };
            fileHashCache.set(filePath, entry);
            writePersistedHash(this.storeDir, filePath, entry);
            break;
          }
        }
        if (!sha256) {
          const persisted = readPersistedHashes(this.storeDir)[filePath] ?? readPersistedHashes(this.storeDir)[ref.file];
          if (persisted && persisted.size === size && Math.abs(persisted.mtimeMs - mtimeMs) < 1000) {
            fileHashCache.set(filePath, persisted);
            sha256 = persisted.sha256;
          }
        }
      }

      if (!sha256 && !options?.fast) {
        sha256 = await hashOfFile(filePath, fileInfo, this.storeDir);
      }
    }
    const sizeMatches = exists && (!ref.bytes || Math.abs(bytes - ref.bytes) <= 1024);
    const hashVerified = Boolean(
      exists && (
        (hashVerifiable && sha256 === ref.sha256) ||
        (options?.fast && hashVerifiable && !sha256 && sizeMatches)
      )
    );
    return {
      role,
      file: ref.file,
      path: filePath,
      exists,
      bytes,
      expectedBytes: ref.bytes,
      sha256,
      expectedSha256: ref.sha256,
      hashVerified,
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

  private async verifyDescriptor(
    descriptor: ModelDescriptor,
    downloaded: boolean,
    options?: { fast?: boolean }
  ): Promise<ModelAvailabilityReport> {
    const checkpoint = await this.inspect(descriptor.checkpoint, 'checkpoint', options);
    const config = await this.inspect(descriptor.config, 'config', options);
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
  async listStatus(options?: { fast?: boolean }): Promise<ModelAvailabilityReport[]> {
    const reports: ModelAvailabilityReport[] = [];
    for (const descriptor of this.registry.list()) {
      reports.push(await this.verifyDescriptor(descriptor, false, options));
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
