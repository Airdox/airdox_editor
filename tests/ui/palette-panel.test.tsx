/**
 * Component tests: Schnipselpalette as a drag source and drop target.
 *
 * These assert the *user-visible contract* of Phase 6 — what a drag carries,
 * which targets accept it, and what the panel must never do (invent a waveform,
 * delete without a payload, treat an internal drag as a file import).
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { PalettePanel } from '../../src/components/PalettePanel';
import { DataOrigin, PaletteClip } from '../../src/types/rekordbox';
import { DRAG_MIME_CLIP, DRAG_MIME_KIND, DRAG_MIME_SELECTION, endDrag } from '../../src/dnd/dragPayload';
import { FakeDataTransfer, dragFromTo, makeDragEvent } from '../helpers/domEvents';
import { createIndexedBuffer } from '../helpers/fakeAudioContext';

function makeClip(overrides: Partial<PaletteClip> = {}): PaletteClip {
  return {
    id: 'clip-1',
    name: 'Kick Loop',
    sourceTrackId: 'deck',
    sourceTrackName: 'Deck Track',
    sourceStart: 4,
    sourceEnd: 6,
    duration: 2,
    beats: 4,
    bars: 1,
    bpm: 124,
    key: '2A',
    color: '#00a2ff',
    audioBuffer: createIndexedBuffer(2, 44100) as unknown as AudioBuffer,
    origin: DataOrigin.REKORDBOX_XML,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  endDrag();
});

describe('PalettePanel — clip as drag source', () => {
  it('starts a drag carrying the clip id in the internal payload', () => {
    const clips = [makeClip()];
    const { container } = render(
      <PalettePanel
        isOpen
        onToggle={() => {}}
        clips={clips}
        onAddFromSelection={() => {}}
        onDeleteClip={() => {}}
        onSelectClip={() => {}}
        selectedClipId={null}
        hasSelection={false}
      />
    );
    const card = container.querySelector('[draggable="true"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('Kick Loop');

    const dataTransfer = new FakeDataTransfer();
    fireEvent(card, makeDragEvent('dragstart', { dataTransfer }));
    expect(dataTransfer.getData(DRAG_MIME_CLIP)).toBe('clip-1');
    expect(dataTransfer.getData(DRAG_MIME_KIND)).toBe('clip');
    expect(dataTransfer.getData('text/plain')).toBe('Kick Loop');
    expect(dataTransfer.effectAllowed).toBe('copyMove');
  });

  it('offers three drop targets and describes them in the tooltips', () => {
    const { container } = render(
      <PalettePanel
        isOpen
        onToggle={() => {}}
        clips={[makeClip()]}
        onAddFromSelection={() => {}}
        onDeleteClip={() => {}}
        onSelectClip={() => {}}
        selectedClipId="clip-1"
        hasSelection
      />
    );
    const card = container.querySelector('[draggable="true"]') as HTMLElement;
    expect(card.getAttribute('title')).toContain('Deck-Ansicht');
    expect(card.getAttribute('title')).toContain('Papierkorb');
    expect(card.getAttribute('title')).toContain('Drop = Einfügen');
    expect(card.className).toContain('cursor-grab');
  });

  it('marks the source card while it is in flight and clears it on dragend', () => {
    const { container } = render(
      <PalettePanel
        isOpen
        onToggle={() => {}}
        clips={[makeClip()]}
        onAddFromSelection={() => {}}
        onDeleteClip={() => {}}
        onSelectClip={() => {}}
        selectedClipId={null}
        hasSelection={false}
      />
    );
    const card = container.querySelector('[draggable="true"]') as HTMLElement;
    const dataTransfer = new FakeDataTransfer();
    fireEvent(card, makeDragEvent('dragstart', { dataTransfer }));
    expect(card.className).toContain('border-dashed');
    fireEvent(card, makeDragEvent('dragend', { dataTransfer }));
    expect(card.className).not.toContain('border-dashed');
  });
});

describe('PalettePanel — selection drop target', () => {
  it('creates a clip from a dragged selection window and reports it', () => {
    const seen: Array<[number, number]> = [];
    const { container } = render(
      <PalettePanel
        isOpen
        onToggle={() => {}}
        clips={[]}
        onAddFromSelection={() => {}}
        onDeleteClip={() => {}}
        onSelectClip={() => {}}
        selectedClipId={null}
        hasSelection
        onDropSelection={(start, end) => seen.push([start, end])}
      />
    );
    const list = container.querySelector('.overflow-y-auto') as HTMLElement;
    const dataTransfer = new FakeDataTransfer({
      data: { [DRAG_MIME_SELECTION]: JSON.stringify({ start: 1.5, end: 3.25 }) },
    });
    fireEvent(list, makeDragEvent('dragover', { dataTransfer }));
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(list.textContent).toContain('Auswahl hier ablegen');
    fireEvent(list, makeDragEvent('drop', { dataTransfer }));
    expect(seen).toEqual([[1.5, 3.25]]);
    // The hint disappears again — no stale highlight after a drop.
    expect(list.textContent).not.toContain('Auswahl hier ablegen');
  });

  it('ignores clip drags on the list (a clip must not clone itself)', () => {
    const onDropSelection = () => {
      throw new Error('clip drag must not create a clip');
    };
    const { container } = render(
      <PalettePanel
        isOpen
        onToggle={() => {}}
        clips={[makeClip()]}
        onAddFromSelection={() => {}}
        onDeleteClip={() => {}}
        onSelectClip={() => {}}
        selectedClipId={null}
        hasSelection
        onDropSelection={onDropSelection}
      />
    );
    const list = container.querySelector('.overflow-y-auto') as HTMLElement;
    const dataTransfer = new FakeDataTransfer({ data: { [DRAG_MIME_CLIP]: 'clip-1' } });
    fireEvent(list, makeDragEvent('dragover', { dataTransfer }));
    fireEvent(list, makeDragEvent('drop', { dataTransfer }));
    expect(list.textContent).not.toContain('Auswahl hier ablegen');
  });

  it('treats a foreign file drag as no-op here (the window overlay owns files)', () => {
    const { container } = render(
      <PalettePanel
        isOpen
        onToggle={() => {}}
        clips={[]}
        onAddFromSelection={() => {}}
        onDeleteClip={() => {}}
        onSelectClip={() => {}}
        selectedClipId={null}
        hasSelection={false}
        onDropSelection={() => {
          throw new Error('file drag must not create a clip');
        }}
      />
    );
    const list = container.querySelector('.overflow-y-auto') as HTMLElement;
    const dataTransfer = new FakeDataTransfer({ files: [{ name: 'song.wav', type: 'audio/wav' }] });
    expect(() => {
      fireEvent(list, makeDragEvent('dragover', { dataTransfer }));
      fireEvent(list, makeDragEvent('drop', { dataTransfer }));
    }).not.toThrow();
  });
});

describe('PalettePanel — trash drop target', () => {
  it('deletes the dropped clip, not the selected one', () => {
    const deleted: string[] = [];
    const { container } = render(
      <PalettePanel
        isOpen
        onToggle={() => {}}
        clips={[makeClip({ id: 'clip-1' }), makeClip({ id: 'clip-2', name: 'Other' })]}
        onAddFromSelection={() => {}}
        onDeleteClip={(id) => deleted.push(id)}
        onSelectClip={() => {}}
        selectedClipId="clip-1"
        hasSelection={false}
      />
    );
    const source = container.querySelectorAll('[draggable="true"]')[1] as HTMLElement;
    const trash = screen.getByTitle(/Ausgewählten Clip löschen/) as HTMLElement;
    expect(trash).toBeTruthy();
    dragFromTo(source, trash, { [DRAG_MIME_CLIP]: 'clip-2', [DRAG_MIME_KIND]: 'clip' });
    expect(deleted).toEqual(['clip-2']);
  });

  it('never deletes on an unrelated drop', () => {
    const deleted: string[] = [];
    const onDeleteClip = (id: string) => deleted.push(id);
    render(
      <PalettePanel
        isOpen
        onToggle={() => {}}
        clips={[makeClip()]}
        onAddFromSelection={() => {}}
        onDeleteClip={onDeleteClip}
        onSelectClip={() => {}}
        selectedClipId="clip-1"
        hasSelection={false}
      />
    );
    const trash = screen.getByTitle(/Ausgewählten Clip löschen/) as HTMLElement;
    const empty = new FakeDataTransfer();
    const fileDrag = new FakeDataTransfer({ files: [{ name: 'notes.txt', type: 'text/plain' }] });
    fireEvent(trash, makeDragEvent('dragover', { dataTransfer: empty }));
    fireEvent(trash, makeDragEvent('drop', { dataTransfer: empty }));
    fireEvent(trash, makeDragEvent('dragover', { dataTransfer: fileDrag }));
    fireEvent(trash, makeDragEvent('drop', { dataTransfer: fileDrag }));
    expect(deleted).toEqual([]);
    expect(trash.className).not.toContain('ring-1');
  });
});

describe('PalettePanel — controls', () => {
  it('adds the current selection via the + button and via the empty-state hint', () => {
    let calls = 0;
    const { container, rerender } = render(
      <PalettePanel
        isOpen
        onToggle={() => {}}
        clips={[]}
        onAddFromSelection={() => {
          calls += 1;
        }}
        onDeleteClip={() => {}}
        onSelectClip={() => {}}
        selectedClipId={null}
        hasSelection
      />
    );
    const plus = within(container).getByTitle(/Auswahl als Clip|Neuen Clip|CLONE|als Clip/i);
    fireEvent.click(plus);
    expect(calls).toBeGreaterThan(0);
    expect(container.textContent).toContain('Keine Clips in der Palette');
    rerender(
      <PalettePanel
        isOpen
        onToggle={() => {}}
        clips={[makeClip()]}
        onAddFromSelection={() => {}}
        onDeleteClip={() => {}}
        onSelectClip={() => {}}
        selectedClipId="clip-1"
        hasSelection
      />
    );
    expect(container.textContent).toContain('Kick Loop');
  });

  it('selects a clip on click and previews it on the play button', () => {
    const selected: string[] = [];
    const { container } = render(
      <PalettePanel
        isOpen
        onToggle={() => {}}
        clips={[makeClip()]}
        onAddFromSelection={() => {}}
        onDeleteClip={() => {}}
        onSelectClip={(clip) => selected.push(clip.id)}
        selectedClipId={null}
        hasSelection={false}
      />
    );
    const card = container.querySelector('[draggable="true"]') as HTMLElement;
    fireEvent.click(within(card).getByText('Kick Loop'));
    expect(selected).toEqual(['clip-1']);
    const play = within(card).getByTitle('Play Preview');
    fireEvent.click(play);
    expect(within(card).getByTitle('Stop')).toBeTruthy();
    fireEvent.click(within(card).getByTitle('Stop'));
    expect(within(card).getByTitle('Play Preview')).toBeTruthy();
  });

  it('collapses when the toggle is pressed and keeps the clip count visible when open', () => {
    const toggles: boolean[] = [];
    const { container } = render(
      <PalettePanel
        isOpen
        onToggle={() => toggles.push(true)}
        clips={[makeClip(), makeClip({ id: 'clip-2', name: 'Clap' })]}
        onAddFromSelection={() => {}}
        onDeleteClip={() => {}}
        onSelectClip={() => {}}
        selectedClipId={null}
        hasSelection={false}
      />
    );
    expect(within(container).getAllByText(/CLAP|Clap/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTitle('Palette einklappen'));
    expect(toggles.length).toBe(1);
  });
});
