/**
 * GoldStandardVariants – the mandatory mix variants of §10.
 *
 * All 15 variants (A..O) are built from the SAME ground truth stems
 * (`generateGoldStandardTrack()`); only the MIX changes. Ground truth stems
 * are never touched by these transforms — a variant answers "does the
 * engine still separate correctly when the delivered mix has been through a
 * realistic mastering chain", not "what if the sources themselves changed".
 */
import type { GoldStandardTrack } from './goldStandard';
import {
  compress,
  extremePan,
  feedbackDelay,
  hardClip,
  peakNormalize,
  saturate,
  sidechainDuck,
  simpleReverb,
  softLimit,
  stereoWidth,
  type StereoBuffer,
} from './mixEffects';

export type VariantId =
  | 'A_clean'
  | 'B_normalized'
  | 'C_compressed'
  | 'D_heavily_compressed'
  | 'E_limited'
  | 'F_very_loud'
  | 'G_saturated'
  | 'H_clipped'
  | 'I_stereo_widened'
  | 'J_mono_compatible'
  | 'K_extreme_panning'
  | 'L_heavy_reverb'
  | 'M_heavy_delay'
  | 'N_sidechain'
  | 'O_dense_full_mix';

export interface MixVariant {
  id: VariantId;
  title: string;
  description: string;
  buffer: StereoBuffer;
}

function toBuffer(track: GoldStandardTrack, data?: Float32Array): StereoBuffer {
  return { data: new Float32Array(data ?? track.mix), sampleRate: track.sampleRate, frames: track.frames };
}

/** Builds every mandatory mix variant of §10 from one gold standard track. */
export function buildGoldStandardVariants(track: GoldStandardTrack): MixVariant[] {
  const base = () => toBuffer(track);
  const beatFrames = Math.floor((60 / track.bpm) * track.sampleRate);

  const variants: MixVariant[] = [
    { id: 'A_clean', title: 'Clean Mix', description: 'Unbearbeiteter linearer Summenmix (§10.A).', buffer: base() },
    { id: 'B_normalized', title: 'Normalized Mix', description: 'Peak-normalisiert auf -1 dBFS (§10.B).', buffer: peakNormalize(base(), -1) },
    {
      id: 'C_compressed',
      title: 'Compressed Mix',
      description: 'Moderate Bus-Kompression, 4:1 bei -18 dBFS (§10.C).',
      buffer: compress(base(), { thresholdDb: -18, ratio: 4, attackMs: 8, releaseMs: 120, makeupDb: 4 }),
    },
    {
      id: 'D_heavily_compressed',
      title: 'Heavily Compressed Mix',
      description: 'Starke Bus-Kompression, 10:1 bei -24 dBFS, hörbares Pumpen (§10.D).',
      buffer: compress(base(), { thresholdDb: -24, ratio: 10, attackMs: 3, releaseMs: 180, makeupDb: 9 }),
    },
    {
      id: 'E_limited',
      title: 'Limited Mix',
      description: 'Brickwall-artiges Soft-Limiting auf -0.3 dBFS (§10.E).',
      buffer: softLimit(peakNormalize(base(), 0), -0.3),
    },
    {
      id: 'F_very_loud',
      title: 'Very Loud Mix',
      description: 'Extremes Loudness-War-Mastering: harte Kompression + doppeltes Limiting nahe 0 dBFS (§10.F).',
      buffer: softLimit(softLimit(compress(base(), { thresholdDb: -20, ratio: 8, attackMs: 2, releaseMs: 80, makeupDb: 10 }), -0.2), -0.1),
    },
    {
      id: 'G_saturated',
      title: 'Saturated Mix',
      description: 'tanh-Sättigung (Bus-Drive) für ungeradzahlige Harmonische (§10.G).',
      buffer: saturate(peakNormalize(base(), -3), 2.2),
    },
    {
      id: 'H_clipped',
      title: 'Clipped Mix',
      description: 'Kontrolliertes hartes digitales Clipping (§10.H).',
      buffer: hardClip(peakNormalize(base(), 3), 0.891),
    },
    {
      id: 'I_stereo_widened',
      title: 'Stereo-Widened Mix',
      description: 'Mid/Side-Verbreiterung, Faktor 1.8 (§10.I).',
      buffer: stereoWidth(base(), 1.8),
    },
    {
      id: 'J_mono_compatible',
      title: 'Mono-Compatible Mix',
      description: 'Stark verengt (Faktor 0.15) für Mono-Kompatibilitätsprüfung (§10.J).',
      buffer: stereoWidth(base(), 0.15),
    },
    {
      id: 'K_extreme_panning',
      title: 'Extreme Panning Mix',
      description: 'Langsames, hartes Auto-Pan-LFO (0.2 Hz) (§10.K).',
      buffer: extremePan(base(), 0.2),
    },
    {
      id: 'L_heavy_reverb',
      title: 'Heavy Reverb Mix',
      description: 'Starker Schroeder-Hall auf dem gesamten Bus (§10.L, §11: Reverb <-> alle Quellen).',
      buffer: simpleReverb(base(), { wet: 0.55, decay: 0.78, predelayMs: 18 }),
    },
    {
      id: 'M_heavy_delay',
      title: 'Heavy Delay Mix',
      description: 'Ausgeprägtes Ping-Pong-Delay mit hoher Feedback-Rate (§10.M).',
      buffer: feedbackDelay(base(), { timeMs: 375, feedback: 0.55, wet: 0.4 }),
    },
    {
      id: 'N_sidechain',
      title: 'Sidechain Mix',
      description: 'Zusätzliches Bus-Sidechain-Ducking im Beat-Raster, unabhängig vom stemseitigen Ducking (§10.N).',
      buffer: sidechainDuck(base(), { beatFrames, duckDb: -6, attackMs: 4, releaseMs: 140 }),
    },
    {
      id: 'O_dense_full_mix',
      title: 'Dense Full Mix',
      description: 'Kombination: Kompression + Sättigung + leichter Hall + Limiting — realistische moderne EDM-Masterkette (§10.O, entspricht §9).',
      buffer: softLimit(
        simpleReverb(
          saturate(compress(base(), { thresholdDb: -20, ratio: 6, attackMs: 5, releaseMs: 100, makeupDb: 7 }), 1.6),
          { wet: 0.18, decay: 0.55, predelayMs: 12 }
        ),
        -0.5
      ),
    },
  ];
  return variants;
}

/** Convenience: only the variant used for §9 (master bus simulation of the last 5 s segment). */
export function buildMasterBusMix(track: GoldStandardTrack): StereoBuffer {
  const buffer = base(track);
  const compressed = compress(buffer, { thresholdDb: -20, ratio: 6, attackMs: 5, releaseMs: 100, makeupDb: 7 });
  const driven = saturate(compressed, 1.5);
  const reverberant = simpleReverb(driven, { wet: 0.15, decay: 0.5, predelayMs: 10 });
  const delayed = feedbackDelay(reverberant, { timeMs: 250, feedback: 0.25, wet: 0.12 });
  return softLimit(delayed, -0.3);
}

function base(track: GoldStandardTrack): StereoBuffer {
  return toBuffer(track);
}
