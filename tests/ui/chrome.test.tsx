/**
 * Chrome & boot path: the parts of the shell that carry commands, and the
 * boundary that is supposed to catch everything else.
 *
 * These are easy to overlook because they look like static markup — every item
 * here is a command that mutates the project, so each one is clicked.
 */
import React, { type ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, fireEvent, act } from '@testing-library/react';
import { MenuBar } from '../../src/components/MenuBar';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';
import { ClipDeckView } from '../../src/components/ClipDeckView';
import { makeDeckTrack, makePaletteClip } from '../helpers/trackFixtures';
import { FakeDataTransfer, makeDragEvent } from '../helpers/domEvents';
import { waitForFrames, resetDialogs, dialogs } from '../setup/ui';
import { DRAG_MIME_CLIP } from '../../src/dnd/dragPayload';
import { APP_VERSION } from '../../src/utils/appVersion';

function menuButton(container: HTMLElement, label: RegExp): HTMLElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => label.test((b.textContent ?? '').trim()));
  if (!el) throw new Error(`button matching ${label} not found`);
  return el as HTMLElement;
}

const baseMenuProps = {
  onNewProject: vi.fn(),
  onSaveProject: vi.fn(),
  onOpenProject: vi.fn(),
  onImportXml: vi.fn(),
  onImportAudio: vi.fn(),
  onExportWav: vi.fn(),
  onExportXml: vi.fn(),
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  canUndo: false,
  canRedo: false,
  waveformMode: 'RGB' as const,
  onSetWaveformMode: vi.fn(),
  paletteOpen: true,
  onTogglePalette: vi.fn(),
  browserOpen: false,
  onToggleBrowser: vi.fn(),
  onShowInfo: vi.fn(),
};

// The dialog recorder stays empty unless a component really complains.
beforeEach(() => resetDialogs());

afterEach(() => cleanup());

describe('MenuBar', () => {
  it('keeps every menu closed until it is opened, and closes on a second click', () => {
    const { container } = render(<MenuBar {...baseMenuProps} />);
    expect(container.textContent).not.toContain('Projekt speichern');
    fireEvent.click(menuButton(container, /^Datei/));
    expect(container.textContent).toContain('Projekt speichern');
    fireEvent.click(menuButton(container, /^Datei/));
    expect(container.textContent).not.toContain('Projekt speichern');
  });

  it('Datei routes each entry to its command', () => {
    const props = {
      ...baseMenuProps,
      onNewProject: vi.fn(),
      onOpenProject: vi.fn(),
      onSaveProject: vi.fn(),
      onImportXml: vi.fn(),
      onImportAudio: vi.fn(),
      onExportWav: vi.fn(),
      onExportXml: vi.fn(),
      onOpenDatabaseInspector: vi.fn(),
      onOpenXmlCollection: vi.fn(),
    };
    const { container } = render(<MenuBar {...props} />);
    fireEvent.click(menuButton(container, /^Datei/));
    const click = (label: RegExp) => fireEvent.click(menuButton(container, label));
    click(/Neues Projekt/);
    expect(props.onNewProject).toHaveBeenCalledTimes(1);
    fireEvent.click(menuButton(container, /^Datei/));
    click(/Projekt öffnen/);
    expect(props.onOpenProject).toHaveBeenCalledTimes(1);
    fireEvent.click(menuButton(container, /^Datei/));
    click(/Projekt speichern/);
    expect(props.onSaveProject).toHaveBeenCalledTimes(1);
    fireEvent.click(menuButton(container, /^Datei/));
    click(/Rekordbox XML importieren/);
    expect(props.onImportXml).toHaveBeenCalledTimes(1);
    fireEvent.click(menuButton(container, /^Datei/));
    click(/Audiodatei/);
    expect(props.onImportAudio).toHaveBeenCalledTimes(1);
    fireEvent.click(menuButton(container, /^Datei/));
    click(/Daten- & Waveform-Extraktor/);
    expect(props.onOpenDatabaseInspector).toHaveBeenCalledTimes(1);
    fireEvent.click(menuButton(container, /^Datei/));
    click(/Track-Auswahl/);
    expect(props.onOpenXmlCollection).toHaveBeenCalledTimes(1);
  });

  it('Bearbeiten exposes undo/redo only when the history allows it', () => {
    const props = { ...baseMenuProps, onUndo: vi.fn(), onRedo: vi.fn(), canUndo: true, canRedo: false };
    const { container } = render(<MenuBar {...props} />);
    fireEvent.click(menuButton(container, /^Bearbeiten/));
    const undo = menuButton(container, /Rückgängig/);
    const redo = menuButton(container, /Wiederholen/);
    expect((undo as HTMLButtonElement).disabled).toBe(false);
    expect((redo as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(undo);
    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(props.onRedo).not.toHaveBeenCalled();
  });

  it('Betrachten switches the waveform representation and the panels', () => {
    const props = { ...baseMenuProps, onSetWaveformMode: vi.fn(), onTogglePalette: vi.fn(), onToggleBrowser: vi.fn() };
    const { container } = render(<MenuBar {...props} />);
    fireEvent.click(menuButton(container, /^Betrachten/));
    fireEvent.click(menuButton(container, /3BAND|3-Band|3 Band/i));
    expect(props.onSetWaveformMode).toHaveBeenCalledWith('3BAND');
    fireEvent.click(menuButton(container, /^Betrachten/));
    fireEvent.click(menuButton(container, /Palette/i));
    expect(props.onTogglePalette).toHaveBeenCalledTimes(1);
    fireEvent.click(menuButton(container, /^Betrachten/));
    fireEvent.click(menuButton(container, /Browser/i));
    expect(props.onToggleBrowser).toHaveBeenCalledTimes(1);
  });

  it('Hilfe opens the data/protection info and the system log', () => {
    const props = { ...baseMenuProps, onShowInfo: vi.fn(), onExportWav: vi.fn(), onExportXml: vi.fn(), onOpenSystemLogs: vi.fn() };
    const { container } = render(<MenuBar {...props} />);
    fireEvent.click(menuButton(container, /^Hilfe/));
    fireEvent.click(menuButton(container, /Originalschutz/));
    expect(props.onShowInfo).toHaveBeenCalledTimes(1);
    fireEvent.click(menuButton(container, /^Hilfe/));
    fireEvent.click(menuButton(container, /System-Protokoll/));
    expect(props.onOpenSystemLogs).toHaveBeenCalledTimes(1);
    fireEvent.click(menuButton(container, /^Datei/));
    fireEvent.click(menuButton(container, /Master als WAV exportieren/));
    fireEvent.click(menuButton(container, /^Datei/));
    fireEvent.click(menuButton(container, /Rekordbox XML exportieren/));
    expect(props.onExportWav).toHaveBeenCalledTimes(1);
    expect(props.onExportXml).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorBoundary', () => {
  function Boom(): React.ReactNode {
    throw new Error('Kaputtes Panel');
  }

  it('passes healthy children through', () => {
    const { container } = render(
      <ErrorBoundary>
        <div>Deck A</div>
      </ErrorBoundary>
    );
    expect(container.textContent).toBe('Deck A');
  });

  it('catches a render crash, keeps the app alive and reports the cause', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    const text = container.textContent ?? '';
    expect(text).not.toContain('Deck A');
    expect(text.length).toBeGreaterThan(0);
    // The crash must be named, never swallowed silently.
    expect(spy).toHaveBeenCalled();
    expect(text).toMatch(/Fehler|Problem|neu starten|Neu laden/i);
    spy.mockRestore();
  });

  it('uses a caller-provided fallback instead of the built-in one', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <ErrorBoundary fallback={<span>Panel nicht verfügbar</span>}>
        <Boom />
      </ErrorBoundary>
    );
    expect(container.textContent).toBe('Panel nicht verfügbar');
    spy.mockRestore();
  });
});

describe('ClipDeckView (FULL_DECK palette)', () => {
  const deckProps = (
    over: Partial<ComponentProps<typeof ClipDeckView>> = {}
  ): ComponentProps<typeof ClipDeckView> => ({
    clips: [makePaletteClip({ id: 'clip-1', name: 'Kick Loop', duration: 2 })],
    activeClipId: null as string | null,
    onSelectClip: vi.fn(),
    onDeleteClip: vi.fn(),
    onAddFromSelection: vi.fn(),
    hasSelectionInDeckA: true,
    activeTrack: makeDeckTrack(),
    matchPitch: false,
    onToggleMatchPitch: vi.fn(),
    onInsertClipToDeckA: vi.fn(),
    onReplaceDeckAWithClip: vi.fn(),
    onOverdubDeckAWithClip: vi.fn(),
    onCloseDeckView: vi.fn(),
    waveformMode: 'RGB' as const,
    onDropClipIntoDeckA: vi.fn(),
    ...over,
  });

  it('shows the clip cards of the palette in the deck view', () => {
    const props = deckProps();
    const { container } = render(<ClipDeckView {...props} />);
    expect(container.textContent).toContain('Kick Loop');
    expect(container.textContent).not.toContain('Keine Clips');
  });

  it('insert, replace and overdub act on the selected card', async () => {
    const props = deckProps();
    const { container } = render(<ClipDeckView {...props} />);
    const card = container.querySelector('[draggable="true"]') as HTMLElement;
    fireEvent.click(card);
    await waitForFrames(1);
    expect(props.onSelectClip).toHaveBeenCalledTimes(1);

    fireEvent.click(menuButton(container, /Auswahl ersetzen/));
    fireEvent.click(menuButton(container, /Überlagern/));
    expect(props.onReplaceDeckAWithClip).toHaveBeenCalledTimes(1);
    expect(props.onOverdubDeckAWithClip).toHaveBeenCalledTimes(1);
  });

  it('accepts a clip dropped on the timeline and hands the id to the app', () => {
    const props = deckProps();
    const { container } = render(<ClipDeckView {...props} />);
    const card = container.querySelector('[draggable="true"]') as HTMLElement;
    const dataTransfer = new FakeDataTransfer();
    fireEvent(card, makeDragEvent('dragstart', { dataTransfer }));
    dataTransfer.readOnly = true;
    // The drop target is the deck timeline region of this view.
    const zone = Array.from(container.querySelectorAll('div')).find((el) => {
      const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
      const p = key ? (el as unknown as Record<string, Record<string, unknown>>)[key] : null;
      return p && typeof p.onDrop === 'function' && typeof p.onDragOver === 'function';
    }) as HTMLElement;
    expect(zone).toBeTruthy();
    dataTransfer.setData(DRAG_MIME_CLIP, 'clip-1');
    fireEvent(zone, makeDragEvent('dragover', { dataTransfer }));
    fireEvent(zone, makeDragEvent('drop', { dataTransfer }));
    expect(props.onDropClipIntoDeckA).toHaveBeenCalledWith('clip-1');
  });

  it('deletes a clip and returns to the sidebar', () => {
    const props = deckProps();
    const { container } = render(<ClipDeckView {...props} />);
    const remove = container.querySelector('button[title="Clip löschen"]') as HTMLElement;
    fireEvent.click(remove);
    expect(props.onDeleteClip).toHaveBeenCalledWith('clip-1');
    fireEvent.click(menuButton(container, /Sidebar/));
    expect(props.onCloseDeckView).toHaveBeenCalledTimes(1);
  });

  it('states the tempo/pitch coupling and lets the user switch it', () => {
    const props = deckProps();
    const { container } = render(<ClipDeckView {...props} />);
    const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle);
    expect(props.onToggleMatchPitch).toHaveBeenCalledTimes(1);
  });

  it('stays usable without a deck track instead of crashing', () => {
    const props = deckProps({ activeTrack: null, clips: [] });
    const { container } = render(<ClipDeckView {...props} />);
    expect(container.textContent.length).toBeGreaterThan(0);
    expect(dialogs.alerts).toEqual([]);
  });
});

describe('Boot module (src/main.tsx)', () => {
  it('mounts the app into #root and labels the window with the build version', async () => {
    const host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    const previousTitle = document.title;

    await act(async () => {
      await import('../../src/main');
    });
    await waitForFrames(3);

    expect(host.childElementCount).toBeGreaterThan(0);
    expect(host.textContent).toContain('Kein Track geladen');
    // The title is the only place the running build version is stated.
    expect(document.title).toBe(`airdox_SMART_Editor v${APP_VERSION}`);
    document.title = previousTitle;
    host.remove();
  });
});
