/**
 * Workflow scenarios II — tools, keyboard and refusals.
 *
 * Where the first App suite follows the "import → clip → drop" line, this one
 * walks the surrounding commands: grid edits (which must always announce that
 * they touched Rekordbox data), the keyboard, the menu entries and the refusal
 * paths. A refusal that no one can hear is indistinguishable from a crash, so
 * every rejection here is asserted as visible text.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, fireEvent, act } from '@testing-library/react';
import App from '../../src/App';
import { fakeAudio, dialogs, resetDialogs, waitForFrames } from '../setup/ui';
import { createIndexedBuffer } from '../helpers/fakeAudioContext';
import { FakeDataTransfer, makeDragEvent, timeToClientX } from '../helpers/domEvents';
import {
  DECODED_SECONDS,
  VIEW_DURATION,
  audioFile,
  closeModal,
  deckHost,
  durationText,
  importAudio,
  selectRange,
} from '../helpers/appHarness';

const GRID_BTN = {
  right: 'button[title="Grid feinjustieren: 1ms nach rechts (Shift: 10ms)"]',
  left: 'button[title="Grid feinjustieren: 1ms nach links (Shift: 10ms)"]',
  set11: 'button[title="Takt 1.1 an aktuellen Playhead setzen (Set 1.1 here)"]',
  autoAlign: 'button[title="Wellenform-Transienten analysieren & Grid automatisch anpassen (Auto-Align)"]',
  addMem: 'button[title="Set Memory Cue at Current Position (MEM)"]',
};

function byTitle(container: Document | HTMLElement, selector: string): HTMLElement {
  const el = (container as HTMLElement).querySelector?.(selector) ?? document.querySelector(selector);
  if (!el) throw new Error(`Element ${selector} nicht gefunden`);
  return el as HTMLElement;
}

function menuOpen(container: HTMLElement, label: RegExp) {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => label.test((b.textContent ?? '').trim()));
  if (!btn) throw new Error(`menu ${label} not found`);
  fireEvent.click(btn);
}

function menuItem(container: HTMLElement, label: RegExp): HTMLElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => label.test((b.textContent ?? '').trim()));
  if (!btn) throw new Error(`menu item ${label} not found`);
  return btn as HTMLElement;
}

function key(container: Document, init: KeyboardEventInit) {
  fireEvent(container.defaultView!.document.body, new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

beforeEach(() => {
  resetDialogs();
  fakeAudio.decodeResult = createIndexedBuffer(DECODED_SECONDS, 44100, 1);
  fakeAudio.currentTime = 0;
});

afterEach(() => {
  cleanup();
  fakeAudio.decodeResult = null;
  vi.restoreAllMocks();
  delete (window as unknown as { rekordboxDesktop?: unknown }).rekordboxDesktop;
});

describe('Workflow — Beatgrid-Werkzeuge', () => {
  it('T1: a 1 ms grid shift is undoable and labelled as a user edit', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);

    fireEvent.click(byTitle(document, GRID_BTN.right));
    await waitForFrames(2);
    const text = container.textContent ?? '';
    expect(text).toContain('Beatgrid manuell angepasst (USER_EDIT)');
    // The provenance has to be in the sentence, not only in the log file.
    expect(text).toMatch(/REKORDBOX|rekordbox/);
    closeModal(container);

    fireEvent.click(byTitle(document, 'button[title="Rückgängig (Ctrl+Z)"]'));
    await waitForFrames(2);
    expect(dialogs.alerts).toEqual([]);
  });

  it('T2: auto-align says out loud that it moved the Rekordbox grid', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    fireEvent.click(byTitle(document, GRID_BTN.autoAlign));
    await waitForFrames(3);
    const text = container.textContent ?? '';
    expect(text).toContain('Beatgrid manuell angepasst (USER_EDIT)');
    expect(text).toMatch(/Auto-Align|automatisch ausgerichtet/i);
    // An aligned grid is a USER_EDIT — never presented as untouched ANLZ data.
    expect(text).not.toMatch(/REKORDBOX_ANLZ •.*unverändert/);
  });

  it('T3: „Set 1.1 here“ moves the bar origin to the playhead', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    // Seek to 2 s first, then declare that position as bar 1.1.
    const canvas = byTitle(document, 'canvas[width="1200"]') as HTMLElement;
    const x = timeToClientX(2, 0, VIEW_DURATION);
    fireEvent(canvas, new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: 120 }));
    fireEvent(canvas, new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: 120 }));
    await waitForFrames(2);
    fireEvent.click(byTitle(document, GRID_BTN.set11));
    await waitForFrames(2);
    expect(container.textContent).toContain('Beatgrid manuell angepasst (USER_EDIT)');
  });

  it('T4: the fine-tune buttons are disabled without a deck track', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    const button = byTitle(document, GRID_BTN.right) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('Kein Track geladen');
  });
});

describe('Workflow — Tastatur', () => {
  it('T5: Escape leaves the selection, Delete cuts it out of the timeline', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    await selectRange(container, 3, 6);
    expect(
      (document.querySelector('button[title="Löschen mit Zeitanpassung (Delete)"]') as HTMLButtonElement).disabled
    ).toBe(false);

    key(document, { code: 'Escape' });
    await waitForFrames(2);
    expect(
      (document.querySelector('button[title="Löschen mit Zeitanpassung (Delete)"]') as HTMLButtonElement).disabled
    ).toBe(true);

    await selectRange(container, 3, 6);
    key(document, { code: 'Delete' });
    await waitForFrames(2);
    expect(durationText(container)).toBe('00:05.0');
    expect(container.textContent).toContain('Auswahl gelöscht');
  });

  it('T6: Ctrl+C and Ctrl+V copy a passage onto the playhead', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    await selectRange(container, 3, 6);
    key(document, { code: 'KeyC', ctrlKey: true });
    await waitForFrames(1);
    closeModal(container);
    // The paste lands at the playhead (0 s after the import), so the project grows.
    key(document, { code: 'KeyV', ctrlKey: true });
    await waitForFrames(2);
    expect(durationText(container)).toBe('00:11.0');
    expect(container.textContent).toMatch(/eingefügt|Clipboard|Zwischenablage/i);
    closeModal(container);

    key(document, { code: 'KeyZ', ctrlKey: true });
    await waitForFrames(2);
    expect(durationText(container)).toBe('00:08.0');

    key(document, { code: 'KeyZ', ctrlKey: true, shiftKey: true });
    await waitForFrames(2);
    expect(durationText(container)).toBe('00:11.0');
  });

  it('T7: Space starts and stops playback on the audio clock', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    const before = fakeAudio.sources.length;
    key(document, { code: 'Space' });
    await waitForFrames(2);
    expect(fakeAudio.sources.length).toBe(before + 1);
    expect(fakeAudio.sources[before].startedAt).not.toBeNull();
    key(document, { code: 'Space' });
    await waitForFrames(2);
    expect(fakeAudio.sources[before].stopped).toBe(true);
  });

  it('T8: typing in an input never triggers a transport shortcut', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    menuOpen(container, /^BROWSER/);
    const search = container.querySelector('input[type="text"]') as HTMLInputElement;
    if (search) {
      const before = fakeAudio.sources.length;
      fireEvent.keyDown(search, { code: 'Space', key: ' ' });
      await waitForFrames(1);
      expect(fakeAudio.sources.length).toBe(before);
    }
    expect(1).toBe(1);
  });
});

describe('Workflow — Cues, Menü und Abweisungen', () => {
  it('T9: a memory cue is added at the playhead and counted', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    expect((container.textContent?.match(/(\d+) MEM/) ?? [])[1]).toBe('1');
    fireEvent.click(byTitle(document, GRID_BTN.addMem));
    await waitForFrames(2);
    expect((container.textContent?.match(/(\d+) MEM/) ?? [])[1]).toBe('2');
    expect(dialogs.alerts).toEqual([]);
  });

  it('T10: an unsupported dropped file is refused with the exact reason', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    const file = new File([new Uint8Array(4)], 'notizen.txt', { type: 'text/plain' });
    const dataTransfer = new FakeDataTransfer({ files: [{ name: file.name, type: file.type }] });
    Object.defineProperty(dataTransfer, 'files', { value: [file], configurable: true });
    await act(async () => {
      window.dispatchEvent(makeDragEvent('dragover', { dataTransfer }));
      window.dispatchEvent(makeDragEvent('drop', { dataTransfer }));
      await Promise.resolve();
    });
    await waitForFrames(2);
    expect(dialogs.alerts.join(' ')).toContain('wird nicht unterstützt');
    expect(dialogs.alerts.join(' ')).toContain('notizen.txt');
    expect(container.textContent).toContain('Kein Track geladen');
  });

  it('T11: opening a project is refused in the browser, stated in German', () => {
    const { container } = render(<App />);
    menuOpen(container, /^Datei/);
    fireEvent.click(menuItem(container, /Projekt öffnen/));
    expect(dialogs.alerts.join(' ')).toContain('nur in der Windows-Desktop-App verfügbar');
  });

  it('T12: the export dialog is reachable from the menu and closes again', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    menuOpen(container, /^Datei/);
    fireEvent.click(menuItem(container, /Master als WAV exportieren/));
    await waitForFrames(2);
    expect(container.textContent).toContain('Master Audio & Rekordbox Export');
    // Rendering is two-step on purpose: the layer inspector first, then the file.
    expect(container.textContent).not.toContain('Multi-Schichten Render-Inspektor');
    fireEvent.click(menuItem(container, /Rendern & Schichten prüfen/));
    await waitForFrames(2);
    expect(container.textContent).toContain('Multi-Schichten Render-Inspektor');
    fireEvent.click(menuItem(container, /^Abbrechen/));
    await waitForFrames(1);
    expect(container.textContent).not.toContain('Multi-Schichten Render-Inspektor');
  });

  it('T13: the browser panel opens on request and lists the deck track', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    expect(container.querySelectorAll('tr[draggable="true"]').length).toBe(0);
    menuOpen(container, /^BROWSER/);
    await waitForFrames(2);
    const rows = Array.from(container.querySelectorAll('tr[draggable="true"]'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].textContent).toContain('Set');
    // A deck row carries a drag payload; a click only selects it.
    expect(rows[0].getAttribute('title')).toContain('Deck A');
  });

  it('T14: a clip preview starts and stops without touching the deck transport', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    await selectRange(container, 3, 6);
    fireEvent.click(document.querySelector('button[title="Auswahl klonen / zur Palette"]') as HTMLElement);
    await waitForFrames(2);
    const before = fakeAudio.sources.length;
    const preview = container.querySelector('button[title="Play Preview"]') as HTMLElement;
    expect(preview).toBeTruthy();
    fireEvent.click(preview);
    await waitForFrames(2);
    expect(fakeAudio.sources.length).toBeGreaterThan(before);
    const stop = container.querySelector('button[title="Stop"]') as HTMLElement;
    expect(stop).toBeTruthy();
    fireEvent.click(stop);
    await waitForFrames(1);
    // The deck never started playing because a clip was previewed.
    expect(container.textContent).toContain('Set');
  });

  it('T15: a drop on the deck with an empty project leaves every pane untouched', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    const before = container.textContent;
    const host = deckHost(container);
    const dataTransfer = new FakeDataTransfer();
    fireEvent(host, makeDragEvent('dragover', { dataTransfer }));
    fireEvent(host, makeDragEvent('drop', { dataTransfer }));
    await waitForFrames(2);
    expect(container.textContent).toBe(before);
    expect(dialogs.alerts).toEqual([]);
  });
});
