#!/usr/bin/env node
/**
 * Baut aus `colab/<name>.md` ein lauffähiges `colab/<name>.ipynb`.
 *
 * Das Markdown ist die Quelle der Wahrheit – ein .ipynb ist in Git nicht
 * reviewbar. Format:
 *
 *   # Titel …          → erste Markdown-Zelle (inkl. Vorrede bis zur ersten Zelle)
 *   <<<CELL md         → Markdown-Zelle
 *   <<<CELL py #@param → Codezelle, Metadaten `{"params": {}}` (Colab-Formularfeld)
 *   >>>                → Zellenende
 *
 *   node scripts/md-to-notebook.mjs colab/airdox-stem-gate.md
 *   node scripts/md-to-notebook.mjs            # alle .md im Ordner colab/
 *
 * Nach dem Bauen: `npm run stems:gate:notebook -- --check` prüft, dass die
 * .ipynb im Repo zum .md passt (CI kann so verhindern, dass jemand nur eine
 * der beiden Dateien ändert).
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function parse(markdown) {
  const lines = markdown.split('\n');
  const cells = [];
  let intro = [];
  let index = 0;
  while (index < lines.length && !lines[index].startsWith('<<<CELL')) {
    intro.push(lines[index]);
    index++;
  }
  const introText = intro.join('\n').trim();
  if (introText) cells.push({ type: 'markdown', source: introText });

  while (index < lines.length) {
    const header = lines[index].match(/^<<<CELL\s+(md|py)(.*)$/);
    if (!header) {
      index++;
      continue;
    }
    const kind = header[1];
    const flags = header[2] ?? '';
    const body = [];
    index++;
    while (index < lines.length && lines[index].trim() !== '>>>') {
      body.push(lines[index]);
      index++;
    }
    index++; // >>>
    cells.push({ type: kind === 'md' ? 'markdown' : 'code', source: body.join('\n').replace(/\s+$/, ''), params: flags.includes('#@param') });
  }
  return cells;
}

function toNotebook(cells) {
  return {
    nbformat: 4,
    nbformat_minor: 0,
    metadata: {
      colab: {
        name: 'airdox-stem-gate',
        // T4 reicht für den Freigabe-Lauf; CPU funktioniert ebenfalls.
        gpuType: 'T4',
        machine_shape: 'gpu',
      },
      accelerator: 'nvidiaGPU',
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python', version: '3' },
    },
    cells: cells.map((cell) => {
      const source = cell.source ? cell.source.split(/(?<=\n)/) : [];
      return cell.type === 'markdown'
        ? { cell_type: 'markdown', metadata: {}, source }
        : {
            cell_type: 'code',
            execution_count: null,
            metadata: cell.params ? { params: {} } : {},
            source,
          };
    }),
  };
}

function serialise(cells) {
  return JSON.stringify(toNotebook(cells), null, 1) + '\n';
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const target = args.find((arg) => !arg.startsWith('--'));
// README.md im Ordner ist Dokumentation, kein Notebook-Rohstoff.
const sources = target
  ? [path.resolve(ROOT, target)]
  : readdirSync(path.join(ROOT, 'colab'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => path.join(ROOT, 'colab', f));

let failed = 0;
for (const file of sources) {
  if (!statSync(file).isFile()) {
    console.error(`keine Datei: ${file}`);
    failed++;
    continue;
  }
  const cells = parse(readFileSync(file, 'utf8'));
  const out = file.replace(/\.md$/, '.ipynb');
  const built = serialise(cells);
  if (check) {
    let current = '';
    try {
      current = readFileSync(out, 'utf8');
    } catch {
      current = '';
    }
    // execution_count/Metadaten können abweichen – verglichen wird der Zellinhalt.
    const fingerprint = (text) => JSON.stringify(JSON.parse(text).cells.map((c) => ({ t: c.cell_type, s: (c.source ?? []).join('') })));
    const same = current && fingerprint(current) === fingerprint(built);
    if (!same) {
      console.error(`✘ ${path.relative(ROOT, out)} ist nicht mehr aktuell (Quelle ${path.relative(ROOT, file)} ändern und neu bauen)`);
      failed++;
    } else {
      console.log(`✓ ${path.relative(ROOT, out)} passt zu ${path.relative(ROOT, file)}`);
    }
    continue;
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, built);
  console.log(`✓ ${path.relative(ROOT, out)} (${cells.filter((c) => c.type === 'code').length} Code-Zellen, ${cells.filter((c) => c.type === 'markdown').length} Markdown)`);
}
if (failed) process.exit(1);
