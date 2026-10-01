#!/usr/bin/env node
/**
 * Run a repository CLI inside Electron's Node runtime.
 *
 * The native Rekordbox SQLCipher addon is rebuilt for Electron, not for the
 * system Node executable. This wrapper sets ELECTRON_RUN_AS_NODE=1 and launches
 * the installed Electron binary so diagnostics use the same ABI as the app.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function fail(message, exitCode = 1) {
  console.error(`[Electron-CLI] ${message}`);
  process.exitCode = exitCode;
}

const [scriptArgument, ...scriptArguments] = process.argv.slice(2);
if (!scriptArgument) {
  fail('Aufruf: node scripts/run-electron-node.mjs <repo-script.mjs> [Argumente]', 2);
} else {
  const target = path.resolve(ROOT, scriptArgument);
  const relativeTarget = path.relative(ROOT, target);
  if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    fail('Das auszuführende Skript muss innerhalb des Repositorys liegen.', 2);
  } else if (!existsSync(target)) {
    fail(`Skript nicht gefunden: ${relativeTarget}`);
  } else {
    let electronPath;
    try {
      electronPath = require('electron');
    } catch (error) {
      fail(
        `Electron-Binary konnte nicht geladen werden. Prüfe, ob npm ci erfolgreich war und ob der Electron-Download durch Netzwerk, Proxy oder Zertifikate blockiert wird. (${error.message || error})`
      );
    }

    if (electronPath) {
      if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
        fail('Die Electron-Anwendung wurde nicht vollständig installiert. Bitte npm ci ausführen.');
      } else {
        const result = spawnSync(electronPath, [target, ...scriptArguments], {
          cwd: ROOT,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: 'inherit',
          windowsHide: true,
        });
        if (result.error) {
          fail(`Electron-CLI konnte nicht gestartet werden: ${result.error.message}`);
        } else {
          process.exitCode = result.status ?? 1;
        }
      }
    }
  }
}
