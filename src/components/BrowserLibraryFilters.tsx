import React from 'react';
import type { LibraryFilters } from '../features/library';

export interface BrowserLibraryFiltersProps {
  filters: LibraryFilters;
  genres: readonly string[];
  keys: readonly string[];
  onChange: (filters: LibraryFilters) => void;
  onReset: () => void;
  active: boolean;
}

/** Controlled filters; options always come from the entire imported collection. */
export function BrowserLibraryFilters({ filters, genres, keys, onChange, onReset, active }: BrowserLibraryFiltersProps) {
  const fieldClass = 'bg-[#0a0b0e] border border-[#343849] rounded-xs px-2 py-1 text-[11px] text-neutral-200 focus:border-[#0088ff] focus:outline-none min-w-0';
  const date = (name: 'createdFrom' | 'createdTo' | 'modifiedFrom' | 'modifiedTo', label: string) => (
    <label className="flex items-center gap-1 text-neutral-400">
      <span>{label}</span>
      <input aria-label={label} type="date" className={fieldClass} value={filters[name] || ''}
        onChange={(event) => onChange({ ...filters, [name]: event.target.value })} />
    </label>
  );
  const invalidDates = !!((filters.createdFrom && filters.createdTo && filters.createdFrom > filters.createdTo)
    || (filters.modifiedFrom && filters.modifiedTo && filters.modifiedFrom > filters.modifiedTo));

  return (
    <div aria-label="Sammlungsfilter" className="px-3 py-2 border-b border-[#252838] bg-[#101219] text-[10px] shrink-0">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-neutral-400">Stems
          <select aria-label="Stems" className={fieldClass} value={filters.stems || 'all'}
            onChange={(event) => onChange({ ...filters, stems: event.target.value as LibraryFilters['stems'] })}>
            <option value="all">Alle</option><option value="present">Vorhanden</option><option value="missing">Nicht vorhanden</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-neutral-400">Tonart (Tonhöhe)
          <select aria-label="Tonart (Tonhöhe)" className={fieldClass} value={filters.key || ''}
            onChange={(event) => onChange({ ...filters, key: event.target.value })}>
            <option value="">Alle Tonarten</option>{keys.map((key) => <option key={key} value={key}>{key}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-neutral-400">Genre
          <select aria-label="Genre" className={fieldClass} value={filters.genre || ''}
            onChange={(event) => onChange({ ...filters, genre: event.target.value })}>
            <option value="">Alle Genres</option>{genres.map((genre) => <option key={genre} value={genre}>{genre}</option>)}
          </select>
        </label>
        <button type="button" onClick={onReset} disabled={!active}
          className="ml-auto px-2 py-1 border border-[#343849] text-neutral-200 hover:bg-[#252838] disabled:opacity-40">Alle Filter zurücksetzen</button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-2">
        {date('createdFrom', 'Erstellungsdatum von')}{date('createdTo', 'Erstellungsdatum bis')}
        {date('modifiedFrom', 'Änderungsdatum von')}{date('modifiedTo', 'Änderungsdatum bis')}
      </div>
      <p className="text-neutral-500 mt-1">Alle Filter werden kombiniert; Datumsgrenzen zählen mit. Fehlende Datumswerte passen nicht zu einem Datumsfilter. Datumherkunft steht am Wert; das Importdatum gilt nicht als Erstellungsdatum.</p>
      {invalidDates && <p role="alert" className="text-amber-300 mt-1">Ungültiger Zeitraum: „von“ liegt nach „bis“.</p>}
    </div>
  );
}
