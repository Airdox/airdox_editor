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
 *  3. Aus `C:\Windows\System32\…` gebaut: UAC virtualisiert Schreibzugriffe, die
 *     Kindprozesse von electron-builder (`7za.exe`, `makensis.exe`) sehen einen
 *     anderen Ordner und das Portable-Paket wird leer
 *     („Add new data to archive: 0 files", „Das System kann den angegebenen Pfad
 *     nicht finden"). Deshalb: Pfad gegen `%%SystemRoot%%` prüfen und Schreibtest.
 *  4. Falscher Zweig gebaut (Name und Fassung der Datei passen nicht zur App) –
 *     der Guard nennt vor dem Build, welche Dateinamen entstehen und ob das Icon
 *     gefunden wird.
 *
 * Aufruf: node tools/check-build-env.cjs [--json]
 */

const fs = require('node:fs');
const path = require('node:path');

const NATIVE_MODULE = 'better-sqlite3-multiple-ciphers';

/**
 * Die Namen, die electron-builder laut `artifactName`-Mustern erzeugt – hier
 * vorhergesagt, damit vor dem Build sichtbar ist, welcher Stand gebaut wird.
 */
function describeArtifacts(pkg) {
  const build = pkg.build || {};
  const fields = {
    name: pkg.name || 'app',
    productName: build.productName || pkg.name || 'app',
    version: pkg.version || '0',
    os: 'win',
    arch: 'x64',
    ext: 'exe',
  };
  const templates = [build.artifactName, build.nsis && build.nsis.artifactName, build.portable && build.portable.artifactName];
  const names = [];
  for (const template of templates) {
    if (typeof template !== 'string') continue;
    const name = template.replace(/\$\{(\w+)\}/g, (_, key) => (key in fields ? fields[key] : key));
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

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

    const win = (pkg.build && pkg.build.win) || {};
    const iconRef = win.icon;
    if (!iconRef) {
      issues.push({
        level: 'warn',
        message:
          'build.win.icon ist nicht gesetzt – die EXE bekommt das Standard-Electron-Icon ' +
          '(electron-builder meldet „default Electron icon is used\"). Im Projekt liegt ' +
          'app-resources/icon.ico; wer den Build aus einem anderen Stand (z. B. main statt ' +
          'dem Arbeitszweig) fährt, sieht genau dieses Bild.',
      });
    } else if (!fs.existsSync(path.resolve(projectRoot, iconRef))) {
      issues.push({
        level: 'error',
        message:
          `build.win.icon zeigt auf ${iconRef}, die Datei fehlt im Projektordner – ` +
          'electron-builder baut ohne Icon und makensis bricht im Installer-Skript ab. ' +
          'Zweig prüfen (app-resources/ existiert erst ab dem Umbau auf diesen Namen).',
      });
    }

    const built = describeArtifacts(pkg);
    if (built.length > 0) {
      notes.push(`Es entstehen: ${built.join(' · ')} – Name und Fassung kommen aus package.json.`);
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

  // Niemals aus dem Windows-Verzeichnis heraus bauen: Schreibzugriffe dorthin
  // virtualisiert UAC nach %LOCALAPPDATA%\VirtualStore, und die Kindprozesse von
  // electron-builder (7za.exe für das Portable-Paket, makensis.exe für den Installer)
  // laufen mit anderer Integrität und sehen einen anderen Ordner. Bild im Log:
  // „Add new data to archive: 0 files" plus „Das System kann den angegebenen Pfad
  // nicht finden", obwohl win-unpacked gerade erst ausgepackt wurde.
  const systemRoot = process.env.SystemRoot || process.env.windir || '';
  const looksLikeWindowsDir =
    /[\\/]Windows([\\/]|$)/i.test(normalized) ||
    /[\\/](System32|SysWOW64|Program Files(?: \(x86\))?)([\\/]|$)/i.test(normalized);
  const insideSystemRoot =
    systemRoot &&
    path
      .normalize(normalized)
      .toLowerCase()
      .startsWith(path.normalize(systemRoot).toLowerCase() + path.sep);
  if (looksLikeWindowsDir || insideSystemRoot) {
    issues.push({
      level: 'error',
      message:
        `Projektordner liegt im Windows-Verzeichnis: ${normalized}\n` +
        '      Dorthin schreibt eine App ohne Admin-Rechte nicht direkt – UAC leitet alles nach\n' +
        '      %LOCALAPPDATA%\\VirtualStore um, und electron-builders Kindprozesse finden den\n' +
        '      ausgepackten Ordner nicht (7za.exe: „0 files", „Das System kann den angegebenen Pfad\n' +
        '      nicht finden"). Neu klonen nach C:\\Dev\\airdox_editor, dort „npm ci" und\n' +
        '      „npm run package:win" – nicht herüberkopieren, sonst wandern die VirtualStore-Reste mit.',
    });
  }

  // Schreibtest im Projektordner: fängt die übrigen Fälle ab (schreibgeschütztes
  // Laufwerk, durch Sync belegte Ordner, VirtualStore), bevor sie im Paketierlauf
  // als kryptische Kindprozess-Fehler erscheinen.
  if (fs.existsSync(normalized)) {
    let probeDir = null;
    try {
      probeDir = fs.mkdtempSync(path.join(normalized, '.build-probe-'));
      const probeFile = path.join(probeDir, 'probe.txt');
      fs.writeFileSync(probeFile, 'airdox');
      if (fs.readFileSync(probeFile, 'utf-8') !== 'airdox') {
        throw Object.assign(new Error('nach dem Schreiben ein anderer Inhalt'), { code: 'EBADCONTENT' });
      }
      notes.push('Im Projektordner lassen sich Ordner anlegen und lesen ✓');
    } catch (err) {
      issues.push({
        level: 'error',
        message:
          `Im Projektordner kann nicht geschrieben werden (${(err && err.code) || err}): ${normalized}\n` +
          '      electron-builder braucht dort „release\\" (Entpacken, Archivieren, Signieren).' +
          ' Auf einem anderen Laufwerk oder Nutzerordner neu klonen und „npm ci" dort ausführen.',
      });
    } finally {
      if (probeDir) {
        try {
          fs.rmSync(probeDir, { recursive: true, force: true });
        } catch {
          // Aufräumfehler sind für die Bewertung egal.
        }
      }
    }
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
      '\n  Abbruch vor dem Build. Ein Umzug des Projektordners (C:\\Dev\\airdox_editor, außerhalb\n' +
        '  von OneDrive und außerhalb von C:\\Windows) behebt die drei typischen Bilder; danach\n' +
        '  dort „npm ci“ und erneut „npm run package:win“ ausführen.\n'
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
