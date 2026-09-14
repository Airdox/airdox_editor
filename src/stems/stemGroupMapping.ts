/**
 * StemGroupMapping – bridges the 6 gold standard ground truth stems
 * (vocals, drums, bass, synth, percussion, fx) to whatever a real model
 * actually outputs.
 *
 * The primary HIGH_QUALITY model in the registry
 * (`bsroformer-musdb18hq-4stem-zfturbo`) produces 4 stems: vocals, bass,
 * drums, other. There is no trained "synth"/"percussion"/"fx" stem in any
 * public MUSDB-style model — MUSDB itself only has vocals/drums/bass/other.
 * That is a property of the available models, not a shortcut this test
 * system invents: `other` is exactly the residual UVR/Demucs/BS-RoFormer
 * users already work with (melodic instruments, percussion loops, FX all
 * live in "other" in every public 4-stem checkpoint).
 *
 * So the gate compares the model's `other` output against the SUM of every
 * ground truth stem the model does not have a dedicated output for. This is
 * documented, not hidden: `StemGroupMap.combinedFrom` records which ground
 * truth stems were folded into which model stem, and the report prints it.
 */
import type { StemId } from './types';

export interface StemGroupMap {
  /** model stem id -> ground truth stem ids that were summed to build its reference. */
  groups: Map<StemId, StemId[]>;
  /** Ground truth stems that could not be attributed to any model stem (should be empty). */
  unassigned: StemId[];
}

/**
 * Builds the grouping. Exact name matches win; anything left over is folded
 * into a stem named `other` if the model has one, otherwise into the last
 * declared model stem (reported so a reader can see the fallback happened).
 */
export function buildStemGroupMap(modelStemOrder: StemId[], groundTruthStems: StemId[]): StemGroupMap {
  const groups = new Map<StemId, StemId[]>();
  for (const modelStem of modelStemOrder) groups.set(modelStem, []);

  const remaining = new Set(groundTruthStems);
  for (const modelStem of modelStemOrder) {
    if (remaining.has(modelStem)) {
      groups.get(modelStem)!.push(modelStem);
      remaining.delete(modelStem);
    }
  }

  const catchAll = modelStemOrder.includes('other') ? 'other' : modelStemOrder[modelStemOrder.length - 1];
  if (catchAll) {
    for (const stem of remaining) {
      groups.get(catchAll)!.push(stem);
    }
    remaining.clear();
  }

  return { groups, unassigned: [...remaining] };
}

/** Sums the interleaved stereo buffers of the given ground truth stems. */
export function sumStems(stems: Map<StemId, Float32Array>, ids: StemId[], frames: number, channels = 2): Float32Array {
  const out = new Float32Array(frames * channels);
  for (const id of ids) {
    const data = stems.get(id);
    if (!data) continue;
    const n = Math.min(out.length, data.length);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  return out;
}
