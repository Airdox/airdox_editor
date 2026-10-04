/**
 * Regressionstest für den Transport-Store und den Playhead-Treiber.
 *
 * Warum dieser Test existiert:
 *   Früher setzte der rAF-Loop in `App.tsx` drei React-States pro Frame
 *   (~180 Updates/s) und registrierte sich beim Auto-Scroll jeden Frame neu.
 *   Der Treiber darf deshalb:
 *     1. die Position pro Frame schreiben (ohne React),
 *     2. `isPlaying` nur bei einem echten Wechsel melden,
 *     3. Pegel höchstens mit der konfigurierten Rate melden,
 *     4. die Ansicht nur bei echter Verschiebung melden (gedrosselt),
 *     5. nach `stop()` keinen Frame mehr anfordern,
 *     6. bei Pause die Parkposition exakt übernehmen und Pegel auf 0 setzen.
 *
 * Der Test läuft framework-frei in Node: `requestFrame`/`cancelFrame` sind
 * gestubbt, damit jeder „Frame" deterministisch ausgelöst werden kann.
 */

import assert from 'node:assert/strict';
import {
  getTransport,
  resetTransport,
  setPosition,
  setTransport,
  subscribeTransport,
} from '../src/state/transportStore';
import { startPlayheadDriver } from '../src/features/transport/playheadDriver';

// ---------------------------------------------------------------------------
// Teil 1: Store – gleiche Werte erzeugen keine Benachrichtigung
// ---------------------------------------------------------------------------
resetTransport();
let notifications = 0;
const unsubscribe = subscribeTransport(() => {
  notifications += 1;
});

setTransport({ isPlaying: false });
assert.equal(notifications, 0, 'Setzen desselben Werts darf nicht benachrichtigen');

setTransport({ isPlaying: true });
assert.equal(notifications, 1, 'Echter Wechsel benachrichtigt genau einmal');
assert.equal(getTransport().isPlaying, true);

setPosition(12.5);
assert.equal(notifications, 2);
setPosition(12.5);
assert.equal(notifications, 2, 'Identische Position darf nicht benachrichtigen');
unsubscribe();
console.log('  ✓ Store benachrichtigt nur bei echten Änderungen');

// ---------------------------------------------------------------------------
// Teil 2: Treiber
// ---------------------------------------------------------------------------
interface Harness {
  state: {
    playing: boolean;
    time: number;
    meter: { left: number; right: number };
    frames: Array<(timestampMs: number) => void>;
    cancelled: number[];
    followOffsets: number[];
    viewport: { offset: number; duration: number; trackDuration: number };
  };
  handle: ReturnType<typeof startPlayheadDriver>;
  runFrame(timestampMs: number): void;
}

function createHarness(playing: boolean): Harness {
  resetTransport();
  const state: Harness['state'] = {
    playing,
    time: 0,
    meter: { left: 0.5, right: 0.4 },
    frames: [],
    cancelled: [],
    followOffsets: [],
    viewport: { offset: 0, duration: 18, trackDuration: 600 },
  };

  let nextHandle = 1;
  const handle = startPlayheadDriver({
    port: {
      getCurrentTime: () => state.time,
      getIsPlaying: () => state.playing,
      getMasterMeter: () => state.meter,
    },
    getViewport: () => state.viewport,
    onFollowOffset: (offset) => state.followOffsets.push(offset),
    requestFrame: (callback) => {
      state.frames.push(callback);
      return nextHandle++;
    },
    cancelFrame: (handleToCancel) => state.cancelled.push(handleToCancel),
  });

  return {
    state,
    handle,
    runFrame(timestampMs) {
      const callback = state.frames.shift();
      assert.ok(callback, 'Es muss ein Frame angefordert sein');
      callback(timestampMs);
    },
  };
}

// 2a. Wiedergabe: Position folgt, Pegel gedrosselt, Stop räumt auf.
{
  const { state, handle, runFrame } = createHarness(true);
  let meterChanges = 0;
  let lastMeter = getTransport().meters;
  const unsubscribeMeters = subscribeTransport(() => {
    const current = getTransport().meters;
    if (current.left !== lastMeter.left || current.right !== lastMeter.right) {
      meterChanges += 1;
      lastMeter = current;
    }
  });

  state.time = 1;
  runFrame(1000);
  state.time = 1.016;
  runFrame(1016);
  state.time = 1.032;
  runFrame(1032);

  assert.equal(getTransport().isPlaying, true, 'Wiedergabe muss im Store sichtbar sein');
  assert.equal(getTransport().positionSec, 1.032, 'Position muss dem letzten Frame entsprechen');
  assert.equal(meterChanges, 1, `Pegel darf nur gedrosselt gemeldet werden (war ${meterChanges})`);

  state.meter = { left: 0.9, right: 0.8 };
  state.time = 1.1;
  runFrame(1100); // > 50 ms nach 1000 ms
  assert.equal(meterChanges, 2, 'Nach dem Intervall muss der neue Pegel kommen');

  unsubscribeMeters();
  handle.stop();
  assert.equal(handle.isRunning(), false);
  assert.equal(state.cancelled.length, 1, 'stop() muss den Frame abbestellen');
  state.time = 99;
  assert.equal(getTransport().positionSec, 1.1, 'Nach stop() darf kein Frame mehr schreiben');
}
console.log('  ✓ Treiber schreibt Position pro Frame und drosselt Pegel');

// 2b. Auto-Scroll folgt erst am rechten Rand und dann gedrosselt.
{
  const { state, runFrame } = createHarness(true);
  state.viewport = { offset: 0, duration: 18, trackDuration: 600 };

  state.time = 10; // 10 < 0.9 * 18 = 16.2
  runFrame(1000);
  assert.deepEqual(state.followOffsets, [], 'Vor dem Fensterrand darf die Ansicht nicht springen');

  state.time = 17; // Ziel = 17 - 0.2*18 = 13.4
  runFrame(2000);
  assert.equal(state.followOffsets.length, 1);
  assert.ok(Math.abs(state.followOffsets[0] - 13.4) < 1e-9, `Erwartet 13.4, war ${state.followOffsets[0]}`);

  state.time = 17.2; // Ziel 13.6 -> Abstand 0.2 < Epsilon 0.5
  runFrame(3000);
  assert.equal(state.followOffsets.length, 1, 'Kleine Korrekturen dürfen nicht gemeldet werden');

  state.time = 18.5; // Ziel 14.9 -> Abstand 1.5 > Epsilon
  runFrame(4000);
  assert.equal(state.followOffsets.length, 2, 'Echte Verschiebung muss gemeldet werden');
}
console.log('  ✓ Auto-Scroll meldet nur echte Fensterverschiebungen');

// 2c. Pause: Parkposition exakt übernehmen, Pegel auf 0.
{
  const { state, runFrame } = createHarness(false);
  setTransport({ isPlaying: true });
  setPosition(42);
  state.time = 42.5;
  runFrame(1000);

  assert.equal(getTransport().isPlaying, false);
  assert.equal(getTransport().positionSec, 42.5, 'Parkposition muss exakt übernommen werden');
  assert.deepEqual(getTransport().meters, { left: 0, right: 0 }, 'Pegel muss auf 0 fallen');
}
console.log('  ✓ Pause übernimmt die Parkposition und senkt die Pegel');

resetTransport();
console.log('  ✓ Transport-Store und Playhead-Treiber halten ihre Verträge');
