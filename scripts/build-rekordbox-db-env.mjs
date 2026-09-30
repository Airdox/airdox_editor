#!/usr/bin/env node
/**
 * Materialisiert die kleine eigene Rekordbox-Datenbankumgebung auf der Platte.
 *
 *   node scripts/build-rekordbox-db-env.mjs [zielVerzeichnis]
 *
 * Standard-Ziel: artifacts/rekordbox-db-env/ (generiert, nicht im Git).
 *
 * Es entstehen echte, mit den bekannten Pioneer-Schlüsseln verschlüsselte
 * SQLCipher-Datenbanken im dokumentierten Aufbau (master.db mit djmd*-Tabellen,
 * exportLibrary.db mit content/cue/…-Tabellen), dazu ANLZ-Byteblöcke und ein
 * winziges Original-WAV. Damit lässt sich die Import-Pipeline
 *
 *   Byteblöcke → SQL-Abfragen → Tabellen-Einträge → TrackModel → ANLZ-Waveform
 *
 * ohne echte Benutzerbibliothek nachweisen (siehe
 * tests/rekordbox-db-env-pipeline.test.mjs und
 * docs/REKORDBOX_DATABASE_FORMAT.md).
 *
 * Read-only-Hinweis: Die App öffnet diese Dateien später ausschließlich
 * lesend; dieses Skript erzeugt sie einmalig.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { buildDbEnvironment, isSqlCipherAvailable } from '../tests/support/rekordboxDbEnv.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(root, process.argv[2] || path.join('artifacts', 'rekordbox-db-env'));

if (!isSqlCipherAvailable()) {
  console.error(
    'FEHLER: better-sqlite3-multiple-ciphers ist nicht verfügbar.\n' +
      'Die Datenbankumgebung braucht das native SQLCipher-Modul –\n' +
      'z. B. "npm run rekordbox:native:rebuild" ausführen und erneut versuchen.'
  );
  process.exit(1);
}

const env = buildDbEnvironment(target);

const describe = (label, filePath) => {
  const stat = statSync(filePath);
  console.log(`  ${label.padEnd(22)} ${path.relative(root, filePath)} (${stat.size} Byte)`);
};

console.log('Kleine Rekordbox-Datenbankumgebung erzeugt:');
describe('master.db', env.masterDbPath);
describe('exportLibrary.db', env.oneLibraryPath);
describe('ANLZ (Byteblöcke)', env.anlzPath);
describe('Original-Audio', env.originalPath);
console.log(`
Nächste Schritte:
  - Pipeline-Nachweis:  npx tsx tests/rekordbox-db-env-pipeline.test.ts
  - Inspektor in der Desktop-App: master.db/exportLibrary.db read-only öffnen
  - Aufbau/Einheiten:   docs/REKORDBOX_DATABASE_FORMAT.md
Hinweis: Die .db-Dateien sind echte SQLCipher-Datenbanken (verschlüsselte
Byteblöcke, kein "SQLite format 3"-Header) und werden von der App nur lesend
geöffnet.`);
