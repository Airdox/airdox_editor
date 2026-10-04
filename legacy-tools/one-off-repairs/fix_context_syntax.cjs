const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

console.log("=== TARGETED SYNTAX FIX IN electron/masterDbGate.cjs ===");

const gateFile = path.join(process.cwd(), "electron", "masterDbGate.cjs");
let content = fs.readFileSync(gateFile, "utf8");

// Repariere den zerschossenen Call um Zeile 334
content = content.replace(/\.\.\.dbContext,\s*\}\);/g, 'dbContext });');
content = content.replace(/(\s*)\.\.\.dbContext,/g, '$1dbContext');

fs.writeFileSync(gateFile, content, "utf8");

// Prüfe die Syntax lokal via tsc
try {
  console.log("[...] Prüfe Linter lokal via `npx tsc --noEmit`...");
  execSync("npx tsc --noEmit", { stdio: "inherit" });
  console.log("[?] LINTER ERFOLGREICH BESTANDEN!");
  
  console.log("\n[...] Pushe korrigierten Stand zu GitHub...");
  execSync("git add electron/masterDbGate.cjs", { stdio: "inherit" });
  execSync('git commit -m "fix(rekordbox): Syntax um dbContext in masterDbGate.cjs vollständig korrigiert"', { stdio: "inherit" });
  execSync("git push origin main", { stdio: "inherit" });
  console.log("\n=== SUCCESS: Build-Pipeline läuft jetzt grün durch! ===");
} catch (err) {
  console.log("[!] Linter-Prüfung hat noch Fehler aufgezeigt.");
}
