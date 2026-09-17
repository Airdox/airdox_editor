# ==============================================================================
# PIPELINE SETUP SCRIPT (Stufe 4 & Multi-File Utilities)
# ==============================================================================

# 1. Ordner 'scripts' sicherstellen
if (-not (Test-Path "scripts")) {
    New-Item -ItemType Directory -Path "scripts" | Out-Null
    Write-Host "[OK] Ordner 'scripts' erstellt." -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# DATEI 1: scripts/anlz-probe.mjs (Einzeldatei-Probe für Stufe 4)
# ------------------------------------------------------------------------------
$anlzProbeContent = @'
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
function getArg(flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

const fileInput = getArg('--file');

if (!fileInput) {
  console.error('Fehler: Bitte gib eine ANLZ-Datei an mit --file <pfad/zu/ANLZ0000.DAT oder .EXT>');
  process.exit(1);
}

const resolvedPath = path.resolve(fileInput);

if (!fs.existsSync(resolvedPath)) {
  console.error(`Fehler: Datei nicht gefunden: ${resolvedPath}`);
  process.exit(1);
}

const fileBuffer = fs.readFileSync(resolvedPath);
const hashBefore = crypto.createHash('sha256').update(fileBuffer).digest('hex');
const stats = fs.statSync(resolvedPath);

console.log(`==================================================`);
console.log(`ANLZ PROBE (Stufe 4) - Probe-Lauf für: ${path.basename(resolvedPath)}`);
console.log(`==================================================`);
console.log(`Pfad:         ${resolvedPath}`);
console.log(`Größe:        ${stats.size} Bytes`);
console.log(`SHA-256 Vor:  ${hashBefore}`);
console.log(`--------------------------------------------------`);

function parseAnlz(buffer) {
  let offset = 0;
  
  const magic = buffer.toString('ascii', offset, offset + 4);
  if (magic !== 'PMAI' && magic !== 'PANL') {
    throw new Error(`Ungültiger ANLZ-Header: '${magic}' (Erwartet: PMAI oder PANL)`);
  }

  const headerLen = buffer.readUInt32BE(offset + 4);
  const tagLen = buffer.readUInt32BE(offset + 8);
  
  offset += headerLen + tagLen;

  const tags = [];

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) break;

    const tagName = buffer.toString('ascii', offset, offset + 4);
    const tagHeaderLen = buffer.readUInt32BE(offset + 4);
    const tagBlockLen = buffer.readUInt32BE(offset + 8);

    const dataStart = offset + tagHeaderLen;
    const dataEnd = offset + tagHeaderLen + tagBlockLen;

    const tagInfo = {
      name: tagName,
      headerLen: tagHeaderLen,
      blockLen: tagBlockLen,
      offset: offset,
      details: {}
    };

    if (dataStart <= buffer.length) {
      if (tagName === 'PPTH') {
        const pathLen = buffer.readUInt32BE(dataStart);
        tagInfo.details.rawPath = buffer.toString('utf16be', dataStart + 4, dataStart + 4 + pathLen).replace(/\0/g, '');
      } 
      else if (tagName === 'PQTZ' || tagName === 'PQT2') {
        const entryCount = buffer.readUInt32BE(dataStart + 8);
        tagInfo.details.beatCount = entryCount;
      } 
      else if (tagName.startsWith('PWV') || tagName === 'PWAV') {
        const entryBytes = buffer.readUInt32BE(dataStart + 4);
        const entryCount = buffer.readUInt32BE(dataStart + 8);
        tagInfo.details.lenEntryBytes = entryBytes;
        tagInfo.details.lenEntries = entryCount;
      }
      else if (tagName === 'PCOB' || tagName === 'PCO2') {
        const cueCount = buffer.readUInt16BE(dataStart + 6);
        tagInfo.details.cueCount = cueCount;
      }
      else if (tagName === 'PSSI') {
        tagInfo.details.hasPhrases = true;
      }
    }

    tags.push(tagInfo);
    offset = dataEnd;
  }

  return { magic, tags };
}

try {
  const result = parseAnlz(fileBuffer);
  
  console.log(`Container Type: ${result.magic}`);
  console.log(`Gefundene Tags (${result.tags.length}):\n`);

  result.tags.forEach((t, idx) => {
    let detailStr = '';
    if (t.name === 'PPTH') detailStr = `-> Path: "${t.details.rawPath}"`;
    else if (t.details.beatCount !== undefined) detailStr = `-> Beats: ${t.details.beatCount}`;
    else if (t.details.lenEntries !== undefined) detailStr = `-> Entries: ${t.details.lenEntries} (${t.details.lenEntryBytes} B/Entry)`;
    else if (t.details.cueCount !== undefined) detailStr = `-> Cues: ${t.details.cueCount}`;
    else if (t.details.hasPhrases) detailStr = `-> Phrase Structure Present`;

    console.log(` [${String(idx + 1).padStart(2, '0')}] Tag: ${t.name.padEnd(4)} | HeaderLen: ${String(t.headerLen).padStart(3)} | BlockLen: ${String(t.blockLen).padStart(6)} | ${detailStr}`);
  });

  const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(resolvedPath)).digest('hex');
  
  console.log(`--------------------------------------------------`);
  console.log(`SHA-256 Nach: ${hashAfter}`);
  
  if (hashBefore !== hashAfter) {
    console.error(`\n[FAIL] EVIDENZ FEHLGESCHLAGEN: Datei wurde verändert!`);
    process.exit(1);
  }

  const hasEssential = result.tags.some(t => t.name === 'PQTZ' || t.name === 'PQT2' || t.name.startsWith('PWV'));
  if (!hasEssential) {
    console.warn(`\n[WARNUNG] Keine Beatgrid- oder Waveform-Tags gefunden!`);
  } else {
    console.log(`\n[PASS] EVIDENZ GATE STUFE 4 ERFÜLLT (Unverändert & Tag-Inventar valide)`);
  }

} catch (err) {
  console.error(`\n[FAIL] Fehler beim Parsen der ANLZ-Datei:`, err.message);
  process.exit(1);
}
'@

$anlzProbeContent | Out-File -FilePath "scripts/anlz-probe.mjs" -Encoding utf8
Write-Host "[OK] Datei 'scripts/anlz-probe.mjs' geschrieben." -ForegroundColor Green

# ------------------------------------------------------------------------------
# DATEI 2: scripts/batch-probe.mjs (Multi-File Scan für ganze Verzeichnisse)
# ------------------------------------------------------------------------------
$batchProbeContent = @'
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
'@

$batchProbeContent | Out-File -FilePath "scripts/batch-probe.mjs" -Encoding utf8
Write-Host "[OK] Datei 'scripts/batch-probe.mjs' geschrieben." -ForegroundColor Green

# ------------------------------------------------------------------------------
# DATEI 3: package.json Konfiguration anpassen
# ------------------------------------------------------------------------------
if (Test-Path "package.json") {
    $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
    
    if (-not $pkg.PSObject.Properties['scripts']) {
        $pkg | Add-Member -MemberType NoteProperty -Name "scripts" -Value ([PSCustomObject]@{})
    }
    
    $pkg.scripts | Add-Member -MemberType NoteProperty -Name "probe:anlz" -Value "node scripts/anlz-probe.mjs" -Force
    $pkg.scripts | Add-Member -MemberType NoteProperty -Name "probe:anlz-batch" -Value "node scripts/batch-probe.mjs" -Force
    
    $pkg | ConvertTo-Json -Depth 100 | Out-File -FilePath "package.json" -Encoding utf8
    Write-Host "[OK] Befehle 'probe:anlz' und 'probe:anlz-batch' in package.json registriert." -ForegroundColor Green
} else {
    Write-Host "[WARNUNG] Keine package.json gefunden." -ForegroundColor Yellow
}

Write-Host "`nSetup vollständig abgeschlossen!" -ForegroundColor Cyan
Write-Host "Verfügbare Befehle:" -ForegroundColor Yellow
Write-Host " 1. Einzeldatei-Test: npm run probe:anlz -- --file <pfad/zu/ANLZ0000.DAT>" -ForegroundColor White
Write-Host " 2. Ordner-Batch-Test: npm run probe:anlz-batch -- <pfad/zum/ANLZ-Ordner>" -ForegroundColor White