/**
 * @license
 * Rekordbox BROWSER Component (Pioneer Rekordbox Library & Matching System)
 * 
 * Authentic Pioneer Rekordbox EDIT Mode Library Management System:
 * - "BROWSER" chamfered tab & "rekordbox" branding
 * - Left tree navigation (Collection, Linked Tracks/Matches, Harmonic Key, BPM Match, XML, Audio, Favorites)
 * - Intelligent search bar with instant filtering by Title, Artist, BPM, Key, Album, Genre, Comments, and Mix Notes
 * - Track Match / Link function: 2-way symmetric track linking with the active deck track
 * - Filtering specifically for linked tracks (both "with active track" and "all with links")
 * - Harmonic Camelot Key compatibility matching & badges
 * - BPM relative pitch shift percentages (±4%, ±6%, ±8%)
 * - Interactive 1-5 star ratings
 * - Sortable columns (Title, Artist, BPM, Key, Time, Cues, Rating, Match status)
 * - In-browser audio preview player
 * - Height toggles (Standard, Extended, Full-Screen)
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { beginDrag, endDrag } from '../dnd/dragPayload';
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
  Pause,
  Check,
  X,
  FileAudio,
  ListMusic,
  Link as LinkIcon,
  Link2,
  Unlink,
  Sparkles,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Maximize2,
  Minimize2,
  Star,
  MessageSquare,
  Flame,
  Volume2,
} from 'lucide-react';
import {
  loadTrackLinks,
  saveTrackLinks,
  areTracksLinked,
  getLinkedTrackIds,
  getAllLinkedTrackIds,
  toggleTrackLink,
  setTrackLinkNote,
  getLinkNote,
  getHarmonicCompatibility,
  getBpmRelation,
  TrackLink,
} from '../utils/trackLinks';
import { logger } from '../utils/logger';

export type BrowserFolder =
  | 'ALL'
  | 'MATCH_ACTIVE'
  | 'MATCH_ALL'
  | 'HARMONIC'
  | 'BPM_RANGE'
  | 'XML'
  | 'AUDIO'
  | 'FAVORITES';

export type SortColumn =
  | 'INDEX'
  | 'TITLE'
  | 'ARTIST'
  | 'BPM'
  | 'KEY'
  | 'TIME'
  | 'CUES'
  | 'RATING'
  | 'MATCH';

export type SortDirection = 'ASC' | 'DESC';

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

const RATINGS_STORAGE_KEY = 'airdox_track_ratings_v1';

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
  // Navigation & filtering state
  const [selectedFolder, setSelectedFolder] = useState<BrowserFolder>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterOnlyLinked, setFilterOnlyLinked] = useState<boolean>(false);
  const [filterHarmonic, setFilterHarmonic] = useState<boolean>(false);
  const [filterBpmRange, setFilterBpmRange] = useState<boolean>(false);
  const [filterOnlyWithAudio, setFilterOnlyWithAudio] = useState<boolean>(false);

  // Sorting state
  const [sortColumn, setSortColumn] = useState<SortColumn>('INDEX');
  const [sortDirection, setSortDirection] = useState<SortDirection>('ASC');

  // Height state: 'STANDARD' (250px), 'EXPANDED' (420px), 'FULL' (calc(100vh - 120px))
  const [viewHeight, setViewHeight] = useState<'STANDARD' | 'EXPANDED' | 'FULL'>('STANDARD');

  // Track Link / Match state
  const [trackLinks, setTrackLinks] = useState<TrackLink[]>([]);
  const [editingNoteTrackId, setEditingNoteTrackId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string>('');

  // Ratings state: { [trackId]: number }
  const [userRatings, setUserRatings] = useState<Record<string, number>>({});

  // Mini preview audio player state
  const [previewTrackId, setPreviewTrackId] = useState<string | null>(null);
  const previewAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const previewAudioContextRef = useRef<AudioContext | null>(null);

  // Load saved links & ratings on mount
  useEffect(() => {
    setTrackLinks(loadTrackLinks());
    try {
      const raw = localStorage.getItem(RATINGS_STORAGE_KEY);
      if (raw) {
        setUserRatings(JSON.parse(raw));
      }
    } catch {
      // ignore
    }
  }, []);

  // Stop preview audio when unmounted
  useEffect(() => {
    return () => {
      stopAudioPreview();
    };
  }, []);

  const activeTrack = useMemo(() => {
    return tracks.find((t) => t.id === activeTrackId) || null;
  }, [tracks, activeTrackId]);

  const activeTrackLinkedIds = useMemo(() => {
    return getLinkedTrackIds(activeTrackId, trackLinks);
  }, [activeTrackId, trackLinks]);

  const allLinkedIdsSet = useMemo(() => {
    return getAllLinkedTrackIds(trackLinks);
  }, [trackLinks]);

  // Audio Preview playback
  const stopAudioPreview = () => {
    if (previewAudioSourceRef.current) {
      try {
        previewAudioSourceRef.current.stop();
        previewAudioSourceRef.current.disconnect();
      } catch {
        // ignore
      }
      previewAudioSourceRef.current = null;
    }
    setPreviewTrackId(null);
  };

  const handleTogglePreview = (track: TrackModel) => {
    if (!track.audioBuffer) return;

    if (previewTrackId === track.id) {
      stopAudioPreview();
      return;
    }

    stopAudioPreview();

    try {
      if (!previewAudioContextRef.current) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        previewAudioContextRef.current = new AudioCtx();
      }
      const ctx = previewAudioContextRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const source = ctx.createBufferSource();
      source.buffer = track.audioBuffer;

      const gain = ctx.createGain();
      gain.gain.value = 0.7;

      source.connect(gain);
      gain.connect(ctx.destination);

      source.onended = () => {
        if (previewTrackId === track.id) {
          setPreviewTrackId(null);
        }
      };

      source.start(0);
      previewAudioSourceRef.current = source;
      setPreviewTrackId(track.id);
    } catch (err) {
      logger.warn('AUDIO_ENGINE', 'Vorschau-Wiedergabe fehlgeschlagen:', err);
    }
  };

  // Toggle link with active track
  const handleToggleLink = (targetTrackId: string) => {
    if (!activeTrackId) {
      logger.warn('UI', 'Kein Track im Deck geladen, um Verknüpfung zu erstellen.');
      return;
    }
    const updated = toggleTrackLink(activeTrackId, targetTrackId, trackLinks);
    setTrackLinks(updated);
  };

  // Save link note
  const handleSaveNote = (targetTrackId: string) => {
    if (!activeTrackId) return;
    const updated = setTrackLinkNote(activeTrackId, targetTrackId, trackLinks, noteDraft);
    setTrackLinks(updated);
    setEditingNoteTrackId(null);
    setNoteDraft('');
  };

  // Rating update
  const handleSetRating = (trackId: string, rating: number) => {
    setUserRatings((prev) => {
      const next = { ...prev, [trackId]: prev[trackId] === rating ? 0 : rating };
      try {
        localStorage.setItem(RATINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  // Column sorting handler
  const handleHeaderClick = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortDirection((prev) => (prev === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortColumn(col);
      setSortDirection(col === 'BPM' || col === 'RATING' || col === 'CUES' || col === 'MATCH' ? 'DESC' : 'ASC');
    }
  };

  // Master Filter & Sort pipeline
  const filteredAndSortedTracks = useMemo(() => {
    // 1. Filter
    const filtered = tracks.filter((t) => {
      const isLinkedWithActive = activeTrackId ? areTracksLinked(activeTrackId, t.id, trackLinks) : false;
      const hasAnyLink = allLinkedIdsSet.has(t.id);
      const rating = userRatings[t.id] ?? t.rating ?? 0;

      // Tree Folder Filtering
      if (selectedFolder === 'MATCH_ACTIVE') {
        if (!isLinkedWithActive) return false;
      } else if (selectedFolder === 'MATCH_ALL') {
        if (!hasAnyLink) return false;
      } else if (selectedFolder === 'HARMONIC') {
        if (!activeTrack) return false;
        const harm = getHarmonicCompatibility(activeTrack.key, t.key);
        if (!harm.isCompatible) return false;
      } else if (selectedFolder === 'BPM_RANGE') {
        if (!activeTrack) return false;
        const bpmRel = getBpmRelation(activeTrack.bpm, t.bpm);
        if (!bpmRel.isWithinPct(6)) return false;
      } else if (selectedFolder === 'XML') {
        if (t.origin !== 'REKORDBOX_XML') return false;
      } else if (selectedFolder === 'AUDIO') {
        if (t.origin !== 'LOCAL_ANALYSIS' && !t.audioBuffer) return false;
      } else if (selectedFolder === 'FAVORITES') {
        if (rating < 4) return false;
      }

      // Quick Chips Filtering
      if (filterOnlyLinked && !hasAnyLink) return false;
      if (filterHarmonic) {
        if (!activeTrack) return false;
        const harm = getHarmonicCompatibility(activeTrack.key, t.key);
        if (!harm.isCompatible) return false;
      }
      if (filterBpmRange) {
        if (!activeTrack) return false;
        const bpmRel = getBpmRelation(activeTrack.bpm, t.bpm);
        if (!bpmRel.isWithinPct(6)) return false;
      }
      if (filterOnlyWithAudio && !t.audioBuffer) return false;

      // Text Search Query Filtering
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;

      const linkNote = activeTrackId ? getLinkNote(activeTrackId, t.id, trackLinks) : '';
      const titleMatch = t.title.toLowerCase().includes(q);
      const artistMatch = (t.artist || '').toLowerCase().includes(q);
      const bpmMatch = t.bpm.toFixed(2).includes(q);
      const keyMatch = (t.key || '').toLowerCase().includes(q);
      const albumMatch = (t.album || '').toLowerCase().includes(q);
      const genreMatch = (t.genre || '').toLowerCase().includes(q);
      const commentsMatch = (t.comments || '').toLowerCase().includes(q);
      const noteMatch = (linkNote || '').toLowerCase().includes(q);

      return (
        titleMatch ||
        artistMatch ||
        bpmMatch ||
        keyMatch ||
        albumMatch ||
        genreMatch ||
        commentsMatch ||
        noteMatch
      );
    });

    // 2. Sort
    return [...filtered].sort((a, b) => {
      let comparison = 0;
      switch (sortColumn) {
        case 'TITLE':
          comparison = a.title.localeCompare(b.title);
          break;
        case 'ARTIST':
          comparison = (a.artist || '').localeCompare(b.artist || '');
          break;
        case 'BPM':
          comparison = a.bpm - b.bpm;
          break;
        case 'KEY':
          comparison = (a.key || '').localeCompare(b.key || '');
          break;
        case 'TIME':
          comparison = a.duration - b.duration;
          break;
        case 'CUES': {
          const cuesA = a.cues.filter((c) => c.type === 'MEMORY').length;
          const cuesB = b.cues.filter((c) => c.type === 'MEMORY').length;
          comparison = cuesA - cuesB;
          break;
        }
        case 'RATING': {
          const ratA = userRatings[a.id] ?? a.rating ?? 0;
          const ratB = userRatings[b.id] ?? b.rating ?? 0;
          comparison = ratA - ratB;
          break;
        }
        case 'MATCH': {
          const aLinkedWithActive = activeTrackId ? areTracksLinked(activeTrackId, a.id, trackLinks) : false;
          const bLinkedWithActive = activeTrackId ? areTracksLinked(activeTrackId, b.id, trackLinks) : false;
          if (aLinkedWithActive && !bLinkedWithActive) comparison = 1;
          else if (!aLinkedWithActive && bLinkedWithActive) comparison = -1;
          else {
            const countA = getLinkedTrackIds(a.id, trackLinks).length;
            const countB = getLinkedTrackIds(b.id, trackLinks).length;
            comparison = countA - countB;
          }
          break;
        }
        case 'INDEX':
        default:
          comparison = 0;
          break;
      }
      return sortDirection === 'ASC' ? comparison : -comparison;
    });
  }, [
    tracks,
    selectedFolder,
    searchQuery,
    filterOnlyLinked,
    filterHarmonic,
    filterBpmRange,
    filterOnlyWithAudio,
    sortColumn,
    sortDirection,
    activeTrackId,
    activeTrack,
    trackLinks,
    allLinkedIdsSet,
    userRatings,
  ]);

  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getContainerHeightClass = () => {
    if (viewHeight === 'FULL') return 'h-[calc(100vh-140px)]';
    if (viewHeight === 'EXPANDED') return 'h-96';
    return 'h-64';
  };

  const renderSortIndicator = (col: SortColumn) => {
    if (sortColumn !== col) {
      return <ArrowUpDown size={10} className="ml-1 opacity-25 group-hover:opacity-60" />;
    }
    return sortDirection === 'ASC' ? (
      <ArrowUp size={11} className="ml-1 text-[#00a2ff]" />
    ) : (
      <ArrowDown size={11} className="ml-1 text-[#00a2ff]" />
    );
  };

  return (
    <div className="bg-[#0b0c10] border-t border-[#1a1d26] flex flex-col select-none z-30 shadow-2xl">
      {/* Strip header with BROWSER angled tab and rekordbox logo */}
      <div className="h-7.5 bg-[#0f1117] flex items-center justify-between px-3 border-b border-[#1c1f2a]">
        {/* Left: BROWSER angled tab & Pioneer Rekordbox branding */}
        <div className="flex items-center space-x-3">
          {/* Angled polygon tab BROWSER */}
          <button
            onClick={onToggle}
            className="rb-tab-chamfer bg-[#1a1d28] hover:bg-[#252a3a] text-neutral-200 hover:text-white text-[10px] font-bold px-4 py-1 tracking-wider uppercase flex items-center space-x-1.5 transition-colors border-r border-[#2d3345]"
            title="Browser ein-/ausklappen [Taste: B]"
          >
            <span>BROWSER</span>
            {isOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>

          {/* Pioneer Rekordbox bottom logo */}
          <div className="flex items-center space-x-1.5 opacity-90 hover:opacity-100 transition-opacity">
            <div className="w-3.5 h-3.5 rounded-full border border-neutral-400 flex items-center justify-center p-0.5">
              <div className="w-1.5 h-1.5 rounded-full bg-white"></div>
            </div>
            <span className="font-bold text-neutral-200 text-[11px] tracking-tight font-sans">
              rekordbox
            </span>
          </div>

          {/* Quick status label */}
          {isOpen && (
            <div className="flex items-center space-x-2 pl-2">
              <span className="text-[10px] text-neutral-400 font-mono hidden sm:inline">
                Sammlung: <strong className="text-white">{tracks.length}</strong> Tracks
              </span>
              <span className="text-[10px] text-neutral-500 font-mono hidden md:inline">•</span>
              <span className="text-[10px] text-neutral-400 font-mono hidden md:inline">
                Gefiltert: <strong className="text-[#00a2ff]">{filteredAndSortedTracks.length}</strong>
              </span>
              {allLinkedIdsSet.size > 0 && (
                <span className="px-1.5 py-0.2 rounded-xs bg-[#0088ff]/15 text-[#00c8ff] border border-[#0088ff]/30 text-[9px] font-mono flex items-center space-x-1">
                  <Link2 size={9} />
                  <span>{trackLinks.length} Verknüpfungen</span>
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right action tools */}
        <div className="flex items-center space-x-2 text-xs text-neutral-400">
          {isOpen && (
            <div className="flex items-center space-x-1 mr-2 border-r border-[#202330] pr-2">
              <button
                onClick={() => setViewHeight('STANDARD')}
                className={`px-1.5 py-0.5 text-[9.5px] rounded-xs font-mono transition-colors ${
                  viewHeight === 'STANDARD'
                    ? 'bg-[#0088ff]/30 text-[#00a2ff] font-bold border border-[#0088ff]/50'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Standardhöhe (260px)"
              >
                Klein
              </button>
              <button
                onClick={() => setViewHeight('EXPANDED')}
                className={`px-1.5 py-0.5 text-[9.5px] rounded-xs font-mono transition-colors ${
                  viewHeight === 'EXPANDED'
                    ? 'bg-[#0088ff]/30 text-[#00a2ff] font-bold border border-[#0088ff]/50'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Erweiterte Ansicht (400px)"
              >
                Mittel
              </button>
              <button
                onClick={() => setViewHeight((prev) => (prev === 'FULL' ? 'STANDARD' : 'FULL'))}
                className={`px-1.5 py-0.5 text-[9.5px] rounded-xs font-mono transition-colors flex items-center space-x-1 ${
                  viewHeight === 'FULL'
                    ? 'bg-[#0088ff] text-white font-bold'
                    : 'text-neutral-400 hover:text-white'
                }`}
                title="Vollbild / Großes Library-Management"
              >
                {viewHeight === 'FULL' ? <Minimize2 size={10} /> : <Maximize2 size={10} />}
                <span>Max</span>
              </button>
            </div>
          )}

          {onOpenXmlCollection && (
            <button
              onClick={onOpenXmlCollection}
              className="px-2.5 py-0.5 bg-[#171a24] hover:bg-[#0088ff] hover:text-white text-neutral-300 border border-[#2b3144] rounded-xs text-[10.5px] transition-colors flex items-center space-x-1.5"
              title="Rekordbox XML Track-Auswahl mit Suchleiste im Pop-up öffnen"
            >
              <Disc size={11} className="text-[#00c8ff]" />
              <span className="font-semibold text-white">XML Track-Auswahl</span>
            </button>
          )}

          <button
            onClick={onImportXml}
            className="px-2 py-0.5 bg-[#16171e] hover:bg-[#20222b] hover:text-white border border-[#262835] rounded-xs text-[10.5px] transition-colors flex items-center space-x-1"
            title="Rekordbox XML importieren"
          >
            <Upload size={11} />
            <span>XML</span>
          </button>

          <button
            onClick={onImportAudio}
            className="px-2 py-0.5 bg-[#16171e] hover:bg-[#20222b] hover:text-white border border-[#262835] rounded-xs text-[10.5px] transition-colors flex items-center space-x-1"
            title="Audio-Datei (WAV, MP3, FLAC) importieren"
          >
            <FileAudio size={11} />
            <span>Audio</span>
          </button>

          <button
            onClick={onToggle}
            className="p-1 hover:text-white hover:bg-[#202432] rounded transition-colors"
            title={isOpen ? 'Browser einklappen' : 'Browser aufklappen'}
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
      </div>

      {/* Expanded Browser Content (Pioneer Rekordbox Collection & Matching View) */}
      {isOpen && (
        <div className={`${getContainerHeightClass()} bg-[#0b0c0f] flex border-t border-[#14151a] overflow-hidden text-xs transition-all duration-150`}>
          {/* Left Tree Navigator */}
          <div className="w-56 bg-[#0d0e13] border-r border-[#1a1c25] p-2 flex flex-col space-y-1 overflow-y-auto select-none flex-shrink-0">
            <div className="text-[10px] text-neutral-500 font-bold uppercase tracking-wider px-2 py-1 flex items-center justify-between">
              <span>Bibliothek</span>
              <span className="text-[9px] font-mono text-neutral-600">SMART</span>
            </div>

            {/* 1. All Tracks */}
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

            {/* 2. MATCH / LINKED TRACKS (PIONEER REKORDBOX MATCHING) */}
            <div className="pt-1.5 pb-0.5">
              <div className="text-[9.5px] text-[#00c8ff] font-bold uppercase tracking-wider px-2 py-0.5 flex items-center space-x-1">
                <Link2 size={10} />
                <span>Verknüpfte Tracks (Match)</span>
              </div>
            </div>

            {/* 2a. Linked with Current Deck Track */}
            <button
              onClick={() => setSelectedFolder('MATCH_ACTIVE')}
              className={`w-full text-left px-2 py-1 rounded-xs flex items-center space-x-2 text-[11px] transition-colors ${
                selectedFolder === 'MATCH_ACTIVE'
                  ? 'bg-[#00e5ff]/20 text-[#00e5ff] font-semibold border-l-2 border-[#00e5ff]'
                  : 'text-neutral-300 hover:bg-[#151720]'
              }`}
              title={activeTrack ? `Nur Tracks anzeigen, die mit „${activeTrack.title}“ verknüpft sind` : 'Kein Track im Deck geladen'}
            >
              <LinkIcon size={12} className={selectedFolder === 'MATCH_ACTIVE' ? 'text-[#00e5ff]' : 'text-neutral-500'} />
              <span className="truncate">Mit Deck-Track</span>
              <span className="ml-auto text-[9.5px] font-mono font-bold text-[#00e5ff]">
                {activeTrackLinkedIds.length}
              </span>
            </button>

            {/* 2b. All Tracks that have ANY Links (User Prompt Explicit Wish!) */}
            <button
              onClick={() => setSelectedFolder('MATCH_ALL')}
              className={`w-full text-left px-2 py-1 rounded-xs flex items-center space-x-2 text-[11px] transition-colors ${
                selectedFolder === 'MATCH_ALL'
                  ? 'bg-[#0088ff]/20 text-[#00a2ff] font-semibold border-l-2 border-[#0088ff]'
                  : 'text-neutral-300 hover:bg-[#151720]'
              }`}
              title="Alle Tracks in der Sammlung anzeigen, die Verknüpfungen besitzen"
            >
              <Link2 size={12} className={selectedFolder === 'MATCH_ALL' ? 'text-[#00a2ff]' : 'text-neutral-500'} />
              <span>Alle Verknüpften</span>
              <span className="ml-auto text-[9.5px] font-mono text-neutral-400">
                {allLinkedIdsSet.size}
              </span>
            </button>

            {/* 3. Harmonic Match (Camelot Wheel) */}
            <div className="pt-1.5 pb-0.5">
              <div className="text-[9.5px] text-neutral-500 font-bold uppercase tracking-wider px-2 py-0.5 flex items-center space-x-1">
                <Sparkles size={10} className="text-emerald-400" />
                <span>Intelligente Filter</span>
              </div>
            </div>

            <button
              onClick={() => setSelectedFolder('HARMONIC')}
              className={`w-full text-left px-2 py-1 rounded-xs flex items-center space-x-2 text-[11px] transition-colors ${
                selectedFolder === 'HARMONIC'
                  ? 'bg-emerald-500/20 text-emerald-400 font-semibold border-l-2 border-emerald-400'
                  : 'text-neutral-300 hover:bg-[#151720]'
              }`}
              title={activeTrack ? `Harmonisch passend zu ${activeTrack.key || 'Deck-Track'}` : 'Kein Track im Deck geladen'}
            >
              <Sparkles size={12} className={selectedFolder === 'HARMONIC' ? 'text-emerald-400' : 'text-neutral-500'} />
              <span>Harmonisch (Key)</span>
              {activeTrack?.key && (
                <span className="ml-auto text-[9.5px] font-mono text-emerald-400 font-bold">
                  {activeTrack.key}
                </span>
              )}
            </button>

            {/* 4. BPM Match (±6%) */}
            <button
              onClick={() => setSelectedFolder('BPM_RANGE')}
              className={`w-full text-left px-2 py-1 rounded-xs flex items-center space-x-2 text-[11px] transition-colors ${
                selectedFolder === 'BPM_RANGE'
                  ? 'bg-amber-500/20 text-amber-300 font-semibold border-l-2 border-amber-400'
                  : 'text-neutral-300 hover:bg-[#151720]'
              }`}
              title={activeTrack ? `Tempo passend zu ${activeTrack.bpm.toFixed(1)} BPM (±6%)` : 'Kein Track im Deck'}
            >
              <Flame size={12} className={selectedFolder === 'BPM_RANGE' ? 'text-amber-400' : 'text-neutral-500'} />
              <span>Tempo (±6% BPM)</span>
              {activeTrack && (
                <span className="ml-auto text-[9.5px] font-mono text-amber-300">
                  {activeTrack.bpm.toFixed(0)}
                </span>
              )}
            </button>

            {/* 5. Favorites */}
            <button
              onClick={() => setSelectedFolder('FAVORITES')}
              className={`w-full text-left px-2 py-1 rounded-xs flex items-center space-x-2 text-[11px] transition-colors ${
                selectedFolder === 'FAVORITES'
                  ? 'bg-yellow-500/20 text-yellow-300 font-semibold border-l-2 border-yellow-400'
                  : 'text-neutral-300 hover:bg-[#151720]'
              }`}
            >
              <Star size={12} className={selectedFolder === 'FAVORITES' ? 'text-yellow-400 fill-yellow-400' : 'text-neutral-500'} />
              <span>Favoriten (4-5★)</span>
            </button>

            {/* 6. Standard Sources */}
            <div className="pt-1.5 pb-0.5">
              <div className="text-[9.5px] text-neutral-500 font-bold uppercase tracking-wider px-2 py-0.5">
                Quellen
              </div>
            </div>

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
                {tracks.filter((t) => t.origin === 'LOCAL_ANALYSIS' || !!t.audioBuffer).length}
              </span>
            </button>
          </div>

          {/* Right Main Area: Search Bar + Toolbar + Track Table */}
          <div className="flex-1 flex flex-col min-w-0 bg-[#0c0d12]">
            {/* Search & Quick-Filter Toolbar */}
            <div className="h-8.5 bg-[#11131a] border-b border-[#1c1e27] px-3 flex items-center justify-between flex-shrink-0 gap-2 overflow-x-auto">
              {/* Search Bar */}
              <div className="relative w-64 md:w-80 flex-shrink-0">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="In Sammlung suchen (Titel, Artist, BPM, Key, Notizen...)"
                  className="w-full bg-[#0a0b0e] border border-[#232533] focus:border-[#0088ff] rounded-xs pl-7 pr-6 py-0.5 text-[11px] text-white placeholder-neutral-500 focus:outline-none"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white"
                    title="Suche leeren"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>

              {/* Quick Filter Toggle Chips */}
              <div className="flex items-center space-x-1.5 flex-shrink-0">
                {/* 🔗 Quick Filter: Nur Verknüpfte */}
                <button
                  onClick={() => setFilterOnlyLinked((prev) => !prev)}
                  className={`px-2 py-0.5 rounded-xs text-[10px] font-medium border flex items-center space-x-1 transition-colors ${
                    filterOnlyLinked
                      ? 'bg-[#00e5ff]/20 text-[#00e5ff] border-[#00e5ff]/50'
                      : 'bg-[#151720] text-neutral-400 hover:text-white border-[#242735]'
                  }`}
                  title="Nur Tracks mit Verknüpfungen anzeigen"
                >
                  <Link2 size={10} />
                  <span>Nur Verknüpfte</span>
                </button>

                {/* 🎼 Quick Filter: Harmonisch */}
                <button
                  onClick={() => setFilterHarmonic((prev) => !prev)}
                  disabled={!activeTrack}
                  className={`px-2 py-0.5 rounded-xs text-[10px] font-medium border flex items-center space-x-1 transition-colors disabled:opacity-40 ${
                    filterHarmonic
                      ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50'
                      : 'bg-[#151720] text-neutral-400 hover:text-white border-[#242735]'
                  }`}
                  title={activeTrack ? `Harmonisch passend zu ${activeTrack.key || 'Deck'}` : 'Erfordert geladenen Track'}
                >
                  <Sparkles size={10} />
                  <span>Harmonisch</span>
                </button>

                {/* ⚡ Quick Filter: BPM Range */}
                <button
                  onClick={() => setFilterBpmRange((prev) => !prev)}
                  disabled={!activeTrack}
                  className={`px-2 py-0.5 rounded-xs text-[10px] font-medium border flex items-center space-x-1 transition-colors disabled:opacity-40 ${
                    filterBpmRange
                      ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                      : 'bg-[#151720] text-neutral-400 hover:text-white border-[#242735]'
                  }`}
                  title={activeTrack ? `BPM passend (±6%) zu ${activeTrack.bpm.toFixed(1)}` : 'Erfordert geladenen Track'}
                >
                  <Flame size={10} />
                  <span>BPM ±6%</span>
                </button>

                {/* 🔊 Quick Filter: Mit Audio */}
                <button
                  onClick={() => setFilterOnlyWithAudio((prev) => !prev)}
                  className={`px-2 py-0.5 rounded-xs text-[10px] font-medium border flex items-center space-x-1 transition-colors ${
                    filterOnlyWithAudio
                      ? 'bg-[#0088ff]/20 text-[#00a2ff] border-[#0088ff]/50'
                      : 'bg-[#151720] text-neutral-400 hover:text-white border-[#242735]'
                  }`}
                  title="Nur Tracks mit geladener Audiodatei anzeigen"
                >
                  <Volume2 size={10} />
                  <span>Audio bereit</span>
                </button>

                {(filterOnlyLinked || filterHarmonic || filterBpmRange || filterOnlyWithAudio || searchQuery || selectedFolder !== 'ALL') && (
                  <button
                    onClick={() => {
                      setFilterOnlyLinked(false);
                      setFilterHarmonic(false);
                      setFilterBpmRange(false);
                      setFilterOnlyWithAudio(false);
                      setSearchQuery('');
                      setSelectedFolder('ALL');
                    }}
                    className="text-[9.5px] text-neutral-500 hover:text-red-400 px-1 py-0.5 ml-1"
                    title="Alle Filter zurücksetzen"
                  >
                    Reset
                  </button>
                )}
              </div>

              {/* Status / Instructions */}
              <div className="text-[10px] text-neutral-500 font-mono hidden lg:block ml-auto flex-shrink-0">
                Doppelklick: In Deck laden • 🔗 Match-Button: Verknüpfen
              </div>
            </div>

            {/* Note Editor Bar (if open) */}
            {editingNoteTrackId && (
              <div className="bg-[#121622] border-b border-[#1f283d] px-3 py-1.5 flex items-center space-x-2 text-xs">
                <MessageSquare size={13} className="text-[#00e5ff]" />
                <span className="text-[11px] font-semibold text-[#00e5ff]">
                  Mix-Notiz für Verknüpfung mit {tracks.find((t) => t.id === editingNoteTrackId)?.title}:
                </span>
                <input
                  type="text"
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveNote(editingNoteTrackId);
                    if (e.key === 'Escape') setEditingNoteTrackId(null);
                  }}
                  placeholder="z.B. Perfekter Drop-Swap bei Bar 32, Breakdown Blend..."
                  className="flex-1 bg-[#0a0b10] border border-[#2b354d] focus:border-[#0088ff] rounded-xs px-2 py-0.5 text-[11px] text-white focus:outline-none"
                  autoFocus
                />
                <button
                  onClick={() => handleSaveNote(editingNoteTrackId)}
                  className="px-2 py-0.5 bg-[#0088ff] hover:bg-[#0099ff] text-white rounded-xs text-[10.5px] font-semibold"
                >
                  Speichern
                </button>
                <button
                  onClick={() => setEditingNoteTrackId(null)}
                  className="px-2 py-0.5 bg-[#181b24] hover:bg-[#252a3a] text-neutral-300 rounded-xs text-[10.5px]"
                >
                  Abbrechen
                </button>
              </div>
            )}

            {/* Track Table */}
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-[#14161f] border-b border-[#202330] text-[10px] text-neutral-400 sticky top-0 z-10 font-bold uppercase tracking-wider select-none">
                  <tr>
                    {/* Index */}
                    <th
                      onClick={() => handleHeaderClick('INDEX')}
                      className="py-1.5 px-2.5 w-9 text-center cursor-pointer hover:text-white group"
                      title="Nach Index sortieren"
                    >
                      <div className="flex items-center justify-center">
                        <span>#</span>
                        {renderSortIndicator('INDEX')}
                      </div>
                    </th>

                    {/* Preview Audio */}
                    <th className="py-1.5 px-1.5 w-8 text-center" title="Audio-Vorhören">
                      <Volume2 size={11} className="mx-auto text-neutral-500" />
                    </th>

                    {/* Title */}
                    <th
                      onClick={() => handleHeaderClick('TITLE')}
                      className="py-1.5 px-3 cursor-pointer hover:text-white group"
                      title="Nach Titel sortieren"
                    >
                      <div className="flex items-center">
                        <span>TITEL</span>
                        {renderSortIndicator('TITLE')}
                      </div>
                    </th>

                    {/* Artist */}
                    <th
                      onClick={() => handleHeaderClick('ARTIST')}
                      className="py-1.5 px-3 w-40 cursor-pointer hover:text-white group"
                      title="Nach Interpret sortieren"
                    >
                      <div className="flex items-center">
                        <span>INTERPRET</span>
                        {renderSortIndicator('ARTIST')}
                      </div>
                    </th>

                    {/* BPM */}
                    <th
                      onClick={() => handleHeaderClick('BPM')}
                      className="py-1.5 px-3 w-28 text-right cursor-pointer hover:text-white group"
                      title="Nach BPM sortieren"
                    >
                      <div className="flex items-center justify-end">
                        <span>BPM</span>
                        {renderSortIndicator('BPM')}
                      </div>
                    </th>

                    {/* Key & Camelot */}
                    <th
                      onClick={() => handleHeaderClick('KEY')}
                      className="py-1.5 px-3 w-28 text-center cursor-pointer hover:text-white group"
                      title="Nach Key / Camelot sortieren"
                    >
                      <div className="flex items-center justify-center">
                        <span>KEY</span>
                        {renderSortIndicator('KEY')}
                      </div>
                    </th>

                    {/* Track Match / Link Column */}
                    <th
                      onClick={() => handleHeaderClick('MATCH')}
                      className="py-1.5 px-3 w-36 text-center cursor-pointer hover:text-white group"
                      title="Nach Verknüpfungsstatus sortieren"
                    >
                      <div className="flex items-center justify-center space-x-1">
                        <Link2 size={11} className="text-[#00c8ff]" />
                        <span>MATCH</span>
                        {renderSortIndicator('MATCH')}
                      </div>
                    </th>

                    {/* Duration */}
                    <th
                      onClick={() => handleHeaderClick('TIME')}
                      className="py-1.5 px-3 w-16 text-center cursor-pointer hover:text-white group"
                      title="Nach Spieldauer sortieren"
                    >
                      <div className="flex items-center justify-center">
                        <span>ZEIT</span>
                        {renderSortIndicator('TIME')}
                      </div>
                    </th>

                    {/* Rating */}
                    <th
                      onClick={() => handleHeaderClick('RATING')}
                      className="py-1.5 px-2.5 w-24 text-center cursor-pointer hover:text-white group"
                      title="Nach Bewertung sortieren"
                    >
                      <div className="flex items-center justify-center">
                        <span>BEWERTUNG</span>
                        {renderSortIndicator('RATING')}
                      </div>
                    </th>

                    {/* Memory Cues */}
                    <th
                      onClick={() => handleHeaderClick('CUES')}
                      className="py-1.5 px-2.5 w-20 text-center cursor-pointer hover:text-white group"
                      title="Nach Memory Cues sortieren"
                    >
                      <div className="flex items-center justify-center">
                        <span>CUES</span>
                        {renderSortIndicator('CUES')}
                      </div>
                    </th>

                    {/* Action */}
                    <th className="py-1.5 px-3 w-24 text-right">AKTION</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-[#151722]">
                  {filteredAndSortedTracks.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="text-center py-10 text-neutral-500 text-xs">
                        <div className="flex flex-col items-center justify-center space-y-1">
                          <span>Keine Tracks in dieser Filteransicht gefunden.</span>
                          {(filterOnlyLinked || selectedFolder === 'MATCH_ACTIVE' || selectedFolder === 'MATCH_ALL') && (
                            <span className="text-[11px] text-neutral-600">
                              Klicke in einer Zeile auf das 🔗 Symbol, um Tracks miteinander zu verknüpfen.
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredAndSortedTracks.map((t, idx) => {
                      const isActive = t.id === activeTrackId;
                      const memCuesCount = t.cues.filter((c) => c.type === 'MEMORY').length;
                      const isLinkedWithActive = activeTrackId ? areTracksLinked(activeTrackId, t.id, trackLinks) : false;
                      const totalLinksCount = getLinkedTrackIds(t.id, trackLinks).length;
                      const linkNote = activeTrackId ? getLinkNote(activeTrackId, t.id, trackLinks) : undefined;
                      const harmonic = activeTrack ? getHarmonicCompatibility(activeTrack.key, t.key) : null;
                      const bpmRel = activeTrack ? getBpmRelation(activeTrack.bpm, t.bpm) : null;
                      const rating = userRatings[t.id] ?? t.rating ?? 0;
                      const isPreviewing = previewTrackId === t.id;

                      return (
                        <tr
                          key={t.id}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'copyLink';
                            beginDrag(e.dataTransfer, {
                              kind: 'track',
                              trackId: t.id,
                              label: `${t.artist ? `${t.artist} – ` : ''}${t.title}`,
                            });
                          }}
                          onDragEnd={() => endDrag()}
                          onClick={() => onSelectTrack(t.id)}
                          onDoubleClick={() => onSelectTrack(t.id)}
                          title="In die Deck-Ansicht ziehen (lädt den Track in Deck A) · Doppelklick = Laden"
                          className={`cursor-grab active:cursor-grabbing transition-colors group text-xs ${
                            isActive
                              ? 'bg-[#0088ff]/15 border-l-2 border-[#0088ff]'
                              : isLinkedWithActive
                              ? 'bg-[#00e5ff]/5 hover:bg-[#00e5ff]/10 border-l-2 border-[#00e5ff]/60'
                              : 'hover:bg-[#141622]'
                          }`}
                        >
                          {/* Index */}
                          <td className="py-2 px-2.5 text-center text-[10.5px] font-mono text-neutral-400">
                            {idx + 1}
                          </td>

                          {/* Preview Audio Play/Pause Button */}
                          <td className="py-2 px-1 text-center" onClick={(e) => e.stopPropagation()}>
                            {t.audioBuffer ? (
                              <button
                                onClick={() => handleTogglePreview(t)}
                                className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors mx-auto ${
                                  isPreviewing
                                    ? 'bg-[#00c853] text-black font-bold'
                                    : 'bg-[#191b26] hover:bg-[#0088ff] text-neutral-300 hover:text-white'
                                }`}
                                title={isPreviewing ? 'Vorschau stoppen' : 'Kurz vorhören (ohne Deck-Wechsel)'}
                              >
                                {isPreviewing ? <Pause size={9} /> : <Play size={8} fill="currentColor" />}
                              </button>
                            ) : (
                              <span className="w-1.5 h-1.5 rounded-full bg-neutral-700 mx-auto block" title="Kein Audio vorhanden" />
                            )}
                          </td>

                          {/* Title */}
                          <td className="py-2 px-3">
                            <div className="flex items-center space-x-2">
                              <Music
                                size={12}
                                className={isActive ? 'text-[#0088ff]' : isLinkedWithActive ? 'text-[#00e5ff]' : 'text-neutral-500'}
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

                              {isLinkedWithActive && !isActive && (
                                <span className="px-1.5 py-0.2 rounded-xs bg-[#00e5ff]/20 text-[#00e5ff] border border-[#00e5ff]/40 text-[9px] font-mono font-semibold flex items-center space-x-0.5">
                                  <Link2 size={8} />
                                  <span>MATCH</span>
                                </span>
                              )}

                              {linkNote && (
                                <span className="text-[9.5px] text-neutral-400 italic flex items-center space-x-0.5 truncate max-w-xs" title={`Mix-Notiz: ${linkNote}`}>
                                  <MessageSquare size={9} className="text-[#00c8ff] flex-shrink-0" />
                                  <span className="truncate">{linkNote}</span>
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Artist */}
                          <td className="py-2 px-3 text-neutral-300 text-[11px] truncate">
                            {t.artist || 'Unbekannt'}
                          </td>

                          {/* BPM */}
                          <td className="py-2 px-3 text-right font-mono text-[11.5px]">
                            <div className="flex items-center justify-end space-x-1.5">
                              {bpmRel && !isActive && (
                                <span
                                  className={`text-[9.5px] font-mono ${
                                    bpmRel.isWithinPct(4)
                                      ? 'text-emerald-400'
                                      : bpmRel.isWithinPct(8)
                                      ? 'text-amber-300'
                                      : 'text-neutral-500'
                                  }`}
                                  title={`Tempo-Differenz zu Deck: ${bpmRel.label} (${bpmRel.diff >= 0 ? '+' : ''}${bpmRel.diff.toFixed(2)} BPM)`}
                                >
                                  {bpmRel.label}
                                </span>
                              )}
                              <span className="font-bold text-[#00a2ff]">
                                {t.bpm.toFixed(2)}
                              </span>
                            </div>
                          </td>

                          {/* Key & Camelot Harmonic Match */}
                          <td className="py-2 px-3 text-center">
                            <div className="flex items-center justify-center space-x-1">
                              <span className="px-1.5 py-0.5 rounded-xs bg-[#1a1c26] text-neutral-200 font-mono text-[10.5px] font-semibold">
                                {t.key || '--'}
                              </span>

                              {harmonic && !isActive && harmonic.isCompatible && (
                                <span
                                  className={`px-1 py-0.2 rounded-xs border text-[8.5px] font-mono font-bold ${harmonic.badgeColor}`}
                                  title={harmonic.label}
                                >
                                  {harmonic.score >= 95 ? '★ KEY' : 'MATCH'}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Match / Linked Tracks Column */}
                          <td className="py-2 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-center space-x-1.5">
                              {/* Toggle Match button with active track */}
                              {activeTrackId && t.id !== activeTrackId ? (
                                <button
                                  onClick={() => handleToggleLink(t.id)}
                                  className={`px-2 py-0.5 rounded-xs text-[10px] font-semibold border flex items-center space-x-1 transition-all ${
                                    isLinkedWithActive
                                      ? 'bg-[#00e5ff]/20 text-[#00e5ff] border-[#00e5ff]/60 hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/40'
                                      : 'bg-[#151722] hover:bg-[#0088ff]/20 text-neutral-400 hover:text-[#00a2ff] border-[#222535] hover:border-[#0088ff]/40'
                                  }`}
                                  title={
                                    isLinkedWithActive
                                      ? 'Mit Deck-Track verknüpft (Klicken zum Lösen)'
                                      : `Mit geladenem Track „${activeTrack?.title}“ verknüpfen`
                                  }
                                >
                                  {isLinkedWithActive ? (
                                    <>
                                      <Link2 size={10} />
                                      <span>LINKED</span>
                                    </>
                                  ) : (
                                    <>
                                      <LinkIcon size={10} />
                                      <span>+ Link</span>
                                    </>
                                  )}
                                </button>
                              ) : (
                                <span className="text-[10px] text-neutral-600 font-mono">-</span>
                              )}

                              {/* Total Links count across collection */}
                              {totalLinksCount > 0 && (
                                <span
                                  className="text-[9.5px] font-mono text-neutral-400 px-1 rounded-xs bg-[#151722] border border-[#232738]"
                                  title={`Dieser Track besitzt ${totalLinksCount} Verknüpfung(en) in deiner Sammlung`}
                                >
                                  🔗{totalLinksCount}
                                </span>
                              )}

                              {/* Mix Note Button */}
                              {isLinkedWithActive && (
                                <button
                                  onClick={() => {
                                    setEditingNoteTrackId(t.id);
                                    setNoteDraft(linkNote || '');
                                  }}
                                  className={`p-1 rounded-xs transition-colors ${
                                    linkNote
                                      ? 'text-[#00c8ff] hover:bg-[#0088ff]/20'
                                      : 'text-neutral-500 hover:text-white hover:bg-[#1f2333]'
                                  }`}
                                  title={linkNote ? `Mix-Notiz bearbeiten: "${linkNote}"` : 'Mix-Notiz für diesen Übergang hinzufügen'}
                                >
                                  <MessageSquare size={11} />
                                </button>
                              )}
                            </div>
                          </td>

                          {/* Time */}
                          <td className="py-2 px-3 text-center font-mono text-neutral-400 text-[11px]">
                            {formatTime(t.duration)}
                          </td>

                          {/* Rating (1-5 Stars) */}
                          <td className="py-2 px-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-center space-x-0.5">
                              {[1, 2, 3, 4, 5].map((starVal) => {
                                const isFilled = starVal <= rating;
                                return (
                                  <button
                                    key={starVal}
                                    onClick={() => handleSetRating(t.id, starVal)}
                                    className="p-0.5 text-neutral-600 hover:text-yellow-400 transition-colors"
                                    title={`${starVal} Sterne`}
                                  >
                                    <Star
                                      size={10}
                                      className={isFilled ? 'text-yellow-400 fill-yellow-400' : 'text-neutral-600'}
                                    />
                                  </button>
                                );
                              })}
                            </div>
                          </td>

                          {/* Memory Cues count */}
                          <td className="py-2 px-2.5 text-center">
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
