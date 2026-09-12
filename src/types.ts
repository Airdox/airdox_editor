export interface HotCue {
  id: string;
  slot: number; // 1 to 8
  name: string;
  time: number; // in seconds
  color: string;
}

export interface DJTrack {
  id: string;
  title: string;
  artist: string;
  remix?: string;
  album?: string;
  genre: string;
  camelotKey: string; // e.g. "8A", "9A", "4B"
  musicalKey: string; // e.g. "Am", "Em", "Abm"
  bpm: number;
  duration: number; // seconds
  year: number;
  rating: number; // 1 to 5
  energy: number; // 1 to 5
  playCount: number;
  dateAdded: string;
  filePath: string;
  readOnlyLocked: boolean; // strictly enforced non-destructive flag
  waveformPeaks: number[];
  hotCues: HotCue[];
  tags: string[];
  colorTag?: string;
  comment?: string;
}

export type MixTransitionType =
  | "smooth_blend"
  | "drop_swap"
  | "bassline_switch"
  | "breakdown_cut"
  | "energy_boost"
  | "vocal_over_dub"
  | "custom";

export interface TrackLink {
  id: string;
  sourceTrackId: string;
  targetTrackId: string;
  mixType: MixTransitionType;
  notes: string;
  rating: number; // 1 to 5
  sourceExitTime?: number;
  targetEntryTime?: number;
  energyChange?: number; // -2 to +2
  createdAt: string;
}

export interface CamelotHarmonicMatch {
  targetTrack: DJTrack;
  relationType:
    | "identical" // same key e.g. 8A -> 8A
    | "energy_lift" // +1 e.g. 8A -> 9A
    | "energy_drop" // -1 e.g. 8A -> 7A
    | "relative" // A <-> B e.g. 8A <-> 8B
    | "diagonal_energy" // +1 and relative e.g. 8A -> 9B
    | "modulate_plus_2" // +2 key jump
    | "harmonic_clash";
  score: number; // 0 to 100
  bpmDiffPercent: number;
  description: string;
  isExistingLink: boolean;
  linkData?: TrackLink;
}

export interface MidiMappingEntry {
  id: string;
  actionId: string;
  actionLabel: string;
  category: "deck1" | "deck2" | "mixer" | "browser" | "effects";
  channel: number; // 1-16
  messageType: "noteon" | "noteoff" | "cc";
  controlNumber: number; // note number or CC number (0-127)
  behavior: "momentary" | "toggle" | "fader" | "knob" | "jog";
  hardwareController: "ddj-flx4" | "ddj-1000" | "custom";
}

export interface DeckState {
  deckId: 1 | 2;
  track: DJTrack | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  bpm: number;
  pitchRate: number; // 0.92 to 1.08 (-8% to +8%)
  volume: number; // 0 to 1
  eqHigh: number; // 0 to 1 (center 0.5)
  eqMid: number; // 0 to 1 (center 0.5)
  eqLow: number; // 0 to 1 (center 0.5)
  filter: number; // -1 (LPF) to 0 (flat) to +1 (HPF)
  cueTime: number;
  isLooping: boolean;
  loopLength: number; // in beats: 1, 2, 4, 8, 16
  vinylMode: boolean;
  vuMeter: number; // 0 to 1
}

export interface MixerState {
  crossfader: number; // -1 (Deck 1) to 1 (Deck 2)
  masterVolume: number; // 0 to 1
  headphoneCue: {
    deck1: boolean;
    deck2: boolean;
    master: boolean;
  };
}

export interface LibraryFilters {
  search: string;
  genre: string;
  onlyLinked: boolean;
  camelotKey: string;
  bpmMin: number;
  bpmMax: number;
  minRating: number;
  minEnergy: number;
  selectedTag: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
  action?: {
    actionType: string;
    payload?: any;
    summary?: string;
  };
}
