# Diagnose + Fix: ANLZ-Suchpfad auf D:\PIONEER\Master\share\PIONEER setzen
# Laedt nur, manipuliert Originaldatei nie (read-only)

$f = "electron\masterDbGate.cjs"
$c = Get-Content $f -Encoding UTF8 -Raw

Write-Host "=== Dateigroesse ===" -ForegroundColor Cyan
Write-Host ((Get-Item $f).Length) "Bytes"

Write-Host "`n=== Alle Zeilen mit PIONEER oder USBANLZ oder roots ===" -ForegroundColor Cyan
Select-String -Path $f -Pattern "PIONEER|USBANLZ|roots|anlz|anl_" -CaseSensitive:$false | Select-Object LineNumber, Line | Format-Table -AutoSize

Write-Host "`n=== Zeilen 120-180 ===" -ForegroundColor Cyan
(Get-Content $f -Encoding UTF8)[119..179] | ForEach-Object { $i = [array]::IndexOf((Get-Content $f -Encoding UTF8),$_)+1; "$i`: $_" }
