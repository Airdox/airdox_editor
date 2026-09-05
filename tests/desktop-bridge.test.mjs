/**
 * @license
 * Integration test for the Windows desktop bridge.
 *
 * Loads electron/main.cjs and electron/preload.cjs against a stubbed Electron
 * API (no Electron binary needed) and drives every IPC channel the renderer is
 * allowed to use. This catches the failure modes that only show up in the built
 * Windows app: a channel that is exposed but not implemented, a read-only
 * bridge that would touch a source file, and the database reader wiring.
 *
 * Run with: node tests/desktop-bridge.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// ─── Electron-Stub ──────────────────────────────────────────────────────────
const ipcHandlers = new Map();
const loadCalls = [];
const dialogRequests = [];

const stub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
    getAppPath: () => root,
    platform: process.platform,
  },
  BrowserWindow: class BrowserWindowStub {
    constructor(options) {
      this.options = options;
      this.webContents = {
        setWindowOpenHandler: (handler) => {
          loadCalls.push(['windowOpenHandler', typeof handler]);
        },
        on: (event) => loadCalls.push(['webContents.on', event]),
      };
    }

    loadFile(target) {
      loadCalls.push(['loadFile', target]);
    }

    loadURL(url) {
      loadCalls.push(['loadURL', url]);
    }
  },
  dialog: {
    showOpenDialog: async (_parent, options) => {
      dialogRequests.push(options);
      return { canceled: true, filePaths: [] };
    },
  },
  ipcMain: {
    handle: (channel, handler) => {
      assert.ok(!ipcHandlers.has(channel), `Kanal ${channel} ist doppelt registriert`);
      ipcHandlers.set(channel, handler);
    },
  },
  contextBridge: {
    exposeInMainWorld: (name, api) => {
      stub.__exposed = { name, api };
    },
  },
  ipcRenderer: {
    invoke: async (channel, ...args) => {
      assert.ok(ipcHandlers.has(channel), `preload ruft ${channel}, aber main registriert den Kanal nicht`);
      return ipcHandlers.get(channel)({ senderFrame: {} }, ...args);
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return stub;
  return originalLoad.call(this, request, parent, isMain);
};

require(path.join(root, 'electron/main.cjs'));
require(path.join(root, 'electron/preload.cjs'));
Module._load = originalLoad;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
  } catch (error) {
    results.push(`  ✗ ${name}\n      ${error.message}`);
    throw error;
  }
}

console.log('\n  Desktop-Bridge (main.cjs ↔ preload.cjs ↔ dbReader)');

await check('alle IPC-Kanäle sind registriert', () => {
  const expected = [
    'rekordbox:inspect-location',
    'rekordbox:read-original-audio',
    'rekordbox:choose-analysis-file',
    'rekordbox:read-analysis-file',
    'rekordbox:choose-rekordbox-database',
    'rekordbox:locate-rekordbox-databases',
    'rekordbox:database-capabilities',
    'rekordbox:read-library-db',
  ];
  for (const channel of expected) assert.ok(ipcHandlers.has(channel), `fehlt: ${channel}`);
});

await check('preload und main passen zusammen (kein toter Kanal, keine Lücke)', async () => {
  assert.ok(stub.__exposed, 'contextBridge.exposeInMainWorld wurde nicht aufgerufen');
  assert.strictEqual(stub.__exposed.name, 'rekordboxDesktop');
  const api = stub.__exposed.api;
  for (const [method, fn] of Object.entries(api)) {
    assert.strictEqual(typeof fn, 'function', `${method} ist keine Funktion`);
  }
  // Every method resolves to a registered handler (verified by invoke above).
  await api.locateRekordboxDatabases();
  await api.describeDatabaseEngines();
  const source = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf-8');
  const usedChannels = [...source.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]);
  for (const channel of usedChannels) assert.ok(ipcHandlers.has(channel), `Kanal ohne Handler: ${channel}`);
  for (const channel of ipcHandlers.keys()) {
    assert.ok(usedChannels.includes(channel), `Handler ohne Preload-Methode: ${channel}`);
  }
});

await check('die Renderer-Typen decken genau die Preload-Methoden ab', () => {
  const source = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf-8');
  const exposed = [...source.matchAll(/^  (\w+): /gm)].map((match) => match[1]);
  const types = fs.readFileSync(path.join(root, 'src/types/desktop.d.ts'), 'utf-8');
  for (const method of exposed) {
    assert.ok(new RegExp(`\\b${method}\\(`).test(types), `desktop.d.ts kennt ${method} nicht`);
  }
  assert.ok(exposed.length >= 8, 'erwartet mindestens acht Brückenmethoden');
});

await check('Fenster nutzt contextIsolation + Sandbox und verhindert Navigation', () => {
  const calls = new Map(loadCalls);
  assert.ok(calls.has('windowOpenHandler'), 'setWindowOpenHandler fehlt');
  assert.strictEqual(calls.get('windowOpenHandler'), 'function');
  assert.ok(loadCalls.some((entry) => entry[0] === 'webContents.on' && entry[1] === 'will-navigate'));
  const mainSource = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf-8');
  assert.match(mainSource, /contextIsolation: true/);
  assert.match(mainSource, /nodeIntegration: false/);
  assert.match(mainSource, /sandbox: true/);
});

await check('inspectLocation liest Windows-Pfade und file://-URLs (read-only)', async () => {
  const target = path.join(root, 'tests/fixtures/rekordbox6/master.db');
  const inspect = ipcHandlers.get('rekordbox:inspect-location');
  const asPath = await inspect(null, target);
  assert.strictEqual(asPath.validLocation, true);
  assert.strictEqual(asPath.exists, true);
  assert.strictEqual(asPath.accessMode, 'READ_ONLY');
  assert.ok(asPath.size > 0);

  const asUrl = await inspect(null, 'file:///C:/Music/airdox.wav');
  assert.strictEqual(asUrl.validLocation, true, 'file://-URL muss erkannt werden');
  assert.match(asUrl.path, /[\\/]Music[\\/]airdox\.wav$/);
  assert.strictEqual(asUrl.exists, false);

  const asDrivePath = await inspect(null, 'C:\\Music\\airdox.wav');
  assert.strictEqual(asDrivePath.validLocation, true, 'Laufwerksbuchstabe ist keine URL');

  const httpUrl = await inspect(null, 'https://example.com/track.wav');
  assert.strictEqual(httpUrl.validLocation, false, 'fremde Schemas müssen abgewiesen werden');
});

await check('readOriginalAudio und readAnalysisFile lehnen falsche Quellen ab', async () => {
  const readAudio = ipcHandlers.get('rekordbox:read-original-audio');
  await assert.rejects(
    () => readAudio(null, 'file:///C:/Music/track.mid'),
    /unterstützte Audiodatei/,
    'MIDI darf nicht als Audio akzeptiert werden'
  );
  await assert.rejects(() => readAudio(null, ''), /kein lokaler Dateipfad/);

  const readAnalysis = ipcHandlers.get('rekordbox:read-analysis-file');
  await assert.rejects(
    () => readAnalysis(null, path.join(root, 'package.json')),
    /ANLZ/,
    'Dateityp-Prüfung muss greifen'
  );
});

await check('Dateidialoge liefern nur einen Pfad und nie einen Schreibgriff', async () => {
  const chooseAnalysis = ipcHandlers.get('rekordbox:choose-analysis-file');
  assert.strictEqual(await chooseAnalysis(), null, 'abgewählter Dialog muss null liefern');
  const chooseDb = ipcHandlers.get('rekordbox:choose-rekordbox-database');
  assert.strictEqual(await chooseDb(), null);
  assert.strictEqual(dialogRequests.length, 2);
  assert.ok(dialogRequests.every((options) => options.properties.includes('openFile')));
  const mainSource = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf-8');
  assert.doesNotMatch(mainSource, /writeFile|appendFile|createWriteStream|openSync\([^,]+,\s*'w/);
});

await check('locateRekordboxDatabases und describeEngines laufen ohne Pioneer-Installation', async () => {
  const located = await ipcHandlers.get('rekordbox:locate-rekordbox-databases')();
  assert.ok(Array.isArray(located), 'Erwartet eine Liste (leer, wenn kein Rekordbox installiert ist)');
  const engines = await ipcHandlers.get('rekordbox:database-capabilities')();
  assert.strictEqual(typeof engines.native.available, 'boolean');
  assert.strictEqual(engines.javascript.available, true, 'der JavaScript-Leser muss ohne Build-Tools laufen');
});

await check('read-library-db liefert die Fixture-Zeilen über die Bridge', async () => {
  const read = ipcHandlers.get('rekordbox:read-library-db');
  const result = await read(null, path.join(root, 'tests/fixtures/rekordbox6/master.db'));
  assert.strictEqual(result.available, true, result.reason);
  assert.strictEqual(result.dbType, 'MASTER_DB');
  assert.strictEqual(result.stats.tracks, 2);
  assert.strictEqual(result.rows.content[0].FolderPath, 'C:\\Music\\Rekordbox');
  await assert.rejects(() => read(null, ''), /Kein gültiger Datenbankpfad/);
});

await check('die Quelle der Fixture bleibt unverändert (Read-Only-Zusage)', async () => {
  const file = path.join(root, 'tests/fixtures/rekordbox6/master.db');
  const before = fs.readFileSync(file);
  const beforeMtime = fs.statSync(file).mtimeMs;
  await ipcHandlers.get('rekordbox:read-library-db')(null, file);
  assert.ok(fs.readFileSync(file).equals(before), 'Dateiinhalt wurde verändert');
  assert.strictEqual(fs.statSync(file).mtimeMs, beforeMtime, 'Datei wurde neu geschrieben');
});

console.log(results.join('\n'));
console.log(`\n  ${results.length} Prüfungen bestanden\n`);
