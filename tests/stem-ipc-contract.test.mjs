/**
 * Vertragstest der Desktop-Bridge (Electron ↔ Renderer) für die Stem-Strecke.
 *
 * Die Electron-Laufzeit kann in CI nicht gestartet werden (kein Display, kein
 * Binary-Download). Dieser Test prüft deshalb statisch, aber streng, dass die
 * Brücke zusammenpasst – genau die Klasse von Fehlern, die die Stem-Funktion
 * vorher unbenutzbar gemacht hat:
 *
 *  - jeder im Preload exponierte Kanal hat einen Handler im Main-Process,
 *  - jede im Renderer aufgerufene Bridge-Methode ist exponiert UND typisiert,
 *  - der Separator wird über execFile + Argument-Array aufgerufen (nie wieder
 *    ein Shell-String, der bei Pfaden mit Leerzeichen/Klammern zerbricht),
 *  - Ausgabeordner-Isolation und Vorher/Nachher-Diff sind eingebaut.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const mainSource = read('electron/main.cjs');
const preloadSource = read('electron/preload.cjs');
const desktopTypes = read('src/types/desktop.d.ts');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[ PASS ] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[ FAIL ] ${name}`);
    console.error(`         ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function matches(source, regex) {
  return [...source.matchAll(regex)].map((match) => match[1]);
}

// Renderer-Quellen einsammeln (nur .ts/.tsx, ohne stems/Node-Module)
function rendererSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, 'src'));
  return files;
}

test('#1 Jeder Preload-Kanal hat einen Handler oder Sender im Main-Process', () => {
  const invoked = [...new Set(matches(preloadSource, /ipcRenderer\.invoke\(\s*'([^']+)'/g))];
  const listened = [...new Set(matches(preloadSource, /ipcRenderer\.on\(\s*'([^']+)'/g))];
  const handled = new Set(matches(mainSource, /ipcMain\.handle\(\s*'([^']+)'/g));
  const sent = new Set(matches(mainSource, /\.send\(\s*'([^']+)'/g));

  assert.ok(invoked.length >= 10, `Zu wenige Preload-Kanäle gefunden (${invoked.length})`);
  for (const channel of invoked) {
    assert.ok(handled.has(channel), `Kein ipcMain.handle für "${channel}"`);
  }
  for (const channel of listened) {
    assert.ok(sent.has(channel), `Kein sender.send für den Ereignis-Kanal "${channel}"`);
  }
});

test('#2 Alle Stem-Kanäle sind vollständig verdrahtet', () => {
  const expected = [
    'audio:separate-stems',
    'audio:separator-status',
    'audio:separate-stems:cancel',
    'audio:separate-stems:progress',
    'stems:models:list',
    'stems:models:runtime-catalog',
    'stems:models:download',
    'stems:models:cancel',
    'stems:models:remove',
    'stems:models:import',
    'stems:models:open-folder',
    'stems:models:progress',
  ];
  const invoked = matches(preloadSource, /ipcRenderer\.invoke\(\s*'([^']+)'/g);
  const listened = matches(preloadSource, /ipcRenderer\.on\(\s*'([^']+)'/g);
  const handled = matches(mainSource, /ipcMain\.handle\(\s*'([^']+)'/g);
  const sent = matches(mainSource, /\.send\(\s*'([^']+)'/g);
  const all = [...invoked, ...listened];
  for (const channel of expected) {
    assert.ok(all.includes(channel), `Stem-Kanal "${channel}" fehlt im Preload`);
    assert.ok(handled.includes(channel) || sent.includes(channel), `Stem-Kanal "${channel}" fehlt im Main-Process`);
  }
});

test('#3 Jede exponierte Bridge-Methode ist in desktop.d.ts typisiert', () => {
  const bridgeBlock = preloadSource.slice(preloadSource.indexOf("exposeInMainWorld('rekordboxDesktop'"));
  const exposed = [...new Set(matches(bridgeBlock, /^\s{2}([A-Za-z0-9_]+):/gm))];
  assert.ok(exposed.length >= 12, `Bridge-Methoden nicht erkannt (${exposed.length})`);
  for (const method of exposed) {
    assert.ok(new RegExp(`\\b${method}\\??\\s*[(:]`).test(desktopTypes), `Typdeklaration für "${method}" fehlt in src/types/desktop.d.ts`);
  }
  for (const method of ['separateStems', 'separatorStatus', 'cancelStemSeparation', 'onStemSeparationProgress', 'listStemModels', 'downloadStemModel', 'importStemModels', 'openStemModelFolder']) {
    assert.ok(exposed.includes(method), `"${method}" wird nicht über die Bridge exponiert`);
  }
});

test('#4 Jede im Renderer genutzte Bridge-Methode ist wirklich exponiert', () => {
  const bridgeBlock = preloadSource.slice(preloadSource.indexOf("exposeInMainWorld('rekordboxDesktop'"));
  const exposed = new Set(matches(bridgeBlock, /^\s{2}([A-Za-z0-9_]+):/gm));
  const used = new Set();
  for (const file of rendererSources()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const method of matches(source, /rekordboxDesktop\??\.([A-Za-z0-9_]+)\s*[?(]/g)) used.add(method);
  }
  assert.ok(used.size >= 5, 'Renderer nutzt erkennbar keine Bridge-Methoden – Prüfmuster kaputt');
  for (const method of used) {
    assert.ok(exposed.has(method), `Renderer ruft "${method}" auf, aber die Bridge exponiert es nicht`);
  }
});

test('#5 Kein Shell-String mehr: Separator läuft über execFile + Argument-Array', () => {
  assert.ok(!/const\s*\{\s*exec\s*\}\s*=\s*require\('node:child_process'\)/.test(mainSource), 'exec() ist wieder importiert – Shell-String-Risiko');
  assert.ok(!/exec\(\s*`[^`]*\$\{/.test(mainSource), 'Shell-String mit Interpolation gefunden');
  assert.ok(/execFile\(status\.command, useShell \? toShellArgs\(args\) : args/.test(mainSource), 'execFile-Aufruf mit Argument-Array fehlt');
  assert.ok(/buildSeparatorArgs\(/.test(mainSource), 'Argumente werden nicht über buildSeparatorArgs gebaut');
});

test('#6 Ausgabeordner-Isolation und Vorher/Nachher-Diff sind eingebaut', () => {
  assert.ok(/trackOutputRoot\(roots\.output, localPath\)/.test(mainSource), 'Kein eigener Ausgabeordner pro Quelldatei');
  assert.ok(/collectStemOutputs\(/.test(mainSource), 'Ergebnis wird nicht über das Datei-Diff bestimmt');
  assert.ok(/filesBefore = listDirectoryEntries\(outputDir\)/.test(mainSource), 'Vorher-Snapshot fehlt');
  assert.ok(/resolveSeparatorStatus\(/.test(mainSource), 'CLI-Verfügbarkeit wird nicht vorab geprüft');
});

test('#7 Modell-Gewichte werden validiert und nur über HTTPS geladen', () => {
  assert.ok(/normalizeModelRequest\(/.test(mainSource), 'Modell-Payload wird nicht validiert');
  assert.ok(/MODEL_URL_PROTOCOLS/.test(read('electron/stemRunner.cjs')), 'HTTPS-Whitelist fehlt');
  assert.ok(/sha256OfFile/.test(read('electron/stemModelStore.cjs')), 'Prüfsummenkontrolle fehlt');
  assert.ok(/PART_SUFFIX/.test(read('electron/stemModelStore.cjs')), 'Atomarer Download (.part) fehlt');
});

test('#8 Fehler werden klassifiziert statt roh an den Renderer geworfen', () => {
  assert.ok(/classifySeparatorFailure\(/.test(mainSource), 'Fehlerklassifikation fehlt');
  assert.ok(/withStemCode\(/.test(mainSource), 'Fehlercodes werden nicht gesetzt');
  for (const code of ['SEPARATOR_NOT_INSTALLED', 'SEPARATOR_MODEL_MISSING', 'SEPARATOR_NO_OUTPUT', 'SEPARATOR_TIMEOUT']) {
    assert.ok(read('electron/stemRunner.cjs').includes(code), `Fehlercode ${code} fehlt im Runner`);
  }
});

console.log(`\nstem-ipc-contract: ${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exitCode = 1;
