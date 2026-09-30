/**
 * @license
 * Rekordbox-Runtime-Preflight (Phase 5/6).
 *
 * Der Master-DB-Gate kann nur arbeiten, wenn das native SQLCipher-Modul
 * (`better-sqlite3-multiple-ciphers`) für die *tatsächlich laufende*
 * Electron-Version kompiliert ist. Ein Build, der das Modul nicht enthält,
 * liefert zur Laufzeit `SQLCIPHER_UNAVAILABLE` – dann ist der Track-Import
 * tot, obwohl der Build "erfolgreich" war.
 *
 * Dieser Preflight beweist das, bevor überhaupt ein Track geladen wird:
 *
 *   1. ELECTRON_VERSION        – welche Electron-/Node-ABI läuft hier?
 *   2. NATIVE_MODULE_RESOLVED  – liegt better-sqlite3-multiple-ciphers vor?
 *   3. NATIVE_MODULE_LOADABLE  – ist das .node-Binary für diese ABI ladbar?
 *   4. SQLCIPHER_FUNCTIONAL     – funktioniert Verschlüsselung/Entschlüsselung?
 *   5. MASTER_DB_READONLY      – öffnet eine echte master.db lesend, und bleibt
 *                                 die Datei dabei byteweise unverändert?
 *
 * Das Modul schreibt niemals in eine Rekordbox-Quelldatei. Schritt 4 beweist
 * den Verschlüsselungsweg über eine isolierte Scratch-Datei im OS-Temp-
 * Verzeichnis (siehe ./rekordboxCipherProbe.cjs – ":memory:" unterstützt
 * PRAGMA key nicht); Schritt 5 vergleicht Größe und mtime der master.db vor
 * und nach dem Zugriff.
 * Das Modul schreibt niemals in eine Rekordbox-Quelldatei. Schritt 4 arbeitet
 * auf einer frisch angelegten temporären Datei im Systemtemp-Verzeichnis
 * (SQLCipher verweigert `PRAGMA key` ausdrücklich bei In-Memory-Datenbanken –
 * „Setting key not supported for in-memory or temporary databases“ – eine
 * In-Memory-Probe wäre also immer rot, auch wenn das Modul einwandfrei läuft);
 * Schritt 5 vergleicht Größe und mtime der master.db vor und nach dem Zugriff.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dbReader = require('./dbReader.cjs');
const cipherProbe = require('./rekordboxCipherProbe.cjs');

const MODULE_NAME = 'better-sqlite3-multiple-ciphers';
const APP_ROOT = path.resolve(__dirname, '..');

const CHECK_IDS = Object.freeze([
  'ELECTRON_VERSION',
  'NATIVE_MODULE_RESOLVED',
  'NATIVE_MODULE_LOADABLE',
  'SQLCIPHER_FUNCTIONAL',
  'MASTER_DB_READONLY',
]);

/** Reads a dependency range from the app manifest without failing if absent. */
function readDeclaredRange(field, appRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    return manifest[field] || '';
  } catch {
    return '';
  }
}

function major(version) {
  const match = /^(\d+)/.exec(String(version || ''));
  return match ? Number(match[1]) : null;
}

/**
 * Turns the three classic native-module failures into an actionable German
 * hint instead of a raw loader stack trace.
 */
function explainNativeModuleError(error) {
  const message = error && error.message ? String(error.message) : String(error);
  if (/NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(message)) {
    return (
      `${message} → Das native Modul wurde für eine andere Electron-/Node-ABI gebaut. ` +
      'Abhilfe: "npm run rekordbox:native:rebuild" (bzw. "npm run package:win", das den Rebuild automatisch ausführt).'
    );
  }
  if (/was compiled against a different Node\.js version using NODE_MODULE_VERSION/i.test(message)) {
    return `${message} → "npm run rekordbox:native:rebuild" ausführen.`;
  }
  if (/Cannot find module/i.test(message)) {
    return `${message} → "npm ci" ausführen; das Modul ist eine Pflichtabhängigkeit.`;
  }
  return message;
}

/**
 * Functional proof of the SQLCipher binding on a throwaway temp file. No
 * Rekordbox source is touched; the probe database is deleted afterwards.
 *
 * A `:memory:` database cannot be used: SQLCipher refuses `PRAGMA key` on
 * in-memory/temporary databases, which would make this check fail even when
 * the module is perfectly healthy.
 */
function probeCipherFunctionality(Database) {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-sqlcipher-probe-'));
  const probePath = path.join(probeDir, 'probe.db');
  try {
    const db = new Database(probePath);
    try {
      db.pragma('cipher = sqlcipher');
      db.pragma('legacy = 4');
      db.pragma(`key = 'airdox-runtime-preflight'`);
      db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT);');
      db.prepare('INSERT INTO probe (value) VALUES (?)').run('rekordbox');
      const row = db.prepare('SELECT count(*) AS n FROM probe').get();
      const stored = db.prepare('SELECT value FROM probe LIMIT 1').get();
      let cipherVersion = null;
      try {
        const result = db.pragma('cipher_version', { simple: true });
        cipherVersion = typeof result === 'object' ? result.cipher_version : result;
      } catch {
        // older SQLCipher builds do not expose cipher_version
      }
      return {
        ok: Number(row && row.n) === 1 && String(stored && stored.value) === 'rekordbox',
        cipherVersion: cipherVersion ? String(cipherVersion) : null,
      };
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      fs.rmSync(probeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function fingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.appRoot]        Repo-/App-Root für das Manifest.
 * @param {boolean} [options.requireDatabase]  Fehlende master.db als FAIL statt SKIP.
 * @param {string} [options.trackId]        TrackID für den read-only Probelauf.
 * @returns {{ok: boolean, checks: Array, electron: object, module: object, database: object}}
 */
function checkRekordboxRuntime(options = {}) {
  const requireDatabase = options.requireDatabase === true;
  const trackId = String(options.trackId || '').trim();
  // `appRoot` ist dokumentiert und erlaubt Tests/Diagnosen, den Preflight
  // gegen einen isolierten App-Root (ohne node_modules) laufen zu lassen.
  const appRoot = options.appRoot ? path.resolve(options.appRoot) : APP_ROOT;
  const checks = [];

  const add = (id, label, status, detail) => {
    checks.push({ id, label, status, detail });
    return checks[checks.length - 1];
  };

  // --- 1. Electron-Version -------------------------------------------------
  const electronVersion = process.versions.electron || null;
  const nodeVersion = process.versions.node || null;
  const modulesAbi = process.versions.modules || null;
  const declaredElectron = readDeclaredRange('devDependencies.electron', appRoot);
  if (!electronVersion) {
    add(
      'ELECTRON_VERSION',
      'Electron-Laufzeit',
      'WARN',
      `Kein Electron-Prozess (Node ${nodeVersion}, ABI ${modulesAbi}). Der Preflight läuft außerhalb der Desktop-App; ` +
      'für den Nachweis muss "npm run rekordbox:doctor" aus dem Electron-Hauptprozess bzw. der installierten App kommen.'
    );
  } else if (declaredElectron && major(declaredElectron) && major(electronVersion) !== major(declaredElectron)) {
    add(
      'ELECTRON_VERSION',
      'Electron-Laufzeit',
      'FAIL',
      `Laufende Electron-Version ${electronVersion} passt nicht zu der im Manifest deklarierten ${declaredElectron}.`
    );
  } else {
    add(
      'ELECTRON_VERSION',
      'Electron-Laufzeit',
      'OK',
      `Electron ${electronVersion}, Node ${nodeVersion}, Modul-ABI ${modulesAbi}` +
      (declaredElectron ? ` (Manifest: ${declaredElectron})` : '')
    );
  }

  // --- 2. Modul vorhanden --------------------------------------------------
  let resolvedPath = null;
  try {
    resolvedPath = require.resolve(MODULE_NAME, { paths: [appRoot] });
    add('NATIVE_MODULE_RESOLVED', 'Native SQLCipher-Modul vorhanden', 'OK', resolvedPath);
  } catch (error) {
    add('NATIVE_MODULE_RESOLVED', 'Native SQLCipher-Modul vorhanden', 'FAIL', explainNativeModuleError(error));
  }

  // --- 3. Modul ladbar -----------------------------------------------------
  let Database = null;
  let moduleVersion = null;
  if (resolvedPath) {
    try {
      // eslint-disable-next-line import/no-extraneous-dependencies, global-require
      Database = require(MODULE_NAME);
      moduleVersion = readModuleVersion(appRoot);
      add('NATIVE_MODULE_LOADABLE', 'Native SQLCipher-Modul ladbar', 'OK', `${MODULE_NAME} geladen (${moduleVersion || 'Version unbekannt'})`);
    } catch (error) {
      add('NATIVE_MODULE_LOADABLE', 'Native SQLCipher-Modul ladbar', 'FAIL', explainNativeModuleError(error));
    }
  } else {
    add('NATIVE_MODULE_LOADABLE', 'Native SQLCipher-Modul ladbar', 'FAIL', `${MODULE_NAME} wurde nicht gefunden – Datenbank kann nicht geöffnet werden.`);
  }

  // --- 4. SQLCipher funktionsfähig -----------------------------------------
  if (Database) {
    try {
      const probe = cipherProbe.probeCipherFunctionality(Database);
      if (!probe.ok) {
        add('SQLCIPHER_FUNCTIONAL', 'SQLCipher funktionsfähig', 'FAIL', 'Verschlüsselte Scratch-Datenbank konnte nicht geschrieben und wieder gelesen werden.');
        add('SQLCIPHER_FUNCTIONAL', 'SQLCipher funktionsfähig', 'FAIL', 'Temporäre Probe-Datenbank konnte nicht verschlüsselt geschrieben und gelesen werden.');
      } else {
        add(
          'SQLCIPHER_FUNCTIONAL',
          'SQLCipher funktionsfähig',
          'OK',
          `Verschlüsselte Scratch-Datenbank im OS-Temp-Verzeichnis geschrieben und wieder entschlüsselt${probe.cipherVersion ? ` (cipher_version ${probe.cipherVersion})` : ''}.`
          `Verschlüsselte temporäre Probe-Datenbank geöffnet${probe.cipherVersion ? ` (cipher_version ${probe.cipherVersion})` : ''}.`
        );
      }
    } catch (error) {
      add('SQLCIPHER_FUNCTIONAL', 'SQLCipher funktionsfähig', 'FAIL', explainNativeModuleError(error));
    }
  } else {
    add('SQLCIPHER_FUNCTIONAL', 'SQLCipher funktionsfähig', 'FAIL', 'Kein ladbares natives Modul – der Cipher wurde nicht ausgeführt.');
  }

  // --- 5. Echte master.db read-only öffnen ---------------------------------
  const database = { path: null, dbType: null, openedReadonly: false, unchanged: null, trackId: trackId || null };
  if (!Database) {
    add('MASTER_DB_READONLY', 'master.db read-only öffnen', 'FAIL', 'Ohne SQLCipher kann keine Rekordbox-Datenbank geöffnet werden.');
  } else {
    let found = [];
    try {
      found = dbReader.locateRekordboxDatabases() || [];
    } catch (error) {
      add('MASTER_DB_READONLY', 'master.db read-only öffnen', 'FAIL', `Datenbanksuche fehlgeschlagen: ${error.message || error}`);
    }
    if (!found.length) {
      const status = requireDatabase ? 'FAIL' : 'SKIP';
      add(
        'MASTER_DB_READONLY',
        'master.db read-only öffnen',
        status,
        'Keine lokale Rekordbox-Datenbank gefunden. Auf einem Rechner ohne Rekordbox-Installation ist dieser Nachweis nicht erbringbar.'
      );
    } else {
      const ordered = found.slice().sort((a, b) => (a.kind === 'MASTER_DB' ? 0 : 1) - (b.kind === 'MASTER_DB' ? 0 : 1));
      const target = ordered[0];
      database.path = target.path;
      database.dbType = target.kind || null;
      const before = fingerprint(target.path);
      try {
        const opened = dbReader.openContentRow(target.path, trackId || '1');
        const after = fingerprint(target.path);
        database.openedReadonly = opened && opened.available === true;
        database.unchanged = Boolean(before && after && before.size === after.size && before.mtimeMs === after.mtimeMs);
        if (!opened || opened.available !== true) {
          add(
            'MASTER_DB_READONLY',
            'master.db read-only öffnen',
            'FAIL',
            `${target.path}: ${(opened && opened.reason) || 'nicht lesbar'}`
          );
        } else if (!database.unchanged) {
          add('MASTER_DB_READONLY', 'master.db read-only öffnen', 'FAIL', `${target.path}: Datei wurde verändert! (Größe/mtime weichen ab)`);
        } else {
          add(
            'MASTER_DB_READONLY',
            'master.db read-only öffnen',
            'OK',
            `${target.path} read-only geöffnet, djmdContent-Abfrage möglich, Datei unverändert (${before.size} Bytes).`
          );
        }
      } catch (error) {
        add('MASTER_DB_READONLY', 'master.db read-only öffnen', 'FAIL', explainNativeModuleError(error));
      }
    }
  }

  const failures = checks.filter((check) => check.status === 'FAIL');
  const warnings = checks.filter((check) => check.status === 'WARN');

  return {
    ok: failures.length === 0,
    platform: process.platform,
    arch: process.arch,
    electronVersion,
    nodeVersion,
    modulesAbi,
    module: { name: MODULE_NAME, version: moduleVersion, path: resolvedPath },
    database,
    checks,
  };
}

function readModuleVersion(appRoot) {
  try {
    const manifestPath = require.resolve(`${MODULE_NAME}/package.json`, { paths: [appRoot || APP_ROOT] });
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version || null;
  } catch {
    return null;
  }
}

const STATUS_LABEL = { OK: 'OK', WARN: 'WARNUNG', FAIL: 'FEHLER', SKIP: 'ÜBERSPRUNGEN' };

/** Renders the preflight result as the plain-text block the doctor prints. */
function formatRekordboxRuntimeReport(result) {
  const lines = [];
  lines.push('SQLCipher runtime:');
  lines.push(`  Electron:        ${result.electronVersion || 'n/a (kein Electron-Prozess)'}`);
  lines.push(`  Node / ABI:      ${result.nodeVersion || 'n/a'} / ${result.modulesAbi || 'n/a'}`);
  lines.push(`  Modul:           ${result.module.name} ${result.module.version || ''}`.trimEnd());
  lines.push(`  Modulpfad:       ${result.module.path || 'nicht gefunden'}`);
  lines.push(`  Datenbank:       ${result.database.path || 'keine gefunden'}`);
  lines.push('');
  for (const check of result.checks) {
    lines.push(`  [${STATUS_LABEL[check.status] || check.status}] ${check.label}`);
    lines.push(`      ${check.detail}`);
  }
  return lines.join('\n');
}

module.exports = {
  MODULE_NAME,
  CHECK_IDS,
  checkRekordboxRuntime,
  formatRekordboxRuntimeReport,
  explainNativeModuleError,
  /**
   * True when at least one check could not be proven. The Windows packaging
   * hook treats this as a build failure: a package that ships without a proven
   * SQLCipher runtime must not be published as "working".
   */
  hasUnprovenChecks: (result) =>
    !result.ok || result.checks.some((check) => check.status === 'WARN'),
};
