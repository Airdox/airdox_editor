import type { BackendCapabilities, StemId } from '../types';
import type { BackendSeparationRequest, BackendSeparationResult, IStemSeparator } from './types';
import { PipelineDoubleSeparator } from './pipelineDoubleSeparator';

/**
 * Adapter boundary for BS-RoFormer transports. The actual native/Python
 * process can be plugged in without changing the engine contract. In a
 * dependency-free checkout the adapter refuses to claim trained output and
 * falls back only when explicitly requested by the caller.
 */
export class BSRoFormerSeparator implements IStemSeparator {
  readonly backendId: string;
  private readonly stemOrder: StemId[];
  private readonly fallback?: PipelineDoubleSeparator;
  constructor(options: { backendId?: string; stemOrder?: StemId[]; fallback?: PipelineDoubleSeparator } = {}) {
    this.backendId = options.backendId ?? 'bsroformer';
    this.stemOrder = options.stemOrder ?? ['vocals', 'drums', 'bass', 'other'];
    this.fallback = options.fallback;
  }
  capabilities(): BackendCapabilities { return { trainedModel: !this.fallback, supportsCancellation: true, supportsStereo: true, stemOrder: this.stemOrder }; }
  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResult> {
    if (!this.fallback) throw new Error('BS-RoFormer-Backend ist ohne installierten Checkpoint nicht verfügbar');
    return this.fallback.separate({ ...request, stemOrder: this.stemOrder });
  }
}

/** Mel-band transport uses the same engine contract as BS-RoFormer. */
export class MelBandRoFormerSeparator extends BSRoFormerSeparator {
  constructor(options: ConstructorParameters<typeof BSRoFormerSeparator>[0] = {}) { super({ ...options, backendId: options.backendId ?? 'melband-roformer' }); }
}
