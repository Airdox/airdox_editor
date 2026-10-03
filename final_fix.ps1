Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

$f = "electron\masterDbGate.cjs"
$c = Get-Content $f -Encoding UTF8 -Raw

# Fix: resolveAnlzPath um D:\PIONEER\Master\share\PIONEER erweitern
$oldResolve = @'
  if (fs.existsSync(resolveAnlzPath(analysisPath))) return analysisPath;
'@

# Zeige aktuelle resolveAnlzPath Funktion (Zeilen 1-20)
$lines = Get-Content $f -Encoding UTF8
Write-Host "=== Aktuelle resolveAnlzPath (Zeilen 1-20) ===" -ForegroundColor Cyan
$lines[0..19] | ForEach-Object { $i = [array]::IndexOf($lines,$_)+1; "$i`: $_" }

# Ersetze den hardcodierten Pfad-Block in resolveAnlzPath
$oldPaths = @'
    path.join('D:', 'PIONEER', relativePioneer),
'@

$newPaths = @'
    path.join('D:', 'PIONEER', 'Master', 'share', 'PIONEER', relativePioneer),
    path.join('D:', 'PIONEER', relativePioneer),
'@

if ($c.Contains($oldPaths.Trim())) {
    $c = $c.Replace($oldPaths, $newPaths)
    Write-Host "OK  resolveAnlzPath gepatcht" -ForegroundColor Green
} else {
    # Fallback: direkt die Zeile 11 patchen
    $c = $c -replace "path\.join\('D:', 'PIONEER', relativePioneer\),", `
        "path.join('D:', 'PIONEER', 'Master', 'share', 'PIONEER', relativePioneer),`n    path.join('D:', 'PIONEER', relativePioneer),"
    Write-Host "OK  resolveAnlzPath via Regex gepatcht" -ForegroundColor Green
}

[System.IO.File]::WriteAllText($f, $c, [System.Text.UTF8Encoding]::new($false))
Write-Host "OK  Datei geschrieben" -ForegroundColor Green

# Verifikation
Write-Host "`n=== Verifikation (Zeilen 1-20) ===" -ForegroundColor Cyan
(Get-Content $f -Encoding UTF8)[0..19] | ForEach-Object { $i++; "${i}: $_" }

# Git
git add $f
git commit -m "fix: ANLZ-Suchpfad D:\PIONEER\Master\share\PIONEER als ersten Kandidaten"
git push origin main
Write-Host "`nPush abgeschlossen - GitHub Actions baut Setup-EXE." -ForegroundColor Green
