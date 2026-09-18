import type { StemId } from './types';
import { DSP_STEM_LABELS } from './dspSeparator';

/**
 * Naming helpers shared by the renderer and the tests.
 *
 * External separators (e.g. the `audio-separator` CLI) encode the stem inside
 * the file name – typically `Artist - Title (Vocals) Model.wav`. The renderer
 * needs that information to label and colour the deck buttons, so the mapping
 * lives in one dependency-free module instead of being guessed by array index.
 */

/**
 * Reihenfolge matters: „No Vocals“/„Instrumental“ muss vor „Vocals“ geprüft
 * werden, sonst würde ein Karaoke-Instrumental als Gesangs-Stem landen.
 */
const STEM_PATTERNS: { id: StemId; pattern: RegExp }[] = [
  { id: 'other', pattern: /\b(other|instrumental|inst|no[_ -]?vocals?|accompaniment|backing|karaoke[_ -]?inst)\b/i },
  { id: 'vocals', pattern: /\b(vocals?|vox|gesang|lead[_ -]?vocals?)\b/i },
  { id: 'drums', pattern: /\b(drums?|drum[_ -]?kit|percussion|perc|schlagzeug|hats?|cymbals?)\b/i },
  { id: 'bass', pattern: /\b(bass|bassline|sub[_ -]?bass|bass[_ -]?guitar)\b/i },
];

export const DEFAULT_STEM_ORDER: readonly StemId[] = ['vocals', 'drums', 'bass', 'other'];

export interface ClassifiedStemFile {
  filePath: string;
  fileName: string;
  id: StemId;
  label: string;
  /** false when the stem had to be guessed from the file name. */
  matched: boolean;
}

export function stemLabel(id: StemId): string {
  return DSP_STEM_LABELS[id] ?? id;
}

function baseName(filePath: string): string {
  return (String(filePath).split(/[\\/]/).pop() ?? String(filePath)).replace(/\.[^.]+$/, '');
}

/** Human readable hint taken from `… (Guitar) …` style suffixes. */
function labelHint(fileName: string): string | null {
  const groups = [...fileName.matchAll(/\(([^)]{2,24})\)/g)].map((match) => match[1].trim()).filter(Boolean);
  return groups.length ? groups[groups.length - 1] : null;
}

/** Map one output file to a stem id; unknown names fall back to `other`. */
export function classifyStemFileName(filePath: string): ClassifiedStemFile {
  const fileName = baseName(filePath);
  for (const { id, pattern } of STEM_PATTERNS) {
    if (pattern.test(fileName)) return { filePath, fileName, id, label: stemLabel(id), matched: true };
  }
  const hint = labelHint(fileName);
  return { filePath, fileName, id: 'other', label: hint ?? stemLabel('other'), matched: false };
}

/**
 * Classify a list of files and order them for the deck
 * (vocals → drums → bass → other). No file is dropped: playback replaces the
 * mix with the sum of the stems, so silently discarding one would lose audio.
 * Repeated buckets get a numbered label ("Inst", "Inst 2", …).
 */
export function classifyStemFiles(filePaths: readonly string[], preferredOrder: readonly StemId[] = DEFAULT_STEM_ORDER): ClassifiedStemFile[] {
  const classified = filePaths.map(classifyStemFileName);
  const used = new Set<ClassifiedStemFile>();
  const ordered: ClassifiedStemFile[] = [];
  const take = (entry: ClassifiedStemFile | undefined): void => {
    if (!entry || used.has(entry)) return;
    used.add(entry);
    ordered.push(entry);
  };
  for (const id of preferredOrder) take(classified.find((entry) => entry.id === id && !used.has(entry)));
  for (const entry of classified) take(entry);

  const counters = new Map<StemId, number>();
  return ordered.map((entry) => {
    const seen = (counters.get(entry.id) ?? 0) + 1;
    counters.set(entry.id, seen);
    return { ...entry, label: seen > 1 ? `${entry.label} ${seen}` : entry.label };
  });
}
