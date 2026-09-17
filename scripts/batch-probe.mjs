import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const dirInput = args[0];

if (!dirInput) {
  console.error('Fehler: Bitte gib ein Verzeichnis an: node scripts/batch-probe.mjs <ordner-pfad>');
  process.exit(1);
}

const targetDir = path.resolve(dirInput);

function findAnlzFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      findAnlzFiles(filePath, fileList);
    } else if (file.toUpperCase().startsWith('ANLZ') && (file.toUpperCase().endsWith('.DAT') || file.toUpperCase().endsWith('.EXT'))) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

try {
  const files = findAnlzFiles(targetDir);
  console.log(`[BATCH PROBE] ${files.length} ANLZ-Dateien in '${targetDir}' gefunden.\n`);

  files.forEach((f, idx) => {
    console.log(`>>> [${idx + 1}/${files.length}] TESTE: ${f}`);
    try {
      execSync(`node scripts/anlz-probe.mjs --file "${f}"`, { stdio: 'inherit' });
      console.log('\n');
    } catch {
      console.error(`[FAIL] Fehler bei Datei: ${f}\n`);
    }
  });
} catch (err) {
  console.error('Fehler beim Ordnerscan:', err.message);
}
