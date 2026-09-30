const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const targetFile = path.join(process.cwd(), 'electron', 'masterDbGate.cjs');

console.log('?? [AIRDOX SYSTEM] Starte Auto-Patch & Push...\n');

if (fs.existsSync(targetFile)) {
    let code = fs.readFileSync(targetFile, 'utf8');
    
    // 1. Finde heraus, wie die Variable für die DB-Zeile wirklich heißt (meist vor .title oder .id)
    let correctVar = 'row'; // Default
    const varMatch = code.match(/title:\s*([a-zA-Z0-9_]+)\./);
    if (varMatch && varMatch[1] !== 'track') {
        correctVar = varMatch[1];
        console.log(`?? [ANALYSE] Korrekte Datenbank-Variable erkannt: '${correctVar}'`);
    } else {
        console.log(`?? [ANALYSE] Fallback auf Standard-Variable: '${correctVar}'`);
    }

    // 2. Tausche den falschen Code-Schnipsel aus
    const badString = "path: track.path || track.location || (track.FolderPath ? track.FolderPath + track.FileName : null)";
    const goodString = `path: ${correctVar}.path || ${correctVar}.location || (${correctVar}.FolderPath ? ${correctVar}.FolderPath + ${correctVar}.FileName : null)`;

    if (code.includes(badString)) {
        code = code.replace(badString, goodString);
        fs.writeFileSync(targetFile, code);
        console.log(`? [FIX] Datei masterDbGate.cjs erfolgreich repariert.`);
        
        // 3. Git Commit & Push auslösen
        console.log('\n?? [GIT] Pushe den Fix direkt in die GitHub-Pipeline...');
        try {
            execSync('git add electron/masterDbGate.cjs', { stdio: 'inherit' });
            execSync('git commit -m "fix: resolve ReferenceError by correcting variable name in track mapping"', { stdio: 'inherit' });
            execSync('git push origin main', { stdio: 'inherit' });
            console.log('\n?? [ERFOLG] Alles erledigt! Die GitHub-Pipeline baut jetzt den korrekten Installer.');
        } catch (err) {
            console.error('\n? [GIT FEHLER] Git-Befehle sind fehlgeschlagen (evtl. nichts zu committen?).');
        }
    } else {
        console.log('?? [SKIP] Der fehlerhafte String wurde nicht gefunden. Möglicherweise hast du ihn schon manuell geändert?');
    }
} else {
    console.error(`? [FEHLER] Datei nicht gefunden: ${targetFile}`);
}
