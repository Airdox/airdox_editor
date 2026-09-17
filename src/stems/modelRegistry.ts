import type { StemId } from './types';
import { StemRegistry, type StemModelDescriptor } from './stemSeparationEngine';
export const DEFAULT_MODEL_ID = 'bsroformer-musdb18hq-4stem-zfturbo';
export const MODEL_REGISTRY: readonly StemModelDescriptor[] = [
  { id: DEFAULT_MODEL_ID, stemOrder: ['vocals', 'drums', 'bass', 'other'], trainedModel: true },
  { id: 'pipeline-double-v1', stemOrder: ['vocals', 'drums', 'bass', 'other'], trainedModel: false },
];
export { StemRegistry };
export type { StemModelDescriptor };
export function createModelRegistry(): StemRegistry { const registry = new StemRegistry(); return registry; }
export function modelStemOrder(modelId: string, fallback: StemId[] = ['vocals', 'drums', 'bass', 'other']): StemId[] { return MODEL_REGISTRY.find((model) => model.id === modelId)?.stemOrder ?? fallback; }
