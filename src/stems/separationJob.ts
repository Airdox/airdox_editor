import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface SeparationJobRecord {
  jobId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'PAUSED';
  createdAt: number;
  updatedAt: number;
  inputPath: string;
  inputHash: string;
  modelId: string;
  modelHash: string;
  settingsHash: string;
  settings: Record<string, unknown>;
  backend: string;
  precision: string;
  extras?: Record<string, string | number | boolean>;
  outputRoot: string;
  stems: { id: string; filePath: string; sampleRate: number; channels: number; frames: number }[];
  events: { phase: string; detail?: string; at: number }[];
  error?: { code: string; message: string };
  cacheKey: string;
  historyArchived?: boolean;
}

export class SeparationJobStore {
  constructor(private readonly root: string) {}

  path(jobId: string): string {
    return path.join(this.root, jobId, 'job.json');
  }

  async write(record: SeparationJobRecord): Promise<SeparationJobRecord> {
    const jobDir = path.join(this.root, record.jobId);
    await mkdir(jobDir, { recursive: true });
    const next = { ...record, updatedAt: Date.now() };
    await writeFile(this.path(record.jobId), JSON.stringify(next, null, 2));
    return next;
  }

  async read(jobId: string): Promise<SeparationJobRecord | undefined> {
    try {
      const raw = await readFile(this.path(jobId), 'utf8');
      return JSON.parse(raw) as SeparationJobRecord;
    } catch {
      return undefined;
    }
  }

  async update(jobId: string, patch: Partial<SeparationJobRecord>): Promise<SeparationJobRecord | undefined> {
    const existing = await this.read(jobId);
    if (!existing) return undefined;
    const next = { ...existing, ...patch, updatedAt: Date.now() };
    await writeFile(this.path(jobId), JSON.stringify(next, null, 2));
    return next;
  }

  async archive(jobId: string, archiveRoot: string): Promise<string> {
    const record = await this.read(jobId);
    if (!record) throw new Error(`Job not found: ${jobId}`);
    const archiveDir = path.join(archiveRoot, jobId);
    await mkdir(archiveDir, { recursive: true });
    const dest = path.join(archiveDir, 'job.json');
    await writeFile(dest, JSON.stringify({ ...record, historyArchived: true }, null, 2));
    await this.update(jobId, { historyArchived: true });
    return dest;
  }
}
