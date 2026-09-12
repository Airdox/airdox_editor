import { describe, it, expect, beforeEach } from 'vitest';
import {
  TrackLink,
  areTracksLinked,
  toggleTrackLink,
  getLinkedTrackIds,
  getAllLinkedTrackIds,
  setTrackLinkNote,
  getLinkNote,
  getHarmonicCompatibility,
  getBpmRelation,
} from '../../src/utils/trackLinks';

describe('Track Match & Link System (Rekordbox Matching)', () => {
  let links: TrackLink[];

  beforeEach(() => {
    links = [];
  });

  it('toggles a 2-way symmetric link between two tracks', () => {
    expect(areTracksLinked('track-1', 'track-2', links)).toBe(false);

    // Link track-1 and track-2
    links = toggleTrackLink('track-1', 'track-2', links);
    expect(areTracksLinked('track-1', 'track-2', links)).toBe(true);
    expect(areTracksLinked('track-2', 'track-1', links)).toBe(true); // 2-way symmetry

    // Toggle off
    links = toggleTrackLink('track-1', 'track-2', links);
    expect(areTracksLinked('track-1', 'track-2', links)).toBe(false);
    expect(areTracksLinked('track-2', 'track-1', links)).toBe(false);
  });

  it('retrieves all linked track IDs for a specific track', () => {
    links = toggleTrackLink('track-A', 'track-B', links);
    links = toggleTrackLink('track-A', 'track-C', links);

    const linkedWithA = getLinkedTrackIds('track-A', links);
    expect(linkedWithA).toContain('track-B');
    expect(linkedWithA).toContain('track-C');
    expect(linkedWithA).toHaveLength(2);

    const linkedWithB = getLinkedTrackIds('track-B', links);
    expect(linkedWithB).toEqual(['track-A']);
  });

  it('retrieves the set of all tracks having at least one link across the library', () => {
    links = toggleTrackLink('track-A', 'track-B', links);
    links = toggleTrackLink('track-C', 'track-D', links);

    const allLinked = getAllLinkedTrackIds(links);
    expect(allLinked.has('track-A')).toBe(true);
    expect(allLinked.has('track-B')).toBe(true);
    expect(allLinked.has('track-C')).toBe(true);
    expect(allLinked.has('track-D')).toBe(true);
    expect(allLinked.has('track-E')).toBe(false);
    expect(allLinked.size).toBe(4);
  });

  it('stores and retrieves transition mix notes', () => {
    links = toggleTrackLink('track-1', 'track-2', links, 'Drop Swap bei Bar 32');
    expect(getLinkNote('track-1', 'track-2', links)).toBe('Drop Swap bei Bar 32');
    expect(getLinkNote('track-2', 'track-1', links)).toBe('Drop Swap bei Bar 32');

    links = setTrackLinkNote('track-1', 'track-2', links, 'Breakdown Blend');
    expect(getLinkNote('track-1', 'track-2', links)).toBe('Breakdown Blend');
  });

  it('determines harmonic Camelot compatibility accurately', () => {
    // Exact same key
    const exact = getHarmonicCompatibility('8A', '8A');
    expect(exact.isCompatible).toBe(true);
    expect(exact.type).toBe('EXACT');
    expect(exact.score).toBe(100);

    // Relative major/minor (8A <-> 8B: Am and C)
    const relative = getHarmonicCompatibility('8A', '8B');
    expect(relative.isCompatible).toBe(true);
    expect(relative.type).toBe('RELATIVE');
    expect(relative.score).toBe(95);

    // Subdominant / Dominant fifths (8A <-> 9A or 7A)
    const dom = getHarmonicCompatibility('8A', '9A');
    expect(dom.isCompatible).toBe(true);
    expect(dom.type).toBe('FIFTH_DOM');

    const sub = getHarmonicCompatibility('8A', '7A');
    expect(sub.isCompatible).toBe(true);
    expect(sub.type).toBe('FIFTH_SUB');

    // Incompatible key (8A and 2A)
    const incomp = getHarmonicCompatibility('8A', '2A');
    expect(incomp.isCompatible).toBe(false);
  });

  it('computes BPM difference and range percentages', () => {
    const rel = getBpmRelation(126, 128);
    expect(rel.diff).toBeCloseTo(2, 1);
    expect(rel.percent).toBeCloseTo(1.587, 2);
    expect(rel.isWithinPct(4)).toBe(true);
    expect(rel.isWithinPct(1)).toBe(false);
  });
});
