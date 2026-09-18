#!/usr/bin/env node
/**
 * Baut die mitgelieferte Python-Runtime für die Stem-Engine (§19, §34).
 *
 * Ziel ist eine Runtime, die in `resources/stem-runtime` liegt und von
 * `resolveStemRuntime()` gefunden wird – also ohne System-Python und ohne
 * Internet auf dem Zielrechner arbeitet.
 *
 * Zwei Modi:
 *
 *   standalone (Standard)
 *     python-build-standalone (astral-sh), Architektur `install_only`.
 *     Diese Distribution ist relokatierbar: sie funktioniert auch, wenn die
 *     portable EXE sich bei jedem Start in einen anderen Temp-Ordner entpackt.
 *     Deshalb ist sie der Standard für `npm run package:win:portable`.
 *     Download-Quelle: GitHub-Release-Assets des Projekts.
 *
 *   venv
 *     `python -m venv` aus einem lokalen Python 3.10–3.12 + PyPI-Wheels.
 *     Dasselbe, was der In-App-Installer in %APPDATA% tut – hier aber fest in
 *     `resources/stem-runtime`. ACHTUNG: ein venv ist NICHT relokatierbar, der
 *     Pfad steckt in `pyvenv.cfg`/`Scripts`. Für NSIS-Installationen (stabiler
 *     Installationsordner) brauchbar, für die portable EXE nicht.
 *
 * Aufruf:
 *   node scripts/setup-stem-runtime.mjs
 *   node scripts/setup-stem-runtime.mjs --mode venv
 *   node scripts/setup-stem-runtime.mjs --target /tmp/stem-runtime-test --mode venv
 *   node scripts/setup-stem-runtime.mjs --dry-run
 *   node scripts/setup-stem-runtime.mjs --skip-packages
 *
 * Danach die Gewichte holen: `npm run stems:bundle`.
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Dieselben Pins wie `python/install_bsroformer.py` (Schritte 3 und 4). */
const TORCH_PINS = ['torch==2.5.1', 'torchaudio==2.5.1'];
const SUPPORT_PINS = [
  'msst==0.1.0',
  'beartype==0.18.5',
  'einops==0.8.1',
  'rotary-embedding-torch==0.8.6',
  'numpy==1.26.4',
  'soundfile==0.13.1',
  'PyYAML==6.0.2',
  'ml-collections==1.1.0',
  // Included for the offline HT-Demucs model bundle as well as BS-RoFormer.
  'demucs==4.0.1',
];
const TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu';
/** Überschreibbar für Spiegel/Proxies (`--torch-index <url>` oder `pypi`). */
const SUPPORTED_MINORS = [10, 11, 12];
const STANDALONE_RELEASES = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function pythonBinary(target) {
  return path.join(target, ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    // Die Release-Metadaten von python-build-standalone sind >1 MiB; das
    // Node-Default-Limit würde den Prozess still abschneiden.
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: result.status === 0, code: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

/** Python 3.10–3.12 auf dem Build-Rechner finden (nicht 3.13/3.14). */
function locateBasePython() {
  const candidates = process.platform === 'win32'
    ? [['py', '-3.12'], ['py', '-3.11'], ['py', '-3.10'], ['python3.12', []], ['python3.11', []], ['python3.10', []], ['python3', []], ['python', []]]
    : [['python3.12', []], ['python3.11', []], ['python3.10', []], ['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const args = [...(Array.isArray(prefix) ? prefix : [prefix]), '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'];
    const probe = run(command, args, { quiet: true });
    if (!probe.ok) continue;
    const [major, minor] = probe.stdout.split(/[\s.]+/).map(Number);
    if (major === 3 && SUPPORTED_MINORS.includes(minor)) return { command, prefix: Array.isArray(prefix) ? prefix : [prefix], version: `${major}.${minor}` };
  }
  return null;
}

function standaloneTriple() {
  const { platform, arch } = process;
  if (platform === 'win32') return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
}

/**
 * `fetch` mit curl-Rückfall.
 *
 * Node bringt eigene CA-Zertifikate mit; in Firmennetzen mit TLS-Inspektion
 * scheitert `fetch` deshalb, während `curl` (ab Windows 10 fester Bestandteil)
 * problemlos lädt. Der Rückfall hält den Bundling-Schritt dort benutzbar.
 */
async function httpJson(url) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'airdox-stem-runtime' } });
    if (response.ok) return await response.json();
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    const fallback = run('curl', ['-fsSL', '--retry', '2', '-H', 'User-Agent: airdox-stem-runtime', url], { quiet: true });
    if (!fallback.ok) throw new Error(`${url}: ${error?.message ?? error}${fallback.stderr ? ` (curl: ${fallback.stderr})` : ''}`);
    return JSON.parse(fallback.stdout);
  }
}

async function resolveStandaloneAsset(minor) {
  const release = await httpJson(STANDALONE_RELEASES);
  const triple = standaloneTriple();
  const pattern = new RegExp(`^cpython-3\\.${minor}\\.\\d+\\+.*-${triple}-install_only\\.tar\\.gz$`);
  const asset = (release.assets ?? []).find((entry) => pattern.test(entry.name));
  if (!asset) {
    throw new Error(
      `Kein passendes Asset für Python 3.${minor} (${triple}) im Release ${release.tag_name}. ` +
        'Verfügbar: ' + (release.assets ?? []).map((entry) => entry.name).filter((name) => name.includes('-install_only.tar.gz')).slice(0, 5).join(', ')
    );
  }
  return { url: asset.browser_download_url, name: asset.name, size: asset.size, tag: release.tag_name };
}

async function download(url, targetFile) {
  mkdirSync(path.dirname(targetFile), { recursive: true });
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'airdox-stem-runtime' } });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await new Promise((resolve, reject) => {
      const stream = createWriteStream(targetFile);
      const reader = response.body.getReader();
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) {
          stream.end(resolve);
          return;
        }
        const chunk = Buffer.from(value);
        stream.write(chunk, () => pump());
      }).catch(reject);
      pump();
    });
  } catch (error) {
    rmSync(targetFile, { force: true });
    const fallback = run('curl', ['-fL', '--retry', '3', '--output', targetFile, url]);
    if (!fallback.ok) throw new Error(`Download fehlgeschlagen: ${url} (${error?.message ?? error})`);
  }
  return statSync(targetFile).size;
}

/** Entpackt `<tarball>/python/**` nach `target` (flach, wie der Resolver erwartet). */
async function extractStandalone(tarball, target) {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'airdox-runtime-'));
  try {
    const untar = run('tar', ['-xzf', tarball, '-C', staging]);
    if (!untar.ok) throw new Error(`tar konnte ${path.basename(tarball)} nicht entpacken (Exit ${untar.code})`);
    const inner = path.join(staging, 'python');
    const source = existsSync(inner) ? inner : staging;
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) {
      await cp(path.join(source, entry), path.join(target, entry), { recursive: true });
    }
    // install_only bringt pip mit; die Lizenz des Interpreters nicht in den Baum schmuggeln.
    const version = `${process.platform === 'win32' ? 'python' : 'python'}`;
    rmSync(path.join(target, `${version}-install-manifest.json`), { force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function installPackages(pythonPath, torchIndex) {
  const pip = (args) => {
    const result = run(pythonPath, ['-m', 'pip', 'install', '--disable-pip-version-check', ...args]);
    if (!result.ok) throw new Error(`pip-Installation fehlgeschlagen: ${args.join(' ')}`);
  };
  pip(['--upgrade', 'pip']);
  const torchArgs = torchIndex === 'pypi' ? [...TORCH_PINS] : ['--index-url', torchIndex, ...TORCH_PINS];
  pip(torchArgs);
  // Zweiter Lauf pinnt torch erneut, damit die Abhängigkeiten es nicht hochziehen.
  pip([...TORCH_PINS, ...SUPPORT_PINS]);
}

function verifyRuntime(pythonPath, strict = true) {
  const code = strict
    ? 'import sys, torch, torchaudio, soundfile, msst, yaml; print("RUNTIME_OK", sys.version.split()[0], torch.__version__)'
    : 'import sys; print("RUNTIME_OK", sys.version.split()[0], "ohne-torch")';
  return run(pythonPath, ['-c', code], { quiet: true });
}

async function main() {
  const mode = String(arg('mode', 'standalone'));
  const minor = String(Number(arg('python', 11)));
  const target = path.resolve(ROOT, String(arg('target', path.join('resources', 'stem-runtime'))));
  const force = Boolean(arg('force', false));
  const dryRun = Boolean(arg('dry-run', false));
  const skipPackages = Boolean(arg('skip-packages', false));
  const torchIndex = String(arg('torch-index', TORCH_CPU_INDEX));

  if (/app\.asar/.test(target)) {
    console.error('✘ Ziel darf nicht in einem ASAR-Archiv liegen.');
    process.exit(2);
  }
  if (!SUPPORTED_MINORS.includes(Number(minor))) {
    console.error(`✘ Python 3.${minor} wird nicht unterstützt (3.10–3.12; die torch-Pins 2.5.1 setzen das voraus).`);
    process.exit(2);
  }

  log('═══════════════════════════════════════════════════════════════════');
  log('  airdox – Python-Runtime für die Stem-Engine bündeln');
  log('═══════════════════════════════════════════════════════════════════');
  log(`  Modus:   ${mode}`);
  log(`  Python:  3.${minor}`);
  log(`  Ziel:    ${target}`);

  if (mode === 'standalone') {
    const asset = await resolveStandaloneAsset(Number(minor));
    log(`  Quelle:  ${asset.name} (${(asset.size / (1024 * 1024)).toFixed(1)} MiB, ${asset.tag})`);
    log(`  Pakete:  ${skipPackages ? '(übersprungen)' : [...TORCH_PINS, ...SUPPORT_PINS].join(' ')}`);
    log(`  Index:   ${torchIndex}`);
    if (dryRun) {
      log('\n  --dry-run: nichts heruntergeladen, nichts geschrieben.');
      return;
    }
    if (existsSync(pythonBinary(target)) && !force) {
      log(`\n  ✓ Runtime vorhanden (${pythonBinary(target)}) – mit --force neu aufbauen.`);
    } else {
      const tarball = path.join(os.tmpdir(), asset.name);
      log(`\n  lade ${asset.name} …`);
      const bytes = await download(asset.url, tarball);
      log(`  ✓ ${(bytes / (1024 * 1024)).toFixed(1)} MiB geladen, entpacke …`);
      if (force) rmSync(target, { recursive: true, force: true });
      await extractStandalone(tarball, target);
      rmSync(tarball, { force: true });
      log(`  ✓ entpackt nach ${target}`);
    }
  } else if (mode === 'venv') {
    const base = locateBasePython();
    if (!base) {
      console.error('\n✘ Kein Python 3.10–3.12 gefunden. Bitte Python 3.11 (64-Bit) installieren oder --mode standalone verwenden.');
      process.exit(2);
    }
    log(`  Basis:   ${base.command} ${base.prefix.join(' ')} (${base.version})`);
    log(`  Pakete:  ${skipPackages ? '(übersprungen)' : [...TORCH_PINS, ...SUPPORT_PINS].join(' ')}`);
    log(`  Index:   ${torchIndex}`);
    if (dryRun) {
      log('\n  --dry-run: nichts installiert, nichts geschrieben.');
      return;
    }
    if (existsSync(pythonBinary(target)) && !force) {
      log(`\n  ✓ Runtime vorhanden (${pythonBinary(target)}) – mit --force neu aufbauen.`);
    } else {
      if (force) rmSync(target, { recursive: true, force: true });
      mkdirSync(path.dirname(target), { recursive: true });
      log(`\n  erstelle venv in ${target} …`);
      const created = run(base.command, [...base.prefix, '-m', 'venv', target]);
      if (!created.ok) {
        console.error('✘ venv-Erstellung fehlgeschlagen.');
        process.exit(1);
      }
    }
  } else {
    console.error(`✘ Unbekannter Modus "${mode}" (erlaubt: standalone, venv).`);
    process.exit(2);
  }

  const pythonPath = pythonBinary(target);
  if (!existsSync(pythonPath)) {
    console.error(`✘ Im Ziel liegt kein Python: ${pythonPath}`);
    process.exit(1);
  }

  if (!skipPackages) {
    log('\n  installiere PyTorch (CPU-Wheels) und die Audio-Pakete …');
    installPackages(pythonPath, torchIndex);
  }

  const probe = verifyRuntime(pythonPath, !skipPackages);
  if (!probe.ok || !probe.stdout.includes('RUNTIME_OK')) {
    console.error(`\n✘ Runtime-Prüfung fehlgeschlagen:\n${probe.stderr || probe.stdout || '(keine Ausgabe)'}`);
    process.exit(1);
  }
  if (skipPackages) {
    log('\n  ! --skip-packages: Interpreter liegt bereit, torch/msst fehlen noch.');
  }

  log(`\n  ✓ ${probe.stdout}`);
  log('\n  Nächster Schritt – Gewichte in den Build legen:');
  log('    npm run stems:bundle          # Checkpoint + Config nach resources/models');
  log('    npm run package:win:portable  # danach neu bauen');
}

main().catch((error) => {
  console.error(`\n✘ FEHLER: ${error?.message ?? error}`);
  process.exit(1);
});
