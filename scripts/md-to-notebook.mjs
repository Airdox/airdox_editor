#!/usr/bin/env node
/**
 * Builds ipynb from md source of truth (colab/airdox-stem-gate.md -> colab/airdox-stem-gate.ipynb)
 * Checks manifest via --check
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const check = args.includes('--check');

const mdPath = path.join('colab', 'airdox-stem-gate.md');
const ipynbPath = path.join('colab', 'airdox-stem-gate.ipynb');

function mdToNotebook(mdContent) {
  const lines = mdContent.split('\n');
  const cells = [];
  let currentMd = [];
  let currentCode = [];
  let inCodeBlock = false;
  let codeLang = '';

  function flushMd() {
    if (currentMd.length) {
      const source = currentMd.join('\n');
      if (source.trim()) {
        cells.push({
          cell_type: 'markdown',
          metadata: {},
          source: source.split('\n').map(l => l + '\n'),
        });
      }
      currentMd = [];
    }
  }

  function flushCode() {
    if (currentCode.length) {
      cells.push({
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: currentCode.join('\n').split('\n').map(l => l + '\n'),
      });
      currentCode = [];
    }
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
        if (codeLang === '' || codeLang === 'python' || codeLang === 'bash' || codeLang === 'javascript') {
          flushMd();
        } else {
          // treat as markdown fence
          currentMd.push(line);
          inCodeBlock = false;
        }
      } else {
        inCodeBlock = false;
        if (codeLang === 'python' || codeLang === 'bash' || codeLang === 'javascript' || codeLang === '') {
          flushCode();
        } else {
          currentMd.push(line);
        }
        codeLang = '';
      }
    } else {
      if (inCodeBlock) {
        if (codeLang === 'python' || codeLang === 'bash' || codeLang === 'javascript' || codeLang === '') {
          currentCode.push(line);
        } else {
          currentMd.push(line);
        }
      } else {
        currentMd.push(line);
      }
    }
  }
  flushMd();
  flushCode();

  // Ensure at least one cell
  if (cells.length === 0) {
    cells.push({
      cell_type: 'markdown',
      metadata: {},
      source: ['# Airdox Stem Gate\n'],
    });
  }

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.10.0' },
      colab: { provenance: [] },
    },
    cells,
  };
}

async function main() {
  if (!existsSync(mdPath)) {
    console.error(`Markdown source not found: ${mdPath}`);
    process.exit(1);
  }
  const mdContent = await readFile(mdPath, 'utf8');
  const notebook = mdToNotebook(mdContent);
  const json = JSON.stringify(notebook, null, 2);

  if (check) {
    if (!existsSync(ipynbPath)) {
      console.error(`Notebook missing: ${ipynbPath} – run npm run stems:gate:notebook to generate`);
      process.exit(1);
    }
    const existing = await readFile(ipynbPath, 'utf8');
    // Normalize for comparison: parse and re-stringify to avoid whitespace diff
    try {
      const existingObj = JSON.parse(existing);
      const existingNorm = JSON.stringify(existingObj, null, 2);
      const newNorm = JSON.stringify(notebook, null, 2);
      if (existingNorm !== newNorm) {
        console.error(`Notebook out of date: ${ipynbPath} does not match ${mdPath}`);
        console.error(`Run: npm run stems:gate:notebook`);
        // Show diff snippet
        const existingLines = existingNorm.split('\n');
        const newLines = newNorm.split('\n');
        let diffCount = 0;
        for (let i = 0; i < Math.min(existingLines.length, newLines.length); i++) {
          if (existingLines[i] !== newLines[i]) {
            console.error(`Diff at line ${i}:`);
            console.error(`- ${existingLines[i]}`);
            console.error(`+ ${newLines[i]}`);
            diffCount++;
            if (diffCount > 10) break;
          }
        }
        process.exit(1);
      } else {
        console.log(`Notebook check passed: ${ipynbPath} matches ${mdPath}`);
      }
    } catch (e) {
      console.error(`Failed to parse existing notebook: ${e}`);
      process.exit(1);
    }
  } else {
    await writeFile(ipynbPath, json);
    console.log(`Notebook generated: ${ipynbPath} from ${mdPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
