import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import {defineConfig} from 'vite';

// App version injected at build time (single source: package.json).
const pkgVersion = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')
).version as string;

export default defineConfig(() => {
  return {
    // WICHTIG: Relative Pfade ("./") sind erforderlich, damit die gebaute App
    // unter dem file://-Protokoll von Electron korrekt lädt. Absolute Pfade
    // ("/assets/...") führen in der ausgelieferten Desktop-App zu 404-Fehlern
    // und damit zum berüchtigten weissen Bildschirm.
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkgVersion),
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
