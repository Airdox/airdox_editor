/**
 * @license
 * Small preview profiles for clip cards (palette, browser rows).
 *
 * The project rule for the Rekordbox path is: never draw a contour that was not
 * measured. A preview still needs far fewer values than the stored analysis has
 * columns, so the only allowed reduction is SELECTION: every preview pixel shows
 * exactly one stored column value, byte-identical, chosen by nearest column
 * centre. No averaging, no smoothing, no interpolation, no re-analysis of audio.
 */

import type { WaveformAnalysisData } from '../types/rekordbox';

/** Where a preview profile came from — shown on the card, asserted in tests. */
export type PreviewOrigin = 'ANLZ' | 'EDIT';

export interface PreviewProfile {
  peaks: number[];
  origin: PreviewOrigin;
  /** How many stored columns the profile was selected from (0 for EDIT). */
  columns: number;
}

/**
 * Selects `width` stored columns for the window `[sourceStart, sourceStart +
 * durationSec)` of `variant`. Returns null when the variant does not cover the
 * window (then the caller must NOT invent a preview).
 */
export function miniPeaksFromStoredColumns(
  variant: WaveformAnalysisData | null | undefined,
  sourceStart: number,
  durationSec: number,
  width: number
): number[] | null {
  if (!variant || !(variant.length > 0) || !(width > 0) || !(durationSec > 0)) return null;
  const bucketSeconds =
    variant.secPerBucket && variant.secPerBucket > 0 ? variant.secPerBucket : 0;
  if (!(bucketSeconds > 0)) return null;
  const covered = variant.length * bucketSeconds;
  if (!(sourceStart >= 0) || sourceStart + durationSec > covered + bucketSeconds) return null;

  const peaks = variant.peaks;
  const out: number[] = [];
  const step = durationSec / width;
  for (let k = 0; k < width; k++) {
    const at = sourceStart + (k + 0.5) * step;
    const idx = Math.max(0, Math.min(variant.length - 1, Math.floor(at / bucketSeconds + 1e-9)));
    out.push(peaks[idx]);
  }
  return out;
}

/**
 * Builds the card profile for a window of a track: prefers the stored analysis
 * (labelled `ANLZ`), and only for material that has none (e.g. a local import,
 * or a clip taken from the EDIT timeline) falls back to the caller-provided
 * profile computed from the clip's own audio (labelled `EDIT`).
 */
export function clipPreviewProfile(
  variant: WaveformAnalysisData | null | undefined,
  sourceStart: number,
  durationSec: number,
  width: number,
  fallbackFromAudio: () => number[]
): PreviewProfile {
  const stored = miniPeaksFromStoredColumns(variant, sourceStart, durationSec, width);
  if (stored) {
    return { peaks: stored, origin: 'ANLZ', columns: (variant as WaveformAnalysisData).length };
  }
  return { peaks: fallbackFromAudio(), origin: 'EDIT', columns: 0 };
}

/** One-line, honest note for tooltips and feedback texts. */
export function describePreviewOrigin(profile: PreviewProfile): string {
  return profile.origin === 'ANLZ'
    ? `Mini-Peaks aus ${profile.columns} gespeicherten ANLZ-Spalten ausgewählt (keine Eigenanalyse)`
    : 'Mini-Peaks aus dem Edit-Audio dieses Clips berechnet (keine gespeicherten Spalten vorhanden)';
}
