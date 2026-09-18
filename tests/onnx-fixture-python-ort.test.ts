// @requires: onnxruntime_python
/**
 * ECHTE ORT-SESSION über das Fixture – Beweis für den Testgraphen.
 *
 * `tests/onnx-fast-separation-live.test.ts` fährt den kompletten schnellen
 * Editor-Pfad. Rechnet dort eine **Referenz-Runtime** (weil auf der Maschine
 * keine Node-ORT-Runtime liegt), muss belegt sein, dass das Fixture wirklich
 * ein ONNX-Graph mit genau dieser Signatur und genau diesen Werten ist. Das
 * macht dieser Test mit einer echten `onnxruntime`-Session (Python):
 *
 *   1. Graph lädt mit CPU-Provider (kein Training, keine Gewichte von außen),
 *   2. Eingabe `mix [1,2,4096] float32`, Ausgabe `stems [1,4,2,4096] float32`,
 *   3. `stems[i] = mix * gain[i]` mit gain = [0.5, 0.3, 0.15, 0.05] – die
 *      Zahlen, auf die der Editor-Test seine Pegelprüfung stützt,
 *   4. die Session ist deterministisch: zweiter Lauf, gleiches Ergebnis.
 *
 * Ist `onnxruntime` für Python nicht installiert, wird der Test übersprungen
 * (`pip install --break-system-packages onnxruntime`).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execPython = promisify(execFile);
const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'onnx', 'tiny-stem-separator.onnx');

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  ONNX-FIXTURE – echte ORT-Session (Python), Signatur und Gains    ');
console.log('═══════════════════════════════════════════════════════════════════');

const SCRIPT = `
import json, sys
import numpy as np
import onnxruntime as ort

session = ort.InferenceSession(sys.argv[1], providers=['CPUExecutionProvider'])
inputs = [(i.name, [int(d) if isinstance(d, int) else d for d in i.shape], i.type) for i in session.get_inputs()]
outputs = [(o.name, [int(d) if isinstance(d, int) else d for d in o.shape], o.type) for o in session.get_outputs()]

segment = int(inputs[0][1][-1])
mix = np.full((1, 2, segment), 0.25, dtype=np.float32)
stems = session.run(None, {inputs[0][0]: mix})[0]
gains = [float(stems[0, index, 0, 0] / 0.25) for index in range(stems.shape[1])]
again = session.run(None, {inputs[0][0]: mix})[0]
print(json.dumps({
    "providers": session.get_providers(),
    "inputs": inputs,
    "outputs": outputs,
    "dims": [int(d) for d in stems.shape],
    "gains": gains,
    "deterministic": bool(np.array_equal(stems, again)),
}))
`;

/**
 * Interpreter wie in `tests/stem-separation-bsroformer-live.test.ts` suchen:
 * CI-Runner heißen „python“ (Windows) oder „python3“ (Linux/macOS) – der Test
 * darf daran nicht scheitern.
 */
async function findPython(): Promise<string> {
  const candidates = [process.env.AIRODOX_STEM_PYTHON, 'python3', 'python'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      await execPython(candidate, ['-c', 'import sys; print(sys.version_info[0])']);
      return candidate;
    } catch {
      /* nächster Kandidat */
    }
  }
  throw new Error('Kein Python-Interpreter gefunden (python3/python).');
}

async function main() {
  const python = await findPython();
  // Ohne die Pakete ist hier nichts zu prüfen: der Lauf endet als SKIP (wie im
  // Runner, der den Test über `@requires: onnxruntime_python` überspringt) –
  // niemals als grüner Test, der nichts gemessen hat.
  try {
    await execPython(python, ['-c', 'import numpy, onnxruntime']);
  } catch {
    console.log(`\n  SKIP: ${python} hat numpy/onnxruntime nicht (pip install onnxruntime).`);
    return;
  }
  const { stdout } = await execPython(python, ['-c', SCRIPT, FIXTURE], { maxBuffer: 8 * 1024 * 1024 });
  const report = JSON.parse(stdout.trim().split('\n').pop() as string) as {
    providers: string[];
    inputs: [string, number[], string][];
    outputs: [string, number[], string][];
    dims: number[];
    gains: number[];
    deterministic: boolean;
  };

  console.log(`\n  Interpreter: ${python}`);
  console.log(`  Provider: ${report.providers.join(', ')}`);
  assert.ok(report.providers.includes('CPUExecutionProvider'), 'CPU-Provider ist aktiv');
  assert.equal(report.inputs[0][0], 'mix');
  assert.deepEqual(report.inputs[0][1], [1, 2, 4096], 'Eingabe-Signatur wie im HT-Demucs-Onnx-Export');
  assert.equal(report.inputs[0][2], 'tensor(float)');
  assert.equal(report.outputs[0][0], 'stems');
  assert.deepEqual(report.outputs[0][1], [1, 4, 2, 4096], 'vier Stems × zwei Kanäle × Segment');
  console.log('  ✓ mix [1,2,4096] → stems [1,4,2,4096], float32');

  assert.deepEqual(report.dims, [1, 4, 2, 4096]);
  const expected = [0.5, 0.3, 0.15, 0.05];
  report.gains.forEach((gain, index) => {
    assert.ok(
      Math.abs(gain - expected[index]) < 1e-5,
      `Gain ${index} ist ${gain}, erwartet ${expected[index]} (Reihenfolge drums/bass/other/vocals)`
    );
  });
  assert.equal(report.deterministic, true, 'die Session ist deterministisch – Testgrundlage für den Editor-Pfad');
  console.log(`  ✓ Gains ${report.gains.map((gain) => gain.toFixed(3)).join(' / ')} wie erwartet, deterministisch`);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  ONNX-FIXTURE MIT ECHTER ORT-SESSION BESTÄTIGT');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
