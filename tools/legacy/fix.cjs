const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('?? [AIRDOX SYSTEM] Starte autonome Repository-Analyse & Bugfixing...\n');

const baseDir = 'C:\\Users\\p_kro\\airdox_editor';

const paths = {
    masterDbGate: path.join(baseDir, 'electron', 'masterDbGate.cjs'),
    packageJson: path.join(baseDir, 'package.json'),
};

console.log('?? [1/3] Analysiere package.json (asarUnpack für C++ Bindings & ONNX)...');
if (fs.existsSync(paths.packageJson)) {
    let pkgRaw = fs.readFileSync(paths.packageJson, 'utf8');
    let pkg = JSON.parse(pkgRaw);
    let modifiedPkg = false;

    if (!pkg.build) pkg.build = {};
    if (!pkg.build.asarUnpack) pkg.build.asarUnpack = [];

    const requiredUnpacks = [
        "**/*.node",
        "**/better-sqlite3-multiple-ciphers/**",
        "**/onnxruntime-node/**"
    ];

    let currentUnpack = pkg.build.asarUnpack;
    if (typeof currentUnpack === 'string') currentUnpack = [currentUnpack];

    requiredUnpacks.forEach(rule => {
        if (!currentUnpack.includes(rule)) {
            currentUnpack.push(rule);
            modifiedPkg = true;
            console.log(`  ?? Fix: '${rule}' zu asarUnpack hinzugefügt.`);
        }
    });

    if (modifiedPkg) {
        pkg.build.asarUnpack = currentUnpack;
        fs.writeFileSync(paths.packageJson, JSON.stringify(pkg, null, 2));
        console.log('  ? package.json erfolgreich gepatched.');
    } else {
        console.log('  ? asarUnpack Regeln sind bereits optimal konfiguriert.');
    }
} else {
    console.error(`  ? package.json nicht gefunden unter: ${paths.packageJson}`);
}

console.log('\n?? [2/3] Analysiere electron/masterDbGate.cjs (Datenbank-Mapping)...');
if (fs.existsSync(paths.masterDbGate)) {
    let code = fs.readFileSync(paths.masterDbGate, 'utf8');
    let modifiedDb = false;

    fs.writeFileSync(paths.masterDbGate + '.bak', code);

    if (code.includes('SELECT') && !code.includes('*') && !code.includes('FolderPath')) {
        console.log('  ?? Fix: Erweitere SQL Queries um FolderPath und FileName...');
        code = code.replace(/SELECT\s+(id,.*?title.*?)FROM/gi, 'SELECT $1, FolderPath, FileName, location FROM');
        modifiedDb = true;
    }

    const mappingRegex = /({[\s\S]*?id:\s*[^,\n]+,[\s\S]*?title:\s*[^,\n]+[\s\S]*?})/;
    const match = code.match(mappingRegex);

    if (match) {
        let block = match[0];
        if (!block.includes('path:') && !block.includes('location:')) {
            let varName = 'row'; 
            if (block.includes('track.')) varName = 'track';
            else if (block.includes('item.')) varName = 'item';
            else if (block.includes('trackData.')) varName = 'trackData';

            console.log(`  ?? Fix: Injiziere fehlendes 'path' Mapping. Erkannte Variable: ${varName}`);
            
            const pathInject = `\n      path: ${varName}.path || ${varName}.location || (${varName}.FolderPath ? ${varName}.FolderPath + ${varName}.FileName : null),`;
            const patchedBlock = block.replace(/(title:\s*[^,\n]+,)/, `$1${pathInject}`);
            
            code = code.replace(block, patchedBlock);
            modifiedDb = true;
        } else {
            console.log('  ? Track-Objekt enthält bereits ein Path-Mapping.');
        }
    } else {
         console.log('  ?? Konnte Track-Mapping-Objekt nicht automatisch per Regex isolieren.');
    }

    if (modifiedDb) {
        fs.writeFileSync(paths.masterDbGate, code);
        console.log('  ? masterDbGate.cjs erfolgreich gepatched.');
    } else {
        console.log('  ? Keine Änderungen an masterDbGate.cjs nötig.');
    }
} else {
    console.error(`  ? electron/masterDbGate.cjs nicht gefunden unter: ${paths.masterDbGate}`);
}

console.log('\n?? [3/3] Führe strikten TypeScript Compiler Check durch...');
try {
    const tscOutput = execSync('npx tsc --noEmit', { cwd: baseDir, encoding: 'utf8', stdio: 'pipe' });
    console.log('  ? TypeScript Check fehlerfrei durchgelaufen (0 Errors).');
} catch (error) {
    console.error('  ? TypeScript Fehler gefunden:\n');
    console.error(error.stdout || error.message);
}

console.log('\n?? [AIRDOX SYSTEM] Analyse & Patch-Vorgang beendet.');
