/**
 * @license
 * Source hygiene guard.
 *
 * Why this exists: `electron/dbReader.cjs` carried one raw NUL byte inside a
 * regex character class (`/[\s<00>]+$/`). Semantically harmless — and it made
 * every diff tool, GitHub's PR view and `grep` treat 960 lines of product code
 * as *binary*, so nobody could review changes to the most touched file in
 * electron/. The escape sequence `\x00` is byte-identical at runtime, so there
 * is no reason to ever write the literal control character.
 *
 * Run with: npx tsx tests/source-hygiene.test.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTest, assert, report } from './helpers/microTest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.json', '.md', '.css', '.html', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'release', '.git', 'reference']);

function textSources(dir: string, acc: string[] = []): string[] {
  const abs = join(root, dir);
  try {
    for (const entry of readdirSync(abs)) {
      if (entry === '.git' || SKIP_DIRS.has(entry)) continue;
      const full = join(abs, entry);
      if (statSync(full).isDirectory()) textSources(relative(root, full), acc);
      else if (TEXT_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) acc.push(relative(root, full).split('\\').join('/'));
    }
  } catch {
    /* Verzeichnis existiert nicht — für die Guard-Blöcke darunter tolerant sein. */
  }
  return acc;
}

const files = ['src', 'electron', 'tests', '.github']
  .flatMap((dir) => textSources(dir))
  .filter((f, i, all) => all.indexOf(f) === i)
  .sort();

assert(files.length > 40, `Hygiene-Guard findet nur ${files.length} Quelldateien — Pfade verlegt?`);

/** Control bytes that a text file must never contain (tab/LF/CR are allowed). */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

runTest('H1: keine rohen Steuerzeichen (insbesondere NUL) in Quelltexten', () => {
  const offenders: string[] = [];
  for (const file of files) {
    const data = readFileSync(join(root, file));
    const match = CONTROL.exec(data.toString('latin1'));
    if (match) {
      const line = data.toString('latin1').slice(0, match.index).split('\n').length;
      offenders.push(`${file}:${line} (0x${match[0].charCodeAt(0).toString(16).padStart(2, '0')})`);
    }
  }
  assert(
    offenders.length === 0,
    `Rohes Steuerzeichen im Quelltext — Tools/bei GitHub zeigen die Datei als Binärdatei an: ${offenders.join(', ')}. Als Escape-Folge schreiben (\\x00), nicht als Byte.`
  );
});

runTest('H2: kein Byte Order Mark am Dateianfang', () => {
  const offenders = files.filter((file) => readFileSync(join(root, file)).slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  assert(offenders.length === 0, `BOM in ${offenders.join(', ')} — führt zu unsichtbaren Fehlern in Parsern und Problemen mit „use strict"`);
});

runTest('H3: Zeilenenden einheitlich LF', () => {
  const offenders = files.filter((file) => readFileSync(join(root, file)).includes(0x0d));
  assert(
    offenders.length === 0,
    `CRLF in ${offenders.slice(0, 6).join(', ')}${offenders.length > 6 ? ` … (${offenders.length} Dateien)` : ''} — gemischte Zeilenenden machen Diff-Rauschen in Windows-Builds`
  );
});

runTest('H4: Dateienden mit Newline (Git diff --check und Concatenation bleiben sauber)', () => {
  const offenders = files.filter((file) => {
    const data = readFileSync(join(root, file));
    return data.length > 0 && data[data.length - 1] !== 0x0a;
  });
  assert(offenders.length === 0, `fehlender Zeilenumbruch am Dateiende: ${offenders.slice(0, 8).join(', ')}${offenders.length > 8 ? ` … (${offenders.length})` : ''}`);
});

runTest('H5: src/ logt ausschließlich über utils/logger (eine Senke für Konsole, Datei-Log und System-Protokoll)', () => {
  const offenders = files
    .filter((file) => file.startsWith('src/') && !file.endsWith('utils/logger.ts'))
    .filter((file) => {
      const text = readFileSync(join(root, file), 'utf8');
      return /\bconsole\.(log|info|warn|error|debug)\s*\(/.test(text);
    });
  assert(
    offenders.length === 0,
    `direkte console-Aufrufe umgehen Logger, Datei-Log und System-Protokoll — Nutzerberichte verlieren genau die Zeilen, die den Fehler erklären: ${offenders.join(', ')}. Stattdessen logger.info/warn/error('KATEGORIE', …) verwenden.`
  );
});

runTest('H6: Identitäten kommen aus utils/ids — kein Date.now() als id', () => {
  // Zwei `Date.now()`-Aufrufe in einem Objekt können bei einem Tick-Übergang
  // verschiedene Werte liefern (beobachtet: Track-Id vs. Segment-`trackId` beim
  // LOCAL-IMPORT). Eine Projektion, die ein Segment über seine Id auflöst, verliert
  // dann genau diesen Schnitt — still.
  const ID_FROM_CLOCK = /[\w]*[iI]d\s*[:=]\s*[^\n]*Date\.now\(\)/;
  const offenders: string[] = [];
  for (const file of files) {
    if (!file.startsWith('src/')) continue;
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // Kommentarzeilen sind keine Aufrufe (die Doku in utils/ids nennt Präfixe als Beispiel).
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (ID_FROM_CLOCK.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert(
    offenders.length === 0,
    `id-Werte aus der Uhr sind nicht eindeutig und können pro Feld auseinanderlaufen — utils/ids.ts (nextId/nextEditId) verwenden: ${offenders.join(', ')}`
  );
});

runTest('H7: neue Id-Präfixe kollidieren nicht mit Ids der Importer', () => {
  // nextId('seg') würde `seg-1` erzeugen — xmlParser/dbParser nennen ihre
  // importierten Segmente aber genauso (`seg-${index}`). Eine doppelte Id pro Track
  // ist kein Kosmetikfehler: `segById` entscheidet dann über das falsche Edit.
  const idPrefixes = new Set<string>();
  for (const file of files.filter((f) => f.startsWith('src/'))) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
      for (const m of line.matchAll(/nextId\(\s*'([^']+)'\s*\)/g)) idPrefixes.add(m[1]);
    }
  }
  assert(idPrefixes.size > 0, 'utils/ids wird in src/ gar nicht benutzt — Guard verpufft?');
  const parserIds = new Set<string>();
  for (const file of ['src/rekordbox/xmlParser.ts', 'src/rekordbox/dbParser.ts', 'src/App.tsx']) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(/id:\s*`([a-z0-9-]+)-\$\{(?:idx|index|mIdx|hotNum|beatIdx|i)\}/g)) {
      parserIds.add(m[1]);
    }
  }
  const collisions = [...idPrefixes].filter((prefix) => parserIds.has(prefix));
  assert(
    collisions.length === 0,
    `Laufzeit-Ids und Importer-Ids teilen ein Präfix (Kollisionsgefahr in segById): ${collisions.join(', ')}`
  );
});

report('SOURCE HYGIENE GUARD');
