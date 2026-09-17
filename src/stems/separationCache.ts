import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './wavIo';
export interface SeparationCacheKeyInput { inputPath: string; inputHash?: string; modelId: string; profile?: string; settings?: unknown; }
export interface SeparationCacheEntry<T = unknown> { key: string; createdAt: number; value: T; }
export class SeparationCache {
  constructor(readonly root: string) {}
  async key(input: SeparationCacheKeyInput): Promise<string> { const hash = input.inputHash ?? await sha256File(input.inputPath); return createHash('sha256').update(JSON.stringify({ ...input, inputHash: hash })).digest('hex'); }
  async get<T>(key: string): Promise<SeparationCacheEntry<T> | undefined> { try { return JSON.parse(await readFile(path.join(this.root, `${key}.json`), 'utf8')) as SeparationCacheEntry<T>; } catch { return undefined; } }
  async put<T>(key: string, value: T): Promise<void> { await mkdir(this.root, { recursive: true }); await writeFile(path.join(this.root, `${key}.json`), JSON.stringify({ key, createdAt: Date.now(), value })); }
  async invalidate(key?: string): Promise<void> { if (key) await rm(path.join(this.root, `${key}.json`), { force: true }); else await rm(this.root, { recursive: true, force: true }); }
  async has(key: string): Promise<boolean> { try { await access(path.join(this.root, `${key}.json`)); return true; } catch { return false; } }
}
