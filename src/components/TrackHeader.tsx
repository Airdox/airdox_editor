/**
 * @license
 * Rekordbox TrackHeader Component
 * Artwork, Title, Time, Key, BPM, and Track Overview Waveform matching Screenshots 01, 02, 03.
 */

import React from 'react';
import { FileAudio, Check } from 'lucide-react';
import { TrackModel } from '../types/rekordbox';
import { TrackOverview } from './TrackOverview';

interface TrackHeaderProps {
  track: TrackModel | null;
  currentTime: number;
  viewOffset: number; // start of detail window in seconds
  viewDuration: number; // duration of detail window in seconds
  onSeek: (time: number) => void;
  onPanView: (newOffset: number) => void;
  onLoadAudioClick?: () => void;
}

export const TrackHeader: React.FC<TrackHeaderProps> = ({
  track,
  currentTime,
  viewOffset,
  viewDuration,
  onSeek,
  onPanView,
  onLoadAudioClick,
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
              {track && !track.audioBuffer && onLoadAudioClick && (
                <button
                  onClick={onLoadAudioClick}
                  className="flex items-center space-x-1 px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/35 border border-amber-500/50 text-amber-300 text-[10px] font-semibold transition-all cursor-pointer shadow-sm animate-pulse"
                  title="Audiodatei (MP3/WAV/FLAC) für diesen Track verknüpfen"
                >
                  <FileAudio size={11} />
                  <span>Audiodatei fehlt – Klicken zum Verknüpfen</span>
                </button>
              )}
              {track && track.audioBuffer && (
                <span className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-emerald-400 text-[9.5px] font-mono">
                  <Check size={10} />
                  <span>Audio aktiv ({track.sampleRate}Hz)</span>
                </span>
              )}
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
    </div>
  );
};
