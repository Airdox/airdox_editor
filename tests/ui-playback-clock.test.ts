/**
 * @license
 * UI-Playback-Clock & Transport-Position Regression Suite.
 *
 * Performance-Kontrakt (Reaktion der Bedienung): Playhead und VU-Meter dürfen
 * NIEMALS über React-State pro Frame verteilt werden – vorher hat eine rAF-
 * Schleife in App.tsx 60×/s die komplette App neu gerendert, sodass Buttons
 * erst Sekunden nach dem Klick reagierten. Diese Suite sichert die neuen
 * Bausteine:
 *   1. playbackClock: eine einzige rAF-Loop, Subscriber-Lebenszyklus, keine
 *      Loop ohne Subscriber.
 *   2. Transport-Position: stop() setzt Position 0 (wie alle Stopp-Stellen
 *      der UI), setTransportPosition() setzt die Playhead-Position im
 *      Pausenzustand, getCurrentTime() liefert sie frame-genau zurück.
 */

import assert from 'node:assert/strict';
import { audioEngine } from '../src/audio/audioEngine';
import { playbackClock } from '../src/audio/playbackClock';

// ─── rAF-Stub: realistisches Handle-Management wie im Browser ───────────────
type RafCallback = (t: number) => void;
const rafHandles = new Map<number, RafCallback>();
let nextRafHandle = 1;
let rafActive = false;

(globalThis as unknown as { requestAnimationFrame: (cb: RafCallback) => number }).requestAnimationFrame = (cb: RafCallback) => {
  const handle = nextRafHandle++;
  rafHandles.set(handle, cb);
  return handle;
};
(globalThis as unknown as { cancelAnimationFrame: (handle: number) => void }).cancelAnimationFrame = (handle: number) => {
  rafHandles.delete(handle);
};

function pumpRaf(times = 1): void {
  for (let i = 0; i < times; i++) {
    const entries = [...rafHandles.values()];
    rafHandles.clear();
    for (const cb of entries) cb(0);
  }
}

function scheduledRafCount(): number {
  return rafHandles.size;
}

function framesObserved(): void {
  rafActive = true;
}

let testIndex = 0;
function section(name: string): void {
  testIndex += 1;
  console.log(`[${testIndex}] ${name}`);
}

async function testClockLifecycle(): Promise<void> {
  section('playbackClock: Loop läuft nur mit Subscribern');

  const frames: number[] = [];
  let unsub = playbackClock.subscribe(() => {
    frames.push(frames.length);
  });
  assert.ok(scheduledRafCount() >= 1, 'Subscribe muss die rAF-Loop starten');

  pumpRaf(3);
  assert.equal(frames.length, 3, 'Jeder gepumpte Frame muss an Subscriber gehen');

  unsub();
  pumpRaf(5);
  assert.equal(frames.length, 3, 'Nach Unsubscribe dürfen keine Frames mehr kommen');
  assert.equal(scheduledRafCount(), 0, 'Ohne Subscriber darf keine rAF-Loop mehr geplant sein');

  section('playbackClock: mehrere Subscriber, gemeinsame Loop');
  let a = 0;
  let b = 0;
  const unsubA = playbackClock.subscribe(() => { a += 1; });
  const unsubB = playbackClock.subscribe(() => { b += 1; });
  assert.equal(scheduledRafCount(), 1, 'Zwei Subscriber teilen sich EINE Loop');
  pumpRaf(2);
  assert.equal(a, 2);
  assert.equal(b, 2);
  unsubA();
  pumpRaf(1);
  assert.equal(a, 2, 'Abbestellter Subscriber erhält nichts mehr');
  assert.equal(b, 3, 'Verbleibender Subscriber läuft weiter');
  unsubB();
  pumpRaf(2);
  assert.equal(b, 3, 'Nach dem letzten Unsubscribe stoppt die Loop');
  assert.equal(scheduledRafCount(), 0, 'Keine geplanten rAF-Callbacks mehr');
}

async function testTransportPosition(): Promise<void> {
  section('Transport: stop() setzt Position 0 (UI-Kontrakt)');
  audioEngine.setTransportPosition(0);
  audioEngine.stop();
  assert.equal(audioEngine.getCurrentTime(), 0, 'stop() muss die Transport-Position zurücksetzen');

  section('Transport: setTransportPosition im Pausenzustand');
  audioEngine.setTransportPosition(41.37);
  assert.ok(Math.abs(audioEngine.getCurrentTime() - 41.37) < 1e-9, 'getCurrentTime() muss die gesetzte Position liefern');

  section('Transport: setTransportPosition clampt negative Werte');
  audioEngine.setTransportPosition(-5);
  assert.equal(audioEngine.getCurrentTime(), 0, 'Negative Positionen werden auf 0 geklemmt');

  section('Transport: stop() nach gesetzter Position → wieder 0');
  audioEngine.setTransportPosition(12.5);
  audioEngine.stop();
  assert.equal(audioEngine.getCurrentTime(), 0);

  section('Clock-Frame liefert Engine-Position (Pausenzustand)');
  audioEngine.setTransportPosition(3.25);
  let observed = -1;
  const unsub = playbackClock.subscribe((frame) => {
    observed = frame.time;
    framesObserved();
  });
  pumpRaf(1);
  unsub();
  assert.ok(Math.abs(observed - 3.25) < 1e-9, `Frame muss die Engine-Position tragen (bekam ${observed})`);
  assert.ok(rafActive, 'Frame-Callback muss gefeuert haben');

  section('Clock-Frame: Meter bleibt im Pausenzustand bei 0');
  let meterObserved = -1;
  const unsubMeter = playbackClock.subscribe((frame) => {
    meterObserved = frame.meter.left + frame.meter.right;
  });
  pumpRaf(1);
  unsubMeter();
  assert.equal(meterObserved, 0, 'Ohne Wiedergabe darf kein Pegel anliegen');
}

async function main(): Promise<void> {
  await testClockLifecycle();
  await testTransportPosition();
  console.log('\nAlle UI-Playback-Clock-Tests bestanden.');
}

await main();
