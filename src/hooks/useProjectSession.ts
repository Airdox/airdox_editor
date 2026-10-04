import { useCallback, useState } from 'react';
import type { TrackModel } from '../types/rekordbox';
import { updateTrackById as updateTrackByIdImmutable } from '../state/trackUpdates';

/** Owns the selected project metadata and its immutable track collection. */
export function useProjectSession() {
  const [projectName, setProjectName] = useState('New Project');
  const [tracks, setTracks] = useState<TrackModel[]>([]);
  const [activeTrackId, setActiveTrackId] = useState('');
  const [workingAudioBuffer, setWorkingAudioBuffer] = useState<AudioBuffer | null>(null);

  const activeTrack = tracks.find((track) => track.id === activeTrackId) || tracks[0] || null;
  const updateTrack = useCallback((trackId: string, updater: (track: TrackModel) => TrackModel) => {
    setTracks((current) => updateTrackByIdImmutable(current, trackId, updater));
  }, []);

  return {
    projectName,
    setProjectName,
    tracks,
    setTracks,
    activeTrackId,
    setActiveTrackId,
    activeTrack,
    workingAudioBuffer,
    setWorkingAudioBuffer,
    updateTrack,
  };
}
