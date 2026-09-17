/**
 * One-click installer with progress events
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function runInstallerScript(scriptPath, options = {}) {
  const { onProgress, env, cwd } = options;
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const isPs1 = scriptPath.endsWith('.ps1');
    let command, args;
    if (isPs1) {
      command = 'powershell';
      args = ['-ExecutionPolicy', 'Bypass', '-File', scriptPath];
    } else {
      command = isWin ? 'bash' : 'bash';
      // On Windows, try bash, else use sh
      if (isWin) {
        // Check if bash exists, else try via WSL or git bash
        command = 'bash';
      }
      args = [scriptPath];
    }

    onProgress?.({ phase: 'start', script: scriptPath });

    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      onProgress?.({ phase: 'log', detail: text.trim() });
    });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      onProgress?.({ phase: 'log', detail: text.trim(), isError: true });
    });

    child.on('close', (code) => {
      if (code === 0) {
        onProgress?.({ phase: 'done', code });
        resolve({ code, stdout, stderr });
      } else {
        onProgress?.({ phase: 'error', code, detail: stderr.slice(0, 1000) });
        reject(new Error(`Installer failed exit ${code}: ${stderr.slice(0, 1000)}`));
      }
    });

    child.on('error', (e) => {
      onProgress?.({ phase: 'error', detail: e.message });
      reject(e);
    });
  });
}

function registerInstallerIpc(ipcMain, options = {}) {
  const { logger } = options;

  ipcMain.handle('stems:install', async (event, opts = {}) => {
    const model = opts.model || 'bsroformer';
    const scriptMap = {
      bsroformer: path.join(__dirname, '..', 'scripts', 'setup-bsroformer-model.sh'),
      all: path.join(__dirname, '..', 'scripts', 'setup-stem-model.sh'),
      demucs: path.join(__dirname, '..', 'scripts', 'setup-stem-model.sh'),
    };
    let scriptPath = scriptMap[model] || scriptMap.all;
    if (process.platform === 'win32') {
      // Prefer ps1 on Windows
      const ps1 = path.join(__dirname, '..', 'scripts', 'setup-stem-model.ps1');
      if (fs.existsSync(ps1)) scriptPath = ps1;
    }

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Installer script not found: ${scriptPath}`);
    }

    const win = event.sender;
    const sendProgress = (data) => {
      try { win.send('stems:install-progress', data); } catch {}
    };

    try {
      if (logger) logger.info('stems:install start', { model, scriptPath });
      const result = await runInstallerScript(scriptPath, {
        onProgress: sendProgress,
      });
      if (logger) logger.info('stems:install done', { model });
      return { success: true, stdout: result.stdout.slice(0, 2000) };
    } catch (e) {
      if (logger) logger.error('stems:install failed', { error: e.message });
      throw e;
    }
  });

  ipcMain.handle('stems:install:check', async () => {
    // Check if models exist
    const modelDir = process.env.AIRODOX_MSST_DIR || path.join(process.cwd(), 'models');
    const checkpoint = path.join(modelDir, 'bsroformer-musdb18hq-4stem-zfturbo.ckpt');
    return {
      modelDir,
      checkpointExists: fs.existsSync(checkpoint),
      checkpointPath: checkpoint,
      envSet: !!process.env.AIRODOX_MSST_DIR,
    };
  });
}

module.exports = {
  runInstallerScript,
  registerInstallerIpc,
};
