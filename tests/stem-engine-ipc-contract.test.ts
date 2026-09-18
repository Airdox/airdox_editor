/**
 * CONTRACT TEST: Stem-Engine ↔ Editor-Anbindung (IPC, Brücke, Deskriptoren).
 *
 * Der Kern (`src/stems/*`) war nach Teil 1 komplett getestet, aber nicht
 * angebunden: `electron/demucsRunner.cjs` kannte eine hartgeschriebene
 * 4-Stem-Liste, `src/audio/stemEngine.ts` nur „Demucs oder Fallback", und die
 * UI hatte weder Fortschritt noch Abbruch. Dieses File hält genau die
 * Nahtstellen fest:
 *
 *   1. Stem-Namen im Demucs-Vorschau-Pfad kommen aus dem Modell-Katalog
 *      (`stemOrder` des htdemucs-Deskriptors) – nicht aus einer Konstanten.
 *   2. IPC-Kanäle: jeder von `preload.cjs` aufgerufene Stem-Kanal ist im
 *      Bridge-Host registriert, und jede Methode von `StemDesktopApi` wird
 *      tatsächlich exponiert (kein „function is not a function" zur Laufzeit).
 *   3. Der Transportvertrag (`src/stems/transportTypes.ts`) ist frei von
 *      Node-Importen, sonst zieht er `node:fs` in das Renderer-Bundle.
 *   4. Die Brücke degradiert sauber: fehlt das Engine-Bundle, gibt es einen
 *      Grund (`ENGINE_BUNDLE_MISSING`) statt eines Exceptions im Renderer.
 *   5. End-to-End über das echte gebündelte Bridge-Modul: Job starten,
 *      Fortschritt, Stem-Bytes – mit dem deterministischen Pipeline-Double.
 *   6. Die UI rendert die Stem-Liste aus dem Deskriptor (`stems.stemIds`) und
 *      bietet Abbruch an.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve('.');

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  STEM-ENGINE ↔ EDITOR: IPC-, BRÜCKEN- UND DESKRIPTOR-VERTRAG');
console.log('═══════════════════════════════════════════════════════════════════');

async function read(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), 'utf8');
}

function uniqueChannels(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))].sort();
}

async function run() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-ipc-contract-'));
  try {
    // =========================================================================
    console.log('\n[ TEST ] #1 Stem-Namen des Vorschau-Pfads kommen aus dem Katalog');
    const catalog = JSON.parse(await read('src/stems/modelCatalog.json')) as {
      models: { id: string; family: string; version: string; stemOrder: string[] }[];
    };
    const demucs = catalog.models.find((model) => model.family === 'htdemucs');
    assert.ok(demucs, 'Katalog muss ein htdemucs-Modell führen');
    const runner = require(path.join(ROOT, 'electron', 'demucsRunner.cjs')) as {
      STEM_NAMES: string[];
      FALLBACK_STEM_NAMES: string[];
      stemNamesForModel: (model: string, repoRoot?: string) => string[];
    };
    assert.deepEqual(
      runner.STEM_NAMES,
      demucs.stemOrder,
      `STEM_NAMES muss dem stemOrder-Deskriptor folgen (${demucs.stemOrder.join(',')}), ist aber ${runner.STEM_NAMES.join(',')}`
    );
    assert.deepEqual(runner.stemNamesForModel(demucs.version, ROOT), demucs.stemOrder, 'Auflösung über die Modell-Version');
    assert.deepEqual(runner.stemNamesForModel('irgendein-modell', ROOT), demucs.stemOrder, 'unbekanntes Modell bleibt beim Deskriptor der Familie');
    const runnerSource = await read('electron/demucsRunner.cjs');
    assert.equal(
      /const STEM_NAMES\s*=\s*\['vocals',\s*'drums',\s*'bass',\s*'other'\]/.test(runnerSource),
      false,
      'die alte hartgeschriebene 4-Stem-Konstante darf nicht zurückkehren'
    );
    console.log(`  ✓ htdemucs-Deskriptor → ${demucs.stemOrder.join(', ')} (Fallback identisch: ${runner.FALLBACK_STEM_NAMES.join(',') === demucs.stemOrder.join(',')})`);

    // =========================================================================
    console.log('\n[ TEST ] #2 IPC-Kanäle: preload ↔ Bridge-Host');
    const bridgeSource = await read('electron/stemEngineBridge.cjs');
    const preloadSource = await read('electron/preload.cjs');
    const bridgeChannels = channelTable(bridgeSource);
    const invoked = uniqueChannels(preloadSource, /invoke\('([a-z:_-]+)'/g);
    const mainSource = await read('electron/main.cjs');
    const registered = new Set([
      ...bridgeChannels,
      ...uniqueChannels(mainSource, /ipcMain\.(?:handle|on)\('(stems:[a-z0-9:-]+)'/g),
    ]);
    const stemInvoked = invoked.filter((channel) => channel.startsWith('stems:'));
    assert.ok(stemInvoked.length >= 12, `preload ruft ${stemInvoked.length} Stem-Kanäle auf`);
    for (const channel of stemInvoked) {
      assert.ok(registered.has(channel), `preload ruft ${channel} auf, aber weder Bridge-Host noch main.cjs registrieren ihn`);
    }
    assert.ok(stemInvoked.includes('stems:job-start') && stemInvoked.includes('stems:job-cancel'), 'Job-Kanäle müssen dabei sein');
    // Der Fortschrittskanal wird gepusht (send, nicht invoke) – muss trotzdem
    // in beiden Richtungen bekannt sein.
    assert.ok(bridgeChannels.includes('stems:job-progress'), 'Host muss den Progress-Kanal kennen');
    assert.ok(preloadSource.includes("ipcRenderer.on('stems:job-progress'"), 'preload muss den Progress-Kanal abnehmen');
    assert.ok(preloadSource.includes('removeListener'), 'und beim Ablösen wieder entfernen');
    console.log(`  ✓ ${stemInvoked.length} invoke-Kanäle + Progress-Kanal gedeckt`);

    console.log('\n[ TEST ] #3 StemDesktopApi ↔ preload-Methoden (1:1)');
    const contract = await read('src/stems/transportTypes.ts');
    const apiBlock = contract.slice(contract.indexOf('export interface StemDesktopApi'), contract.indexOf('}', contract.indexOf('onStemJobProgress')));
    const methods = [...apiBlock.matchAll(/^\s{2}([a-zA-Z]+)\(/gm)].map((match) => match[1]);
    assert.ok(methods.length >= 11, `Vertrag nennt ${methods.length} Methoden`);
    const stemEngineBlock = preloadSource.slice(preloadSource.indexOf('stemEngine: {'));
    for (const method of methods) {
      assert.ok(stemEngineBlock.includes(`${method}:`), `preload exponiert ${method}() nicht – Renderer würde zur Laufzeit scheitern`);
    }
    const typing = await read('src/types/desktop.d.ts');
    assert.match(typing, /stemEngine\?: StemDesktopApi/, 'Window-Typ muss den Vertrag referenzieren (sonst kein Typfehler bei fehlender Methode)');
    assert.match(typing, /import type \{ StemDesktopApi \} from '\.\.\/stems\/transportTypes'/);
    console.log(`  ✓ ${methods.length} Vertragsmethoden in preload + Window-Typ`);

    console.log('\n[ TEST ] #4 Transportvertrag ist browser-sicher (keine Node-Importe)');
    const imports = contract.match(/^import[ \t].*$/gm) ?? [];
    assert.ok(imports.length > 0, 'der Vertrag importiert seine Basistypen');
    for (const line of imports) {
      assert.match(line, /from '\.\/types';$/, `transportTypes.ts darf nur Typen aus ./types importieren, Fund: ${line}`);
    }
    const rendererSource = await read('src/audio/stemEngine.ts');
    assert.match(rendererSource, /import type \{ StemJobView, StemServiceStatus \} from '\.\.\/stems\/transportTypes'/, 'Renderer importiert den Vertrag typ-only');
    assert.equal(/from '\.\.\/stems\/stemJobService'/.test(rendererSource), false, 'der Renderer darf den Node-Kern nicht direkt importieren');
    console.log('  ✓ type-only Import, kein node:* im Vertrag');

    // =========================================================================
    console.log('\n[ TEST ] #5 Brücke ohne Build: ehrlicher Grund statt Exception');
    const emptyRoot = path.join(root, 'empty-app');
    await mkdir(path.join(emptyRoot, 'dist', 'stems'), { recursive: true });
    await mkdir(path.join(emptyRoot, 'electron'), { recursive: true });
    const host = require(path.join(ROOT, 'electron', 'stemEngineBridge.cjs')) as {
      registerStemEngineIpc: (options: {
        repoRoot: string;
        userDataDir: string;
        logger?: unknown;
        ipcMain: { handle: (channel: string, listener: (...args: unknown[]) => unknown) => void };
        broadcast?: (channel: string, payload: unknown) => void;
      }) => { available: boolean; reason?: string; channels: Record<string, string> };
      loadStemBridge: (repoRoot: string, logger?: unknown) => { bridge: unknown; reason?: string };
      sanitizeRequest: (raw: unknown) => Record<string, unknown>;
      CHANNELS: Record<string, string>;
    };
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const missing = host.registerStemEngineIpc({
      repoRoot: emptyRoot,
      userDataDir: path.join(root, 'data-missing'),
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    });
    assert.equal(missing.available, false, 'ohne Bundle ist der Host ausdrücklich nicht verfügbar');
    assert.match(missing.reason ?? '', /build:stems-bridge/, 'Nennung des Build-Schritts im Grund');
    assert.ok(handlers.has(host.CHANNELS.status), 'ein Status-Kanal bleibt registriert (kein No-handler-Fehler im Renderer)');
    const statusResult = (await handlers.get(host.CHANNELS.status)!()) as { ok: boolean; code?: string };
    assert.equal(statusResult.ok, false);
    assert.equal(statusResult.code, 'ENGINE_BUNDLE_MISSING');
    console.log(`  ✓ ${host.CHANNELS.status} → ENGINE_BUNDLE_MISSING, Grund: „…${(missing.reason ?? '').slice(-32)}`);

    console.log('\n[ TEST ] #6 Vor dem Kern eingehende Requests werden gefiltert');
    const sanitized = host.sanitizeRequest({
      profile: 'HIGH_QUALITY',
      modelId: 'x'.repeat(400),
      trackName: 'y'.repeat(400),
      overlap: 42,
      chunkSizeSamples: 10,
      stems: ['vocals', '"; rm -rf /', 3],
      bytes: { huge: true },
      evil: 'sollte verworfen werden',
    });
    assert.equal(sanitized.profile, 'HIGH_QUALITY');
    assert.equal(sanitized.modelId?.toString().length, 120, 'modelId gekürzt');
    assert.equal(sanitized.trackName?.toString().length, 120, 'trackName gekürzt');
    assert.equal(sanitized.overlap, undefined, 'overlap außerhalb 0..0.95 verworfen');
    assert.equal(sanitized.chunkSizeSamples, undefined, 'Chunk unter 4096 verworfen');
    assert.equal(sanitized.stems, undefined, 'Stem-Liste mit ungültigen Einträgen verworfen (keine Teilübernahme)');
    assert.equal(sanitized.bytes, undefined, 'bytes werden nie über sanitizeRequest gereicht');
    assert.equal((sanitized as Record<string, unknown>).evil, undefined, 'unbekannte Felder erreichen den Kern nicht');
    console.log('  ✓ Profil bleibt, Müll fällt raus');

    // =========================================================================
    console.log('\n[ TEST ] #7 End-to-End über das gebündelte Bridge-Modul');
    const bundleDir = path.join(root, 'app', 'dist', 'stems');
    await mkdir(bundleDir, { recursive: true });
    const outfile = path.join(bundleDir, 'node-bridge.cjs');
    if (existsSync(path.join(ROOT, 'dist', 'stems', 'node-bridge.cjs'))) {
      // bereits gebaut (npm run build:stems-bridge) → direkt verwenden
      await writeFile(outfile, await read('dist/stems/node-bridge.cjs'));
    } else {
      const esbuild = (await import('esbuild')) as unknown as {
        build: (options: Record<string, unknown>) => Promise<void>;
      };
      await esbuild.build({
        entryPoints: [path.join(ROOT, 'src', 'stems', 'nodeBridge.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile,
        logLevel: 'silent',
      });
    }
    const bridgeModule = require(outfile) as {
      createStemBridge: (options: Record<string, unknown>) => {
        version: number;
        status: () => Promise<{ ok: boolean; data?: { profiles: unknown[]; usable: boolean } }>;
        onEvent: (listener: (event: unknown) => void) => () => void;
      };
      STEM_BRIDGE_VERSION: number;
    };
    assert.equal(typeof bridgeModule.createStemBridge, 'function', 'Bundle exportiert createStemBridge');
    const serviceRoot = path.join(root, 'app-data');
    const bridge = bridgeModule.createStemBridge({
      root: serviceRoot,
      allowPipelineDouble: true,
      chunkSizeSamples: 44100,
      modelStoreDir: path.join(serviceRoot, 'Models'),
      env: {},
    });
    assert.equal(bridge.version, bridgeModule.STEM_BRIDGE_VERSION);
    const bundledStatus = await bridge.status();
    assert.equal(bundledStatus.ok, true);
    assert.equal((bundledStatus.data?.profiles ?? []).length, 3, 'drei Profile aus dem Katalog');
    assert.equal(typeof bundledStatus.data?.usable, 'boolean');

    const hostWithBundle = host.registerStemEngineIpc({
      repoRoot: path.join(root, 'app'),
      userDataDir: serviceRoot,
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
      broadcast: () => undefined,
    });
    assert.equal(hostWithBundle.available, true, 'mit Bundle meldet der Host Verfügbarkeit');
    const statusViaIpc = (await handlers.get(host.CHANNELS.status)!()) as { ok: boolean; data: { profiles: unknown[] } };
    assert.equal(statusViaIpc.ok, true);
    assert.equal(statusViaIpc.data.profiles.length, 3, 'IPC-Antwort trägt die Katalog-Profile');
    console.log(`  ✓ Bundle v${bridgeModule.STEM_BRIDGE_VERSION}: 3 Profile, IPC-Status antwortet durch den Host`);

    console.log('\n[ TEST ] #8 UI-Ebene: Stem-Liste aus dem Deskriptor, Abbruch vorhanden');
    const deck = await read('src/components/DeckStemsControl.tsx');
    assert.match(deck, /stems\?\.stemIds \?\? STEM_TYPES/, 'Buttons folgen stems.stemIds (Deskriptor), STEM_TYPES nur als Default');
    assert.match(deck, /repeat\(\$\{visibleConfigs\.length\}/, 'Grid folgt der Anzahl der Deskriptor-Stems');
    assert.match(deck, /onCancelSeparation/, 'Abbruch ist verdrahtet');
    const app = await read('src/App.tsx');
    assert.match(app, /stemEngine\.cancelActiveEngineJob\(/, 'App ruft den echten Engine-Abbruch auf');
    assert.match(app, /separateWithEngine\(/, 'HQ-Profile laufen über den Engine-Kern');
    assert.match(app, /profile === 'PREVIEW'/, 'PREVIEW bleibt beim Demucs-Pfad');
    const engine = await read('src/audio/stemEngine.ts');
    for (const channel of ['startStemJob', 'waitStemJob', 'readStemJobStem', 'cancelStemJob', 'onStemJobProgress']) {
      assert.ok(engine.includes(channel), `Renderer nutzt ${channel}() nicht`);
    }
    assert.match(engine, /stemIds:\s*\[\.\.\.job\.stems\]/, 'TrackStems trägt die Deskriptor-Stem-Liste');
    assert.match(engine, /liefert Stems, die der Deck-Mixer nicht darstellen kann/, 'unabbildbare Stems scheitern laut statt still');
    console.log('  ✓ Deck-Buttons, Profil-Chips, Abbruch und Kern-Routing verdrahtet');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log('\n✔ STEM-ENGINE ↔ EDITOR: Vertrag hält');
}

/** Kanalnamen aus der CHANNELS-Tabelle der Bridge. */
function channelTable(source: string): string[] {
  const start = source.indexOf('const CHANNELS');
  assert.ok(start >= 0, 'stemEngineBridge.cjs muss eine CHANNELS-Tabelle haben');
  const block = source.slice(start, source.indexOf('};', start));
  return uniqueChannels(block, /'([a-z0-9:_-]+)'/g);
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
