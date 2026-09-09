import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    // WICHTIG: Relative Pfade ("./") sind erforderlich, damit die gebaute App
    // unter dem file://-Protokoll von Electron korrekt lädt. Absolute Pfade
    // ("/assets/...") führen in der ausgelieferten Desktop-App zu 404-Fehlern
    // und damit zum berüchtigten weissen Bildschirm.
    base: './',
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
