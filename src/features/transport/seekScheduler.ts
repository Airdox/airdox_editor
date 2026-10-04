/**
 * Seek-Scheduler – bündelt Sprünge während der Wiedergabe.
 *
 * Warum diese Datei existiert:
 *   Im Systemprotokoll eines echten Laufs stehen Restart-Stürme:
 *
 *     21:59:37.587  Wiedergabe gestartet bei 62.190s
 *     21:59:37.624  Wiedergabe gestartet bei 62.460s
 *     21:59:37.636  Wiedergabe gestartet bei 62.729s
 *     21:59:37.654  Wiedergabe gestartet bei 62.729s
 *     21:59:37.688  Wiedergabe gestartet bei 62.729s
 *     …
 *     22:53:08.006  Wiedergabe gestartet bei 110.920s
 *     22:53:08.083  Wiedergabe gestartet bei 109.843s
 *
 *   Fünf Neustarts in 101 ms, sechsmal dieselbe Zielposition – jeder davon ein
 *   `AudioBufferSourceNode`, der abgerissen und neu aufgebaut wurde. Hörbar
 *   sind Klicks und Aussetzer; mit angeschlossenem DDJ-FLX4 erzeugt jeder
 *   Jog-Tick einen Neustart, weil `--seek`-Impulse einzeln durchgereicht wurden.
 *   Der Web-Audio-Graph kennt kein „Seek“ auf einer laufenden Source – ein
 *   Sprung **muss** neu aufsetzen. Er muss es nur nicht sechsmal tun.
 *
 * Arbeitsweise:
 *   - `applyPosition(target)` läuft **sofort** bei jeder Anfrage: Playhead und
 *     Zeitanzeige folgen dem Klick ohne Verzögerung.
 *   - `restart(target)` läuft **gedrosselt** (Standard 150 ms) und immer mit der
 *     **neuesten** Zielposition (Trailing Edge – der letzte Klick gewinnt).
 *   - Anfragen innerhalb des Fensters mit derselben Zielposition erzeugen keinen
 *     zweiten Neustart: dort läuft der Ton schon.
 *   - `cancel()` verwirft offene Arbeit (Pause, Stop, Trackwechsel) – sonst
 *     könnte ein geplanter Neustart die Wiedergabe nach dem Pausieren wieder
 *     starten.
 *
 * Die Datei ist bewusst frei von React und von der Audio-Engine: die Aufrufer
 * liefern beide Pfade herein, dadurch ist das Verhalten ohne Browser prüfbar
 * (`tests/seek-scheduler.test.ts`).
 */

export interface SeekCoalesceReport {
  /** Anfragen, die zu diesem einen Neustart zusammengefasst wurden. */
  requested: number;
  /** Zielposition des ausgeführten Neustarts in Sekunden. */
  targetSec: number;
}

export interface SeekSchedulerOptions {
  /** Billiger Pfad: Position sofort sichtbar machen (Store + Engine-Ziel). */
  applyPosition: (targetSec: number) => void;
  /** Teurer Pfad: Audiograph bei `targetSec` neu aufsetzen. */
  restart: (targetSec: number) => void;
  /**
   * Wird gerufen, wenn ein Neustart bewusst **nicht** ausgeführt wird, weil der
   * Ton bereits an dieser Position läuft (identische Anfrage im selben Fenster).
   * Der Aufrufer soll die „Zielanzeige“ dann wieder freigeben.
   */
  releaseOverride?: () => void;
  /** Mindestabstand zwischen zwei Neustarts in Millisekunden (Standard 150). */
  minIntervalMs?: number;
  /** Meldung, wenn Anfragen zusammengefasst wurden – Beweis im Systemprotokoll. */
  onCoalesce?: (report: SeekCoalesceReport) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface SeekScheduler {
  /** Neue Zielposition: sofort sichtbar, Neustart höchstens im Fenstertakt. */
  seek: (targetSec: number) => void;
  /** Offene Arbeit verwerfen (Pause/Stop/Trackwechsel) – ohne Neustart. */
  cancel: () => void;
  /** Nur für Tests und Anzeigen. */
  isPending: () => boolean;
  pendingTarget: () => number | null;
}

export const DEFAULT_SEEK_COALESCE_MS = 150;

export function createSeekScheduler(options: SeekSchedulerOptions): SeekScheduler {
  const {
    applyPosition,
    restart,
    releaseOverride,
    minIntervalMs = DEFAULT_SEEK_COALESCE_MS,
    onCoalesce,
    now = () => Date.now(),
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (handle) => clearTimeout(handle),
  } = options;

  let pending: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRestartTarget: number | null = null;
  let lastRestartAt = Number.NEGATIVE_INFINITY;
  let requestsInWindow = 0;
  /**
   * Wahr, wenn der anstehende Neustart **gedrosselt** wurde (die Anfrage kam
   * innerhalb des Fensters). Nur dann darf eine identische Zielposition den
   * Aufbau überspringen: Sie bedeutet „der Ton läuft schon dorthin“. Ein
   * späterer, echter Rücksprung an dieselbe Stelle (außerhalb des Fensters)
   * wird dagegen ausgeführt.
   */
  let throttled = false;

  const stopTimer = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const execute = (): void => {
    stopTimer();
    const target = pending;
    pending = null;
    if (target === null) return;

    if (throttled && target === lastRestartTarget) {
      // Der Ton läuft bereits genau dorthin – ein zweiter Aufbau wäre nur ein
      // weiterer Klick. Nur die Zielanzeige wird freigegeben.
      requestsInWindow = 0;
      releaseOverride?.();
      return;
    }

    const requested = requestsInWindow;
    requestsInWindow = 0;
    lastRestartTarget = target;
    lastRestartAt = now();
    restart(target);
    if (requested > 1) onCoalesce?.({ requested, targetSec: target });
  };

  return {
    seek(targetSec: number): void {
      const target = Math.max(0, targetSec);
      pending = target;
      requestsInWindow += 1;
      // Anzeige sofort – unabhängig davon, wann der Graph neu aufgebaut wird.
      applyPosition(target);

      const dueIn = lastRestartAt + minIntervalMs - now();
      if (dueIn <= 0) {
        throttled = false;
        execute();
        return;
      }
      // Trailing Edge: kein Timer pro Anfrage. Ein laufender Timer nimmt beim
      // Feuern die dann aktuelle Zielposition – der letzte Klick gewinnt.
      throttled = true;
      if (timer === null) {
        timer = setTimer(execute, dueIn);
      }
    },

    cancel(): void {
      stopTimer();
      pending = null;
      requestsInWindow = 0;
      throttled = false;
      releaseOverride?.();
    },

    isPending(): boolean {
      return pending !== null || timer !== null;
    },

    pendingTarget(): number | null {
      return pending;
    },
  };
}
