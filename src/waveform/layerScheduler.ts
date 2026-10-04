/**
 * Layer-Scheduler für Canvas-Zeichnungen.
 *
 * Warum es diese Datei gibt:
 *   Der Detail-Wellenform-Renderer zeichnete bisher in einem einzigen
 *   `requestAnimationFrame`-Loop, der nie endete: nach dem letzten
 *   Prop-Wechsel lief er weiter und malte dieselbe Szene (~2,4–4,0 ms pro
 *   Frame, gemessen mit `npm run bench`) – auch bei pausierter Wiedergabe und
 *   stehender Maus.
 *
 *   Der Scheduler trennt in einen teuren **Basis-Layer** (Wellenform,
 *   Beatgrid, Parts, Cues – ändert sich nur bei Track/Ansicht/Zoom) und einen
 *   günstigen **Overlay-Layer** (Auswahl, Hover-Führung, Playhead – ändert
 *   sich pro Interaktion oder Frame). Er entscheidet pro Frame, was wirklich
 *   neu gezeichnet werden muss; im Leerlauf zeichnet er **gar nichts**.
 *
 *   Die Datei ist bewusst frei von React und DOM, damit die Entscheidungslogik
 *   in Node getestet werden kann (siehe tests/waveform-layer-scheduler.test.ts).
 */

export interface LayerPlan {
  /** Basis-Layer muss neu gezeichnet werden. */
  base: boolean;
  /** Overlay-Layer muss neu gezeichnet werden. */
  overlay: boolean;
}

export interface LayerScheduler {
  /** Basis geändert – erzwingt zusätzlich ein neues Overlay. */
  markBase(): void;
  /** Nur Overlay geändert (Playhead, Auswahl, Hover). */
  markOverlay(): void;
  /** Holt den Plan für genau einen Frame und setzt die Markierungen zurück. */
  take(): LayerPlan;
  /** Nur für Tests/Diagnose: liegt Arbeit an, ohne sie zu verbrauchen? */
  isDirty(): boolean;
}

export function createLayerScheduler(): LayerScheduler {
  let baseDirty = true;
  let overlayDirty = true;

  return {
    markBase() {
      baseDirty = true;
      // Eine neue Basis bedeutet neue Geometrie: das Overlay sitzt darauf.
      overlayDirty = true;
    },
    markOverlay() {
      overlayDirty = true;
    },
    take() {
      const plan: LayerPlan = { base: baseDirty, overlay: overlayDirty };
      baseDirty = false;
      overlayDirty = false;
      return plan;
    },
    isDirty() {
      return baseDirty || overlayDirty;
    },
  };
}
