@echo off
chcp 65001 > nul
title Airdox Editor - EXE Builder mit Logging

echo ====================================================
echo  AIRDOX EDITOR - WINDOWS EXE BUILDER (DEBUG MODE)
echo ====================================================
echo.

if not exist "scripts" mkdir scripts

echo [1/3] Aktualisiere Build-Skript (scripts/build-exe.mjs)...

(
echo import { execSync } from 'child_process';
echo import fs from 'fs';
echo import path from 'path';
echo.
echo console.log('===================================================='^);
echo console.log('AIRDOX EDITOR - WINDOWS EXE BUILDER'^);
echo console.log('====================================================\n'^);
echo.
echo try {
echo   console.log('[1/3] Bilde Frontend ^(Vite / React^)...'^);
echo   execSync('npm run build', { stdio: 'inherit' }^);
echo.
echo   console.log('\n[2/3] Rekompiliere native Module für Electron...'^);
echo   execSync('npx electron-rebuild -f -w better-sqlite3-multiple-ciphers', { stdio: 'inherit' }^);
echo.
echo   console.log('\n[3/3] Paketiere Standalone Windows .exe...'^);
echo   execSync('npx electron-builder --win portable', { stdio: 'inherit' }^);
echo.
echo   console.log('\n===================================================='^);
echo   console.log('BUILD ERFOLGREICH!'^);
echo   console.log('Deine ausführbare Datei liegt unter: '^ + path.join^(process.cwd^(^), 'dist'^)^);
echo   console.log('===================================================='^);
echo } catch ^(error^) {
echo   console.error('\n[FEHLER beim Build-Prozess]:', error.message^);
echo   process.exit^(1^);
echo }
) > scripts\build-exe.mjs

echo [2/3] Starte Build-Prozess und schreibe Log-Datei (build_debug.log)...
echo Bitte warten... Das Fenster bleibt stumm, während alles in die Log-Datei geschrieben wird.
echo.

:: Leitet stdout (1) und stderr (2) komplett in build_debug.log um
node node_modules\tsx\dist\cli.mjs scripts/build-exe.mjs > build_debug.log 2>&1

echo [3/3] Build beendet. Öffne Log-Datei...
echo.

:: Öffnet das Logfile automatisch in Notepad zur Analyse
if exist build_debug.log (
    start notepad build_debug.log
)

echo ====================================================
echo Fertig! Prüfe das geöffnete Editor-Fenster.
echo ====================================================
pause