'use strict';

// Real packaged Electron acceptance. No IPC, model or inference mocks.
// node scripts/verify-stems-desktop.cjs <exe> <mixture.wav> <evidence-dir>
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');

async function playwright() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  try { return require('playwright'); } catch { /* existing npm exec cache */ }
  const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'npm-cache/_npx');
  for (const folder of await fs.readdir(cache)) {
    try { return require(path.join(cache, folder, 'node_modules/playwright')); } catch { /* another package */ }
  }
  throw new Error('Playwright fehlt. npm exec --yes --package=playwright -- playwright --version ausführen.');
}

(async () => {
  const [executable, input, destination, scenario] = process.argv.slice(2);
  assert.ok(executable && input && destination, 'exe, mixture.wav und evidence-dir erforderlich');
  const out = path.resolve(destination);
  await fs.mkdir(out, { recursive: true });
  const report = { startedAt: new Date().toISOString(), executable: path.resolve(executable), input: path.resolve(input), checks: {}, errors: [], crashes: [] };
  let app;
  const started = Date.now();
  try {
    const { _electron } = await playwright();
    const missingModel = scenario === '--missing-model';
    const emptyModels = path.join(out, 'empty-models');
    if (missingModel) await fs.mkdir(emptyModels, { recursive: true });
    app = await _electron.launch({ executablePath: path.resolve(executable), args: [`--user-data-dir=${path.join(out, 'profile')}`], timeout: 60000,
      ...(missingModel ? { env: { ...process.env, AIRODOX_STEM_MODEL_DIR: emptyModels, AIRODOX_STEM_CHECKPOINT_DIR: emptyModels } } : {}),
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('crash', () => report.crashes.push('renderer crash'));
    await page.locator('[data-stem-center]').waitFor();
    const skip = page.getByRole('button', { name: 'Später einrichten / Überspringen', exact: true });
    if (await skip.isVisible()) await skip.click();
    await app.evaluate(() => {
      global.stemQa = { ticks: 0, maxLagMs: 0, last: Date.now() };
      global.stemQaTimer = setInterval(() => {
        const now = Date.now(); global.stemQa.maxLagMs = Math.max(global.stemQa.maxLagMs, now - global.stemQa.last - 100);
        global.stemQa.last = now; global.stemQa.ticks++;
      }, 100);
    });
    await page.evaluate(() => {
      window.stemQa = { ticks: 0, maxLagMs: 0, last: Date.now() };
      window.stemQaTimer = setInterval(() => {
        const now = Date.now(); window.stemQa.maxLagMs = Math.max(window.stemQa.maxLagMs, now - window.stemQa.last - 100);
        window.stemQa.last = now; window.stemQa.ticks++;
      }, 100);
    });
    await page.locator('input[type=file]').setInputFiles(path.resolve(input));
    await page.getByRole('button', { name: 'OK', exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    report.checks.import = true;
    await page.locator('[data-stem-action="start-config"]').click();
    await page.getByRole('button', { name: 'Modell wechseln', exact: true }).click();
    await page.getByRole('button', { name: /^SCNet · Live/ }).click();
    await page.locator('[data-stem-action="start-config"]').click();
    await page.getByRole('button', { name: 'Lokal (GPU/CPU)', exact: true }).click();
    await page.getByRole('button', { name: 'Schnell', exact: true }).click();
    assert.ok(!(await page.locator('[data-stem-center]').innerText()).includes('gerade nicht erreichbar'), 'lokale Konfiguration darf keinen Remote-Verbindungsfehler zeigen');
    report.checks.localConfiguration = true;
    if (missingModel) {
      assert.ok(await page.getByRole('button', { name: 'Stems erzeugen', exact: true }).isDisabled());
      assert.ok(await page.getByRole('button', { name: 'Modell installieren', exact: true }).isVisible());
      await page.getByRole('button', { name: 'Modell installieren', exact: true }).click();
      report.checks.missingModel = (await page.locator('body').innerText()).slice(-7000);
      await page.screenshot({ path: path.join(out, 'missing-model.png'), scale: 'css' });
      assert.equal(report.errors.length, 0);
      assert.equal(report.crashes.length, 0);
      report.pass = true;
      return;
    }
    await page.getByRole('button', { name: 'Stems erzeugen', exact: true }).click();
    const until = async (check, label, timeout = 300000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await check()) return;
        assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error(`Timeout: ${label}`);
    };
    await until(async () => /SCNet: Abschnitt/.test(await page.locator('[data-stem-center]').innerText()), 'echte SCNet-Berechnung startet');
    await page.screenshot({ path: path.join(out, '01-processing.png'), scale: 'css' });
    report.checks.progress = await page.locator('[data-stem-center]').innerText();
    const cancellation = Date.now();
    await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    await until(async () => (await page.getByRole('button', { name: 'Stems erzeugen', exact: true }).count()) === 1, 'Abbruch beendet', 30000);
    report.checks.cancelMs = Date.now() - cancellation;
    await page.screenshot({ path: path.join(out, '02-cancelled.png'), scale: 'css' });
    await page.getByRole('button', { name: 'Stems erzeugen', exact: true }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    report.checks.playDuringSeparation = (await page.getByRole('button', { name: 'Pause', exact: true }).count()) === 1;
    await until(async () => (await page.locator('[data-stem-mixer]').count()) === 1, 'Wiederholung liefert Mixer');
    const ok = page.getByRole('button', { name: 'OK', exact: true }).first();
    if (await ok.isVisible()) await ok.click();
    const mixer = page.locator('[data-stem-mixer]');
    assert.equal(await mixer.locator('input[type=range]').count(), 4);
    report.checks.fourStemChannels = true;
    await page.evaluate(() => {
      window.stemQaLinks = [];
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (...args) {
        if (this instanceof AudioBufferSourceNode && args[0] instanceof GainNode) window.stemQaLinks.push({ source: this, gain: args[0] });
        return connect.apply(this, args);
      };
    });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('button', { name: 'Acapella', exact: true }).click();
    assert.equal(await page.getByTitle('Solo: schaltet alle anderen Stems stumm, sodass nur VOCALS zu hören ist', { exact: true }).getAttribute('aria-pressed'), 'true');
    report.acapellaGains = await page.evaluate(() => window.stemQaLinks.slice(-4).map(x => x.gain.gain.value));
    assert.deepEqual(report.acapellaGains, [1, 0, 0, 0]);
    await page.getByRole('button', { name: 'Instrumental', exact: true }).click();
    assert.equal(await page.getByTitle('Mute: schaltet den VOCALS-Kanal stumm', { exact: true }).getAttribute('aria-pressed'), 'true');
    report.playback = await page.evaluate(() => ({
      context: window.stemQaLinks.at(-1).source.context.state,
      instrumentalGains: window.stemQaLinks.slice(-4).map(x => x.gain.gain.value),
      buffers: window.stemQaLinks.slice(-4).map(x => {
        const pcm = x.source.buffer.getChannelData(0); let energy = 0;
        for (const value of pcm) energy += value * value;
        return { frames: pcm.length, channels: x.source.buffer.numberOfChannels, sampleRate: x.source.buffer.sampleRate, rms: Math.sqrt(energy / pcm.length) };
      }),
    }));
    assert.deepEqual(report.playback.instrumentalGains, [0, 1, 1, 1]);
    assert.equal(report.playback.context, 'running');
    assert.ok(report.playback.buffers.every(buffer => buffer.rms > 0 && Number.isFinite(buffer.rms)));
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    for (const stem of ['DRUMS', 'BASS', 'OTHER', 'VOCALS']) {
      const solo = page.getByTitle(`Solo: schaltet alle anderen Stems stumm, sodass nur ${stem} zu hören ist`, { exact: true });
      await solo.click(); assert.equal(await solo.getAttribute('aria-pressed'), 'true'); await solo.click();
      const mute = page.getByTitle(`Mute: schaltet den ${stem}-Kanal stumm`, { exact: true });
      await mute.click(); assert.equal(await mute.getAttribute('aria-pressed'), 'true'); await mute.click();
    }
    const volume = mixer.locator('input[title^="Lautstärke für VOCALS"]');
    await volume.focus(); await volume.press('Home'); await volume.press('ArrowRight');
    assert.equal(await volume.inputValue(), '0.05');
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    report.checks.mixerControls = true;
    await page.getByTitle('Diesen isolierten VOCALS-Stem als eigenen Clip in die Clip-Palette exportieren', { exact: true }).click();
    await page.getByText('VOCALS-Stem als Clip extrahiert', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    report.checks.clipExport = true;
    await page.screenshot({ path: path.join(out, '03-mixer.png'), scale: 'css' });
    report.mainHeartbeat = await app.evaluate(() => global.stemQa);
    report.rendererHeartbeat = await page.evaluate(() => window.stemQa);
    report.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, stems: document.querySelector('[data-stem-center]').getBoundingClientRect().toJSON() }));
    assert.ok(report.mainHeartbeat.ticks > 10);
    assert.ok(report.rendererHeartbeat.ticks > 10);
    assert.ok(report.mainHeartbeat.maxLagMs < 10000, 'Main-Prozess blockiert >10s');
    assert.ok(report.rendererHeartbeat.maxLagMs < 10000, 'Renderer blockiert >10s');
    assert.equal(report.errors.length, 0);
    assert.equal(report.crashes.length, 0);
    assert.ok(report.viewport.stems.bottom <= report.viewport.height);
    report.pass = true;
  } catch (error) {
    report.pass = false; report.failure = error.stack || String(error); process.exitCode = 1;
  } finally {
    report.elapsedMs = Date.now() - started;
    await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (app) await app.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
