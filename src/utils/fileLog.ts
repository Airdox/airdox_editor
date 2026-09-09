/**
 * @license
 * Durable file logging bridge (renderer side).
 *
 * Mirrors every LoggerService entry into the desktop log file
 * (`<userData>/airdox-smart-editor.log`, rotated at 5 MB) so the decisive
 * pipeline parameters — ANLZ resolution, file sizes, tags, waveform variants,
 * merge verdicts — survive the session and diagnose a missing waveform after
 * the fact. In a browser (no Electron bridge) file logging degrades to a
 * no-op. Initialization is idempotent; logging never throws into the app.
 */

import { logger, LogEntry } from './logger';

let initialized = false;
let unsubscribe: (() => void) | null = null;

function mirrorToFile(entry: LogEntry) {
  const bridge = window.rekordboxDesktop;
  if (!bridge?.appendLog) return;
  // Fire-and-forget with a swallowed rejection: a log write must never
  // surface as an app error (which would then log about logging…).
  bridge
    .appendLog({
      ts: entry.timestamp,
      level: entry.level,
      category: entry.category,
      message: entry.message,
      data: entry.details,
    })
    .catch(() => {});
}

/**
 * Starts mirroring all logger entries into the durable desktop log file.
 * Returns the unsubscribe function (subsequent calls return no-ops).
 */
export function initFileLogging(): () => void {
  if (initialized) return () => {};
  initialized = true;

  if (typeof window === 'undefined' || !window.rekordboxDesktop?.appendLog) {
    logger.info('SYSTEM', 'Datei-Logging nicht verfügbar (kein Desktop-Bridge); nur In-App-Log aktiv.');
    return () => {};
  }

  unsubscribe = logger.subscribe(mirrorToFile);
  window.rekordboxDesktop
    .getLogFilePath?.()
    .then((p) => {
      if (p) {
        logger.info('SYSTEM', `Datei-Logging aktiv — entscheidende Parameter werden in ${p} geschrieben (Rotation 5 MB).`);
      }
    })
    .catch(() => {});

  return () => {
    unsubscribe?.();
    unsubscribe = null;
    initialized = false;
  };
}
