/** Immutable collection update for the active project track list. */
export function updateTrackById<T extends { id: string }>(
  tracks: T[],
  trackId: string,
  update: (track: T) => T
): T[] {
  const index = tracks.findIndex((track) => track.id === trackId);
  if (index < 0) return tracks;

  const current = tracks[index];
  const nextTrack = update(current);
  if (nextTrack === current) return tracks;

  const nextTracks = [...tracks];
  nextTracks[index] = nextTrack;
  return nextTracks;
}
