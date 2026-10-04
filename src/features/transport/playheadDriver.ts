/**
 * Playhead-Treiber – der einzige Ort, der die Wiedergabezeit abfragt.
 *
 * Warum es diese Datei gibt:
 *   Vorher setzte ein `requestAnimationFrame`-Loop in `App.tsx` drei
 *   React-States pro Frame (`currentTime`, `meterL`, `meterR`) und schrieb
 *   zusätzlich `viewOffset`, wodurch der Loop sich wegen seiner eigenen
 *   Dependency-Liste jeden Frame neu registrierte.
 *
 *   Der Treiber kennt kein React. Er liest die Position aus der Audio-Engine
 *   und schreibt sie in den Transport-Store; alles Sichtbare (Canvas,
 *   Zähler, VU-Meter) hängt sich dort an. Die Zustandsänderung „läuft/läuft
 *   nicht" wird nur gemeldet, wenn sie sich wirklich ändert.
 *
 *   Der Auto-Scroll (Ansicht folgt dem Playhead) meldet sich gedrosselt über
 *   `onFollowOffsetChange`, damit die Ansichtsposition nicht 60-mal pro
 *   Sekunde in den React-State wandert.
 */

import { setMeters, setPosition, setTransport, getTransport } from '../../state/transportStore';

export interface PlaybackPort {
  getCurrentTime(): number;
  getIsPlaying(): boolean;
  getMasterMeter(): { left: number; right: number };
}

export interface PlayheadDriverOptions {
  /** Port zur Audio-Engine (im Test ersetzbar). */
  port: PlaybackPort;
  /** Aktuelles Ansichtsfenster; wird für den Auto-Scroll gebraucht. */
  getViewport(): { offset: number; duration: number; trackDuration: number };
  /** Wird nur bei einer echten Verschiebung gerufen (gedrosselt, s. u.). */
  onFollowOffset?: (offset: number) => void;
  /** Pegelrate in Millisekunden (VU-Meter brauchen keine 60 Hz). */
  meterIntervalMs?: number;
  /** Minimale Verschiebung der Ansicht in Sekunden, bevor gemeldet wird. */
  followEpsilonSec?: number;
  /** rAF-Ersatz für Tests. */
  requestFrame?: (callback: (timestampMs: number) => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface PlayheadDriverHandle {
  stop(): void;
  /** Nur für Tests: einen Frame ausführen, ohne auf rAF zu warten. */
  tick(timestampMs?: number): void;
  isRunning(): boolean;
}

const DEFAULT_METER_INTERVAL_MS = 50; // 20 Hz
const DEFAULT_FOLLOW_EPSILON_SEC = 0.5;

export function startPlayheadDriver(options: PlayheadDriverOptions): PlayheadDriverHandle {
  const {
    port,
    getViewport,
    onFollowOffset,
    meterIntervalMs = DEFAULT_METER_INTERVAL_MS,
    followEpsilonSec = DEFAULT_FOLLOW_EPSILON_SEC,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (handle) => cancelAnimationFrame(handle),
  } = options;

  let frameHandle = 0;
  let running = true;
  let lastMeterAt = -Infinity;
  let lastReportedOffset = Number.NaN;

  const tick = (timestampMs?: number) => {
    if (!running) return;
    const now = typeof timestampMs === 'number' ? timestampMs : performance.now();
    const isPlaying = port.getIsPlaying();

    if (isPlaying !== getTransport().isPlaying) {
      setTransport({ isPlaying });
      if (!isPlaying) {
        // Pause/Stop: Position exakt übernehmen und Meter auf 0 fahren.
        setPosition(port.getCurrentTime());
        setMeters({ left: 0, right: 0 });
      }
    }

    if (isPlaying) {
      setPosition(port.getCurrentTime());

      if (now - lastMeterAt >= meterIntervalMs) {
        const meter = port.getMasterMeter();
        setMeters({ left: meter.left, right: meter.right });
        lastMeterAt = now;
      }

      if (onFollowOffset) {
        const { offset, duration, trackDuration } = getViewport();
        const position = getTransport().positionSec;
        // Fenster folgt erst kurz vor dem rechten Rand – wie bisher in App.tsx.
        if (position > offset + duration * 0.9) {
          const next = Math.max(0, Math.min(position - duration * 0.2, Math.max(0, trackDuration - duration)));
          if (!Number.isFinite(lastReportedOffset) || Math.abs(next - lastReportedOffset) >= followEpsilonSec) {
            lastReportedOffset = next;
            onFollowOffset(next);
          }
        }
      }
    }

    frameHandle = requestFrame(tick);
  };

  frameHandle = requestFrame(tick);

  return {
    stop() {
      running = false;
      if (frameHandle) cancelFrame(frameHandle);
      frameHandle = 0;
    },
    tick(timestampMs?: number) {
      tick(timestampMs);
    },
    isRunning() {
      return running;
    },
  };
}
