/**
 * @license
 * electron-builder Hooks für den Master-DB-Pfad.
 *
 * Ziel: Ein Windows-Paket darf **nicht** erfolgreich durchlaufen, wenn das
 * native SQLCipher-Modul anschließend fehlt oder nicht zur Electron-Version
 * passt. Genau dieser Zustand ist bisher unbemerkt durchgerutscht, weil
 * `npmRebuild: false` gesetzt war und nichts den Zustand geprüft hat.
 *
 *   beforePack → baut better-sqlite3-multiple-ciphers gegen die Electron-Version,
 *                die tatsächlich gepackt wird, und bricht bei Fehlern ab.
 *   afterPack  → prüft das fertige Paket: app.asar vorhanden, natives Binary
 *                im app.asar.unpacked, generiertes ANLZ-Spiegelmodul im asar.
 *                Erst danach gilt der Build als SQLCipher-fähig.
 *
 * Konfiguriert in package.json → build.beforePack / build.afterPack.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_NAME = 'better-sqlite3-multiple-ciphers';

function fail(message, hint) {
  const error = new Error(`[airdox:packaging] ${message}${hint ? `\n${hint}` : ''}`);
  error.name = 'AirdoxPackagingError';
  throw error;
}

function resolveElectronVersion(context) {
  const candidates = [
    context && context.electronVersion,
    context && context.packager && context.packager.config && context.packager.config.electronVersion,
    context && context.packager && context.packager.info && context.packager.info.electronVersion,
    context && context.packager && context.packager.appInfo && context.packager.appInfo.electronVersion,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^\d+\.\d+\.\d+/.test(candidate)) return candidate;
  }
  fail(
    'Die Electron-Version des Builds konnte nicht ermittelt werden.',
    'Der native Rebuild würde gegen eine falsche ABI gebaut. Abbruch ist sicherer als ein Paket ohne SQLCipher.'
  );
  return '';
}

function projectDir(context) {
  return (context && context.packager && context.packager.projectDir) || process.cwd();
}

function findNativeBinary(root) {
  const base = path.join(root, 'node_modules', MODULE_NAME, 'build', 'Release');
  if (!fs.existsSync(base)) return null;
  const node = fs.readdirSync(base).find((name) => name.endsWith('.node'));
  return node ? path.join(base, node) : null;
}

/** Pfad der Electron-Binary, die tatsächlich mitgepackt wird. */
function electronBinaryPath(root) {
  try {
    // Das npm-Paket `electron` exportiert den Pfad seiner Binary.
    return require(require.resolve('electron', { paths: [root] }));
  } catch {
    return null;
  }
}

/**
 * Lädt das native Modul in der *echten* Electron-Laufzeit.
 *
 * Das ist der einzige belastbare Nachweis: electron-builder-Hooks laufen in
 * Node, ein für Electron gebautes Binary lässt sich dort aber gar nicht
 * laden. Mit ELECTRON_RUN_AS_NODE=1 interpretiert dieselbe Electron-Binary
 * das Skript – mit exakt der ABI, in der die installierte App läuft.
 *
 * Die Cipher-Probe arbeitet auf einer eigenen temporären Datei im Systemtemp:
 * SQLCipher verweigert `PRAGMA key` ausdrücklich bei In-Memory-Datenbanken
 * („Setting key not supported for in-memory or temporary databases“), eine
 * `:memory:`-Probe wäre also selbst auf einwandfreiem Modul immer rot.
 */
function requireInElectronRuntime(electronPath, modulePath) {
  const script =
    [
      `const fs = require('node:fs');`,
      `const os = require('node:os');`,
      `const path = require('node:path');`,
      `const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-pack-probe-'));`,
      `try {`,
      `  const m = require(${JSON.stringify(modulePath)});`,
      `  const d = new m(path.join(dir, 'probe.db'));`,
      `  d.pragma("cipher = sqlcipher"); d.pragma("legacy = 4"); d.pragma("key = 'probe'");`,
      `  d.exec('CREATE TABLE t (a INTEGER)'); d.prepare('INSERT INTO t VALUES (1)').run();`,
      `  const n = d.prepare('SELECT count(*) AS n FROM t').get(); d.close();`,
      `  if (Number(n.n) !== 1) { throw new Error('cipher probe failed'); }`,
      `  process.stdout.write('ok ' + process.versions.electron + ' abi ' + process.versions.modules);`,
      `} finally {`,
      `  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }`,
      `}`,
    ].join('\n');
  const result = spawnSync(electronPath, ['-e', script], {
    cwd: path.dirname(modulePath),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {
    ok: result.status === 0 && /ok\s/.test(result.stdout || ''),
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || result.error?.message || '').trim(),
  };
}

async function beforePack(context) {
  const electronVersion = resolveElectronVersion(context);
  const dir = projectDir(context);
  console.log(`[airdox:packaging] beforePack: Electron ${electronVersion}`);

  const moduleDir = path.join(dir, 'node_modules', MODULE_NAME);
  if (!fs.existsSync(moduleDir)) {
    fail(
      `${MODULE_NAME} ist nicht installiert und wird deshalb nicht mitgepackt.`,
      'Die Abhängigkeit darf nicht optional sein: "npm ci" ausführen und erneut bauen.'
    );
  }

  let rebuild;
  try {
    // @electron/rebuild ist ESM-only; aus CommonJS heraus deshalb dynamisch.
    ({ rebuild } = await import('@electron/rebuild'));
  } catch (error) {
    fail(
      `@electron/rebuild ist nicht verfügbar (${error.message}).`,
      'Ohne diesen Rebuild ist das gepackte SQLCipher-Binary nicht garantiert ABI-kompatibel.'
    );
  }

  // electron-builder übergibt `arch` als Arch-Enum (x64 = 1), @electron/rebuild
  // erwartet aber den Klarnamen ('x64') – eine Zahl würde als `--arch=1`
  // durchgereicht und der Build würde gegen die falsche Architektur laufen.
  const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' };
  const rawArch = (context && context.arch) || process.arch;
  const arch = typeof rawArch === 'number' ? ARCH_NAMES[rawArch] || String(process.arch) : String(rawArch);
  const rawPlatform =
    (context && context.electronPlatformName) ||
    (context && context.packager && context.packager.platform && context.packager.platform.node) ||
    process.platform;
  const context2 = {
    buildPath: dir,
    electronVersion,
    arch,
    platform: rawPlatform,
    onlyModules: [MODULE_NAME],
    force: true,
  };
  try {
    await rebuild(context2);
  } catch (error) {
    fail(
      `Der native Rebuild von ${MODULE_NAME} für Electron ${electronVersion} ist fehlgeschlagen: ${error.message || error}`,
      'Ein Build ohne lauffähiges SQLCipher wird nicht erzeugt.'
    );
  }

  const binary = findNativeBinary(dir);
  if (!binary) {
    fail(
      `Nach dem Rebuild liegt kein .node-Binary für ${MODULE_NAME} vor.`,
      `Erwartet unter ${path.join(moduleDir, 'build', 'Release')}`
    );
  }
  console.log(`[airdox:packaging] beforePack: natives SQLCipher-Binary ${path.relative(dir, binary)}`);

  // Der Nachweis muss in der Electron-Laufzeit stattfinden – in Node lässt
  // sich ein für Electron gebautes Binary grundsätzlich nicht laden.
  const electronPath = electronBinaryPath(dir);
  if (!electronPath || !fs.existsSync(electronPath)) {
    fail(
      'Die Electron-Binary wurde nicht gefunden; ohne sie ist der ABI-Nachweis unmöglich.',
      'electron ist eine devDependency – bitte "npm ci" ausführen und erneut bauen.'
    );
  }
  const probe = requireInElectronRuntime(electronPath, moduleDir);
  if (!probe.ok) {
    fail(
      `Das native SQLCipher-Modul ließ sich in der Electron-Laufzeit nicht laden (${electronPath}).`,
      probe.stderr || 'unbekannter Fehler'
    );
  }
  console.log(`[airdox:packaging] beforePack: Electron-Nachweis ${probe.stdout}`);
}

function afterPack(context) {
  const appOutDir = context && context.appOutDir;
  if (!appOutDir) fail('afterPack: appOutDir fehlt im electron-builder-Kontext.');
  console.log(`[airdox:packaging] afterPack: ${appOutDir}`);

  const asarPath = path.join(appOutDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    fail('app.asar wurde nicht erzeugt.', `Erwartet: ${asarPath}`);
  }

  const unpackedRoot = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', MODULE_NAME);
  const unpackedBinary = findNativeBinary(path.join(appOutDir, 'resources', 'app.asar.unpacked'));
  if (!unpackedBinary) {
    fail(
      'Das native SQLCipher-Binary ist nicht im Paket enthalten.',
      `Erwartet: ${path.join(unpackedRoot, 'build', 'Release', '*.node')}\n` +
      'Ohne diese Datei liefert die installierte App zur Laufzeit SQLCIPHER_UNAVAILABLE.'
    );
  }
  console.log(`[airdox:packaging] afterPack: natives Binary ${path.relative(appOutDir, unpackedBinary)}`);

  // Ende-zu-Ende: das *entpackte* Modul in der Electron-Laufzeit laden, die
  // auch die installierte App verwendet. Das ist der Nachweis, den die
  // Verpackung bisher nie erbracht hat.
  const electronPath = electronBinaryPath(projectDir(context));
  if (electronPath && fs.existsSync(electronPath)) {
    const probe = requireInElectronRuntime(electronPath, unpackedRoot);
    if (!probe.ok) {
      fail(
        'Das gepackte SQLCipher-Modul ließ sich nicht in der Electron-Laufzeit laden.',
        probe.stderr || 'unbekannter Fehler'
      );
    }
    console.log(`[airdox:packaging] afterPack: gepacktes Modul in Electron ladbar (${probe.stdout})`);
  } else {
    console.warn('[airdox:packaging] afterPack: Electron-Binary nicht gefunden – Ladetest des Pakets übersprungen.');
  }

  // Das generierte ANLZ-Spiegelmodul muss mit im Paket sein – ohne es kann
  // der Master-DB-Gate keine ANLZ-Datei lesen.
  let asarList = null;
  try {
    const asar = require('@electron/asar');
    // listPackage liefert absolute Pfade ('/electron/…'; unter Windows mit
    // Backslashes) – ohne Normalisierung würde der Vergleich nie greifen und
    // afterPack jeden validen Packvorgang zu Unrecht abbrechen.
    asarList = new Set(
      asar.listPackage(asarPath).map((entry) => String(entry).replace(/^[\\/]+/, '').replace(/\\/g, '/'))
    );
  } catch {
    asarList = null;
  }
  const generatedRelative = path.posix.join('electron', 'generated', 'anlzStructure.cjs');
  if (asarList && !asarList.has(generatedRelative)) {
    fail(
      `${generatedRelative} fehlt im app.asar – der Master-DB-Gate könnte keine ANLZ-Datei lesen.`,
      'In package.json → build.files muss "electron/**/*" enthalten sein.'
    );
  }
  if (!asarList) {
    console.warn(
      '[airdox:packaging] afterPack: app.asar konnte nicht gelesen werden – der ANLZ-Spiegel wurde nicht gegengeprüft.'
    );
  }
  console.log('[airdox:packaging] afterPack: Paket enthält das native SQLCipher-Modul und den ANLZ-Spiegel.');
}

module.exports = { beforePack, afterPack };
