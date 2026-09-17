/**
 * Editor-facing job service, status mapping, staging renderer bytes
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { StemSeparationEngine, type SeparationRequest } from './stemSeparationEngine';
import { SeparationCancellationToken } from './chunkProcessor';
import type { StemProfile } from './types';
import { getModelCatalog } from './modelRegistry';
import { PipelineDoubleSeparator } from './backends/pipelineDoubleSeparator';
import { BSRoFormerSeparator } from './backends/roformerSeparator';
import { HTDemucsSeparator } from './backends/htDemucsSeparator';

export interface JobServiceOptions {
  workingRoot: string;
  outputRoot: string;
  cacheRoot?: string;
  modelStoreDir?: string;
  historyRoot?: string;
  allowPipelineDouble?: boolean;
}

export interface JobProgress {
  jobId: string;
  phase: string;
  percent?: number;
  detail?: string;
  chunkIndex?: number;
}

export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'PAUSED';

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  progress: number;
  request: SeparationRequest;
  result?: Awaited<ReturnType<StemSeparationEngine['separate']>>;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
}

export class StemJobService {
  private readonly engine: StemSeparationEngine;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly tokens = new Map<string, SeparationCancellationToken>();
  private readonly progressListeners = new Set<(p: JobProgress) => void>();

  constructor(private readonly options: JobServiceOptions) {
    this.engine = new StemSeparationEngine({
      workingRoot: options.workingRoot,
      outputRoot: options.outputRoot,
      cacheRoot: options.cacheRoot,
      modelStoreDir: options.modelStoreDir,
      historyRoot: options.historyRoot,
      allowPipelineDouble: options.allowPipelineDouble ?? true,
      backendFactory: (model, req) => {
        const catalog = getModelCatalog();
        const entry = catalog.models.find(m => m.id === model.id);
        const backendType = entry?.backend || 'pipeline-double';
        if (backendType === 'bsroformer') {
          return new BSRoFormerSeparator({ stemOrder: model.stemOrder, fallback: new PipelineDoubleSeparator({ stemOrder: model.stemOrder }) });
        }
        if (backendType === 'htdemucs') {
          return new HTDemucsSeparator({ stemOrder: model.stemOrder, fallback: new PipelineDoubleSeparator({ stemOrder: model.stemOrder }) });
        }
        return new PipelineDoubleSeparator({ stemOrder: model.stemOrder });
      },
    });
  }

  onProgress(callback: (p: JobProgress) => void): () => void {
    this.progressListeners.add(callback);
    return () => this.progressListeners.delete(callback);
  }

  private emitProgress(p: JobProgress) {
    for (const cb of this.progressListeners) {
      try { cb(p); } catch {}
    }
  }

  async stageRendererBytes(bytes: Uint8Array, fileName: string): Promise<string> {
    const jobId = randomUUID();
    const dir = path.join(this.options.workingRoot, 'staging', jobId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, fileName.replace(/[^a-zA-Z0-9_.-]/g, '_'));
    await writeFile(filePath, bytes);
    return filePath;
  }

  async createJob(request: Omit<SeparationRequest, 'token' | 'onProgress' | 'jobId'>): Promise<JobRecord> {
    const jobId = randomUUID();
    const token = new SeparationCancellationToken();
    this.tokens.set(jobId, token);

    const record: JobRecord = {
      jobId,
      status: 'PENDING',
      progress: 0,
      request: { ...request, jobId, token } as SeparationRequest,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(jobId, record);

    // Start async
    this.runJob(jobId, token).catch((e) => {
      const rec = this.jobs.get(jobId);
      if (rec) {
        rec.status = 'FAILED';
        rec.error = { code: e.code || 'UNKNOWN', message: e.message };
        rec.updatedAt = Date.now();
      }
    });

    return record;
  }

  private async runJob(jobId: string, token: SeparationCancellationToken) {
    const record = this.jobs.get(jobId);
    if (!record) return;
    record.status = 'RUNNING';
    record.updatedAt = Date.now();
    this.emitProgress({ jobId, phase: 'start', percent: 0 });

    try {
      const result = await this.engine.separate({
        ...record.request,
        jobId,
        token,
        onProgress: (entry) => {
          this.emitProgress({ jobId, phase: entry.phase, detail: entry.detail, chunkIndex: entry.chunkIndex });
          if (entry.phase === 'chunk-start' && record) {
            // Estimate progress
            record.progress = Math.min(90, record.progress + 5);
          }
        },
      });

      record.result = result;
      record.status = result.status === 'COMPLETED' ? 'COMPLETED' : result.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
      record.progress = record.status === 'COMPLETED' ? 100 : record.progress;
      record.updatedAt = Date.now();
      this.emitProgress({ jobId, phase: 'done', percent: 100 });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (token.isCancelled || err.code === 'CANCELLED') {
        record.status = 'CANCELLED';
      } else {
        record.status = 'FAILED';
        record.error = { code: err.code || 'UNKNOWN', message: err.message || String(e) };
      }
      record.updatedAt = Date.now();
      this.emitProgress({ jobId, phase: 'error', detail: err.message });
      throw e;
    } finally {
      this.tokens.delete(jobId);
    }
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  listJobs(): JobRecord[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  cancelJob(jobId: string): boolean {
    const token = this.tokens.get(jobId);
    if (token) {
      token.cancel();
      return true;
    }
    return false;
  }

  pauseJob(jobId: string): boolean {
    const token = this.tokens.get(jobId);
    if (token) {
      token.pause();
      const rec = this.jobs.get(jobId);
      if (rec) rec.status = 'PAUSED';
      return true;
    }
    return false;
  }

  resumeJob(jobId: string): boolean {
    const token = this.tokens.get(jobId);
    if (token) {
      token.resume();
      const rec = this.jobs.get(jobId);
      if (rec) rec.status = 'RUNNING';
      return true;
    }
    return false;
  }

  mapStatus(status: JobStatus): 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' {
    switch (status) {
      case 'PENDING': return 'pending';
      case 'RUNNING': return 'running';
      case 'COMPLETED': return 'completed';
      case 'FAILED': return 'failed';
      case 'CANCELLED': return 'cancelled';
      case 'PAUSED': return 'paused';
      default: return 'pending';
    }
  }
}
