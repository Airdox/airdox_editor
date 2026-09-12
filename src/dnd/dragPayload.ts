/**
 * @license
 * Drag & drop payloads (pure).
 *
 * One place defines what can be dragged inside the editor and what a drop target
 * may expect, so palette → deck, collection → deck, selection → palette and the
 * file drop of the desktop shell all speak the same protocol. Everything here is
 * DOM-light: it only needs the small `DataTransferLike` surface, which makes the
 * accept/reject rules unit-testable (tests/edit-dnd.test.ts). Grid snapping is NOT
 * part of this contract: the drop target snaps with its own beat-grid policy, so
 * a drag never invents a grid that a track does not have.
 */

/** Palette clip (clip → deck timeline / deck B / palette trash). */
export const DRAG_MIME_CLIP = 'application/x-airdox-clip';
/** Loaded or imported track (collection/browser row → deck A). */
export const DRAG_MIME_TRACK = 'application/x-airdox-track';
/** Current selection of the detail waveform (selection → palette). */
export const DRAG_MIME_SELECTION = 'application/x-airdox-selection';
/** Fallback marker so `text/plain` payloads are still recognisable. */
export const DRAG_MIME_KIND = 'application/x-airdox-kind';

export type DropMode = 'insert' | 'replace' | 'overdub' | 'load';

export type DragPayload =
  | { kind: 'clip'; clipId: string; label?: string }
  | { kind: 'track'; trackId: string; label?: string }
  | { kind: 'selection'; start: number; end: number; label?: string };

export interface DataTransferLike {
  types: readonly string[];
  getData(format: string): string;
  setData(format: string, data: string): void;
  files?: ArrayLike<{ name?: string; type?: string }>;
  items?: ArrayLike<{ kind?: string; type?: string }>;
  dropEffect?: string;
  effectAllowed?: string;
}

function hasType(dt: DataTransferLike, type: string): boolean {
  try {
    return Array.from(dt.types ?? []).includes(type);
  } catch {
    return false;
  }
}

/** Attaches an internal payload to a drag operation (and a readable text mirror). */
export function writeDragPayload(dt: DataTransferLike, payload: DragPayload): void {
  try {
    if (payload.kind === 'clip') {
      dt.setData(DRAG_MIME_CLIP, payload.clipId);
      dt.setData(DRAG_MIME_KIND, 'clip');
      dt.setData('text/plain', payload.label ?? payload.clipId);
    } else if (payload.kind === 'track') {
      dt.setData(DRAG_MIME_TRACK, payload.trackId);
      dt.setData(DRAG_MIME_KIND, 'track');
      dt.setData('text/plain', payload.label ?? payload.trackId);
    } else {
      dt.setData(
        DRAG_MIME_SELECTION,
        JSON.stringify({ start: payload.start, end: payload.end })
      );
      dt.setData(DRAG_MIME_KIND, 'selection');
      dt.setData('text/plain', payload.label ?? `${payload.start}-${payload.end}`);
    }
  } catch {
    // A browser may refuse setData outside a dragstart gesture; the drop then
    // simply behaves like an unknown (external) drag.
  }
}

/**
 * The browser only exposes `getData()` in the `drop` event — during `dragover`
 * every custom payload reads back empty. A single app-wide record of the running
 * gesture is therefore what drop targets consult for their live preview, while the
 * `dataTransfer` payload stays authoritative for the drop itself (and for drops that
 * happen in another window).
 */
let currentDrag: DragPayload | null = null;

/** Starts an internal drag: writes the payload and records it for live previews. */
export function beginDrag(dt: DataTransferLike, payload: DragPayload): void {
  currentDrag = payload;
  writeDragPayload(dt, payload);
}

/** Ends an internal drag (dragend fires even when the drop was rejected). */
export function endDrag(): void {
  currentDrag = null;
}

/** The gesture currently in flight, if it is ours. */
export function currentDragPayload(): DragPayload | null {
  return currentDrag;
}

/** True when an internal drag of ours is in flight (used to ignore file overlays). */
export function isInternalDrag(): boolean {
  return currentDrag !== null;
}

/** Payload for a live dragover: `dataTransfer` first, in-flight gesture as fallback. */
export function resolveDragPayload(dt: DataTransferLike | null | undefined): DragPayload | null {
  return readDragPayload(dt) ?? currentDrag;
}

function parseJson<T>(raw: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Reads an internal payload from a drag. `null` means "not ours" — a file drag
 * (or any foreign app's drag) is then handled by the file import path instead.
 * Never throws: an incomplete `dataTransfer` during dragover must not break the UI.
 */
export function readDragPayload(dt: DataTransferLike | null | undefined): DragPayload | null {
  if (!dt) return null;

  const clipId = hasType(dt, DRAG_MIME_CLIP) ? dt.getData(DRAG_MIME_CLIP) : '';
  if (clipId) return { kind: 'clip', clipId };

  const trackId = hasType(dt, DRAG_MIME_TRACK) ? dt.getData(DRAG_MIME_TRACK) : '';
  if (trackId) return { kind: 'track', trackId };

  const selectionRaw = hasType(dt, DRAG_MIME_SELECTION) ? dt.getData(DRAG_MIME_SELECTION) : '';
  if (selectionRaw) {
    const parsed = parseJson<{ start?: number; end?: number }>(selectionRaw);
    if (parsed && typeof parsed.start === 'number' && typeof parsed.end === 'number') {
      return { kind: 'selection', start: parsed.start, end: parsed.end };
    }
  }

  const kind = hasType(dt, DRAG_MIME_KIND) ? dt.getData(DRAG_MIME_KIND) : '';
  if (kind === 'clip') {
    const fallback = dt.getData('text/plain');
    if (fallback) return { kind: 'clip', clipId: fallback };
  } else if (kind === 'track') {
    const fallback = dt.getData('text/plain');
    if (fallback) return { kind: 'track', trackId: fallback };
  }
  return null;
}

/** True when the drag carries files (XML / audio import), i.e. an external drop. */
export function isFileDrag(dt: DataTransferLike | null | undefined): boolean {
  if (!dt) return false;
  if (hasType(dt, 'Files')) return true;
  const files = dt.files;
  if (files && typeof files.length === 'number' && files.length > 0) return true;
  const items = dt.items;
  if (items && typeof items.length === 'number') {
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.kind === 'file') return true;
    }
  }
  return false;
}

/**
 * Modifier semantics of a drop onto the deck timeline:
 * (nothing) = insert and shift, Shift = replace the same-length window,
 * Alt/Option = overdub (mix, timeline length untouched), Ctrl/Meta = replace too.
 */
export function structuralDropMode(modifiers: {
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): { mode: Exclude<DropMode, 'load'>; label: string } {
  if (modifiers.altKey) return { mode: 'overdub', label: 'Überlagern (Overdub)' };
  if (modifiers.shiftKey || modifiers.ctrlKey || modifiers.metaKey) {
    return { mode: 'replace', label: 'Bereich ersetzen' };
  }
  return { mode: 'insert', label: 'Einfügen (Material danach rückt)' };
}

/** `dropEffect` to advertise for a mode (cursor feedback while dragging). */
export function dropEffectFor(mode: DropMode): 'copy' | 'move' | 'link' | 'none' {
  switch (mode) {
    case 'overdub':
      return 'link';
    case 'replace':
      return 'move';
    default:
      return 'copy';
  }
}
