#!/usr/bin/env node
/**
 * @license
 * Erzeugt das CommonJS-Spiegelmodul der ANLZ-Struktur für den Electron-
 * Hauptprozess.
 *
 * `src/rekordbox/anlzStructure.ts` ist die *einzige* Quelle der ANLZ-
 * Spezifikation. Der Renderer (Vite/ESM) importiert sie direkt; der
 * Electron-Hauptprozess läuft dagegen als unverpacktes CommonJS und kann kein
 * TypeScript laden. Statt die Spezifikation ein zweites Mal zu schreiben
 * (und damit auseinanderlaufen zu lassen), wird sie hier deterministisch nach
 * `electron/generated/anlzStructure.cjs` übersetzt.
 *
 * Das Ergebnis wird mit committet, damit die App auch ohne diesen Build-Schritt
 * startet. `tests/anlz-structure-parity.test.ts` vergleicht beide Module
 * semantisch über dieselben Fixtures und schlägt bei jeder Abweichung fehl.
 *
 * Aufruf: node scripts/build-anlz-structure.mjs [--check]
 */

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'src', 'rekordbox', 'anlzStructure.ts');
const TARGET = path.join(ROOT, 'electron', 'generated', 'anlzStructure.cjs');
const CHECK_ONLY = process.argv.includes('--check');

const BANNER = `/**
 * GENERATED FILE – DO NOT EDIT.
 * Build: npm run build:anlz-structure
 * Source: src/rekordbox/anlzStructure.ts (single source of truth for the
 * Rekordbox ANLZ container structure shared with the renderer parser).
 */`;

const result = await build({
  entryPoints: [SOURCE],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  write: false,
  legalComments: 'none',
  banner: { js: BANNER },
  outfile: path.relative(path.dirname(TARGET), SOURCE).replace(/\\/g, '/'),
});

const code = result.outputFiles[0].text;
if (CHECK_ONLY) {
  let current = '';
  try {
    current = await readFile(TARGET, 'utf8');
  } catch {
    console.error(`build:anlz-structure: ${path.relative(ROOT, TARGET)} fehlt. Bitte "npm run build:anlz-structure" ausführen.`);
    process.exit(1);
  }
  if (current.trim() !== code.trim()) {
    console.error(
      `build:anlz-structure: ${path.relative(ROOT, TARGET)} ist veraltet. Bitte "npm run build:anlz-structure" ausführen.`
    );
    process.exit(1);
  }
  console.log(`build:anlz-structure: ${path.relative(ROOT, TARGET)} ist aktuell.`);
} else {
  await mkdir(path.dirname(TARGET), { recursive: true });
  await writeFile(TARGET, code, 'utf8');
  console.log(
    `build:anlz-structure: ${path.relative(ROOT, SOURCE)} → ${path.relative(ROOT, TARGET)} (${code.length} Bytes)`
  );
}
