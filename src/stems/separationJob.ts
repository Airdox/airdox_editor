import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SeparationSummary } from './stemSeparationEngine';
export type SeparationJobStatus = 'QUEUED'|'RUNNING'|'COMPLETED'|'CANCELLED'|'FAILED';
export interface SeparationJobRecord { id: string; status: SeparationJobStatus; progress: number; createdAt: number; updatedAt: number; summary?: SeparationSummary; error?: { code: string; message: string }; }
export class SeparationJob {
  readonly path: string;
  constructor(readonly root: string, readonly id: string) { this.path = path.join(root, id, 'job.json'); }
  async update(patch: Partial<SeparationJobRecord>): Promise<SeparationJobRecord> { const current = await this.read() ?? { id: this.id, status: 'QUEUED' as SeparationJobStatus, progress: 0, createdAt: Date.now(), updatedAt: Date.now() }; const next = { ...current, ...patch, updatedAt: Date.now() }; await mkdir(path.dirname(this.path), { recursive: true }); await writeFile(this.path, JSON.stringify(next, null, 2)); return next; }
  async read(): Promise<SeparationJobRecord | undefined> { try { return JSON.parse(await readFile(this.path, 'utf8')) as SeparationJobRecord; } catch { return undefined; } }
}
