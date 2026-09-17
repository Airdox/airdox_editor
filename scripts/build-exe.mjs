import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

console.log('====================================================');
console.log('AIRDOX EDITOR - WINDOWS EXE BUILDER');
console.log('====================================================\n');

try {
  console.log('[1/3] Bilde Frontend (Vite / React)...');
  execSync('npm run build', { stdio: 'inherit' });

  console.log('\n[2/3] Rekompiliere native Module für Electron...');
  execSync('npx electron-rebuild -f -w better-sqlite3-multiple-ciphers', { stdio: 'inherit' });

  console.log('\n[3/3] Paketiere Standalone Windows .exe...');
  execSync('npx electron-builder --win portable', { stdio: 'inherit' });

  console.log('\n====================================================');
  console.log('BUILD ERFOLGREICH!');
  console.log('Deine ausführbare Datei liegt unter: ' + path.join(process.cwd(), 'dist'));
  console.log('====================================================');
} catch (error) {
  console.error('\n[FEHLER beim Build-Prozess]:', error.message);
  process.exit(1);
}
