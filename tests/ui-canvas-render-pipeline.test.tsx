/**
 * @license
 * UI-Canvas-Render-Pipeline Smoke-Test (jsdom).
 *
 * Sichert den Performance-Umbau der Wellenform-Renderer ab:
 *   • DetailWaveform/TrackOverview mounten fehlerfrei und abonnieren den
 *     zentralen playbackClock.
 *   • Pro Frame wird NUR das Offscreen-Canvas geblittet (drawImage) plus
 *     Overlay – die teure statische Szene (Waveform-Spalten-Loops) darf
 *     NICHT pro Frame neu gezeichnet werden (vorher: komplette Neuzeichnung
 *     60×/s → blockierte Bedienung).
 *   • EditModeBar aktualisiert die VU-Meter imperativ per Frame-Callback.
 *
 * SKIP, wenn jsdom nicht installiert ist (wie andere Umgebungstests auch).
 */

import assert from 'node:assert/strict';

let jsdomModule: typeof import('jsdom') | null = null;
try {
  jsdomModule = await import('jsdom');
} catch {
  console.log('SKIP: jsdom ist nicht installiert (npm install jsdom) – UI-Smoke-Test übersprungen.');
  process.exit(0);
}

const { JSDOM } = jsdomModule;

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: false,
  url: 'http://localhost/',
});

// ─── Browser-Globals für React & Komponenten bereitstellen ──────────────────
const { window } = dom;
const g = globalThis as unknown as Record<string, unknown>;
g.window = window;
g.document = window.document;
// navigator ist in Node 22 read-only (getter) – nur definieren, wenn fehlt.
if (!('navigator' in globalThis)) g.navigator = window.navigator;
g.HTMLElement = window.HTMLElement;
g.Element = window.Element;
g.SVGElement = window.SVGElement;
g.getComputedStyle = window.getComputedStyle;
g.requestAnimationFrame = undefined;
g.cancelAnimationFrame = undefined;
g.ResizeObserver = class {
  observe(): void { /* jsdom-Stub */ }
  unobserve(): void { /* jsdom-Stub */ }
  disconnect(): void { /* jsdom-Stub */ }
};

// ─── rAF-Stub mit Handle-Management (wie im Browser) ────────────────────────
type RafCallback = (t: number) => void;
const rafHandles = new Map<number, RafCallback>();
let nextRafHandle = 1;
window.requestAnimationFrame = ((cb: RafCallback) => {
  const handle = nextRafHandle++;
  rafHandles.set(handle, cb);
  return handle;
}) as typeof window.requestAnimationFrame;
window.cancelAnimationFrame = ((handle: number) => {
  rafHandles.delete(handle);
}) as typeof window.cancelAnimationFrame;
(globalThis as unknown as { requestAnimationFrame: (cb: RafCallback) => number }).requestAnimationFrame =
  window.requestAnimationFrame as (cb: RafCallback) => number;
(globalThis as unknown as { cancelAnimationFrame: (h: number) => void }).cancelAnimationFrame =
  window.cancelAnimationFrame as (h: number) => void;

function pumpRaf(times = 1): void {
  for (let i = 0; i < times; i++) {
    const entries = [...rafHandles.values()];
    rafHandles.clear();
    for (const cb of entries) cb(0);
  }
}

// ─── Canvas-2D-Stub mit Call-Zählern pro Canvas ─────────────────────────────
interface CtxStats {
  drawImage: number;
  fillRect: number;
  clearRect: number;
}
const ctxStats = new WeakMap<object, CtxStats>();
const canvasToCtx = new WeakMap<object, unknown>();

function makeCtxStats(): CtxStats {
  return { drawImage: 0, fillRect: 0, clearRect: 0 };
}

function makeStubCtx(canvas: unknown): Record<string, unknown> {
  const stats = makeCtxStats();
  ctxStats.set(canvas as object, stats);
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = {
    canvas,
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => gradient,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  return new Proxy(target, {
    get(obj, prop: string) {
      if (prop in obj) return obj[prop];
      if (prop === 'drawImage' || prop === 'fillRect' || prop === 'clearRect') {
        return () => {
          stats[prop] += 1;
        };
      }
      return () => {};
    },
    set(obj, prop: string, value) {
      obj[prop] = value;
      return true;
    },
  });
}

// Alle Canvas (JSX + document.createElement) bekommen denselben Stub-Typ.
const OriginalCreateElement = window.document.createElement.bind(window.document);
(window.document as unknown as { createElement: (tag: string, opts?: unknown) => HTMLElement }).createElement = (tag: string, opts?: unknown) => {
  const el = OriginalCreateElement(tag, opts);
  if (tag.toLowerCase() === 'canvas') {
    (el as unknown as { width: number }).width = 1200;
    (el as unknown as { height: number }).height = 320;
  }
  return el;
};
(window.HTMLCanvasElement.prototype as unknown as { getContext: (type: string) => unknown }).getContext = function (this: unknown, type: string) {
  if (type !== '2d') return null;
  let ctx = canvasToCtx.get(this as object);
  if (!ctx) {
    ctx = makeStubCtx(this);
    canvasToCtx.set(this as object, ctx);
  }
  return ctx;
};
// jsdom liefert 0×0-Rects → realistische Layout-Größen simulieren.
(window.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = function () {
  return {
    x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 320,
    width: 1200, height: 320, toJSON: () => ({}),
  } as unknown as DOMRect;
};

// ─── React-Umgebung ─────────────────────────────────────────────────────────
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { DetailWaveform } = await import('../src/components/DetailWaveform');
const { TrackOverview } = await import('../src/components/TrackOverview');
const { EditModeBar } = await import('../src/components/EditModeBar');
const { DataOrigin } = await import('../src/types/rekordbox');
const { playbackClock } = await import('../src/audio/playbackClock');
const { audioEngine } = await import('../src/audio/audioEngine');

// ─── Minimaler Track mit Analyse-Daten ──────────────────────────────────────
function makeAnalysis(): import('../src/types/rekordbox').WaveformAnalysisData {
  const n = 2000;
  const peaks = new Float32Array(n);
  const low = new Float32Array(n);
  const mid = new Float32Array(n);
  const high = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    peaks[i] = 0.4 + 0.5 * Math.abs(Math.sin(i / 40));
    low[i] = 0.3 + 0.4 * Math.abs(Math.sin(i / 61));
    mid[i] = 0.2 + 0.3 * Math.abs(Math.sin(i / 23));
    high[i] = 0.1 + 0.2 * Math.abs(Math.sin(i / 11));
  }
  return {
    length: n,
    peaks,
    peaksL: peaks,
    peaksR: peaks,
    lowEnergy: low,
    midEnergy: mid,
    highEnergy: high,
    origin: DataOrigin.LOCAL_ANALYSIS,
    secPerBucket: 10 / n,
    samplesPerBucket: 441,
  };
}

function makeTrack(): import('../src/types/rekordbox').TrackModel {
  return {
    id: 'track-smoke',
    title: 'Smoke Test',
    artist: 'Test',
    album: 'Test',
    bpm: 128,
    key: '1A',
    duration: 10,
    sampleRate: 44100,
    channels: 2,
    originalSha256: 'sha256-test',
    isOriginalUntouched: true,
    audioBuffer: null,
    beatGrid: { firstBeat: 0, bpm: 128, meter: 4, beats: [], origin: DataOrigin.LOCAL_ANALYSIS },
    cues: [],
    loops: [],
    analysis: makeAnalysis(),
    origin: DataOrigin.LOCAL_ANALYSIS,
    workingSegments: [],
  };
}

const noop = () => {};

function render(jsx: React.ReactElement): { root: ReturnType<typeof createRoot>; container: HTMLElement } {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(jsx);
  });
  return { root, container };
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
  }
}

// ─── 1. DetailWaveform: statische Szene wird gecacht, Frame blittet nur ─────
const track = makeTrack();
const detail = render(
  <DetailWaveform
    track={track}
    currentTime={1.5}
    viewOffset={0}
    viewDuration={5}
    waveformMode="RGB"
    selection={null}
    quantize={true}
    onSeek={noop}
    onSelect={noop}
    onZoomIn={noop}
    onZoomOut={noop}
    onResetZoom={noop}
    onPanView={noop}
    onAddToPalette={noop}
    onCopy={noop}
    onCut={noop}
    onPaste={noop}
    onInsert={noop}
    onReplace={noop}
    onOverdub={noop}
    onDelete={noop}
    onClear={noop}
    onAddCue={noop}
  />
);

const detailCanvas = detail.container.querySelector('canvas') as unknown as HTMLCanvasElement;
check('DetailWaveform: Canvas gemountet', () => assert.ok(detailCanvas, 'Canvas muss existieren'));

// Erste Frames pumpen: statische Szene + Overlay-Blits
pumpRaf(3);
const warmupStats = ctxStats.get(detailCanvas);
check('DetailWaveform: Frame-Loop blittet pro Frame', () => {
  assert.ok(warmupStats, 'Canvas-Kontext muss existieren');
  assert.ok(warmupStats.drawImage >= 3, `drawImage sollte pro Frame laufen (bekam ${warmupStats?.drawImage})`);
});
// Zahlen sofort einfrieren (Live-Objekt mutiert weiter).
const warmupClearRect = warmupStats.clearRect;
const warmupFillRect = warmupStats.fillRect;

// Weitere Frames: die teure statische Szene darf NICHT pro Frame neu laufen.
pumpRaf(20);
const playbackStats = ctxStats.get(detailCanvas);
check('DetailWaveform: statische Szene wird NICHT pro Frame neu gezeichnet', () => {
  assert.ok(playbackStats, 'Canvas-Kontext muss existieren');
  assert.equal(
    playbackStats.clearRect,
    warmupClearRect + 20,
    `clearRect muss exakt +20 (ein Mal pro Frame) wachsen, nicht mehr (bekam ${playbackStats.clearRect - warmupClearRect})`
  );
  assert.equal(
    playbackStats.fillRect,
    warmupFillRect,
    `fillRect (statische Szene) darf sich über Frames nicht verändern (bekam ${playbackStats.fillRect} statt ${warmupFillRect})`
  );
});

act(() => { detail.root.unmount(); });

// ─── 2. TrackOverview: gleiche Pipeline ─────────────────────────────────────
const overview = render(
  <TrackOverview track={track} currentTime={1.5} viewOffset={0} viewDuration={5} onSeek={noop} onPanView={noop} />
);
const overviewCanvas = overview.container.querySelector('canvas') as unknown as HTMLCanvasElement;
pumpRaf(2);
check('TrackOverview: Frame-Loop blittet pro Frame', () => {
  const stats = ctxStats.get(overviewCanvas);
  assert.ok(stats, 'Canvas-Kontext muss existieren');
  assert.ok(stats.drawImage >= 2, `drawImage sollte pro Frame laufen (bekam ${stats?.drawImage})`);
});
act(() => { overview.root.unmount(); });

// ─── 3. EditModeBar: Meter werden imperativ aktualisiert ────────────────────
const bar = render(
  <EditModeBar
    projectName="Smoke"
    isPlaying={false}
    onTogglePlay={noop}
    onReturnToStart={noop}
    loopActive={false}
    onToggleLoop={noop}
    quantizeActive={true}
    onToggleQuantize={noop}
    onNewProject={noop}
    onSaveProject={noop}
    onExport={noop}
    onShowInfo={noop}
    masterVolume={0.9}
    onMasterVolumeChange={noop}
  />
);
const meterFills = bar.container.querySelectorAll('[data-side]');
check('EditModeBar: zwei Meter-Balken vorhanden', () => assert.equal(meterFills.length, 2));

pumpRaf(2);
check('EditModeBar: Meter-Styles werden pro Frame imperativ gesetzt', () => {
  const fill = meterFills[0] as unknown as HTMLElement;
  assert.ok(fill.style.width !== undefined && fill.style.width !== '', 'style.width muss gesetzt sein');
  assert.match(fill.style.width, /%$/, 'Meter-Breite muss in Prozent gesetzt werden');
});
act(() => { bar.root.unmount(); });

// ─── 4. Clock-Lifecycle: nach Unmount aller Komponenten keine Loop mehr ─────
pumpRaf(3);
check('playbackClock: keine rAF-Loop ohne Subscriber', () => {
  assert.equal(rafHandles.size, 0, `Nach Unmount darf kein rAF mehr geplant sein (bekam ${rafHandles.size})`);
});

// ─── 5. Transport-Position (Pausenzustand) treibt den Playhead ──────────────
const detail2 = render(
  <DetailWaveform
    track={track}
    currentTime={0}
    viewOffset={0}
    viewDuration={5}
    waveformMode="BLUE"
    selection={null}
    quantize={false}
    onSeek={noop}
    onSelect={noop}
    onZoomIn={noop}
    onZoomOut={noop}
    onResetZoom={noop}
    onPanView={noop}
    onAddToPalette={noop}
    onCopy={noop}
    onCut={noop}
    onPaste={noop}
    onInsert={noop}
    onReplace={noop}
    onOverdub={noop}
    onDelete={noop}
    onClear={noop}
    onAddCue={noop}
  />
);
audioEngine.setTransportPosition(2.5);
pumpRaf(2);
check('DetailWaveform: pausierter Seek ändert die Clock-Position', () => {
  assert.ok(Math.abs(playbackClock.peek().time - 2.5) < 1e-9, `Clock sollte 2.5s liefern (bekam ${playbackClock.peek().time})`);
});
act(() => { detail2.root.unmount(); });
audioEngine.stop();

if (failures > 0) {
  console.error(`\n${failures} UI-Canvas-Check(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log('\nAlle UI-Canvas-Render-Pipeline-Tests bestanden.');
// Der Renderer-Logger hält sonst einen Flush-Timer am Event-Loop – im Test-
// Kontext beenden wir explizit.
process.exit(0);
