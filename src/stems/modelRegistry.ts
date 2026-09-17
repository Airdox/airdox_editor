import type { StemId } from './types';
import { StemRegistry, type StemModelDescriptor } from './stemSeparationEngine';
import { DSP_SEPARATOR_ENGINE } from './dspSeparator';
export const DEFAULT_MODEL_ID = 'bsroformer-musdb18hq-4stem-zfturbo';
/** Modell, das überall läuft (Browser + Desktop, ohne externe Runtime). */
export const BUILTIN_MODEL_ID = DSP_SEPARATOR_ENGINE;
export const MODEL_REGISTRY: readonly StemModelDescriptor[] = [
  { id: DEFAULT_MODEL_ID, stemOrder: ['vocals', 'drums', 'bass', 'other'], trainedModel: true },
  // Läuft ohne Python/GPU/Checkpoint im Prozess – ehrlich als Heuristik markiert.
  { id: DSP_SEPARATOR_ENGINE, stemOrder: ['vocals', 'drums', 'bass', 'other'], trainedModel: false },
  { id: 'pipeline-double-v1', stemOrder: ['vocals', 'drums', 'bass', 'other'], trainedModel: false },
];
export function createModelRegistry(): StemRegistry { const registry = new StemRegistry(); return registry; }
export function modelStemOrder(modelId: string, fallback: StemId[] = ['vocals', 'drums', 'bass', 'other']): StemId[] { return MODEL_REGISTRY.find((model) => model.id === modelId)?.stemOrder ?? fallback; }
