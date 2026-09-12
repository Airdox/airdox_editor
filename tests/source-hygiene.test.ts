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

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function runTest(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (err: any) {
    results.push({ name, passed: false, error: err?.message || String(err) });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

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

const failed = results.filter((r) => !r.passed);
console.log('\n' + '═'.repeat(70));
console.log('  SOURCE HYGIENE GUARD');
console.log('═'.repeat(70));
for (const r of results) {
  console.log(`  ${r.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
}
console.log(`\n  ${files.length} Quelldateien geprüft (src, electron, tests, .github)`);
console.log('─'.repeat(70) + '\n');
if (failed.length) process.exit(1);
