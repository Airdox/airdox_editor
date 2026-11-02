import React from 'react';
import type { LibraryDateValue, PartialTrackModel } from '../types/rekordbox';
import { getLibraryTrackDates, libraryDateDay } from '../features/library';

export type BrowserStemStatus = 'available' | 'missing' | 'unknown' | 'checking';
export function BrowserLibraryMetadataCells({ track, status }: { track: PartialTrackModel; status: BrowserStemStatus }) {
  const dates = getLibraryTrackDates(track);
  const date = (value?: LibraryDateValue) => {
    if (!value) return <span className="text-neutral-500">Unbekannt</span>;
    const source = { REKORDBOX_XML: 'Rekordbox XML', REKORDBOX_DB: 'Rekordbox-Datenbank', AUDIO_FILE: 'Audiodatei' }[value.source];
    const meaning = value.source === 'AUDIO_FILE' ? 'Metadaten der Original-Audiodatei' : 'Metadaten des Rekordbox-Sammlungsdatensatzes';
    return <span title={`${source} · ${value.field} · ${value.value} · ${meaning}`}>
      <span className="block font-mono">{libraryDateDay(value.value) || 'Unbekannt'}</span>
      <span className="block text-[9px] text-neutral-500">{source} · {value.field}</span>
    </span>;
  };
  const stem = {
    available: { label: 'Vorhanden', color: 'text-emerald-400', help: 'Geprüfte, nutzbare Stem-Dateien für diese Quelldatei vorhanden.' },
    missing: { label: 'Nicht vorhanden', color: 'text-neutral-400', help: 'Geprüft: kein vollständiger nutzbarer Stem-Satz für diese Quelldatei vorhanden.' },
    unknown: { label: 'Ungeprüft', color: 'text-amber-300', help: 'Noch kein belastbarer Dateinachweis. Kein Nachweis bedeutet nicht, dass Stems fehlen.' },
    checking: { label: 'Prüfung läuft…', color: 'text-sky-300', help: 'Stem-Dateien werden geprüft.' },
  }[status];
  return <>
    <td className="py-2 px-3 text-[11px] text-neutral-300">{track.genre || <span className="text-neutral-500">Unbekannt</span>}</td>
    <td className={`py-2 px-3 text-[10px] whitespace-nowrap ${stem.color}`} title={stem.help}>{stem.label}</td>
    <td className="py-2 px-3 text-[10px] text-neutral-300 whitespace-nowrap">{date(dates.created)}</td>
    <td className="py-2 px-3 text-[10px] text-neutral-300 whitespace-nowrap">{date(dates.modified)}</td>
  </>;
}
