/**
 * Transport-Store – die einzige Wahrheit über Wiedergabezeit und Pegel.
 *
 * Warum es diese Datei gibt:
 *   Vorher lagen `currentTime`, `meterL` und `meterR` als React-State in
 *   `App.tsx` und wurden im `requestAnimationFrame`-Loop gesetzt: bei 60 fps
 *   ergaben das ~180 State-Updates pro Sekunde und damit vollständige
 *   Re-Renders der gesamten Anwendung (inklusive Canvas-Komponenten) – auch
 *   dann, wenn sich sichtbar nur eine weiße Linie bewegte.
 *
 *   Diese Datei trennt zwei Arten von Verbrauchern:
 *     - **Selten** (Zustandswechsel): `useTransport(selector)` rendert nur neu,
 *       wenn sich der ausgewählte Wert wirklich ändert. Selektoren müssen
 *       deshalb primitive Werte liefern.
 *     - **Häufig** (jeder Frame): `subscribeTransport(listener)` ohne React.
 *       Canvas-Zeichner und der Playhead-Treiber nutzen diesen Weg.
 *
 *   `positionSec` wird bei jedem Tick geschrieben, `meters` nur gedrosselt
 *   (siehe `src/features/transport/playheadDriver.ts`).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

export interface TransportMeters {
  /** 0..1, Spitzenwert linkes Kanalpaar. */
  left: number;
  /** 0..1, Spitzenwert rechtes Kanalpaar. */
  right: number;
}

export interface TransportState {
  isPlaying: boolean;
  /** Aktuelle Wiedergabeposition in Sekunden (bei Pause: die Parkposition). */
  positionSec: number;
  loopActive: boolean;
  loopStart: number;
  loopEnd: number;
  meters: TransportMeters;
}

const INITIAL_STATE: TransportState = {
  isPlaying: false,
  positionSec: 0,
  loopActive: false,
  loopStart: 0,
  loopEnd: 0,
  meters: { left: 0, right: 0 },
};

let state: TransportState = INITIAL_STATE;
const listeners = new Set<() => void>();

function emit(): void {
  // Kopie der Liste: Listener dürfen sich während der Benachrichtigung abmelden.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      // Ein defekter Zeichner darf die Wiedergabe nicht anhalten.
      console.error('[transportStore] Listener-Fehler:', error);
    }
  }
}

export function setTransport(patch: Partial<TransportState>): void {
  let changed = false;
  for (const key of Object.keys(patch) as (keyof TransportState)[]) {
    const next = patch[key];
    if (next !== undefined && next !== state[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return; // identische Werte erzeugen keinen Render
  state = { ...state, ...patch };
  emit();
}

/**
 * Setzt ausschließlich die Position. Getrennt von `setTransport`, weil dieser
 * Pfad bei jedem Frame läuft und deshalb ohne Objektvergleich auskommen soll.
 */
export function setPosition(positionSec: number): void {
  if (positionSec === state.positionSec) return;
  state = { ...state, positionSec };
  emit();
}

export function setMeters(meters: TransportMeters): void {
  if (meters.left === state.meters.left && meters.right === state.meters.right) return;
  state = { ...state, meters };
  emit();
}

export function getTransport(): TransportState {
  return state;
}

/** Aktuelle Position ohne React – für Befehle, die im Moment des Klicks gelten. */
export function getPositionSec(): number {
  return state.positionSec;
}

export function subscribeTransport(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Nur für primitive oder referenzstabile Selektoren verwenden. */
export function useTransport<T>(select: (snapshot: TransportState) => T): T {
  return useSyncExternalStore(
    subscribeTransport,
    () => select(state),
    () => select(INITIAL_STATE)
  );
}

/**
 * Gedrosselte Position für Anzeigen, die keine 60 fps brauchen (Zeitzähler).
 *
 * Die Position im Store wird pro Frame geschrieben. Ein direkter
 * `useTransport`-Selektor würde die Komponente 60-mal pro Sekunde rendern –
 * für einen Textzähler unnötig. Dieser Hook rendert höchstens alle
 * `intervalMs`; bei stehender Wiedergabe wird der Endwert sofort übernommen,
 * damit nach Pause/Seek kein Zwischenstand stehen bleibt.
 */
export function useThrottledPosition(intervalMs = 100): number {
  const [value, setValue] = useState(() => getTransport().positionSec);

  useEffect(() => {
    let lastUpdate = Number.NEGATIVE_INFINITY;
    return subscribeTransport(() => {
      const transport = getTransport();
      const now = performance.now();
      if (!transport.isPlaying || now - lastUpdate >= intervalMs) {
        lastUpdate = now;
        setValue(transport.positionSec);
      }
    });
  }, [intervalMs]);

  return value;
}

/** Gedrosselte Pegelanzeige (VU-Meter) – Standard 50 ms, also 20 Hz. */
export function useThrottledMeters(intervalMs = 50): TransportMeters {
  const [value, setValue] = useState(() => getTransport().meters);

  useEffect(() => {
    let lastUpdate = Number.NEGATIVE_INFINITY;
    return subscribeTransport(() => {
      const transport = getTransport();
      const now = performance.now();
      if (now - lastUpdate >= intervalMs) {
        lastUpdate = now;
        setValue((previous) =>
          previous.left === transport.meters.left && previous.right === transport.meters.right
            ? previous
            : transport.meters
        );
      }
    });
  }, [intervalMs]);

  return value;
}

/** Für Tests und Projektwechsel: kompletter Reset. */
export function resetTransport(): void {
  state = INITIAL_STATE;
  emit();
}
