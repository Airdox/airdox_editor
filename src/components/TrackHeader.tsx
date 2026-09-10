/**
 * @license
 * Rekordbox TrackHeader Component
 * Artwork, Title, Time, Key, BPM, and Track Overview Waveform matching Screenshots 01, 02, 03.
 */

import React from 'react';
import { TrackModel } from '../types/rekordbox';
import { TrackOverview } from './TrackOverview';
import { APP_BUILD } from '../utils/appVersion';

interface TrackHeaderProps {
  track: TrackModel | null;
  currentTime: number;
  viewOffset: number; // start of detail window in seconds
  viewDuration: number; // duration of detail window in seconds
  onSeek: (time: number) => void;
  onPanView: (newOffset: number) => void;
}

/**
 * ANLZ auto-lookup diagnostics (read from track.rawXmlAttributes.anlzLookup,
 * written by the deck loader): shows WHY a track has (or has not) its
 * genuine Rekordbox waveform — DB link, exact PPTH scan hit, unique
 * basename hit (needs verification), or scan with no match.
 */
interface AnlzLookupInfo {
  via: 'DB' | 'PPTH' | 'PPTH_NAME' | null;
  scanned: number;
  folders: number;
  elapsedMs: number;
  note?: string;
}

function readAnlzLookup(track: TrackModel | null): AnlzLookupInfo | null {
  if (!track?.rawXmlAttributes?.anlzLookup) return null;
  try {
    return JSON.parse(track.rawXmlAttributes.anlzLookup) as AnlzLookupInfo;
  } catch {
    return null;
  }
}

function AnlzStatusChip({ track }: { track: TrackModel }) {
  const hasAnlz = !!(track.analysis && track.analysis.length > 0);
  const lookup = readAnlzLookup(track);

  let label = '';
  let cls = '';
  let title = '';
  if (hasAnlz) {
    label = `ANLZ OK${track.analysis?.sourceTag ? ` • ${track.analysis.sourceTag}` : ''}`;
    cls = 'text-emerald-400 border-emerald-800/50 bg-emerald-950/40';
    title = 'Genuine Rekordbox-ANLZ zugeordnet (Waveform/Cues/Phrasen aus der Quelle).';
  } else if (lookup?.via === 'PPTH_NAME') {
    label = 'ANLZ via DATEINAME – PRÜFEN!';
    cls = 'text-[#f5b800] border-[#f5b800]/50 bg-[#f5b800]/10';
    title = lookup.note || 'ANLZ per eindeutigem Dateinamen zugeordnet (Datei wurde vermutlich nach der Analyse verschoben).';
  } else if (lookup?.via === 'PPTH' || lookup?.via === 'DB') {
    // Lookup fand die Datei, aber das Lesen lieferte keine Waveform.
    label = `ANLZ ${lookup.via === 'DB' ? 'via DB' : 'via PPTH'} – NICHT LESBAR`;
    cls = 'text-[#f5b800] border-[#f5b800]/50 bg-[#f5b800]/10';
    title = 'ANLZ-Datei wurde deterministisch zugeordnet, konnte aber nicht gelesen werden (Pfad prüfen).';
  } else if (lookup) {
    label = `KEIN ANLZ • SCAN ${lookup.scanned} DAT.`;
    cls = 'text-[#ff5555] border-[#ff5555]/50 bg-[#ff5555]/10';
    title = `Automatische Suche: ${lookup.scanned} ANLZ-Dateien in ${lookup.folders} Ordner(n) gescannt, keine Übereinstimmung mit dem Audio-Pfad dieses Tracks. ANLZ manuell über DATA zuordnen.`;
  } else {
    label = 'KEIN ANLZ';
    cls = 'text-[#ff5555] border-[#ff5555]/50 bg-[#ff5555]/10';
    title = 'Keine ANLZ zugeordnet – Beatgrid-Vorschau aktiv. ANLZ über DATA oder automatische Zuordnung erhalten.';
  }

  return (
    <span className={`font-mono text-[9.5px] px-1 rounded-xs border ${cls}`} title={title}>
      {label}
    </span>
  );
}

/** Honest origin labels — every track origin is named, never implied. */
const ORIGIN_LABELS: Record<string, string> = {
  REKORDBOX_XML: 'REKORDBOX XML',
  REKORDBOX_DB: 'REKORDBOX DB',
  REKORDBOX_ANLZ: 'REKORDBOX ANLZ',
  LOCAL_ANALYSIS: 'LOKALER IMPORT',
  PROJECT: 'PROJEKT',
  ANALYSIS_CACHE: 'ANALYSE-CACHE',
  USER_EDIT: 'USER EDIT',
  GENERATED_FALLBACK: 'GENERIERTE DEMO',
};

/** Read-only source status: missing originals are shown as MISSING, loudly. */
const STATUS_STYLES: Record<string, string> = {
  AVAILABLE: 'text-emerald-400 border-emerald-800/50 bg-emerald-950/40',
  MISSING: 'text-[#ff5555] border-[#ff5555]/50 bg-[#ff5555]/10',
  UNSUPPORTED: 'text-[#f5b800] border-[#f5b800]/50 bg-[#f5b800]/10',
  UNVERIFIED: 'text-neutral-400 border-neutral-700 bg-neutral-800/40',
};

export const TrackHeader: React.FC<TrackHeaderProps> = ({
  track,
  currentTime,
  viewOffset,
  viewDuration,
  onSeek,
  onPanView,
}) => {
  // Format 05:26.3
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const tenths = Math.floor((secs % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${tenths}`;
  };

  return (
    <div className="bg-[#0b0c0f] border-b border-[#1a1b22] px-3 py-1.5 flex flex-col select-none">
      {/* Upper info row: Artwork, Title, Metadata (Time, Key, BPM) */}
      <div className="flex items-center justify-between mb-1.5">
        {/* Left: Artwork + Track Title */}
        <div className="flex items-center space-x-3">
          {/* Authentic blue disc artwork or empty disc */}
          <div className="w-10 h-10 rounded-xs bg-gradient-to-br from-[#0c4085] via-[#082a5c] to-[#041433] border border-[#1b4d8c] flex items-center justify-center shadow-inner relative overflow-hidden flex-shrink-0">
            <div className="w-6 h-6 rounded-full border border-[#f5b800]/60 flex items-center justify-center">
              <span className="font-serif italic font-bold text-[#f5b800] text-[10px] tracking-tighter">
                {track ? 'SB' : 'RB'}
              </span>
            </div>
            <div className="absolute inset-0 bg-blue-500/10 pointer-events-none" />
          </div>

          <div className="flex flex-col">
            <div className="flex items-center space-x-2">
              <span className="text-white font-semibold text-[13px] tracking-wide">
                {track ? track.title : 'Kein Track geladen'}
              </span>
            </div>
            <div className="flex items-center space-x-2 text-[10.5px] text-neutral-400">
              <span>{track ? track.artist : 'Bereit für Rekordbox XML- oder Audio-Import'}</span>
              <span>•</span>
              <span className="text-[#00a2ff] font-mono text-[9.5px]">
                {!track ? 'LEERES PROJEKT' : ORIGIN_LABELS[track.origin] ?? track.origin}
              </span>
              {track?.originalMedia && (
                <>
                  <span>•</span>
                  <span className={`font-mono text-[9.5px] px-1 rounded-xs border ${STATUS_STYLES[track.originalMedia.status] ?? STATUS_STYLES.UNVERIFIED}`}>
                    {track.originalMedia.status === 'AVAILABLE'
                      ? 'QUELLE OK'
                      : `QUELLE: ${track.originalMedia.status}`}
                  </span>
                </>
              )}
              {track && (
                <>
                  <span>•</span>
                  <AnlzStatusChip track={track} />
                </>
              )}
              <span
                className="font-mono text-[9.5px] px-1 rounded-xs border border-neutral-700 bg-neutral-800/40 text-neutral-400"
                title={`airdox_SMART_Editor Version ${APP_BUILD}`}
              >
                v{APP_BUILD}
              </span>
            </div>
          </div>
        </div>

        {/* Right: Time, Key, BPM */}
        <div className="flex items-center space-x-6 font-mono text-neutral-200 text-xs">
          {/* Duration */}
          <div className="flex items-center space-x-1">
            <span className="text-white font-bold text-[13px]">
              {track ? formatTime(track.duration) : '00:00.0'}
            </span>
          </div>

          {/* Key */}
          <div className="flex items-center space-x-1">
            <span className="text-white font-bold text-[13px] tracking-wide">
              {track ? track.key : '--'}
            </span>
          </div>

          {/* BPM */}
          <div className="flex items-center space-x-1">
            <span className="text-white font-bold text-[13px]">
              {track ? track.bpm.toFixed(2) : '--.--'}
            </span>
          </div>
        </div>
      </div>

      {/* Lower row: Thin horizontal Track Overview Waveform */}
      <TrackOverview
        track={track}
        currentTime={currentTime}
        viewOffset={viewOffset}
        viewDuration={viewDuration}
        onSeek={onSeek}
        onPanView={onPanView}
      />
    </div>
  );
};
