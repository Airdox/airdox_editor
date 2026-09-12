/**
 * @license
 * Drag & drop event helpers for component tests (test-only file).
 *
 * jsdom has no DataTransfer and no drag event constructors that carry one, so a
 * drop could not be driven at all. This helper builds a real `Event` with the
 * properties React's synthetic drag events expose (dataTransfer, coordinates,
 * modifiers), which is exactly what the drop targets read.
 */

export interface FakeDataTransferInit {
  data?: Record<string, string>;
  files?: Array<{ name: string; type: string; size?: number }>;
  dropEffect?: string;
  effectAllowed?: string;
}

export class FakeDataTransfer {
  private store = new Map<string, string>();
  types: string[] = [];
  files: Array<{ name: string; type: string; size: number; lastModified: number }>;
  items: Array<{ kind: string; type: string; getAsFile: () => unknown }>;
  dropEffect: string;
  effectAllowed: string;
  /** True during dragover in real browsers: getData() is then blocked. */
  readOnly = false;

  constructor(init: FakeDataTransferInit = {}) {
    this.store = new Map(Object.entries(init.data ?? {}));
    this.types = [...this.store.keys()];
    if (this.filesHaveData(init)) this.types.unshift('Files');
    this.files = (init.files ?? []).map((f) => ({
      name: f.name,
      type: f.type,
      size: f.size ?? 1024,
      lastModified: 0,
    }));
    this.items = this.files.map((f) => ({
      kind: 'file',
      type: f.type,
      getAsFile: () => f,
    }));
    this.dropEffect = init.dropEffect ?? 'none';
    this.effectAllowed = init.effectAllowed ?? 'uninitialized';
  }

  private filesHaveData(init: FakeDataTransferInit) {
    return (init.files?.length ?? 0) > 0;
  }

  getData(format: string): string {
    if (this.readOnly) return '';
    return this.store.get(format) ?? '';
  }
  setData(format: string, value: string): void {
    this.store.set(format, value);
    if (!this.types.includes(format)) this.types.push(format);
  }
  clearData(format?: string): void {
    if (format) this.store.delete(format);
    else this.store.clear();
  }
  setDragImage(): void {}
}

export interface DragEventInit {
  x?: number;
  y?: number;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  dataTransfer?: FakeDataTransfer;
}

/**
 * Builds a bubbling drag event of `type` carrying `dataTransfer`.
 * Coordinates default to the middle of the 1200 px test box.
 */
export function makeDragEvent(type: string, init: DragEventInit = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
  const dataTransfer = init.dataTransfer ?? new FakeDataTransfer();
  Object.assign(event, {
    dataTransfer,
    clientX: init.x ?? 600,
    clientY: init.y ?? 160,
    screenX: init.x ?? 600,
    screenY: init.y ?? 160,
    pageX: init.x ?? 600,
    pageY: init.y ?? 160,
    offsetX: init.x ?? 600,
    offsetY: init.y ?? 160,
    shiftKey: !!init.shiftKey,
    altKey: !!init.altKey,
    ctrlKey: !!init.ctrlKey,
    metaKey: !!init.metaKey,
    button: 0,
    buttons: 0,
    relatedTarget: null,
    view: window,
  });
  return event;
}

/** Pointer event with coordinates (used for selection drags on the canvas). */
export function makePointerEvent(
  type: 'mousedown' | 'mousemove' | 'mouseup' | 'click' | 'contextmenu' | 'dblclick',
  x: number,
  y: number,
  init: { shiftKey?: boolean; button?: number } = {}
): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    shiftKey: !!init.shiftKey,
    button: init.button ?? 0,
  });
}

/** Converts a time on the deck timeline into a client X coordinate (1200 px box). */
export function timeToClientX(time: number, viewOffset: number, viewDuration: number, width = 1200): number {
  return ((time - viewOffset) / viewDuration) * width;
}

/** Full drag gesture between two elements, mirroring what a browser fires. */
export function dragFromTo(
  source: Element,
  target: Element,
  payloadData: Record<string, string>,
  dropInit: { x?: number; y?: number; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = {}
): { dataTransfer: FakeDataTransfer; start: Event; over: Event; drop: Event } {
  const dataTransfer = new FakeDataTransfer({ data: payloadData });
  const start = makeDragEvent('dragstart', { dataTransfer, x: dropInit.x, y: dropInit.y });
  source.dispatchEvent(start);
  // The browser blocks payload reads until the drop itself.
  dataTransfer.readOnly = true;
  const over = makeDragEvent('dragover', {
    dataTransfer,
    x: dropInit.x,
    y: dropInit.y,
    shiftKey: dropInit.shiftKey,
    altKey: dropInit.altKey,
    ctrlKey: dropInit.ctrlKey,
  });
  target.dispatchEvent(over);
  dataTransfer.readOnly = false;
  const drop = makeDragEvent('drop', {
    dataTransfer,
    x: dropInit.x,
    y: dropInit.y,
    shiftKey: dropInit.shiftKey,
    altKey: dropInit.altKey,
    ctrlKey: dropInit.ctrlKey,
  });
  target.dispatchEvent(drop);
  const end = makeDragEvent('dragend', { dataTransfer });
  source.dispatchEvent(end);
  return { dataTransfer, start, over, drop };
}
