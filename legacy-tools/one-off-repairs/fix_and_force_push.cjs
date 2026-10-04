const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

console.log("=== RESET & REPAIR electron/masterDbGate.cjs ===");

const gateFile = path.join(process.cwd(), "electron", "masterDbGate.cjs");

// 1. Zwinge Git dazu, den kaputten lokalen Stand mit dem Commit vor den Patches zu überschreiben
try {
  console.log("[...] Setze masterDbGate.cjs auf den letzten sauberen Stand zurück...");
  execSync("git checkout HEAD~2 -- electron/masterDbGate.cjs", { stdio: "inherit" });
} catch (e) {
  try {
    execSync("git checkout main -- electron/masterDbGate.cjs", { stdio: "inherit" });
  } catch (err) {}
}

let content = fs.readFileSync(gateFile, "utf8");

// 2. Erstelle eine saubere Pfadauflösungs-Funktion für D:\PIONEER ganz oben in der Datei
const dDriveHelper = `
// Auto-generated Pfadauflösung für D:\\PIONEER
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
  console.log("[?] Pfadauflösung für D:\\PIONEER sauber eingefügt.");
}

// 3. Git Staging & Push erzwingen
try {
  console.log("\n[...] Füge masterDbGate.cjs hinzu und pushe zu GitHub...");
  execSync("git add electron/masterDbGate.cjs", { stdio: "inherit" });
  execSync('git commit -m "fix(rekordbox): masterDbGate Syntax repariert und D:\\PIONEER Pfadauflösung integriert"', { stdio: "inherit" });
  execSync("git push origin main", { stdio: "inherit" });
  console.log("\n=== SUCCESS: Fix erfolgreich gepusht! GitHub Actions baut die .exe jetzt neu. ===");
} catch (err) {
  console.log("[!] Fehler beim Git Push:", err.message);
}
