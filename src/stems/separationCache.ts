import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { StemSeparationError } from './errors';

export interface CacheEntry {
  key: string;
  inputHash: string;
  modelHash: string;
  settingsHash: string;
  createdAt: number;
  stems: { id: string; filePath: string }[];
  metadata: Record<string, unknown>;
}

export function buildCacheKey(inputHash: string, modelHash: string, settingsHash: string): string {
  return `${inputHash}:${modelHash}:${settingsHash}`;
}

export function hashSettings(settings: Record<string, unknown>): string {
  const canonical = JSON.stringify(settings, Object.keys(settings).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function hashModelId(modelId: string, modelCatalogHash?: string): string {
  return createHash('sha256').update(`${modelId}:${modelCatalogHash ?? ''}`).digest('hex').slice(0, 16);
}

export class SeparationCache {
  constructor(private readonly cacheRoot: string) {}

  private entryPath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 120);
    return path.join(this.cacheRoot, `${safe}.json`);
  }

  private stemsDir(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 120);
    return path.join(this.cacheRoot, `${safe}_stems`);
  }

  async get(key: string): Promise<CacheEntry | null> {
    try {
      const raw = await readFile(this.entryPath(key), 'utf8');
      const entry = JSON.parse(raw) as CacheEntry;
      if (!entry || entry.key !== key) throw new StemSeparationError('CACHE_CORRUPT', `Cache key mismatch`);
      // Validate stems exist
      for (const stem of entry.stems) {
        await stat(stem.filePath);
      }
      return entry;
    } catch (e) {
      if (e instanceof StemSeparationError && e.code === 'CACHE_CORRUPT') throw e;
      // If file not found, miss
      if ((e as { code?: string }).code === 'ENOENT') return null;
      // Corrupt JSON or missing stem
      try {
        await rm(this.entryPath(key), { force: true });
      } catch {}
      throw new StemSeparationError('CACHE_CORRUPT', `Cache corrupt for key ${key}: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  async set(entry: CacheEntry): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true });
    await writeFile(this.entryPath(entry.key), JSON.stringify(entry, null, 2));
  }

  async invalidate(key: string): Promise<void> {
    await rm(this.entryPath(key), { force: true });
    await rm(this.stemsDir(key), { recursive: true, force: true });
  }

  async clear(): Promise<void> {
    const { readdir } = await import('node:fs/promises');
    try {
      const files = await readdir(this.cacheRoot);
      for (const f of files) {
        await rm(path.join(this.cacheRoot, f), { recursive: true, force: true });
      }
    } catch {}
  }
}
