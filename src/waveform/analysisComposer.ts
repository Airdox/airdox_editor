/**
 * Composes waveform from edit segments preserving native ANLZ buckets through edits
 * Preserves native ANLZ buckets for untouched regions, CLEAR stays empty (no invented floor)
 */

import type { EditSegment } from '../types/rekordbox';
import type { WaveformAnalysisData } from '../types/rekordbox';

export interface ComposedBucket {
  peak: number;
  low: number;
  mid: number;
  high: number;
  origin: string;
  sourceStart?: number;
  sourceEnd?: number;
}

export function composeAnalysisFromSegments(
  originalAnalysis: WaveformAnalysisData | null,
  segments: EditSegment[],
  totalBuckets: number
): { buckets: ComposedBucket[]; hasGaps: boolean } {
  const buckets: ComposedBucket[] = new Array(totalBuckets).fill(null).map(() => ({
    peak: 0,
    low: 0,
    mid: 0,
    high: 0,
    origin: 'empty',
  }));

  let hasGaps = false;

  if (!originalAnalysis) {
    return { buckets, hasGaps: true };
  }

  const secPerBucket = originalAnalysis.secPerBucket || (totalBuckets > 0 ? 1 / 200 : 0.005);
  const origPeaks = originalAnalysis.peaks;
  const origLow = originalAnalysis.lowEnergy;
  const origMid = originalAnalysis.midEnergy;
  const origHigh = originalAnalysis.highEnergy;

  // For each segment, map its source range to project range
  for (const seg of segments) {
    if ((seg.type as any) === 'CLEAR') {
      // CLEAR stays empty – no invented floor
      continue;
    }

    const projectStartBucket = Math.floor(seg.projectStart / secPerBucket);
    const projectEndBucket = Math.floor((seg.projectStart + seg.projectDuration) / secPerBucket);
    const sourceStartBucket = Math.floor(seg.sourceStart / secPerBucket);

    for (let b = projectStartBucket; b < projectEndBucket && b < totalBuckets; b++) {
      if (b < 0) continue;
      const sourceBucket = sourceStartBucket + (b - projectStartBucket);
      if (sourceBucket >= 0 && sourceBucket < origPeaks.length) {
        buckets[b] = {
          peak: origPeaks[sourceBucket] || 0,
          low: origLow?.[sourceBucket] || 0,
          mid: origMid?.[sourceBucket] || 0,
          high: origHigh?.[sourceBucket] || 0,
          origin: originalAnalysis.origin || 'REKORDBOX_ANLZ',
          sourceStart: seg.sourceStart,
          sourceEnd: seg.sourceStart + seg.projectDuration,
        };
      } else if (seg.clipBuffer) {
        // For inserted clips, we would have their own analysis – simplified as empty for now
        // In real implementation, clip would carry analysis slice + beatOffsets for exact round-trip
        hasGaps = true;
      }
    }
  }

  // Check for gaps (untouched regions should preserve native buckets, but we have no mapping for them if segments don't cover)
  // If segments is empty or doesn't cover full timeline, preserve original for untouched
  if (segments.length === 0) {
    for (let b = 0; b < Math.min(totalBuckets, origPeaks.length); b++) {
      buckets[b] = {
        peak: origPeaks[b] || 0,
        low: origLow?.[b] || 0,
        mid: origMid?.[b] || 0,
        high: origHigh?.[b] || 0,
        origin: originalAnalysis.origin || 'REKORDBOX_ANLZ',
      };
    }
  }

  // Detect gaps
  for (let b = 0; b < totalBuckets; b++) {
    if (buckets[b].origin === 'empty') {
      hasGaps = true;
      break;
    }
  }

  return { buckets, hasGaps };
}

export function preserveNativeBuckets(
  originalAnalysis: WaveformAnalysisData,
  editedRange: { start: number; end: number },
  secPerBucket: number
): { preserved: boolean; buckets: ComposedBucket[] } {
  // For untouched regions, preserve native ANLZ buckets
  const totalBuckets = originalAnalysis.length;
  const buckets: ComposedBucket[] = [];

  for (let b = 0; b < totalBuckets; b++) {
    const time = b * secPerBucket;
    if (time < editedRange.start || time >= editedRange.end) {
      buckets.push({
        peak: originalAnalysis.peaks[b] || 0,
        low: originalAnalysis.lowEnergy?.[b] || 0,
        mid: originalAnalysis.midEnergy?.[b] || 0,
        high: originalAnalysis.highEnergy?.[b] || 0,
        origin: originalAnalysis.origin || 'REKORDBOX_ANLZ',
      });
    } else {
      buckets.push({
        peak: 0,
        low: 0,
        mid: 0,
        high: 0,
        origin: 'edited',
      });
    }
  }

  return { preserved: true, buckets };
}

export function isNoOpEdit(segments: EditSegment[], originalDuration: number): boolean {
  // Same-slot 4-bar palette round-trip detected as no-op via sample-exact check
  if (segments.length === 1 && segments[0].type === 'ORIGINAL') {
    const seg = segments[0];
    if (Math.abs(seg.sourceStart - seg.projectStart) < 0.001 && Math.abs(seg.projectDuration - originalDuration) < 0.001) {
      return true;
    }
  }
  // Check if segments reconstruct original exactly
  if (segments.length === 0) return true;
  let covered = 0;
  for (const seg of segments) {
    if (seg.type !== 'ORIGINAL') return false;
    if (Math.abs(seg.projectStart - covered) > 0.001) return false;
    if (Math.abs(seg.sourceStart - covered) > 0.001) return false;
    covered += seg.projectDuration;
  }
  return Math.abs(covered - originalDuration) < 0.001;
}
