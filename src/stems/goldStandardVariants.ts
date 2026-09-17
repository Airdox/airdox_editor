import type { GoldStandardTrack } from './goldStandard';
import { compress, extremePan, feedbackDelay, hardClip, peakNormalize, saturate, sidechainDuck, simpleReverb, softLimit, stereoWidth, type StereoBuffer } from './mixEffects';
export type VariantId = 'A_clean'|'B_normalized'|'C_compressed'|'D_heavily_compressed'|'E_limited'|'F_very_loud'|'G_saturated'|'H_clipped'|'I_stereo_widened'|'J_mono_compatible'|'K_extreme_panning'|'L_heavy_reverb'|'M_heavy_delay'|'N_sidechain'|'O_dense_full_mix';
export interface MixVariant { id: VariantId; title: string; description: string; buffer: StereoBuffer; }
const toBuffer = (track: GoldStandardTrack): StereoBuffer => ({ data: new Float32Array(track.mix), sampleRate: track.sampleRate, frames: track.frames });
export function buildGoldStandardVariants(track: GoldStandardTrack): MixVariant[] {
  const b = () => toBuffer(track), beatFrames = Math.floor(60 / track.bpm * track.sampleRate);
  return [
    { id: 'A_clean', title: 'Clean Mix', description: 'Unbearbeiteter Summenmix.', buffer: b() },
    { id: 'B_normalized', title: 'Normalized Mix', description: 'Peak-normalisiert.', buffer: peakNormalize(b(), -1) },
    { id: 'C_compressed', title: 'Compressed Mix', description: 'Moderate Bus-Kompression.', buffer: compress(b(), { thresholdDb: -18, ratio: 4, attackMs: 8, releaseMs: 120, makeupDb: 4 }) },
    { id: 'D_heavily_compressed', title: 'Heavily Compressed Mix', description: 'Starke Kompression.', buffer: compress(b(), { thresholdDb: -24, ratio: 10, attackMs: 3, releaseMs: 180, makeupDb: 9 }) },
    { id: 'E_limited', title: 'Limited Mix', description: 'Soft-Limiting.', buffer: softLimit(peakNormalize(b(), 0), -.3) },
    { id: 'F_very_loud', title: 'Very Loud Mix', description: 'Loudness-War-Mastering.', buffer: softLimit(compress(b(), { thresholdDb: -20, ratio: 8, attackMs: 2, releaseMs: 80, makeupDb: 10 }), -.1) },
    { id: 'G_saturated', title: 'Saturated Mix', description: 'Bus-Sättigung.', buffer: saturate(peakNormalize(b(), -3), 2.2) },
    { id: 'H_clipped', title: 'Clipped Mix', description: 'Digitales Clipping.', buffer: hardClip(peakNormalize(b(), 3), .891) },
    { id: 'I_stereo_widened', title: 'Stereo-Widened Mix', description: 'Mid/Side verbreitert.', buffer: stereoWidth(b(), 1.8) },
    { id: 'J_mono_compatible', title: 'Mono-Compatible Mix', description: 'Mid/Side verengt.', buffer: stereoWidth(b(), .15) },
    { id: 'K_extreme_panning', title: 'Extreme Panning Mix', description: 'Auto-Pan.', buffer: extremePan(b(), .2) },
    { id: 'L_heavy_reverb', title: 'Heavy Reverb Mix', description: 'Bus-Hall.', buffer: simpleReverb(b(), { wet: .55, decay: .78, predelayMs: 18 }) },
    { id: 'M_heavy_delay', title: 'Heavy Delay Mix', description: 'Ping-Pong-Delay.', buffer: feedbackDelay(b(), { timeMs: 375, feedback: .55, wet: .4 }) },
    { id: 'N_sidechain', title: 'Sidechain Mix', description: 'Bus-Sidechain.', buffer: sidechainDuck(b(), { beatFrames, duckDb: -6, attackMs: 4, releaseMs: 140 }) },
    { id: 'O_dense_full_mix', title: 'Dense Full Mix', description: 'EDM-Masterkette.', buffer: softLimit(simpleReverb(saturate(compress(b(), { thresholdDb: -20, ratio: 6, attackMs: 5, releaseMs: 100, makeupDb: 7 }), 1.6), { wet: .18, decay: .55, predelayMs: 12 }), -.5) },
  ];
}
export function buildMasterBusMix(track: GoldStandardTrack): StereoBuffer { return softLimit(simpleReverb(saturate(compress(toBuffer(track), { thresholdDb: -20, ratio: 6, attackMs: 5, releaseMs: 100, makeupDb: 7 }), 1.5), { wet: .15, decay: .5, predelayMs: 10 }), -.3); }
