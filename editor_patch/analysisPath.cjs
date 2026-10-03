/**
 * @license
 * Rekordbox Analysis-Path-Auflösung (editor_patch/analysisPath.cjs)
 *
 * `djmdContent.AnalysisDataPath` wird von Rekordbox **relativ zum
 * Analysis-Data-Root** gespeichert – dem Ordner, den Rekordbox in der
 * `options.json` des rekordboxAgent unter dem Schlüssel
 * `analysis-data-root-path` einträgt (z. B. `D:\PIONEER\Master\share`):
 *
 *   AnalysisDataPath : /PIONEER/USBANLZ/PQT000055.DAT
 *   analysis-data-root-path : D:\PIONEER\Master\share
 *   -> D:\PIONEER\Master\share\PIONEER\USBANLZ\PQT000055.DAT
 *
 * Der Pfad ist ausdrücklich **nicht** relativ zum PIONEER-Medien-Root
 * (`D:\PIONEER`), sondern relativ zu diesem Analysis-Root. Genau so löst der
 * Gate ihn hier auf.
 *
 * Verbindliche Regeln (1:1, kein Ersatz, keine eigene Berechnung):
 *   1. Es werden ausschließlich Kandidaten aus der aufgeschriebenen Pfadangabe
 *      plus bekannten, dokumentierten Rekordbox-Wurzeln gebildet. Es wird nie
 *      nach Dateiname, Titel oder Künstler geraten und nie eine andere
 *      Analyse-Datei genommen, weil die erwartete fehlt.
 *   2. Fehlt die Datei an allen Kandidaten, ist das ein Fehlercode
 *      (`ANLZ_NOT_FOUND`) – der Aufrufer (Master-DB-Gate) bricht ab und rechnet
 *      nichts selbst.
 *   3. Alle Zugriffe sind lesend (`existsSync`/`readFileSync` auf options.json).
 *      Es wird nichts angelegt, geschrieben, umbenannt oder gelöscht.
 */

const path = require('node:path');
const fs = require('node:fs');

/** Schlüssel in rekordboxAgent/storage/options.json. */
const DB_PATH_KEY = 'db-path';
const ANALYSIS_ROOT_KEY = 'analysis-data-root-path';

/** Umgebungs-Override für Diagnosen an fremden/verschobenen Bibliotheken. */
const ANALYSIS_ROOT_ENV = 'AIRODOX_REKORDBOX_ANALYSIS_ROOT';

// ---------------------------------------------------------------------------
// options.json (rein lesend)
// ---------------------------------------------------------------------------

function readJsonIfExists(filePath, io = fs) {
  try {
    if (typeof io.existsSync === 'function' && !io.existsSync(filePath)) return null;
    const raw = io.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function optionsValue(parsed, key) {
  if (!parsed || typeof parsed !== 'object') return null;
  const entries = Array.isArray(parsed.options) ? parsed.options : null;
  if (entries) {
    for (const entry of entries) {
      if (Array.isArray(entry) && entry[0] === key && typeof entry[1] === 'string' && entry[1].trim()) {
        return entry[1].trim();
      }
    }
  }
  const direct = parsed[key];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return null;
}

/** Bekannte, dokumentierte Ablageorte der rekordboxAgent-options.json. */
function optionsFileLocations({ databasePath, env = process.env, platform = process.platform } = {}) {
  const locations = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim() && !locations.includes(value)) locations.push(value);
  };

  // Vom Nutzer ausdrücklich angegebene Datei (Diagnose an Fremdrechnern).
  push(env.AIRODOX_REKORDBOX_OPTIONS);

  if (platform === 'win32' || env.APPDATA) {
    const appData = env.APPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Roaming');
    // Kanonisch als Geschwister der Versionsordner, zusätzlich die alte
    // Ablage innerhalb des Versionsordners.
    push(path.join(appData, 'Pioneer', 'rekordboxAgent', 'storage', 'options.json'));
    push(path.join(appData, 'Pioneer', 'rekordbox7', 'rekordboxAgent', 'storage', 'options.json'));
  }
  if (platform === 'darwin') {
    push(
      path.join(
        env.HOME || '',
        'Library',
        'Application Support',
        'Pioneer',
        'rekordboxAgent',
        'storage',
        'options.json'
      )
    );
  }

  // Bei einer extern geführten Bibliothek (z. B. D:\PIONEER\Master\master.db)
  // kann die options.json als Geschwister des Datenbankordners bzw. darin
  // liegen (D:\PIONEER\rekordboxAgent\storage\options.json).
  if (databasePath) {
    const databaseDir = path.dirname(String(databasePath));
    push(path.join(path.dirname(databaseDir), 'rekordboxAgent', 'storage', 'options.json'));
    push(path.join(databaseDir, 'rekordboxAgent', 'storage', 'options.json'));
  }
  return locations;
}

/**
 * Liest `db-path` und `analysis-data-root-path` aus der options.json.
 * Rein lesend; ohne Fund bleiben beide Felder `null`.
 */
function readRekordboxOptions(options = {}) {
  const { databasePath, env = process.env, platform = process.platform, io = fs } = options;
  for (const filePath of optionsFileLocations({ databasePath, env, platform })) {
    const parsed = readJsonIfExists(filePath, io);
    if (!parsed) continue;
    const dbPath = optionsValue(parsed, DB_PATH_KEY);
    const analysisDataRootPath = optionsValue(parsed, ANALYSIS_ROOT_KEY);
    if (!dbPath && !analysisDataRootPath) continue;
    return { optionsPath: filePath, dbPath, analysisDataRootPath };
  }
  return { optionsPath: null, dbPath: null, analysisDataRootPath: null };
}

// ---------------------------------------------------------------------------
// Wurzeln für relative /PIONEER/...-Pfade
// ---------------------------------------------------------------------------

/** Findet die nächstgelegene PIONEER-Wurzel in einem Datenbank- oder ANLZ-Pfad. */
function pioneerRootFromPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().replace(/\\/g, '/');
  const match = normalized.match(/^(.*?)(?:^|\/)PIONEER(?:\/|$)/i);
  if (!match) return null;
  const prefix = match[1].replace(/\/$/, '');
  return `${prefix}${prefix ? (prefix.includes('\\') ? '\\' : '/') : ''}PIONEER`;
}

/** Eine Wurzel aus options.json/ENV zeigt auf den Ordner, der `PIONEER` enthält. */
function pioneerRootForRoot(root) {
  const trimmed = String(root).trim().replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop() || '';
  return base.toLowerCase() === 'pioneer' ? trimmed : path.join(trimmed, 'PIONEER');
}

function joinPioneerRoot(root, relativePath) {
  const value = String(root);
  return /^[a-z]:[\\/]/i.test(value) || value.includes('\\')
    ? path.win32.join(value, relativePath)
    : path.join(value, relativePath);
}

function dedupeKey(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Geordnete, dokumentierte PIONEER-Wurzeln für relative Analysis-Pfade.
 *
 *   1. `AIRODOX_REKORDBOX_ANALYSIS_ROOT` (expliziter Override, `;`-getrennt)
 *   2. `analysis-data-root-path` aus der options.json  ← maßgeblich
 *   3. PIONEER-Wurzel der Datenbank selbst (umgezogene/exportierte Bibliothek)
 *   4. Standard-Share `%APPDATA%\Pioneer\rekordbox\share\PIONEER`
 *   5. `D:\PIONEER` (vom Nutzer angegebener Export-Root, nur letzter Rückfall)
 *
 * @returns {Array<{path: string, source: string}>}
 */
function analysisRootCandidates(options = {}) {
  const { databasePath, env = process.env, platform = process.platform, io = fs } = options;
  const roots = [];
  const seen = new Set();
  const push = (value, source) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const resolved = pioneerRootForRoot(value);
    const key = dedupeKey(resolved);
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ path: resolved, source });
  };

  // 1. Expliziter Override ist eine exakte Auswahl (fail-closed wie
  //    AIRODOX_REKORDBOX_DB): keine zusätzlichen Wurzeln "on top".
  const override = String(env[ANALYSIS_ROOT_ENV] || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of override) push(entry, 'ENV_ANALYSIS_ROOT');

  // 2. Maßgeblich: analysis-data-root-path aus der options.json des
  //    rekordboxAgent (bei dir D:\PIONEER\Master\share).
  const { analysisDataRootPath } = readRekordboxOptions({ databasePath, env, platform, io });
  if (analysisDataRootPath) push(analysisDataRootPath, 'OPTIONS_ANALYSIS_ROOT');

  // 3. PIONEER-Wurzel der Datenbank selbst.
  const databaseRoot = pioneerRootFromPath(databasePath);
  if (databaseRoot) push(databaseRoot, 'DATABASE_ROOT');

  // 4. Standard-Share der Rekordbox-Installation.
  if (platform === 'win32' || env.APPDATA) {
    const appData = env.APPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Roaming');
    push(path.join(appData, 'Pioneer', 'rekordbox', 'share', 'PIONEER'), 'APPDATA_SHARE');
  }
  if (platform === 'darwin') {
    push(
      path.join(env.HOME || '', 'Library', 'Application Support', 'Pioneer', 'rekordbox', 'share', 'PIONEER'),
      'APPDATA_SHARE'
    );
  }

  // 5. Letzter Rückfall: der vom Nutzer benannte Export-Root.
  push('D:\\PIONEER', 'LEGACY_EXPORT_ROOT');

  return roots;
}

// ---------------------------------------------------------------------------
// Kandidatenliste für einen AnalysisDataPath
// ---------------------------------------------------------------------------

function toLocalPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    if (/^file:/i.test(raw)) {
      const url = new URL(raw);
      const { pathname } = url;
      // Geräte-interne Locations (file://localhost//contents_…) sind keine
      // lokale Datei; sie werden als Pfad durchgereicht und scheitern
      // deterministisch an der Existenzprüfung des Gates.
      return decodeURIComponent(pathname) || null;
    }
  } catch {
    return raw;
  }
  return raw;
}

/**
 * Baut die deterministischen Kandidaten für einen `AnalysisDataPath`.
 *
 * @param {string} rawAnalysisPath Wert aus djmdContent.AnalysisDataPath
 * @param {{databasePath?: string, roots?: Array<{path:string,source:string}|string>,
 *          env?: object, platform?: string, io?: object}} [options]
 * @returns {string[]} geordnete, doppelfreie Kandidaten (nie Pfad-Erfindungen)
 */
function buildAnalysisPathCandidates(rawAnalysisPath, options = {}) {
  const { databasePath, env = process.env, platform = process.platform, io = fs } = options;
  const raw = String(rawAnalysisPath ?? '').trim();
  if (!raw) return [];

  const normalized = raw.replace(/^file:\/\//i, '').replace(/\\/g, '/');
  const driveAbsolute = /^[a-z]:\//i.test(normalized);
  const pioneerMatch = normalized.match(/(?:^|\/)PIONEER\/(.+)$/i);
  const pioneerRootRelative = Boolean(pioneerMatch) && !driveAbsolute;
  let relativePath = pioneerMatch ? pioneerMatch[1] : null;
  if (!relativePath && !driveAbsolute && !normalized.startsWith('/')) {
    relativePath = normalized.replace(/^\/+/, '');
  }
  if (!relativePath && /^\/(?:USBANLZ|ANLZ)\//i.test(normalized)) {
    relativePath = normalized.replace(/^\/+/, '');
  }

  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    const key = dedupeKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const directPath = toLocalPath(raw) || raw;
  // Ein vollständig aufgeschriebener Laufwerkspfad bleibt exakt so erhalten.
  // Er wird ausdrücklich NICHT auf eine andere Wurzel umgeschrieben: sonst
  // könnte ein gleichnamiges ANLZ-Pendant aus einem anderen Ordner als Ersatz
  // für die eigentlich eingetragene Datei genommen werden.
  if (driveAbsolute) return [directPath];
  if (!pioneerRootRelative) add(directPath);
  if (!relativePath) {
    if (pioneerRootRelative) add(directPath);
    return candidates;
  }

  const roots = Array.isArray(options.roots)
    ? options.roots.map((entry) => (typeof entry === 'string' ? { path: entry, source: 'INJECTED' } : entry))
    : analysisRootCandidates({ databasePath, env, platform, io });
  for (const root of roots) {
    if (!root || !root.path) continue;
    add(joinPioneerRoot(root.path, relativePath));
  }
  if (pioneerRootRelative) add(directPath);
  return candidates;
}

module.exports = {
  DB_PATH_KEY,
  ANALYSIS_ROOT_KEY,
  ANALYSIS_ROOT_ENV,
  optionsFileLocations,
  readRekordboxOptions,
  analysisRootCandidates,
  buildAnalysisPathCandidates,
  pioneerRootFromPath,
  pioneerRootForRoot,
  toLocalPath,
};
