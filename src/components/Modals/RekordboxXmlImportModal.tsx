/**
 * @license
 * Rekordbox XML Track Selection Modal
 * Displays imported XML tracks in an interactive searchable list/table with
 * instant search filter, sorting, cue inspection, and direct deck loading.
 */

import React, { useState, useMemo } from 'react';
import {
  X,
  Search,
  Music,
  Play,
  Clock,
  Tag,
  Disc,
  Filter,
  Check,
  ArrowUpDown,
  ListFilter,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { TrackModel, CuePoint } from '../../types/rekordbox';

export interface RekordboxXmlImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  xmlTracks: TrackModel[];
  fileName?: string;
  onSelectTrack: (track: TrackModel) => void;
  currentTrackId?: string;
}

type SortField = 'title' | 'artist' | 'bpm' | 'key' | 'duration' | 'memoryCues' | 'id';
type SortOrder = 'asc' | 'desc';
type CueFilter = 'all' | 'hasMemory' | 'hasHotCue' | 'hasLoops';

export const RekordboxXmlImportModal: React.FC<RekordboxXmlImportModalProps> = ({
  isOpen,
  onClose,
  xmlTracks,
  fileName = 'Rekordbox XML Collection',
  onSelectTrack,
  currentTrackId,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTrackId, setSelectedTrackId] = useState<string>(
    xmlTracks.length > 0 ? (currentTrackId || xmlTracks[0].id) : ''
  );
  const [sortField, setSortField] = useState<SortField>('id');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [cueFilter, setCueFilter] = useState<CueFilter>('all');
  const [visibleTrackLimit, setVisibleTrackLimit] = useState(200);
  const [sourceStatus, setSourceStatus] = useState<{
    kind: 'NOT_PROVIDED' | 'CHECKING' | 'AVAILABLE' | 'MISSING' | 'UNAVAILABLE';
    detail: string;
  }>({ kind: 'NOT_PROVIDED', detail: 'Keine XML-Location hinterlegt.' });

  // Update selectedTrackId when tracks change or modal opens
  React.useEffect(() => {
    if (xmlTracks.length > 0) {
      if (currentTrackId && xmlTracks.some((t) => t.id === currentTrackId)) {
        setSelectedTrackId(currentTrackId);
      } else if (!selectedTrackId || !xmlTracks.some((t) => t.id === selectedTrackId)) {
        setSelectedTrackId(xmlTracks[0].id);
      }
    }
  }, [xmlTracks, currentTrackId]);

  // Do not mount thousands of table rows at once. Search/sort still applies to
  // the complete collection, and the user can reveal additional pages.
  React.useEffect(() => {
    setVisibleTrackLimit(200);
  }, [searchQuery, cueFilter, sortField, sortOrder, xmlTracks]);

  // Format seconds to mm:ss
  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Format milliseconds to mm:ss.mmm
  const formatMsec = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  // Filtered & Sorted tracks
  const filteredTracks = useMemo(() => {
    return xmlTracks
      .filter((track) => {
        // Text search across multiple fields
        const query = searchQuery.trim().toLowerCase();
        if (query) {
          const matchTitle = track.title.toLowerCase().includes(query);
          const matchArtist = track.artist.toLowerCase().includes(query);
          const matchAlbum = (track.album || '').toLowerCase().includes(query);
          const matchGenre = (track.genre || '').toLowerCase().includes(query);
          const matchKey = (track.key || '').toLowerCase().includes(query);
          const matchBpm = track.bpm.toFixed(2).includes(query);
          const matchComments = (track.comments || '').toLowerCase().includes(query);

          if (!matchTitle && !matchArtist && !matchAlbum && !matchGenre && !matchKey && !matchBpm && !matchComments) {
            return false;
          }
        }

        // Cue filter
        if (cueFilter === 'hasMemory') {
          return track.cues.some((c) => c.type === 'MEMORY');
        }
        if (cueFilter === 'hasHotCue') {
          return track.cues.some((c) => c.type === 'HOT_CUE');
        }
        if (cueFilter === 'hasLoops') {
          return track.loops && track.loops.length > 0;
        }

        return true;
      })
      .sort((a, b) => {
        let cmp = 0;
        switch (sortField) {
          case 'title':
            cmp = a.title.localeCompare(b.title);
            break;
          case 'artist':
            cmp = a.artist.localeCompare(b.artist);
            break;
          case 'bpm':
            cmp = a.bpm - b.bpm;
            break;
          case 'key':
            cmp = (a.key || '').localeCompare(b.key || '');
            break;
          case 'duration':
            cmp = a.duration - b.duration;
            break;
          case 'memoryCues': {
            const memA = a.cues.filter((c) => c.type === 'MEMORY').length;
            const memB = b.cues.filter((c) => c.type === 'MEMORY').length;
            cmp = memA - memB;
            break;
          }
          case 'id':
          default: {
            const numA = parseInt(a.id, 10);
            const numB = parseInt(b.id, 10);
            cmp = !isNaN(numA) && !isNaN(numB) ? numA - numB : a.id.localeCompare(b.id);
            break;
          }
        }
        return sortOrder === 'asc' ? cmp : -cmp;
      });
  }, [xmlTracks, searchQuery, cueFilter, sortField, sortOrder]);

  const selectedTrack = useMemo(() => {
    return xmlTracks.find((t) => t.id === selectedTrackId) || filteredTracks[0] || null;
  }, [xmlTracks, selectedTrackId, filteredTracks]);

  const visibleTracks = useMemo(
    () => filteredTracks.slice(0, visibleTrackLimit),
    [filteredTracks, visibleTrackLimit]
  );

  React.useEffect(() => {
    const location = selectedTrack?.originalMedia?.location;
    let disposed = false;

    if (!location) {
      setSourceStatus({ kind: 'NOT_PROVIDED', detail: 'Keine XML-Location hinterlegt.' });
      return () => { disposed = true; };
    }

    if (!window.rekordboxDesktop) {
      setSourceStatus({
        kind: 'UNAVAILABLE',
        detail: 'Pfadprüfung ist in der Windows-Desktop-App verfügbar.',
      });
      return () => { disposed = true; };
    }

    setSourceStatus({ kind: 'CHECKING', detail: 'Originaldatei wird nur lesend geprüft...' });
    window.rekordboxDesktop.inspectLocation(location).then((result) => {
      if (disposed) return;
      if (result.exists) {
        setSourceStatus({ kind: 'AVAILABLE', detail: 'Originaldatei vorhanden – Zugriff nur lesend.' });
      } else {
        setSourceStatus({
          kind: 'MISSING',
          detail: result.reason || 'Originaldatei am XML-Pfad nicht gefunden.',
        });
      }
    }).catch(() => {
      if (!disposed) setSourceStatus({ kind: 'MISSING', detail: 'Originaldatei konnte nicht geprüft werden.' });
    });

    return () => { disposed = true; };
  }, [selectedTrack?.id, selectedTrack?.originalMedia?.location]);

  const handleSortToggle = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const handleLoadTrack = (track: TrackModel) => {
    onSelectTrack(track);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-50 select-none p-3 sm:p-5">
      <div className="w-full max-w-5xl bg-[#101116] border border-[#262834] rounded-sm shadow-2xl overflow-hidden flex flex-col max-h-[92vh] text-neutral-200 text-xs">
        {/* Modal Header */}
        <div className="h-10 bg-[#161720] border-b border-[#242735] flex items-center justify-between px-4 flex-shrink-0">
          <div className="flex items-center space-x-2.5">
            <Disc size={17} className="text-[#0088ff] animate-pulse" />
            <div>
              <span className="font-bold text-white text-xs tracking-wide">
                Rekordbox XML Track-Auswahl
              </span>
              <span className="text-[10.5px] text-neutral-400 ml-2 font-mono">
                {fileName} ({xmlTracks.length} Tracks in XML)
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors"
            title="Schließen"
          >
            <X size={15} />
          </button>
        </div>

        {/* Top Control Bar: Search input & Filters */}
        <div className="bg-[#13151c] border-b border-[#20222d] p-3 flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-center justify-between flex-shrink-0">
          {/* Search bar */}
          <div className="relative flex-1 max-w-xl">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tracks durchsuchen nach Titel, Interpret, BPM, Tonart, Album..."
              className="w-full bg-[#0a0b0e] border border-[#2b2e3d] focus:border-[#0088ff] rounded-xs pl-8 pr-8 py-1.5 text-xs text-white placeholder-neutral-500 focus:outline-none transition-colors"
              autoFocus
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-white"
                title="Suche zurücksetzen"
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Filter Chips */}
          <div className="flex items-center gap-1.5 overflow-x-auto text-[11px]">
            <button
              onClick={() => setCueFilter('all')}
              className={`px-2.5 py-1 rounded-xs border transition-colors whitespace-nowrap ${
                cueFilter === 'all'
                  ? 'bg-[#0088ff] text-white border-[#0088ff] font-semibold'
                  : 'bg-[#181a24] text-neutral-300 border-[#2b2e3c] hover:bg-[#202330]'
              }`}
            >
              Alle ({xmlTracks.length})
            </button>
            <button
              onClick={() => setCueFilter('hasMemory')}
              className={`px-2.5 py-1 rounded-xs border transition-colors whitespace-nowrap flex items-center space-x-1 ${
                cueFilter === 'hasMemory'
                  ? 'bg-[#ff2222] text-white border-[#ff2222] font-semibold'
                  : 'bg-[#181a24] text-neutral-300 border-[#2b2e3c] hover:bg-[#202330]'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#ff4444]" />
              <span>Mit Memory Cues</span>
            </button>
            <button
              onClick={() => setCueFilter('hasHotCue')}
              className={`px-2.5 py-1 rounded-xs border transition-colors whitespace-nowrap flex items-center space-x-1 ${
                cueFilter === 'hasHotCue'
                  ? 'bg-[#00a2ff] text-white border-[#00a2ff] font-semibold'
                  : 'bg-[#181a24] text-neutral-300 border-[#2b2e3c] hover:bg-[#202330]'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#00e5ff]" />
              <span>Mit Hot Cues</span>
            </button>
            <button
              onClick={() => setCueFilter('hasLoops')}
              className={`px-2.5 py-1 rounded-xs border transition-colors whitespace-nowrap flex items-center space-x-1 ${
                cueFilter === 'hasLoops'
                  ? 'bg-[#ff9500] text-white border-[#ff9500] font-semibold'
                  : 'bg-[#181a24] text-neutral-300 border-[#2b2e3c] hover:bg-[#202330]'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#ffb74d]" />
              <span>Mit Loops</span>
            </button>
          </div>
        </div>

        {/* Main Content Area: Table of Tracks + Details Preview */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Track Table */}
          <div className="flex-1 overflow-y-auto bg-[#0c0d12]">
            {filteredTracks.length === 0 ? (
              <div className="p-12 text-center text-neutral-500">
                <Search size={32} className="mx-auto mb-3 opacity-40 text-neutral-400" />
                <p className="text-sm text-neutral-300 font-medium">Keine passenden Tracks gefunden</p>
                <p className="text-xs text-neutral-500 mt-1">
                  Suchbegriff "{searchQuery}" ergab keine Übereinstimmungen.
                </p>
                <button
                  onClick={() => { setSearchQuery(''); setCueFilter('all'); }}
                  className="mt-3 px-3 py-1 bg-[#1a1c26] hover:bg-[#252838] border border-[#2b2e3e] rounded text-neutral-300 text-xs transition-colors"
                >
                  Filter zurücksetzen
                </button>
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead className="bg-[#151720] border-b border-[#222532] text-[10.5px] text-neutral-400 sticky top-0 z-10 select-none">
                  <tr>
                    <th
                      onClick={() => handleSortToggle('id')}
                      className="py-2 px-3 cursor-pointer hover:text-white w-12 text-center"
                    >
                      <div className="flex items-center justify-center space-x-1">
                        <span>#</span>
                        {sortField === 'id' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('title')}
                      className="py-2 px-3 cursor-pointer hover:text-white"
                    >
                      <div className="flex items-center space-x-1">
                        <span>TITEL</span>
                        {sortField === 'title' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('artist')}
                      className="py-2 px-3 cursor-pointer hover:text-white"
                    >
                      <div className="flex items-center space-x-1">
                        <span>INTERPRET</span>
                        {sortField === 'artist' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('bpm')}
                      className="py-2 px-3 cursor-pointer hover:text-white w-20 text-right"
                    >
                      <div className="flex items-center justify-end space-x-1">
                        <span>BPM</span>
                        {sortField === 'bpm' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('key')}
                      className="py-2 px-3 cursor-pointer hover:text-white w-16 text-center"
                    >
                      <div className="flex items-center justify-center space-x-1">
                        <span>KEY</span>
                        {sortField === 'key' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('duration')}
                      className="py-2 px-3 cursor-pointer hover:text-white w-20 text-center"
                    >
                      <div className="flex items-center justify-center space-x-1">
                        <span>ZEIT</span>
                        {sortField === 'duration' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('memoryCues')}
                      className="py-2 px-3 cursor-pointer hover:text-white w-28 text-center"
                    >
                      <div className="flex items-center justify-center space-x-1">
                        <span>CUES & LOOPS</span>
                        {sortField === 'memoryCues' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th className="py-2 px-3 w-32 text-right">
                      <span>DECK AKTION</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#171922]">
                  {visibleTracks.map((tr, idx) => {
                    const isSelected = tr.id === selectedTrackId;
                    const memCuesCount = tr.cues.filter((c) => c.type === 'MEMORY').length;
                    const hotCuesCount = tr.cues.filter((c) => c.type === 'HOT_CUE').length;
                    const isCurrentlyInDeck = tr.id === currentTrackId;

                    return (
                      <tr
                        key={tr.id}
                        onClick={() => setSelectedTrackId(tr.id)}
                        onDoubleClick={() => handleLoadTrack(tr)}
                        className={`cursor-pointer transition-colors group ${
                          isSelected
                            ? 'bg-[#0088ff]/15 border-l-2 border-[#0088ff]'
                            : 'hover:bg-[#151722]'
                        }`}
                      >
                        {/* Track ID / Index */}
                        <td className="py-2.5 px-3 text-center text-[11px] font-mono text-neutral-400">
                          {tr.id || idx + 1}
                        </td>

                        {/* Title */}
                        <td className="py-2.5 px-3">
                          <div className="font-semibold text-neutral-100 group-hover:text-white flex items-center space-x-2">
                            <span>{tr.title}</span>
                            {isCurrentlyInDeck && (
                              <span className="px-1.5 py-0.2 bg-[#0088ff]/30 text-[#00a2ff] border border-[#0088ff]/40 rounded-xs text-[9px] font-mono font-bold">
                                IM DECK
                              </span>
                            )}
                          </div>
                          {tr.album && (
                            <div className="text-[10px] text-neutral-500 truncate max-w-xs">
                              {tr.album}
                            </div>
                          )}
                        </td>

                        {/* Artist */}
                        <td className="py-2.5 px-3 text-neutral-300">
                          {tr.artist || 'Unbekannt'}
                        </td>

                        {/* BPM */}
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-white text-[11.5px]">
                          {tr.bpm.toFixed(2)}
                        </td>

                        {/* Key */}
                        <td className="py-2.5 px-3 text-center">
                          <span className="px-1.5 py-0.5 rounded-xs bg-[#1f2230] border border-[#2f3348] text-neutral-200 font-mono text-[10.5px]">
                            {tr.key || '--'}
                          </span>
                        </td>

                        {/* Time */}
                        <td className="py-2.5 px-3 text-center font-mono text-neutral-300">
                          {formatTime(tr.duration)}
                        </td>

                        {/* Memory Cues / Hot Cues tags */}
                        <td className="py-2.5 px-3 text-center">
                          <div className="flex items-center justify-center space-x-1.5">
                            {memCuesCount > 0 ? (
                              <span className="px-1.5 py-0.5 rounded-xs bg-[#ff2222]/20 border border-[#ff2222]/40 text-[#ff6666] font-mono text-[10px] font-bold">
                                {memCuesCount} MEM
                              </span>
                            ) : (
                              <span className="text-neutral-600 text-[10px]">-</span>
                            )}

                            {hotCuesCount > 0 && (
                              <span className="px-1.5 py-0.5 rounded-xs bg-[#00a2ff]/20 border border-[#00a2ff]/40 text-[#00b4ff] font-mono text-[10px] font-bold">
                                {hotCuesCount} HOT
                              </span>
                            )}

                            {tr.loops && tr.loops.length > 0 && (
                              <span className="px-1.5 py-0.5 rounded-xs bg-[#ff9500]/20 border border-[#ff9500]/40 text-[#ffaa33] font-mono text-[10px] font-bold">
                                {tr.loops.length} LOOP
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Action: In Deck laden */}
                        <td className="py-2.5 px-3 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleLoadTrack(tr);
                            }}
                            className="px-2.5 py-1 bg-[#0088ff] hover:bg-[#0070d6] active:bg-[#005bb5] text-white rounded-xs font-semibold text-[11px] shadow-sm transition-colors inline-flex items-center space-x-1.5"
                            title="Diesen Track in das DJ-Deck laden"
                          >
                            <Play size={11} fill="currentColor" />
                            <span>In Deck laden</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Selected Track Deep Preview Panel */}
          {selectedTrack && (
            <div className="border-t border-[#222533] bg-[#0e0f14] p-3 flex flex-col sm:flex-row gap-3 items-start justify-between flex-shrink-0 text-xs">
              {/* Left Column: Metadata summary */}
              <div className="space-y-1 min-w-[280px]">
                <div className="flex items-center space-x-2">
                  <Music size={13} className="text-[#0088ff]" />
                  <span className="font-bold text-white text-xs">{selectedTrack.title}</span>
                  <span className="text-neutral-400 font-mono text-[10.5px]">({selectedTrack.artist})</span>
                </div>
                <div className="flex items-center space-x-3 text-[11px] text-neutral-400 font-mono">
                  <span>BPM: <strong className="text-white">{selectedTrack.bpm.toFixed(2)}</strong></span>
                  <span>•</span>
                  <span>Tonart: <strong className="text-[#00e5ff]">{selectedTrack.key || '2A'}</strong></span>
                  <span>•</span>
                  <span>Dauer: <strong className="text-white">{formatTime(selectedTrack.duration)}</strong></span>
                  <span>•</span>
                  <span>Sample Rate: <strong className="text-neutral-300">{selectedTrack.sampleRate || 44100} Hz</strong></span>
                </div>
                {selectedTrack.comments && (
                  <p className="text-[10px] text-neutral-500 italic max-w-md truncate">
                    Kommentar: {selectedTrack.comments}
                  </p>
                )}
                <div className={`text-[10px] font-mono ${
                  sourceStatus.kind === 'AVAILABLE'
                    ? 'text-[#34d399]'
                    : sourceStatus.kind === 'MISSING'
                    ? 'text-[#fbbf24]'
                    : 'text-neutral-500'
                }`}>
                  ORIGINAL: {sourceStatus.detail}
                </div>
              </div>

              {/* Center/Right: Extracted Memory Cues preview */}
              <div className="flex-1 overflow-x-auto w-full">
                <div className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider mb-1 flex items-center justify-between">
                  <span>Enthaltene Cues ({selectedTrack.cues.length}):</span>
                  <span className="text-[9px] text-neutral-500 font-normal">
                    Doppelklick auf Track lädt direkt in Deck
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-16 overflow-y-auto">
                  {selectedTrack.cues.length === 0 ? (
                    <span className="text-neutral-500 text-[10.5px] italic">Keine Cues in diesem Track definiert</span>
                  ) : (
                    selectedTrack.cues.map((c) => (
                      <div
                        key={c.id}
                        className="px-2 py-0.5 rounded-xs bg-[#171922] border border-[#272a38] text-[10.5px] font-mono flex items-center space-x-1.5"
                      >
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: c.color || (c.type === 'MEMORY' ? '#ff2222' : '#00a2ff') }}
                        />
                        <span className="font-semibold text-neutral-200">
                          {c.name || (c.type === 'MEMORY' ? 'MEM' : `HOT ${c.letter || ''}`)}
                        </span>
                        <span className="text-neutral-500 text-[9.5px]">
                          {formatMsec(c.position)}
                        </span>
                        {c.barNumber && (
                          <span className="text-neutral-400 text-[9px]">
                            [T{c.barNumber}:{c.beatNumber || 1}]
                          </span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="h-11 bg-[#14161f] border-t border-[#222533] px-4 flex items-center justify-between flex-shrink-0">
          <div className="text-[11px] text-neutral-400 flex items-center space-x-2">
            <span>
              Zeige <strong>{visibleTracks.length}</strong> von <strong>{filteredTracks.length}</strong> Treffern
            </span>
            {searchQuery && (
              <span className="text-neutral-500 font-mono text-[10px]">
                (Gefiltert nach "{searchQuery}")
              </span>
            )}
          </div>

          <div className="flex items-center space-x-2.5">
            {visibleTracks.length < filteredTracks.length && (
              <button
                onClick={() => setVisibleTrackLimit((limit) => limit + 200)}
                className="px-3.5 py-1.5 bg-[#1a1c26] hover:bg-[#252838] border border-[#2c3040] text-neutral-300 hover:text-white rounded-xs text-xs transition-colors"
              >
                Weitere 200 anzeigen
              </button>
            )}
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 bg-[#1a1c26] hover:bg-[#252838] border border-[#2c3040] text-neutral-300 hover:text-white rounded-xs text-xs transition-colors"
            >
              Schließen
            </button>
            {selectedTrack && (
              <button
                onClick={() => handleLoadTrack(selectedTrack)}
                className="px-4 py-1.5 bg-[#0088ff] hover:bg-[#0070d6] active:bg-[#005bb5] text-white rounded-xs font-bold text-xs shadow-md transition-colors flex items-center space-x-1.5"
              >
                <Play size={12} fill="currentColor" />
                <span>"{selectedTrack.title}" in Deck laden</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const XmlImportBrowserModal = RekordboxXmlImportModal;
export type XmlImportBrowserModalProps = RekordboxXmlImportModalProps;
