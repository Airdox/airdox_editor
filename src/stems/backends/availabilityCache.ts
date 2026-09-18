/**
 * Backend-Verfügbarkeit – einmal messen, mehrfach lesen.
 *
 * Der Statusaufruf des Editors und der Job-Start müssen dieselbe Antwort
 * bekommen. Vorher probte jeder Aufruf jedes Backend erneut (und zwar
 * sequenziell), was im Produktionslog als 7–21 s pro `stems:engine-status`
 * sichtbar wurde – und was zusätzlich bedeutete, dass die Profil-Matrix eine
 * andere Meinung haben konnte als der Job: die Matrix fragte die Laufzeit ab,
 * `start()`/`resolveModel()` prüften nur, ob die Gewichte auf der Platte liegen.
 *
 * Dieser Cache macht daraus eine Wahrheit:
 *  - single-flight: parallele Aufrufe teilen sich den laufenden Probe,
 *  - TTL: positive Antworten 5 min, negative 15 s (nachinstallierte Runtimes
 *    werden also schnell sichtbar),
 *  - Schlüssel: Backend-Identität + Modell + Gerät, damit zwei Modelle
 *    derselben Familie mit unterschiedlichen Gewichten nicht kollidieren.
 *
 * Die Aussage bleibt unverändert streng: „available“ heißt, dass der Probe des
 * Backends (Torch-Import, ONNX-Runtime, natives Binary) erfolgreich war.
 */
import type { BackendAvailability, IStemSeparator } from './types';

export interface BackendAvailabilityCacheOptions {
  ttlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  at: number;
  report: BackendAvailability;
}

export class BackendAvailabilityCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<BackendAvailability>>();
  private readonly probes = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;

  constructor(options: BackendAvailabilityCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.negativeTtlMs = options.negativeTtlMs ?? 15 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Liefert das (ggf. gecachte) Ergebnis; `probe` läuft höchstens einmal. */
  async resolve(key: string, probe: () => Promise<BackendAvailability>): Promise<BackendAvailability> {
    const cached = this.entries.get(key);
    if (cached) {
      const ttl = cached.report.available ? this.ttlMs : this.negativeTtlMs;
      if (this.now() - cached.at < ttl) return cached.report;
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const task = probe()
      .then((report) => {
        this.entries.set(key, { at: this.now(), report });
        return report;
      })
      .catch((error: unknown) => {
        // Ein werfender Probe ist eine Aussage über die Umgebung, kein Absturz:
        // als „nicht verfügbar“ cachen, damit der Statusaufruf nicht 500 wird.
        const report: BackendAvailability = {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
        this.entries.set(key, { at: this.now(), report });
        return report;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    this.probes.set(key, (this.probes.get(key) ?? 0) + 1);
    return task;
  }

  /** Wie oft für diesen Schlüssel wirklich gemessen wurde (Diagnose/Tests). */
  probeCount(key?: string): number {
    if (key !== undefined) return this.probes.get(key) ?? 0;
    let total = 0;
    for (const value of this.probes.values()) total += value;
    return total;
  }

  /** Einträge verwerfen – z. B. direkt nach einer Installation. */
  clear(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
      this.probes.clear();
      return;
    }
    this.entries.delete(key);
    this.probes.delete(key);
  }
}

/**
 * Stabiler Schlüssel für ein Backend + Modell. `availabilityKey` setzen die
 * Backends selbst (Interpreter-Pfad, Model-Store, Gerät); der Rest fällt auf
 * Kind/Name zurück.
 */
export function availabilityCacheKey(
  candidate: IStemSeparator,
  descriptorId: string,
  device?: string,
  options: { fast?: boolean } = {}
): string {
  const identity = candidate.availabilityKey ?? `${candidate.kind}:${candidate.name}`;
  // Die Prüftiefe gehört in den Schlüssel: ein schnelles Verdikt (find_spec)
  // ist nicht dasselbe wie ein echter Modul-Import.
  return `${identity}|${descriptorId}|${device ?? 'auto'}|${options.fast ? 'fast' : 'strict'}`;
}
