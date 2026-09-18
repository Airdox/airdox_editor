#!/usr/bin/env node
/**
 * Bundelt die Stem-Gewichte in den Build (§19, §34).
 *
 * Warum es dieses Skript gibt:
 *   `resources/models/` enthält im Repo nur einen Platzhalter. Die gepackte App
 *   findet ihre Gewichte aber genau dort (bzw. in `%APPDATA%/airdox_SMART_Editor/
 *   stems/Models`) – `resolveStemModel()` prüft beide Orte. Wer offline
 *   ausliefern will, kopiert Checkpoint + Config vor dem Build hier hinein.
 *
 * Garantien:
 *   - Downloads landen als `.part` und werden erst nach passendem SHA256
 *     aktiviert (kein halber Checkpoint im Build),
 *   - ein vorhandener, korrekter Checkpoint wird nie erneut geladen,
 *   - Dateien außerhalb `resources/models` werden nicht angefasst,
 *   - `--check-only` schreibt nichts und ist damit CI-/Freigabe-tauglich.
 *
 * Aufruf:
 *   npm run stems:bundle                        # Standard-Set (669 MiB):
 *                                               #   BS-RoFormer (503 MiB) + ONNX-Fast-Path (166 MiB)
 *   npm run stems:bundle -- --models id1,id2
 *   npm run stems:bundle -- --all              # alle installierbaren Katalogmodelle
 *   npm run stems:bundle -- --source D:\\downloads   # lokale Kopien statt Netz
 *   npm run stems:bundle -- --check-only
 *   npm run stems:bundle -- --dry-run
 *   npm run stems:bundle -- --target /tmp/test-models --source /tmp/fixtures
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveStemModel } from '../src/stems/runtime/pathResolver';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'src', 'stems', 'modelCatalog.json');
const DEFAULT_TARGET = path.join(ROOT, 'resources', 'models');
const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * Was `npm run stems:bundle` ohne `--models` in den Build legt:
 * der Studio-Pfad (BS-RoFormer) und der DJ-Fast-Path (ONNX, in-process).
 * Modelle, die der Katalog nicht kennt (Mini-Kataloge in Tests), werden dabei
 * still übersprungen – explizit per `--models` angeforderte aber nie.
 */
const DEFAULT_MODEL_IDS = ['bsroformer-musdb18hq-4stem-zfturbo', 'htdemucs-onnx-4stem-fp16'];

export interface BundleFileRef {
  file: string;
  format?: string;
  url?: string;
  sha256?: string;
}

export interface BundleModel {
  id: string;
  family?: string;
  checkpoint?: BundleFileRef;
  config?: BundleFileRef;
  modelHash?: string;
}

export interface BundleFileResult {
  modelId: string;
  role: 'checkpoint' | 'config';
  file: string;
  path: string;
  bytes: number;
  sha256?: string;
  verified: boolean;
  action: 'present' | 'copied' | 'downloaded' | 'skipped' | 'missing';
}

export interface BundleResult {
  ok: boolean;
  target: string;
  files: BundleFileResult[];
  problems: string[];
}

export interface BundleOptions {
  /** Default: gebündelter Katalog. Tests reichen einen Mini-Katalog herein. */
  catalog?: { models?: BundleModel[]; catalogVersion?: string };
  target?: string;
  /** Modell-IDs; Default ist das primäre Modell des Katalogs. */
  models?: string[];
  /** Verzeichnis mit bereits geladenen Dateien – hat Vorrang vor dem Netz. */
  source?: string;
  force?: boolean;
  checkOnly?: boolean;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

function hashOf(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function readCatalog(): { models: BundleModel[]; catalogVersion?: string } {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as { models: BundleModel[]; catalogVersion?: string };
}

/**
 * Fallback für Netze mit TLS-Inspektion: Node `fetch` scheitert dort an der
 * Zertifikatskette („unable to verify the first certificate"), `curl` kommt mit
 * dem Firmen-Proxy zurecht. Läuft nur, wenn kein eigenes `fetch` injiziert wurde
 * – Tests sprechen also nie versehentlich das echte Netz an.
 */
function downloadWithCurl(url: string, partial: string, log: (message: string) => void): void {
  log('      fetch nicht möglich – Fallback auf curl');
  const result = spawnSync('curl', ['-fL', '--retry', '3', '--connect-timeout', '30', '--speed-time', '60', '-o', partial, url], {
    stdio: 'ignore',
  });
  if (result.error || result.status !== 0) {
    if (existsSync(partial)) rmSync(partial, { force: true });
    throw new Error(`Download fehlgeschlagen (curl, Status ${result.status ?? 'n/a'}): ${url}`);
  }
}

async function download(
  ref: BundleFileRef,
  targetFile: string,
  fetchImpl: typeof fetch,
  log: (message: string) => void,
  allowCurlFallback = true
): Promise<void> {
  if (!ref.url) throw new Error(`kein Download-URL für ${ref.file} im Katalog`);
  const partial = `${targetFile}.part`;
  mkdirSync(path.dirname(targetFile), { recursive: true });
  const viaFetch = async (): Promise<void> => {
    const response = await fetchImpl(ref.url!, { headers: { 'User-Agent': 'airdox-stem-bundle' } });
    if (!response.ok || !response.body) throw new Error(`Download fehlgeschlagen (HTTP ${response.status}): ${ref.url}`);
    let received = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(partial);
      const reader = response.body!.getReader();
      const pump = (): void => {
        reader.read().then(({ done, value }) => {
          if (done) {
            stream.end(() => resolve());
            return;
          }
          const chunk = Buffer.from(value);
          received += chunk.byteLength;
          if (received % (32 * 1024 * 1024) < chunk.byteLength) log(`      … ${(received / (1024 * 1024)).toFixed(0)} MiB`);
          stream.write(chunk, () => pump());
        }).catch(reject);
      };
      pump();
    });
  };
  try {
    await viaFetch();
  } catch (error) {
    if (!allowCurlFallback) throw error;
    log(`      ${error instanceof Error ? error.message : String(error)}`);
    downloadWithCurl(ref.url, partial, log);
  }
  try {
    if (ref.sha256 && SHA256_RE.test(ref.sha256) && hashOf(partial) !== ref.sha256.toLowerCase()) {
      throw new Error(`SHA256 stimmt nicht: ${ref.file}`);
    }
    renameSync(partial, targetFile);
  } finally {
    if (existsSync(partial)) rmSync(partial, { force: true });
  }
}

/**
 * Legt Checkpoint und Config eines Modells in den Zielordner. Prüft Hashes und
 * beschreibt jede Datei im Ergebnis – die CLI (und der Test) entscheidet, was
 * ein Problem ist.
 */
export async function bundleStemModels(options: BundleOptions = {}): Promise<BundleResult> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const catalog = options.catalog ?? readCatalog();
  const target = path.resolve(options.target ?? DEFAULT_TARGET);
  const fetchImpl = options.fetchImpl ?? fetch;
  const files: BundleFileResult[] = [];
  const problems: string[] = [];

  if (/app\.asar/.test(target)) {
    return { ok: false, target, files, problems: ['Ziel darf nicht in einem ASAR-Archiv liegen.'] };
  }

  const wanted = options.models?.length
    ? options.models
    : DEFAULT_MODEL_IDS.filter((id) => catalog.models?.some((model) => model.id === id));

  for (const modelId of wanted) {
    const model = catalog.models?.find((entry) => entry.id === modelId);
    if (!model) {
      problems.push(`Modell ${modelId} ist nicht im Katalog.`);
      continue;
    }
    const refs: { ref?: BundleFileRef; role: 'checkpoint' | 'config' }[] = [
      { ref: model.checkpoint, role: 'checkpoint' },
      { ref: model.config, role: 'config' },
    ];
    for (const { ref, role } of refs) {
      if (!ref) continue;
      const targetFile = path.join(target, ref.file);
      const verifiable = Boolean(ref.sha256 && SHA256_RE.test(ref.sha256));
      const present = existsSync(targetFile);
      const presentHash = present ? hashOf(targetFile) : undefined;
      const presentOk = present && (!verifiable || presentHash === ref.sha256!.toLowerCase());

      if (present && presentOk && !options.force) {
        log(`    vorhanden: ${ref.file} (${(statSync(targetFile).size / (1024 * 1024)).toFixed(1)} MiB${verifiable ? ', sha256 geprüft' : ''})`);
        files.push({ modelId, role, file: ref.file, path: targetFile, bytes: statSync(targetFile).size, sha256: presentHash, verified: verifiable, action: 'present' });
        continue;
      }
      if (present && !presentOk) {
        problems.push(`${ref.file} liegt bereits im Ziel, passt aber nicht zum Katalog-Hash – bitte manuell entfernen.`);
        if (!options.force) {
          files.push({ modelId, role, file: ref.file, path: targetFile, bytes: statSync(targetFile).size, sha256: presentHash, verified: false, action: 'skipped' });
          continue;
        }
      }
      if (options.checkOnly) {
        problems.push(`${ref.file} fehlt in ${target}.`);
        files.push({ modelId, role, file: ref.file, path: targetFile, bytes: 0, verified: false, action: 'missing' });
        continue;
      }
      if (options.dryRun) {
        log(`    würde laden: ${ref.file}${options.source ? ` (Quelle: ${options.source})` : ` von ${ref.url ?? '—'}`}`);
        files.push({ modelId, role, file: ref.file, path: targetFile, bytes: 0, verified: false, action: 'skipped' });
        continue;
      }

      const localSource = options.source ? path.join(options.source, ref.file) : undefined;
      try {
        if (localSource && existsSync(localSource)) {
          log(`    kopiere ${ref.file} aus ${options.source} …`);
          mkdirSync(path.dirname(targetFile), { recursive: true });
          await copyFile(localSource, forceSuffix(targetFile));
          const staged = forceSuffix(targetFile);
          if (verifiable && hashOf(staged) !== ref.sha256!.toLowerCase()) throw new Error(`SHA256 stimmt nicht: ${ref.file}`);
          renameSync(staged, targetFile);
          files.push({ modelId, role, file: ref.file, path: targetFile, bytes: statSync(targetFile).size, sha256: hashOf(targetFile), verified: verifiable, action: 'copied' });
        } else {
          log(`    lade ${ref.file} …`);
          await download(ref, targetFile, fetchImpl, log, !options.fetchImpl);
          files.push({ modelId, role, file: ref.file, path: targetFile, bytes: statSync(targetFile).size, sha256: hashOf(targetFile), verified: verifiable, action: 'downloaded' });
        }
        log(`    ✓ ${ref.file} (${(statSync(targetFile).size / (1024 * 1024)).toFixed(1)} MiB${verifiable ? ', sha256 geprüft' : ''})`);
      } catch (error) {
        rmSync(`${targetFile}.part`, { force: true });
        problems.push(`${ref.file}: ${error instanceof Error ? error.message : String(error)}`);
        files.push({ modelId, role, file: ref.file, path: targetFile, bytes: 0, verified: false, action: 'missing' });
      }
    }
  }

  return { ok: problems.length === 0, target, files, problems };
}

/** `.part`-Zwischendatei beim Kopieren – gleiche Semantik wie beim Download. */
function forceSuffix(file: string): string {
  return `${file}.part`;
}

/**
 * Prüft, ob die *gepackte* Auflösung die Dateien wirklich findet. Genau der
 * Pfad, den `resolveStemModel()` im Build geht: `resources/models`.
 */
export function verifyBundleResolution(
  target: string,
  catalog?: { models?: BundleModel[] },
  modelId?: string
): { ok: boolean; checkpointPath: string | null; configPath: string | null; candidates: string[]; modelId: string | null; layoutHint: string | null } {
  const source = catalog ?? readCatalog();
  const primary =
    (modelId ? source.models?.find((model) => model.id === modelId) : undefined) ??
    source.models?.find((model) => model.id === 'bsroformer-musdb18hq-4stem-zfturbo') ??
    source.models?.[0];
  const checkpointFile = primary?.checkpoint?.file;
  const configFile = primary?.config?.file;
  const resolved = resolveStemModel({
    env: {},
    repoRoot: ROOT,
    resourcesPath: path.dirname(target),
    modelId: primary?.id,
    checkpointFile,
    configFile,
  });
  const found = resolved.checkpointPath && path.resolve(resolved.checkpointPath) === path.resolve(path.join(target, checkpointFile ?? ''));
  // Die gepackte App sucht unter `<resources>/models`. Zeigt --target woanders
  // hin, ist die Auflösung oben bewusst der Gegenbeweis („so würde die App
  // suchen") – der Hinweis erklärt, warum sie dann nicht trifft.
  const layoutHint =
    path.basename(target) === 'models'
      ? null
      : `Ziel ist kein "resources/models"-Layout – die gepackte App sucht unter ${path.join(path.dirname(target), 'models')}. Für ein echtes Bundle --target auf "<projekt>/resources/models" setzen.`;
  return {
    ok: Boolean(found && (!configFile || existsSync(path.join(target, configFile)))),
    checkpointPath: resolved.checkpointPath,
    configPath: resolved.configPath,
    candidates: resolved.candidates,
    modelId: primary?.id ?? null,
    layoutHint,
  };
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

async function main(): Promise<void> {
  const target = path.resolve(String(arg('target', DEFAULT_TARGET)));
  const models = arg('models')?.split(',').map((entry) => entry.trim()).filter(Boolean);
  const allModels = Boolean(arg('all', undefined));
  const source = arg('source');
  const checkOnly = Boolean(arg('check-only', undefined));
  const dryRun = Boolean(arg('dry-run', undefined));
  const force = Boolean(arg('force', undefined));
  const catalog = readCatalog();

  process.stdout.write('═══════════════════════════════════════════════════════════════════\n');
  process.stdout.write('  airdox – Stem-Gewichte in den Build legen\n');
  process.stdout.write('═══════════════════════════════════════════════════════════════════\n');
  process.stdout.write(`  Katalog: ${catalog.catalogVersion ?? '—'}\n`);
  process.stdout.write(`  Ziel:    ${target}\n`);
  process.stdout.write(`  Modus:   ${checkOnly ? 'check-only' : dryRun ? 'dry-run' : 'bundle'}\n`);

  const requestedModels = allModels
    ? catalog.models.filter((model) => model.checkpoint?.format !== 'synthetic').map((model) => model.id)
    : models;
  if (allModels) process.stdout.write(`  Auswahl:  alle installierbaren Modelle (${requestedModels.length})\n`);
  const result = await bundleStemModels({ catalog, target, models: requestedModels, source: source && source !== 'true' ? source : undefined, checkOnly, dryRun, force });

  process.stdout.write('\n  Auflösung wie in der gepackten App:\n');
  const resolution = verifyBundleResolution(target, catalog, models?.[0]);
  process.stdout.write(`    Modell:     ${resolution.modelId ?? '—'}\n`);
  process.stdout.write(`    Checkpoint: ${resolution.checkpointPath ?? '—'}\n`);
  process.stdout.write(`    Config:     ${resolution.configPath ?? '—'}\n`);
  process.stdout.write(`    Ordner geprüft: ${resolution.candidates.slice(0, 3).join(', ')}\n`);
  if (resolution.layoutHint) process.stdout.write(`    Hinweis:    ${resolution.layoutHint}\n`);

  if (!result.ok || (!resolution.ok && !dryRun)) {
    process.stdout.write('\n✘ Bundle unvollständig:\n');
    for (const problem of result.problems) process.stdout.write(`    - ${problem}\n`);
    if (!resolution.ok && !dryRun) process.stdout.write(`    - Checkpoint/Config werden unter ${target} nicht gefunden.\n`);
    process.exit(1);
  }

  const verified = result.files.filter((entry) => entry.action !== 'skipped' && entry.action !== 'missing');
  const totalMiB = verified.reduce((sum, entry) => sum + entry.bytes, 0) / (1024 * 1024);
  const manifest = {
    generatedAt: new Date().toISOString(),
    catalogVersion: catalog.catalogVersion ?? null,
    target,
    files: result.files,
  };
  if (!checkOnly && !dryRun) {
    mkdirSync(target, { recursive: true });
    await (await import('node:fs/promises')).writeFile(path.join(target, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`\n✔ ${verified.length} Datei(en), ${totalMiB.toFixed(1)} MiB – ${checkOnly ? 'Bestand geprüft' : 'Bundle bereit'}.\n`);
  process.stdout.write('  Nächster Schritt: npm run package:win:portable  (bzw. package:win)\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).replace(/\.(ts|mjs|js)$/, '') === fileURLToPath(import.meta.url).replace(/\.(ts|mjs|js)$/, '');
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`\n✘ FEHLER: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
