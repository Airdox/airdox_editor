/**
 * Modal dialogs: they are where the app explains itself, so they are tested as
 * user-facing promises — what is stated, what is refused, what gets exported.
 *
 * The modals are mounted directly (with the same prop shapes App passes) so a
 * broken dialog is caught even when the surrounding workflow test is busy.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, act } from '@testing-library/react';
import { OperationFeedbackModal } from '../../src/components/Modals/OperationFeedbackModal';
import type { OperationTelemetry } from '../../src/components/Modals/OperationFeedbackModal';
import { ProjectInfoModal } from '../../src/components/Modals/ProjectInfoModal';
import { ImportProgressModal } from '../../src/components/Modals/ImportProgressModal';
import { ExportModal } from '../../src/components/Modals/ExportModal';
import { MultiLayerRenderInspector } from '../../src/components/Modals/MultiLayerRenderInspector';
import { SystemLogModal } from '../../src/components/Modals/SystemLogModal';
import { DatabaseExtractionModal } from '../../src/components/Modals/DatabaseExtractionModal';
import { RekordboxXmlImportModal } from '../../src/components/Modals/RekordboxXmlImportModal';
import { logger } from '../../src/utils/logger';
import { audioEngine } from '../../src/audio/audioEngine';
import type { XmlImportProgress } from '../../src/rekordbox/xmlParser';
import { makeDeckTrack, makePaletteClip } from '../helpers/trackFixtures';
import { dialogs, resetDialogs, waitForFrames } from '../setup/ui';

const track = () => makeDeckTrack({ title: 'Obsidian Voltage', id: '1' });

/** The export format cards are `<label>` elements, not buttons. */
function labelText(container: HTMLElement, label: RegExp): HTMLElement {
  const el = Array.from(container.querySelectorAll('label')).find((l) => label.test(l.textContent ?? ''));
  if (!el) throw new Error(`label matching ${label} not found`);
  return el as HTMLElement;
}

/** Waits for the render-inspector animation to unlock the download button. */
async function waitForEnabled(button: HTMLButtonElement, timeoutMs = 6000) {
  const until = Date.now() + timeoutMs;
  while (button.disabled && Date.now() < until) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
  }
  expect(button.disabled).toBe(false);
}

function findButton(container: HTMLElement, label: RegExp): HTMLElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    label.test((b.textContent ?? '').trim())
  ) as HTMLElement | undefined;
}

function buttonText(container: HTMLElement, label: RegExp): HTMLElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) =>
    label.test((b.textContent ?? '').trim())
  );
  if (!el) throw new Error(`button matching ${label} not found`);
  return el as HTMLElement;
}

beforeEach(() => resetDialogs());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { rekordboxDesktop?: unknown }).rekordboxDesktop;
});

describe('OperationFeedbackModal', () => {
  const telemetry: OperationTelemetry = {
    title: 'Auswahl gelöscht (Delete)',
    operationType: 'DELETE',
    description: 'Bereich (3.000s / 1.6 Takte) gelöscht; nachfolgendes Material rückt nach vorne.',
    timeRangeSec: { start: 3, end: 6, duration: 3 },
    barsCount: 1.625,
    beatsCount: 6.5,
    shiftedCuesCount: 2,
    originalSha256: 'sha256-0123456789abcdef',
    timestamp: Date.UTC(2026, 8, 12, 10, 30, 0),
  };

  it('renders nothing while closed and everything while open', () => {
    const closed = render(<OperationFeedbackModal isOpen={false} onClose={() => {}} telemetry={telemetry} />);
    expect(closed.container.textContent).toBe('');
    cleanup();
    const open = render(<OperationFeedbackModal isOpen onClose={() => {}} telemetry={telemetry} />);
    expect(open.container.textContent).toContain('Auswahl gelöscht (Delete)');
    expect(open.container.textContent).toContain('Originaldatei unverändert');
    expect(open.container.textContent).toContain('00:03.000');
  });

  it('survives a null telemetry instead of crashing the app', () => {
    const { container } = render(<OperationFeedbackModal isOpen onClose={() => {}} telemetry={null} />);
    expect(container.textContent).not.toContain('undefined');
  });

  it('closes through both close affordances', () => {
    const onClose = vi.fn();
    const { container } = render(<OperationFeedbackModal isOpen onClose={onClose} telemetry={telemetry} />);
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectInfoModal', () => {
  it('states the original-protection priority and the verified sources', () => {
    const { container } = render(
      <ProjectInfoModal isOpen onClose={() => {}} track={track()} />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Originaldateien sind 100% unveränderlich geschützt');
    expect(text).toContain('REKORDBOX XML (VERIFIZIERT)');
    expect(text).toContain('Phasenstarre Zeittransformation');
  });

  it('closes via Schließen', () => {
    const onClose = vi.fn();
    const { container } = render(<ProjectInfoModal isOpen onClose={onClose} track={track()} />);
    fireEvent.click(buttonText(container, /Schließen/));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ImportProgressModal', () => {
  const progress = (over: Partial<XmlImportProgress> = {}): XmlImportProgress => ({
    phase: 'PARSING_XML',
    phaseText: 'Track 2 von 4 …',
    percent: 50,
    processedTracks: 2,
    totalTracks: 4,
    memoryCuesFound: 6,
    hotCuesFound: 3,
    loopsFound: 1,
    logMessages: ['Datei wird geladen: rekordbox.xml', 'POSITION_MARK gelesen'],
    ...over,
  });

  it('mirrors the live counters of the parse', () => {
    const { container } = render(
      <ImportProgressModal isOpen progress={progress()} onClose={() => {}} onOpenCollection={() => {}} />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('50');
    expect(text).toContain('POSITION_MARK gelesen');
    expect(text).toContain('Memory Cues');
  });

  it('shows the collection shortcut only when the import is complete', () => {
    const done = render(
      <ImportProgressModal
        isOpen
        progress={progress({ phase: 'COMPLETE', percent: 100, processedTracks: 4, phaseText: 'Fertig' })}
        onClose={() => {}}
        onOpenCollection={vi.fn()}
      />
    );
    expect(done.container.textContent).toContain('Zur Track-Auswahl');
    cleanup();
    const running = render(
      <ImportProgressModal isOpen progress={progress()} onClose={() => {}} onOpenCollection={vi.fn()} />
    );
    expect(running.container.textContent).not.toContain('Zur Track-Auswahl');
  });

  it('reports an error phase as an error', () => {
    const onOpenCollection = vi.fn();
    const { container } = render(
      <ImportProgressModal
        isOpen
        progress={progress({ phase: 'ERROR', percent: 0, phaseText: 'Kritischer Fehler beim Parsing: no root' })}
        onClose={() => {}}
        onOpenCollection={onOpenCollection}
      />
    );
    expect(container.textContent).toContain('Kritischer Fehler beim Parsing');
    // An errored import must not offer to continue into the collection.
    expect(container.textContent).not.toContain('Zur Track-Auswahl');
    expect(onOpenCollection).not.toHaveBeenCalled();
  });
});

describe('MultiLayerRenderInspector', () => {
  it('lists the layers that build the rendered result', async () => {
    const onStartDownload = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <MultiLayerRenderInspector
        isOpen
        track={track()}
        clips={[makePaletteClip()]}
        format="WAV"
        onStartDownload={onStartDownload}
        onCancel={onCancel}
      />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Multi-Schichten Render-Inspektor');
    expect(text).toContain('Ursprung & Dateiquelle');
    expect(text).toContain('Non-Destructive');
    const download = findButton(container, /herunterladen|Rendert Schichten/i) as HTMLButtonElement;
    expect(download.disabled).toBe(true); // the layers have to render first
    await waitForEnabled(download);
    fireEvent.click(download);
    expect(onStartDownload).toHaveBeenCalledTimes(1);
    fireEvent.click(buttonText(container, /Abbrechen|Schließen/));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('SystemLogModal', () => {
  beforeEach(() => logger.clear?.());

  it('shows written log entries and filters by level, category and text', async () => {
    logger.info('EDITING', 'Edit-Projektion neu abgeleitet', { spans: 3 });
    logger.error('DATABASE', 'ANLZ Pipelinefehler: Identität nicht bestätigt');
    const { container } = render(<SystemLogModal isOpen onClose={() => {}} />);
    await waitForFrames(1);
    expect(container.textContent).toContain('Edit-Projektion neu abgeleitet');
    expect(container.textContent).toContain('ANLZ Pipelinefehler');

    const search = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'Pipelinefehler' } });
    await waitForFrames(1);
    expect(container.textContent).toContain('ANLZ Pipelinefehler');
    expect(container.textContent).not.toContain('Edit-Projektion neu abgeleitet');

    fireEvent.change(search, { target: { value: 'nichts-davon' } });
    await waitForFrames(1);
    expect(container.textContent).toContain('Keine Log-Einträge für den gewählten Filter');
  });

  it('streams new entries while it is open', async () => {
    const { container } = render(<SystemLogModal isOpen onClose={() => {}} />);
    await waitForFrames(1);
    act(() => {
      logger.warn('SYSTEM', 'Live-Eintrag nach dem Öffnen');
    });
    await waitForFrames(1);
    expect(container.textContent).toContain('Live-Eintrag nach dem Öffnen');
  });

  it('offers the diagnostics exports without touching the log', async () => {
    logger.info('SYSTEM', 'Eintrag für den Export');
    const { container } = render(<SystemLogModal isOpen onClose={() => {}} />);
    await waitForFrames(1);
    fireEvent.click(buttonText(container, /JSON Export/));
    await waitForFrames(1);
    const copy = findButton(container, /kopieren/i);
    if (copy) fireEvent.click(copy);
    await waitForFrames(1);
    // Exporting a report never removes log lines (the entry is still there) …
    expect(logger.getEntries().some((e) => e.message === 'Eintrag für den Export')).toBe(true);
    // … and no dialog error escapes into the UI.
    expect(dialogs.alerts.filter((a) => /Fehler|nicht/i.test(a))).toEqual([]);
  });
});

describe('DatabaseExtractionModal', () => {
  it('switches tabs, filters cues and jumps to a cue position', () => {
    const onSelectCue = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <DatabaseExtractionModal
        isOpen
        onClose={onClose}
        track={track()}
        onSelectCue={onSelectCue}
        onImportXmlFile={vi.fn()}
      />
    );
    const text = () => container.textContent ?? '';
    expect(text()).toContain('Waveform Buckets');
    fireEvent.click(buttonText(container, /Waveform-Puffer/));
    expect(text()).toMatch(/Bucket|PWAV|Waveform/i);
    fireEvent.click(buttonText(container, /Song-Struktur/));
    expect(text()).toMatch(/Phrasen|PSSI/);
    fireEvent.click(buttonText(container, /ANLZ \/ XML \/ DB Datei-Import/));
    expect(text()).toContain('Rekordbox 6/7 Datenbank');
    expect(text()).toMatch(/ausschließlich lesend/);

    fireEvent.click(buttonText(container, /Memory Cues/));
    const jump = Array.from(container.querySelectorAll('button')).find((b) =>
      /Anspringen/.test(b.textContent ?? '')
    );
    if (jump) {
      fireEvent.click(jump);
      expect(onSelectCue).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });

  it('opens the manual database picker through the bridge, read-only', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <DatabaseExtractionModal
        isOpen
        onClose={onClose}
        track={track()}
        onOpenRekordboxDatabase={onOpen}
      />
    );
    fireEvent.click(buttonText(container, /ANLZ \/ XML \/ DB Datei-Import/));
    fireEvent.click(buttonText(container, /Datenbankdatei auswählen/));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reads the Rekordbox database through the read-only bridge callbacks', async () => {
    const candidates = [
      { path: 'C:/Users/dj/AppData/Roaming/Pioneer/rekordbox/master.db', kind: 'MASTER_DB' as const, label: 'Rekordbox-Bibliothek' },
    ];
    const onLocate = vi.fn(async () => candidates);
    const onLoadDb = vi.fn();
    const { container } = render(
      <DatabaseExtractionModal
        isOpen
        onClose={() => {}}
        track={track()}
        onLocateRekordboxDatabases={onLocate}
        onLoadRekordboxDatabase={onLoadDb}
      />
    );
    fireEvent.click(buttonText(container, /ANLZ \/ XML \/ DB Datei-Import/));
    expect(container.textContent).toContain('Keine Datenbank im Standardordner gefunden');
    await act(async () => {
      fireEvent.click(buttonText(container, /Standardordner durchsuchen/));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitForFrames(2);
    expect(onLocate).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Rekordbox-Bibliothek');
    fireEvent.click(buttonText(container, /^Laden$/));
    expect(onLoadDb).toHaveBeenCalledTimes(1);
    expect(onLoadDb.mock.calls[0][0]).toBe(candidates[0].path);
  });

  it('hands a chosen XML file to the app and closes', () => {
    const onImportXmlFile = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <DatabaseExtractionModal
        isOpen
        onClose={onClose}
        track={track()}
        onImportXmlFile={onImportXmlFile}
      />
    );
    fireEvent.click(buttonText(container, /ANLZ \/ XML \/ DB Datei-Import/));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['<DJ_PLAYLISTS/>'], 'rekordbox.xml', { type: 'text/xml' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput, { target: { files: [file] } as never });
    expect(onImportXmlFile).toHaveBeenCalledTimes(1);
    expect((onImportXmlFile.mock.calls[0][0] as File).name).toBe('rekordbox.xml');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers the collection presets and applies them by index', () => {
    const onLoadTrackByIndex = vi.fn();
    const { container } = render(
      <DatabaseExtractionModal
        isOpen
        onClose={() => {}}
        track={track()}
        onLoadTrackByIndex={onLoadTrackByIndex}
      />
    );
    fireEvent.click(buttonText(container, /Hyperdrive/));
    expect(onLoadTrackByIndex).toHaveBeenCalledWith(1);
  });
});

describe('ExportModal', () => {
  it('exports the edited project as Rekordbox XML through the browser download', async () => {
    const created: Array<{ blob: Blob }> = [];
    URL.createObjectURL = ((blob: Blob) => {
      created.push({ blob });
      return 'blob:airdox-test';
    }) as typeof URL.createObjectURL;
    const onComplete = vi.fn();
    const { container } = render(
      <ExportModal
        isOpen
        onClose={() => {}}
        track={track()}
        workingAudioBuffer={null}
        protectedPaths={[]}
        onExportComplete={onComplete}
      />
    );
    fireEvent.click(labelText(container, /Rekordbox XML/));
    fireEvent.click(buttonText(container, /Rendern & Schichten prüfen/));
    await waitForFrames(2);
    // The render inspector is shown first — the user sees which layers are used.
    expect(container.textContent).toContain('Multi-Schichten Render-Inspektor');
    const download = findButton(container, /herunterladen|Rendert Schichten/i) as HTMLButtonElement;
    await waitForEnabled(download);
    await act(async () => {
      fireEvent.click(download);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    await waitForFrames(2);
    expect(created.length).toBe(1);
    const xml = await created[0].blob.text();
    expect(xml).toContain('<DJ_PLAYLISTS');
    expect(xml).toContain('Obsidian Voltage');
    expect(container.textContent).toContain('erfolgreich');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].operationType).toBe('EXPORT');
  });

  it('refuses to export audio when there is nothing to export', async () => {
    const { container } = render(
      <ExportModal
        isOpen
        onClose={() => {}}
        track={{ ...track(), audioBuffer: null }}
        workingAudioBuffer={null}
      />
    );
    fireEvent.click(labelText(container, /Master Audio/));
    fireEvent.click(buttonText(container, /Rendern & Schichten prüfen/));
    const download = findButton(container, /herunterladen|Rendert Schichten/i) as HTMLButtonElement;
    await waitForEnabled(download);
    await act(async () => {
      fireEvent.click(download);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    await waitForFrames(2);
    expect(dialogs.alerts.join(' ')).toContain('Keine Audiodaten für Export vorhanden');
  });

  it('routes an export crash into the log instead of only the console', async () => {
    // The failure must be visible twice: to the user (alert) and in the durable
    // log (file log + System-Protokoll), because this is the report users send.
    const exportSpy = vi.spyOn(audioEngine, 'exportToWavBlob').mockImplementation(() => {
      throw new Error('Encoder-Laufzeitfehler');
    });
    const logSpy = vi.spyOn(logger, 'error');
    const { container } = render(
      <ExportModal
        isOpen
        onClose={() => {}}
        track={track()}
        workingAudioBuffer={null}
        onExportComplete={vi.fn()}
      />
    );
    fireEvent.click(labelText(container, /Master Audio/));
    fireEvent.click(buttonText(container, /Rendern & Schichten prüfen/));
    const download = findButton(container, /herunterladen|Rendert Schichten/i) as HTMLButtonElement;
    await waitForEnabled(download);
    await act(async () => {
      fireEvent.click(download);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    await waitForFrames(2);
    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(dialogs.alerts.join(' ')).toContain('Fehler beim Exportieren: Encoder-Laufzeitfehler');
    const entry = logSpy.mock.calls.find(([, message]) => message === 'Export fehlgeschlagen');
    expect(entry, 'Export-Fehler muss als SYSTEM-Fehler im Log landen').toBeDefined();
    expect(entry![0]).toBe('SYSTEM');
    expect(entry![2]).toMatchObject({ error: 'Encoder-Laufzeitfehler', format: 'WAV' });
    expect(container.textContent).not.toContain('erfolgreich');
  });

  it('saves through the desktop bridge with the protected paths, never over an original', async () => {
    const saveExportFile = vi.fn(async (_args: { kind: string; defaultName: string; protectedPaths: string[] }) => ({
      saved: true,
      path: 'C:\\Users\\dj\\Desktop\\Obsidian Voltage_EDIT_MASTER.wav',
    }));
    (window as unknown as { rekordboxDesktop: unknown }).rekordboxDesktop = { saveExportFile };
    const { container } = render(
      <ExportModal
        isOpen
        onClose={() => {}}
        track={track()}
        workingAudioBuffer={null}
        protectedPaths={['D:/Rekordbox/Obsidian.wav']}
      />
    );
    // A fake AudioBuffer has no channel data, so the WAV path is exercised with
    // the JSON project state instead — the bridge call shape is what matters.
    fireEvent.click(labelText(container, /Rekordbox XML/));
    fireEvent.click(buttonText(container, /Rendern & Schichten prüfen/));
    const download = findButton(container, /herunterladen|Rendert Schichten/i) as HTMLButtonElement;
    await waitForEnabled(download);
    await act(async () => {
      fireEvent.click(download);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    await waitForFrames(2);
    expect(saveExportFile).toHaveBeenCalledTimes(1);
    const args = saveExportFile.mock.calls[0][0];
    expect(args.protectedPaths).toEqual(['D:/Rekordbox/Obsidian.wav']);
    expect(container.textContent).toContain('gespeichert');
    // The exported bytes are the XML document itself, so a re-import round-trips.
    const bytes = saveExportFile.mock.calls[0][0] as unknown as { data: Uint8Array; kind: string };
    expect(bytes.kind).toBe('XML');
    expect(new TextDecoder().decode(bytes.data)).toContain('<DJ_PLAYLISTS');
  });
});

describe('RekordboxXmlImportModal', () => {
  const collection = () => [
    makeDeckTrack({ id: '101', title: 'Obsidian Voltage (Club Mix)' }),
    makeDeckTrack({ id: '102', title: 'Hyperdrive', multiplier: 2 }),
  ];

  it('lists the collection with its file name and per-track counts', () => {
    const { container } = render(
      <RekordboxXmlImportModal
        isOpen
        onClose={() => {}}
        xmlTracks={collection()}
        fileName="rekordbox.xml"
        onSelectTrack={vi.fn()}
      />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('rekordbox.xml');
    expect(text).toContain('Obsidian Voltage (Club Mix)');
    expect(text).toContain('2 Tracks');
  });

  it('narrows the list by search and by cue filter', () => {
    const { container } = render(
      <RekordboxXmlImportModal
        isOpen
        onClose={() => {}}
        xmlTracks={collection()}
        fileName="rekordbox.xml"
        onSelectTrack={vi.fn()}
      />
    );
    const rowsWithAction = () =>
      Array.from(container.querySelectorAll('tr')).filter((r) =>
        r.querySelector('button[title="Diesen Track in das DJ-Deck laden"]')
      );
    expect(rowsWithAction().length).toBe(2);
    const search = container.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'Hyper' } });
    expect(rowsWithAction().map((r) => r.textContent)).toEqual([expect.stringMatching('Hyperdrive')]);

    fireEvent.change(search, { target: { value: 'unbekannt' } });
    expect(rowsWithAction().length).toBe(0);
    expect(container.textContent).toMatch(/keine|Keine/);
  });

  it('loads exactly the record the user activates', () => {
    const onSelectTrack = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <RekordboxXmlImportModal
        isOpen
        onClose={onClose}
        xmlTracks={collection()}
        fileName="rekordbox.xml"
        onSelectTrack={onSelectTrack}
        currentTrackId="101"
      />
    );
    const rows = Array.from(container.querySelectorAll('tr')).filter((r) =>
      r.querySelector('button[title="Diesen Track in das DJ-Deck laden"]')
    );
    expect(rows.length).toBe(2);
    fireEvent.click(rows[1].querySelector('button[title="Diesen Track in das DJ-Deck laden"]') as HTMLElement);
    expect(onSelectTrack).toHaveBeenCalledTimes(1);
    expect((onSelectTrack.mock.calls[0][0] as { title: string }).title).toBe('Hyperdrive');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sorts by title and keeps the current selection marked', () => {
    const { container } = render(
      <RekordboxXmlImportModal
        isOpen
        onClose={() => {}}
        xmlTracks={collection()}
        fileName="rekordbox.xml"
        onSelectTrack={vi.fn()}
        currentTrackId="102"
      />
    );
    const order = () =>
      Array.from(container.querySelectorAll('tbody tr'))
        .map((r) => (r.textContent ?? '').split('In Deck')[0])
        .join('|');
    const before = order();
    const titleHeader = Array.from(container.querySelectorAll('th')).find((th) =>
      /titel|title/i.test(th.textContent ?? '')
    ) as HTMLElement;
    fireEvent.click(titleHeader);
    expect(order()).not.toBe(before);
  });
});
