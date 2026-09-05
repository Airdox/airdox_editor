/**
 * @license
 * Build-Umgebung prüfen, BEVOR electron-builder läuft.
 *
 * Zwei Fehlerbilder aus der Praxis, die beide erst nach minutenlangem Build
 * sichtbar wurden:
 *
 *  1. electron-builder rebuildet das optionale Native-Modul → node-gyp →
 *     „Could not find any Visual Studio installation to use". Verhindert das
 *     `build.npmRebuild: false` (und der CLI-Override in den npm-Skripten),
 *     meldet dieses Skript den Status.
 *  2. „Attempting to build a module with a space in the path" – node-gyp (und
 *     viele Build-Werkzeuge) scheitern an Pfaden wie
 *     `C:\Users\me\OneDrive\Desktop\Neuer Ordner\projekt`.
 *
 * Aufruf: node tools/check-build-env.cjs [--json]
 */

const fs = require('node:fs');
const path = require('node:path');

const NATIVE_MODULE = 'better-sqlite3-multiple-ciphers';

/** Reine Analyse, damit das Verhalten ohne echten Build testbar ist. */
function analyzeEnvironment(projectRoot) {
  const issues = [];
  const notes = [];

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
  } catch {
    issues.push({
      level: 'error',
      message: `Kein package.json in ${projectRoot} gefunden – aus dem Projektordner heraus starten.`,
    });
  }

  if (pkg) {
    const npmRebuild = pkg.build ? pkg.build.npmRebuild : undefined;
    if (npmRebuild === false) {
      notes.push('build.npmRebuild = false → electron-builder startet keinen node-gyp-Lauf.');
    } else {
      issues.push({
        level: 'error',
        message:
          'In package.json fehlt "build": { "npmRebuild": false }. electron-builder würde ' +
          `das native Modul (${NATIVE_MODULE}) für die Electron-ABI neu bauen und ohne ` +
          'Visual Studio abbrechen. Ergänze die Zeile in package.json (die npm-Skripte übergeben ' +
          'zusätzlich --config.npmRebuild=false).',
      });
    }

    const publish = pkg.build ? pkg.build.publish : undefined;
    if (typeof publish === 'string') {
      issues.push({
        level: 'error',
        message:
          `build.publish ist "${publish}" – in der Konfiguration steht darin kein Modus, sondern ein ` +
          `Provider-Name, den electron-builder als Modul sucht (electron-publisher-${publish}) und mit ` +
          '"Cannot find module for publisher" abbricht. Richtig: "build": { "publish": null } ' +
          '(kein Update-Server). Den Modus "never" gibt es nur auf der Kommandozeile: --publish never.',
      });
    }

    const shared = Object.keys(pkg.dependencies || {}).filter((name) => (pkg.devDependencies || {})[name] !== undefined);
    if (shared.length > 0) {
      issues.push({
        level: 'error',
        message:
          `Diese Pakete stehen zugleich in dependencies und devDependencies: ${shared.join(', ')}. ` +
          'Als Runtime-Abhängigkeit wandert ein Build-Werkzeug sonst unnötig in die App.',
      });
    }

    const hasDist = fs.existsSync(path.join(projectRoot, 'dist', 'index.html'));
    if (!hasDist) {
      notes.push('dist/index.html fehlt – das npm-Skript holt das mit "npm run build" nach.');
    } else {
      const html = fs.readFileSync(path.join(projectRoot, 'dist', 'index.html'), 'utf-8');
      if (/["'(]\s*\/assets\//.test(html)) {
        issues.push({
          level: 'error',
          message:
            'dist/index.html verweist auf absolute Pfade (/assets/…). Im Desktop-Fenster (file://) ' +
            'führt das zu einem weißen Fenster – in vite.config.ts muss base "./" stehen, danach neu bauen.',
        });
      } else {
        notes.push('dist/index.html nutzt relative Asset-Pfade (base "./") ✓');
      }
    }
  }

  // Native Modul: optionaler Beschleuniger, darf den Build nie blockieren.
  const nativeDir = path.join(projectRoot, 'node_modules', NATIVE_MODULE);
  const nativeInstalled = fs.existsSync(nativeDir);
  if (nativeInstalled) {
    const built = fs.existsSync(path.join(nativeDir, 'build', 'Release'));
    notes.push(
      `${NATIVE_MODULE} ist installiert${built ? ' (mit build/Release)' : ' (ohne Build-Ausgabe)'}. ` +
        'Ohne passendes Electron-Binary nutzt die App den reinen JavaScript-Leser – der Import bleibt vollständig.'
    );
  }

  const normalized = path.resolve(projectRoot);
  const hasSpace = /\s/.test(normalized);
  const isOneDrive = /OneDrive/i.test(normalized);
  if (hasSpace && nativeInstalled) {
    issues.push({
      level: 'error',
      message:
        `Projektpfad enthält Leerzeichen: ${normalized}\n` +
        '      node-gyp meldet dazu "Attempting to build a module with a space in the path".' +
        ' Das Projekt nach z. B. C:\\Dev\\airdox_editor verschieben (außerhalb von OneDrive) und dort' +
        ' "npm ci" erneut ausführen.',
    });
  } else if (hasSpace) {
    issues.push({
      level: 'warn',
      message:
        `Projektpfad enthält Leerzeichen (${normalized}). Ohne natives Modul ist das unkritisch;` +
        ' Build-Tools und einige Installer reagieren aber empfindlich. Empfohlen: C:\\Dev\\airdox_editor.',
    });
  }
  if (isOneDrive) {
    issues.push({
      level: 'warn',
      message:
        'Der Pfad liegt in OneDrive. Dateisync sperrt Dateien in node_modules\\ und release\\ ' +
        '(EPERM/EBUSY, halbe Artefakte). Für Builds nach C:\\Dev\\… kopieren oder OneDrive-Pause einlegen.',
    });
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) {
    issues.push({
      level: 'error',
      message: `Node.js ${process.version} ist zu alt – Vite 6 und Electron 44 erwarten Node.js >= 20.`,
    });
  } else {
    notes.push(`Node.js ${process.version}`);
  }

  let electronVersion = null;
  try {
    electronVersion = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'node_modules/electron/package.json'), 'utf-8')
    ).version;
  } catch {
    issues.push({
      level: 'error',
      message: 'electron ist nicht installiert – "npm ci" bzw. "npm install" im Projektordner ausführen.',
    });
  }
  if (electronVersion) {
    let abi = null;
    try {
      abi = fs.readFileSync(path.join(projectRoot, 'node_modules/electron/abi_version'), 'utf-8').trim();
    } catch {
      // ältere Electron-Pakete ohne abi_version
    }
    notes.push(`Electron ${electronVersion}${abi ? ` (Node-ABI ${abi})` : ''}`);
    if (abi && Number(abi) > 146 && nativeInstalled) {
      notes.push(
        `Electron-ABI ${abi} liegt über den Prebuilds von ${NATIVE_MODULE} (max. 146) →` +
          ' natives Modul wird nicht geladen, der JavaScript-Leser übernimmt.'
      );
    }
  }

  return { issues, notes, root: normalized };
}

function main() {
  const args = process.argv.slice(2);
  const root = path.resolve(__dirname, '..');
  const { issues, notes, root: resolved } = analyzeEnvironment(root);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ root: resolved, notes, issues }, null, 2));
    process.exitCode = issues.some((issue) => issue.level === 'error') ? 1 : 0;
    return;
  }

  console.log('\n  Build-Umgebung prüfen');
  console.log(`  Projekt: ${resolved}`);
  for (const note of notes) console.log(`    · ${note}`);
  for (const issue of issues) {
    const label = issue.level === 'error' ? '  ✗' : '  !';
    console.log(`${label} ${issue.message}`);
  }

  const errors = issues.filter((issue) => issue.level === 'error');
  if (errors.length > 0) {
    console.log(
      '\n  Abbruch vor dem Build. Bei Leerzeichen-/OneDrive-Problemen hilft ein Umzug des Projektordners;\n' +
        '  danach „npm ci“ und erneut „npm run package:win“ ausführen.\n'
    );
    process.exitCode = 1;
    return;
  }
  if (issues.length > 0) {
    console.log('\n  Warnungen oben beachten – der Build kann trotzdem durchlaufen.\n');
  } else {
    console.log('  ✓ Umgebung passt für den Windows-Build (ohne Visual Studio).\n');
  }
}

if (require.main === module) main();

module.exports = { analyzeEnvironment, NATIVE_MODULE };
