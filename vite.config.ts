import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import {execSync} from 'node:child_process';
import {defineConfig} from 'vite';

// App version injected at build time (single source: package.json).
const pkgVersion = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')
).version as string;

// Git-Commit zum Build-Zeitpunkt, damit zwei Builds derselben Versionsnummer
// (z. B. 0.4.20 vor/nach dem Pipeline-Umbau) in der UI unterscheidbar sind.
// Fallback ausserhalb eines Git-Checkouts: leer.
let pkgCommit = '';
try {
  pkgCommit = execSync('git rev-parse --short HEAD', {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
} catch {
  pkgCommit = '';
}

export default defineConfig(() => {
  return {
    // WICHTIG: Relative Pfade ("./") sind erforderlich, damit die gebaute App
    // unter dem file://-Protokoll von Electron korrekt lädt. Absolute Pfade
    // ("/assets/...") führen in der ausgelieferten Desktop-App zu 404-Fehlern
    // und damit zum berüchtigten weissen Bildschirm.
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkgVersion),
      __APP_COMMIT__: JSON.stringify(pkgCommit),
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Quellmaps helfen bei der Fehlersuche im Fehlerfall (kein weisser
      // Bildschirm mehr, sondern eine nachvollziehbare Fehlermeldung).
      sourcemap: true,
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true as const,
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
