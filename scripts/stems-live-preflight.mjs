#!/usr/bin/env node
/**
 * Read-only preflight for the real stem quality gates.
 * It never downloads or modifies models; it proves that the selected catalog
 * entries, Python runtime and checkpoint/config files are ready before a long
 * live run is started.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const catalog = JSON.parse(readFileSync(path.join(root, 'src/stems/modelCatalog.json'), 'utf8'));
const selected = process.env.AIRODOX_STEM_LIVE_MODELS
  ? process.env.AIRODOX_STEM_LIVE_MODELS.split(',').map((id) => id.trim()).filter(Boolean)
  : catalog.models.filter((model) => model.family !== 'pipeline_double').map((model) => model.id);
const home = process.env.AIRODOX_STEM_HOME || path.join(os.homedir(), '.cache', 'airdox-stems');
const modelDirs = [
  process.env.AIRODOX_STEM_MODEL_DIR,
  process.env.AIRODOX_STEM_CHECKPOINT_DIR,
  path.join(home, 'Models'),
  path.join(home, 'checkpoints'),
  path.join(root, 'resources', 'models'),
].filter(Boolean);
const configDirs = [
  process.env.AIRODOX_STEM_CONFIG_DIR,
  path.join(home, 'configs'),
  path.join(home, 'Models'),
  path.join(root, 'resources', 'models'),
].filter(Boolean);
const sha256 = (file) => {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
};
const locate = (file, dirs) => dirs.map((dir) => path.join(dir, file)).find((candidate) => existsSync(candidate));
const pythonCandidates = [
  process.env.AIRODOX_STEM_PYTHON,
  process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python3'),
  'python3',
  'python',
].filter(Boolean);
const python = pythonCandidates.find((candidate) => {
  const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0:2])'], { encoding: 'utf8' });
  return probe.status === 0;
});
const needsTorch = selected.some((id) => catalog.models.find((model) => model.id === id)?.checkpoint.format !== 'onnx');
const torchProbe = needsTorch && python
  ? spawnSync(python, ['-c', 'import torch, torchaudio, soundfile; print(torch.__version__)'], { encoding: 'utf8' })
  : null;

let failures = 0;
const report = { generatedAt: new Date().toISOString(), selected, python: python || null, torch: !needsTorch || torchProbe?.status === 0, models: [] };
console.log('STEM LIVE PREFLIGHT');
console.log(`Modelle: ${selected.join(', ')}`);
console.log(`Python: ${needsTorch ? (python || 'FEHLT') : 'nicht erforderlich (ONNX)'}`);
console.log(`PyTorch/Torchaudio/SoundFile: ${!needsTorch ? 'nicht erforderlich' : torchProbe?.status === 0 ? 'OK' : 'FEHLT'}`);
if (needsTorch && (!python || !torchProbe || torchProbe.status !== 0)) failures++;

for (const id of selected) {
  const model = catalog.models.find((entry) => entry.id === id);
  if (!model) {
    console.log(`✗ ${id}: nicht im Katalog`);
    report.models.push({ id, ready: false, reason: 'not in catalog' });
    failures++;
    continue;
  }
  const checkpoint = locate(model.checkpoint.file, modelDirs);
  const config = model.config ? locate(model.config.file, configDirs) : null;
  const expected = model.checkpoint.sha256 || model.modelHash;
  const actual = checkpoint ? sha256(checkpoint) : null;
  const hashOk = !checkpoint || !expected || expected === 'unverified' || actual === expected.toLowerCase();
  const formatOk = Boolean(model.checkpoint.url?.startsWith('https://'));
  const ready = Boolean(checkpoint && config || checkpoint && !model.config) && hashOk && formatOk && model.family !== 'pipeline_double';
  const reason = ready ? 'ready' : [
    !checkpoint && `checkpoint fehlt (${model.checkpoint.file})`,
    model.config && !config && `config fehlt (${model.config.file})`,
    !hashOk && `SHA256 falsch (erwartet ${expected}, gefunden ${actual})`,
    !formatOk && 'keine HTTPS-Quelle im Katalog',
  ].filter(Boolean).join('; ');
  console.log(`${ready ? '✓' : '✗'} ${id}: ${ready ? 'bereit' : reason}`);
  if (checkpoint) console.log(`  checkpoint: ${checkpoint} (${(statSync(checkpoint).size / 1048576).toFixed(1)} MiB${expected === 'unverified' ? ', Hash unverified' : ', Hash geprüft'})`);
  report.models.push({ id, family: model.family, format: model.checkpoint.format, ready, checkpoint, config, actualHash: actual, expectedHash: expected || null, reason });
  if (!ready) failures++;
}

const out = process.env.AIRODOX_STEM_PREFLIGHT_OUT || path.join(root, 'stem-gate-run', 'preflight.json');
if (!process.env.AIRODOX_STEM_PREFLIGHT_NO_WRITE) {
  const fs = await import('node:fs/promises');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${out}`);
}
if (failures) {
  console.error(`\nNICHT BEREIT: ${failures} Prüfung(en) fehlgeschlagen.`);
  process.exitCode = 1;
} else {
  console.log('\nBEREIT: Live-Gates können gestartet werden.');
}
