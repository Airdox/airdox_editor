import type { TrackModel } from '../../types/rekordbox';
import { getLibraryTrackDates, libraryDateDay } from './dates';
import { getLibraryStemStatus, type LibraryStemSnapshot } from './stems';
export * from './dates';
export * from './stems';

export interface LibraryFilters {
  stems?: 'all' | 'present' | 'missing';
  createdFrom?: string; createdTo?: string; modifiedFrom?: string; modifiedTo?: string;
  genre?: string; key?: string;
}
export const DEFAULT_LIBRARY_FILTERS: Readonly<LibraryFilters> = Object.freeze({
  stems: 'all', createdFrom: '', createdTo: '', modifiedFrom: '', modifiedTo: '', genre: '', key: '',
});
const normalized = (value?: string) => value?.trim().toLowerCase() || '';

export function filterLibraryTracks<T extends Partial<TrackModel>>(tracks: readonly T[], filters: LibraryFilters = DEFAULT_LIBRARY_FILTERS, stems?: LibraryStemSnapshot): T[] {
  const prepareRange = (from?: string, to?: string) => {
    if (!from && !to) return true;
    const lower = from ? libraryDateDay(from) : undefined;
    const upper = to ? libraryDateDay(to) : undefined;
    return (value?: string) => {
      const day = value && libraryDateDay(value);
      if (!day || (from && !lower) || (to && !upper)) return false;
      return (!lower || day >= lower) && (!upper || day <= upper);
    };
  };
  const createdRange = prepareRange(filters.createdFrom, filters.createdTo);
  const modifiedRange = prepareRange(filters.modifiedFrom, filters.modifiedTo);
  return tracks.filter(track => {
    if (filters.genre && normalized(track.genre) !== normalized(filters.genre)) return false;
    if (filters.key && normalized(track.key) !== normalized(filters.key)) return false;
    if (filters.stems && filters.stems !== 'all') {
      const status = getLibraryStemStatus(track, stems);
      if (status !== (filters.stems === 'present' ? 'available' : 'missing')) return false;
    }
    if (createdRange === true && modifiedRange === true) return true;
    const dates = getLibraryTrackDates(track);
    return (createdRange === true || createdRange(dates.created?.value)) && (modifiedRange === true || modifiedRange(dates.modified?.value));
  });
}
export function getLibraryFilterOptions(tracks: readonly Partial<TrackModel>[]): { genres: string[]; keys: string[] } {
  const values = (field: 'genre' | 'key') => {
    const seen = new Map<string, string>();
    for (const track of tracks) if (track[field]?.trim()) seen.set(normalized(track[field]), track[field]!.trim());
    return [...seen.values()].sort((a,b) => a.localeCompare(b));
  };
  return { genres: values('genre'), keys: values('key') };
}
