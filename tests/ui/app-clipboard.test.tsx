/**
 * @license
 * COPY / PASTE / CLONE in the real app — the combinations a user clicks through.
 *
 * Reported by a user of the built Windows app: "Bereich selektiert, COPY, woanders
 * PASTE — er fügt nicht den selektierten Bereich ein, und die Wellenform passt
 * nicht." Root cause class: a timeline window that cannot be traced back to the
 * original material used to be *guessed* (project position treated as source
 * position). These tests pin the two guarantees instead:
 *
 *   1. PASTE goes where the user pointed (selection first, else playhead),
 *   2. a source position is only ever claimed when it was verified — and the
 *      waveform then really is the stored columns of that verified window.
 *
 * Run with: npx vitest run tests/ui/app-clipboard.test.tsx
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import App from '../../src/App';
import { fakeAudio } from '../setup/ui';
import { createIndexedBuffer } from '../helpers/fakeAudioContext';
import { DECODED_SECONDS } from '../helpers/appHarness';
import {
  buttonByTitle,
  clipCards,
  cloneSelectionToPalette,
  closeModal,
  dropClipOnDeck,
  durationText,
  importAudio,
  seek,
  selectRange,
  SEL,
} from '../helpers/appHarness';
import { dialogs, resetDialogs, waitForFrames } from '../setup/ui';

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

const COPY_BTN = /Auswahl in die Zwischenablage/;
const PASTE_BTN = /^Einfügen \(Strg\+V\)/;
const FEEDBACK_TEXT = () => document.body.textContent ?? '';

describe('App — Zwischenablage und Quellfenster', () => {
  it('C1: PASTE uses the live selection as the target, not the playhead', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);

    await selectRange(container, 3, 6);
    fireEvent.click(buttonByTitle(container, COPY_BTN));
    await waitForFrames(2);

    // Target: a different window, playhead still at 0.000 s.
    await selectRange(container, 1, 2);
    fireEvent.click(buttonByTitle(container, PASTE_BTN));
    await waitForFrames(3);

    expect(FEEDBACK_TEXT()).toContain('Zwischenablage eingefügt');
    expect(FEEDBACK_TEXT()).toContain('an der Auswahlposition (1.000s)');
    expect(FEEDBACK_TEXT()).not.toContain('an der Wiedergabeposition');
    // 8 s deck + 3 s pasted material
    expect(durationText(container)).toBe('00:11.0');
    expect(dialogs.alerts).toEqual([]);
  });

  it('C2: PASTE without a selection falls back to the playhead and says so', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);

    await selectRange(container, 3, 6);
    fireEvent.click(buttonByTitle(container, COPY_BTN));
    await waitForFrames(2);
    fireEvent.click(buttonByTitle(container, /Auswahl aufheben/)); // CANCEL leaves no target selection
    await waitForFrames(1);
    await seek(container, 7);

    fireEvent.click(buttonByTitle(container, PASTE_BTN));
    await waitForFrames(3);
    expect(FEEDBACK_TEXT()).toContain('an der Wiedergabeposition (7.000s)');
    expect(durationText(container)).toBe('00:11.0');
  });

  it('C3: COPY after a cut takes the material from its ORIGINAL position, and the waveform follows', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);

    // Remove 3–6 s, so everything behind it shifts 3 s to the left.
    await selectRange(container, 3, 6);
    fireEvent.click(container.querySelector(SEL.delete) as HTMLElement);
    await waitForFrames(3);
    expect(durationText(container)).toBe('00:05.0');

    // The window right behind the gap is project 3.0 s — that is source 6.0 s.
    await selectRange(container, 3, 4.5);
    fireEvent.click(buttonByTitle(container, COPY_BTN));
    await waitForFrames(2);
    await selectRange(container, 0.5, 1);
    fireEvent.click(buttonByTitle(container, PASTE_BTN));
    await waitForFrames(3);

    expect(FEEDBACK_TEXT()).toContain('Quelle: Originalmaterial ab 6.000s');
    // Stored columns are reused, so nothing is re-analyzed and nothing is invented.
    expect(FEEDBACK_TEXT()).toContain('gespeicherte Wellenform-Spalten werden übernommen');
    expect(FEEDBACK_TEXT()).not.toContain('werden daraus berechnet');
    expect(durationText(container)).toBe('00:06.5');
  });

  it('C4: a cloned window that spans the cut join claims NO source position', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);

    await selectRange(container, 3, 6);
    fireEvent.click(container.querySelector(SEL.delete) as HTMLElement);
    await waitForFrames(3);

    // 2.9–3.1 straddles the join: the two halves come from different source places.
    await selectRange(container, 2.9, 3.1);
    await cloneSelectionToPalette(container);
    const card = clipCards(container)[0];
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('EDIT-MATERIAL');
    expect(card.title).toContain('Kein geprüftes Quellfenster');
    expect(card.title).not.toContain('Quellfenster im Original geprüft');
  });

  it('C5: a verified clone is labelled by its proven source window and previews from stored columns', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);

    await selectRange(container, 3, 6);
    await cloneSelectionToPalette(container);
    const card = clipCards(container)[0];
    expect(card.textContent).toContain('QUELLE GEPRÜFT');
    expect(card.textContent).toContain('Vorschau: gespeicherte Spalten');
    expect(card.title).toContain('Quellfenster im Original geprüft: 3.000s–6.000s');
  });

  it('C6: dropping the unverified clip keeps audio and waveform consistent (labelled, not borrowed)', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);

    await selectRange(container, 3, 6);
    fireEvent.click(container.querySelector(SEL.delete) as HTMLElement);
    await waitForFrames(2);
    await selectRange(container, 2.9, 3.1);
    await cloneSelectionToPalette(container);
    const card = clipCards(container)[0];
    dropClipOnDeck(container, card, 1);
    await waitForFrames(3);
    closeModal(container);

    // 0.2 s of material inserted at 1 s into a 5 s timeline.
    expect(durationText(container)).toBe('00:05.2');
    // The inserted region has no verified source, so its columns are honestly
    // marked as computed instead of silently drawn from the original at 1 s.
    const footer = Array.from(container.querySelectorAll('span, div')).find((el) =>
      /EDIT-WAVEFORM/.test(el.textContent ?? '')
    );
    expect(footer?.textContent ?? '').toContain('BERECHNET');
    expect(dialogs.alerts).toEqual([]);
  });

  it('C7: Ctrl+C / Ctrl+V route through the same verified path as the buttons', async () => {
    const { container } = render(<App />);
    await waitForFrames(2);
    await importAudio(container);
    closeModal(container);

    await selectRange(container, 3, 6);
    fireEvent.keyDown(window.document, { code: 'KeyC', ctrlKey: true });
    await waitForFrames(2);
    await selectRange(container, 0, 0.5);
    fireEvent.keyDown(window.document, { code: 'KeyV', ctrlKey: true });
    await waitForFrames(3);

    expect(FEEDBACK_TEXT()).toContain('Zwischenablage eingefügt');
    expect(durationText(container)).toBe('00:11.0');
    // Undo removes the paste again — the clipboard itself stays filled.
    fireEvent.click(container.querySelector(SEL.undo) as HTMLElement);
    await waitForFrames(2);
    expect(durationText(container)).toBe('00:08.0');
  });
});
