/**
 * @license
 * Identity source for everything the app creates at runtime.
 *
 * Why this exists instead of `Date.now()`: a wall-clock timestamp is only
 * *probably* unique, and it is a separate read for every field. Two ids built
 * from two `Date.now()` calls in the same object literal were observed to differ
 * when the millisecond ticked over between them — which produces a track whose
 * segments point at a track id that does not exist. That is not a theoretical
 * defect: the LOCAL-IMPORT path showed exactly this, and an edit that cannot
 * find its own track is silently dropped by the projection.
 *
 * The counter per prefix is monotonic, cheap and unique for the lifetime of the
 * renderer process. Prefixes are kept deliberately close to the old shape
 * (`seg-`, `cue-`, `track-`, `clip-`) because ids end up in saved projects, in
 * React keys and in the log; they stay opaque everywhere else. Legacy projects
 * carry ids with 13-digit timestamp suffixes, so a small counter value can never
 * collide with material that was loaded from disk.
 */

const counters = new Map<string, number>();

/**
 * Next unique id for a domain, e.g. `nextId('seg')` → `seg-1`, `seg-2`, …
 * Never repeats inside a process, independent of the wall clock.
 */
export function nextId(prefix: string): string {
  const clean = prefix || 'id';
  const next = (counters.get(clean) ?? 0) + 1;
  counters.set(clean, next);
  return `${clean}-${next}`;
}

/**
 * Ids of the edit domain (segments, timeline objects derived from them). Kept as
 * a named export because the edit engine and the UI must draw from ONE source —
 * a segment id invented in another place cannot be matched to its track.
 */
export function nextEditId(): string {
  return nextId('edit');
}

/** Highest counter value of a prefix — used by the tests and by the guard only. */
export function idCounterValue(prefix: string): number {
  return counters.get(prefix) ?? 0;
}

/**
 * Adoption hook for loaded projects: after a project file is read, the counters
 * are advanced past every numeric suffix found in it. Without this a fresh
 * session starting at `seg-1` could eventually reuse an id that the project
 * already uses, and `segById` lookups would answer for the wrong edit.
 */
export function adoptIds(ids: Iterable<string | undefined>): void {
  for (const id of ids) {
    if (!id) continue;
    const match = /^(.*)-(\d+)$/.exec(id);
    if (!match) continue;
    const [, prefix, digits] = match;
    const value = Number(digits);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value > (counters.get(prefix) ?? 0)) counters.set(prefix, value);
  }
}
