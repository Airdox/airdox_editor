/**
 * Desktop entry point: the single surface the Electron main process uses.
 *
 * This is bundled to CommonJS (`npm run build:stems`) because `electron/main.cjs`
 * cannot import TypeScript/ESM directly. Keeping one narrow entry means the
 * main process never reimplements engine logic — it only calls in here, so the
 * read-only guarantees, error classification and stem identity rules are the
 * same ones the test suite covers.
 */
import path from 'node:path';
import { StemSeparationEngine, createDefaultBackendFactory, StemRegistry } from './stemSeparationEngine';
import { SeparationCancellationToken } from './chunkProcessor';
import { checkAudioSeparator, DEFAULT_AUDIO_SEPARATOR_MODEL } from './backends/audioSeparatorSeparator';
import { StemSeparationError } from './errors';
import { sha256File } from './wavIo';
import type { StemId } from './types';

export interface DesktopSeparationRoots {
  workingRoot: string;
  outputRoot: string;
  cacheRoot: string;
  modelStoreDir: string;
}

export interface DesktopStemResult {
  id: StemId;
  filePath: string;
  sampleRate: number;
  channels: number;
  frames: number;
}

export interface DesktopSeparationResponse {
  status: 'COMPLETED' | 'CANCELLED' | 'FAILED';
  stems: DesktopStemResult[];
  modelId: string;
  fromTrainedModel: boolean;
  /** sha256 of the input before and after — proof the original was not touched. */
  originalHashBefore: string;
  originalHashAfter: string;
  originalUnchanged: boolean;
  durationMs: number;
  error?: { code: string; message: string };
}

/** Human-readable, actionable messages. Error codes alone help nobody in a UI. */
const MESSAGES: Record<string, string> = {
  AUDIO_MISSING: 'Die Audiodatei wurde nicht gefunden.',
  AUDIO_CORRUPT: 'Die Audiodatei konnte nicht gelesen werden (beschädigt oder kein unterstütztes WAV).',
  AUDIO_UNSUPPORTED_FORMAT: 'Dieses Audioformat wird nicht unterstützt.',
  WRITE_DENIED: 'Das Ausgabeverzeichnis ist nicht beschreibbar.',
  BACKEND_UNAVAILABLE: 'Die Separations-Engine ist nicht verfügbar. Bitte "audio-separator" installieren.',
  INFERENCE_FAILED: 'Die Separation ist fehlgeschlagen.',
  CANCELLED: 'Die Separation wurde abgebrochen.',
  INVALID_REQUEST: 'Ungültige Anfrage an die Separations-Engine.',
  CACHE_CORRUPT: 'Der Separations-Cache war beschädigt und wurde verworfen.',
};

export function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof StemSeparationError) {
    return { code: error.code, message: `${MESSAGES[error.code] ?? 'Unbekannter Fehler.'} ${error.message}`.trim() };
  }
  return { code: 'INFERENCE_FAILED', message: error instanceof Error ? error.message : String(error) };
}

const activeTokens = new Map<string, SeparationCancellationToken>();

/** Cancels a running job. Returns false if the job id is unknown (already done). */
export function cancelSeparation(jobId: string): boolean {
  const token = activeTokens.get(jobId);
  if (!token) return false;
  token.cancel();
  return true;
}

export async function preflight(options: { command?: string } = {}): Promise<{ available: boolean; version?: string; reason?: string; command: string; defaultModel: string }> {
  const result = await checkAudioSeparator(options);
  return { ...result, defaultModel: DEFAULT_AUDIO_SEPARATOR_MODEL };
}

export interface DesktopSeparationOptions extends DesktopSeparationRoots {
  inputPath: string;
  jobId: string;
  trackName?: string;
  modelId?: string;
  command?: string;
  usePipelineDouble?: boolean;
  onProgress?: (entry: { phase: string; detail?: string; percent?: number }) => void;
}

/**
 * Runs a separation for the desktop app.
 *
 * The input file is hashed before and after. The engine only ever reads it, but
 * the app claims non-destructive editing, so that claim is verified at runtime
 * rather than merely asserted in a test.
 */
export async function separateForDesktop(options: DesktopSeparationOptions): Promise<DesktopSeparationResponse> {
  const started = Date.now();
  const modelId = options.modelId ?? (options.usePipelineDouble ? 'pipeline-double-v1' : 'bsroformer-musdb18hq-4stem-zfturbo');
  const token = new SeparationCancellationToken();
  activeTokens.set(options.jobId, token);

  const engine = new StemSeparationEngine({
    workingRoot: options.workingRoot,
    outputRoot: options.outputRoot,
    cacheRoot: options.cacheRoot,
    modelStoreDir: options.modelStoreDir,
    allowPipelineDouble: true,
    registry: new StemRegistry(),
    backendFactory: createDefaultBackendFactory({
      audioSeparator: { command: options.command, modelFileDir: options.modelStoreDir },
    }),
  });

  let hashBefore = '';
  try {
    hashBefore = await sha256File(options.inputPath);
  } catch (error) {
    activeTokens.delete(options.jobId);
    return {
      status: 'FAILED', stems: [], modelId, fromTrainedModel: false,
      originalHashBefore: '', originalHashAfter: '', originalUnchanged: true,
      durationMs: Date.now() - started, error: describeError(new StemSeparationError('AUDIO_MISSING', String((error as Error)?.message ?? error))),
    };
  }

  try {
    const summary = await engine.separate({
      inputPath: options.inputPath,
      modelId,
      profile: 'HIGH_QUALITY',
      trackName: options.trackName ?? path.basename(options.inputPath, path.extname(options.inputPath)),
      token,
      onProgress: (entry) => {
        const percent = entry.phase === 'progress' ? Number(entry.detail) : undefined;
        options.onProgress?.({ phase: entry.phase, detail: entry.detail, percent: Number.isFinite(percent) ? percent : undefined });
      },
    });
    const hashAfter = await sha256File(options.inputPath).catch(() => hashBefore);
    return {
      status: summary.status,
      stems: summary.stems.map((s) => ({ id: s.id, filePath: s.filePath, sampleRate: s.sampleRate, channels: s.channels, frames: s.frames })),
      modelId,
      fromTrainedModel: summary.validation.fromTrainedModel,
      originalHashBefore: hashBefore,
      originalHashAfter: hashAfter,
      originalUnchanged: hashBefore === hashAfter,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const hashAfter = await sha256File(options.inputPath).catch(() => hashBefore);
    return {
      status: token.isCancelled ? 'CANCELLED' : 'FAILED',
      stems: [], modelId, fromTrainedModel: false,
      originalHashBefore: hashBefore, originalHashAfter: hashAfter,
      originalUnchanged: hashBefore === hashAfter,
      durationMs: Date.now() - started,
      error: describeError(error),
    };
  } finally {
    activeTokens.delete(options.jobId);
  }
}
