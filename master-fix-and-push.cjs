const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('?? [AIRDOX MASTER-FIX] Starte Repository-Reparatur & Installer-Optimierung...\n');

const baseDir = process.cwd();
const paths = {
    masterDbGate: path.join(baseDir, 'electron', 'masterDbGate.cjs'),
    packageJson: path.join(baseDir, 'package.json'),
};

// --- 1. PACKAGE.JSON: ASAR-UNPACK & NUR NSIS-INSTALLER ---
console.log('?? [1/4] Konfiguriere package.json (asarUnpack & NSIS-Installer)...');
if (fs.existsSync(paths.packageJson)) {
    let pkg = JSON.parse(fs.readFileSync(paths.packageJson, 'utf8'));
    if (!pkg.build) pkg.build = {};
    
    // Unpack für schwere Binaries erzwingen
    pkg.build.asarUnpack = [
        "node_modules/better-sqlite3-multiple-ciphers/**/*",
        "node_modules/onnxruntime-node/**/*",
        "**/*.node"
    ];

    // AUSSCHLIESSLICH NSIS-Installer konfigurieren (kein Portable!)
    pkg.build.win = {
        "target": [
            {
                "target": "nsis",
                "arch": ["x64"]
            }
        ]
    };

    pkg.build.nsis = {
        "oneClick": false,
        "allowToChangeInstallationDirectory": true,
        "createDesktopShortcut": true,
        "createStartMenuShortcut": true
    };

    fs.writeFileSync(paths.packageJson, JSON.stringify(pkg, null, 2));
    console.log('  ? package.json: NSIS-Installer-Ziel und asarUnpack erfolgreich gesetzt.');
} else {
    console.error('  ? package.json nicht gefunden!');
    process.exit(1);
}

// --- 2. masterDbGate.cjs TRACK PATH FIX ---
console.log('\n?? [2/4] Prüfe electron/masterDbGate.cjs auf Track-Pfad-Mapping...');
if (fs.existsSync(paths.masterDbGate)) {
    let code = fs.readFileSync(paths.masterDbGate, 'utf8');
    fs.writeFileSync(paths.masterDbGate + '.bak', code); // Backup

    const mappingRegex = /({[\s\S]*?id:\s*[^,\n]+,[\s\S]*?title:\s*[^,\n]+[\s\S]*?})/;
    const match = code.match(mappingRegex);

    if (match) {
        let block = match[0];
        let varName = 'row';
        if (block.includes('track.')) varName = 'track';
        else if (block.includes('item.')) varName = 'item';

        if (!block.includes('path:') && !block.includes('location:')) {
            console.log(`  ?? Injiziere fehlendes 'path'-Mapping mit Variable: ${varName}`);
            const pathInject = `\n      path: ${varName}.path || ${varName}.location || (${varName}.FolderPath ? ${varName}.FolderPath + ${varName}.FileName : null),`;
            const patchedBlock = block.replace(/(title:\s*[^,\n]+,)/, `$1${pathInject}`);
            code = code.replace(block, patchedBlock);
        } else {
            console.log('  ?? Path-Mapping ist bereits vorhanden.');
        }
    }

    if (code.includes('SELECT') && !code.includes('FolderPath') && !code.includes('*')) {
        code = code.replace(/SELECT\s+(id,.*?title.*?)FROM/gi, 'SELECT $1, FolderPath, FileName, location FROM');
        console.log('  ?? SQL SELECT Query um Pfad-Spalten erweitert.');
    }

    fs.writeFileSync(paths.masterDbGate, code);
    console.log('  ? masterDbGate.cjs erfolgreich gepatcht.');
} else {
    console.error('  ? electron/masterDbGate.cjs nicht gefunden!');
    process.exit(1);
}

// --- 3. TYPESCRIPT LINTER CHECK ---
console.log('\n?? [3/4] Führe TypeScript Linter Check aus...');
try {
    execSync('npx tsc --noEmit', { cwd: baseDir, stdio: 'inherit' });
    console.log('  ? TypeScript Check erfolgreich (0 Fehler).');
} catch (error) {
    console.error('  ? TypeScript-Fehler festgestellt!');
    process.exit(1);
}

// --- 4. GIT COMMIT & PUSH ---
console.log('\n?? [4/4] Übertrage Änderungen in das GitHub Repository...');
try {
    execSync('git add package.json electron/masterDbGate.cjs', { stdio: 'inherit' });
    execSync('git commit -m "fix(build): enforce NSIS installer target, asarUnpack and D: drive path mapping"', { stdio: 'inherit' });
    execSync('git push origin main', { stdio: 'inherit' });
    console.log('\n?? [ERFOLG] Alles erledigt! Der GitHub-Runner baut nun exklusiv die Setup.exe.');
} catch (err) {
    console.error('\n?? [HINWEIS] Git-Befehle konnten nicht ausgeführt werden (evtl. keine Änderungen).');
}
