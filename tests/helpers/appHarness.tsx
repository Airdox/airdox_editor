/**
 * @license
 * Shared driver for the full-app workflow tests (test-only file).
 *
 * Everything here mirrors what a user does with a mouse — the locators are the
 * visible labels and titles, never test ids — so both App test files stay in
 * sync when the UI changes: one place to fix when a caption moves.
 */
import { fireEvent, act } from '@testing-library/react';
import React from 'react';
import { fakeAudio, waitForFrames } from '../setup/ui';
import { createIndexedBuffer } from './fakeAudioContext';
import { FakeDataTransfer, makeDragEvent, makePointerEvent, timeToClientX } from './domEvents';
import { SCENARIO_TECHNO_XML } from '../fixtures/testDatasets';

export const DECODED_SECONDS = 8;
/** The deck opens with a fixed 18 s zoom window (App state default). */
export const VIEW_DURATION = 18;

/** Locators that mirror what the user actually sees, not test ids. */
export const SEL = {
  deckCanvas: 'canvas[width="1200"]',
  clipCard: '[draggable="true"][title*="Drop = Einfügen"]',
  browserRow: 'tr[draggable="true"][title*="lädt den Track in Deck A"]',
  clone: 'button[title="Auswahl klonen / zur Palette"]',
  clear: 'button[title="Stumm schalten / leeren (Clear)"]',
  delete: 'button[title="Löschen mit Zeitanpassung (Delete)"]',
  undo: 'button[title="Rückgängig (Ctrl+Z)"]',
  redo: 'button[title="Wiederholen (Ctrl+Y)"]',
};

export function audioFile(name = 'Set.wav'): File {
  return new File([new Uint8Array(64)], name, { type: 'audio/wav' });
}

export async function importAudio(container: HTMLElement, file = audioFile()) {
  const input = container.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } as never });
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
  await waitForFrames(3);
}

export async function importXml(container: HTMLElement, xml = SCENARIO_TECHNO_XML) {
  const file = new File([xml], 'rekordbox.xml', { type: 'text/xml' });
  const input = container.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } as never });
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  // loadXmlFile opens the collection popup after a real 1.2 s progress delay.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1400));
  });
  await waitForFrames(3);
}

/** Dismisses whatever operation-feedback / info modal is on screen. */
export function closeModal(container: HTMLElement) {
  for (const button of Array.from(container.querySelectorAll('button'))) {
    const label = (button.textContent ?? '').trim();
    if (label === 'OK' || label === 'Schließen' || label === 'Fertig' || label === '×') {
      fireEvent.click(button);
    }
  }
}

/** React props of a DOM node (only used to find the element that owns a handler). */
export function reactProps(element: Element): Record<string, unknown> | null {
  const key = Object.keys(element).find((k) => k.startsWith('__reactProps$'));
  return key ? ((element as unknown as Record<string, Record<string, unknown>>)[key] ?? null) : null;
}

/**
 * The detail waveform canvas. Located by the handlers it carries, because the
 * overview strip renders a canvas of the same nominal size and the app has more
 * than one — an id-based query would silently hit the wrong pane.
 */
export function deckCanvas(container: HTMLElement): HTMLElement {
  const canvas = deckCanvasOrNull(container);
  if (!canvas) throw new Error(`interaktives Detail-Waveform-Canvas (${SEL.deckCanvas}) nicht gefunden`);
  return canvas;
}

export function deckCanvasOrNull(container: HTMLElement): HTMLElement | undefined {
  return Array.from(container.querySelectorAll(SEL.deckCanvas)).find(
    (el) => typeof reactProps(el)?.onMouseDown === 'function'
  ) as HTMLElement | undefined;
}

/** Elements that carry both dragover and drop handlers (real drop zones). */
export function dropZones(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('div')).filter((el) => {
    const props = reactProps(el);
    return !!props && typeof props.onDrop === 'function' && typeof props.onDragOver === 'function';
  }) as HTMLElement[];
}

/**
 * The deck's drop zone — the DetailWaveform container. Located through its
 * handlers so the same lookup works in the empty state, where the component
 * renders a placeholder instead of a canvas.
 */
export function deckHost(container: HTMLElement): HTMLElement {
  const zones = dropZones(container);
  const canvas = deckCanvasOrNull(container);
  const withCanvas = canvas ? zones.find((z) => z.contains(canvas)) : undefined;
  const zone =
    withCanvas ??
    zones.find((z) => (z.textContent ?? '').includes('Bereit für Import')) ??
    zones.find((z) => (z.textContent ?? '').includes('Waveform'));
  if (!zone) throw new Error('Drop-Zone der Detail-Waveform nicht gefunden');
  return zone;
}

/**
 * Quantize is a toggle, so it is only clicked when the state differs — a test
 * that clicked it blindly would flip snapping on again half way through.
 */
export async function setQuantize(container: HTMLElement, on: boolean) {
  const button = container.ownerDocument.querySelector('button[title="Quantize Mode"]') as HTMLElement;
  const active = button.className.includes('#ff3b30');
  if (active !== on) fireEvent.click(button);
  await waitForFrames(1);
}

/**
 * Selects [from, to] (seconds) by dragging on the waveform. Quantization is
 * turned off first: the pixel → time mapping is only exact for values on the
 * 1200 px grid (multiples of 3 s in an 18 s window), and that is what the
 * assertions below rely on.
 */
export async function selectRange(container: HTMLElement, from: number, to: number) {
  await setQuantize(container, false);
  const canvas = deckCanvas(container);
  const y = 120;
  fireEvent(canvas, makePointerEvent('mousedown', timeToClientX(from, 0, VIEW_DURATION), y));
  fireEvent(canvas, makePointerEvent('mousemove', timeToClientX(to, 0, VIEW_DURATION), y));
  fireEvent(canvas, makePointerEvent('mouseup', timeToClientX(to, 0, VIEW_DURATION), y));
  await waitForFrames(2);
}

export async function cloneSelectionToPalette(container: HTMLElement) {
  fireEvent.click(container.ownerDocument.querySelector(SEL.clone) as HTMLElement);
  await waitForFrames(2);
}

export function dropClipOnDeck(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars

  container: HTMLElement,
  card: HTMLElement,
  time: number,
  modifiers: { shiftKey?: boolean; altKey?: boolean } = {}
) {
  const dataTransfer = new FakeDataTransfer();
  const host = deckHost(container);
  const x = timeToClientX(time, 0, VIEW_DURATION);
  fireEvent(card, makeDragEvent('dragstart', { dataTransfer }));
  dataTransfer.readOnly = true;
  fireEvent(host, makeDragEvent('dragover', { dataTransfer, x, ...modifiers }));
  dataTransfer.readOnly = false;
  fireEvent(host, makeDragEvent('drop', { dataTransfer, x, ...modifiers }));
  fireEvent(card, makeDragEvent('dragend', { dataTransfer }));
}

/** First mm:ss.s time read-out = the project/timeline length in the header. */
export function durationText(container: HTMLElement): string {
  const match = container.textContent?.match(/(\d\d:\d\d\.\d)/);
  return match ? match[1] : '';
}

export function clipCards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll(SEL.clipCard)) as HTMLElement[];
}
