import type { BackendCapabilities, StemId } from '../types';
import type { BackendSeparationRequest, BackendSeparationResult, IStemSeparator } from './types';
import { PipelineDoubleSeparator } from './pipelineDoubleSeparator';
export class HTDemucsSeparator implements IStemSeparator {
  readonly backendId = 'htdemucs';
  private readonly fallback?: PipelineDoubleSeparator;
  private readonly stemOrder: StemId[];
  constructor(options: { fallback?: PipelineDoubleSeparator; stemOrder?: StemId[] } = {}) { this.fallback = options.fallback; this.stemOrder = options.stemOrder ?? ['drums', 'bass', 'other', 'vocals']; }
  capabilities(): BackendCapabilities { return { trainedModel: !this.fallback, supportsCancellation: true, supportsStereo: true, stemOrder: this.stemOrder }; }
  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResult> { if (!this.fallback) throw new Error('HT-Demucs-Backend ist ohne installierten Checkpoint nicht verfügbar'); return this.fallback.separate({ ...request, stemOrder: this.stemOrder }); }
}
