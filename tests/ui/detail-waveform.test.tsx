/**
 * Component tests: Deck-Ansicht (DetailWaveform) as the central drop target.
 *
 * What is asserted here is the visible half of the drag & drop contract: the drop
 * position the timeline reports, the mode the modifiers select, the ghost that
 * promises exactly the window the edit will address, the honest empty state, and
 * the block-move on the edit strip.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { DetailWaveform } from '../../src/components/DetailWaveform';
import { DRAG_MIME_CLIP, DRAG_MIME_SELECTION, DRAG_MIME_TRACK } from '../../src/dnd/dragPayload';
import { ProjectedSpanView } from '../../src/edit/editModel';
import { TrackModel, SelectionRange } from '../../src/types/rekordbox';
import { FakeDataTransfer, makeDragEvent, makePointerEvent, timeToClientX } from '../helpers/domEvents';
import { canvasCallLog, waitForFrames, waitUntilDrawn } from '../setup/ui';
import { DECK_BPM, DECK_SECONDS, drawnTexts, makeDeckTrack } from '../helpers/trackFixtures';

const VIEW_DURATION = DECK_SECONDS;

interface Harness {
  container: HTMLElement;
  canvas: HTMLElement;
  calls: {
    dropClip: ReturnType<typeof vi.fn>;
    dropTrack: ReturnType<typeof vi.fn>;
    moveSpan: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    addToPalette: ReturnType<typeof vi.fn>;
    seek: ReturnType<typeof vi.fn>;
    dropFile: ReturnType<typeof vi.fn>;
  };
}

function renderDeck(opts: {
  track?: TrackModel | null;
  spans?: ProjectedSpanView[];
  quantize?: boolean;
  selection?: SelectionRange | null;
} = {}): Harness {
  const calls = {
    dropClip: vi.fn(),
    dropTrack: vi.fn(),
    moveSpan: vi.fn(),
    select: vi.fn(),
    addToPalette: vi.fn(),
    seek: vi.fn(),
    dropFile: vi.fn(),
  };
  const track = opts.track === undefined ? makeDeckTrack() : opts.track;
  const { container } = render(
    <DetailWaveform
      track={track}
      currentTime={0}
      viewOffset={0}
      viewDuration={VIEW_DURATION}
      waveformMode="BLUE"
      selection={opts.selection ?? null}
      quantize={opts.quantize ?? true}
      onSeek={calls.seek}
      onSelect={calls.select}
      onZoomIn={() => {}}
      onZoomOut={() => {}}
      onResetZoom={() => {}}
      onPanView={() => {}}
      onAddToPalette={calls.addToPalette}
      onCopy={() => {}}
      onCut={() => {}}
      onPaste={() => {}}
      onInsert={() => {}}
      onReplace={() => {}}
      onOverdub={() => {}}
      onDelete={() => {}}
      onClear={() => {}}
      onAddCue={() => {}}
      onDropFile={calls.dropFile}
      onDropClip={calls.dropClip}
      onDropTrack={calls.dropTrack}
      onMoveSpan={calls.moveSpan}
      clipInfo={(id) => (id === 'clip-1' ? { name: 'Kick Loop', duration: 2 } : null)}
      spans={opts.spans}
    />
  );
  const canvas = container.querySelector('canvas') as HTMLElement;
  return { container, canvas, calls };
}

const x = (time: number) => timeToClientX(time, 0, VIEW_DURATION);

function dropClip(harness: Harness, time: number, modifiers: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = {}) {
  const dataTransfer = new FakeDataTransfer({ data: { [DRAG_MIME_CLIP]: 'clip-1' } });
  // dragover with the payload hidden (what browsers do), then the real drop.
  dataTransfer.readOnly = true;
  fireEvent(harness.canvas.parentElement as HTMLElement, makeDragEvent('dragover', { dataTransfer, x: x(time), ...modifiers }));
  dataTransfer.readOnly = false;
  fireEvent(
    harness.canvas.parentElement as HTMLElement,
    makeDragEvent('drop', { dataTransfer, x: x(time), ...modifiers })
  );
}

afterEach(() => {
  cleanup();
});

describe('DetailWaveform — clip drop', () => {
  it('reports the snapped drop position and the insert mode', async () => {
    const harness = renderDeck({ quantize: true });
    await waitForFrames();
    // 1.2 s is not on the grid; the nearest imported beat node is 1.0 s (0.5 s spacing).
    dropClip(harness, 1.2);
    expect(harness.calls.dropClip).toHaveBeenCalledTimes(1);
    const [clipId, start, mode, windowEnd] = harness.calls.dropClip.mock.calls[0];
    expect(clipId).toBe('clip-1');
    expect(start).toBeCloseTo(1.0, 6);
    expect(mode).toBe('insert');
    expect(windowEnd).toBeUndefined();
  });

  it('drops exactly at the pointer when quantize is off', async () => {
    const harness = renderDeck({ quantize: false });
    await waitForFrames();
    dropClip(harness, 1.2);
    const [, start] = harness.calls.dropClip.mock.calls[0];
    expect(start).toBeCloseTo(1.2, 4);
  });

  it('switches to replace on Shift and to overdub on Alt', async () => {
    const harness = renderDeck();
    await waitForFrames();
    dropClip(harness, 4, { shiftKey: true });
    // A replace without an explicit range addresses exactly the clip length — the
    // window is therefore derived by the planner, not passed in.
    expect(harness.calls.dropClip).toHaveBeenLastCalledWith('clip-1', 4, 'replace', undefined);
    dropClip(harness, 4, { ctrlKey: true });
    expect(harness.calls.dropClip).toHaveBeenLastCalledWith('clip-1', 4, 'replace', undefined);
    dropClip(harness, 4, { altKey: true });
    const [, overdubStart, mode, windowEnd] = harness.calls.dropClip.mock.calls[2];
    expect(overdubStart).toBeCloseTo(4, 6);
    expect(mode).toBe('overdub');
    expect(windowEnd).toBeCloseTo(6, 6);
  });

  it('overdubs the current selection window when one exists', async () => {
    const harness = renderDeck({
      selection: {
        start: 2,
        end: 5,
        startBeat: 4,
        endBeat: 10,
        beatsCount: 6,
        barsCount: 1.5,
        duration: 3,
      },
    });
    await waitForFrames();
    dropClip(harness, 2, { altKey: true });
    const [, , mode, windowEnd] = harness.calls.dropClip.mock.calls[0];
    expect(mode).toBe('overdub');
    expect(windowEnd).toBeCloseTo(5, 6);
  });

  it('draws the drop ghost with the window and mode it promises', async () => {
    const harness = renderDeck();
    const canvas = harness.container.querySelector('canvas') as HTMLCanvasElement;
    await waitForFrames();
    const log = canvasCallLog(canvas);
    const before = (log?.calls.length ?? 0);
    const dataTransfer = new FakeDataTransfer({ data: { [DRAG_MIME_CLIP]: 'clip-1' } });
    fireEvent(
      harness.canvas.parentElement as HTMLElement,
      makeDragEvent('dragover', { dataTransfer, x: x(3) })
    );
    const drawn = await waitUntilDrawn(() => drawnTexts(log).some((t) => t.includes('INSERT')));
    expect(drawn).toBe(true);
    const texts = drawnTexts(log).slice(0);
    // The canvas labels the footprint with the mode; the DOM banner promises the
    // consequence in words — both must describe the SAME window.
    expect(texts.some((t) => t.includes('INSERT'))).toBe(true);
    expect(texts.some((t) => t.includes('Kick Loop'))).toBe(true);
    expect(harness.container.textContent).toContain('BEI 3.00 s EINFÜGEN');
    expect((log?.calls.length ?? 0)).toBeGreaterThan(before);
    // and it disappears again once the drag leaves
    fireEvent(harness.canvas.parentElement as HTMLElement, makeDragEvent('dragleave', { dataTransfer }));
    await waitForFrames();
    expect(harness.container.textContent).not.toContain('Clip-Drop braucht');
  });

  it('explains instead of silently ignoring a clip drop with an empty deck', async () => {
    const harness = renderDeck({ track: null });
    await waitForFrames();
    const dataTransfer = new FakeDataTransfer({ data: { [DRAG_MIME_CLIP]: 'clip-1' } });
    const host = harness.canvas.parentElement as HTMLElement;
    fireEvent(host, makeDragEvent('dragover', { dataTransfer, x: 200 }));
    expect(dataTransfer.dropEffect).toBe('none');
    expect(harness.container.textContent).toContain('Clip-Drop braucht einen geladenen Deck-Track');
    fireEvent(host, makeDragEvent('drop', { dataTransfer, x: 200 }));
    expect(harness.calls.dropClip).not.toHaveBeenCalled();
  });
});

describe('DetailWaveform — other drop kinds', () => {
  it('loads a track dropped from the collection/browser', () => {
    const harness = renderDeck({ track: null });
    const host = harness.canvas.parentElement as HTMLElement;
    const dataTransfer = new FakeDataTransfer({ data: { [DRAG_MIME_TRACK]: 'other-track' } });
    fireEvent(host, makeDragEvent('dragover', { dataTransfer }));
    expect(dataTransfer.dropEffect).toBe('link');
    fireEvent(host, makeDragEvent('drop', { dataTransfer }));
    expect(harness.calls.dropTrack).toHaveBeenCalledWith('other-track');
  });

  it('imports a dropped audio file and never mistakes it for a clip', () => {
    const harness = renderDeck();
    const host = harness.canvas.parentElement as HTMLElement;
    const file = new File([new Uint8Array(8)], 'song.wav', { type: 'audio/wav' });
    const dataTransfer = new FakeDataTransfer({ files: [{ name: file.name, type: file.type }] });
    fireEvent(host, makeDragEvent('dragover', { dataTransfer }));
    expect(dataTransfer.dropEffect).toBe('copy');
    fireEvent(host, makeDragEvent('drop', { dataTransfer }));
    expect(harness.calls.dropFile).toHaveBeenCalledTimes(1);
    expect(harness.calls.dropClip).not.toHaveBeenCalled();
  });

  it('ignores a selection drag over the deck (the palette owns it)', () => {
    const harness = renderDeck();
    const host = harness.canvas.parentElement as HTMLElement;
    const dataTransfer = new FakeDataTransfer({ data: { [DRAG_MIME_SELECTION]: JSON.stringify({ start: 1, end: 2 }) } });
    fireEvent(host, makeDragEvent('dragover', { dataTransfer }));
    expect(dataTransfer.dropEffect).toBe('copy');
    fireEvent(host, makeDragEvent('drop', { dataTransfer }));
    expect(harness.calls.dropClip).not.toHaveBeenCalled();
    expect(harness.calls.dropTrack).not.toHaveBeenCalled();
    expect(harness.calls.dropFile).not.toHaveBeenCalled();
  });
});

describe('DetailWaveform — edit strip and block move', () => {
  const span: ProjectedSpanView = {
    id: 'span-1',
    segmentId: 'insert-1',
    clipId: 'clip-1',
    kind: 'clip',
    start: 5,
    duration: 2,
    label: 'Kick Loop',
    color: '#00a2ff',
    movable: true,
    note: 'Tempo unverändert · Quelle: Clip Quelle',
  };

  it('labels the projected block and shows the move affordance', async () => {
    const harness = renderDeck({ spans: [span] });
    const canvas = harness.container.querySelector('canvas') as HTMLCanvasElement;
    const drawn = await waitUntilDrawn(() => (canvasCallLog(canvas)?.calls.length ?? 0) > 0);
    expect(drawn).toBe(true);
    const texts = drawnTexts(canvasCallLog(canvas));
    expect(texts).toContain('Kick Loop');
    expect(texts.some((t) => t.includes('ziehen = verschieben'))).toBe(true);
    expect(canvasCallLog(canvas)?.ops.has('fillRect')).toBe(true);
  });

  it('moves a block to the snapped target on drag', async () => {
    const harness = renderDeck({ spans: [span] });
    await waitForFrames();
    const canvas = harness.canvas;
    const rect = { height: 320 };
    const stripY = rect.height - 8; // inside the 16 px edit strip
    fireEvent(canvas, makePointerEvent('mousedown', x(5.5), stripY));
    fireEvent(canvas, makePointerEvent('mousemove', x(7.3), stripY));
    await waitForFrames();
    fireEvent(window, new MouseEvent('mouseup', { bubbles: true }));
    expect(harness.calls.moveSpan).toHaveBeenCalledTimes(1);
    const [segmentId, newStart] = harness.calls.moveSpan.mock.calls[0];
    expect(segmentId).toBe('insert-1');
    // The grab offset (0.5 s into the block) is preserved, then snapped: 7.3 − 0.5 → 7.0
    expect(newStart).toBeCloseTo(7.0, 6);
  });

  it('treats a click without movement as no move at all', async () => {
    const harness = renderDeck({ spans: [span] });
    await waitForFrames();
    const canvas = harness.canvas;
    fireEvent(canvas, makePointerEvent('mousedown', x(5.5), 312));
    fireEvent(window, new MouseEvent('mouseup', { bubbles: true }));
    expect(harness.calls.moveSpan).not.toHaveBeenCalled();
  });

  it('does not offer a move for a silenced block', async () => {
    const harness = renderDeck({ spans: [{ ...span, kind: 'silence', movable: false, label: 'Stumm' }] });
    await waitForFrames();
    fireEvent(harness.canvas, makePointerEvent('mousedown', x(5.5), 312));
    fireEvent(window, new MouseEvent('mouseup', { bubbles: true }));
    expect(harness.calls.moveSpan).not.toHaveBeenCalled();
    // a mousedown in the strip must not start a selection either
    expect(harness.calls.select).not.toHaveBeenCalled();
    expect(harness.calls.seek).toHaveBeenCalled();
  });
});

describe('DetailWaveform — selection, provenance and honesty', () => {
  it('selects a range by dragging on the waveform', async () => {
    const harness = renderDeck();
    await waitForFrames();
    fireEvent(harness.canvas, makePointerEvent('mousedown', x(2), 120));
    fireEvent(harness.canvas, makePointerEvent('mousemove', x(4), 120));
    fireEvent(harness.canvas, makePointerEvent('mouseup', x(4), 120));
    expect(harness.calls.select).toHaveBeenCalled();
    const last = harness.calls.select.mock.calls.at(-1)?.[0];
    expect(last.start).toBeCloseTo(2, 4);
    expect(last.end).toBeCloseTo(4, 4);
    expect(last.duration).toBeCloseTo(2, 4);
  });

  it('offers the selection as a palette drag with the exact window', async () => {
    const harness = renderDeck({
      selection: { start: 1.5, end: 3.25, startBeat: 3, endBeat: 6.5, beatsCount: 3.5, barsCount: 0.875, duration: 1.75 },
    });
    await waitForFrames();
    const chip = Array.from(harness.container.querySelectorAll('[draggable="true"]')).at(-1) as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('1.75 s → PALETTE');
    const dataTransfer = new FakeDataTransfer();
    fireEvent(chip, makeDragEvent('dragstart', { dataTransfer }));
    expect(JSON.parse(dataTransfer.getData(DRAG_MIME_SELECTION))).toEqual({ start: 1.5, end: 3.25 });
    fireEvent.click(chip);
    expect(harness.calls.addToPalette).toHaveBeenCalledWith(1.5, 3.25);
  });

  it('renders nothing but a hint when the deck has no ANLZ data', async () => {
    const harness = renderDeck({ track: makeDeckTrack({ withAnalysis: false }) });
    const canvas = harness.container.querySelector('canvas') as HTMLCanvasElement;
    await waitForFrames(3);
    const texts = drawnTexts(canvasCallLog(canvas));
    expect(texts.some((t) => t.includes('KEINE WAVEFORM-DATEN'))).toBe(true);
    expect(harness.container.textContent).toContain('MISSING_REKORDBOX_ANALYSIS');
    // The footer states the missing analysis instead of a fake contour.
    expect(harness.container.textContent).toContain('KEINE WAVEFORM');
  });

  it('states the per-column provenance of an edited composite', async () => {
    const track = makeDeckTrack();
    track.editInfo = {
      spans: 3,
      structuralEdits: 1,
      overlays: 0,
      columns: 120,
      verbatimColumns: 50,
      retimedColumns: 50,
      clipColumns: 20,
      computedColumns: 0,
      mixColumns: 0,
      silenceColumns: 0,
      missingColumns: 0,
      bucketSeconds: 0.1,
      isIdentity: false,
      sourceTags: ['PWV5'],
    };
    const harness = renderDeck({ track });
    await waitForFrames();
    expect(harness.container.textContent).toContain('EDIT-WAVEFORM 120/120 AUS ANLZ');
    expect(harness.container.textContent).toContain('KEINE NEUANALYSE');
  });

  it('reports computed columns as soon as new material needs them', async () => {
    const track = makeDeckTrack();
    track.editInfo = {
      spans: 3,
      structuralEdits: 1,
      overlays: 0,
      columns: 120,
      verbatimColumns: 40,
      retimedColumns: 40,
      clipColumns: 0,
      computedColumns: 40,
      mixColumns: 0,
      silenceColumns: 0,
      missingColumns: 0,
      bucketSeconds: 0.1,
      isIdentity: false,
      sourceTags: ['PWV5'],
    };
    const harness = renderDeck({ track });
    await waitForFrames();
    expect(harness.container.textContent).toContain('80/120 AUS ANLZ · 40 BERECHNET');
    expect(harness.container.textContent).not.toContain('KEINE NEUANALYSE');
  });

  it('keeps drawing every waveform column even at a zoomed view', async () => {
    const harness = renderDeck();
    const canvas = harness.container.querySelector('canvas') as HTMLCanvasElement;
    fireEvent(harness.canvas, makePointerEvent('mousemove', x(3.2), 100));
    await waitUntilDrawn(() => canvasCallLog(canvas)?.ops.has('setLineDash') === true);
    const ops = canvasCallLog(canvas)?.ops;
    expect(ops?.has('fillRect')).toBe(true);
    expect(ops?.has('fillText')).toBe(true);
    expect(ops?.has('strokeRect')).toBe(true);
    // The hover guide snaps to the beat grid and is drawn dashed.
    expect(ops?.has('setLineDash')).toBe(true);
    // The BPM badge and the cue counts are real DOM, not canvas guesses.
    expect(harness.container.textContent).toContain(DECK_BPM.toFixed(2));
    expect(harness.container.textContent).toContain('2 MEM');
    expect(harness.container.textContent).toContain('2 CUES');
  });
});
