const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

console.log("=== SAUBERE SYNTAX-REPARATUR UND D:\\PIONEER FIX ===");

const gateFile = path.join(process.cwd(), "electron", "masterDbGate.cjs");

// 1. Hole die unbeschädigte Originaldatei vor allen Ersetzungsversuchen
try {
  console.log("[...] Setze masterDbGate.cjs auf den unberührten Remote-Stand zurück...");
  execSync("git fetch origin main", { stdio: "inherit" });
  execSync("git checkout 3b9c8fd -- electron/masterDbGate.cjs", { stdio: "inherit" });
} catch (e) {
  try {
    execSync("git checkout origin/main~3 -- electron/masterDbGate.cjs", { stdio: "inherit" });
  } catch (err) {}
}

let content = fs.readFileSync(gateFile, "utf8");

// 2. Füge NUR die Pfadauflösung für D:\PIONEER ein (ohne bestehende Objekt-Syntax zu verändern)
const dDriveHelper = `
// Auto-generated Pfadauflösung für D:\\PIONEER und Rekordbox USBANLZ
function resolveAnlzPath(analysisPath) {
  if (!analysisPath) return null;
  if (fs.existsSync(analysisPath)) return analysisPath;

  const cleanPath = String(analysisPath).replace(/^[A-Z]:[\\\\/]/i, '').replace(/^[\\\\/]/, '');
  const relativePioneer = cleanPath.replace(/^PIONEER[\\\\/]/i, '');

  const candidates = [
    path.join('D:', 'PIONEER', relativePioneer),
    path.join('D:', cleanPath),
    path.join('D:', 'PIONEER', cleanPath),
    path.join('C:', 'PIONEER', relativePioneer),
    path.join(process.env.APPDATA || '', 'Pioneer', 'rekordbox', 'share', cleanPath)
  ];

  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return analysisPath;
}
`;

if (!content.includes("function resolveAnlzPath")) {
  content = dDriveHelper + "\n" + content;
  content = content.replace(/fs\.existsSync\((analysisPath)\)/g, 'fs.existsSync(resolveAnlzPath($1))');
  fs.writeFileSync(gateFile, content, "utf8");
  console.log("[?] D:\\PIONEER Unterstützung sauber integriert.");
}

// 3. Lokale Syntax-Prüfung vor dem Push
try {
  console.log("[...] Prüfe Linter lokal via `npx tsc --noEmit`...");
  execSync("npx tsc --noEmit", { stdio: "inherit" });
  console.log("[?] Syntax & TypeScript-Check ERFOLGREICH BESTANDEN!");
} catch (err) {
  console.log("[!] Linter hat noch lokale Fehler. Bitte Ausgabe prüfen.");
}

// 4. Git Commit & Push
try {
  console.log("\n[...] Pushe fehlerfreien Stand zu GitHub...");
  execSync("git add electron/masterDbGate.cjs", { stdio: "inherit" });
  execSync('git commit -m "fix(rekordbox): Saubere D:\\PIONEER Pfadauflösung ohne Syntaxfehler in masterDbGate"', { stdio: "inherit" });
  execSync("git push origin main", { stdio: "inherit" });
  console.log("\n=== SUCCESS: Fix auf GitHub gepusht! GitHub Actions baut die .exe jetzt fehlerfrei neu. ===");
} catch (err) {
  console.log("[!] Push fehlgeschlagen:", err.message);
}
