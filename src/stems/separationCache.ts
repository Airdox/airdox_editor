/**
 * SeparationCache (§12).
 *
 * Key: `input_audio_hash : model_hash : settings_hash`. A cache entry is only
 * reused when the stored stem files still exist AND their sha256 still matches
 * the recorded value. A corrupt entry is invalidated and reported – it never
 * produces a half trusted result, and the original audio is never involved.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { StemSeparationError } from './errors';
import { sha256File } from './wavIo';
import type { SeparationJobMetadata, SeparationSettings, StemDescriptor } from './types';

/** Canonical, order independent hash of the settings that influence the result. */
export function hashSettings(settings: SeparationSettings): string {
  const canonical = JSON.stringify({
    profile: settings.profile,
    modelId: settings.modelId,
    modelVersion: settings.modelVersion,
    modelHash: settings.modelHash,
    family: settings.family,
    backend: settings.backend,
    precision: settings.precision,
    device: settings.device,
    sampleRate: settings.sampleRate,
    channels: settings.channels,
    chunkSizeSamples: settings.chunkSizeSamples,
    chunkOverlap: settings.chunkOverlap,
    numOverlap: settings.numOverlap,
    ensemblePasses: settings.ensemblePasses,
    clipMode: settings.clipMode,
    dcRemoval: settings.dcRemoval,
    stems: [...settings.stems].sort(),
    extras: Object.fromEntries(Object.entries(settings.extras ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildCacheKey(inputAudioHash: string, modelHash: string, settingsHash: string): string {
  return `${inputAudioHash}:${modelHash}:${settingsHash}`;
}

export interface CacheLookupResult {
  hit: boolean;
  key: string;
  reason?: string;
  metadata?: SeparationJobMetadata;
  /** Stem files inside the cache directory. */
  stems?: StemDescriptor[];
}

export class SeparationCache {
  constructor(private readonly root: string) {}

  get rootDir(): string {
    return this.root;
  }

  /** Directory of one cache entry (diagnostics, cache corruption tests). */
  entryDirectory(key: string): string {
    return this.entryDir(key);
  }

  private entryDir(key: string): string {
    const safe = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return path.join(this.root, safe);
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** Reads and verifies an entry. Corrupt entries are deleted and reported. */
  async lookup(key: string): Promise<CacheLookupResult> {
    const dir = this.entryDir(key);
    let raw: string;
    try {
      raw = await readFile(path.join(dir, 'job.json'), 'utf8');
    } catch {
      return { hit: false, key, reason: 'kein Cache-Eintrag' };
    }
    let metadata: SeparationJobMetadata;
    try {
      metadata = JSON.parse(raw) as SeparationJobMetadata;
    } catch {
      await rm(dir, { recursive: true, force: true });
      return { hit: false, key, reason: 'CACHE_CORRUPT: job.json ist kein gültiges JSON' };
    }
    if (metadata.status !== 'COMPLETED') {
      await rm(dir, { recursive: true, force: true });
      return { hit: false, key, reason: `CACHE_CORRUPT: Eintrag hat Status ${metadata.status}` };
    }
    const verified: StemDescriptor[] = [];
    for (const stem of metadata.stems ?? []) {
      const cached = path.join(dir, 'stems', path.basename(stem.filePath));
      try {
        const info = await stat(cached);
        const hash = await sha256File(cached);
        if (hash !== stem.sha256 || info.size !== stem.bytes) {
          await rm(dir, { recursive: true, force: true });
          return { hit: false, key, reason: `CACHE_CORRUPT: Stem ${stem.id} weicht vom gespeicherten Hash ab` };
        }
        verified.push({ ...stem, filePath: cached });
      } catch {
        await rm(dir, { recursive: true, force: true });
        return { hit: false, key, reason: `CACHE_CORRUPT: Stem ${stem.id} fehlt im Cache` };
      }
    }
    if (verified.length === 0) {
      await rm(dir, { recursive: true, force: true });
      return { hit: false, key, reason: 'CACHE_CORRUPT: Eintrag enthält keine Stems' };
    }
    return { hit: true, key, metadata, stems: verified };
  }

  /** Stores a completed job: stem files are copied, then `job.json` is written. */
  async store(key: string, metadata: SeparationJobMetadata, stemFiles: { stem: StemDescriptor; filePath: string }[]): Promise<string> {
    const dir = this.entryDir(key);
    const stemDir = path.join(dir, 'stems');
    await mkdir(stemDir, { recursive: true });
    const stored: StemDescriptor[] = [];
    for (const { stem, filePath } of stemFiles) {
      const target = path.join(stemDir, path.basename(filePath));
      await copyFile(filePath, target);
      const hash = await sha256File(target);
      if (hash !== stem.sha256) {
        throw new StemSeparationError('CACHE_CORRUPT', `Cache-Kopie von ${stem.id} weicht vom Quell-Hash ab`, { stem: stem.id });
      }
      stored.push({ ...stem, filePath: target });
    }
    const cachedMetadata: SeparationJobMetadata = { ...metadata, stems: stored, cacheKey: key, cacheHit: false };
    const tmp = path.join(dir, 'job.json.tmp');
    await writeFile(tmp, JSON.stringify(cachedMetadata, null, 2));
    await writeFile(path.join(dir, 'job.json'), JSON.stringify(cachedMetadata, null, 2));
    await rm(tmp, { force: true });
    return dir;
  }

  /** Copies cached stems into the job directory and returns the new paths. */
  async materialise(key: string, targetDir: string): Promise<StemDescriptor[]> {
    const entry = await this.lookup(key);
    if (!entry.hit || !entry.stems) {
      throw new StemSeparationError('CACHE_CORRUPT', `Cache-Eintrag ist nicht mehr gültig: ${entry.reason}`);
    }
    await mkdir(targetDir, { recursive: true });
    const result: StemDescriptor[] = [];
    for (const stem of entry.stems) {
      const target = path.join(targetDir, `${stem.id}.wav`);
      await copyFile(stem.filePath, target);
      const hash = await sha256File(target);
      if (hash !== stem.sha256) {
        throw new StemSeparationError('CACHE_CORRUPT', `Materialisierter Stem ${stem.id} ist beschädigt`);
      }
      result.push({ ...stem, filePath: target });
    }
    return result;
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
  }

  /** Diagnostic listing used by the quality gate report. */
  async entries(): Promise<{ key: string; dir: string; stems: number }[]> {
    let dirs: string[];
    try {
      dirs = await readdir(this.root);
    } catch {
      return [];
    }
    const out: { key: string; dir: string; stems: number }[] = [];
    for (const dir of dirs) {
      try {
        const raw = await readFile(path.join(this.root, dir, 'job.json'), 'utf8');
        const metadata = JSON.parse(raw) as SeparationJobMetadata;
        out.push({ key: metadata.cacheKey, dir: path.join(this.root, dir), stems: metadata.stems?.length ?? 0 });
      } catch {
        out.push({ key: '<corrupt>', dir: path.join(this.root, dir), stems: 0 });
      }
    }
    return out;
  }
}
