import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Header } from "./components/Header";
import { DualDeckPlayer } from "./components/DualDeckPlayer";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { TrackTable } from "./components/TrackTable";
import { TrackDetailModal } from "./components/TrackDetailModal";
import { MidiMappingModal } from "./components/MidiMappingModal";
import { AiDjChatDrawer } from "./components/AiDjChatDrawer";
import { GitSyncModal } from "./components/GitSyncModal";

import {
  DJTrack,
  TrackLink,
  DeckState,
  MixerState,
  LibraryFilters,
} from "./types";
import {
  INITIAL_TRACKS,
  INITIAL_TRACK_LINKS,
} from "./data/initialTracks";
import { audioEngine } from "./services/audioEngine";
import { midiService } from "./services/midiService";

export default function App() {
  // --- Persistent Library & Links State ---
  const [tracks, setTracks] = useState<DJTrack[]>(() => {
    try {
      const saved = localStorage.getItem("airdox_tracks");
      return saved ? JSON.parse(saved) : INITIAL_TRACKS;
    } catch {
      return INITIAL_TRACKS;
    }
  });

  const [links, setLinks] = useState<TrackLink[]>(() => {
    try {
      const saved = localStorage.getItem("airdox_links");
      return saved ? JSON.parse(saved) : INITIAL_TRACK_LINKS;
    } catch {
      return INITIAL_TRACK_LINKS;
    }
  });

  // Save changes locally
  useEffect(() => {
    try {
      localStorage.setItem("airdox_tracks", JSON.stringify(tracks));
    } catch {
      // ignore
    }
  }, [tracks]);

  useEffect(() => {
    try {
      localStorage.setItem("airdox_links", JSON.stringify(links));
    } catch {
      // ignore
    }
  }, [links]);

  // --- Decks & Mixer State ---
  const [deck1, setDeck1] = useState<DeckState>({
    deckId: 1,
    track: tracks[0] || null, // Default Opus
    isPlaying: false,
    currentTime: 0,
    duration: tracks[0]?.duration || 560,
    bpm: tracks[0]?.bpm || 126,
    pitchRate: 1.0,
    volume: 0.85,
    eqHigh: 0.5,
    eqMid: 0.5,
    eqLow: 0.5,
    filter: 0,
    cueTime: 0,
    isLooping: false,
    loopLength: 4,
    vinylMode: true,
    vuMeter: 0,
  });

  const [deck2, setDeck2] = useState<DeckState>({
    deckId: 2,
    track: tracks[1] || null, // Default Innerbloom
    isPlaying: false,
    currentTime: 0,
    duration: tracks[1]?.duration || 442,
    bpm: tracks[1]?.bpm || 125,
    pitchRate: 1.0,
    volume: 0.85,
    eqHigh: 0.5,
    eqMid: 0.5,
    eqLow: 0.5,
    filter: 0,
    cueTime: 0,
    isLooping: false,
    loopLength: 4,
    vinylMode: true,
    vuMeter: 0,
  });

  const [mixer, setMixer] = useState<MixerState>({
    crossfader: 0,
    masterVolume: 0.9,
    headphoneCue: { deck1: false, deck2: false, master: true },
  });

  // --- Filter State ---
  const [filters, setFilters] = useState<LibraryFilters>({
    search: "",
    genre: "",
    onlyLinked: false, // The core requested Rekordbox Match filter
    camelotKey: "",
    bpmMin: 115,
    bpmMax: 180,
    minRating: 0,
    minEnergy: 0,
    selectedTag: "",
  });

  // --- UI Visibility & Modals ---
  const [decksVisible, setDecksVisible] = useState(true);
  const [inspectingTrack, setInspectingTrack] = useState<DJTrack | null>(null);
  const [isMidiModalOpen, setIsMidiModalOpen] = useState(false);
  const [isAiChatOpen, setIsAiChatOpen] = useState(false);
  const [isGitModalOpen, setIsGitModalOpen] = useState(false);

  // --- Hardware & MIDI State ---
  const [activeMidiPreset, setActiveMidiPreset] = useState<"ddj-flx4" | "ddj-1000" | "custom">("ddj-flx4");
  const [connectedMidiDevices, setConnectedMidiDevices] = useState<string[]>([]);

  // Initialize Web Audio Engine with initial tracks
  useEffect(() => {
    audioEngine.init();
    if (tracks[0]) audioEngine.deck1?.setTrack(tracks[0]);
    if (tracks[1]) audioEngine.deck2?.setTrack(tracks[1]);
    audioEngine.setCrossfader(0);
    audioEngine.setMasterVolume(0.9);
  }, []);

  // Initialize Web MIDI API and register listener
  useEffect(() => {
    midiService.init();

    const unsubDevices = midiService.onDeviceChange((devices) => {
      setConnectedMidiDevices(devices);
    });

    const unsubAction = midiService.onAction((actionId, value) => {
      handleMidiAction(actionId, value);
    });

    return () => {
      unsubDevices();
      unsubAction();
    };
  }, []);

  // Handle hardware MIDI controller inputs (Pioneer DDJ-FLX4 and DDJ-1000)
  const handleMidiAction = useCallback((actionId: string, value: number) => {
    const normValue = value / 127; // 0 to 1

    switch (actionId) {
      // Deck 1
      case "deck1_play_pause":
        togglePlayPause(1);
        break;
      case "deck1_cue":
        handleCue(1);
        break;
      case "deck1_volume_fader":
        handleVolumeChange(1, normValue);
        break;
      case "deck1_pitch_fader":
        // 0..1 -> 0.92 .. 1.08 (-8% to +8%)
        handlePitchChange(1, 0.92 + normValue * 0.16);
        break;
      case "deck1_eq_high":
        handleEqChange(1, "high", normValue);
        break;
      case "deck1_eq_mid":
        handleEqChange(1, "mid", normValue);
        break;
      case "deck1_eq_low":
        handleEqChange(1, "low", normValue);
        break;
      case "deck1_filter":
        handleFilterChange(1, normValue * 2 - 1);
        break;
      case "deck1_hotcue_1":
        handleHotCue(1, 1);
        break;
      case "deck1_hotcue_2":
        handleHotCue(1, 2);
        break;
      case "deck1_hotcue_3":
        handleHotCue(1, 3);
        break;

      // Deck 2
      case "deck2_play_pause":
        togglePlayPause(2);
        break;
      case "deck2_cue":
        handleCue(2);
        break;
      case "deck2_volume_fader":
        handleVolumeChange(2, normValue);
        break;
      case "deck2_pitch_fader":
        handlePitchChange(2, 0.92 + normValue * 0.16);
        break;
      case "deck2_eq_high":
        handleEqChange(2, "high", normValue);
        break;
      case "deck2_eq_mid":
        handleEqChange(2, "mid", normValue);
        break;
      case "deck2_eq_low":
        handleEqChange(2, "low", normValue);
        break;
      case "deck2_filter":
        handleFilterChange(2, normValue * 2 - 1);
        break;
      case "deck2_hotcue_1":
        handleHotCue(2, 1);
        break;
      case "deck2_hotcue_2":
        handleHotCue(2, 2);
        break;

      // Mixer
      case "mixer_crossfader":
        // 0..127 -> -1 to 1
        handleCrossfaderChange((value / 127) * 2 - 1);
        break;
      case "mixer_master_volume":
        handleMasterVolumeChange(normValue);
        break;
    }
  }, []);

  // --- Deck Operations ---
  const togglePlayPause = (deckId: 1 | 2) => {
    audioEngine.ensureContext();
    if (deckId === 1) {
      setDeck1((prev) => {
        const nextPlaying = !prev.isPlaying;
        if (nextPlaying) {
          audioEngine.deck1?.play();
        } else {
          audioEngine.deck1?.pause();
        }
        return { ...prev, isPlaying: nextPlaying };
      });
    } else {
      setDeck2((prev) => {
        const nextPlaying = !prev.isPlaying;
        if (nextPlaying) {
          audioEngine.deck2?.play();
        } else {
          audioEngine.deck2?.pause();
        }
        return { ...prev, isPlaying: nextPlaying };
      });
    }
  };

  const handleCue = (deckId: 1 | 2) => {
    audioEngine.ensureContext();
    if (deckId === 1) {
      audioEngine.deck1?.pause();
      setDeck1((prev) => ({ ...prev, isPlaying: false, currentTime: prev.cueTime }));
    } else {
      audioEngine.deck2?.pause();
      setDeck2((prev) => ({ ...prev, isPlaying: false, currentTime: prev.cueTime }));
    }
  };

  const handleHotCue = (deckId: 1 | 2, slot: number) => {
    audioEngine.ensureContext();
    const deck = deckId === 1 ? deck1 : deck2;
    const cue = deck.track?.hotCues?.find((c) => c.slot === slot);
    const targetTime = cue ? cue.time : 0;

    if (deckId === 1) {
      setDeck1((prev) => ({ ...prev, currentTime: targetTime }));
      if (!deck1.isPlaying) togglePlayPause(1);
    } else {
      setDeck2((prev) => ({ ...prev, currentTime: targetTime }));
      if (!deck2.isPlaying) togglePlayPause(2);
    }
  };

  const handlePitchChange = (deckId: 1 | 2, rate: number) => {
    if (deckId === 1) {
      setDeck1((prev) => ({ ...prev, pitchRate: rate }));
      if (deck1.track && audioEngine.deck1) {
        audioEngine.deck1.bpm = deck1.track.bpm * rate;
      }
    } else {
      setDeck2((prev) => ({ ...prev, pitchRate: rate }));
      if (deck2.track && audioEngine.deck2) {
        audioEngine.deck2.bpm = deck2.track.bpm * rate;
      }
    }
  };

  const handleVolumeChange = (deckId: 1 | 2, vol: number) => {
    if (deckId === 1) {
      setDeck1((prev) => ({ ...prev, volume: vol }));
      audioEngine.deck1?.setVolume(vol);
    } else {
      setDeck2((prev) => ({ ...prev, volume: vol }));
      audioEngine.deck2?.setVolume(vol);
    }
  };

  const handleEqChange = (deckId: 1 | 2, band: "low" | "mid" | "high", val: number) => {
    if (deckId === 1) {
      setDeck1((prev) => {
        const next = { ...prev, [band === "low" ? "eqLow" : band === "mid" ? "eqMid" : "eqHigh"]: val };
        audioEngine.deck1?.setEQ(next.eqLow, next.eqMid, next.eqHigh);
        return next;
      });
    } else {
      setDeck2((prev) => {
        const next = { ...prev, [band === "low" ? "eqLow" : band === "mid" ? "eqMid" : "eqHigh"]: val };
        audioEngine.deck2?.setEQ(next.eqLow, next.eqMid, next.eqHigh);
        return next;
      });
    }
  };

  const handleFilterChange = (deckId: 1 | 2, val: number) => {
    if (deckId === 1) {
      setDeck1((prev) => ({ ...prev, filter: val }));
      audioEngine.deck1?.setFilter(val);
    } else {
      setDeck2((prev) => ({ ...prev, filter: val }));
      audioEngine.deck2?.setFilter(val);
    }
  };

  const handleCrossfaderChange = (val: number) => {
    setMixer((prev) => ({ ...prev, crossfader: val }));
    audioEngine.setCrossfader(val);
  };

  const handleMasterVolumeChange = (vol: number) => {
    setMixer((prev) => ({ ...prev, masterVolume: vol }));
    audioEngine.setMasterVolume(vol);
  };

  const loadTrackToDeck = (track: DJTrack, deckId: 1 | 2) => {
    if (deckId === 1) {
      audioEngine.deck1?.pause();
      audioEngine.deck1?.setTrack(track);
      setDeck1((prev) => ({
        ...prev,
        track,
        isPlaying: false,
        currentTime: 0,
        duration: track.duration,
        bpm: track.bpm,
        pitchRate: 1.0,
      }));
    } else {
      audioEngine.deck2?.pause();
      audioEngine.deck2?.setTrack(track);
      setDeck2((prev) => ({
        ...prev,
        track,
        isPlaying: false,
        currentTime: 0,
        duration: track.duration,
        bpm: track.bpm,
        pitchRate: 1.0,
      }));
    }
  };

  const loadPairToDecks = (trackA: DJTrack, trackB: DJTrack) => {
    loadTrackToDeck(trackA, 1);
    loadTrackToDeck(trackB, 2);
  };

  // --- Rekordbox Track Links Management ---
  const handleSaveLink = (linkData: Partial<TrackLink>) => {
    const newLink: TrackLink = {
      id: `link-${Date.now()}`,
      sourceTrackId: linkData.sourceTrackId || "",
      targetTrackId: linkData.targetTrackId || "",
      mixType: linkData.mixType || "smooth_blend",
      notes: linkData.notes || "Harmonischer Übergang",
      rating: linkData.rating || 5,
      sourceExitTime: linkData.sourceExitTime,
      targetEntryTime: linkData.targetEntryTime,
      createdAt: new Date().toISOString().split("T")[0],
    };
    setLinks((prev) => [...prev, newLink]);
  };

  const handleDeleteLink = (linkId: string) => {
    setLinks((prev) => prev.filter((l) => l.id !== linkId));
  };

  const handleQuickLink = (sourceTrackId: string, targetTrackId: string) => {
    const src = tracks.find((t) => t.id === sourceTrackId);
    const tgt = tracks.find((t) => t.id === targetTrackId);
    if (!src || !tgt) return;

    handleSaveLink({
      sourceTrackId,
      targetTrackId,
      mixType: "smooth_blend",
      notes: `Harmonische Verknüpfung: ${src.camelotKey} ➔ ${tgt.camelotKey} (${src.bpm} BPM / ${tgt.bpm} BPM)`,
      rating: 5,
    });
  };

  const handleUpdateTrackMetadata = (trackId: string, updates: Partial<DJTrack>) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, ...updates } : t))
    );
  };

  // --- Filtered Tracks Memo ---
  const filteredTracks = useMemo(() => {
    return tracks.filter((track) => {
      // 1. Rekordbox Matches Filter ("Nur verknüpfte Tracks anzeigen")
      if (filters.onlyLinked) {
        const hasLinks = links.some(
          (l) => l.sourceTrackId === track.id || l.targetTrackId === track.id
        );
        if (!hasLinks) return false;
      }

      // 2. Search Text
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const matchesTitle = track.title.toLowerCase().includes(q);
        const matchesArtist = track.artist.toLowerCase().includes(q);
        const matchesRemix = track.remix?.toLowerCase().includes(q);
        const matchesKey = track.camelotKey.toLowerCase().includes(q);
        const matchesGenre = track.genre.toLowerCase().includes(q);
        const matchesTag = track.tags.some((t) => t.toLowerCase().includes(q));
        if (!matchesTitle && !matchesArtist && !matchesRemix && !matchesKey && !matchesGenre && !matchesTag) {
          return false;
        }
      }

      // 3. Genre
      if (filters.genre && track.genre !== filters.genre) {
        return false;
      }

      // 4. Camelot Key
      if (filters.camelotKey && track.camelotKey !== filters.camelotKey) {
        return false;
      }

      // 5. BPM Max
      if (track.bpm > filters.bpmMax) {
        return false;
      }

      // 6. Min Energy
      if (filters.minEnergy > 0 && track.energy < filters.minEnergy) {
        return false;
      }

      return true;
    });
  }, [tracks, links, filters]);

  // Count tracks with links
  const linkedTracksCount = useMemo(() => {
    const linkedIds = new Set<string>();
    links.forEach((l) => {
      linkedIds.add(l.sourceTrackId);
      linkedIds.add(l.targetTrackId);
    });
    return linkedIds.size;
  }, [links]);

  // --- AI DJ Action Dispatcher ---
  const handleExecuteAiAction = (action: { actionType: string; payload?: any }) => {
    switch (action.actionType) {
      case "set_filter_linked_only":
        setFilters((prev) => ({ ...prev, onlyLinked: true }));
        break;

      case "filter_library":
        if (action.payload) {
          setFilters((prev) => ({ ...prev, ...action.payload }));
        }
        break;

      case "link_tracks":
        if (action.payload?.sourceId && action.payload?.targetId) {
          handleSaveLink({
            sourceTrackId: action.payload.sourceId,
            targetTrackId: action.payload.targetId,
            mixType: action.payload.mixType || "smooth_blend",
            notes: action.payload.notes || "KI-optimierte Verknüpfung",
            rating: action.payload.rating || 5,
          });
        }
        break;

      case "load_to_deck":
        if (action.payload?.trackId) {
          const target = tracks.find((t) => t.id === action.payload.trackId);
          if (target) {
            loadTrackToDeck(target, action.payload.deckNumber === 1 ? 1 : 2);
          }
        }
        break;
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans select-none antialiased">
      {/* Top Header */}
      <Header
        decksVisible={decksVisible}
        onToggleDecks={() => setDecksVisible(!decksVisible)}
        onOpenMidiModal={() => setIsMidiModalOpen(true)}
        onOpenAiChat={() => setIsAiChatOpen(true)}
        onOpenGitModal={() => setIsGitModalOpen(true)}
        activePreset={activeMidiPreset}
        connectedMidiDevices={connectedMidiDevices}
      />

      {/* Dual Deck Player (Top view, collapsible) */}
      {decksVisible && (
        <DualDeckPlayer
          deck1={deck1}
          deck2={deck2}
          mixer={mixer}
          onPlayPause={togglePlayPause}
          onCue={handleCue}
          onHotCue={handleHotCue}
          onPitchChange={handlePitchChange}
          onVolumeChange={handleVolumeChange}
          onEqChange={handleEqChange}
          onFilterChange={handleFilterChange}
          onCrossfaderChange={handleCrossfaderChange}
          onMasterVolumeChange={handleMasterVolumeChange}
        />
      )}

      {/* Main DJ Library Management Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Crates, Camelot Keys & Linked Filter */}
        <LibrarySidebar
          filters={filters}
          onFilterChange={(newFilters) =>
            setFilters((prev) => ({ ...prev, ...newFilters }))
          }
          totalTracks={tracks.length}
          linkedTracksCount={linkedTracksCount}
        />

        {/* Center: Track Table & Harmonic Match Visualizer */}
        <TrackTable
          tracks={filteredTracks}
          allTracks={tracks}
          links={links}
          deck1TrackId={deck1.track?.id}
          deck2TrackId={deck2.track?.id}
          onLoadDeck={loadTrackToDeck}
          onOpenTrackInspector={(track) => setInspectingTrack(track)}
          onQuickLinkTracks={handleQuickLink}
        />
      </div>

      {/* POP-UP INSPECTOR MODAL: Full Waveform, Cue Points & Rekordbox Transition Link Editor */}
      {inspectingTrack && (
        <TrackDetailModal
          track={inspectingTrack}
          allTracks={tracks}
          links={links}
          onClose={() => setInspectingTrack(null)}
          onSaveLink={handleSaveLink}
          onDeleteLink={handleDeleteLink}
          onLoadPairToDecks={loadPairToDecks}
          onUpdateTrackMetadata={handleUpdateTrackMetadata}
        />
      )}

      {/* PIONEER HARDWARE & MIDI LEARN MODAL */}
      {isMidiModalOpen && (
        <MidiMappingModal
          onClose={() => setIsMidiModalOpen(false)}
          activePreset={activeMidiPreset}
          onSelectPreset={(preset) => setActiveMidiPreset(preset)}
          connectedDevices={connectedMidiDevices}
        />
      )}

      {/* AI DJ ASSISTANT CHAT DRAWER */}
      <AiDjChatDrawer
        isOpen={isAiChatOpen}
        onClose={() => setIsAiChatOpen(false)}
        tracks={tracks}
        links={links}
        deck1Track={deck1.track}
        deck2Track={deck2.track}
        onExecuteAiAction={handleExecuteAiAction}
      />

      {/* GIT REPOSITORY SYNC MODAL */}
      {isGitModalOpen && (
        <GitSyncModal onClose={() => setIsGitModalOpen(false)} />
      )}
    </div>
  );
}
