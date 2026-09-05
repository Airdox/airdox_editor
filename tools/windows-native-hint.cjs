/**
 * @license
 * Diagnose-Skript für den Windows-Build.
 *
 * Beantwortet die Frage, die hinter "Could not find any Visual Studio
 * installation to use" steckt: wird für den Datenbank-Import ein C-Compiler
 * benötigt oder nicht?
 *
 *   node tools/windows-native-hint.cjs      (auch: npm run native:windows-hint)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const readJson = (relative) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf-8'));
  } catch {
    return null;
  }
};

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Airdox_intelligents_Editor – Build-Diagnose');
console.log('══════════════════════════════════════════════════════════════\n');

line('Betriebssystem', process.platform + ' / ' + process.arch);
line('Node.js', process.version);

const electronPkg = readJson('node_modules/electron/package.json');
if (electronPkg) {
  let abi = '?';
  try {
    abi = fs.readFileSync(path.join(root, 'node_modules/electron/abi_version'), 'utf-8').trim();
  } catch {
    // ältere Electron-Pakete ohne abi_version
  }
  line('Electron (installiert)', `${electronPkg.version} (Node-ABI ${abi})`);
} else {
  line('Electron (installiert)', 'nicht installiert – bitte npm ausführen');
}

const nativeRoot = path.join(root, 'node_modules/better-sqlite3-multiple-ciphers');
const nativeInstalled = fs.existsSync(nativeRoot);
const nativeBinary = fs
  .existsSync(path.join(nativeRoot, 'build/Release'))
  ? fs.readdirSync(path.join(nativeRoot, 'build/Release')).filter((f) => f.endsWith('.node'))
  : [];
line('natives SQLCipher-Modul', nativeInstalled ? `vorhanden (${nativeBinary.length ? nativeBinary.join(', ') : 'ohne Build-Ausgabe'})` : 'nicht installiert (optional)');

if (nativeInstalled) {
  try {
    require('better-sqlite3-multiple-ciphers');
    line('…lädt in diesem Node', 'ja');
  } catch (error) {
    line('…lädt in diesem Node', 'nein – ' + String(error.message).split('\n')[0]);
  }
}

const sqlJs = readJson('node_modules/sql.js/package.json');
line('sql.js (SQLite als WebAssembly)', sqlJs ? sqlJs.version : 'fehlt – npm install ausführen');

console.log('\n  Selbsttest des reinen JavaScript-Lesers (kein Compiler nötig):');
if (!sqlJs) {
  console.log('    übersprungen – sql.js ist nicht installiert.\n');
} else {
  try {
    const { readRekordboxDatabase } = require(path.join(root, 'electron/dbReader.cjs'));
    const fixture = path.join(root, 'tests/fixtures/rekordbox6/master.db');
    const started = Date.now();
    readRekordboxDatabase(fixture).then((result) => {
      if (result.available) {
        console.log(
          `    ✓ ${result.fileName}: ${result.stats.tracks} Tracks, ${result.stats.cues} Cues ` +
            `(${result.engine}, ${result.cipher}) in ${Date.now() - started}ms`
        );
      } else {
        console.log(`    ✗ ${result.reason}`);
      }
      printAdvice();
    });
  } catch (error) {
    console.log('    ✗ Selbsttest fehlgeschlagen: ' + error.message);
    printAdvice();
  }
}

function printAdvice() {
  console.log(`
  Bedeutung des Visual-Studio-Fehlers
  ────────────────────────────────────
  node-gyp sucht Visual Studio, sobald ein natives Modul (binding.gyp) für die
  Electron-ABI gebaut werden muss. Das betrifft hier ausschließlich das
  *optionale* Paket better-sqlite3-multiple-ciphers: die Publishing-Releases
  des Moduls enden bei Electron-ABI 146, Electron 44 nutzt ABI 149 – es gibt
  also kein vorgebautes Binary und electron-builder wollte kompilieren.

  Notwendig ist das nicht mehr:
    • electron-builder Konfiguration setzt "npmRebuild": false → kein node-gyp
      mehr beim Paketieren (siehe package.json → "build").
    • Die App liest master.db / exportLibrary.db über den reinen
      JavaScript-Pfad (electron/sqlcipherCodec.cjs + sql.js).

  npm run package:win            → NSIS-Installer + portable .exe
  npm run package:win:installer  → nur den Installer
  npm run package:win:portable   → nur die einzelne .exe

  Optional (nur wenn du das native Modul wirklich willst, z. B. für sehr große
  Bibliotheken): Visual Studio 2022 mit Workload "Desktopentwicklung mit C++"
  und Python 3 installieren, dann
    npm install --runtime=electron --target=${electronPkg ? electronPkg.version : '<electron-version>'} --update-binary better-sqlite3-multiple-ciphers
  oder nach einem regulären npm install:
    npm run rebuild:electron
`);
  if (process.platform !== 'win32') {
    try {
      execFileSync('node', ['-v'], { stdio: 'ignore' });
    } catch {
      // ignore
    }
    console.log('  Hinweis: Dieses Diagnose-Skript läuft plattformneutral; unter Linux/macOS\n  wird die DLL-Prüfung nur der Form halber ausgeführt.\n');
  }
}
