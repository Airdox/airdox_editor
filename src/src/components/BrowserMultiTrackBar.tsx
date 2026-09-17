/**
 * @license
 * Rekordbox BROWSER Component (Pure Rekordbox EDIT Mode Workflow)
 * 
 * Replaces the multi-track arrangement with the authentic Pioneer Rekordbox
 * Library & Collection Browser:
 * - "BROWSER" chamfered tab & "rekordbox" branding
 * - Left tree navigation (Collection, XML, Playlists, History)
 * - Search bar with instant filtering by Title, Artist, BPM, Key
 * - Full track table with Memory Cue counts, BPM, Key, and "In Deck laden"
 * - No DAW/Arrangement lanes, completely true to Pioneer Rekordbox EDIT Mode.
 */

import React, { useState, useMemo } from 'react';
import { TrackModel } from '../types/rekordbox';
import {
  ChevronUp,
  ChevronDown,
  Music,
  Disc,
  Upload,
  Search,
  Folder,
  FolderOpen,
  Play,
  Check,
  X,
  FileAudio,
  ListMusic,
} from 'lucide-react';

interface BrowserBarProps {
  isOpen: boolean;
  onToggle: () => void;
  tracks: TrackModel[];
  activeTrackId: string;
  onSelectTrack: (trackId: string) => void;
  onImportXml: () => void;
  onImportAudio: () => void;
  onOpenXmlCollection?: () => void;
  currentTime?: number;
}

export const BrowserMultiTrackBar: React.FC<BrowserBarProps> = ({
  isOpen,
  onToggle,
  tracks,
  activeTrackId,
  onSelectTrack,
  onImportXml,
  onImportAudio,
  onOpenXmlCollection,
}) => {
  const [selectedFolder, setSelectedFolder] = useState<'ALL' | 'XML' | 'AUDIO' | 'PLAYLIST'>('ALL');
  const [browserSearchQuery, setBrowserSearchQuery] = useState<string>('');

  // Filter tracks by selected tree folder and search query
  const filteredTracks = useMemo(() => {
    return tracks.filter((t) => {
      // Folder filter
      if (selectedFolder === 'XML' && t.origin !== 'REKORDBOX_XML') return false;
      if (selectedFolder === 'AUDIO' && t.origin !== 'LOCAL_ANALYSIS') return false;

      // Search query filter
      const q = browserSearchQuery.trim().toLowerCase();
      if (!q) return true;

      const titleMatch = t.title.toLowerCase().includes(q);
      const artistMatch = (t.artist || '').toLowerCase().includes(q);
      const bpmMatch = t.bpm.toFixed(2).includes(q);
      const keyMatch = (t.key || '').toLowerCase().includes(q);
      const albumMatch = (t.album || '').toLowerCase().includes(q);

      return titleMatch || artistMatch || bpmMatch || keyMatch || albumMatch;
    });
  }, [tracks, selectedFolder, browserSearchQuery]);

  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="bg-[#0a0b0d] border-t border-[#181920] flex flex-col select-none z-30">
      {/* Strip header with BROWSER angled tab and rekordbox logo */}
      <div className="h-7 bg-[#0d0e12] flex items-center justify-between px-3 border-b border-[#181a20]">
        {/* Left: BROWSER angled tab & Pioneer Rekordbox branding */}
        <div className="flex items-center space-x-3">
          {/* Angled polygon tab BROWSER */}
          <button
            onClick={onToggle}
            className="rb-tab-chamfer bg-[#181a22] text-neutral-300 hover:text-white text-[10px] font-bold px-4 py-1 tracking-wider uppercase flex items-center space-x-1.5 transition-colors"
          >
            <span>BROWSER</span>
            {isOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>

          {/* Pioneer Rekordbox bottom logo */}
          <div className="flex items-center space-x-1.5 opacity-80 hover:opacity-100 transition-opacity">
            <div className="w-3.5 h-3.5 rounded-full border border-neutral-300 flex items-center justify-center p-0.5">
              <div className="w-1.5 h-1.5 rounded-full bg-white"></div>
            </div>
            <span className="font-bold text-neutral-300 text-[11px] tracking-tight font-sans">
              rekordbox
            </span>
          </div>

          {/* Quick status label */}
          {isOpen && (
            <span className="text-[10.5px] text-neutral-400 font-mono pl-3 hidden sm:inline">
              Sammlung: <strong>{filteredTracks.length}</strong> Tracks
            </span>
          )}
        </div>

        {/* Right action tools: XML Track-Auswahl, XML Import, Audio Import */}
        <div className="flex items-center space-x-2 text-xs text-neutral-400">
          {onOpenXmlCollection && (
            <button
              onClick={onOpenXmlCollection}
              className="px-2.5 py-0.5 bg-[#181a24] hover:bg-[#0088ff] hover:text-white text-neutral-300 border border-[#2b2e3e] rounded-xs text-[10.5px] transition-colors flex items-center space-x-1.5"
              title="Rekordbox XML Track-Auswahl mit Suchleiste im Pop-up öffnen"
            >
              <Disc size={12} className="text-[#00e5ff]" />
              <span className="font-semibold text-white">XML Track-Auswahl (Pop-up)</span>
            </button>
          )}

          <button
            onClick={onImportXml}
            className="px-2 py-0.5 bg-[#16171e] hover:bg-[#20222b] hover:text-white border border-[#262835] rounded-xs text-[10.5px] transition-colors flex items-center space-x-1"
            title="Rekordbox XML importieren"
          >
            <Upload size={11} />
            <span>XML Import</span>
          </button>

          <button
            onClick={onImportAudio}
            className="px-2 py-0.5 bg-[#16171e] hover:bg-[#20222b] hover:text-white border border-[#262835] rounded-xs text-[10.5px] transition-colors flex items-center space-x-1"
            title="Audio-Datei (WAV, MP3, FLAC) importieren"
          >
            <FileAudio size={11} />
            <span>Audio Import</span>
          </button>

          <button
            onClick={onToggle}
            className="p-1 hover:text-white transition-colors"
            title={isOpen ? 'Browser einklappen' : 'Browser aufklappen'}
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
      </div>

      {/* Expanded Browser Content (Pioneer Rekordbox Collection View) */}
      {isOpen && (
        <div className="h-56 bg-[#0b0c0f] flex border-t border-[#14151a] overflow-hidden text-xs">
          {/* Left Tree Navigator */}
          <div className="w-52 bg-[#0d0e13] border-r border-[#1a1c25] p-2 flex flex-col space-y-1 overflow-y-auto select-none flex-shrink-0">
            <div className="text-[10px] text-neutral-500 font-bold uppercase tracking-wider px-2 py-1">
              Bibliothek
            </div>

            <button
              onClick={() => setSelectedFolder('ALL')}
              className={`w-full text-left px-2 py-1 rounded-xs flex items-center space-x-2 text-[11px] transition-colors ${
                selectedFolder === 'ALL'
                  ? 'bg-[#0088ff]/20 text-[#00a2ff] font-semibold border-l-2 border-[#0088ff]'
                  : 'text-neutral-300 hover:bg-[#151720]'
              }`}
            >
              {selectedFolder === 'ALL' ? (
                <FolderOpen size={13} className="text-[#00a2ff]" />
              ) : (
                <Folder size={13} className="text-neutral-500" />
              )}
              <span>Sammlung (Alle)</span>
              <span className="ml-auto text-[9.5px] font-mono text-neutral-500">{tracks.length}</span>
            </button>

            <button
              onClick={() => setSelectedFolder('XML')}
              className={`w-full text-left px-2 py-1 rounded-xs flex items-center space-x-2 text-[11px] transition-colors ${
                selectedFolder === 'XML'
                  ? 'bg-[#0088ff]/20 text-[#00a2ff] font-semibold border-l-2 border-[#0088ff]'
                  : 'text-neutral-300 hover:bg-[#151720]'
              }`}
            >
              <Disc size={13} className={selectedFolder === 'XML' ? 'text-[#00e5ff]' : 'text-neutral-500'} />
              <span>Rekordbox XML</span>
              <span className="ml-auto text-[9.5px] font-mono text-neutral-500">
                {tracks.filter((t) => t.origin === 'REKORDBOX_XML').length}
              </span>
            </button>

            <button
              onClick={() => setSelectedFolder('AUDIO')}
              className={`w-full text-left px-2 py-1 rounded-xs flex items-center space-x-2 text-[11px] transition-colors ${
                selectedFolder === 'AUDIO'
                  ? 'bg-[#0088ff]/20 text-[#00a2ff] font-semibold border-l-2 border-[#0088ff]'
                  : 'text-neutral-300 hover:bg-[#151720]'
              }`}
            >
              <FileAudio size={13} className={selectedFolder === 'AUDIO' ? 'text-[#00a2ff]' : 'text-neutral-500'} />
              <span>Audio-Dateien</span>
              <span className="ml-auto text-[9.5px] font-mono text-neutral-500">
                {tracks.filter((t) => t.origin === 'LOCAL_ANALYSIS').length}
              </span>
            </button>

            <button
              onClick={() => setSelectedFolder('PLAYLIST')}
              className={`w-full text-left px-2 py-1 rounded-xs flex items-center space-x-2 text-[11px] transition-colors ${
                selectedFolder === 'PLAYLIST'
                  ? 'bg-[#0088ff]/20 text-[#00a2ff] font-semibold border-l-2 border-[#0088ff]'
                  : 'text-neutral-300 hover:bg-[#151720]'
              }`}
            >
              <ListMusic size={13} className="text-neutral-500" />
              <span>Vorbereitung (Edit)</span>
            </button>
          </div>

          {/* Right Main Area: Search Bar + Track Table */}
          <div className="flex-1 flex flex-col min-w-0 bg-[#0c0d12]">
            {/* Search filter toolbar */}
            <div className="h-8 bg-[#11131a] border-b border-[#1c1e27] px-3 flex items-center justify-between flex-shrink-0">
              <div className="relative w-72">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
                <input
                  type="text"
                  value={browserSearchQuery}
                  onChange={(e) => setBrowserSearchQuery(e.target.value)}
                  placeholder="In Sammlung suchen (Titel, Artist, BPM...)"
                  className="w-full bg-[#0a0b0e] border border-[#232533] focus:border-[#0088ff] rounded-xs pl-7 pr-6 py-0.5 text-[11px] text-white placeholder-neutral-500 focus:outline-none"
                />
                {browserSearchQuery && (
                  <button
                    onClick={() => setBrowserSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>

              <div className="text-[10.5px] text-neutral-400 font-mono">
                Doppelklick zum Laden in Deck
              </div>
            </div>

            {/* Track Table */}
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-[#14161f] border-b border-[#202330] text-[10px] text-neutral-400 sticky top-0 z-10 font-bold uppercase tracking-wider select-none">
                  <tr>
                    <th className="py-1.5 px-3 w-10 text-center">#</th>
                    <th className="py-1.5 px-3">TITEL</th>
                    <th className="py-1.5 px-3">INTERPRET</th>
                    <th className="py-1.5 px-3 w-20 text-right">BPM</th>
                    <th className="py-1.5 px-3 w-16 text-center">KEY</th>
                    <th className="py-1.5 px-3 w-18 text-center">ZEIT</th>
                    <th className="py-1.5 px-3 w-24 text-center">MEMORY CUES</th>
                    <th className="py-1.5 px-3 w-28 text-right">AKTION</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#151722]">
                  {filteredTracks.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="text-center py-8 text-neutral-500 text-xs">
                        Keine Tracks in der ausgewählten Ansicht gefunden.
                      </td>
                    </tr>
                  ) : (
                    filteredTracks.map((t, idx) => {
                      const isActive = t.id === activeTrackId;
                      const memCuesCount = t.cues.filter((c) => c.type === 'MEMORY').length;

                      return (
                        <tr
                          key={t.id}
                          onClick={() => onSelectTrack(t.id)}
                          onDoubleClick={() => onSelectTrack(t.id)}
                          className={`cursor-pointer transition-colors group text-xs ${
                            isActive
                              ? 'bg-[#0088ff]/15 border-l-2 border-[#0088ff]'
                              : 'hover:bg-[#141622]'
                          }`}
                        >
                          {/* Index */}
                          <td className="py-2 px-3 text-center text-[10.5px] font-mono text-neutral-400">
                            {idx + 1}
                          </td>

                          {/* Title */}
                          <td className="py-2 px-3">
                            <div className="flex items-center space-x-2">
                              <Music
                                size={12}
                                className={isActive ? 'text-[#0088ff]' : 'text-neutral-500'}
                              />
                              <span className={`font-semibold ${isActive ? 'text-white' : 'text-neutral-200'} group-hover:text-white`}>
                                {t.title}
                              </span>
                              {t.audioBuffer ? (
                                <span className="px-1.5 py-0.2 rounded-xs bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[9px] font-mono">
                                  AUDIO
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.2 rounded-xs bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[9px] font-mono" title="Originalaudiodatei noch nicht verknüpft">
                                  KEIN AUDIO
                                </span>
                              )}
                              {isActive && (
                                <span className="px-1.5 py-0.2 rounded-xs bg-[#0088ff]/30 text-[#00a2ff] border border-[#0088ff]/40 text-[9px] font-mono font-bold">
                                  IM DECK
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Artist */}
                          <td className="py-2 px-3 text-neutral-300 text-[11px]">
                            {t.artist || 'Unbekannt'}
                          </td>

                          {/* BPM */}
                          <td className="py-2 px-3 text-right font-mono font-bold text-[#00a2ff] text-[11.5px]">
                            {t.bpm.toFixed(2)}
                          </td>

                          {/* Key */}
                          <td className="py-2 px-3 text-center">
                            <span className="px-1.5 py-0.5 rounded-xs bg-[#1a1c26] text-neutral-200 font-mono text-[10px]">
                              {t.key || '--'}
                            </span>
                          </td>

                          {/* Time */}
                          <td className="py-2 px-3 text-center font-mono text-neutral-400 text-[11px]">
                            {formatTime(t.duration)}
                          </td>

                          {/* Memory Cues count */}
                          <td className="py-2 px-3 text-center">
                            {memCuesCount > 0 ? (
                              <span className="px-1.5 py-0.5 rounded-xs bg-[#ff2222]/20 border border-[#ff2222]/40 text-[#ff6666] font-mono text-[10px] font-bold">
                                {memCuesCount} MEM
                              </span>
                            ) : (
                              <span className="text-neutral-600 text-[10px]">-</span>
                            )}
                          </td>

                          {/* Load button */}
                          <td className="py-2 px-3 text-right">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectTrack(t.id);
                              }}
                              className={`px-2.5 py-1 rounded-xs font-semibold text-[10.5px] transition-colors inline-flex items-center space-x-1 ${
                                isActive
                                  ? 'bg-[#00c853]/20 text-[#00e676] border border-[#00c853]/40'
                                  : 'bg-[#1e212e] hover:bg-[#0088ff] text-neutral-200 hover:text-white border border-[#2c3042]'
                              }`}
                            >
                              {isActive ? (
                                <>
                                  <Check size={11} />
                                  <span>Geladen</span>
                                </>
                              ) : (
                                <>
                                  <Play size={10} fill="currentColor" />
                                  <span>In Deck</span>
                                </>
                              )}
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
