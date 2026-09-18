#!/usr/bin/env tsx
/**
 * Diagnostic command: npm run stems:diagnose
 * Generates full report per §36.
 */

import { getStemRuntimeDiagnostics, formatDiagnosticsReport } from '../src/stems/runtime/diagnostics';
import { runStemPreflight, formatPreflightReport } from '../src/stems/runtime/preflight';
import { ModelRegistryV2 } from '../src/stems/runtime/modelRegistry';
import path from 'node:path';
import fs from 'node:fs';

async function main() {
  console.log('=== AIRDOX STEM DIAGNOSTICS ===\n');

  console.log('Resolving runtime and models...\n');

  const diagnostics = await getStemRuntimeDiagnostics();
  console.log(await formatDiagnosticsReport(diagnostics));

  console.log('\n');

  const preflight = await runStemPreflight();
  console.log(formatPreflightReport(preflight));

  console.log('\n=== MODEL REGISTRY ===\n');
  try {
    const registry = await ModelRegistryV2.create();
    for (const model of registry.list()) {
      console.log(`${model.modelId}:`);
      console.log(`  Architecture: ${model.architecture}`);
      console.log(`  Version: ${model.version}`);
      console.log(`  Checkpoint: ${model.checkpoint}`);
      console.log(`  Config: ${model.config}`);
      console.log(`  SHA256: ${model.checkpointSha256}`);
      console.log(`  SampleRate: ${model.sampleRate}`);
      console.log(`  SupportedStems: ${model.supportedStems.join(', ')}`);
      console.log(`  SourceUrl: ${model.sourceUrl}`);
      console.log(`  License: ${model.license}`);
      console.log(`  WeightLicense: ${model.weightLicense}`);
      console.log(`  Status: ${model.status}`);
      console.log(`  CheckpointPath: ${model.checkpointPath ?? 'missing'}`);
      console.log(`  ConfigPath: ${model.configPath ?? 'missing'}`);
      console.log(`  Verified: ${model.checkpointVerified}`);
      if (model.reason) console.log(`  Reason: ${model.reason}`);
      console.log('');
    }
  } catch (e) {
    console.error('Registry error:', e);
  }

  console.log('=== LIVE OUTPUT REQUIREMENTS (§37) ===\n');
  console.log('Engine, Model, Device, Precision, Processing time, RTF, Output files, Quality metrics');
  console.log('werden bei jeder Separation im Job-Log und in der UI angezeigt.');
  console.log('');

  console.log('=== PATH RESOLUTION (§34, §35) ===\n');
  const { resolveStemRuntime, resolveStemModel } = await import('../src/stems/runtime/pathResolver');
  const runtime = resolveStemRuntime();
  console.log('Runtime:');
  console.log(`  PythonPath: ${runtime.pythonPath ?? 'not found'}`);
  console.log(`  RuntimeDir: ${runtime.runtimeDir ?? 'not found'}`);
  console.log(`  IsProduction: ${runtime.isProduction}`);
  console.log(`  IsAsar: ${runtime.isAsar}`);
  console.log(`  Candidates: ${runtime.candidates.join(', ')}`);
  console.log('');

  const modelPaths = resolveStemModel({
    checkpointFile: 'model_bs_roformer_ep_17_sdr_9.6568.ckpt',
    configFile: 'config_bs_roformer_384_8_2_485100.yaml',
  });
  console.log('Model:');
  console.log(`  ModelStoreDir: ${modelPaths.modelStoreDir}`);
  console.log(`  CheckpointPath: ${modelPaths.checkpointPath}`);
  console.log(`  ConfigPath: ${modelPaths.configPath}`);
  console.log(`  Candidates: ${modelPaths.candidates.join(', ')}`);
  console.log('');

  console.log('=== PRODUCTION PATHS (§9, §10) ===\n');
  console.log('Production (Windows):');
  console.log('  resources/stem-runtime/python.exe');
  console.log('  resources/stem-runtime/Lib/');
  console.log('  resources/stem-runtime/Scripts/');
  console.log('  resources/models/model_bs_roformer_ep_17_sdr_9.6568.ckpt');
  console.log('  resources/models/config_bs_roformer_384_8_2_485100.yaml');
  console.log('');
  console.log('Development:');
  console.log('  project/.venv/Scripts/python.exe (win) or project/.venv/bin/python3 (posix)');
  console.log('  ~/.cache/airdox-stems/checkpoints/');
  console.log('');

  console.log('=== ENGINE STATUS ===\n');
  console.log(`Engine: ${diagnostics.engineStatus}`);
  console.log(`Model Status: ${diagnostics.modelStatus}`);
  console.log(`Checkpoint Verified: ${preflight.checkpointVerified}`);
  console.log(`Preflight Status: ${preflight.status}`);
  console.log('');

  if (preflight.status !== 'READY') {
    console.log('⚠️  Engine NOT READY – no fake stems will be produced. UI must show STEM AI UNAVAILABLE.');
  } else {
    console.log('✅ Engine READY – BS-RoFormer can perform real AI separation.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
