/**
 * @license
 * Datenbankort-Bootstrap (Testzwecke).
 *
 * Zu Testzwecken wird beim App-Start explizit gefragt, wo die
 * Rekordbox-Datenbank (master.db / exportLibrary.db) liegt. Dieses Modul
 * enthält die deterministischen, Electron-unabhängigen Teile davon:
 *
 *  - Persistenter Speicher des gewählten Pfads (<userData>/db-location.json)
 *  - Aufbau der Start-Dialogparameter (Buttons, Detailtext, Default-Auswahl)
 *
 * Die eigentlichen Dialoge (Electron `dialog`) laufen in main.cjs und
 * verwenden diese Bausteine. Alle Funktionen sind read-only gegenüber der
 * Rekordbox-Datenbank selbst – hier wird nur ein Pfad verwaltet.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Dateiname des persistenten Datenbankort-Speichers im userData-Verzeichnis. */
const DB_LOCATION_FILE_NAME = 'db-location.json';

function locationFilePath(userDataDir) {
  return path.join(userDataDir, DB_LOCATION_FILE_NAME);
}

/**
 * Liest den gespeicherten Datenbankort.
 * @param {string} userDataDir
 * @returns {{ dbPath: string | null, exists: boolean }}
 *  `exists` sagt aus, ob die gespeicherte Datei aktuell noch existiert.
 */
function loadStoredDbLocation(userDataDir) {
  try {
    const raw = fs.readFileSync(locationFilePath(userDataDir), 'utf-8');
    const parsed = JSON.parse(raw);
    const dbPath =
      typeof parsed === 'string'
        ? parsed
        : parsed && typeof parsed.dbPath === 'string'
          ? parsed.dbPath
          : null;
    if (!dbPath || !dbPath.trim()) return { dbPath: null, exists: false };
    const trimmed = dbPath.trim();
    let exists = false;
    try {
      exists = fs.existsSync(trimmed) && fs.statSync(trimmed).isFile();
    } catch {
      exists = false;
    }
    return { dbPath: trimmed, exists };
  } catch {
    return { dbPath: null, exists: false };
  }
}

/**
 * Speichert den gewählten Datenbankort dauerhaft.
 * @param {string} userDataDir
 * @param {string} dbPath
 * @returns {{ dbPath: string, savedAt: string }}
 */
function saveStoredDbLocation(userDataDir, dbPath) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new Error('Kein gültiger Datenbankpfad übergeben.');
  }
  const payload = { dbPath: dbPath.trim(), savedAt: new Date().toISOString() };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(locationFilePath(userDataDir), JSON.stringify(payload, null, 2), 'utf-8');
  return { dbPath: payload.dbPath, savedAt: payload.savedAt };
}

/** Entfernt den gespeicherten Datenbankort (falls vorhanden). */
function clearStoredDbLocation(userDataDir) {
  try {
    fs.unlinkSync(locationFilePath(userDataDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Baut die Parameter für den Start-Dialog (Electron `dialog.showMessageBox`).
 * Reine Funktion – ohne Electron testbar.
 *
 * @param {{ storedDbPath?: string|null, storedExists?: boolean, candidates?: Array<{path:string,label?:string}> }} [input]
 * @returns {{
 *   title: string,
 *   message: string,
 *   detail: string,
 *   buttons: Array<{ id: 'CHOOSE'|'USE_STORED'|'USE_DETECTED'|'SKIP', label: string }>,
 *   defaultId: number,
 *   cancelId: number,
 * }}
 */
function buildStartupPrompt({ storedDbPath = null, storedExists = false, candidates = [] } = {}) {
  const buttons = [{ id: 'CHOOSE', label: 'Datenbank auswählen…' }];
  let defaultId = 0;

  const hasStored = storedExists && !!storedDbPath;
  if (hasStored) {
    buttons.push({ id: 'USE_STORED', label: 'Gespeicherten Pfad verwenden' });
    defaultId = buttons.length - 1;
  }

  const detected = Array.isArray(candidates) ? candidates.find((c) => c && c.path) : null;
  if (detected) {
    buttons.push({ id: 'USE_DETECTED', label: 'Automatisch erkannte Datenbank verwenden' });
    if (!hasStored) defaultId = buttons.length - 1;
  }

  buttons.push({ id: 'SKIP', label: 'Überspringen' });
  const cancelId = buttons.length - 1;

  const detailLines = [
    'Zu Testzwecken wird beim Start gefragt, wo die Rekordbox-Datenbank liegt.',
    'Die Datenbank wird ausschließlich lesend geöffnet.',
    '',
  ];
  if (storedDbPath) {
    detailLines.push(
      storedExists
        ? `Zuletzt verwendet: ${storedDbPath}`
        : `Zuletzt verwendet: ${storedDbPath} (Datei nicht mehr vorhanden)`
    );
  } else {
    detailLines.push('Zuletzt verwendet: –');
  }
  if (detected) {
    detailLines.push(`Automatisch erkannt (${candidates.length}):`);
    for (const c of candidates.slice(0, 3)) {
      detailLines.push(`  • ${c.label || path.basename(c.path)} → ${c.path}`);
    }
    if (candidates.length > 3) {
      detailLines.push(`  … und ${candidates.length - 3} weitere`);
    }
  } else {
    detailLines.push('Automatisch erkannt: keine');
  }

  return {
    title: 'Rekordbox-Datenbank',
    message: 'Wo liegt die Rekordbox-Datenbank?',
    detail: detailLines.join('\n'),
    buttons,
    defaultId,
    cancelId,
  };
}

module.exports = {
  DB_LOCATION_FILE_NAME,
  loadStoredDbLocation,
  saveStoredDbLocation,
  clearStoredDbLocation,
  buildStartupPrompt,
};
