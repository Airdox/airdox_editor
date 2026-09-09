/**
 * @license
 * Rekordbox TrackHeader Component
 * Artwork, Title, Time, Key, BPM, and Track Overview Waveform matching Screenshots 01, 02, 03.
 */

import React from 'react';
import { TrackModel } from '../types/rekordbox';
import { TrackOverview } from './TrackOverview';

interface TrackHeaderProps {
  track: TrackModel | null;
  currentTime: number;
  viewOffset: number; // start of detail window in seconds
  viewDuration: number; // duration of detail window in seconds
  onSeek: (time: number) => void;
  onPanView: (newOffset: number) => void;
}

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
                {!track
                  ? 'LEERES PROJEKT'
                  : track.origin === 'REKORDBOX_XML'
                  ? 'REKORDBOX XML'
                  : 'EDIT WORKING COPY'}
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

      {/* v0.4.5 ANLZ-status banner (Step 4/8): transparent message when real
          Rekordbox analysis is missing or the beatgrid was user-edited. */}
      {track && (track.analysisStatus === 'MISSING_REKORDBOX_ANALYSIS' || track.analysisStatusMessage) && (
        <div className={`mt-1 px-2 py-0.5 text-[10px] font-mono rounded-[2px] border ${
          track.analysisStatus === 'MISSING_REKORDBOX_ANALYSIS'
            ? 'bg-[#3d2b00]/50 border-[#7c5a00]/60 text-[#ffc857]'
            : track.analysisOrigin === 'USER_EDIT'
            ? 'bg-[#2b1d3f]/60 border-[#8b6bc5]/50 text-[#c4a6ff]'
            : 'bg-[#0b2a1b]/60 border-[#2a7a4f]/50 text-[#8ee0b0]'
        }`}>
          {track.analysisStatus === 'MISSING_REKORDBOX_ANALYSIS' ? '⚠  ' : 'ℹ  '}
          {track.analysisStatusMessage ||
            (track.analysisOrigin === 'REKORDBOX_ANLZ'
              ? 'Rekordbox-ANLZ-Analyse geladen (PQTZ+PWV).'
              : track.analysisOrigin === 'USER_EDIT'
              ? 'Beatgrid wurde manuell verändert (USER_EDIT).'
              : 'Analyse-Daten bereit.')}
          <span className="ml-2 opacity-70">
            [Origin: {track.analysisOrigin} · Status: {track.analysisStatus}]
          </span>
        </div>
      )}
    </div>
  );
};
