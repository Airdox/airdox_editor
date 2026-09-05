/**
 * @license
 * Plattform-neutraler Aufräumer (Windows hat kein `rm -rf`).
 * Löscht Build-Artefakte, damit ein frischer Paketlauf keine Reste enthält.
 */

const fs = require('node:fs');
const path = require('node:path');

const targets = ['dist', 'release', 'release-current', 'server.js'];
const root = path.resolve(__dirname, '..');

let removed = 0;
for (const target of targets) {
  const fullPath = path.join(root, target);
  if (!fs.existsSync(fullPath)) continue;
  fs.rmSync(fullPath, { recursive: true, force: true });
  removed += 1;
  console.log(`entfernt: ${target}`);
}
if (removed === 0) console.log('Nichts zu entfernen – Arbeitsverzeichnis ist sauber.');
