/**
 * @license
 * jsdom environment patches for component tests (test-only file).
 *
 * jsdom lacks the canvas 2D context, ResizeObserver, matchMedia, a usable
 * getBoundingClientRect and a DataTransfer. The components under test need all of
 * them to reach their real code paths — recording calls instead of returning
 * nothing would only prove that a render did not throw.
 */

import { installFakeWebAudio } from '../helpers/fakeAudioContext';

/** Everything the waveform renderers call, recorded per canvas element. */
export interface CanvasCallLog {
  calls: Array<{ op: string; args: unknown[] }>;
  ops: Set<string>;
}

const canvasLogs = new WeakMap<object, CanvasCallLog>();

export function canvasCallLog(el: unknown): CanvasCallLog | undefined {
  return canvasLogs.get(el as object);
}

export function resetCanvasCallLog(el: unknown) {
  canvasLogs.delete(el as object);
}

const canvasContexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();

function make2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  // One context per element: components legitimately ask for it more than once,
  // and a fresh log per call would silently lose everything drawn before.
  const existing = canvasContexts.get(canvas);
  if (existing) return existing;
  const log: CanvasCallLog = { calls: [], ops: new Set() };
  canvasLogs.set(canvas, log);
  const state: Record<string, unknown> = {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'butt',
    lineJoin: 'miter',
    imageSmoothingEnabled: true,
    filter: 'none',
    miterLimit: 10,
    shadowBlur: 0,
    shadowColor: 'transparent',
  };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 6 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop: () => {} });
      }
      if (prop === 'createPattern') return () => null;
      if (prop === 'getImageData') {
        return (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
          width: w,
          height: h,
          colorSpace: 'srgb',
        });
      }
      if (prop === 'createImageData') {
        return (w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
      }
      if (typeof prop === 'string') {
        return (...args: unknown[]) => {
          log.ops.add(prop);
          log.calls.push({ op: prop, args });
          return undefined;
        };
      }
      return undefined;
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      log.ops.add(`set:${prop}`);
      log.calls.push({ op: `set:${prop}`, args: [value] });
      return true;
    },
  };
  const ctx = new Proxy(state, handler) as unknown as CanvasRenderingContext2D;
  canvasContexts.set(canvas, ctx);
  return ctx;
}

const proto = (globalThis as unknown as { HTMLCanvasElement?: { prototype: unknown } }).HTMLCanvasElement?.prototype as
  | { getContext?: (kind: string, attrs?: unknown) => unknown }
  | undefined;
if (proto) {
  proto.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
    if (kind === '2d' || kind === 'webgl' || kind === 'bitmaprenderer') return make2dContext(this);
    return null;
  } as (kind: string, attrs?: unknown) => unknown;
}

class FakeResizeObserver {
  static observed: FakeResizeObserver[] = [];
  callbacks: Array<(entries: unknown[]) => void> = [];
  constructor(cb: (entries: unknown[]) => void) {
    this.callbacks.push(cb);
    FakeResizeObserver.observed.push(this);
  }
  observe(el: unknown) {
    // Report the element once so size-dependent canvases take their real branch.
    this.callbacks.forEach((cb) => cb([{ target: el, contentRect: { width: 1200, height: 320 } }]));
  }
  unobserve() {}
  disconnect() {}
  /** Tests fire a resize explicitly (e.g. after mounting at a different width). */
  fire() {
    this.callbacks.forEach((cb) => cb([{ contentRect: { width: 1200, height: 320 } }]));
  }
}

globalThis.ResizeObserver = globalThis.ResizeObserver || (FakeResizeObserver as unknown as typeof ResizeObserver);
(globalThis as unknown as { __FakeResizeObserver: unknown }).__FakeResizeObserver = FakeResizeObserver;

class FakeIntersectionObserver {
  constructor(_cb: unknown, _opts?: unknown) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.IntersectionObserver =
  globalThis.IntersectionObserver || (FakeIntersectionObserver as unknown as typeof IntersectionObserver);

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// Canvas animations in the components use rAF; jsdom's rAF exists but runs after
// the test ends. A synchronous implementation makes the draw pass deterministic.
// The waveform canvases re-arm requestAnimationFrame continuously. Scheduling on
// a microtask would starve the test loop (the queue never yields), so frames run
// as macrotasks: one tick per await, and the draw code still executes for real.
let rafSeq = 0;
const rafPending = new Map<number, { fn: () => void; timer: ReturnType<typeof setTimeout> }>();
window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  const id = ++rafSeq;
  const timer = setTimeout(() => {
    const entry = rafPending.get(id);
    if (entry) {
      rafPending.delete(id);
      entry.fn();
    }
  }, 0);
  rafPending.set(id, { fn: () => cb(performance.now()), timer });
  return id;
}) as typeof window.requestAnimationFrame;
window.cancelAnimationFrame = ((id: number) => {
  const entry = rafPending.get(id);
  if (entry) {
    clearTimeout(entry.timer);
    rafPending.delete(id);
  }
}) as typeof window.cancelAnimationFrame;
/** Runs every pending frame callback synchronously (used to force one draw). */
(globalThis as unknown as { __flushFrames: () => void }).__flushFrames = () => {
  const entries = [...rafPending.entries()];
  rafPending.clear();
  for (const [, entry] of entries) {
    clearTimeout(entry.timer);
    entry.fn();
  }
};
/** Awaits `frames` animation frames so canvas draws happen deterministically. */
export async function waitForFrames(frames = 2): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Waits for a canvas condition across frames. The waveform loop re-arms itself, so
 * a fixed number of ticks is a race — a predicate is what makes the assertion
 * about a *drawn* thing reliable (and it fails loudly when the draw never comes).
 */
export async function waitUntilDrawn(predicate: () => boolean, ticks = 40): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return predicate();
}

{
  // jsdom reports a zero box for everything, which turns every coordinate → time
  // mapping into a division by zero. A fixed 1200×320 box makes the mapping exact.
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 320,
      width: 1200,
      height: 320,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Range.prototype.getBoundingClientRect = Element.prototype.getBoundingClientRect;
}

if (!URL.createObjectURL) {
  URL.createObjectURL = (() => 'blob:airdox-test') as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
}

if (!window.HTMLElement.prototype.scrollTo) {
  window.HTMLElement.prototype.scrollTo = () => {};
}
if (!window.HTMLAnchorElement.prototype.click) {
  // jsdom has click; kept for completeness in environments without it.
}
if (!window.indexedDB) {
  (window as unknown as { indexedDB: unknown }).indexedDB = undefined;
}

/** Web Audio: needed by the engine, the meters and export flows. */
export const fakeAudio = installFakeWebAudio(window);

/**
 * The app reports refusals through `alert` (and asks through confirm/prompt). jsdom
 * would only print "not implemented", so the dialogs are recorded — a test can then
 * assert WHAT the user was told, which is the point of those code paths.
 */
export const dialogs: { alerts: string[]; confirms: boolean; prompts: string[] } = {
  alerts: [],
  confirms: true,
  prompts: [],
};
window.alert = ((message?: unknown) => {
  dialogs.alerts.push(String(message ?? ''));
}) as typeof window.alert;
window.confirm = (() => dialogs.confirms) as typeof window.confirm;
window.prompt = ((_message?: string, value?: string) => {
  const answer = value ?? '';
  dialogs.prompts.push(answer);
  return answer;
}) as typeof window.prompt;
/** Clears the recorded dialogs (call between tests). */
export function resetDialogs() {
  dialogs.alerts.length = 0;
  dialogs.prompts.length = 0;
}

/** Lets the canvas element report a size even before the first ResizeObserver pass. */
export const TEST_CANVAS_SIZE = { width: 1200, height: 320 };

/**
 * jsdom (27) does not implement `Blob.arrayBuffer()` yet, but the app's whole
 * import path (`file.arrayBuffer()` → decodeAudioData, `file.text()` for XML)
 * relies on it. Polyfilling it here keeps the production code untouched while
 * letting the DOM tests read real bytes.
 */
function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
    return blobToArrayBuffer(this);
  };
}
if (typeof Blob !== 'undefined' && typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function text(this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}
