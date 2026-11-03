const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CONFIG_FILE = 'stem-storage-root.json';

function defaultRoot(appData, appName) {
  return path.join(appData, appName, 'stems');
}

function configPath(userDataDir) {
  return path.join(userDataDir, CONFIG_FILE);
}

function readConfiguredRoot(userDataDir) {
  try {
    const raw = fs.readFileSync(configPath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.root === 'string' && path.isAbsolute(parsed.root.trim())
      ? path.resolve(parsed.root.trim())
      : null;
  } catch {
    return null;
  }
}

function directoryCheck(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root.trim())) {
    return { ok: false, reason: 'Bitte einen absoluten Stem-Datenpfad wählen.' };
  }
  const resolved = path.resolve(String(root || '').trim());
  if (!resolved || resolved === path.parse(resolved).root) {
    return { ok: false, root: resolved, reason: 'Bitte einen konkreten Stem-Datenordner auswählen.' };
  }
  try {
    const info = fs.statSync(resolved);
    if (!info.isDirectory()) return { ok: false, root: resolved, reason: 'Der Stem-Datenpfad ist kein Ordner.' };
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
    return { ok: true, root: resolved };
  } catch (error) {
    return {
      ok: false,
      root: resolved,
      reason: `Stem-Datenordner nicht les-/schreibbar: ${error && error.message ? error.message : String(error)}`,
    };
  }
}

function resolveStemDataRoot({ appData, appName, userDataDir } = {}) {
  const fallback = defaultRoot(appData, appName);
  const configured = userDataDir ? readConfiguredRoot(userDataDir) : null;
  let reason;
  if (configured) {
    const check = directoryCheck(configured);
    if (check.ok) return { ...check, source: 'configured', configPath: configPath(userDataDir) };
    reason = check.reason;
  }

  return {
    root: fallback,
    ok: true,
    source: 'appdata-default',
    reason,
    configPath: userDataDir ? configPath(userDataDir) : undefined,
  };
}

function saveStemDataRoot(userDataDir, root) {
  if (!userDataDir) return { ok: false, code: 'CONFIG_PATH_MISSING', message: 'App-Datenpfad fehlt.' };
  const check = directoryCheck(root);
  if (!check.ok) return { ok: false, code: 'STEM_ROOT_INVALID', message: check.reason, root: check.root };
  const probe = path.join(check.root, `.airdox-write-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' });
    fs.unlinkSync(probe);
  } catch (error) {
    return { ok: false, code: 'STEM_ROOT_INVALID', message: `Schreibprüfung fehlgeschlagen: ${error.message}` };
  }
  const target = configPath(userDataDir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, root: check.root }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, target);
    return { ok: true, root: check.root, configPath: target, source: 'configured' };
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    return { ok: false, code: 'CONFIG_WRITE_FAILED', message: error && error.message ? error.message : String(error) };
  }
}

function describeStemDataRoot({ appData, appName, userDataDir } = {}) {
  const resolved = resolveStemDataRoot({ appData, appName, userDataDir });
  return {
    root: resolved.root,
    source: resolved.source,
    configPath: resolved.configPath,
    writable: directoryCheck(resolved.root).ok,
    reason: resolved.reason,
  };
}

module.exports = {
  CONFIG_FILE,
  configPath,
  directoryCheck,
  resolveStemDataRoot,
  saveStemDataRoot,
  describeStemDataRoot,
};
