# fix_sqlcipher.ps1  -  baut das native SQLCipher-Modul fuer die Electron-Version des Editors neu.
# Aufruf im Repo-Ordner (C:\Users\p_kro\airdox_editor):
#   powershell -ExecutionPolicy Bypass -File .\fix_sqlcipher.ps1
#   powershell -ExecutionPolicy Bypass -File .\fix_sqlcipher.ps1 -InstallBuildTools   (installiert die C++-Build-Tools, mehrere GB)
# Aendert nur node_modules (Build-Ausgabe). Rekordbox-Daten auf D: werden nicht angefasst.
param([switch]$InstallBuildTools, [string]$TrackId = "87868672")

$ErrorActionPreference = "Continue"
$log = Join-Path $env:TEMP "fix_sqlcipher.log"
Start-Transcript -Path $log -Force | Out-Null

if (-not (Test-Path ".\package.json")) { Write-Host "[XX] Bitte im Repo-Ordner starten (package.json fehlt)."; Stop-Transcript | Out-Null; exit 1 }

Write-Host "== 1) Versionen"
$electronVer = node -e "try{console.log(require('electron/package.json').version)}catch(e){console.log('NICHT GEFUNDEN')}"
Write-Host "  Electron:  $electronVer"
$modPkg = ".\node_modules\better-sqlite3-multiple-ciphers\package.json"
if (Test-Path $modPkg) {
  $modVer = node -e "console.log(require('./node_modules/better-sqlite3-multiple-ciphers/package.json').version)"
  Write-Host "  Modul:     better-sqlite3-multiple-ciphers $modVer"
} else {
  Write-Host "  [XX] Modul fehlt in node_modules -> zuerst 'npm install' ausfuehren."
  Stop-Transcript | Out-Null; exit 1
}
Write-Host "  Node:      $(node --version)"

Write-Host "`n== 2) C++-Build-Tools (Visual Studio) pruefen"
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = $null
if (Test-Path $vswhere) {
  $vsPath = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if ($vsPath) {
  Write-Host "  [OK] C++-Build-Tools gefunden: $vsPath"
} elseif ($InstallBuildTools) {
  Write-Host "  [..] Installiere Visual Studio Build Tools (kann lange dauern, Administratorfenster moeglich) ..."
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
} else {
  Write-Host "  [!!] Keine C++-Build-Tools gefunden. Ohne sie kann das Modul nicht gebaut werden."
  Write-Host "       Erneut starten mit:  powershell -ExecutionPolicy Bypass -File .\fix_sqlcipher.ps1 -InstallBuildTools"
  Write-Host "       (oder 'Desktop development with C++' im Visual Studio Installer waehlen)"
}

Write-Host "`n== 3) Modul fuer Electron $electronVer neu bauen"
npx --yes @electron/rebuild -f -w better-sqlite3-multiple-ciphers -m .

Write-Host "`n== 4) Pruefen"
$bin = Get-ChildItem -Path ".\node_modules\better-sqlite3-multiple-ciphers" -Recurse -Filter "better_sqlite3.node" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($bin) { Write-Host "  [OK] gebaut: $($bin.FullName)" } else { Write-Host "  [XX] better_sqlite3.node wurde nicht erzeugt (siehe Meldungen oben)." }
npm run rekordbox:doctor -- $TrackId

Write-Host "`nProtokoll: $log"
Stop-Transcript | Out-Null
