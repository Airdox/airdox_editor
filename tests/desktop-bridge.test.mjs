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
import os from 'node:os';
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
const productNames = [];
// Was der Speicherdialog „zurückgibt“ – wird pro Prüfung gesetzt.
let saveDialogResult = { canceled: true };
let openDialogResult = { canceled: true, filePaths: [] };
const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-bridge-'));

const stub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
    getAppPath: () => root,
    getPath: (kind) => (kind === 'documents' ? sandboxDir : sandboxDir),
    setName: (name) => productNames.push(name),
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
      return openDialogResult.filePaths?.length
        ? openDialogResult
        : { canceled: true, filePaths: [] };
    },
    showSaveDialog: async (_parent, options) => {
      dialogRequests.push(options);
      return saveDialogResult;
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
    'datei:specify-path',
    'datei:write',
    'datei:write-many',
    'datei:pick-open',
    'datei:pick-directory',
    'datei:read-text',
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

await check('Dateidialoge liefern nur einen Pfad; die Rekordbox-Kanäle bleiben reine Lesespur', async () => {
  const chooseAnalysis = ipcHandlers.get('rekordbox:choose-analysis-file');
  assert.strictEqual(await chooseAnalysis(), null, 'abgewählter Dialog muss null liefern');
  const chooseDb = ipcHandlers.get('rekordbox:choose-rekordbox-database');
  assert.strictEqual(await chooseDb(), null);
  assert.strictEqual(dialogRequests.length, 2);
  assert.ok(dialogRequests.every((options) => options.properties.includes('openFile')));
  // Geschrieben werden darf nur in den datei:*-Kanälen – und dort ausschließlich an
  // einen per Dialog bestätigten Ort. Kein rekordbox:*-Kanal darf schreiben.
  const mainSource = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf-8');
  const blocks = mainSource.split(/ipcMain\.handle\('/).slice(1);
  for (const block of blocks) {
    const channel = block.slice(0, block.indexOf("'"));
    const body = block.slice(0, block.indexOf("\nipcMain.handle(") > 0 ? block.indexOf("\nipcMain.handle(") : block.length);
    if (channel.startsWith('rekordbox:')) {
      assert.doesNotMatch(
        body,
        /writeFile|appendFile|createWriteStream|openSync\([^,]+,\s*'w/,
        `${channel} schreibt, obwohl nur gelesen werden darf`
      );
    }
    if (channel.startsWith('datei:write')) {
      assert.ok(body.includes('assertWritableTarget'), `${channel} prüft die Dialogfreigabe nicht`);
      assert.ok(body.includes('MAX_WRITE_BYTES'), `${channel} hat kein Größenlimit`);
    }
  }
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

await check('Build-Guard erkennt den node-gyp-Fehlerpfad (Leerzeichen + natives Modul)', () => {
  const { analyzeEnvironment } = require(path.join(root, 'tools/check-build-env.cjs'));

  const own = analyzeEnvironment(root);
  const ownErrors = own.issues
    .filter((issue) => issue.level === 'error')
    .map((issue) => issue.message);
  // Der Checkout hier muss die zwei typischen Fehlerbilder nicht melden (Pflege
  // anderer Punkte, z. B. ein fehlender Electron-Install, ist hier egal).
  assert.deepStrictEqual(ownErrors.filter((message) => /Leerzeichen|npmRebuild|assets/.test(message)), []);
  assert.ok(
    own.notes.some((note) => /npmRebuild = false/.test(note)),
    'Der Guard muss npmRebuild:false bestätigen (sonst rebuildet electron-builder)'
  );

  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'space path '));
  try {
    fs.mkdirSync(path.join(fake, 'node_modules/better-sqlite3-multiple-ciphers/build/Release'), { recursive: true });
    fs.writeFileSync(
      path.join(fake, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0', build: { productName: 'X' } })
    );
    const broken = analyzeEnvironment(fake);
    const errors = broken.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message);
    assert.ok(
      errors.some((message) => /Leerzeichen/.test(message)),
      'Pfad mit Leerzeichen + nativem Modul muss als Fehler melden: ' + JSON.stringify(errors)
    );
    assert.ok(
      errors.some((message) => /npmRebuild/.test(message)),
      'fehlendes npmRebuild:false muss als Fehler melden: ' + JSON.stringify(errors)
    );
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

await check('der Build-Guard erkennt das System32-Bild und nennt die Dateinamen', () => {
  const { analyzeEnvironment } = require(path.join(root, 'tools/check-build-env.cjs'));

  // Ein Projektordner, der wie C:\Windows\System32\… aussieht. Dort virtualisiert UAC
  // die Schreibzugriffe, und electron-builders Kindprozesse (7za.exe für das
  // Portable-Paket, makensis.exe für den Installer) finden das eben ausgepackte
  // win-unpacked nicht – im Log: „Add new data to archive: 0 files“.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-guard-'));
  try {
    const inside = path.join(fake, 'Windows', 'System32', 'airdox_editor');
    fs.mkdirSync(inside, { recursive: true });
    fs.writeFileSync(
      path.join(inside, 'package.json'),
      JSON.stringify({
        name: 'x',
        version: '0.1.0',
        build: { productName: 'Rekordbox Desktop Import', npmRebuild: false, win: {} },
      })
    );
    const broken = analyzeEnvironment(inside);
    const errors = broken.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message);
    assert.ok(
      errors.some((message) => /Windows-Verzeichnis/.test(message)),
      'Pfad im Windows-Verzeichnis muss als Fehler melden: ' + JSON.stringify(errors)
    );
    assert.ok(
      broken.issues.some((issue) => issue.level === 'warn' && /Standard-Electron-Icon/.test(issue.message)),
      'fehlendes build.win.icon muss gemeldet werden (electron-builder: „default Electron icon is used“)'
    );

    // Der andere Fall derselben Verwechslung: welcher Stand gebaut wird, steht vor
    // dem Build da – Name und Fassung kommen aus package.json.
    const own = analyzeEnvironment(root);
    const note = own.notes.find((text) => /Es entstehen:/.test(text));
    assert.ok(note, 'der Guard muss die entstehenden Dateinamen nennen');
    assert.ok(/Airdox_intelligents_Editor-0\.2\.0-win-x64\.exe/.test(note), 'Installer-Name: ' + note);
    assert.ok(/Airdox_intelligents_Editor-Portable-0\.2\.0-x64\.exe/.test(note), 'Portable-Name: ' + note);
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

await check('die Build-Konfiguration kann electron-builder nicht mehr ausbremsen', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  assert.strictEqual(pkg.build.npmRebuild, false, 'npmRebuild:false fehlt → electron-builder startet node-gyp');
  // Die dokumentierten Kommandos müssen es auch wirklich sein (Doku ↔ Realität).
  const scripts = pkg.scripts;
  assert.ok(scripts['check:build-env']?.includes('tools/check-build-env.cjs'), 'npm run check:build-env fehlt');
  for (const name of ['package:win', 'package:win:installer', 'package:win:portable']) {
    const script = scripts[name] || '';
    assert.ok(script.includes('--config.npmRebuild=false'), `${name} erzwingt npmRebuild=false nicht`);
    assert.ok(script.includes('npm run check:build-env'), `${name} läuft ohne Build-Guard`);
  }
  // Dokumentierte Dateinamen müssen aus den Mustern in package.json folgen.
  const productName = pkg.build.productName;
  const version = pkg.version;
  const names = {
    installer: `${productName}-${version}-win-x64.exe`,
    portable: `${productName}-Portable-${version}-x64.exe`,
  };
  const docs = fs.readFileSync(path.join(root, 'BUILD-WINDOWS.md'), 'utf-8');
  for (const file of Object.values(names)) {
    assert.ok(docs.includes(file), `BUILD-WINDOWS.md nennt ${file} nicht, obwohl package.json es so benennt`);
  }
  assert.ok(scripts.test?.includes('tests/clip-library.test.ts'), 'npm test überspringt die Clip-Bibliothek');
  assert.ok(scripts.test?.includes('tests/project-io.test.ts'), 'npm test überspringt die Projektdatei-Suite');
  // Ein String an dieser Stelle wird als Provider-Name interpretiert und bricht
  // den Build mit 'Cannot find module for publisher "never"'.
  assert.strictEqual(pkg.build.publish, null, 'build.publish muss null sein (nicht "never")');
  const runtime = Object.keys(pkg.dependencies || {});
  const dev = Object.keys(pkg.devDependencies || {});
  assert.deepStrictEqual(
    runtime.filter((name) => dev.includes(name)),
    [],
    'Build-Werkzeuge dürfen nicht zusätzlich als Runtime-Abhängigkeit im Paket landen'
  );
  for (const unused of ['express', 'dotenv', 'vite']) {
    assert.ok(!runtime.includes(unused), `${unused} wird nirgends importiert und gehört nicht ins Paket`);
  }
  assert.ok(runtime.includes('sql.js'), 'sql.js ist der Compiler-freie Datenbankleser');
  const files = JSON.stringify(pkg.build.files);
  assert.ok(files.includes('sql.js'), 'files muss sql.js für das asar-Paket nennen');
});


await check('der Produktname ist überall identisch (Umbenennung)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf-8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8');
  assert.ok(productNames.includes(pkg.build.productName), 'main.cjs ruft app.setName mit dem Produktnamen auf');
  assert.ok(main.includes(`title: PRODUCT_NAME`), 'Fenstertitel nutzt PRODUCT_NAME');
  assert.ok(html.includes('<title>' + pkg.build.productName), 'index.html-Titel weicht ab: ' + html.match(/<title>[^<]*/)?.[0]);
  assert.strictEqual(pkg.build.productName, 'Airdox_intelligents_Editor');
  assert.ok(pkg.build.nsis.shortcutName === pkg.build.productName, 'Verknüpfungsname weicht ab');

  // Der Renderer bezieht den Namen aus einer einzigen Quelle, nicht aus Streusätzen.
  const productNameModule = fs.readFileSync(path.join(root, 'src/productName.ts'), 'utf-8');
  const declared = /export const PRODUCT_NAME = '([^']+)'/.exec(productNameModule);
  assert.ok(declared, 'src/productName.ts deklariert PRODUCT_NAME nicht');
  assert.strictEqual(declared[1], pkg.build.productName, 'src/productName.ts und package.json sind uneins');
  const titleBar = fs.readFileSync(path.join(root, 'src/components/TitleBar.tsx'), 'utf-8');
  assert.ok(titleBar.includes('PRODUCT_DISPLAY_NAME'), 'Titelleiste zeigt einen hartkodierten Produktnamen');
  assert.ok(
    !/airdox&nbsp;intelligents&nbsp;editor/i.test(titleBar),
    'Titelleiste enthält eine zweite, handgeschriebene Namensschreibweise'
  );

  // Paketname, App-ID und CI-Artefakt folgen demselben Namen.
  assert.strictEqual(pkg.name, pkg.build.productName.toLowerCase(), 'package.json „name“ weicht ab');
  assert.ok(pkg.build.appId.includes('airdox'), `appId ${pkg.build.appId} nennt das Produkt nicht`);
  assert.ok(pkg.build.nsis.shortcutName === pkg.build.productName);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/windows-build.yml'), 'utf-8');
  assert.ok(
    /name:\s*airdox-intelligents-editor-windows-x64/.test(workflow),
    'CI-Artefakt heißt noch nach dem alten Produktnamen'
  );

  // Beschreibung und Meta-Texte gehören auch zum Produkt, nicht zum Gerüst.
  assert.ok(!/palette clips/i.test(html), 'index.html bewirbt noch „palette clips“ statt der Clip-Bibliothek');
  assert.ok(html.includes('application-name'), 'index.html setzt application-name nicht');
});

await check('kein Rest des alten App-Namens in ausgelieferten Dateien', () => {
  // Der alte Produktname war „Rekordbox Desktop Import“. „Rekordbox-Desktop-Importpfad“
  // ist etwas anderes (der Importweg) und darf deshalb nicht melden → \b nach Import.
  const stale = /rekordbox[\s._-]?desktop[\s._-]?import\b/i;
  const skippedDirs = new Set(['node_modules', 'dist', 'release', '.git', 'coverage']);
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'tests' || entry.name === '.git' || skippedDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (/\.(ts|tsx|cjs|mjs|js|json|html|md|yml|yaml|css)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf-8');
        text.split('\n').forEach((line, index) => {
          if (stale.test(line)) hits.push(`${path.relative(root, full)}:${index + 1}: ${line.trim().slice(0, 90)}`);
        });
      }
    }
  };
  walk(root, 0);
  assert.deepEqual(hits, [], 'alte Produktnamen gefunden:\n      ' + hits.join('\n      '));
});

await check('Schreiben ist nur an dialogbestätigte Orte möglich', async () => {
  const write = ipcHandlers.get('datei:write');
  const outside = path.join(sandboxDir, 'einfach-so.wav');
  await assert.rejects(
    () => write(null, { filePath: outside, data: Buffer.from('x').toString('base64') }),
    /nicht in einem Speicherdialog bestätigt/,
    'Schreiben ohne Dialogfreigabe wurde zugelassen'
  );

  const target = path.join(sandboxDir, 'projekt.airdoxproj.json');
  saveDialogResult = { canceled: false, filePath: target };
  const choice = await ipcHandlers.get('datei:specify-path')(null, { kind: 'project', suggestedName: 'projekt.airdoxproj.json' });
  assert.strictEqual(choice.filePath, path.resolve(target), 'Dialogpfad wurde verändert zurückgegeben');
  const result = await write(null, { filePath: target, data: '{\"kind\":\"airdox-intelligents-project\"}', encoding: 'utf8' });
  assert.strictEqual(result.bytes, fs.statSync(target).size, 'gemeldete Bytezahl stimmt nicht');
  assert.ok(fs.readFileSync(target, 'utf-8').includes('airdox-intelligents-project'), 'Inhalt fehlt');
});

await check('ohne Endung ergänzt der Dialog .airdoxproj.json, abbruch liefert null', async () => {
  const noExtension = path.join(sandboxDir, 'ohneendung');
  saveDialogResult = { canceled: false, filePath: noExtension };
  const choice = await ipcHandlers.get('datei:specify-path')(null, { kind: 'project' });
  assert.ok(choice.filePath.endsWith('.airdoxproj.json'), `Erwartet .airdoxproj.json, bekam ${choice.filePath}`);

  saveDialogResult = { canceled: true };
  const aborted = await ipcHandlers.get('datei:specify-path')(null, { kind: 'project' });
  assert.deepStrictEqual(aborted, { canceled: true }, 'Abbruch muss { canceled: true } sein');
});

await check('Mehrfachexport bleibt im bestätigten Ordner (kein Pfadtrick)', async () => {
  const dir = path.join(sandboxDir, 'clips');
  fs.mkdirSync(dir, { recursive: true });
  openDialogResult = { canceled: false, filePaths: [dir] };
  const picked = await ipcHandlers.get('datei:pick-directory')(null, {});
  assert.strictEqual(picked.directory, path.resolve(dir));

  const payload = {
    directory: dir,
    files: [
      { name: '../ausserhalb.wav', data: Buffer.from('RIFF').toString('base64') },
      { name: '02_zwei.wav', data: Buffer.from('RIFF').toString('base64') },
    ],
  };
  const result = await ipcHandlers.get('datei:write-many')(null, payload);
  assert.strictEqual(result.written.length, 2, 'beide Dateien müssen geschrieben werden');
  for (const entry of result.written) {
    assert.strictEqual(path.dirname(entry.filePath), path.resolve(dir), `Datei landet außerhalb: ${entry.filePath}`);
  }
  assert.ok(fs.existsSync(path.join(dir, '02_zwei.wav')), 'Clip-Datei fehlt');

  await assert.rejects(
    () => ipcHandlers.get('datei:write-many')(null, { directory: path.join(sandboxDir, 'fremd'), files: payload.files }),
    /Zielordner wurde nicht in einem Ordnerdialog bestätigt/,
    'Ordner ohne Dialogfreigabe wurde akzeptiert'
  );
});

await check('read-text liest Projekte, aber keine anderen Dateitypen', async () => {
  const project = path.join(sandboxDir, 'lesbar.airdoxproj.json');
  fs.writeFileSync(project, '{\"kind\":\"airdox-intelligents-project\"}', 'utf-8');
  const audio = path.join(sandboxDir, 'fremd.wav');
  fs.writeFileSync(audio, 'RIFF', 'utf-8');

  const result = await ipcHandlers.get('datei:read-text')(null, { filePath: project });
  assert.ok(result.text.includes('airdox-intelligents-project'), 'Projektinhalt nicht gelesen');
  await assert.rejects(
    () => ipcHandlers.get('datei:read-text')(null, { filePath: audio }),
    /Nur Projektdateien/,
    'Der Lesekanal akzeptiert fremde Dateitypen'
  );
});

await check('die Brücke kennt keinen generischen Schreibkanal', () => {
  const preload = fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf-8');
  assert.ok(!/require\('node:fs'\)/.test(preload), 'preload darf kein fs direkt importieren');
  assert.ok(!/ipcRenderer\.sendSync/.test(preload), 'sendSync umgeht die Handler-Prüfung');
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf-8');
  assert.ok(main.includes('assertWritableTarget'), 'Schreibpfade werden nicht gegen Dialogfreigaben geprüft');
});

await check('der Editor schneidet über den geprüften Kern, nicht im Bauteil', () => {
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf-8');
  for (const op of ['copyRangeToEnd', 'moveRangeToStart', 'removeRange', 'insertClipAt', 'replaceRange', 'overdubRange', 'silenceRange', 'cutRange', 'pasteAt']) {
    assert.ok(app.includes(`from './audio/editOps'`) && new RegExp(`${op}\\(`).test(app), `${op} wird nicht aus editOps aufgerufen`);
  }
  // Alte Muster: direkte Sample-Bastelei im Bauteil würde an den Tests vorbeilaufen.
  assert.ok(!/dest\.set\(src\.subarray/.test(app), 'App.tsx schneidet wieder von Hand im Puffer');
  assert.ok(app.includes('analyzePcm('), 'Wellenform wird nach Schnitten nicht neu berechnet');
  assert.ok(app.includes('buildProjectFile(') && app.includes('parseProject('), 'Projekt speichern/öffnen nutzt nicht das Formatmodul');
});

await check('die Quelle der Fixture bleibt unverändert (Read-Only-Zusage)', async () => {
  const file = path.join(root, 'tests/fixtures/rekordbox6/master.db');
  const before = fs.readFileSync(file);
  const beforeMtime = fs.statSync(file).mtimeMs;
  await ipcHandlers.get('rekordbox:read-library-db')(null, file);
  assert.ok(fs.readFileSync(file).equals(before), 'Dateiinhalt wurde verändert');
  assert.strictEqual(fs.statSync(file).mtimeMs, beforeMtime, 'Datei wurde neu geschrieben');
});

fs.rmSync(sandboxDir, { recursive: true, force: true });
console.log(results.join('\n'));
console.log(`\n  ${results.length} Prüfungen bestanden\n`);
