# Liest masterDbGate.cjs, patcht isSameMediaPath und die roots-Zeile, schreibt zurück und pusht

$file = "electron\masterDbGate.cjs"
$content = Get-Content $file -Encoding UTF8 -Raw

# ── Fix 1: isSameMediaPath – bei ?-Prefix nur Dateinamen vergleichen ──────────
$oldFn = @'
function isSameMediaPath(left, right) {
  const a = normalizeMediaPath(left);
  const b = normalizeMediaPath(right);
  return Boolean(a && b && a === b);
}
'@

$newFn = @'
function isSameMediaPath(left, right) {
  const a = normalizeMediaPath(left);
  const b = normalizeMediaPath(right);
  if (a && b && a === b) return true;
  // Rekordbox schreibt in ANLZ-PPTH manchmal "?/Dateiname.mp3" wenn das
  // Laufwerk zum Analysezeitpunkt keinen Buchstaben hatte. In diesem Fall
  // reicht der Dateiname als Identitätsbeweis – der Pfad-Prefix ist nicht
  // vertrauenswürdig und darf den Load nicht blockieren.
  const leftIsUnknownDrive = typeof left === 'string' && /^\?[/\\]/.test(left.trim());
  const rightIsUnknownDrive = typeof right === 'string' && /^\?[/\\]/.test(right.trim());
  if (leftIsUnknownDrive || rightIsUnknownDrive) {
    const nameOf = (p) => p ? p.replace(/\\/g, '/').split('/').pop().toLowerCase() : '';
    const la = nameOf(left);
    const ra = nameOf(right);
    return Boolean(la && ra && la === ra);
  }
  return false;
}
'@

# ── Fix 2: master.db-Pfad als ANLZ-Root ableiten ──────────────────────────────
# Statt nur D:\PIONEER hartcodiert, leiten wir aus dem databasePath ab:
# <databaseRoot>\share\PIONEER  (z.B. D:\PIONEER\Master\share\PIONEER)
$oldRoots = "  const roots = [path.win32.join('D:\\\\', 'PIONEER'), path.win32.join('D:\\\\', 'PIONEER', 'Master', 'share', 'PIONEER')];"
$newRoots = @'
  // Leite den ANLZ-Root direkt vom Datenbankpfad ab, damit die Suche immer
  // neben der tatsächlich verwendeten master.db landet.
  // Beispiel: D:\PIONEER\Master\master.db  →  D:\PIONEER\Master\share\PIONEER
  const dbDerivedShare = databasePath
    ? path.win32.join(path.win32.dirname(databasePath), 'share', 'PIONEER')
    : null;
  const roots = [
    ...(dbDerivedShare ? [dbDerivedShare] : []),
    path.win32.join('D:\\', 'PIONEER', 'Master', 'share', 'PIONEER'),
    path.win32.join('D:\\', 'PIONEER'),
  ];
'@

if ($content.Contains($oldFn.Trim())) {
    $content = $content.Replace($oldFn, $newFn)
    Write-Host "OK  isSameMediaPath gepatcht" -ForegroundColor Green
} else {
    Write-Host "WARN isSameMediaPath-Block nicht exakt gefunden – manuell prüfen" -ForegroundColor Yellow
}

if ($content.Contains($oldRoots)) {
    $content = $content.Replace($oldRoots, $newRoots)
    Write-Host "OK  roots-Block gepatcht" -ForegroundColor Green
} else {
    Write-Host "WARN roots-Block nicht exakt gefunden – manuell prüfen" -ForegroundColor Yellow
}

[System.IO.File]::WriteAllText($file, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host "OK  Datei geschrieben" -ForegroundColor Green

# Verifikation
Write-Host "`nVerifikation isSameMediaPath:" -ForegroundColor Cyan
Select-String -Path $file -Pattern "leftIsUnknownDrive|nameOf" | Select-Object LineNumber, Line

Write-Host "`nVerifikation roots:" -ForegroundColor Cyan
Select-String -Path $file -Pattern "dbDerivedShare|PIONEER.*Master.*share" | Select-Object LineNumber, Line

# Git
git add $file
git commit -m "fix: ANLZ-Pfad-Mismatch bei ?-Laufwerk + ANLZ-Root aus databasePath ableiten"
git push origin main
Write-Host "`nPush abgeschlossen – GitHub Actions baut jetzt die neue Setup-EXE." -ForegroundColor Green

