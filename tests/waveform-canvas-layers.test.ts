import assert from 'node:assert/strict';
import { drawPlayhead } from '../src/waveform/canvasLayers.ts';

interface DrawCall {
  name: string;
  args: number[];
}

function createContext(): { context: CanvasRenderingContext2D; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const record = (name: string) => (...args: number[]) => calls.push({ name, args });
  const context = {
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    closePath: record('closePath'),
    fill: record('fill'),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
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

console.log('waveform canvas layers: playhead overlay is isolated and bounds-safe');
