/**
 * Workflow scenarios: the whole app in a DOM.
 *
 * Every scenario drives the real components with real events and asserts the
 * follow-up state of the *combination* (import → selection → palette → drop →
 * undo → delete → clear → collection drop → save), not one function in
 * isolation. Where the app promises something to the user (timeline duration,
 * provenance line, refusal text, German wording), that promise is what is
 * checked — a UI that silently keeps showing the old waveform is exactly the
 * failure this suite exists to catch.
 *
 * The driving helpers live in `tests/helpers/appHarness.tsx` and are shared with
 * `app-tools.test.tsx`.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, fireEvent, act, screen } from '@testing-library/react';
import App from '../../src/App';
import { fakeAudio, dialogs, resetDialogs, waitForFrames } from '../setup/ui';
import { createIndexedBuffer } from '../helpers/fakeAudioContext';
import { FakeDataTransfer, makeDragEvent } from '../helpers/domEvents';
import { DRAG_MIME_CLIP } from '../../src/dnd/dragPayload';
import { SCENARIO_TECHNO_XML } from '../fixtures/testDatasets';
import {
  DECODED_SECONDS,
  SEL,
  audioFile,
  clipCards,
  closeModal,
  cloneSelectionToPalette,
  deckHost,
  dropClipOnDeck,
  durationText,
  importAudio,
  importXml,
  selectRange,
  setQuantize,
} from '../helpers/appHarness';

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

describe('Workflow — Import, Auswahl, Palette, Drop', () => {
  it('W1: an empty project shows an empty deck and invents nothing', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    expect(container.textContent).toContain('Kein Track geladen');
    expect(container.textContent).toContain('LEERES PROJEKT');
    expect(durationText(container)).toBe('00:00.0');
  });

  it('W2: importing audio loads the deck, the timeline length and a feedback modal', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    expect(container.textContent).toContain('Set');
    expect(durationText(container)).toBe('00:08.0');
    expect(container.textContent).toContain('Audiodatei importiert');
    expect(container.textContent).toContain('Originaldatei unverändert');
    expect(dialogs.alerts).toEqual([]);
  });

  it('W3: a selection becomes a palette clip that can be dragged', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    await selectRange(container, 3, 6);
    await cloneSelectionToPalette(container);
    const cards = clipCards(container);
    expect(cards.length).toBe(1);
    // 3 s at 130 BPM = 1.6 bars — and a bar is four beats, not a quarter beat.
    expect(cards[0].textContent).toContain('1.6 Bars');
    expect(container.textContent).not.toContain('Keine Clips in der Palette');
  });

  it('W4: dropping the clip inserts it and re-derives length, waveform and provenance', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    await selectRange(container, 3, 6);
    await cloneSelectionToPalette(container);
    dropClipOnDeck(container, clipCards(container)[0], 3);
    await waitForFrames(2);

    // 8 s of material + a 3 s clip inserted = 11 s project.
    expect(durationText(container)).toBe('00:11.0');
    expect(container.textContent).toContain('Clip per Drag & Drop eingefügt');
    // The columns come from the original analysis, not from a fresh one.
    expect(container.textContent).toMatch(/EDIT-WAVEFORM \d+\/\d+ AUS ANLZ · KEINE NEUANALYSE/);
  });

  it('W5: Shift-drop replaces and Alt-drop overdubs — both keep the timeline length', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    await selectRange(container, 3, 6);
    await cloneSelectionToPalette(container);
    const card = clipCards(container)[0];

    dropClipOnDeck(container, card, 3, { shiftKey: true });
    await waitForFrames(2);
    expect(durationText(container)).toBe('00:08.0');
    expect(container.textContent).toContain('ersetzt');
    closeModal(container);

    dropClipOnDeck(container, card, 3, { altKey: true });
    await waitForFrames(2);
    expect(durationText(container)).toBe('00:08.0');
    expect(container.textContent).toContain('überlagert');
  });

  it('W6: Undo restores the unedited deck, Redo replays the drop', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    await selectRange(container, 0, 3);
    await cloneSelectionToPalette(container);
    dropClipOnDeck(container, clipCards(container)[0], 3);
    await waitForFrames(2);
    expect(durationText(container)).toBe('00:11.0');
    closeModal(container);

    fireEvent.click(container.ownerDocument.querySelector(SEL.undo) as HTMLElement);
    await waitForFrames(2);
    expect(durationText(container)).toBe('00:08.0');

    fireEvent.click(container.ownerDocument.querySelector(SEL.redo) as HTMLElement);
    await waitForFrames(2);
    expect(durationText(container)).toBe('00:11.0');
  });

  it('W7: Delete cuts the range out of the timeline, Clear only silences it', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);

    await selectRange(container, 3, 6);
    fireEvent.click(container.ownerDocument.querySelector(SEL.clear) as HTMLElement);
    await waitForFrames(2);
    expect(durationText(container)).toBe('00:08.0');
    expect(container.textContent).toMatch(/stumm|leeren|CLEAR/i);
    closeModal(container);

    await selectRange(container, 3, 6);
    fireEvent.click(container.ownerDocument.querySelector(SEL.delete) as HTMLElement);
    await waitForFrames(2);
    // 8 s − 3 s of deleted material: the timeline really shrinks.
    expect(durationText(container)).toBe('00:05.0');
    expect(container.textContent).toContain('gelöscht');
  });

  it('W8: the seeded marker survives an insertion in front of it without duplicating', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    const cueBefore = (container.textContent?.match(/(\d+) MEM/) ?? [])[1];
    await selectRange(container, 3, 6);
    await cloneSelectionToPalette(container);
    dropClipOnDeck(container, clipCards(container)[0], 0);
    await waitForFrames(2);
    expect(cueBefore).toBe('1');
    expect((container.textContent?.match(/(\d+) MEM/) ?? [])[1]).toBe('1');
    expect(durationText(container)).toBe('00:11.0');
  });
});

describe('Workflow — Collection, Drag aus dem Browser, Datei-Drop', () => {
  it('W9: an XML file dropped on the window opens the collection but never a deck', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    const file = new File([SCENARIO_TECHNO_XML], 'rekordbox.xml', { type: 'text/xml' });
    const dataTransfer = new FakeDataTransfer({ files: [{ name: file.name, type: file.type }] });
    Object.defineProperty(dataTransfer, 'files', { value: [file], configurable: true });
    await act(async () => {
      window.dispatchEvent(makeDragEvent('dragenter', { dataTransfer }));
      window.dispatchEvent(makeDragEvent('dragover', { dataTransfer }));
      window.dispatchEvent(makeDragEvent('drop', { dataTransfer }));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1400));
    });
    await waitForFrames(3);
    // The collection popup lists the record …
    expect(container.textContent).toContain('Obsidian Voltage');
    // … and the deck is still empty: no arbitrary auto-load (Phase 6 rule).
    expect(container.textContent).toContain('Kein Track geladen');
    expect(dialogs.alerts).toEqual([]);
  });

  it('W10: dragging a browser row onto the deck reloads that deck track', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    await selectRange(container, 1, 2);
    await cloneSelectionToPalette(container);
    // The BROWSER strip is collapsed by default; open it to reach its rows.
    const toggle = Array.from(container.querySelectorAll('button')).find((b) =>
      /BROWSER/i.test((b.textContent ?? '').trim())
    ) as HTMLElement;
    fireEvent.click(toggle);
    await waitForFrames(2);
    const row = container.querySelector(SEL.browserRow) as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('Set');

    const dataTransfer = new FakeDataTransfer();
    fireEvent(row, makeDragEvent('dragstart', { dataTransfer }));
    dataTransfer.readOnly = true;
    const host = deckHost(container);
    fireEvent(host, makeDragEvent('dragover', { dataTransfer }));
    expect(dataTransfer.dropEffect).toBe('link');
    fireEvent(host, makeDragEvent('drop', { dataTransfer }));
    fireEvent(row, makeDragEvent('dragend', { dataTransfer }));
    await waitForFrames(3);

    // Dropping the row re-loads the deck (same 8 s project, no clip insert) and
    // never invents a second timeline.
    expect(durationText(container)).toBe('00:08.0');
    expect(container.textContent).not.toContain('Clip per Drag & Drop eingefügt');
    expect(dialogs.alerts).toEqual([]);
  });

  it('W10b: „In Deck laden“ for an XML record without verified Rekordbox identity refuses out loud', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importXml(container);
    const row = Array.from(container.querySelectorAll('tr')).find((r) =>
      (r.textContent ?? '').includes('Obsidian Voltage')
    ) as HTMLElement;
    expect(row).toBeTruthy();
    // Documented design of the collection popup: a row click only highlights,
    // loading needs the explicit "In Deck laden" action, and only deck/browser
    // rows carry a drag payload at all.
    expect(row.hasAttribute('draggable')).toBe(false);
    fireEvent.click(row);
    await waitForFrames(2);
    expect(container.textContent).toContain('Kein Track geladen');

    const load = row.querySelector('button[title="Diesen Track in das DJ-Deck laden"]') as HTMLElement;
    expect(load).toBeTruthy();
    await act(async () => {
      fireEvent.click(load);
      for (let i = 0; i < 24; i++) await Promise.resolve();
    });
    await waitForFrames(3);

    // The strict identity guard refuses the load …
    expect(container.textContent).toContain('Kein Track geladen');
    // … and the refusal is stated to the user, not hidden in the log: without a
    // djmdContent.ID + exact path match there is no ANLZ, so nothing is invented.
    const alert = dialogs.alerts.join(' ');
    expect(alert).toContain('Identität nicht bestätigt');
    expect(alert).toContain('Obsidian Voltage (Club Mix)');
    // No fake waveform appears anywhere for an unloaded deck.
    expect(container.textContent).not.toMatch(/VORSCHAU-PEAKS|Ersatz-Waveform/);
  });

  it('W10c: the same record stays loadable once its file path is a local import', async () => {
    // Counterpart of W10b: a file the user hands over directly is not subject to
    // the Rekordbox identity guard — the deck must accept it and analyse locally.
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container, audioFile('Obsidian Voltage (Club Mix).wav'));
    expect(container.textContent).toContain('LOCAL_ANALYSIS');
    expect(container.textContent).not.toMatch(/KEINE WAVEFORM •/);
    expect(dialogs.alerts).toEqual([]);
  });

  it('W11: a clip drop on the empty deck is refused with a reason, silently', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    const dataTransfer = new FakeDataTransfer({ data: { [DRAG_MIME_CLIP]: 'clip-x' } });
    const host = deckHost(container);
    fireEvent(host, makeDragEvent('dragover', { dataTransfer }));
    expect(dataTransfer.dropEffect).toBe('none');
    expect(container.textContent).toContain('Clip-Drop braucht einen geladenen Deck-Track');
    fireEvent(host, makeDragEvent('drop', { dataTransfer }));
    await waitForFrames(1);
    expect(dialogs.alerts).toEqual([]);
    expect(durationText(container)).toBe('00:00.0');
  });

  it('W12: an unknown track id dropped on the deck is answered out loud', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    const dataTransfer = new FakeDataTransfer({ data: { 'application/x-airdox-track': 'nope-1' } });
    const host = deckHost(container);
    fireEvent(host, makeDragEvent('drop', { dataTransfer }));
    expect(dialogs.alerts.join(' ')).toContain('gehört zu keiner geladenen Sammlung');
  });
});

describe('Workflow — Transport, Speichern, Sprache', () => {
  it('W13: play starts a real buffer source and pause stops it (no phantom transport)', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    const play = screen.getByTitle('Play / Pause') as HTMLElement;
    const before = fakeAudio.sources.length;
    fireEvent.click(play);
    await waitForFrames(2);
    const source = fakeAudio.sources[before];
    expect(source).toBeTruthy();
    expect(source.startedAt).not.toBeNull();
    fireEvent.click(play);
    await waitForFrames(2);
    expect(source.stopped).toBe(true);
  });

  it('W14: saving goes through the desktop bridge with the protected paths attached', async () => {
    type SaveArgs = { kind: string; data: Uint8Array; defaultName: string; protectedPaths: string[] };
    const saveExportFile = vi.fn(
      async (_args: SaveArgs) => ({ saved: true, path: 'C:\\Users\\dj\\Documents\\New Project.airdox.json' })
    );
    (window as unknown as { rekordboxDesktop: unknown }).rekordboxDesktop = { saveExportFile };
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);
    const save = Array.from(container.querySelectorAll('button')).find((b) =>
      /Speichern/i.test(b.getAttribute('title') ?? '')
    ) as HTMLElement;
    expect(save).toBeTruthy();
    await act(async () => {
      fireEvent.click(save);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    await waitForFrames(2);
    expect(saveExportFile).toHaveBeenCalledTimes(1);
    const arg = saveExportFile.mock.calls[0][0];
    expect(arg.kind).toBe('PROJECT');
    expect(Array.isArray(arg.protectedPaths)).toBe(true);
    expect(container.textContent).toContain('Projekt gespeichert');
    expect(dialogs.alerts).toEqual([]);
  });

  it('W15: all user-visible workflow strings stay German', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    const text = container.textContent ?? '';
    expect(text).toContain('Audiodatei importiert');
    expect(text).toContain('Originaldatei unverändert');
    expect(text).not.toMatch(/\b(Imported successfully|Deleted|Inserted clip|File not found)\b/);
  });
});
