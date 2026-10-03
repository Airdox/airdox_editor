// Opt-in CI smoke: exercises the actual packaged renderer and remote IPC.
// Not active in ordinary launches. No user audio or Google credentials involved.
const fs = require('node:fs/promises');
const path = require('node:path');

exports.attachPackagedSmoke = function (window, app) {
  const destination = process.env.AIRDOX_PACKAGED_SMOKE_DIR;
  if (!app.isPackaged || !destination) return;
  const timer = setTimeout(() => app.exit(2), 90000);
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((document.querySelector('#root')?.textContent?.length ?? 0) > 100) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if ((document.querySelector('#root')?.textContent?.length ?? 0) <= 100) throw new Error('Renderer did not render');
        if (typeof window.rekordboxDesktop?.openColabPackage !== 'function') throw new Error('Colab package IPC missing');
        const status = await window.rekordboxDesktop.stemEngine.remoteStatus();
        if (!status.ok || !Array.isArray(status.data.jobs)) throw new Error('Remote IPC failed: ' + JSON.stringify(status));
        return { rendererLoaded: true, remoteIpc: true, workerReady: status.data.workerReady, url: location.href };
      })()`);
      const directory = path.join(process.resourcesPath, 'colab');
      for (const file of ['airdox-colab-worker.zip', 'airdox-stem-remote-worker.ipynb', 'bundle.json', 'ABNAHME.md']) {
        if (!(await fs.stat(path.join(directory, file))).size) throw new Error(`Missing packaged file ${file}`);
      }
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, 'windows-smoke.json'), JSON.stringify({ result: 'PASS', appVersion: app.getVersion(), platform: process.platform, ...result }, null, 2));
      await fs.writeFile(path.join(destination, 'windows-smoke.png'), (await window.webContents.capturePage()).toPNG());
      clearTimeout(timer);
      app.exit(0);
    } catch (error) {
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, 'windows-smoke.json'), JSON.stringify({ result: 'FAIL', error: String(error) }));
      clearTimeout(timer);
      app.exit(1);
    }
  });
};
