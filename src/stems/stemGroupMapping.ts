import type { StemId } from './types';
export interface StemGroupMap { groups: Map<StemId, StemId[]>; unassigned: StemId[]; }
export function buildStemGroupMap(modelStemOrder: StemId[], groundTruthStems: StemId[]): StemGroupMap {
  const groups = new Map<StemId, StemId[]>(modelStemOrder.map((id) => [id, []])); const remaining = new Set(groundTruthStems);
  for (const id of modelStemOrder) if (remaining.delete(id)) groups.get(id)!.push(id);
  const fallback = modelStemOrder.includes('other') ? 'other' : modelStemOrder[modelStemOrder.length - 1];
  if (fallback) for (const id of remaining) groups.get(fallback)!.push(id);
  return { groups, unassigned: fallback ? [] : [...remaining] };
}
export function sumStems(stems: Map<StemId, Float32Array>, ids: StemId[], frames: number, channels = 2): Float32Array { const out = new Float32Array(frames * channels); for (const id of ids) { const data = stems.get(id); if (!data) continue; for (let i = 0; i < Math.min(out.length, data.length); i++) out[i] += data[i]; } return out; }
