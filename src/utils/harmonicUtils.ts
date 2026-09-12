import { DJTrack, CamelotHarmonicMatch, TrackLink } from "../types";

export interface CamelotCoordinate {
  number: number; // 1 to 12
  letter: "A" | "B"; // A = Minor, B = Major
}

export function parseCamelot(keyStr: string): CamelotCoordinate | null {
  if (!keyStr) return null;
  const match = keyStr.trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  if (num < 1 || num > 12) return null;
  return { number: num, letter: match[2] as "A" | "B" };
}

export function getCamelotColor(keyStr: string): string {
  const coord = parseCamelot(keyStr);
  if (!coord) return "#64748b";
  // Classic Camelot Wheel chromatic hues
  const colors: Record<number, string> = {
    1: "#0ea5e9", // Sky Blue
    2: "#06b6d4", // Cyan
    3: "#14b8a6", // Teal
    4: "#10b981", // Emerald
    5: "#84cc16", // Lime
    6: "#eab308", // Yellow
    7: "#f97316", // Orange
    8: "#ef4444", // Red (Am / C)
    9: "#ec4899", // Pink
    10: "#d946ef", // Fuchsia
    11: "#a855f7", // Purple
    12: "#6366f1", // Indigo
  };
  return colors[coord.number] || "#64748b";
}

export function analyzeHarmonicRelationship(
  sourceTrack: DJTrack,
  targetTrack: DJTrack,
  existingLink?: TrackLink
): CamelotHarmonicMatch {
  const c1 = parseCamelot(sourceTrack.camelotKey);
  const c2 = parseCamelot(targetTrack.camelotKey);

  const bpmDiffPercent =
    Math.round((Math.abs(targetTrack.bpm - sourceTrack.bpm) / sourceTrack.bpm) * 1000) / 10;

  if (!c1 || !c2) {
    return {
      targetTrack,
      relationType: "harmonic_clash",
      score: 50,
      bpmDiffPercent,
      description: "Tonart nicht im Camelot-Format hinterlegt.",
      isExistingLink: !!existingLink,
      linkData: existingLink,
    };
  }

  // Calculate circular distance on the 1-12 wheel
  const numDiff = (c2.number - c1.number + 12) % 12;
  const sameLetter = c1.letter === c2.letter;

  let relationType: CamelotHarmonicMatch["relationType"] = "harmonic_clash";
  let baseScore = 40;
  let description = "";

  if (numDiff === 0 && sameLetter) {
    relationType = "identical";
    baseScore = 98;
    description = `Identische Tonart (${sourceTrack.camelotKey} ➔ ${targetTrack.camelotKey}): Perfekter, nahtloser Harmoniemix!`;
  } else if (numDiff === 1 && sameLetter) {
    relationType = "energy_lift";
    baseScore = 95;
    description = `Energy Lift +1 (${sourceTrack.camelotKey} ➔ ${targetTrack.camelotKey}): Baut spürbare Energie auf der Tanzfläche auf.`;
  } else if (numDiff === 11 && sameLetter) {
    relationType = "energy_drop";
    baseScore = 88;
    description = `Energy Drop -1 (${sourceTrack.camelotKey} ➔ ${targetTrack.camelotKey}): Beruhigt den Floor harmonisch für einen Breakdown.`;
  } else if (numDiff === 0 && !sameLetter) {
    relationType = "relative";
    baseScore = 92;
    description = `Relative Tonart (${sourceTrack.camelotKey} ➔ ${targetTrack.camelotKey}): Moll/Dur-Wechsel mit identischem Tonvorrat.`;
  } else if (numDiff === 1 && !sameLetter) {
    relationType = "diagonal_energy";
    baseScore = 82;
    description = `Diagonale Modulation (+1 & relative): Interessanter, progressiver Stimmungswechsel.`;
  } else if (numDiff === 2 && sameLetter) {
    relationType = "modulate_plus_2";
    baseScore = 76;
    description = `Ganzton-Modulation (+2): Dramatischer Euphorie-Kick im Set.`;
  } else {
    relationType = "harmonic_clash";
    baseScore = 40;
    description = `Dissonanter Abstand (${sourceTrack.camelotKey} ➔ ${targetTrack.camelotKey}): Besser mit Perkussions-Cut oder Echo-Out mixen.`;
  }

  // Factor in BPM drift
  let bpmPenalty = 0;
  if (bpmDiffPercent <= 2) {
    bpmPenalty = 0;
  } else if (bpmDiffPercent <= 4) {
    bpmPenalty = 5;
  } else if (bpmDiffPercent <= 8) {
    bpmPenalty = 15;
  } else {
    bpmPenalty = 30;
  }

  const finalScore = Math.max(10, Math.min(100, baseScore - bpmPenalty));

  return {
    targetTrack,
    relationType,
    score: finalScore,
    bpmDiffPercent,
    description,
    isExistingLink: !!existingLink,
    linkData: existingLink,
  };
}

export function findHarmonicMatchesForTrack(
  sourceTrack: DJTrack,
  allTracks: DJTrack[],
  links: TrackLink[]
): CamelotHarmonicMatch[] {
  const matches = allTracks
    .filter((t) => t.id !== sourceTrack.id)
    .map((target) => {
      const existingLink = links.find(
        (l) =>
          (l.sourceTrackId === sourceTrack.id && l.targetTrackId === target.id) ||
          (l.sourceTrackId === target.id && l.targetTrackId === sourceTrack.id)
      );
      return analyzeHarmonicRelationship(sourceTrack, target, existingLink);
    });

  // Sort: existing links first, then by score descending
  return matches.sort((a, b) => {
    if (a.isExistingLink && !b.isExistingLink) return -1;
    if (!a.isExistingLink && b.isExistingLink) return 1;
    return b.score - a.score;
  });
}
