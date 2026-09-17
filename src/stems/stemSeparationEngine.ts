import { access, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { SeparationCancellationToken } from './chunkProcessor';
import { StemSeparationError, asStemSeparationError } from './errors';
import { readWavFile } from './wavIo';
import type { StemId, StemProfile, StemDescriptor } from './types';
import type { BackendSeparationResult, IStemSeparator } from './backends/types';
import { PipelineDoubleSeparator } from './backends/pipelineDoubleSeparator';
import { AudioSeparatorSeparator, type AudioSeparatorOptions } from './backends/audioSeparatorSeparator';
export interface SeparationRequest { inputPath: string; modelId?: string; profile?: StemProfile; trackName?: string; chunkSizeSamples?: number; overlap?: number; token?: SeparationCancellationToken; onProgress?: (entry: { chunkIndex?: number; phase: string; detail?: string }) => void; extras?: Record<string, string | number | boolean>; }
export interface SeparationStem { id: StemId; filePath: string; sampleRate: number; channels: number; frames: number; }
export interface SeparationMetadata { settings: { inputPath: string; modelId: string; profile: StemProfile; trackName: string; extras?: Record<string, string | number | boolean> }; events: { phase: string; detail?: string }[]; }
export interface SeparationSummary { status: 'COMPLETED' | 'CANCELLED' | 'FAILED'; stems: SeparationStem[]; metadata: SeparationMetadata; validation: { fromTrainedModel: boolean; stemOrder: StemId[] }; error?: { code: string; message: string }; }
export interface StemModelDescriptor extends StemDescriptor { id: string; stemOrder: StemId[]; trainedModel: boolean; }
export class StemRegistry { private readonly models = new Map<string, StemModelDescriptor>(); constructor() { this.register({ id: 'bsroformer-musdb18hq-4stem-zfturbo', stemOrder: ['vocals', 'drums', 'bass', 'other'], trainedModel: true }); this.register({ id: 'pipeline-double-v1', stemOrder: ['vocals', 'drums', 'bass', 'other'], trainedModel: false }); } register(model: StemModelDescriptor): void { this.models.set(model.id, model); } get(id: string): StemModelDescriptor | undefined { return this.models.get(id); } list(): StemModelDescriptor[] { return [...this.models.values()]; } }
export interface StemEngineOptions { workingRoot: string; outputRoot: string; cacheRoot?: string; modelStoreDir?: string; allowPipelineDouble?: boolean; backendFactory?: (model: StemModelDescriptor, request: SeparationRequest) => IStemSeparator; registry?: StemRegistry; }
export class StemSeparationEngine {
  readonly registry: StemRegistry;
  private readonly options: StemEngineOptions;
  constructor(options: StemEngineOptions) { this.options = options; this.registry = options.registry ?? new StemRegistry(); }
  async separate(request: SeparationRequest): Promise<SeparationSummary> {
    const modelId = request.modelId ?? (request.profile === 'PREVIEW' ? 'pipeline-double-v1' : 'bsroformer-musdb18hq-4stem-zfturbo'); const model = this.registry.get(modelId);
    if (!model) throw new StemSeparationError('INVALID_REQUEST', `Unbekanntes Modell: ${modelId}`);
    if (!(this.options.allowPipelineDouble ?? false) && modelId === 'pipeline-double-v1') throw new StemSeparationError('BACKEND_UNAVAILABLE', 'Pipeline-Double ist für diese Engine deaktiviert');
    try { await access(request.inputPath); } catch (e) { throw new StemSeparationError('AUDIO_MISSING', `Audiodatei fehlt: ${request.inputPath}`, e); }
    let audio; try { audio = await readWavFile(request.inputPath); if (!audio.frames || !audio.data.length) throw new Error('leere Audiodatei'); } catch (e) { throw new StemSeparationError('AUDIO_CORRUPT', `Audiodatei ist nicht lesbar: ${request.inputPath}`, e); }
    await mkdir(this.options.workingRoot, { recursive: true });
    await this.ensureWritableRoot(this.options.outputRoot);
    const token = request.token; token?.throwIfCancelled(); const trackName = (request.trackName ?? path.basename(request.inputPath, path.extname(request.inputPath))).replace(/[^a-zA-Z0-9_.-]/g, '_'); const outputRoot = path.join(this.options.outputRoot, trackName);
    await mkdir(outputRoot, { recursive: true });
    const backend = this.options.backendFactory?.(model, request) ?? new PipelineDoubleSeparator({ stemOrder: model.stemOrder });
    let result: BackendSeparationResult;
    try { result = await backend.separate({ inputPath: request.inputPath, outputRoot, stemOrder: model.stemOrder, sampleRate: audio.sampleRate, channels: audio.channels, token, onProgress: request.onProgress, extras: request.extras }); }
    catch (error) { if (token?.isCancelled || (error instanceof Error && /cancel/i.test(error.message))) return { status: 'CANCELLED', stems: [], metadata: this.metadata(request, modelId, trackName, []), validation: { fromTrainedModel: model.trainedModel, stemOrder: model.stemOrder } }; throw asStemSeparationError(error); }
    const metadata = this.metadata(request, modelId, trackName, result.events); const stems = result.stems.map((s) => ({ id: s.id, filePath: s.filePath, sampleRate: s.sampleRate, channels: s.channels, frames: s.frames }));
    return { status: 'COMPLETED', stems, metadata, validation: { fromTrainedModel: model.trainedModel && backend.capabilities().trainedModel, stemOrder: model.stemOrder } };
  }
  private metadata(request: SeparationRequest, modelId: string, trackName: string, events: { phase: string; detail?: string }[]): SeparationMetadata { return { settings: { inputPath: request.inputPath, modelId, profile: request.profile ?? 'HIGH_QUALITY', trackName, extras: request.extras }, events }; }
  private async ensureWritableRoot(root: string): Promise<void> { try { const info = await stat(root).catch(() => undefined); if (info && (info.mode & 0o222) === 0) throw new StemSeparationError('WRITE_DENIED', `Ausgabeverzeichnis ist nicht beschreibbar: ${root}`); await mkdir(root, { recursive: true }); } catch (error) { if (error instanceof StemSeparationError) throw error; throw new StemSeparationError('WRITE_DENIED', `Ausgabeverzeichnis konnte nicht erstellt werden: ${root}`, error); } }
}
/**
 * Default backend selection.
 *
 * - `pipeline-double-v1` always maps to the deterministic double.
 * - An explicitly injected `pipelineDouble` wins for every model (tests/CI).
 * - Every other (trained) model runs the real `audio-separator` backend.
 *
 * Previously this returned the double for trained models too, which meant a
 * caller asking for a trained model silently received fixture audio.
 */
export function createDefaultBackendFactory(options: { pipelineDouble?: PipelineDoubleSeparator; audioSeparator?: AudioSeparatorOptions } = {}): (model: StemModelDescriptor, request: SeparationRequest) => IStemSeparator {
  return (model) => {
    if (options.pipelineDouble) return options.pipelineDouble;
    if (model.id === 'pipeline-double-v1' || !model.trainedModel) return new PipelineDoubleSeparator({ stemOrder: model.stemOrder });
    return new AudioSeparatorSeparator({ ...options.audioSeparator, stemOrder: model.stemOrder });
  };
}
