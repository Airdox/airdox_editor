<#
  collect_for_claude.ps1
  Sammelt Quellcode, Konfiguration und Diagnoseausgaben von airdox_editor in einer ZIP-Datei.

  Sicherheit / Rahmenbedingungen:
  - Es wird NICHTS im Projekt oder in D:\PIONEER geaendert. Gelesen wird nur.
  - Geschrieben wird ausschliesslich in %TEMP% (Staging) und in den Zielordner (Standard: Desktop).
  - Nicht enthalten: node_modules, .git, Audiodateien, Datenbanken (master.db),
    ANLZ-Dateien, Binaerdateien, .env-Dateien (API-Keys), Dateien > 1,5 MB.

  Aufruf (PowerShell):
    powershell -ExecutionPolicy Bypass -File .\collect_for_claude.ps1
    powershell -ExecutionPolicy Bypass -File .\collect_for_claude.ps1 -TrackId 9546
#>
param(
  [string]$ProjectDir = "C:\Users\p_kro\airdox_editor",
  [string]$TrackId    = "",
  [string]$OutDir     = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
cmd /c 'chcp 65001 >nul' | Out-Null
$stamp   = Get-Date -Format 'yyyyMMdd_HHmm'
$stage   = Join-Path $env:TEMP "airdox_collect_$stamp"
$diag    = Join-Path $stage "_diagnostics"
$zipPath = Join-Path $OutDir "airdox_editor_upload_$stamp.zip"
$maxBytes = 1500000

if (-not (Test-Path $ProjectDir)) { Write-Host "Projektordner nicht gefunden: $ProjectDir" -ForegroundColor Red; exit 1 }

$xd = @('node_modules','.git','dist','dist-electron','release','out','build','artifacts',
        'code_analysis_out','__pycache__','.venv','venv','target','.cache','coverage','.vite')
$xf = @('*.wav','*.mp3','*.flac','*.aif','*.aiff','*.m4a','*.ogg','*.dll','*.exe','*.node','*.pyd',
        '*.db','*.sqlite','*.sqlite3','*.zip','*.7z','*.asar','*.dat','*.ext','*.2ex','*.pt','*.pth',
        '*.onnx','*.ckpt','*.bin','*.pdb','*.obj','*.lib','.env','.env.*','*.pem','*.key',
        'rekordbox_export2.xml')

New-Item -ItemType Directory -Path $stage, $diag -Force | Out-Null

# 1) Projektdateien kopieren (nur lesen am Original)
Write-Host "Kopiere Projektdateien ..." -ForegroundColor Cyan
$rcArgs = @($ProjectDir, $stage, '/E', "/MAX:$maxBytes", '/XD') + $xd + @('/XF') + $xf +
          @('/NFL','/NDL','/NJH','/NJS','/NP')
& robocopy @rcArgs | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "robocopy meldete Fehler ($LASTEXITCODE)" -ForegroundColor Red }

# .env.example soll mit (enthaelt keine Geheimnisse)
$envExample = Join-Path $ProjectDir '.env.example'
if (Test-Path $envExample) { Copy-Item $envExample (Join-Path $stage '.env.example') -Force }

# 2) Liste uebersprungener grosser Dateien
$bigArgs = @($ProjectDir, (Join-Path $env:TEMP 'airdox_dummy'), '/E', '/L', "/MIN:$($maxBytes + 1)", '/XD') + $xd +
           @('/FP','/NJH','/NJS','/NDL','/NC','/NP')
(& robocopy @bigArgs) | Out-File (Join-Path $diag 'SKIPPED_LARGE_FILES.txt') -Encoding utf8

# 3) Stichprobe der Rekordbox-XML (nur die ersten 150 Zeilen)
$xml = Join-Path $ProjectDir 'rekordbox_export2.xml'
if (Test-Path $xml) {
  Get-Content $xml -TotalCount 150 -Encoding UTF8 | Out-File (Join-Path $diag 'rekordbox_export2.head150.xml') -Encoding utf8
  $cnt = (Select-String -Path $xml -Pattern '<TRACK ' -SimpleMatch | Measure-Object).Count
  "TRACK-Elemente in rekordbox_export2.xml: $cnt" | Out-File (Join-Path $diag 'xml_info.txt') -Encoding utf8
}

# 4) Umgebung und Git-Stand
$info = @()
$info += "Datum: $(Get-Date -Format s)"
$info += "Windows: $([Environment]::OSVersion.VersionString)"
$info += "Node: $(cmd /c 'node -v 2>&1')"
$info += "npm: $(cmd /c 'npm -v 2>&1')"
$info += "Python: $(cmd /c 'python --version 2>&1')"
$info += "Projektordner: $ProjectDir"
$info | Out-File (Join-Path $diag 'environment.txt') -Encoding utf8

Push-Location $ProjectDir
try {
  $git = @()
  $git += "Branch: $(cmd /c 'git rev-parse --abbrev-ref HEAD 2>&1')"
  $git += "HEAD:   $(cmd /c 'git rev-parse HEAD 2>&1')"
  $git += "--- git status --short ---"
  $git += (cmd /c 'git status --short 2>&1')
  $git += "--- git log -15 --oneline ---"
  $git += (cmd /c 'git log -15 --oneline 2>&1')
  $git | Out-File (Join-Path $diag 'git_info.txt') -Encoding utf8

  # 5) Diagnose-Befehle (laut VORHABEN.md alle ohne Schreibzugriff auf Rekordbox-Quellen)
  Write-Host "Pruefe ANLZ-Spiegelmodul ..." -ForegroundColor Cyan
  (cmd /c 'npm run build:anlz-structure:check 2>&1') | Out-File (Join-Path $diag 'anlz_structure_check.txt') -Encoding utf8

  if ($TrackId -ne "") {
    Write-Host "Starte rekordbox:doctor fuer TrackID $TrackId ..." -ForegroundColor Cyan
    (cmd /c "npm run rekordbox:doctor -- $TrackId 2>&1") | Out-File (Join-Path $diag "doctor_$TrackId.txt") -Encoding utf8
    Write-Host "Starte test:rekordbox:runtime fuer TrackID $TrackId ..." -ForegroundColor Cyan
    (cmd /c "npm run test:rekordbox:runtime -- $TrackId 2>&1") | Out-File (Join-Path $diag "runtime_$TrackId.txt") -Encoding utf8
  } else {
    "Kein -TrackId angegeben: doctor und runtime-Test wurden uebersprungen." | Out-File (Join-Path $diag 'doctor_SKIPPED.txt') -Encoding utf8
  }
} finally { Pop-Location }

# 6) Rekordbox-Pfadeinstellungen: NUR db-path und analysis-data-root-path (sonst nichts aus der Datei)
$opt = Join-Path $env:APPDATA 'Pioneer\rekordboxAgent\storage\options.json'
if (Test-Path $opt) {
  try {
    $json = Get-Content $opt -Raw | ConvertFrom-Json
    $out = @()
    foreach ($pair in $json.options) {
      if ($pair[0] -eq 'db-path' -or $pair[0] -eq 'analysis-data-root-path') { $out += "$($pair[0]) = $($pair[1])" }
    }
    $out | Out-File (Join-Path $diag 'rekordbox_paths.txt') -Encoding utf8
  } catch {
    "options.json konnte nicht gelesen werden." | Out-File (Join-Path $diag 'rekordbox_paths.txt') -Encoding utf8
  }
} else {
  "options.json nicht unter $opt gefunden." | Out-File (Join-Path $diag 'rekordbox_paths.txt') -Encoding utf8
}

# 7) ZIP erzeugen
Write-Host "Erstelle ZIP ..." -ForegroundColor Cyan
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fs = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
$root = (Resolve-Path $stage).Path.TrimEnd('\') + '\'
Get-ChildItem $stage -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($root.Length).Replace('\','/')
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
}
$zip.Dispose(); $fs.Dispose()
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

$sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host ""
Write-Host "Fertig: $zipPath ($sizeMb MB)" -ForegroundColor Green
if ($sizeMb -gt 30) { Write-Host "Hinweis: ZIP ist gross. Eventuell passt sie nicht in den Upload." -ForegroundColor Yellow }
Write-Host "Diese Datei im Chat hochladen."
