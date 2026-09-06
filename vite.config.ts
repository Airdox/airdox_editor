import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {readFileSync} from 'node:fs';
import {defineConfig} from 'vite';

// Die Fassung steht nur an einer Stelle: in package.json. electron-builder liest
// sie für den Dateinamen und die Versionsressource der EXE, der Rumpf liest sie
// über dieses `define` – damit Titelleiste und Projektdatei nicht nachlaufen.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string;
};

export default defineConfig(() => {
  return {
    // Relative asset URLs: the packaged desktop app loads dist/index.html from
    // the filesystem (file://), where absolute "/assets/..." paths would 404.
    base: './',
    plugins: [react(), tailwindcss()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Die Arena-Sandbox reicht die Vorschau über einen Proxy-Host (*.e2b.app) durch.
      // Ohne Freigabe antwortet Vite dort mit 403 "blocked host".
      allowedHosts: ['.e2b.app'],
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
