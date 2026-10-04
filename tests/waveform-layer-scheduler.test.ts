/**
 * Regressionstest für den Layer-Scheduler der Wellenform.
 *
 * Warum dieser Test existiert:
 *   Die Detail-Wellenform zeichnete in einem nie endenden rAF-Loop; im
 *   Leerlauf wurden damit weiter ~2,4–4,0 ms pro Frame verbraucht. Der
 *   Scheduler entscheidet, ob Basis- und Overlay-Layer gezeichnet werden
 *   müssen. Der teure Basis-Layer darf nur bei geänderter Ansicht laufen,
 *   das Overlay (Playhead/Auswahl/Hover) bei jeder Interaktion – und im
 *   Leerlauf **nichts**.
 */

import assert from 'node:assert/strict';
import { createLayerScheduler } from '../src/waveform/layerScheduler';

// 1. Kalter Start: beide Layer sind einmal fällig.
const scheduler = createLayerScheduler();
assert.deepEqual(scheduler.take(), { base: true, overlay: true }, 'Start zeichnet beide Layer');

// 2. Leerlauf: keine Arbeit, kein Frame – das ist der Kern der Optimierung.
assert.equal(scheduler.isDirty(), false, 'Nach dem Zeichnen ist nichts mehr zu tun');
assert.deepEqual(scheduler.take(), { base: false, overlay: false }, 'Leerlauf zeichnet nichts');
assert.deepEqual(scheduler.take(), { base: false, overlay: false }, 'Auch der zweite Leerlauf-Frame zeichnet nichts');

// 3. Nur Playhead/Auswahl bewegt sich: Basis bleibt unberührt.
scheduler.markOverlay();
assert.equal(scheduler.isDirty(), true);
assert.deepEqual(scheduler.take(), { base: false, overlay: true }, 'Positionswechsel zeichnet nur das Overlay');
assert.deepEqual(scheduler.take(), { base: false, overlay: false });

// 4. Zoom/Pan/Trackwechsel: Basis und Overlay.
scheduler.markBase();
assert.deepEqual(scheduler.take(), { base: true, overlay: true }, 'Neue Basis braucht auch ein neues Overlay');

// 5. Mehrfache Markierungen innerhalb eines Frames kollabieren zu einem Plan.
scheduler.markOverlay();
scheduler.markOverlay();
scheduler.markBase();
scheduler.markOverlay();
assert.deepEqual(scheduler.take(), { base: true, overlay: true });
assert.deepEqual(scheduler.take(), { base: false, overlay: false }, 'Markierungen sind verbraucht');

// 6. Ein Basis-Repaint allein darf das Overlay nicht vergessen.
scheduler.markBase();
scheduler.take();
scheduler.markBase();
assert.deepEqual(scheduler.take(), { base: true, overlay: true }, 'Basis-Änderung zieht das Overlay mit');

console.log('  ✓ Layer-Scheduler zeichnet im Leerlauf nichts und trennt Basis/Overlay korrekt');
