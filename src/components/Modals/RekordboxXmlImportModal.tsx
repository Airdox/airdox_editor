/**
 * @license
 * Rekordbox Pro Library Management & Track Matching System
 * 
 * State-of-the-Art, highly tactile ("maximal anfassbar") Rekordbox collection browser:
 * - Full-text and multi-criteria intelligent filtering (BPM ranges, Camelot 24-key matrix, ratings, genres, cues, phrases).
 * - Rekordbox 2-Track Matching (Verknüpfungen / Related Tracks):
 *     * 1-Click Match toggle with active deck
 *     * Filter by all matched tracks or tracks matched with active deck
 *     * Traffic Light Harmonic Compatibility (Exact, Adjacent, Relative, Energy Boost)
 *     * DJ transition notes per match
 * - Tactile views: Pro Table Grid & Bento/Waveform Cards
 * - Inline audio pre-listening and scrubbable mini waveforms
 * - Keyboard navigation (Up/Down, Enter to load, Space to pre-listen, M to match)
 */

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Search,
  Music,
  Play,
  Pause,
  Clock,
  Tag,
  Disc,
  Filter,
  Check,
  ArrowUpDown,
  ListFilter,
  Sliders,
  Sparkles,
  Link,
  Link2,
  Unlink,
  Volume2,
  VolumeX,
  Layers,
  ChevronDown,
  ChevronRight,
  Star,
  Flame,
  Zap,
  Activity,
  Calendar,
  Grid,
  List,
  Maximize2,
  Minimize2,
  Info,
  Edit3,
} from 'lucide-react';
import { TrackModel, CuePoint, PhraseSection } from '../../types/rekordbox';
import {
  getStoredMatches,
  areTracksMatched,
  toggleTrackMatch,
  getMatchedTrackIds,
  getMatchNote,
  setMatchNote,
  calculateHarmonicCompatibility,
  isBpmCompatible,
  hasTrackMatches,
  getAllLinkedTrackIds,
  HarmonicTrafficLight,
  MatchStore,
} from '../../rekordbox/trackMatching';
import { getCamelotInfo } from '../../audio/mixAnalysis';
import { logger } from '../../utils/logger';

export interface RekordboxXmlImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  xmlTracks: TrackModel[];
  fileName?: string;
  onSelectTrack: (track: TrackModel) => void;
  currentTrackId?: string;
  activeTrack?: TrackModel | null;
}

type SortField =
  | 'id'
  | 'title'
  | 'artist'
  | 'bpm'
  | 'key'
  | 'duration'
  | 'rating'
  | 'matches'
  | 'memoryCues'
  | 'dateAdded';
type SortOrder = 'asc' | 'desc';

type PrimaryQuickFilter =
  | 'ALL'
  | 'MATCHED_ANY'
  | 'MATCHED_ACTIVE'
  | 'HARMONIC_TRAFFIC_LIGHT'
  | 'BPM_NEAR'
  | 'TOP_RATED'
  | 'HAS_MEMORY'
  | 'HAS_HOT_CUE'
  | 'HAS_LOOPS'
  | 'HAS_PHRASES';

type ViewLayout = 'TABLE' | 'CARDS';

const CAMELOT_KEYS_A = ['1A', '2A', '3A', '4A', '5A', '6A', '7A', '8A', '9A', '10A', '11A', '12A'];
const CAMELOT_KEYS_B = ['1B', '2B', '3B', '4B', '5B', '6B', '7B', '8B', '9B', '10B', '11B', '12B'];

export const RekordboxXmlImportModal: React.FC<RekordboxXmlImportModalProps> = ({
  isOpen,
  onClose,
  xmlTracks,
  fileName = 'Rekordbox XML Collection',
  onSelectTrack,
  currentTrackId,
  activeTrack,
}) => {
  // Search & Navigation states
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTrackId, setSelectedTrackId] = useState<string>(
    xmlTracks.length > 0 ? currentTrackId || xmlTracks[0].id : ''
  );
  const [sortField, setSortField] = useState<SortField>('id');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [viewLayout, setViewLayout] = useState<ViewLayout>('TABLE');
  const [visibleTrackLimit, setVisibleTrackLimit] = useState(250);
  const [showProFilters, setShowProFilters] = useState<boolean>(false);
  const [expandedTrackIds, setExpandedTrackIds] = useState<Set<string>>(new Set());

  // Quick Filters
  const [quickFilter, setQuickFilter] = useState<PrimaryQuickFilter>('ALL');

  // Secondary Filter Matrix
  const [selectedCamelotKey, setSelectedCamelotKey] = useState<string | null>(null);
  const [selectedGenre, setSelectedGenre] = useState<string>('ALL');
  const [minRating, setMinRating] = useState<number>(0);
  const [bpmRangePreset, setBpmRangePreset] = useState<string>('ALL');
  const [customBpmMin, setCustomBpmMin] = useState<number>(60);
  const [customBpmMax, setCustomBpmMax] = useState<number>(185);

  // Local Track Match Store state (for reactive UI updates)
  const [matchStore, setMatchStore] = useState<MatchStore>(() => getStoredMatches());
  const [editingNoteTrackId, setEditingNoteTrackId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string>('');

  // Audio Pre-Listen state (synthesizer or buffer snippet preview)
  const [previewingTrackId, setPreviewingTrackId] = useState<string | null>(null);
  const preListenAudioCtxRef = useRef<AudioContext | null>(null);
  const preListenOscRef = useRef<{ osc1: OscillatorNode; osc2: OscillatorNode; gain: GainNode; intervalId: number } | null>(null);

  // Source path inspection
  const [sourceStatus, setSourceStatus] = useState<{
    kind: 'NOT_PROVIDED' | 'CHECKING' | 'AVAILABLE' | 'MISSING' | 'UNAVAILABLE';
    detail: string;
  }>({ kind: 'NOT_PROVIDED', detail: 'Keine XML-Location hinterlegt.' });

  // Sync selectedTrackId when tracks change
  useEffect(() => {
    if (xmlTracks.length > 0) {
      if (currentTrackId && xmlTracks.some((t) => t.id === currentTrackId)) {
        setSelectedTrackId(currentTrackId);
      } else if (!selectedTrackId || !xmlTracks.some((t) => t.id === selectedTrackId)) {
        setSelectedTrackId(xmlTracks[0].id);
      }
    }
  }, [xmlTracks, currentTrackId]);

  // Reset pagination limit on filter changes
  useEffect(() => {
    setVisibleTrackLimit(250);
  }, [
    searchQuery,
    quickFilter,
    selectedCamelotKey,
    selectedGenre,
    minRating,
    bpmRangePreset,
    customBpmMin,
    customBpmMax,
    sortField,
    sortOrder,
  ]);

  // Clean up pre-listen audio on unmount or close
  useEffect(() => {
    return () => {
      stopPreListen();
    };
  }, []);

  const stopPreListen = useCallback(() => {
    if (preListenOscRef.current) {
      try {
        clearInterval(preListenOscRef.current.intervalId);
        preListenOscRef.current.gain.gain.setValueAtTime(0.0001, preListenAudioCtxRef.current?.currentTime || 0);
        preListenOscRef.current.osc1.stop();
        preListenOscRef.current.osc2.stop();
      } catch {
        // audio node may already be stopped
      }
      preListenOscRef.current = null;
    }
    setPreviewingTrackId(null);
  }, []);

  // Pre-listen synth simulation using Web Audio
  const handleTogglePreListen = useCallback(
    (track: TrackModel) => {
      if (previewingTrackId === track.id) {
        stopPreListen();
        return;
      }

      stopPreListen();

      try {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!preListenAudioCtxRef.current) {
          preListenAudioCtxRef.current = new AudioContextClass();
        }
        const ctx = preListenAudioCtxRef.current;
        if (ctx.state === 'suspended') {
          ctx.resume();
        }

        const bpm = track.bpm || 128;
        const spb = 60.0 / bpm;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0.12, ctx.currentTime);
        gainNode.connect(ctx.destination);

        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        osc1.type = 'sawtooth';
        osc2.type = 'sine';

        // Approximate key frequencies
        const info = getCamelotInfo(track.key);
        const baseFreq = info.code.endsWith('A') ? 110 : 130.81; // A2 or C3
        osc1.frequency.setValueAtTime(baseFreq, ctx.currentTime);
        osc2.frequency.setValueAtTime(baseFreq * 0.5, ctx.currentTime);

        osc1.connect(gainNode);
        osc2.connect(gainNode);

        osc1.start();
        osc2.start();

        // Rhythmic pulsing
        let beat = 0;
        const interval = window.setInterval(() => {
          beat++;
          const isKick = beat % 4 === 1;
          const targetVol = isKick ? 0.22 : 0.08;
          try {
            gainNode.gain.cancelScheduledValues(ctx.currentTime);
            gainNode.gain.setValueAtTime(targetVol, ctx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.02, ctx.currentTime + 0.18);
          } catch {
            // ignore audio timing glitches
          }
        }, spb * 1000);

        preListenOscRef.current = { osc1, osc2, gain: gainNode, intervalId: interval };
        setPreviewingTrackId(track.id);

        // Auto-stop after 8 seconds
        setTimeout(() => {
          if (previewingTrackId === track.id) {
            stopPreListen();
          }
        }, 8000);
      } catch (err) {
        logger.warn('AUDIO_ENGINE', 'Pre-listen could not start', err);
      }
    },
    [previewingTrackId, stopPreListen]
  );

  // Extract unique genres for filter chips
  const availableGenres = useMemo(() => {
    const genreCounts: Record<string, number> = {};
    for (const t of xmlTracks) {
      const g = (t.genre || 'Sonstige').trim();
      if (g) {
        genreCounts[g] = (genreCounts[g] || 0) + 1;
      }
    }
    return Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [xmlTracks]);

  // Effective Active Track (from props or from selection)
  const effectiveActiveTrack = useMemo(() => {
    return activeTrack || xmlTracks.find((t) => t.id === currentTrackId) || xmlTracks[0] || null;
  }, [activeTrack, xmlTracks, currentTrackId]);

  // Statistics for Quick Filter Badges
  const stats = useMemo(() => {
    let matchedAny = 0;
    let matchedActive = 0;
    let harmonicMatches = 0;
    let bpmMatches = 0;
    let topRated = 0;
    let withMemory = 0;
    let withHotCue = 0;
    let withLoops = 0;
    let withPhrases = 0;

    const activeId = effectiveActiveTrack?.id;
    const activeKey = effectiveActiveTrack?.key;
    const activeBpm = effectiveActiveTrack?.bpm || 128;

    for (const t of xmlTracks) {
      if (hasTrackMatches(t, matchStore)) matchedAny++;
      if (activeId && areTracksMatched(activeId, t.id)) matchedActive++;
      if (activeKey && t.key) {
        const h = calculateHarmonicCompatibility(activeKey, t.key);
        if (h.compatible) harmonicMatches++;
      }
      if (activeBpm && t.bpm) {
        const b = isBpmCompatible(activeBpm, t.bpm, 6);
        if (b.compatible) bpmMatches++;
      }
      if ((t.rating || 0) >= 4) topRated++;
      if (t.cues.some((c) => c.type === 'MEMORY')) withMemory++;
      if (t.cues.some((c) => c.type === 'HOT_CUE')) withHotCue++;
      if (t.loops && t.loops.length > 0) withLoops++;
      if (t.phrases && t.phrases.length > 0) withPhrases++;
    }

    return {
      total: xmlTracks.length,
      matchedAny,
      matchedActive,
      harmonicMatches,
      bpmMatches,
      topRated,
      withMemory,
      withHotCue,
      withLoops,
      withPhrases,
    };
  }, [xmlTracks, matchStore, effectiveActiveTrack]);

  // Toggle match handler
  const handleToggleMatch = useCallback(
    (trackId: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      if (!effectiveActiveTrack || effectiveActiveTrack.id === trackId) {
        logger.warn('DATABASE', 'Kann Track nicht mit sich selbst verknüpfen.');
        return;
      }
      toggleTrackMatch(effectiveActiveTrack.id, trackId);
      setMatchStore(getStoredMatches());
    },
    [effectiveActiveTrack]
  );

  // Toggle row expansion
  const handleToggleExpand = useCallback((trackId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setExpandedTrackIds((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);

  // Save transition note
  const handleSaveNote = useCallback(
    (trackId: string) => {
      if (!effectiveActiveTrack) return;
      setMatchNote(effectiveActiveTrack.id, trackId, noteDraft);
      setMatchStore(getStoredMatches());
      setEditingNoteTrackId(null);
      setNoteDraft('');
    },
    [effectiveActiveTrack, noteDraft]
  );

  // Filter and Sort Engine
  const filteredTracks = useMemo(() => {
    const activeId = effectiveActiveTrack?.id;
    const activeKey = effectiveActiveTrack?.key;
    const activeBpm = effectiveActiveTrack?.bpm;

    return xmlTracks
      .filter((track) => {
        // 1. Text Search across metadata
        const query = searchQuery.trim().toLowerCase();
        if (query) {
          const matchTitle = track.title.toLowerCase().includes(query);
          const matchArtist = track.artist.toLowerCase().includes(query);
          const matchAlbum = (track.album || '').toLowerCase().includes(query);
          const matchGenre = (track.genre || '').toLowerCase().includes(query);
          const matchKey = (track.key || '').toLowerCase().includes(query);
          const matchBpm = track.bpm.toFixed(2).includes(query);
          const matchComments = (track.comments || '').toLowerCase().includes(query);
          const matchYear = (track.year || '').toLowerCase().includes(query);

          if (
            !matchTitle &&
            !matchArtist &&
            !matchAlbum &&
            !matchGenre &&
            !matchKey &&
            !matchBpm &&
            !matchComments &&
            !matchYear
          ) {
            return false;
          }
        }

        // 2. Primary Quick Filter
        switch (quickFilter) {
          case 'MATCHED_ANY':
            if (!hasTrackMatches(track, matchStore)) return false;
            break;
          case 'MATCHED_ACTIVE':
            if (!activeId || !areTracksMatched(activeId, track.id)) return false;
            break;
          case 'HARMONIC_TRAFFIC_LIGHT': {
            if (!activeKey || !track.key) return false;
            const h = calculateHarmonicCompatibility(activeKey, track.key);
            const b = activeBpm ? isBpmCompatible(activeBpm, track.bpm, 7) : { compatible: true };
            if (!h.compatible || !b.compatible) return false;
            break;
          }
          case 'BPM_NEAR': {
            if (!activeBpm) return false;
            const b = isBpmCompatible(activeBpm, track.bpm, 5);
            if (!b.compatible) return false;
            break;
          }
          case 'TOP_RATED':
            if ((track.rating || 0) < 4) return false;
            break;
          case 'HAS_MEMORY':
            if (!track.cues.some((c) => c.type === 'MEMORY')) return false;
            break;
          case 'HAS_HOT_CUE':
            if (!track.cues.some((c) => c.type === 'HOT_CUE')) return false;
            break;
          case 'HAS_LOOPS':
            if (!track.loops || track.loops.length === 0) return false;
            break;
          case 'HAS_PHRASES':
            if (!track.phrases || track.phrases.length === 0) return false;
            break;
          case 'ALL':
          default:
            break;
        }

        // 3. Secondary Pro Filters: Camelot Key
        if (selectedCamelotKey) {
          const cam = getCamelotInfo(track.key).code;
          if (cam !== selectedCamelotKey) return false;
        }

        // 4. Secondary Pro Filters: Genre
        if (selectedGenre !== 'ALL') {
          if ((track.genre || 'Sonstige').trim() !== selectedGenre) return false;
        }

        // 5. Secondary Pro Filters: Rating
        if (minRating > 0 && (track.rating || 0) < minRating) {
          return false;
        }

        // 6. Secondary Pro Filters: BPM Presets / Range
        if (bpmRangePreset === 'PLUS_MINUS_4' && activeBpm) {
          const diff = Math.abs(track.bpm - activeBpm) / activeBpm;
          if (diff > 0.04) return false;
        } else if (bpmRangePreset === 'PLUS_MINUS_8' && activeBpm) {
          const diff = Math.abs(track.bpm - activeBpm) / activeBpm;
          if (diff > 0.08) return false;
        } else if (bpmRangePreset === 'HOUSE_120_128') {
          if (track.bpm < 120 || track.bpm > 128.5) return false;
        } else if (bpmRangePreset === 'TECHNO_128_138') {
          if (track.bpm < 128 || track.bpm > 138.5) return false;
        } else if (bpmRangePreset === 'BASS_140_150') {
          if (track.bpm < 139 || track.bpm > 152) return false;
        } else if (bpmRangePreset === 'DNB_170_176') {
          if (track.bpm < 168 || track.bpm > 178) return false;
        } else if (bpmRangePreset === 'CUSTOM') {
          if (track.bpm < customBpmMin || track.bpm > customBpmMax) return false;
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
          case 'rating':
            cmp = (a.rating || 0) - (b.rating || 0);
            break;
          case 'matches': {
            const countA = getAllLinkedTrackIds(a, matchStore).length;
            const countB = getAllLinkedTrackIds(b, matchStore).length;
            cmp = countA - countB;
            break;
          }
          case 'memoryCues': {
            const memA = a.cues.filter((c) => c.type === 'MEMORY').length;
            const memB = b.cues.filter((c) => c.type === 'MEMORY').length;
            cmp = memA - memB;
            break;
          }
          case 'dateAdded':
            cmp = (a.dateAdded || '').localeCompare(b.dateAdded || '');
            break;
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
  }, [
    xmlTracks,
    searchQuery,
    quickFilter,
    selectedCamelotKey,
    selectedGenre,
    minRating,
    bpmRangePreset,
    customBpmMin,
    customBpmMax,
    sortField,
    sortOrder,
    matchStore,
    effectiveActiveTrack,
  ]);

  const visibleTracks = useMemo(
    () => filteredTracks.slice(0, visibleTrackLimit),
    [filteredTracks, visibleTrackLimit]
  );

  const selectedTrack = useMemo(() => {
    return xmlTracks.find((t) => t.id === selectedTrackId) || filteredTracks[0] || null;
  }, [xmlTracks, selectedTrackId, filteredTracks]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const currentIndex = visibleTracks.findIndex((t) => t.id === selectedTrackId);
        if (currentIndex < visibleTracks.length - 1) {
          setSelectedTrackId(visibleTracks[currentIndex + 1].id);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const currentIndex = visibleTracks.findIndex((t) => t.id === selectedTrackId);
        if (currentIndex > 0) {
          setSelectedTrackId(visibleTracks[currentIndex - 1].id);
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedTrack) {
          handleLoadTrack(selectedTrack);
        }
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (selectedTrack) {
          handleTogglePreListen(selectedTrack);
        }
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        if (selectedTrack && effectiveActiveTrack && selectedTrack.id !== effectiveActiveTrack.id) {
          handleToggleMatch(selectedTrack.id);
        }
      } else if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, visibleTracks, selectedTrackId, selectedTrack, effectiveActiveTrack, handleTogglePreListen, handleToggleMatch, onClose]);

  // Inspection of media location
  useEffect(() => {
    const location = selectedTrack?.originalMedia?.location;
    let disposed = false;

    if (!location) {
      setSourceStatus({ kind: 'NOT_PROVIDED', detail: 'Keine XML-Location hinterlegt.' });
      return () => {
        disposed = true;
      };
    }

    if (!window.rekordboxDesktop) {
      setSourceStatus({
        kind: 'UNAVAILABLE',
        detail: 'Pfadprüfung in Desktop-Umgebung aktiv (Read-Only).',
      });
      return () => {
        disposed = true;
      };
    }

    setSourceStatus({ kind: 'CHECKING', detail: 'Originaldatei wird nur lesend geprüft...' });
    window.rekordboxDesktop
      .inspectLocation(location)
      .then((result) => {
        if (disposed) return;
        if (result.exists) {
          setSourceStatus({ kind: 'AVAILABLE', detail: 'Originaldatei vorhanden – Zugriff nur lesend.' });
        } else {
          setSourceStatus({
            kind: 'MISSING',
            detail: result.reason || 'Originaldatei am XML-Pfad nicht gefunden.',
          });
        }
      })
      .catch(() => {
        if (!disposed) {
          setSourceStatus({ kind: 'MISSING', detail: 'Originaldatei konnte nicht geprüft werden.' });
        }
      });

    return () => {
      disposed = true;
    };
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
    stopPreListen();
    onSelectTrack(track);
    onClose();
  };

  const handleResetFilters = () => {
    setSearchQuery('');
    setQuickFilter('ALL');
    setSelectedCamelotKey(null);
    setSelectedGenre('ALL');
    setMinRating(0);
    setBpmRangePreset('ALL');
  };

  const isAnyFilterActive =
    searchQuery.trim().length > 0 ||
    quickFilter !== 'ALL' ||
    selectedCamelotKey !== null ||
    selectedGenre !== 'ALL' ||
    minRating > 0 ||
    bpmRangePreset !== 'ALL';

  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const formatMsec = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-50 select-none p-2 sm:p-4">
      <div className="w-full max-w-7xl bg-[#0d0e14] border border-[#232738] rounded-lg shadow-2xl overflow-hidden flex flex-col h-[94vh] text-neutral-200 text-xs font-sans">
        
        {/* ================= MODAL HEADER ================= */}
        <div className="h-12 bg-gradient-to-r from-[#141724] via-[#161a2b] to-[#12141f] border-b border-[#23283c] flex items-center justify-between px-4 flex-shrink-0">
          <div className="flex items-center space-x-3">
            <div className="w-7 h-7 rounded bg-blue-500/20 border border-blue-400/40 flex items-center justify-center">
              <Disc size={17} className="text-[#00e5ff] animate-spin-slow" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-extrabold text-white text-sm tracking-wide">
                  Rekordbox Smart Library &amp; Matching
                </span>
                <span className="px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-400/30 text-[#00e5ff] text-[10px] font-mono">
                  {xmlTracks.length} Tracks
                </span>
                {stats.matchedAny > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-purple-500/15 border border-purple-400/30 text-purple-300 text-[10px] font-mono flex items-center space-x-1">
                    <Link size={10} />
                    <span>{stats.matchedAny} Verknüpfungen</span>
                  </span>
                )}
              </div>
              <p className="text-[10.5px] text-neutral-400 font-mono truncate max-w-md">
                {fileName}
              </p>
            </div>
          </div>

          {/* Active Deck Header Indicator */}
          {effectiveActiveTrack && (
            <div className="hidden md:flex items-center space-x-2 px-3 py-1 rounded bg-[#101320] border border-[#20273c]">
              <span className="text-[10px] text-neutral-400 uppercase font-mono">Im Deck:</span>
              <span className="text-white font-bold max-w-[140px] truncate text-[11px]">
                {effectiveActiveTrack.title}
              </span>
              <span className="font-mono text-[10.5px] text-[#00e5ff] font-bold">
                {effectiveActiveTrack.bpm.toFixed(1)} BPM
              </span>
              <span className="px-1.5 py-0.2 rounded bg-[#1b2032] border border-[#2e3752] text-amber-300 font-mono text-[10px] font-bold">
                {effectiveActiveTrack.key || '8A'}
              </span>
            </div>
          )}

          {/* Header Controls: Layout switcher & Close */}
          <div className="flex items-center space-x-2">
            <div className="flex items-center bg-[#11131c] border border-[#232738] rounded p-0.5">
              <button
                onClick={() => setViewLayout('TABLE')}
                className={`px-2 py-1 rounded text-[11px] flex items-center space-x-1 transition-colors ${
                  viewLayout === 'TABLE' ? 'bg-[#0088ff] text-white font-bold' : 'text-neutral-400 hover:text-white'
                }`}
                title="Tabelle (Pro Rekordbox Ansicht)"
              >
                <List size={13} />
                <span className="hidden sm:inline">Tabelle</span>
              </button>
              <button
                onClick={() => setViewLayout('CARDS')}
                className={`px-2 py-1 rounded text-[11px] flex items-center space-x-1 transition-colors ${
                  viewLayout === 'CARDS' ? 'bg-[#0088ff] text-white font-bold' : 'text-neutral-400 hover:text-white'
                }`}
                title="Karten / Waveform-Bento Ansicht"
              >
                <Grid size={13} />
                <span className="hidden sm:inline">Karten</span>
              </button>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors"
              title="Schließen (Esc)"
            >
              <X size={17} />
            </button>
          </div>
        </div>

        {/* ================= FILTER CONTROL CENTER ================= */}
        <div className="bg-[#11131c] border-b border-[#202436] p-3 flex flex-col gap-2.5 flex-shrink-0">
          
          {/* Top Row: Search Input + Pro Filter Toggle */}
          <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center justify-between">
            {/* Search bar */}
            <div className="relative flex-1">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Live-Filter nach Titel, Interpret, BPM, Key, Album, Genre, Kommentare (z.B. '128', 'Techno', '8A')..."
                className="w-full bg-[#090a0f] border border-[#282d40] focus:border-[#0088ff] rounded pl-8.5 pr-8 py-1.5 text-xs text-white placeholder-neutral-500 focus:outline-none transition-colors"
                autoFocus
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-white p-0.5"
                  title="Suche zurücksetzen"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {/* Quick Action Buttons */}
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setShowProFilters((prev) => !prev)}
                className={`px-3 py-1.5 rounded border text-[11px] font-medium flex items-center space-x-1.5 transition-colors cursor-pointer ${
                  showProFilters || selectedCamelotKey || selectedGenre !== 'ALL' || minRating > 0 || bpmRangePreset !== 'ALL'
                    ? 'bg-blue-600/20 text-[#00e5ff] border-blue-500/40'
                    : 'bg-[#171a26] text-neutral-300 border-[#282d40] hover:bg-[#202434]'
                }`}
              >
                <Sliders size={13} />
                <span>Kriterien-Matrix</span>
                <ChevronDown
                  size={12}
                  className={`transform transition-transform ${showProFilters ? 'rotate-180' : ''}`}
                />
              </button>

              {isAnyFilterActive && (
                <button
                  onClick={handleResetFilters}
                  className="px-2.5 py-1.5 rounded bg-red-500/15 border border-red-500/30 text-red-300 hover:bg-red-500/25 text-[11px] transition-colors cursor-pointer"
                  title="Alle Filter zurücksetzen"
                >
                  Zurücksetzen
                </button>
              )}
            </div>
          </div>

          {/* Quick-Filter Pills Ribbon ("Maximal anfassbar") */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-[11px] scrollbar-thin">
            <button
              onClick={() => setQuickFilter('ALL')}
              className={`px-3 py-1 rounded-full border transition-all whitespace-nowrap cursor-pointer ${
                quickFilter === 'ALL'
                  ? 'bg-[#0088ff] text-white border-[#0088ff] font-bold shadow-[0_0_8px_rgba(0,136,255,0.4)]'
                  : 'bg-[#151724] text-neutral-300 border-[#24293c] hover:bg-[#1f2234]'
              }`}
            >
              Alle Tracks ({stats.total})
            </button>

            {/* Rekordbox Matching Filter (USER REQUEST HIGHLIGHT) */}
            <button
              onClick={() => setQuickFilter('MATCHED_ANY')}
              className={`px-3 py-1 rounded-full border transition-all whitespace-nowrap flex items-center space-x-1.5 cursor-pointer ${
                quickFilter === 'MATCHED_ANY'
                  ? 'bg-purple-600 text-white border-purple-500 font-bold shadow-[0_0_10px_rgba(168,85,247,0.5)]'
                  : 'bg-[#1c152a] text-purple-300 border-purple-500/40 hover:bg-[#251c38]'
              }`}
              title="Alle Tracks anzeigen, die Rekordbox 2-Track Verknüpfungen besitzen"
            >
              <Link size={12} className="text-purple-300" />
              <span>Verknüpfte Tracks ({stats.matchedAny})</span>
            </button>

            {effectiveActiveTrack && (
              <button
                onClick={() => setQuickFilter('MATCHED_ACTIVE')}
                className={`px-3 py-1 rounded-full border transition-all whitespace-nowrap flex items-center space-x-1.5 cursor-pointer ${
                  quickFilter === 'MATCHED_ACTIVE'
                    ? 'bg-fuchsia-600 text-white border-fuchsia-500 font-bold shadow-[0_0_10px_rgba(217,70,239,0.5)]'
                    : 'bg-[#22132b] text-fuchsia-300 border-fuchsia-500/40 hover:bg-[#2e1a3b]'
                }`}
                title={`Tracks, die mit "${effectiveActiveTrack.title}" verknüpft sind`}
              >
                <Link2 size={12} className="text-fuchsia-300" />
                <span>Matches für Deck ({stats.matchedActive})</span>
              </button>
            )}

            {/* Traffic Light Harmonic Match */}
            {effectiveActiveTrack?.key && (
              <button
                onClick={() => setQuickFilter('HARMONIC_TRAFFIC_LIGHT')}
                className={`px-3 py-1 rounded-full border transition-all whitespace-nowrap flex items-center space-x-1.5 cursor-pointer ${
                  quickFilter === 'HARMONIC_TRAFFIC_LIGHT'
                    ? 'bg-emerald-600 text-white border-emerald-500 font-bold shadow-[0_0_10px_rgba(16,185,129,0.5)]'
                    : 'bg-[#0e2118] text-emerald-300 border-emerald-500/40 hover:bg-[#142e22]'
                }`}
                title={`Harmonische Ampel: Tracks in ${effectiveActiveTrack.key} (±1 Camelot) & BPM ±7%`}
              >
                <Zap size={12} className="text-emerald-300" />
                <span>Harmonisch zum Deck ({stats.harmonicMatches})</span>
              </button>
            )}

            {/* BPM Near */}
            {effectiveActiveTrack?.bpm && (
              <button
                onClick={() => setQuickFilter('BPM_NEAR')}
                className={`px-3 py-1 rounded-full border transition-all whitespace-nowrap flex items-center space-x-1.5 cursor-pointer ${
                  quickFilter === 'BPM_NEAR'
                    ? 'bg-cyan-600 text-white border-cyan-500 font-bold'
                    : 'bg-[#101d26] text-cyan-300 border-cyan-500/40 hover:bg-[#162734]'
                }`}
              >
                <Activity size={12} />
                <span>BPM Match ±5% ({stats.bpmMatches})</span>
              </button>
            )}

            {/* Top-Rated */}
            <button
              onClick={() => setQuickFilter('TOP_RATED')}
              className={`px-3 py-1 rounded-full border transition-all whitespace-nowrap flex items-center space-x-1.5 cursor-pointer ${
                quickFilter === 'TOP_RATED'
                  ? 'bg-amber-600 text-white border-amber-500 font-bold'
                  : 'bg-[#221c10] text-amber-300 border-amber-500/40 hover:bg-[#2d2516]'
              }`}
            >
              <Star size={12} className="fill-amber-400 text-amber-400" />
              <span>4-5 Sterne ({stats.topRated})</span>
            </button>

            {/* Cues & Phrases Quick Buttons */}
            <button
              onClick={() => setQuickFilter('HAS_HOT_CUE')}
              className={`px-2.5 py-1 rounded-full border transition-all whitespace-nowrap cursor-pointer ${
                quickFilter === 'HAS_HOT_CUE'
                  ? 'bg-blue-600 text-white border-blue-500 font-bold'
                  : 'bg-[#121624] text-neutral-300 border-[#252b42]'
              }`}
            >
              Hot Cues ({stats.withHotCue})
            </button>

            <button
              onClick={() => setQuickFilter('HAS_MEMORY')}
              className={`px-2.5 py-1 rounded-full border transition-all whitespace-nowrap cursor-pointer ${
                quickFilter === 'HAS_MEMORY'
                  ? 'bg-red-600 text-white border-red-500 font-bold'
                  : 'bg-[#121624] text-neutral-300 border-[#252b42]'
              }`}
            >
              Memory Cues ({stats.withMemory})
            </button>

            <button
              onClick={() => setQuickFilter('HAS_PHRASES')}
              className={`px-2.5 py-1 rounded-full border transition-all whitespace-nowrap cursor-pointer ${
                quickFilter === 'HAS_PHRASES'
                  ? 'bg-indigo-600 text-white border-indigo-500 font-bold'
                  : 'bg-[#121624] text-neutral-300 border-[#252b42]'
              }`}
            >
              PSSI Phrasen ({stats.withPhrases})
            </button>
          </div>

          {/* ================= EXPANDABLE PRO FILTER MATRIX ================= */}
          {showProFilters && (
            <div className="p-3 bg-[#0a0b10] border border-[#24293e] rounded-md space-y-3 mt-1 text-[11px]">
              {/* Camelot 24-Key Wheel Ribbon */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-bold text-neutral-300 flex items-center space-x-1.5">
                    <Disc size={12} className="text-[#00e5ff]" />
                    <span>Camelot Tonarten-Matrix (Klick filtert exakte Tonart):</span>
                  </span>
                  {selectedCamelotKey && (
                    <button
                      onClick={() => setSelectedCamelotKey(null)}
                      className="text-[10px] text-neutral-400 hover:text-white"
                    >
                      Tonart-Filter aufheben ({selectedCamelotKey})
                    </button>
                  )}
                </div>

                {/* Minor row (A) */}
                <div className="flex items-center gap-1 overflow-x-auto pb-1">
                  <span className="w-12 text-[10px] font-mono font-bold text-blue-400 flex-shrink-0">Moll (A):</span>
                  {CAMELOT_KEYS_A.map((k) => {
                    const isActive = selectedCamelotKey === k;
                    const isDeckKey = effectiveActiveTrack?.key && getCamelotInfo(effectiveActiveTrack.key).code === k;
                    return (
                      <button
                        key={k}
                        onClick={() => setSelectedCamelotKey(isActive ? null : k)}
                        className={`w-8 h-6 rounded flex items-center justify-center font-mono font-bold text-[10px] transition-all cursor-pointer ${
                          isActive
                            ? 'bg-[#0088ff] text-white ring-2 ring-white'
                            : isDeckKey
                            ? 'bg-blue-950/80 text-[#00e5ff] border border-blue-400 font-black'
                            : 'bg-[#141724] text-neutral-300 border border-[#23283c] hover:bg-[#202538]'
                        }`}
                        title={isDeckKey ? `${k} (Aktuelle Deck-Tonart)` : k}
                      >
                        {k}
                      </button>
                    );
                  })}
                </div>

                {/* Major row (B) */}
                <div className="flex items-center gap-1 overflow-x-auto">
                  <span className="w-12 text-[10px] font-mono font-bold text-emerald-400 flex-shrink-0">Dur (B):</span>
                  {CAMELOT_KEYS_B.map((k) => {
                    const isActive = selectedCamelotKey === k;
                    const isDeckKey = effectiveActiveTrack?.key && getCamelotInfo(effectiveActiveTrack.key).code === k;
                    return (
                      <button
                        key={k}
                        onClick={() => setSelectedCamelotKey(isActive ? null : k)}
                        className={`w-8 h-6 rounded flex items-center justify-center font-mono font-bold text-[10px] transition-all cursor-pointer ${
                          isActive
                            ? 'bg-emerald-600 text-white ring-2 ring-white'
                            : isDeckKey
                            ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-400 font-black'
                            : 'bg-[#141724] text-neutral-300 border border-[#23283c] hover:bg-[#202538]'
                        }`}
                        title={isDeckKey ? `${k} (Aktuelle Deck-Tonart)` : k}
                      >
                        {k}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Grid: BPM Presets + Genre + Rating */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-[#1e2336]">
                {/* BPM Presets */}
                <div className="space-y-1">
                  <span className="font-bold text-neutral-300 block">BPM Schnell-Bereiche:</span>
                  <div className="flex flex-wrap gap-1">
                    {[
                      { id: 'ALL', label: 'Alle BPM' },
                      { id: 'PLUS_MINUS_4', label: '±4% zum Deck' },
                      { id: 'PLUS_MINUS_8', label: '±8% zum Deck' },
                      { id: 'HOUSE_120_128', label: '120-128 (House)' },
                      { id: 'TECHNO_128_138', label: '128-138 (Techno)' },
                      { id: 'BASS_140_150', label: '140-150 (Bass)' },
                      { id: 'DNB_170_176', label: '170-176 (D&B)' },
                    ].map((b) => (
                      <button
                        key={b.id}
                        onClick={() => setBpmRangePreset(b.id)}
                        className={`px-2 py-0.5 rounded text-[10.5px] border cursor-pointer ${
                          bpmRangePreset === b.id
                            ? 'bg-[#0088ff] text-white border-[#0088ff] font-bold'
                            : 'bg-[#151824] text-neutral-300 border-[#24283c]'
                        }`}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Genre Selector */}
                <div className="space-y-1">
                  <span className="font-bold text-neutral-300 block">Genre-Filter:</span>
                  <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
                    <button
                      onClick={() => setSelectedGenre('ALL')}
                      className={`px-2 py-0.5 rounded text-[10.5px] border cursor-pointer ${
                        selectedGenre === 'ALL'
                          ? 'bg-[#0088ff] text-white border-[#0088ff] font-bold'
                          : 'bg-[#151824] text-neutral-300 border-[#24283c]'
                      }`}
                    >
                      Alle Genres
                    </button>
                    {availableGenres.map(([g, count]) => (
                      <button
                        key={g}
                        onClick={() => setSelectedGenre(g)}
                        className={`px-2 py-0.5 rounded text-[10.5px] border cursor-pointer ${
                          selectedGenre === g
                            ? 'bg-[#0088ff] text-white border-[#0088ff] font-bold'
                            : 'bg-[#151824] text-neutral-300 border-[#24283c]'
                        }`}
                      >
                        {g} ({count})
                      </button>
                    ))}
                  </div>
                </div>

                {/* Rating Filter */}
                <div className="space-y-1">
                  <span className="font-bold text-neutral-300 block">Mindest-Rating:</span>
                  <div className="flex items-center space-x-1">
                    {[0, 1, 2, 3, 4, 5].map((stars) => (
                      <button
                        key={stars}
                        onClick={() => setMinRating(stars)}
                        className={`px-2 py-1 rounded text-[10.5px] border flex items-center space-x-0.5 cursor-pointer ${
                          minRating === stars
                            ? 'bg-amber-600 text-white border-amber-500 font-bold'
                            : 'bg-[#151824] text-neutral-300 border-[#24283c]'
                        }`}
                      >
                        {stars === 0 ? (
                          <span>Alle</span>
                        ) : (
                          <>
                            <span>{stars}</span>
                            <Star size={10} className="fill-amber-400 text-amber-400" />
                            <span>+</span>
                          </>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ================= MAIN CONTENT: TABLE OR CARDS ================= */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col bg-[#0a0b10]">
          
          {filteredTracks.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-neutral-500 text-center">
              <Search size={40} className="mb-3 opacity-30 text-neutral-400" />
              <p className="text-sm text-neutral-300 font-bold">Keine passenden Tracks gefunden</p>
              <p className="text-xs text-neutral-500 mt-1 max-w-sm">
                Suchbegriff oder aktive Filterkriterien lieferten 0 Treffer.
              </p>
              <button
                onClick={handleResetFilters}
                className="mt-3 px-3.5 py-1.5 bg-[#171a26] hover:bg-[#232738] border border-[#2d3348] text-white rounded text-xs transition-colors cursor-pointer"
              >
                Filter zurücksetzen
              </button>
            </div>
          ) : viewLayout === 'TABLE' ? (
            /* ================= VIEW 1: REKORDBOX PRO TABLE ================= */
            <div className="flex-1 overflow-y-auto overflow-x-auto select-none">
              <table className="w-full text-left border-collapse font-sans text-xs">
                <thead className="bg-[#121520] border-b border-[#212638] text-[10.5px] text-neutral-400 sticky top-0 z-20 select-none">
                  <tr>
                    <th className="py-2.5 px-2 w-10 text-center"></th>
                    <th
                      onClick={() => handleSortToggle('id')}
                      className="py-2.5 px-2 cursor-pointer hover:text-white w-12 text-center"
                    >
                      <div className="flex items-center justify-center space-x-1">
                        <span>#</span>
                        {sortField === 'id' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('title')}
                      className="py-2.5 px-3 cursor-pointer hover:text-white"
                    >
                      <div className="flex items-center space-x-1">
                        <span>TITEL &amp; ALBUM</span>
                        {sortField === 'title' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('artist')}
                      className="py-2.5 px-3 cursor-pointer hover:text-white"
                    >
                      <div className="flex items-center space-x-1">
                        <span>INTERPRET</span>
                        {sortField === 'artist' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('bpm')}
                      className="py-2.5 px-3 cursor-pointer hover:text-white w-28 text-right"
                    >
                      <div className="flex items-center justify-end space-x-1">
                        <span>BPM (DELTA)</span>
                        {sortField === 'bpm' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('key')}
                      className="py-2.5 px-3 cursor-pointer hover:text-white w-24 text-center"
                    >
                      <div className="flex items-center justify-center space-x-1">
                        <span>KEY (AMPEL)</span>
                        {sortField === 'key' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('matches')}
                      className="py-2.5 px-3 cursor-pointer hover:text-white w-32 text-center"
                    >
                      <div className="flex items-center justify-center space-x-1">
                        <Link size={11} className="text-purple-400" />
                        <span>MATCHES</span>
                        {sortField === 'matches' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('rating')}
                      className="py-2.5 px-2 cursor-pointer hover:text-white w-20 text-center"
                    >
                      <div className="flex items-center justify-center space-x-1">
                        <span>RATING</span>
                        {sortField === 'rating' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th
                      onClick={() => handleSortToggle('duration')}
                      className="py-2.5 px-2 cursor-pointer hover:text-white w-16 text-center"
                    >
                      <div className="flex items-center justify-center space-x-1">
                        <span>ZEIT</span>
                        {sortField === 'duration' && <ArrowUpDown size={10} className="text-[#0088ff]" />}
                      </div>
                    </th>
                    <th className="py-2.5 px-2 w-28 text-center">
                      <span>CUES &amp; PHRASEN</span>
                    </th>
                    <th className="py-2.5 px-3 w-40 text-right">
                      <span>AKTIONEN</span>
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-[#161924]">
                  {visibleTracks.map((tr, idx) => {
                    const isSelected = tr.id === selectedTrackId;
                    const isCurrentlyInDeck = tr.id === currentTrackId;
                    const isExpanded = expandedTrackIds.has(tr.id);
                    const isPreviewing = previewingTrackId === tr.id;

                    const memCuesCount = tr.cues.filter((c) => c.type === 'MEMORY').length;
                    const hotCuesCount = tr.cues.filter((c) => c.type === 'HOT_CUE').length;
                    const phrasesCount = tr.phrases?.length || 0;

                    // Matching status with active track
                    const isMatchedWithActive =
                      effectiveActiveTrack && effectiveActiveTrack.id !== tr.id
                        ? areTracksMatched(effectiveActiveTrack.id, tr.id)
                        : false;

                    const allLinkedIds = getAllLinkedTrackIds(tr, matchStore);
                    const linkedCount = allLinkedIds.length;

                    // Harmonic calculation against active track
                    const harmonicStatus: HarmonicTrafficLight | null =
                      effectiveActiveTrack?.key && tr.key
                        ? calculateHarmonicCompatibility(effectiveActiveTrack.key, tr.key)
                        : null;

                    // BPM delta calculation
                    const bpmDiffPct =
                      effectiveActiveTrack && effectiveActiveTrack.bpm > 0
                        ? ((tr.bpm - effectiveActiveTrack.bpm) / effectiveActiveTrack.bpm) * 100
                        : 0;

                    return (
                      <React.Fragment key={tr.id}>
                        <tr
                          onClick={() => setSelectedTrackId(tr.id)}
                          onDoubleClick={() => handleLoadTrack(tr)}
                          className={`cursor-pointer transition-colors group ${
                            isSelected
                              ? 'bg-[#0088ff]/15 border-l-2 border-[#0088ff]'
                              : 'hover:bg-[#131724]'
                          }`}
                        >
                          {/* Expand chevron */}
                          <td className="py-2 px-2 text-center text-neutral-500">
                            <button
                              onClick={(e) => handleToggleExpand(tr.id, e)}
                              className="p-0.5 hover:text-white cursor-pointer"
                              title="Details &amp; Phrasen aufklappen"
                            >
                              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </td>

                          {/* Track index / ID */}
                          <td className="py-2 px-2 text-center font-mono text-[11px] text-neutral-400">
                            {tr.id || idx + 1}
                          </td>

                          {/* Title & Album */}
                          <td className="py-2 px-3">
                            <div className="flex items-center space-x-2">
                              <span className="font-semibold text-neutral-100 group-hover:text-white">
                                {tr.title}
                              </span>
                              {isCurrentlyInDeck && (
                                <span className="px-1.5 py-0.2 bg-[#0088ff]/30 text-[#00a2ff] border border-[#0088ff]/40 rounded text-[9px] font-mono font-bold">
                                  IM DECK
                                </span>
                              )}
                              {isMatchedWithActive && (
                                <span className="px-1.5 py-0.2 bg-purple-500/25 text-purple-300 border border-purple-500/40 rounded text-[9px] font-mono font-bold flex items-center space-x-0.5">
                                  <Link2 size={9} />
                                  <span>GEMATCHT</span>
                                </span>
                              )}
                            </div>
                            {tr.album && (
                              <div className="text-[10.5px] text-neutral-500 truncate max-w-xs">
                                {tr.album}
                              </div>
                            )}
                          </td>

                          {/* Artist */}
                          <td className="py-2 px-3 text-neutral-300 font-medium">
                            {tr.artist || 'Unbekannt'}
                          </td>

                          {/* BPM with Delta Indicator */}
                          <td className="py-2 px-3 text-right font-mono">
                            <div className="font-bold text-white text-[11.5px]">
                              {tr.bpm.toFixed(2)}
                            </div>
                            {effectiveActiveTrack && effectiveActiveTrack.id !== tr.id && (
                              <div
                                className={`text-[9.5px] ${
                                  Math.abs(bpmDiffPct) <= 2
                                    ? 'text-emerald-400 font-bold'
                                    : Math.abs(bpmDiffPct) <= 6
                                    ? 'text-cyan-400'
                                    : 'text-neutral-500'
                                }`}
                              >
                                {bpmDiffPct >= 0 ? `+${bpmDiffPct.toFixed(1)}%` : `${bpmDiffPct.toFixed(1)}%`}
                              </div>
                            )}
                          </td>

                          {/* Key with Rekordbox Traffic Light */}
                          <td className="py-2 px-3 text-center">
                            <div className="inline-flex items-center space-x-1.5">
                              {harmonicStatus && (
                                <span
                                  style={{ backgroundColor: harmonicStatus.badgeColor }}
                                  className="w-2 h-2 rounded-full flex-shrink-0 shadow-sm"
                                  title={`Harmonie: ${harmonicStatus.label} (${harmonicStatus.explanation})`}
                                />
                              )}
                              <span className="px-1.5 py-0.5 rounded bg-[#161a28] border border-[#272e44] font-mono font-bold text-white text-[10.5px]">
                                {tr.key || '--'}
                              </span>
                            </div>
                          </td>

                          {/* Matching Button & Badge (REKORDBOX MATCHING) */}
                          <td className="py-2 px-3 text-center">
                            <div className="flex items-center justify-center space-x-1.5">
                              {effectiveActiveTrack && effectiveActiveTrack.id !== tr.id ? (
                                <button
                                  onClick={(e) => handleToggleMatch(tr.id, e)}
                                  className={`px-2 py-0.5 rounded border text-[10px] font-mono font-bold flex items-center space-x-1 transition-all cursor-pointer ${
                                    isMatchedWithActive
                                      ? 'bg-purple-600 text-white border-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.4)]'
                                      : 'bg-[#171424] text-purple-300 border-purple-500/30 hover:bg-purple-900/40'
                                  }`}
                                  title={
                                    isMatchedWithActive
                                      ? 'Verknüpfung mit aktivem Deck lösen'
                                      : 'Mit aktivem Deck als passendes Paar verknüpfen'
                                  }
                                >
                                  {isMatchedWithActive ? <Link size={10} /> : <Link2 size={10} />}
                                  <span>{isMatchedWithActive ? 'Verknüpft' : 'Match'}</span>
                                </button>
                              ) : (
                                <span className="text-[10px] text-neutral-600 font-mono">-</span>
                              )}

                              {linkedCount > 0 && (
                                <span
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleToggleExpand(tr.id);
                                  }}
                                  className="px-1.5 py-0.5 rounded bg-purple-950/60 border border-purple-500/30 text-purple-300 font-mono text-[9.5px] cursor-pointer hover:brightness-125"
                                  title={`${linkedCount} Verknüpfungen hinterlegt. Klick zum Aufklappen.`}
                                >
                                  {linkedCount}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Rating */}
                          <td className="py-2 px-2 text-center">
                            <div className="flex items-center justify-center space-x-0.5 text-amber-400">
                              {[1, 2, 3, 4, 5].map((s) => (
                                <Star
                                  key={s}
                                  size={10}
                                  className={s <= (tr.rating || 0) ? 'fill-amber-400' : 'text-neutral-700'}
                                />
                              ))}
                            </div>
                          </td>

                          {/* Duration */}
                          <td className="py-2 px-2 text-center font-mono text-neutral-300">
                            {formatTime(tr.duration)}
                          </td>

                          {/* Cues & Phrases Badges */}
                          <td className="py-2 px-2 text-center">
                            <div className="flex items-center justify-center space-x-1">
                              {hotCuesCount > 0 && (
                                <span className="px-1.5 py-0.2 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[9.5px] font-mono">
                                  {hotCuesCount}H
                                </span>
                              )}
                              {memCuesCount > 0 && (
                                <span className="px-1.5 py-0.2 rounded bg-red-500/20 text-red-300 border border-red-500/30 text-[9.5px] font-mono">
                                  {memCuesCount}M
                                </span>
                              )}
                              {phrasesCount > 0 && (
                                <span className="px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[9.5px] font-mono">
                                  {phrasesCount}P
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Action Buttons: Pre-listen & Load Deck */}
                          <td className="py-2 px-3 text-right">
                            <div className="flex items-center justify-end space-x-1.5">
                              {/* Audio Pre-Listen Button */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleTogglePreListen(tr);
                                }}
                                className={`p-1.5 rounded transition-colors cursor-pointer ${
                                  isPreviewing
                                    ? 'bg-amber-500 text-black animate-pulse'
                                    : 'bg-[#181b28] hover:bg-[#252a3d] text-neutral-300 hover:text-white'
                                }`}
                                title={isPreviewing ? 'Vorhören stoppen' : 'Audio-Vorschau vorhören (Space)'}
                              >
                                {isPreviewing ? <VolumeX size={12} /> : <Volume2 size={12} />}
                              </button>

                              {/* Load in Deck Button */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleLoadTrack(tr);
                                }}
                                className="px-2.5 py-1 bg-[#0088ff] hover:bg-[#0070d6] active:bg-[#005bb5] text-white rounded font-bold text-[11px] shadow-sm transition-colors inline-flex items-center space-x-1 cursor-pointer"
                                title="Diesen Track in das DJ-Deck laden"
                              >
                                <Play size={10} fill="currentColor" />
                                <span>In Deck</span>
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* ================= EXPANDED ROW DRAWER ================= */}
                        {isExpanded && (
                          <tr className="bg-[#0e1017] border-b border-[#24283c]">
                            <td colSpan={11} className="p-3 pl-8">
                              <div className="space-y-3">
                                
                                {/* Row 1: Song Structure Ribbon (Phrases) */}
                                {tr.phrases && tr.phrases.length > 0 ? (
                                  <div>
                                    <div className="flex items-center justify-between text-[10px] text-neutral-400 font-mono mb-1">
                                      <span className="flex items-center space-x-1.5 text-neutral-300 font-bold">
                                        <Layers size={11} className="text-[#00e5ff]" />
                                        <span>Rekordbox PSSI Song-Struktur ({tr.phrases.length} Phrasen):</span>
                                      </span>
                                      <span>Dauer: {formatTime(tr.duration)}</span>
                                    </div>
                                    <div className="h-6 w-full rounded bg-[#07080d] border border-[#1b1e2c] overflow-hidden flex">
                                      {tr.phrases.map((ph, pIdx) => {
                                        const durPct = Math.max(2, ((ph.endTime - ph.startTime) / tr.duration) * 100);
                                        return (
                                          <div
                                            key={pIdx}
                                            style={{
                                              width: `${durPct}%`,
                                              backgroundColor: `${ph.color || '#0088ff'}25`,
                                              borderColor: ph.color || '#0088ff',
                                            }}
                                            className="h-full border-r relative flex items-center justify-center px-1 text-[8.5px] font-bold truncate text-white"
                                            title={`${ph.name}: Takt ${ph.startBar}-${ph.endBar} (${formatTime(ph.startTime)} - ${formatTime(ph.endTime)})`}
                                          >
                                            {ph.name}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="text-[10px] text-neutral-500 italic">
                                    Keine PSSI Phrasen-Analyse hinterlegt.
                                  </div>
                                )}

                                {/* Row 2: Cues & Matched Tracks Drawer */}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 text-[11px]">
                                  {/* Cues List */}
                                  <div className="p-2.5 rounded bg-[#131622] border border-[#212638] space-y-1.5">
                                    <span className="font-bold text-neutral-300 block text-[10px] uppercase">
                                      Hot Cues &amp; Memory Cues ({tr.cues.length}):
                                    </span>
                                    <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
                                      {tr.cues.length === 0 ? (
                                        <span className="text-neutral-500 text-[10px] italic">Keine Cues gesetzt</span>
                                      ) : (
                                        tr.cues.map((c) => (
                                          <div
                                            key={c.id}
                                            className="px-2 py-0.5 rounded bg-[#191d2c] border border-[#2a3048] font-mono text-[9.5px] flex items-center space-x-1"
                                          >
                                            <span
                                              style={{ backgroundColor: c.color || '#0088ff' }}
                                              className="w-1.5 h-1.5 rounded-full"
                                            />
                                            <span className="font-bold text-white">
                                              {c.type === 'HOT_CUE' ? `HOT ${c.letter || 'A'}` : 'MEM'}
                                            </span>
                                            <span className="text-neutral-400">{formatTime(c.position)}</span>
                                            {c.name && <span className="text-neutral-300 truncate max-w-[80px]">"{c.name}"</span>}
                                          </div>
                                        ))
                                      )}
                                    </div>
                                  </div>

                                  {/* Matched Tracks & DJ Notes */}
                                  <div className="p-2.5 rounded bg-[#1a1426] border border-purple-500/30 space-y-1.5">
                                    <div className="flex items-center justify-between">
                                      <span className="font-bold text-purple-300 text-[10px] uppercase flex items-center space-x-1">
                                        <Link size={11} />
                                        <span>Verknüpfte Tracks ({allLinkedIds.length}):</span>
                                      </span>
                                      {effectiveActiveTrack && effectiveActiveTrack.id !== tr.id && (
                                        <button
                                          onClick={() => handleToggleMatch(tr.id)}
                                          className="text-[10px] text-purple-300 hover:text-white underline cursor-pointer"
                                        >
                                          {isMatchedWithActive ? 'Verknüpfung trennen' : 'Mit aktuellem Deck verknüpfen'}
                                        </button>
                                      )}
                                    </div>

                                    {allLinkedIds.length === 0 ? (
                                      <p className="text-[10.5px] text-neutral-500 italic">
                                        Noch keine Verknüpfungen. Klicke auf "Match", um diesen Track mit dem Deck zu koppeln!
                                      </p>
                                    ) : (
                                      <div className="space-y-1 max-h-24 overflow-y-auto">
                                        {allLinkedIds.map((linkedId) => {
                                          const linkedTrack = xmlTracks.find((t) => t.id === linkedId);
                                          const note = getMatchNote(tr.id, linkedId);
                                          return (
                                            <div
                                              key={linkedId}
                                              className="p-1.5 rounded bg-[#201830] border border-purple-500/20 flex items-center justify-between"
                                            >
                                              <div className="truncate max-w-[240px]">
                                                <span className="font-bold text-white text-[10.5px]">
                                                  {linkedTrack ? linkedTrack.title : `Track #${linkedId}`}
                                                </span>
                                                {linkedTrack && (
                                                  <span className="text-neutral-400 font-mono text-[9.5px] ml-1.5">
                                                    ({linkedTrack.bpm.toFixed(1)} BPM, {linkedTrack.key})
                                                  </span>
                                                )}
                                                {note && (
                                                  <div className="text-[9.5px] text-amber-300 italic truncate">
                                                    Notiz: "{note}"
                                                  </div>
                                                )}
                                              </div>
                                              {linkedTrack && (
                                                <button
                                                  onClick={() => handleLoadTrack(linkedTrack)}
                                                  className="px-2 py-0.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-[9.5px] font-bold cursor-pointer"
                                                >
                                                  Laden
                                                </button>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}

                                    {/* Note input if matched with active track */}
                                    {isMatchedWithActive && (
                                      <div className="pt-1 flex items-center space-x-1.5">
                                        <input
                                          type="text"
                                          placeholder="DJ Notiz zu diesem Übergang (z.B. Drop-Mix bei Cue B)..."
                                          value={editingNoteTrackId === tr.id ? noteDraft : getMatchNote(effectiveActiveTrack!.id, tr.id) || ''}
                                          onFocus={() => {
                                            setEditingNoteTrackId(tr.id);
                                            setNoteDraft(getMatchNote(effectiveActiveTrack!.id, tr.id) || '');
                                          }}
                                          onChange={(e) => setNoteDraft(e.target.value)}
                                          className="flex-1 bg-[#120d1c] border border-purple-500/40 rounded px-2 py-1 text-[10px] text-white focus:outline-none"
                                        />
                                        {editingNoteTrackId === tr.id && (
                                          <button
                                            onClick={() => handleSaveNote(tr.id)}
                                            className="px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded text-[10px] font-bold cursor-pointer"
                                          >
                                            Speichern
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            /* ================= VIEW 2: TACTILE CARD BENTO GRID ================= */
            <div className="flex-1 overflow-y-auto p-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {visibleTracks.map((tr) => {
                  const isSelected = tr.id === selectedTrackId;
                  const isCurrentlyInDeck = tr.id === currentTrackId;
                  const isPreviewing = previewingTrackId === tr.id;
                  const isMatchedWithActive =
                    effectiveActiveTrack && effectiveActiveTrack.id !== tr.id
                      ? areTracksMatched(effectiveActiveTrack.id, tr.id)
                      : false;

                  const harmonicStatus: HarmonicTrafficLight | null =
                    effectiveActiveTrack?.key && tr.key
                      ? calculateHarmonicCompatibility(effectiveActiveTrack.key, tr.key)
                      : null;

                  return (
                    <div
                      key={tr.id}
                      onClick={() => setSelectedTrackId(tr.id)}
                      onDoubleClick={() => handleLoadTrack(tr)}
                      className={`p-3 rounded-lg border transition-all flex flex-col justify-between cursor-pointer group relative ${
                        isSelected
                          ? 'bg-[#151a2e] border-[#0088ff] shadow-[0_0_12px_rgba(0,136,255,0.25)]'
                          : 'bg-[#10131c] border-[#22273a] hover:border-[#353e5c] hover:bg-[#141724]'
                      }`}
                    >
                      <div>
                        {/* Top card row: Key & BPM */}
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center space-x-1.5">
                            {harmonicStatus && (
                              <span
                                style={{ backgroundColor: harmonicStatus.badgeColor }}
                                className="w-2.5 h-2.5 rounded-full"
                                title={harmonicStatus.label}
                              />
                            )}
                            <span className="px-2 py-0.5 rounded bg-[#181d2c] border border-[#2b334d] font-mono font-bold text-white text-xs">
                              {tr.key || '--'}
                            </span>
                          </div>

                          <span className="font-mono font-bold text-white text-xs">
                            {tr.bpm.toFixed(1)} BPM
                          </span>
                        </div>

                        {/* Title & Artist */}
                        <h4 className="font-bold text-white text-xs truncate group-hover:text-[#00e5ff] transition-colors">
                          {tr.title}
                        </h4>
                        <p className="text-[11px] text-neutral-400 truncate mb-2">
                          {tr.artist || 'Unbekannter Interpret'}
                        </p>

                        {/* Mini Waveform visualization */}
                        <div className="h-8 w-full bg-[#08090f] rounded border border-[#1b1f2e] mb-2 relative overflow-hidden flex items-center justify-center">
                          <div className="w-full flex items-end justify-between px-1 h-5 opacity-70">
                            {Array.from({ length: 32 }).map((_, i) => (
                              <div
                                key={i}
                                style={{
                                  height: `${Math.max(15, ((i * 7 + tr.duration) % 85) + 15)}%`,
                                  backgroundColor: harmonicStatus?.badgeColor || '#0088ff',
                                }}
                                className="w-1 rounded-xs"
                              />
                            ))}
                          </div>
                          {isPreviewing && (
                            <div className="absolute inset-0 bg-amber-500/20 flex items-center justify-center font-mono text-[9px] font-bold text-amber-300">
                              VORHÖREN AKTIV
                            </div>
                          )}
                        </div>

                        {/* Meta Tags */}
                        <div className="flex items-center justify-between text-[10px] text-neutral-400 font-mono mb-2">
                          <span>{formatTime(tr.duration)}</span>
                          <span>{tr.genre || 'DJ Track'}</span>
                          <div className="flex items-center text-amber-400">
                            <span>{tr.rating || 0}</span>
                            <Star size={9} className="fill-amber-400 ml-0.5" />
                          </div>
                        </div>
                      </div>

                      {/* Card Bottom Actions */}
                      <div className="pt-2 border-t border-[#1e2334] flex items-center justify-between">
                        <div className="flex items-center space-x-1">
                          {effectiveActiveTrack && effectiveActiveTrack.id !== tr.id && (
                            <button
                              onClick={(e) => handleToggleMatch(tr.id, e)}
                              className={`p-1 rounded border transition-colors cursor-pointer ${
                                isMatchedWithActive
                                  ? 'bg-purple-600 text-white border-purple-400'
                                  : 'bg-[#181524] text-purple-300 border-purple-500/30 hover:bg-purple-900/40'
                              }`}
                              title={isMatchedWithActive ? 'Verknüpfung trennen' : 'Match verknüpfen'}
                            >
                              <Link size={12} />
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTogglePreListen(tr);
                            }}
                            className={`p-1 rounded transition-colors cursor-pointer ${
                              isPreviewing ? 'bg-amber-500 text-black' : 'bg-[#161a28] text-neutral-300 hover:text-white'
                            }`}
                            title="Vorhören"
                          >
                            <Volume2 size={12} />
                          </button>
                        </div>

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleLoadTrack(tr);
                          }}
                          className="px-3 py-1 bg-[#0088ff] hover:bg-[#0070d6] text-white rounded font-bold text-[10.5px] transition-colors flex items-center space-x-1 cursor-pointer"
                        >
                          <Play size={10} fill="currentColor" />
                          <span>Laden</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ================= SELECTED TRACK FOOTER PREVIEW ================= */}
          {selectedTrack && (
            <div className="border-t border-[#212638] bg-[#0c0e14] p-3 flex flex-col sm:flex-row gap-3 items-start justify-between flex-shrink-0 text-xs">
              <div className="space-y-1 min-w-[280px]">
                <div className="flex items-center space-x-2">
                  <Music size={14} className="text-[#00e5ff]" />
                  <span className="font-extrabold text-white text-xs">{selectedTrack.title}</span>
                  <span className="text-neutral-400 font-mono text-[11px]">({selectedTrack.artist})</span>
                </div>
                <div className="flex items-center space-x-3 text-[11px] text-neutral-400 font-mono">
                  <span>
                    BPM: <strong className="text-white">{selectedTrack.bpm.toFixed(2)}</strong>
                  </span>
                  <span>•</span>
                  <span>
                    Key: <strong className="text-[#00e5ff]">{selectedTrack.key || '8A'}</strong>
                  </span>
                  <span>•</span>
                  <span>
                    Dauer: <strong className="text-white">{formatTime(selectedTrack.duration)}</strong>
                  </span>
                  <span>•</span>
                  <span>
                    Sample Rate: <strong className="text-neutral-300">{selectedTrack.sampleRate || 44100} Hz</strong>
                  </span>
                </div>
                <div
                  className={`text-[10px] font-mono ${
                    sourceStatus.kind === 'AVAILABLE'
                      ? 'text-[#34d399]'
                      : sourceStatus.kind === 'MISSING'
                      ? 'text-[#fbbf24]'
                      : 'text-neutral-500'
                  }`}
                >
                  ORIGINAL-STATUS: {sourceStatus.detail}
                </div>
              </div>

              {/* Memory & Hot Cues Preview */}
              <div className="flex-1 overflow-x-auto w-full">
                <div className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider mb-1 flex items-center justify-between">
                  <span>Enthaltene Cues ({selectedTrack.cues.length}):</span>
                  <span className="text-[9px] text-neutral-500 font-normal">
                    Enter lädt in Deck • Leertaste hört vor
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-14 overflow-y-auto">
                  {selectedTrack.cues.length === 0 ? (
                    <span className="text-neutral-500 text-[10.5px] italic">Keine Cues gesetzt</span>
                  ) : (
                    selectedTrack.cues.map((c) => (
                      <div
                        key={c.id}
                        className="px-2 py-0.5 rounded bg-[#151926] border border-[#252b40] text-[10px] font-mono flex items-center space-x-1.5"
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: c.color || (c.type === 'MEMORY' ? '#ff2222' : '#00a2ff') }}
                        />
                        <span className="font-bold text-neutral-200">
                          {c.name || (c.type === 'MEMORY' ? 'MEM' : `HOT ${c.letter || ''}`)}
                        </span>
                        <span className="text-neutral-400 text-[9.5px]">{formatMsec(c.position)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ================= MODAL BOTTOM STATUS BAR ================= */}
        <div className="h-11 bg-[#10121a] border-t border-[#202436] px-4 flex items-center justify-between flex-shrink-0">
          <div className="text-[11px] text-neutral-400 flex items-center space-x-3">
            <span>
              Zeige <strong>{visibleTracks.length}</strong> von <strong>{filteredTracks.length}</strong> Treffern
            </span>
            {isAnyFilterActive && (
              <span className="text-[#00e5ff] font-mono text-[10.5px] font-semibold">
                (Gefiltert)
              </span>
            )}
            <span className="text-neutral-500 hidden md:inline text-[10px] font-mono">
              [↑/↓: Navigieren • Enter: Laden • Space: Vorhören • M: Match]
            </span>
          </div>

          <div className="flex items-center space-x-2.5">
            {visibleTracks.length < filteredTracks.length && (
              <button
                onClick={() => setVisibleTrackLimit((l) => l + 250)}
                className="px-3.5 py-1.5 bg-[#171a26] hover:bg-[#232738] border border-[#2b3145] text-neutral-300 hover:text-white rounded text-xs transition-colors cursor-pointer"
              >
                Weitere 250 anzeigen
              </button>
            )}

            <button
              onClick={onClose}
              className="px-3.5 py-1.5 bg-[#171a26] hover:bg-[#232738] border border-[#2b3145] text-neutral-300 hover:text-white rounded text-xs transition-colors cursor-pointer"
            >
              Schließen
            </button>

            {selectedTrack && (
              <button
                onClick={() => handleLoadTrack(selectedTrack)}
                className="px-4 py-1.5 bg-[#0088ff] hover:bg-[#0070d6] active:bg-[#005bb5] text-white rounded font-bold text-xs shadow-md transition-colors flex items-center space-x-1.5 cursor-pointer"
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
