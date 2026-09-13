/**
 * @license
 * Rekordbox Track Matching & Harmonic Compatibility Engine
 * 
 * Implements Rekordbox 6/7 "Related Tracks" & "Track Match" (2-Track Verknüpfung)
 * with persistent local storage, bidirectional links, harmonic traffic light
 * analysis, and DJ transition notes.
 */

import { TrackModel } from '../types/rekordbox';
import { getCamelotInfo } from '../audio/mixAnalysis';
import { logger } from '../utils/logger';

const STORAGE_KEY = 'airdox_rekordbox_track_matches_v1';

export interface StoredMatchData {
  /** List of paired track IDs */
  matchedIds: string[];
  /** DJ mixing notes keyed by paired track ID */
  notes?: Record<string, string>;
  /** Timestamp of last edit */
  updatedAt?: number;
}

export type MatchStore = Record<string, StoredMatchData>;

let memoryStore: MatchStore = {};

/**
 * Load all saved track matches from localStorage or in-memory fallback
 */
export function getStoredMatches(): MatchStore {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return memoryStore;
      return JSON.parse(raw);
    }
    return memoryStore;
  } catch (err) {
    logger.warn('DATABASE', 'Fehler beim Laden der gespeicherten Track-Matches:', err);
    return memoryStore;
  }
}

/**
 * Save all track matches to localStorage and in-memory store
 */
export function saveStoredMatches(store: MatchStore): void {
  memoryStore = { ...store };
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    }
  } catch (err) {
    logger.warn('DATABASE', 'Fehler beim Speichern der Track-Matches:', err);
  }
}

/**
 * Check if two tracks are linked together
 */
export function areTracksMatched(trackIdA: string, trackIdB: string): boolean {
  if (!trackIdA || !trackIdB || trackIdA === trackIdB) return false;
  const store = getStoredMatches();
  const data = store[trackIdA];
  return data ? data.matchedIds.includes(trackIdB) : false;
}

/**
 * Get all matched track IDs for a specific track
 */
export function getMatchedTrackIds(trackId: string): string[] {
  if (!trackId) return [];
  const store = getStoredMatches();
  return store[trackId]?.matchedIds || [];
}

/**
 * Toggle a bidirectional match between two tracks
 * @returns true if now matched, false if unmatched
 */
export function toggleTrackMatch(trackIdA: string, trackIdB: string, note?: string): boolean {
  if (!trackIdA || !trackIdB || trackIdA === trackIdB) return false;

  const store = getStoredMatches();
  const currentA = store[trackIdA]?.matchedIds || [];
  const isCurrentlyMatched = currentA.includes(trackIdB);

  const now = Date.now();

  if (isCurrentlyMatched) {
    // Remove link A -> B
    const newA = currentA.filter((id) => id !== trackIdB);
    const notesA = { ...(store[trackIdA]?.notes || {}) };
    delete notesA[trackIdB];
    store[trackIdA] = { matchedIds: newA, notes: notesA, updatedAt: now };

    // Remove link B -> A
    const currentB = store[trackIdB]?.matchedIds || [];
    const newB = currentB.filter((id) => id !== trackIdA);
    const notesB = { ...(store[trackIdB]?.notes || {}) };
    delete notesB[trackIdA];
    store[trackIdB] = { matchedIds: newB, notes: notesB, updatedAt: now };

    saveStoredMatches(store);
    logger.info('RECORDING', `Rekordbox Match gelöst: ${trackIdA} ↮ ${trackIdB}`);
    return false;
  } else {
    // Add link A -> B
    const newA = Array.from(new Set([...currentA, trackIdB]));
    const notesA = { ...(store[trackIdA]?.notes || {}) };
    if (note) notesA[trackIdB] = note;
    store[trackIdA] = { matchedIds: newA, notes: notesA, updatedAt: now };

    // Add link B -> A
    const currentB = store[trackIdB]?.matchedIds || [];
    const newB = Array.from(new Set([...currentB, trackIdA]));
    const notesB = { ...(store[trackIdB]?.notes || {}) };
    if (note) notesB[trackIdA] = note;
    store[trackIdB] = { matchedIds: newB, notes: notesB, updatedAt: now };

    saveStoredMatches(store);
    logger.info('RECORDING', `Rekordbox Match verknüpft: ${trackIdA} ↔ ${trackIdB}${note ? ` ("${note}")` : ''}`);
    return true;
  }
}

/**
 * Save DJ mixing note for a matched pair
 */
export function setMatchNote(trackIdA: string, trackIdB: string, note: string): void {
  const store = getStoredMatches();
  if (!store[trackIdA]) store[trackIdA] = { matchedIds: [trackIdB], notes: {} };
  if (!store[trackIdB]) store[trackIdB] = { matchedIds: [trackIdA], notes: {} };

  if (!store[trackIdA].notes) store[trackIdA].notes = {};
  if (!store[trackIdB].notes) store[trackIdB].notes = {};

  store[trackIdA].notes![trackIdB] = note;
  store[trackIdB].notes![trackIdA] = note;
  store[trackIdA].updatedAt = Date.now();
  store[trackIdB].updatedAt = Date.now();

  saveStoredMatches(store);
}

export function getMatchNote(trackIdA: string, trackIdB: string): string | undefined {
  const store = getStoredMatches();
  return store[trackIdA]?.notes?.[trackIdB];
}

export interface HarmonicTrafficLight {
  compatible: boolean;
  score: number; // 0 - 100%
  type: 'EXACT' | 'ADJACENT' | 'RELATIVE' | 'ENERGY_BOOST' | 'SEMITONE' | 'DISSONANT';
  label: string;
  badgeColor: string; // Hex or Tailwind class
  explanation: string;
}

/**
 * Calculate Rekordbox Traffic Light Harmonic Match between two keys
 */
export function calculateHarmonicCompatibility(keyA?: string, keyB?: string): HarmonicTrafficLight {
  if (!keyA || !keyB) {
    return {
      compatible: false,
      score: 50,
      type: 'DISSONANT',
      label: 'Kein Key',
      badgeColor: '#6b7280',
      explanation: 'Tonart nicht analysiert',
    };
  }

  const infoA = getCamelotInfo(keyA);
  const infoB = getCamelotInfo(keyB);

  const numA = parseInt(infoA.code.replace(/[^0-9]/g, ''), 10) || 8;
  const letA = infoA.code.endsWith('B') ? 'B' : 'A';

  const numB = parseInt(infoB.code.replace(/[^0-9]/g, ''), 10) || 8;
  const letB = infoB.code.endsWith('B') ? 'B' : 'A';

  // Exact Match (e.g. 8A <-> 8A)
  if (numA === numB && letA === letB) {
    return {
      compatible: true,
      score: 100,
      type: 'EXACT',
      label: 'Exakte Tonart',
      badgeColor: '#10b981', // Emerald green
      explanation: '100% harmonische Deckungsgleichheit (Gleiche Tonart)',
    };
  }

  // Relative Major/Minor (e.g. 8A <-> 8B)
  if (numA === numB && letA !== letB) {
    return {
      compatible: true,
      score: 92,
      type: 'RELATIVE',
      label: 'Relative Dur/Moll',
      badgeColor: '#06b6d4', // Cyan
      explanation: 'Paralleltonart: Sanfter Stimmungswechsel zwischen Dur und Moll',
    };
  }

  // Adjacent (+1 or -1 step on Camelot wheel)
  const diff = Math.abs(numA - numB);
  const isAdjacent = (diff === 1 || diff === 11) && letA === letB;
  if (isAdjacent) {
    const isEnergyUp = (numB === (numA % 12) + 1);
    return {
      compatible: true,
      score: 88,
      type: 'ADJACENT',
      label: isEnergyUp ? '+1 Camelot (Rise)' : '-1 Camelot (Drop)',
      badgeColor: '#22c55e', // Bright green
      explanation: isEnergyUp
        ? 'Im Uhrzeigersinn (+1): Natürlicher Energieanstieg im Mix'
        : 'Gegen Uhrzeigersinn (-1): Sanftes Ausklingen / Beruhigung',
    };
  }

  // Energy Boost (+2 on Camelot wheel, same mode)
  const isTwoStep = (diff === 2 || diff === 10) && letA === letB;
  if (isTwoStep) {
    return {
      compatible: true,
      score: 75,
      type: 'ENERGY_BOOST',
      label: '+2 Energy Boost',
      badgeColor: '#f59e0b', // Amber
      explanation: 'Dramatischer Energieschub für Peak-Time Übergänge',
    };
  }

  // Semitone Shift (+7 steps on Camelot)
  const isSemitone = (diff === 7 || diff === 5) && letA === letB;
  if (isSemitone) {
    return {
      compatible: true,
      score: 65,
      type: 'SEMITONE',
      label: 'Halbton-Shift',
      badgeColor: '#a855f7', // Purple
      explanation: 'Halbtonschritt: Erzeugt intense Spannung / Hands-in-the-Air Effekt',
    };
  }

  // Incompatible / Dissonant
  return {
    compatible: false,
    score: 20,
    type: 'DISSONANT',
    label: 'Dissonant',
    badgeColor: '#ef4444', // Red
    explanation: 'Harmonisch reibend (Dissonanzrisiko bei Melodien)',
  };
}

/**
 * Check if BPM of Track B is compatible with Track A
 * Includes half-time and double-time tolerance (e.g. 70/140, 87/174)
 */
export function isBpmCompatible(
  bpmA: number,
  bpmB: number,
  tolerancePct = 6
): { compatible: boolean; relation: 'EXACT' | 'NEAR' | 'HALF_TIME' | 'DOUBLE_TIME' | 'OFF'; diffPct: number } {
  if (!bpmA || !bpmB || bpmA <= 0 || bpmB <= 0) {
    return { compatible: false, relation: 'OFF', diffPct: 100 };
  }

  // Direct diff
  const diffDirect = Math.abs(bpmB - bpmA) / bpmA * 100;
  if (diffDirect < 0.2) return { compatible: true, relation: 'EXACT', diffPct: diffDirect };
  if (diffDirect <= tolerancePct) return { compatible: true, relation: 'NEAR', diffPct: diffDirect };

  // Half-time (e.g. A is 140, B is 70)
  const diffHalf = Math.abs((bpmB * 2) - bpmA) / bpmA * 100;
  if (diffHalf <= tolerancePct) return { compatible: true, relation: 'HALF_TIME', diffPct: diffHalf };

  // Double-time (e.g. A is 70, B is 140)
  const diffDouble = Math.abs((bpmB / 2) - bpmA) / bpmA * 100;
  if (diffDouble <= tolerancePct) return { compatible: true, relation: 'DOUBLE_TIME', diffPct: diffDouble };

  return { compatible: false, relation: 'OFF', diffPct: diffDirect };
}

/**
 * Check if a track has any match links (either in metadata or in local match store)
 */
export function hasTrackMatches(track: TrackModel, store?: MatchStore): boolean {
  if (track.matchingTrackIds && track.matchingTrackIds.length > 0) return true;
  const s = store || getStoredMatches();
  return Boolean(s[track.id]?.matchedIds && s[track.id].matchedIds.length > 0);
}

/**
 * Get all linked track IDs for a track combining metadata & local store
 */
export function getAllLinkedTrackIds(track: TrackModel, store?: MatchStore): string[] {
  const fromMeta = track.matchingTrackIds || [];
  const s = store || getStoredMatches();
  const fromStore = s[track.id]?.matchedIds || [];
  return Array.from(new Set([...fromMeta, ...fromStore]));
}

/**
 * Filter collection: get all tracks that have at least one match link
 */
export function filterTracksWithMatches(tracks: TrackModel[], store?: MatchStore): TrackModel[] {
  const s = store || getStoredMatches();
  return tracks.filter((t) => hasTrackMatches(t, s));
}

/**
 * Filter collection: get all tracks linked to targetTrackId
 */
export function filterTracksMatchedWith(
  targetTrackId: string,
  tracks: TrackModel[],
  store?: MatchStore
): TrackModel[] {
  if (!targetTrackId) return [];
  const s = store || getStoredMatches();
  const matchedIds = new Set(s[targetTrackId]?.matchedIds || []);

  return tracks.filter((t) => {
    if (t.id === targetTrackId) return false;
    if (matchedIds.has(t.id)) return true;
    if (t.matchingTrackIds?.includes(targetTrackId)) return true;
    return false;
  });
}

