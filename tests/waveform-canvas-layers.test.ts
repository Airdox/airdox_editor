import assert from 'node:assert/strict';
import { drawPlayhead, drawSelectionOverlay, drawSnapGuide } from '../src/waveform/canvasLayers.ts';
import { type SelectionRange, type TrackModel } from '../src/types/rekordbox';

interface DrawCall {
  name: string;
  args: unknown[];
}

function createContext(): { context: CanvasRenderingContext2D; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const record = (name: string) => (...args: unknown[]) => calls.push({ name, args });
  const context = {
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    closePath: record('closePath'),
    fill: record('fill'),
    fillText: record('fillText'),
    setLineDash: record('setLineDash'),
    createLinearGradient: record('createLinearGradient'),
    measureText: (text: string) => ({ width: text.length * 5 }),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
  } as unknown as CanvasRenderingContext2D;
  // Return a small gradient stub from the recorded factory call.
  context.createLinearGradient = ((...args: number[]) => {
    calls.push({ name: 'createLinearGradient', args });
    return { addColorStop: record('addColorStop') } as unknown as CanvasGradient;
  }) as typeof context.createLinearGradient;
  return { context, calls };
}

// A visible playhead clears and paints only the supplied overlay canvas.
{
  const { context, calls } = createContext();
  drawPlayhead(context, 5, 2, 6, 600, 300);

  assert.deepEqual(calls[0], { name: 'clearRect', args: [0, 0, 600, 300] });
  assert.ok(calls.some((call) => call.name === 'moveTo' && call.args[0] === 300 && call.args[1] === 0));
  assert.ok(calls.some((call) => call.name === 'lineTo' && call.args[0] === 300 && call.args[1] === 300));
  assert.equal(calls.filter((call) => call.name === 'stroke').length, 1);
  assert.equal(calls.filter((call) => call.name === 'fill').length, 1);
}

// An offscreen or invalid playhead clears stale pixels without drawing a marker.
for (const [time, offset, duration, width, height] of [
  [12, 2, 6, 600, 300],
  [2, 0, 0, 600, 300],
  [2, 0, 2, 0, 300],
] as const) {
  const { context, calls } = createContext();
  drawPlayhead(context, time, offset, duration, width, height);
  assert.deepEqual(calls, [{ name: 'clearRect', args: [0, 0, width, height] }]);
}

// Im zusammengesetzten Overlay der Detail-Wellenform darf die Funktion die
// Ebene nicht leeren, sonst verschwinden Auswahl, Hover-Führung und Snap-Badge.
{
  const { context, calls } = createContext();
  drawPlayhead(context, 5, 2, 6, 600, 300, { clear: false });

  assert.equal(
    calls.filter((call) => call.name === 'clearRect').length,
    0,
    'clear: false darf die Ebene nicht leeren'
  );
  assert.ok(calls.some((call) => call.name === 'stroke'), 'Playhead wird trotzdem gezeichnet');
}

const selection = {
  start: 2,
  end: 5,
  startBeat: 4,
  endBeat: 10,
  beatsCount: 6,
  barsCount: 1.5,
  duration: 3,
} as SelectionRange;

// Selection is painted on its dedicated overlay, independently of the static scene.
{
  const { context, calls } = createContext();
  drawSelectionOverlay(context, selection, 0, 10, 1000, 320);
  assert.ok(calls.some((call) => call.name === 'fillRect' && call.args[0] === 200));
  assert.ok(calls.some((call) => call.name === 'strokeRect' && call.args[0] === 200));
  assert.ok(calls.some((call) => call.name === 'fillText' && call.args[0] === '1.5 Bars'));
}

// Pointer hover draws a beat-snap guide on the overlay without needing a React state update.
{
  const { context, calls } = createContext();
  const beatGrid = { bpm: 120, firstBeat: 0, meter: 4 } as TrackModel['beatGrid'];
  drawSnapGuide(context, 1.9, beatGrid, (time) => Math.round(time * 2) / 2, 0, 8, 800, 320);
  assert.ok(calls.some((call) => call.name === 'createLinearGradient'));
  assert.ok(calls.some((call) => call.name === 'fillText' && String(call.args[0]).includes('BAR')));
}

// Invalid/offscreen inputs do not draw selection or snap markers.
{
  const { context, calls } = createContext();
  drawSelectionOverlay(context, selection, 10, 0, 800, 320);
  drawSnapGuide(context, 1, null, (time) => time, 0, 8, 800, 320);
  assert.deepEqual(calls, []);
}

console.log('waveform canvas layers: playhead, selection, and snap guide are isolated and bounds-safe');
