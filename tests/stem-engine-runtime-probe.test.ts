/**
 * RUNTIME-PROBE: schnell, gecacht, ehrlich.
 *
 * Der Produktionslog vom 18.09.2026 zeigt `stems:engine-status` mit 7178 /
 * 10531 / 14949 / 21173 ms – jede Abfrage startete erneut echte Interpreter
 * (`import torch`). Dieser Test hält die Verträge fest, die das verhindern:
 *
 *   #1 Ein Statusaufruf (`mode: 'fast'`) startet den Interpreter genau einmal
 *      und importiert torch nicht.
 *   #2 Der strenge Jobstart (`mode: 'strict'`) benutzt dieselbe Vorprüfung
 *      wieder (kein zweiter Interpreter für dieselbe Frage) und importiert
 *      genau einmal.
 *   #3 Wiederholte Aufrufe kommen aus dem Cache – ohne neuen Prozess.
 *   #4 Der Platten-Cache überlebt einen Prozess-/Speicher-Cache-Verlust.
 *   #5 Eine nicht unterstützte Python-Version nennt Bereich und Abhilfe.
 *   #6 Ein fehlendes Modul nennt Modul, Interpreter und Abhilfe.
 *   #7 Zeitüberschreitungen werden *nicht* auf Platte festgeschrieben
 *      (ein langsamer Virenscanner darf kein Dauer-„nicht verfügbar“ erzeugen).
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeTorchRuntime, clearTorchProbeCache, torchProbeSpawnCount } from '../src/stems/backends/runtimeProbe';
import { clearRuntimeCaches } from '../src/stems/runtimeCaches';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  RUNTIME-PROBE: EIN PROZESS, EIN VERDIKT, GECACHT                 ');
console.log('═══════════════════════════════════════════════════════════════════');

const temp = mkdtempSync(path.join(os.tmpdir(), 'airdox-probe-'));
const cacheDir = path.join(temp, 'Cache');

/** Eigener Zähler je Fake-Interpreter: nur so ist „erster/zweiter Start“ eindeutig. */
function counterFileFor(mode: string): string {
  return path.join(temp, `spawns-${mode}.log`);
}

/**
 * Fake-Interpreter (Node mit `-e`): zählt jeden Start in eine Datei und
 * antwortet wie ein Python, das die Probe-Einzeiler versteht. Der erste Start
 * liefert die billige Vorprüfung (JSON), der zweite den echten Import-Marker.
 */
function fakeInterpreter(
  mode: 'ok' | 'missing' | 'old' | 'broken' | 'slow',
  id: string = mode
): { command: string; argsPrefix: string[] } {
  const counterFile = counterFileFor(id);
  // Der Aufruf entscheidet, welche Stufe läuft – nicht ein Zähler: die Probe
  // ruft den Interpreter zuerst mit dem Vorprüf-Einzeiler (find_spec) und
  // danach mit dem Import-Einzeiler auf.
  const script = `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(counterFile)}, 'x');
const mode = ${JSON.stringify(mode)};
const stage = process.argv.some((arg) => arg.includes('find_spec')) ? 'fast' : 'import';
if (mode === 'slow') { setTimeout(() => {}, 8000); }
else if (stage === 'fast') {
  const modules = mode === 'missing' ? { torch: false } : { torch: true };
  console.log('AIRDDOX_PROBE ' + JSON.stringify({ version: mode === 'old' ? '3.14.0' : '3.11.9', executable: 'fake-python', modules }));
} else if (mode === 'broken') {
  console.error('ImportError: DLL load failed while importing _C: Das angegebene Modul wurde nicht gefunden.');
  process.exit(1);
} else {
  console.log('AIRDDOX_TORCH 2.5.1+cpu');
}
`;
  // Als *Datei* aufrufen (nicht `-e`): der Interpreter wird wie Python mit
  // `['-c', code]` aufgerufen, und `-c` ist für Node ein Eigenname (–check).
  const file = path.join(temp, `fake-python-${id}.js`);
  writeFileSync(file, script);
  return { command: process.execPath, argsPrefix: [file] };
}

function spawnCount(mode = 'ok'): number {
  const file = counterFileFor(mode);
  return existsSync(file) ? readFileSync(file, 'utf8').length : 0;
}

async function run() {
  // ---- #1/#2/#3: fast → strict → wiederholt --------------------------------
  console.log('\n[ TEST ] #1–#3 fast/strict teilen Vorprüfung und Cache');
  const ok = fakeInterpreter('ok');
  clearTorchProbeCache();
  const fast = await probeTorchRuntime({ ...ok, cacheDir, mode: 'fast' });
  assert.equal(fast.available, true, fast.reason);
  assert.equal(fast.verification, 'find_spec', 'Der Statuspfad darf torch nicht importieren');
  assert.equal(fast.interpreterVersion, '3.11');
  assert.equal(spawnCount(), 1, 'Genau ein Interpreterstart für den Statusaufruf');

  const strict = await probeTorchRuntime({ ...ok, cacheDir, mode: 'strict' });
  assert.equal(strict.available, true, strict.reason);
  assert.equal(strict.verification, 'import', 'Der Jobstart prüft den echten Import');
  assert.equal(strict.torchVersion, '2.5.1+cpu');
  assert.equal(spawnCount(), 2, 'Nur der Import startet einen zweiten Prozess – die Vorprüfung kommt aus dem Cache');

  const spawnsBefore = spawnCount();
  for (let i = 0; i < 3; i++) {
    const repeat = await probeTorchRuntime({ ...ok, cacheDir, mode: i % 2 === 0 ? 'fast' : 'strict' });
    assert.equal(repeat.available, true);
    assert.equal(repeat.cached, true, 'Wiederholte Abfragen müssen aus dem Cache kommen');
  }
  assert.equal(spawnCount(), spawnsBefore, 'Kein weiterer Interpreterstart nach dem ersten Verdikt');
  console.log(`  ✓ 1 Prozess (fast), 1 Prozess (import), 3 Cache-Treffer – ${torchProbeSpawnCount()} Probes`);

  // ---- #4: Platten-Cache ---------------------------------------------------
  console.log('\n[ TEST ] #4 Platten-Cache überlebt den Speicher-Cache');
  clearTorchProbeCache();
  const fromDisk = await probeTorchRuntime({ ...ok, cacheDir, mode: 'strict' });
  assert.equal(fromDisk.available, true);
  assert.equal(fromDisk.cached, true, 'Das Verdikt muss von Platte kommen');
  assert.equal(spawnCount(), spawnsBefore, 'Platten-Cache darf keinen Prozess starten');
  console.log('  ✓ Verdikt von Platte, kein neuer Prozess');

  // ---- #5: nicht unterstützte Python-Version -------------------------------
  console.log('\n[ TEST ] #5 Python 3.14 nennt Bereich und Abhilfe');
  const old = fakeInterpreter('old');
  const oldResult = await probeTorchRuntime({ ...old, cacheDir, mode: 'fast' });
  assert.equal(oldResult.available, false);
  assert.match(oldResult.reason ?? '', /Python 3\.14\.0 wird nicht unterstützt/, `Grund: ${oldResult.reason}`);
  assert.match(oldResult.reason ?? '', /3\.10–3\.12/, 'Der unterstützte Bereich muss in der Meldung stehen');
  assert.match(oldResult.detail ?? '', /3\.11/, 'Die Meldung muss die Abhilfe nennen');
  console.log(`  ✓ ${oldResult.reason}`);

  // ---- #6: fehlendes Modul -------------------------------------------------
  console.log('\n[ TEST ] #6 Fehlendes torch nennt Modul + Abhilfe');
  const missing = fakeInterpreter('missing');
  const missingResult = await probeTorchRuntime({ ...missing, cacheDir, mode: 'fast' });
  assert.equal(missingResult.available, false);
  assert.match(missingResult.reason ?? '', /torch ist in .* nicht installiert/);
  assert.match(missingResult.detail ?? '', /KI-Modelle installieren/);
  console.log(`  ✓ ${missingResult.reason}`);

  // ---- #6b: kaputter Import (DLL fehlt) nennt die Ursache ------------------
  console.log('\n[ TEST ] #6b Kaputter Import nennt die erste Fehlerzeile');
  const broken = fakeInterpreter('broken');
  const brokenResult = await probeTorchRuntime({ ...broken, cacheDir, mode: 'strict' });
  assert.equal(brokenResult.available, false);
  assert.match(brokenResult.reason ?? '', /nicht importierbar/);
  assert.match(brokenResult.detail ?? '', /DLL load failed/, `Detail: ${brokenResult.detail}`);
  console.log(`  ✓ ${brokenResult.reason} – ${brokenResult.detail}`);

  // ---- #7: Zeitüberschreitung wird nicht persistiert -----------------------
  console.log('\n[ TEST ] #7 Zeitüberschreitung wird nicht festgeschrieben');
  const slow = fakeInterpreter('slow');
  const slowCache = path.join(temp, 'CacheSlow');
  const slowResult = await probeTorchRuntime({ ...slow, cacheDir: slowCache, mode: 'fast', fastTimeoutMs: 200 });
  assert.equal(slowResult.available, false);
  assert.match(slowResult.reason ?? '', /nicht verfügbar|Zeitüberschreitung/);
  const persisted = path.join(slowCache, 'runtime-probe.json');
  const persistedEntries = existsSync(persisted)
    ? Object.values(JSON.parse(readFileSync(persisted, 'utf8')).entries ?? {}).length
    : 0;
  assert.equal(persistedEntries, 0, 'Ein Timeout ist keine belastbare Aussage und darf nicht auf Platte landen');
  // Und der nächste Aufruf misst wirklich wieder.
  const before = spawnCount('slow');
  assert.ok(before >= 1, 'Der erste Aufruf muss den Interpreter überhaupt gestartet haben');
  clearTorchProbeCache();
  await probeTorchRuntime({ ...slow, cacheDir: slowCache, mode: 'fast', fastTimeoutMs: 200 });
  assert.ok(spawnCount('slow') > before, 'Nach einem Timeout muss neu gemessen werden');
  console.log('  ✓ Timeout nur im Speicher, nächste Messung startet neu');

  // ---- #8: Installation verwirft die Verdikte ------------------------------
  console.log('\n[ TEST ] #8 clearRuntimeCaches() verwirft negative Verdikte');
  const installCache = path.join(temp, 'CacheInstall');

  // Ein positives Verdikt bleibt nach einer Installation gültig …
  const okAgain = fakeInterpreter('ok', 'ok-install');
  clearTorchProbeCache();
  await probeTorchRuntime({ ...okAgain, cacheDir: installCache, mode: 'strict' });
  const okSpawns = spawnCount('ok-install');
  await clearRuntimeCaches();
  const okCached = await probeTorchRuntime({ ...okAgain, cacheDir: installCache, mode: 'strict' });
  assert.equal(okCached.available, true);
  assert.equal(okCached.cached, true, 'Positives Verdikt darf nicht verworfen werden');
  assert.equal(spawnCount('ok-install'), okSpawns, 'Kein neuer Prozess für ein gültiges positives Verdikt');

  // … ein negatives muss verworfen werden (sonst bleibt „nicht verfügbar“
  // stehen, obwohl gerade installiert wurde).
  const negative = fakeInterpreter('missing', 'missing-install');
  const negativeCache = path.join(temp, 'CacheNegative');
  clearTorchProbeCache();
  await probeTorchRuntime({ ...negative, cacheDir: negativeCache, mode: 'fast' });
  const negativeSpawns = spawnCount('missing-install');
  assert.equal(negativeSpawns, 1);
  await clearRuntimeCaches();
  const remeasured = await probeTorchRuntime({ ...negative, cacheDir: negativeCache, mode: 'fast' });
  assert.equal(remeasured.available, false);
  assert.ok(
    spawnCount('missing-install') > negativeSpawns,
    'Nach clearRuntimeCaches() muss ein negatives Verdikt neu gemessen werden'
  );
  console.log(`  ✓ positiv gecacht, negativ neu gemessen (${spawnCount('missing-install')} Prozesse)`);

  // Aufräumen
  writeFileSync(path.join(temp, 'done'), '1');
  rmSync(temp, { recursive: true, force: true });
  console.log('\n✔ RUNTIME-PROBE: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
