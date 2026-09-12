/**
 * @license
 * Rekordbox Track Link & Match System (Pioneer Rekordbox Match-Funktion)
 * 
 * Provides deterministic 2-way track linking, harmonic Camelot compatibility,
 * BPM range analysis, and persistent storage for transition relationships.
 */

import { logger } from './logger';
import { parseMusicalKey } from '../audio/pitchTempoEngine';

export interface TrackLink {
  trackIdA: string;
  trackIdB: string;
  createdAt: number;
  note?: string;
}

export type HarmonicCompatibilityType =
  | 'EXACT'       // Same key (e.g. 8A <-> 8A)
  | 'RELATIVE'    // Relative major/minor (e.g. 8A <-> 8B)
  | 'FIFTH_SUB'   // Subdominant -1 fifth (e.g. 8A <-> 7A)
  | 'FIFTH_DOM'   // Dominant +1 fifth (e.g. 8A <-> 9A)
  | 'DIAGONAL'    // Adjacent + different scale (e.g. 8A <-> 7B or 9B)
  | 'ENERGY_BOOST'// +2 semitones / wheel jump (e.g. 8A <-> 10A)
  | 'INCOMPATIBLE'
  | 'UNKNOWN';

export interface HarmonicMatchResult {
  type: HarmonicCompatibilityType;
  score: number; // 0 - 100
  label: string;
  badgeColor: string; // Tailwind color classes
  isCompatible: boolean;
}

const STORAGE_KEY = 'airdox_rekordbox_track_matches_v1';

/**
 * Loads all saved track link relationships from persistent local storage.
 */
export function loadTrackLinks(): TrackLink[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item) =>
          item &&
          typeof item.trackIdA === 'string' &&
          typeof item.trackIdB === 'string'
      );
    }
  } catch (err) {
    logger.warn('DATABASE', 'Fehler beim Laden gespeicherter Track-Verknüpfungen:', err);
  }
  return [];
}

/**
 * Saves track link relationships to persistent local storage.
 */
export function saveTrackLinks(links: TrackLink[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(links));
  } catch (err) {
    logger.warn('DATABASE', 'Fehler beim Speichern von Track-Verknüpfungen:', err);
  }
}

/**
 * Check if two tracks are linked (order-independent).
 */
export function areTracksLinked(
  trackIdA: string,
  trackIdB: string,
  links: TrackLink[]
): boolean {
  if (!trackIdA || !trackIdB || trackIdA === trackIdB) return false;
  return links.some(
    (l) =>
      (l.trackIdA === trackIdA && l.trackIdB === trackIdB) ||
      (l.trackIdA === trackIdB && l.trackIdB === trackIdA)
  );
}

/**
 * Get all track IDs linked to a specific track.
 */
export function getLinkedTrackIds(trackId: string, links: TrackLink[]): string[] {
  if (!trackId) return [];
  const result = new Set<string>();
  for (const l of links) {
    if (l.trackIdA === trackId) result.add(l.trackIdB);
    if (l.trackIdB === trackId) result.add(l.trackIdA);
  }
  return Array.from(result);
}

/**
 * Get the set of all track IDs that have at least one link.
 */
export function getAllLinkedTrackIds(links: TrackLink[]): Set<string> {
  const set = new Set<string>();
  for (const l of links) {
    set.add(l.trackIdA);
    set.add(l.trackIdB);
  }
  return set;
}

/**
 * Get any transition note between two linked tracks.
 */
export function getLinkNote(
  trackIdA: string,
  trackIdB: string,
  links: TrackLink[]
): string | undefined {
  const match = links.find(
    (l) =>
      (l.trackIdA === trackIdA && l.trackIdB === trackIdB) ||
      (l.trackIdA === trackIdB && l.trackIdB === trackIdA)
  );
  return match?.note;
}

/**
 * Toggles a 2-way link between trackIdA and trackIdB.
 * Returns the updated links array.
 */
export function toggleTrackLink(
  trackIdA: string,
  trackIdB: string,
  currentLinks: TrackLink[],
  note?: string
): TrackLink[] {
  if (!trackIdA || !trackIdB || trackIdA === trackIdB) return currentLinks;

  const existingIndex = currentLinks.findIndex(
    (l) =>
      (l.trackIdA === trackIdA && l.trackIdB === trackIdB) ||
      (l.trackIdA === trackIdB && l.trackIdB === trackIdA)
  );

  let updated: TrackLink[];
  if (existingIndex >= 0) {
    // Remove link
    updated = currentLinks.filter((_, idx) => idx !== existingIndex);
    logger.info('UI', `Track-Verknüpfung entfernt: ${trackIdA} ↮ ${trackIdB}`);
  } else {
    // Add link
    const newLink: TrackLink = {
      trackIdA,
      trackIdB,
      createdAt: Date.now(),
      note: note?.trim() || undefined,
    };
    updated = [...currentLinks, newLink];
    logger.info('UI', `Track-Verknüpfung erstellt: ${trackIdA} 🔗 ${trackIdB}`);
  }

  saveTrackLinks(updated);
  return updated;
}

/**
 * Sets or updates the note for an existing track link.
 */
export function setTrackLinkNote(
  trackIdA: string,
  trackIdB: string,
  currentLinks: TrackLink[],
  note: string
): TrackLink[] {
  let found = false;
  const updated = currentLinks.map((l) => {
    if (
      (l.trackIdA === trackIdA && l.trackIdB === trackIdB) ||
      (l.trackIdA === trackIdB && l.trackIdB === trackIdA)
    ) {
      found = true;
      return { ...l, note: note.trim() || undefined };
    }
    return l;
  });

  if (!found && note.trim()) {
    // Auto-create link if note is entered
    updated.push({
      trackIdA,
      trackIdB,
      createdAt: Date.now(),
      note: note.trim(),
    });
  }

  saveTrackLinks(updated);
  return updated;
}

/**
 * Calculate Camelot Wheel harmonic compatibility between two keys.
 */
export function getHarmonicCompatibility(
  sourceKeyStr: string | undefined,
  targetKeyStr: string | undefined
): HarmonicMatchResult {
  const src = parseMusicalKey(sourceKeyStr);
  const tgt = parseMusicalKey(targetKeyStr);

  if (!src || !tgt) {
    return {
      type: 'UNKNOWN',
      score: 0,
      label: 'Keine Tonart',
      badgeColor: 'text-neutral-500 bg-neutral-800/40 border-neutral-700/50',
      isCompatible: false,
    };
  }

  const srcCamelot = src.camelot; // e.g. "8A"
  const tgtCamelot = tgt.camelot; // e.g. "8A"

  // 1. Exact same key
  if (srcCamelot === tgtCamelot) {
    return {
      type: 'EXACT',
      score: 100,
      label: 'Perfekter Match',
      badgeColor: 'text-[#00e676] bg-[#00e676]/15 border-[#00e676]/40',
      isCompatible: true,
    };
  }

  const srcNum = parseInt(srcCamelot.slice(0, -1), 10);
  const srcLetter = srcCamelot.slice(-1); // "A" or "B"
  const tgtNum = parseInt(tgtCamelot.slice(0, -1), 10);
  const tgtLetter = tgtCamelot.slice(-1); // "A" or "B"

  // 2. Relative Major / Minor (same number, different letter: 8A <-> 8B)
  if (srcNum === tgtNum && srcLetter !== tgtLetter) {
    return {
      type: 'RELATIVE',
      score: 95,
      label: 'Relative Dur/Moll',
      badgeColor: 'text-[#00e5ff] bg-[#00e5ff]/15 border-[#00e5ff]/40',
      isCompatible: true,
    };
  }

  // Helper for circular Camelot diff (1 to 12)
  const diffCircular = (a: number, b: number) => {
    const diff = (b - a + 12) % 12;
    return diff > 6 ? diff - 12 : diff;
  };

  const step = diffCircular(srcNum, tgtNum);

  // 3. Same scale, +1 or -1 on Camelot wheel (Fifths: Subdominant or Dominant)
  if (srcLetter === tgtLetter) {
    if (step === 1) {
      return {
        type: 'FIFTH_DOM',
        score: 90,
        label: '+1 Quinte (Dominante)',
        badgeColor: 'text-[#00b0ff] bg-[#00b0ff]/15 border-[#00b0ff]/40',
        isCompatible: true,
      };
    }
    if (step === -1) {
      return {
        type: 'FIFTH_SUB',
        score: 90,
        label: '-1 Quinte (Subdominante)',
        badgeColor: 'text-[#2979ff] bg-[#2979ff]/15 border-[#2979ff]/40',
        isCompatible: true,
      };
    }
    if (step === 2) {
      return {
        type: 'ENERGY_BOOST',
        score: 75,
        label: 'Energie-Boost (+2)',
        badgeColor: 'text-[#ff9100] bg-[#ff9100]/15 border-[#ff9100]/40',
        isCompatible: true,
      };
    }
  }

  // 4. Diagonal mix: step = +1 or -1 with letter flip
  if (srcLetter !== tgtLetter && (step === 1 || step === -1)) {
    return {
      type: 'DIAGONAL',
      score: 70,
      label: 'Diagonale Harmonie',
      badgeColor: 'text-[#ffd600] bg-[#ffd600]/15 border-[#ffd600]/40',
      isCompatible: true,
    };
  }

  return {
    type: 'INCOMPATIBLE',
    score: 25,
    label: 'Nicht harmonisch',
    badgeColor: 'text-neutral-500 bg-neutral-800/30 border-neutral-700/30',
    isCompatible: false,
  };
}

/**
 * Calculates BPM difference and percentage relative to reference BPM.
 */
export function getBpmRelation(
  refBpm: number,
  targetBpm: number
): {
  diff: number;
  percent: number;
  label: string;
  isWithinPct: (pct: number) => boolean;
} {
  if (!refBpm || refBpm <= 0 || !targetBpm || targetBpm <= 0) {
    return {
      diff: 0,
      percent: 0,
      label: '0.00',
      isWithinPct: () => false,
    };
  }

  const diff = targetBpm - refBpm;
  const percent = (diff / refBpm) * 100;
  const sign = percent >= 0 ? '+' : '';
  const label = `${sign}${percent.toFixed(1)}%`;

  return {
    diff,
    percent,
    label,
    isWithinPct: (limitPct: number) => Math.abs(percent) <= limitPct,
  };
}
