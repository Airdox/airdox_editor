# pack-project.ps1
#
# Im Projektordner ausführen (dort, wo package.json liegt):
#   powershell -ExecutionPolicy Bypass -File pack-project.ps1
#
# Kopiert das Projekt in einen Temp-Ordner, lässt dabei node_modules,
# .git und typische Build-Ausgaben weg, und packt den Rest in eine ZIP.

$ErrorActionPreference = "Stop"

$ProjectDir = Get-Location
$StampTemp  = Join-Path $env:TEMP ("projekt_pack_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
$ZipName    = "projekt.zip"
$ZipPath    = Join-Path $ProjectDir $ZipName

if (-not (Test-Path (Join-Path $ProjectDir "package.json"))) {
    Write-Host "FEHLER: Hier liegt keine package.json. Bitte im Projektordner ausfuehren." -ForegroundColor Red
    exit 1
}

Write-Host "Kopiere Projekt (ohne node_modules, .git, Build-Ausgaben) ..." -ForegroundColor Cyan

New-Item -ItemType Directory -Path $StampTemp | Out-Null

# Ordner, die NICHT mitkopiert werden (Hauptverursacher der 300 MB)
$ExcludeDirs = @(
    "node_modules",
    ".git",
    "dist",
    "out",
    "release",
    "build_output",
    "coverage",
    ".cache",
    ".parcel-cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".vs"
)

# robocopy kopiert zuverlässig und schnell, /XD schliesst ganze Ordner aus
$xdArgs = $ExcludeDirs | ForEach-Object { "`"$_`"" }
$robocopyArgs = @($ProjectDir, $StampTemp, "/E", "/XD") + $ExcludeDirs + @("/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS")
robocopy @robocopyArgs | Out-Null

# Vorhandene alte ZIP im Zielordner nicht versehentlich mitkopieren
$oldZipInTemp = Join-Path $StampTemp $ZipName
if (Test-Path $oldZipInTemp) { Remove-Item $oldZipInTemp -Force }

if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }

Write-Host "Packe ZIP ..." -ForegroundColor Cyan
Compress-Archive -Path (Join-Path $StampTemp "*") -DestinationPath $ZipPath -CompressionLevel Optimal

Remove-Item $StampTemp -Recurse -Force

$sizeMB = [Math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
Write-Host ""
Write-Host "Fertig: $ZipPath ($sizeMB MB)" -ForegroundColor Green
Write-Host "Diese Datei kannst du jetzt hochladen." -ForegroundColor Green

if ($sizeMB -gt 50) {
    Write-Host ""
    Write-Host "Hinweis: Die ZIP ist noch recht gross ($sizeMB MB)." -ForegroundColor Yellow
    Write-Host "Pruefe, ob z.B. grosse Medien-/Asset-Ordner enthalten sind, die nicht noetig sind." -ForegroundColor Yellow
}
