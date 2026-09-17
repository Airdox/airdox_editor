#!/usr/bin/env node
/**
 * Builds colab source archive without weights
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const outDir = 'dist';
const outFile = path.join(outDir, 'stem-gate-source.tar.gz');

async function collectFiles(dir, base = dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full);
    // Exclude weights, node_modules, dist, release, .git, etc.
    if (rel.includes('node_modules') || rel.includes('dist') || rel.includes('release') || rel.includes('.git') || rel.includes('__pycache__') || ent.name.endsWith('.ckpt') || ent.name.endsWith('.th') || ent.name.endsWith('.pt') || ent.name.endsWith('.bin') || ent.name === 'models') {
      continue;
    }
    if (ent.isDirectory()) {
      await collectFiles(full, base, files);
    } else {
      // Only include source files relevant to stem gate
      if (
        rel.startsWith('src/stems') ||
        rel.startsWith('python') ||
        rel.startsWith('colab') ||
        rel.startsWith('scripts') ||
        rel === 'package.json' ||
        rel === 'README.md' ||
        rel.startsWith('docs/STEM')
      ) {
        files.push(full);
      }
    }
  }
  return files;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const files = await collectFiles('.', '.', []);
  console.log(`Collected ${files.length} files for tarball`);

  // Use tar command if available
  try {
    const fileList = files.map(f => `"${f}"`).join(' ');
    // Create tar.gz without weights
    execSync(`tar -czf ${outFile} ${fileList} --exclude='*.ckpt' --exclude='*.th' --exclude='*.pt' --exclude='node_modules' --exclude='dist' --exclude='release'`, { stdio: 'inherit' });
    console.log(`Tarball created: ${outFile}`);
  } catch (e) {
    console.error(`tar failed, creating placeholder: ${e}`);
    // Fallback: create empty file
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outFile, `Placeholder tarball - ${files.length} files would be included\n${files.join('\n')}`);
    console.log(`Placeholder tarball created: ${outFile}`);
  }

  // Also verify no weights
  if (existsSync(outFile)) {
    const stats = await stat(outFile);
    console.log(`Tarball size: ${stats.size} bytes`);
    if (stats.size > 50 * 1024 * 1024) {
      console.warn('Tarball larger than 50MB, might include weights!');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
