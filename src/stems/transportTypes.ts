/**
 * IPC/HTTP contract, must stay node-free (no fs, path, etc.)
 */

export type StemProfile = 'PREVIEW' | 'HIGH_QUALITY' | 'MAXIMUM_QUALITY';
export type StemId = string;

export interface StemSeparationRequest {
  inputPath: string;
  modelId?: string;
  profile?: StemProfile;
  trackName?: string;
  chunkSizeSamples?: number;
  overlap?: number;
  numOverlap?: number;
  precision?: 'float32' | 'float16';
  extras?: Record<string, string | number | boolean>;
  jobId?: string;
}

export interface StemSeparationResponse {
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  stems: { id: StemId; filePath: string; sampleRate: number; channels: number; frames: number }[];
  metadata: {
    settings: {
      inputPath: string;
      modelId: string;
      profile: StemProfile;
      trackName: string;
    };
    job: {
      jobId: string;
      inputHash: string;
      modelHash: string;
      settingsHash: string;
      backend: string;
      cacheKey: string;
      cacheHit: boolean;
    };
  };
  validation: { fromTrainedModel: boolean; stemOrder: StemId[] };
  error?: { code: string; message: string };
}

export interface StemEngineStatus {
  available: boolean;
  models: { id: string; displayName: string; backend: string; trainedModel: boolean }[];
  bridgeLoaded: boolean;
  contentHash: string;
  error?: string;
}

export interface StemJobProgress {
  jobId: string;
  phase: string;
  percent?: number;
  detail?: string;
  chunkIndex?: number;
}

export interface StemDesktopApi {
  getStatus(): Promise<StemEngineStatus>;
  separate(request: StemSeparationRequest): Promise<StemSeparationResponse>;
  getJobStatus(jobId: string): Promise<{ status: string; jobId: string }>;
  cancelJob(jobId: string): Promise<{ cancelled: boolean; jobId: string }>;
  getJobProgress(): Promise<{ progress: number }>;
  install(opts?: { model?: string }): Promise<{ success: boolean; stdout: string }>;
  checkInstall(): Promise<{ modelDir: string; checkpointExists: boolean; checkpointPath: string; envSet: boolean }>;
  onInstallProgress(callback: (data: { phase: string; detail?: string }) => void): () => void;
  onJobProgress(callback: (data: StemJobProgress) => void): () => void;
}
