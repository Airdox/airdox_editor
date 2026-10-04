/**
 * Regressionstest für den Seek-Scheduler und die Zielanzeige der Audio-Engine.
 *
 * Warum dieser Test existiert:
 *   Ein echtes Systemprotokoll zeigte Restart-Stürme während der Wiedergabe.
 *   Die Abstände (die Zeitstempel im Original tragen kein Datum, daher hier als
 *   Abstand notiert) und die Meldungen `Wiedergabe gestartet bei …s` aus
 *   `audioEngine.play()`/`playWithStems()` sahen so aus:
 *
 *     +  0 ms   Wiedergabe gestartet bei 62.190s
 *     + 37 ms   Wiedergabe gestartet bei 62.460s
 *     + 49 ms   Wiedergabe gestartet bei 62.729s
 *     + 67 ms   Wiedergabe gestartet bei 62.729s
 *     +101 ms   Wiedergabe gestartet bei 62.729s
 *     …
 *     +  0 ms   Wiedergabe gestartet bei  89.382s
 *     + 51 ms   Wiedergabe gestartet bei  89.651s
 *
 *   Fünf Neustarts in 101 ms, acht in 155 ms, sechsmal dieselbe Zielposition
 *   (62,729 s) – jeder ein abgerissener und neu gebauter Audiograph. Jeder
 *   Neustart reißt eine laufende `AudioBufferSourceNode` ab – hörbar als Klick.
 *   Der Scheduler muss deshalb:
 *
 *     1. die Position **sofort** melden (Playhead folgt ohne Verzögerung),
 *     2. den teuren Neustart höchstens einmal pro Fenster ausführen,
 *     3. dabei immer die **neueste** Zielposition verwenden,
 *     4. identische Anfragen im selben Fenster ohne zweiten Neustart lassen,
 *     5. nach `cancel()` (Pause/Stop/Trackwechsel) nichts mehr auslösen.
 *
 *   Teil 2 prüft außerdem, dass die Anzeige zwischen Klick und Neustart nicht
 *   auf die alte Tonposition zurückspringt (`audioEngine.setSeekTarget`).
 *
 * Der Test läuft framework-frei in Node: Uhr und Timer sind gestubbt, dadurch
 * ist jeder Ablauf deterministisch und ohne Browser prüfbar.
 */

import assert from 'node:assert/strict';
import { createSeekScheduler, DEFAULT_SEEK_COALESCE_MS, type SeekCoalesceReport } from '../src/features/transport/seekScheduler';
import { audioEngine } from '../src/audio/audioEngine';

// ---------------------------------------------------------------------------
// Virtuelle Uhr: `advance()` feuert fällige Timer deterministisch
// ---------------------------------------------------------------------------
interface VirtualClock {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  advance: (ms: number) => void;
}

function createClock(): VirtualClock {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => current,
    setTimer: (callback, delayMs) => {
      const id = nextId++;
      timers.set(id, { at: current + Math.max(0, delayMs), callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number);
    },
    advance(ms: number) {
      current += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [id, timer] of [...timers]) {
          if (timer.at <= current) {
            timers.delete(id);
            timer.callback();
            fired = true;
          }
        }
      }
    },
  };
}

interface Harness {
  clock: VirtualClock;
  positions: number[];
  restarts: number[];
  releases: number;
  reports: SeekCoalesceReport[];
  scheduler: ReturnType<typeof createSeekScheduler>;
}

function createHarness(): Harness {
  const clock = createClock();
  const positions: number[] = [];
  const restarts: number[] = [];
  const reports: SeekCoalesceReport[] = [];
  const harness: Harness = { clock, positions, restarts, releases: 0, reports, scheduler: null! };
  harness.scheduler = createSeekScheduler({
    applyPosition: (target) => positions.push(target),
    restart: (target) => restarts.push(target),
    releaseOverride: () => {
      harness.releases += 1;
    },
    onCoalesce: (report) => reports.push(report),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return harness;
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  SEEK-SCHEDULER – SPRÜNGE WÄHREND DER WIEDERGABE BÜNDELN');
console.log('═══════════════════════════════════════════════════════════════════');

// ---------------------------------------------------------------------------
// 1 · Ein einzelner Sprung ist sofort sichtbar und sofort hörbar
// ---------------------------------------------------------------------------
{
  const { clock, positions, restarts, scheduler } = createHarness();
  scheduler.seek(12.5);
  assert.deepEqual(positions, [12.5], 'Die Position muss sofort gemeldet werden');
  assert.deepEqual(restarts, [12.5], 'Der erste Sprung darf nicht verzögert werden');
  clock.advance(1000);
  assert.deepEqual(restarts, [12.5], 'Kein zweiter Neustart ohne neue Anfrage');
  assert.equal(scheduler.isPending(), false);
  console.log('  ✓ einzelner Sprung: 1 Neustart, Position sofort');
}

// ---------------------------------------------------------------------------
// 2 · Der Sturm aus dem Log: 5 Anfragen in 101 ms ⇒ 2 Neustarts
// ---------------------------------------------------------------------------
{
  const { clock, positions, restarts, reports, scheduler } = createHarness();
  scheduler.seek(62.19);
  clock.advance(37);
  scheduler.seek(62.46);
  clock.advance(12);
  scheduler.seek(62.729);
  clock.advance(18);
  scheduler.seek(62.729);
  clock.advance(24);
  scheduler.seek(62.729);
  assert.deepEqual(restarts, [62.19], 'Nur der erste Sprung startet sofort neu');
  assert.equal(positions.length, 5, 'Jede Anfrage muss die Anzeige sofort bewegen');
  clock.advance(DEFAULT_SEEK_COALESCE_MS);
  assert.deepEqual(restarts, [62.19, 62.729], 'Alle weiteren Anfragen werden zu einem Neustart gebündelt');
  assert.deepEqual(positions, [62.19, 62.46, 62.729, 62.729, 62.729]);
  assert.equal(reports.length, 1, 'Die Bündelung wird genau einmal gemeldet');
  assert.equal(reports[0].requested, 4, 'Vier Anfragen wurden zusammengefasst');
  assert.equal(reports[0].targetSec, 62.729, 'Der letzte Klick gewinnt');
  console.log(`  ✓ 5 Anfragen in 101 ms ⇒ 2 Neustarts (Bericht: ${reports[0].requested} → 1 bei ${reports[0].targetSec}s)`);
}

// ---------------------------------------------------------------------------
// 3 · Identische Anfragen im selben Fenster lösen keinen zweiten Neustart aus
// ---------------------------------------------------------------------------
{
  // `releases` ist eine Zahl – nicht destrukturieren, sonst wäre es ein
  // Schnappschuss vom Startwert.
  const harness = createHarness();
  const { clock, restarts, reports, scheduler } = harness;
  scheduler.seek(89.382);
  clock.advance(30);
  scheduler.seek(89.382);
  clock.advance(30);
  scheduler.seek(89.382);
  clock.advance(DEFAULT_SEEK_COALESCE_MS);
  assert.deepEqual(restarts, [89.382], 'Der Ton läuft schon dort – kein zweiter Aufbau');
  assert.equal(harness.releases, 1, 'Die Zielanzeige wird wieder freigegeben');
  assert.equal(reports.length, 0, 'Ohne ausgeführten Neustart gibt es nichts zu melden');
  console.log('  ✓ identische Wiederholungen erzeugen keinen zweiten Neustart');
}

// ---------------------------------------------------------------------------
// 4 · Ein echter späterer Sprung an dieselbe Stelle wird ausgeführt
// ---------------------------------------------------------------------------
{
  const { clock, restarts, scheduler } = createHarness();
  scheduler.seek(89.382);
  clock.advance(2000);
  scheduler.seek(89.382);
  assert.deepEqual(restarts, [89.382, 89.382], 'Außerhalb des Fensters ist ein Rücksprung ein echter Sprung');
  console.log('  ✓ späterer Sprung an dieselbe Position wird ausgeführt');
}

// ---------------------------------------------------------------------------
// 5 · Pause/Stop/Trackwechsel: cancel() verwirft offene Arbeit
// ---------------------------------------------------------------------------
{
  const { clock, restarts, scheduler } = createHarness();
  scheduler.seek(10);
  clock.advance(40);
  scheduler.seek(20);
  assert.equal(scheduler.isPending(), true, 'Während des Fensters ist ein Neustart offen');
  assert.equal(scheduler.pendingTarget(), 20);
  scheduler.cancel();
  assert.equal(scheduler.isPending(), false);
  clock.advance(5000);
  assert.deepEqual(restarts, [10], 'Nach dem Abbruch darf kein Neustart mehr feuern');
  console.log('  ✓ cancel() verhindert, dass ein geplanter Neustart nach der Pause startet');
}

// ---------------------------------------------------------------------------
// 6 · Die neueste Position gewinnt auch kurz vor dem Fensterrand
// ---------------------------------------------------------------------------
{
  const { clock, restarts, scheduler } = createHarness();
  scheduler.seek(1);
  clock.advance(120);
  scheduler.seek(2);
  clock.advance(10);
  scheduler.seek(3);
  clock.advance(DEFAULT_SEEK_COALESCE_MS);
  assert.deepEqual(restarts, [1, 3], 'Der Neustart muss die zuletzt gewünschte Position nehmen');
  console.log('  ✓ neueste Zielposition gewinnt (Trailing Edge)');
}

// ---------------------------------------------------------------------------
// 7 · Audio-Engine: die Anzeige springt zwischen Klick und Neustart nicht zurück
// ---------------------------------------------------------------------------
{
  // Die Felder sind privat; der Test setzt sie bewusst direkt, weil ein echter
  // AudioContext in Node nicht existiert. Genau diese Kombination ist der Fall
  // „Wiedergabe läuft, Sprung ist vorgemerkt“.
  const engine = audioEngine as unknown as {
    isPlaying: boolean;
    startTime: number;
    pauseOffset: number;
    ctx: unknown;
    activeBuffer: unknown;
  };
  const previous = { ...engine };
  engine.isPlaying = true;
  engine.startTime = 0;
  engine.pauseOffset = 0;
  engine.ctx = { currentTime: 10 };
  engine.activeBuffer = { duration: 100 };

  assert.equal(audioEngine.getCurrentTime(), 10, 'Ohne Sprung zählt die echte Tonposition');
  audioEngine.setSeekTarget(42);
  assert.equal(audioEngine.getCurrentTime(), 42, 'Mit vorgemerktem Sprung folgt die Anzeige dem Klick');
  audioEngine.clearSeekTarget();
  assert.equal(audioEngine.getCurrentTime(), 10, 'Nach dem Neustart gilt wieder die Tonposition');
  audioEngine.stop();
  assert.equal(audioEngine.getCurrentTime(), 0, 'stop() verwirft ein offenes Sprungziel');

  Object.assign(engine, previous);
  console.log('  ✓ audioEngine.getCurrentTime() folgt dem Klick und fällt nicht zurück');
}

console.log('\n  Ergebnis: Sprünge werden gebündelt, die Anzeige bleibt sofort und ehrlich.');
