#!/usr/bin/env node
/**
 * EINMAL AUSFÜHREN, FERTIG.
 *
 * Dieses Skript richtet die automatische Windows-Setup.exe-Erstellung
 * für deine Electron-App komplett ein.
 *
 * Benutzung:
 *   1. Diese Datei in den Hauptordner deines Projekts legen
 *      (dort, wo auch deine package.json liegt)
 *   2. Im Terminal ausführen:   node setup-installer-pipeline.js
 *   3. Fertig. Änderungen committen und pushen.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.cwd();
const PKG_PATH = path.join(PROJECT_ROOT, 'package.json');
const WORKFLOW_DIR = path.join(PROJECT_ROOT, '.github', 'workflows');
const WORKFLOW_PATH = path.join(WORKFLOW_DIR, 'build-installer.yml');

const WORKFLOW_CONTENT = `name: Windows Setup bauen

on:
  push:
    branches: [main, master]
    tags: ['v*']
  workflow_dispatch:

jobs:
  build-windows-setup:
    runs-on: windows-latest

    steps:
      - name: Code auschecken
        uses: actions/checkout@v4

      - name: Node.js einrichten
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Abhängigkeiten installieren
        run: npm ci

      - name: Windows-Setup bauen
        run: npx electron-builder --win --publish never

      - name: Setup-Datei hochladen
        uses: actions/upload-artifact@v4
        with:
          name: windows-setup
          path: dist/*.exe
          if-no-files-found: error

      - name: Release erstellen (nur bei Versions-Tag)
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          files: dist/*.exe
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

function fail(msg) {
  console.error('\n❌ ' + msg + '\n');
  process.exit(1);
}

function ok(msg) {
  console.log('✅ ' + msg);
}

// 1. package.json muss existieren
if (!fs.existsSync(PKG_PATH)) {
  fail(
    'Keine package.json im aktuellen Ordner gefunden.\n' +
    '   Bitte dieses Skript in den Hauptordner deines Electron-Projekts legen\n' +
    '   und von dort aus ausführen (node setup-installer-pipeline.js).'
  );
}

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

// 2. Workflow-Datei schreiben
fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
fs.writeFileSync(WORKFLOW_PATH, WORKFLOW_CONTENT, 'utf8');
ok('GitHub-Actions-Workflow angelegt: .github/workflows/build-installer.yml');

// 3. electron-builder als devDependency eintragen
pkg.devDependencies = pkg.devDependencies || {};
if (!pkg.devDependencies['electron-builder'] && !(pkg.dependencies || {})['electron-builder']) {
  pkg.devDependencies['electron-builder'] = '^25.1.8';
  ok('electron-builder zu devDependencies hinzugefügt');
} else {
  ok('electron-builder war bereits vorhanden');
}

// 4. "build"-Abschnitt ergänzen, falls er fehlt
if (!pkg.build) {
  const appName = pkg.name || 'meine-app';
  pkg.build = {
    appId: `com.example.${appName}`,
    productName: pkg.productName || appName,
    win: {
      target: 'nsis'
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true
    }
  };
  ok('"build"-Abschnitt in package.json ergänzt (Standardwerte, bei Bedarf anpassen)');
} else {
  ok('"build"-Abschnitt war bereits vorhanden, wurde nicht verändert');
}

// 5. package.json zurückschreiben
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
ok('package.json aktualisiert');

console.log(
  '\n🎉 Fertig! Nächste Schritte:\n' +
  '   1. git add .\n' +
  '   2. git commit -m "Automatischer Windows-Setup-Build"\n' +
  '   3. git push\n' +
  '\n   Danach baut GitHub bei jedem Push automatisch die Setup.exe.\n' +
  '   Zu finden unter: GitHub-Repo -> Reiter "Actions" -> Lauf öffnen -> "Artifacts"\n'
);
