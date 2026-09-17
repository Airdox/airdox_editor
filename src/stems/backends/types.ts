import type { BackendCapabilities, StemId } from '../types';
import type { SeparationCancellationToken } from '../chunkProcessor';
export interface BackendSeparationRequest { inputPath: string; outputRoot: string; stemOrder: StemId[]; sampleRate: number; channels: number; token?: SeparationCancellationToken; onProgress?: (entry: { chunkIndex?: number; phase: string; detail?: string }) => void; extras?: Record<string, string | number | boolean>; }
export interface BackendStemResult { id: StemId; filePath: string; sampleRate: number; channels: number; frames: number; }
export interface BackendSeparationResult { stems: BackendStemResult[]; events: { phase: string; detail?: string }[]; }
export interface IStemSeparator { readonly backendId: string; capabilities(): BackendCapabilities; separate(request: BackendSeparationRequest): Promise<BackendSeparationResult>; }
