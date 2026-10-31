/** Results belong to the exact track and immutable working-copy revision submitted. */
export interface StemResultTarget {
  trackId: string | undefined;
  buffer: AudioBuffer | null;
}

export function applyStemResultIfCurrent(
  current: StemResultTarget,
  submitted: StemResultTarget,
  apply: () => void
): boolean {
  if (current.trackId !== submitted.trackId || current.buffer !== submitted.buffer) return false;
  apply();
  return true;
}
