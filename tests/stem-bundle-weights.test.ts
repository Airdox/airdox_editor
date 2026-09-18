/**
 * Bundling der Stem-Gewichte (§19, §34) – ohne Netz, ohne 503 MiB.
 *
 * Geprüft wird genau das, was beim Offline-Build schiefgehen kann:
 *   #1 Checkpoint + Config landen in `resources/models` und sind hash-geprüft,
 *   #2 die gepackte Auflösung (`resolveStemModel` über `resourcesPath`) findet
 *      sie danach – also derselbe Pfad, den die Windows-EXE geht,
 *   #3 ein Hash-Mismatch aktiviert NICHTS und hinterlässt keine `.part`-Datei,
 *   #4 `--check-only` schreibt nichts und meldet fehlende Dateien.
 *
 * Die echten Modell-URLs kommen aus dem Katalog; der Test benutzt dafür einen
 * Mini-Katalog mit Kopien aus einem Quellordner (`--source`-Pfad).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleStemModels, verifyBundleResolution, type BundleModel } from '../scripts/bundle-stem-engine';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  STEM BUNDLE – GEWICHTE FÜR DEN OFFLINE-BUILD                   ');
console.log('═══════════════════════════════════════════════════════════════════');

const CHECKPOINT = 'model_bs_roformer_ep_17_sdr_9.6568.ckpt';
const CONFIG = 'config_bs_roformer_384_8_2_485100.yaml';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function run() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-bundle-'));
  const source = path.join(root, 'downloads');
  const target = path.join(root, 'resources', 'models');
  await mkdir(source, { recursive: true });

  const checkpointContent = 'BS-ROFORMER-CHECKPOINT-PLATZHALTER';
  const configContent = 'audio:\n  chunk_size: 485100\ntraining:\n  instruments: [drums, bass, other, vocals]\nmodel:\n  dim: 384\n';
  await writeFile(path.join(source, CHECKPOINT), checkpointContent);
  await writeFile(path.join(source, CONFIG), configContent);

  const catalog: { models: BundleModel[]; catalogVersion: string } = {
    catalogVersion: 'test-catalog',
    models: [
      {
        id: 'bsroformer-musdb18hq-4stem-zfturbo',
        checkpoint: { file: CHECKPOINT, url: 'https://invalid.example/checkpoint', sha256: sha256(checkpointContent) },
        config: { file: CONFIG, url: 'https://invalid.example/config' },
        modelHash: sha256(checkpointContent),
      },
    ],
  };

  // ---- #1: Bundle aus lokalem Quellordner ---------------------------------
  console.log('\n[ TEST ] #1 Kopieren, Hashen, Ablegen – ohne Netz');
  const result = await bundleStemModels({ catalog, target, source, log: () => {} });
  assert.equal(result.ok, true, `Bundle-Fehler: ${result.problems.join(' | ')}`);
  assert.equal(existsSync(path.join(target, CHECKPOINT)), true);
  assert.equal(existsSync(path.join(target, CONFIG)), true);
  const checkpoint = result.files.find((entry) => entry.role === 'checkpoint')!;
  assert.equal(checkpoint.action, 'copied');
  assert.equal(checkpoint.verified, true, 'Checkpoint muss gegen den Katalog-Hash geprüft sein');
  assert.equal(checkpoint.sha256, sha256(checkpointContent));
  assert.equal(readdirSync(target).some((name) => name.endsWith('.part')), false, 'keine .part-Reste');
  console.log(`  ✓ ${result.files.length} Dateien, Checkpoint sha256 geprüft`);

  // ---- #2: gepackte Auflösung findet das Bundle ---------------------------
  console.log('\n[ TEST ] #2 Genau der Pfad, den die gepackte App auflöst');
  const resolution = verifyBundleResolution(target, catalog);
  assert.equal(resolution.ok, true, `Auflösung fehlgeschlagen: ${JSON.stringify(resolution)}`);
  assert.equal(path.resolve(resolution.checkpointPath!), path.resolve(path.join(target, CHECKPOINT)));
  assert.equal(path.resolve(resolution.configPath!), path.resolve(path.join(target, CONFIG)));
  assert.ok(resolution.candidates.includes(path.join(path.dirname(target), 'models')), 'resources/models steht in den Kandidaten');
  console.log(`  ✓ resolved -> ${resolution.checkpointPath}`);

  // ---- #3: Hash-Mismatch aktiviert nichts ---------------------------------
  console.log('\n[ TEST ] #3 Falscher Hash aktiviert keine Datei');
  const brokenTarget = path.join(root, 'broken', 'resources', 'models');
  await writeFile(path.join(source, CHECKPOINT), 'MANIPULIERTER-CHECKPOINT');
  const broken = await bundleStemModels({ catalog, target: brokenTarget, source, log: () => {} });
  assert.equal(broken.ok, false, 'Hash-Mismatch muss das Bundle verhindern');
  assert.match(broken.problems.join(' '), /SHA256/);
  assert.equal(existsSync(path.join(brokenTarget, CHECKPOINT)), false, 'keine aktivierte Datei nach Hash-Fehler');
  assert.equal(existsSync(`${path.join(brokenTarget, CHECKPOINT)}.part`), false, 'keine .part-Reste');
  console.log(`  ✓ abgelehnt: ${broken.problems[0]}`);

  // ---- #4: check-only prüft, schreibt nicht -------------------------------
  console.log('\n[ TEST ] #4 --check-only schreibt nichts');
  const emptyTarget = path.join(root, 'empty', 'resources', 'models');
  const checked = await bundleStemModels({ catalog, target: emptyTarget, checkOnly: true, log: () => {} });
  assert.equal(checked.ok, false, 'leeres Ziel darf nicht als vollständig gelten');
  assert.equal(existsSync(emptyTarget), false, 'check-only legt keinen Ordner an');
  const checkedGood = await bundleStemModels({ catalog, target, checkOnly: true, log: () => {} });
  assert.equal(checkedGood.ok, true, `vorhandenes Bundle muss bestehen: ${checkedGood.problems.join(' | ')}`);
  assert.equal(checkedGood.files.every((entry) => entry.action === 'present'), true);
  console.log('  ✓ leer -> Fehler, vorhandenes Bundle -> present');

  console.log('\n✔ STEM BUNDLE: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
