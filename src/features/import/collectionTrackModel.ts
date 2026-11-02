import { buildCollectionTrackModel as buildProjectCollectionTrackModel } from '../project/projectModel';
import { getLibraryTrackDates } from '../library/dates';
import type { DataOrigin, PartialTrackModel, TrackModel } from '../../types/rekordbox';

/** Keep source metadata through the project-model builder's legacy defaults. */
export function buildCollectionTrackModel(source: PartialTrackModel, index: number, origin: DataOrigin): TrackModel {
  const track = buildProjectCollectionTrackModel(source, index, origin);
  return { ...track, key: source.key || '', genre: source.genre || '', libraryDates: getLibraryTrackDates(source) };
}
