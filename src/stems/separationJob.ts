/**
 * SeparationJob – lifecycle, metadata and cancellation (§11, §15, §17).
 *
 * A job owns: the immutable settings, the progress state, the event trace, the
 * cancellation token and the on-disk metadata (`job.json`). Metadata is written
 * atomically so an interrupted run never leaves a half written job file that
 * looks completed.
 */
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  JOB_SCHEMA_VERSION,
  type JobStatus,
  type OriginalIntegrity,
  type ProgressCallback,
  type SeparationJobMetadata,
  type SeparationProgress,
  type QualityValidationReport,
  type SeparationSettings,
  type StemDescriptor,
} from './types';
import { SeparationCancellationToken } from './chunkProcessor';
import { hashSettings, buildCacheKey } from './separationCache';

export interface CreateJobOptions {
  inputPath: string;
  inputFormat: string;
  workingRoot: string;
  outputRoot: string;
  settings: SeparationSettings;
  onProgress?: ProgressCallback;
  token?: SeparationCancellationToken;
}

export class SeparationJob {
  readonly jobId: string;
  readonly settings: SeparationSettings;
  readonly settingsHash: string;
  readonly outputDir: string;
  readonly partialDir: string;
  readonly chunkDir: string;
  readonly metadataPath: string;
  readonly token: SeparationCancellationToken;
  private readonly onProgress?: ProgressCallback;
  private readonly startedAt = Date.now();

  status: JobStatus = 'PENDING';
  percent = 0;
  phase = 'Job erstellt';
  inputAudioHash = '';
  cacheKey = '';
  cacheHit = false;
  workingCopyPath = '';
  chunkCount = 0;
  chunkPlan: { index: number; startSample: number; endSample: number }[] = [];
  stems: StemDescriptor[] = [];
  validation?: QualityValidationReport;
  originalIntegrity?: OriginalIntegrity;
  events: { at: number; phase: string; detail?: string }[] = [];
  error?: { code: string; message: string };
  timings: { prepareMs?: number; inferenceMs?: number; reconstructMs?: number; validateMs?: number } = {};

  constructor(options: CreateJobOptions) {
    this.jobId = `job_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    this.settings = options.settings;
    this.settingsHash = hashSettings(options.settings);
    // §3 layout: Separation/<track>/{vocals.wav, drums.wav, job.json}
    this.outputDir = options.outputRoot;
    this.partialDir = path.join(this.outputDir, '.partial');
    this.chunkDir = path.join(options.workingRoot, '.chunks', this.jobId);
    this.metadataPath = path.join(this.outputDir, 'job.json');
    this.token = options.token ?? new SeparationCancellationToken();
    this.onProgress = options.onProgress;
    this.log('Job erstellt', options.inputPath);
  }

  log(phase: string, detail?: string): void {
    this.events.push({ at: Date.now(), phase, detail });
  }

  setStatus(status: JobStatus, phase?: string): void {
    this.status = status;
    if (phase) this.phase = phase;
    this.log(`status:${status}`, phase);
    this.emit();
  }

  report(percent: number, phase: string, extra: Partial<SeparationProgress> = {}): void {
    this.percent = Math.max(0, Math.min(100, percent));
    this.phase = phase;
    this.emit(extra);
  }

  private emit(extra: Partial<SeparationProgress> = {}): void {
    if (!this.onProgress) return;
    const totalSeconds = Number(extra.totalSeconds ?? 0);
    this.onProgress({
      jobId: this.jobId,
      status: this.status,
      percent: this.percent,
      phase: this.phase,
      processedSeconds: Number(extra.processedSeconds ?? (totalSeconds * this.percent) / 100),
      totalSeconds,
      chunkIndex: extra.chunkIndex,
      chunkCount: extra.chunkCount,
    });
  }

  cancel(reason = 'Abbruch durch Benutzer'): void {
    this.token.cancel(reason);
    this.log('cancel', reason);
  }

  pause(): void {
    this.token.pause();
    this.log('pause');
  }

  resume(): void {
    this.token.resume();
    this.log('resume');
  }

  get cacheKeyValue(): string {
    return this.cacheKey || buildCacheKey(this.inputAudioHash, this.settings.modelHash, this.settingsHash);
  }

  toMetadata(): SeparationJobMetadata {
    const finishedAt = this.status === 'COMPLETED' || this.status === 'FAILED' || this.status === 'CANCELLED' ? Date.now() : undefined;
    return {
      jobId: this.jobId,
      schemaVersion: JOB_SCHEMA_VERSION,
      status: this.status,
      inputPath: this.events.find((event) => event.phase === 'Job erstellt')?.detail ?? '',
      inputAudioHash: this.inputAudioHash,
      inputFormat: '',
      originalIntegrity: this.originalIntegrity ?? {
        path: '', sha256Before: this.inputAudioHash, sizeBefore: 0, mtimeMsBefore: 0, unchanged: true, checkedAt: this.startedAt,
      },
      workingCopyPath: this.workingCopyPath,
      settings: this.settings,
      settingsHash: this.settingsHash,
      cacheKey: this.cacheKeyValue,
      cacheHit: this.cacheHit,
      chunkCount: this.chunkCount,
      chunkPlan: this.chunkPlan,
      stems: this.status === 'COMPLETED' ? this.stems : [],
      validation: this.validation,
      timing: {
        startedAt: this.startedAt,
        finishedAt,
        prepareMs: this.timings.prepareMs,
        inferenceMs: this.timings.inferenceMs,
        reconstructMs: this.timings.reconstructMs,
        validateMs: this.timings.validateMs,
        totalMs: finishedAt ? finishedAt - this.startedAt : undefined,
      },
      events: this.events,
      error: this.error,
    };
  }

  /** Atomic write: `job.json.tmp` -> `job.json`. */
  async persist(extra: Partial<SeparationJobMetadata> = {}): Promise<string> {
    await mkdir(this.outputDir, { recursive: true });
    await mkdir(path.dirname(this.metadataPath), { recursive: true });
    const metadata = { ...this.toMetadata(), ...extra };
    const tmp = path.join(this.outputDir, 'job.json.tmp');
    await writeFile(tmp, JSON.stringify(metadata, null, 2));
    await rename(tmp, this.metadataPath);
    return this.metadataPath;
  }

  /** Removes partial output after cancel/failure (§17). */
  async discardPartial(): Promise<void> {
    await rm(this.partialDir, { recursive: true, force: true });
    await rm(this.chunkDir, { recursive: true, force: true });
  }

  fingerprint(): string {
    return createHash('sha256').update(`${this.jobId}:${this.settingsHash}:${this.inputAudioHash}`).digest('hex').slice(0, 16);
  }
}
