import type { LibraryDateValue, TrackModel } from '../../types/rekordbox';
export type { LibraryDateValue } from '../../types/rekordbox';

/** Strict ISO calendar dates; timezone-less source timestamps retain their wall date. */
export function libraryDateDay(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(value);
  if (!match) return undefined;
  const [, y, m, d] = match;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) return undefined;
  if (value.length > 10) {
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value) ||
        !Number.isFinite(Date.parse(value))) return undefined;
    const time = value.slice(11, 19).split(':').map(Number);
    if (time[0] > 23 || time[1] > 59 || time[2] > 59) return undefined;
  }
  return `${y}-${m}-${d}`;
}

export function sourceLibraryDate(value: unknown, source: LibraryDateValue['source'], field: string): LibraryDateValue | undefined {
  if (typeof value !== 'string') return undefined;
  value = value.trim();
  if (!libraryDateDay(value as string)) return undefined;
  return { value: value as string, source, field, precision: (value as string).length === 10 ? 'day' : 'instant' };
}

export function getLibraryTrackDates(track: Partial<TrackModel>): { created?: LibraryDateValue; modified?: LibraryDateValue } {
  const raw = track.rawXmlAttributes || {};
  const valid = (date?: LibraryDateValue) => date && libraryDateDay(date.value) ? date : undefined;
  const fromRaw = (fields: string[]) => fields.map(field => sourceLibraryDate(raw[field],
    raw.databaseType || track.origin === 'REKORDBOX_DB' ? 'REKORDBOX_DB' : 'REKORDBOX_XML', field)).find(Boolean);
  const created = valid(track.libraryDates?.created) || fromRaw(['DateCreated', 'created_at', 'dateCreated']);
  let modified = valid(track.libraryDates?.modified) || fromRaw(['DateModified', 'updated_at', 'dateModified']);
  // Audio mtime describes the audio file, never the XML/ANLZ container or import.
  const mtime = track.originalMedia?.modifiedAt;
  if (!modified && track.originalMedia?.status === 'AVAILABLE' && typeof mtime === 'number' && Number.isFinite(mtime)) {
    const date = new Date(mtime);
    if (Number.isFinite(date.getTime())) modified = sourceLibraryDate(date.toISOString(), 'AUDIO_FILE', 'modifiedAt');
  }
  return { created, modified };
}
