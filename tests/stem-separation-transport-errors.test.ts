/**
 * Transport-Diagnose: Backend-Fehler müssen sprechen.
 *
 * Reproduziert den Produktivfall „STEM_CONFIG_INVALID: Backend beendete sich
 * mit Code 2 ([object Object])“: ein Python-Backend, das sklearn-argparse-mäßig
 * an den Argumenten scheitert (Exit 2, Usage auf stderr), zeigte in der UI
 * weder den Grund noch verwertbaren Text – der Details-Block wurde per
 * `String(objekt)` zu „[object Object]“. Außerdem: Geräte-Mapping für den
 * Python-Adapter (directml ist ein ONNX-Begriff, argparse kannte ihn nicht →
 * genau jener Exit 2) und die OOM-Neuklassifizierung über den stderr-Schwanz.
 *
 * Die „Backends“ hier sind `node -e`-Oneliner: kein Python, kein Modell nötig.
 */
import assert from 'node:assert/strict';
import { runBackendProcess } from '../src/stems/backends/processTransport';
import { pythonDeviceFor } from '../src/stems/backends/roformerSeparator';
import { classifyFailure, isStemError } from '../src/stems/errors';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  TRANSPORT-FEHLERDIAGNOSE + GERÄTE-MAPPING (ohne Python)         ');
console.log('═══════════════════════════════════════════════════════════════════');

const ARGPARSE_FAIL =
  "process.stderr.write(\"usage: bsroformer_inference.py [-h]\\n" +
  "bsroformer_inference.py: error: argument --device: invalid choice: 'directml' " +
  "(choose from 'auto', 'cpu', 'cuda', 'cuda:0', 'mps')\\n\"); process.exitCode = 2;";

const OOM_FAIL =
  "process.stderr.write('Traceback (most recent call last):\\n" +
  "RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB\\n'); process.exitCode = 1;";

async function run() {
  // ---- #1: Geräte-Mapping für den Python-Adapter ---------------------------
  console.log('\n[ TEST ] #1 pythonDeviceFor bildet Engine-Geräte auf argparse-Choices ab');
  assert.equal(pythonDeviceFor('cpu'), 'cpu');
  assert.equal(pythonDeviceFor('cuda'), 'cuda');
  assert.equal(pythonDeviceFor('auto'), 'auto');
  assert.equal(pythonDeviceFor('coreml'), 'mps', 'CoreML-Anfrage landet auf Apple-silicon mps');
  assert.equal(pythonDeviceFor('metal'), 'mps');
  assert.equal(pythonDeviceFor('directml'), 'auto', 'DirectML ist ONNX-Vokabular – pythonseitig auto (cuda/cpu)');
  assert.equal(pythonDeviceFor('vulkan'), 'auto');
  assert.equal(pythonDeviceFor(undefined), 'auto');
  console.log('  ✓ directml/vulkan -> auto, coreml/metal -> mps, keine argparse-Exit-2 mehr');

  // ---- #2: classifyFailure rendert Objekt-Ursachen lesbar ------------------
  console.log('\n[ TEST ] #2 classifyFailure: Objekt-Ursache wird JSON, nie „[object Object]“');
  const objectCause = classifyFailure('STEM_CONFIG_INVALID', 'Backend beendete sich mit Code 2', {
    stderr: 'usage: …',
    logs: ['letzte Zeile'],
  });
  assert.ok(!objectCause.message.includes('[object Object]'), `Meldung war: ${objectCause.message}`);
  assert.ok(objectCause.message.includes('usage'), 'Inhalt der Ursache muss erhalten bleiben');
  assert.ok(objectCause.code === 'STEM_CONFIG_INVALID');
  console.log(`  ✓ Meldung: ${objectCause.message}`);

  // ---- #3: Exit 2 ohne Protokollfehler zeigt den argparse-Grund ------------
  console.log('\n[ TEST ] #3 Prozess-Exit 2: stderr-Schwanz landet in der Fehlermeldung');
  const rejected = await runBackendProcess({ command: process.execPath, args: ['-e', ARGPARSE_FAIL] }).catch((error) => error);
  assert.ok(isStemError(rejected), `StemSeparationError erwartet, war: ${rejected}`);
  assert.equal(rejected.code, 'STEM_CONFIG_INVALID', 'Exit 2 = EXIT_BAD_ARGS -> STEM_CONFIG_INVALID');
  assert.ok(rejected.message.includes('invalid choice'), `argparse-Grund muss sichtbar sein:\n${rejected.message}`);
  assert.ok(rejected.message.includes("'directml'"), 'die abgelehnte Wahl muss im Text stehen');
  assert.ok(!rejected.message.includes('[object Object]'));
  console.log(`  ✓ ${rejected.code}: ${rejected.message.split('\n')[0]} (+ argparse-Zeile)`);

  // ---- #4: stderr-Inhalt steuert die Klassifizierung (OOM) -----------------
  console.log('\n[ TEST ] #4 CUDA-OOM im stderr-Schwanz wird als GPU_OUT_OF_MEMORY klassifiziert');
  const oom = await runBackendProcess({ command: process.execPath, args: ['-e', OOM_FAIL] }).catch((error) => error);
  assert.ok(isStemError(oom));
  assert.equal(oom.code, 'GPU_OUT_OF_MEMORY', `OOM-Signatur muss remappen, war: ${oom.code}`);
  assert.ok(oom.message.includes('out of memory'), 'der OOM-Text bleibt Bestandteil der Meldung');
  console.log(`  ✓ Exit 1 + OOM-Traceback -> ${oom.code}`);

  console.log('\n✔ TRANSPORT-FEHLERDIAGNOSE: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
