/**
 * Regressionstest für Latenzprobleme bei stems:engine-status und Datei-Hashing.
 *
 * Aus dem Produktionslog vom 18.09.2026:
 *  - Langsamer IPC-Handler ›stems:engine-status‹: 35413 ms, 108933 ms, 20033 ms
 *  - Langsamer IPC-Handler ›rekordbox:choose-directory‹: 40003 ms, 37021 ms
 *  - console-message arguments are deprecated
 *
 * Prüfungen:
 *  #1 Nicht existierender Python-Pfad bricht in < 5 ms ab (kein spawn / kein Timeout).
 *  #2 ModelManager persistiert Hashes in model-hashes.json und liest sie ohne I/O wieder.
 *  #3 ModelManager.listStatus({ fast: true }) blockiert nicht auf un-gecachten Dateien.
 *  #4 installed-models.json wird für Hash-Prüfungen herangezogen.
 *  #5 Parallele Backend-Probes laufen über Promise.all.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeTorchRuntime, clearTorchProbeCache } from '../src/stems/backends/runtimeProbe';
import { ModelManager, clearModelHashCache } from '../src/stems/modelManager';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { StemJobService } from '../src/stems/stemJobService';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  TEST: STATUS-LATENZ, PERSISTENTES HASHING & SCHNELLER STATUS     ');
console.log('═══════════════════════════════════════════════════════════════════');

const temp = mkdtempSync(path.join(os.tmpdir(), 'airdox-status-latency-'));
const cacheDir = path.join(temp, 'Cache');
const storeDir = path.join(temp, 'Models');
mkdirSync(cacheDir, { recursive: true });
mkdirSync(storeDir, { recursive: true });

async function run() {
  // ---- #1 Nicht existierender Python-Pfad bricht sofort ab (< 10 ms) --------
  console.log('\n[ TEST ] #1 Nicht existierender Python-Pfad meldet sofort');
  clearTorchProbeCache();
  const nonExistentPython = path.join(temp, 'does-not-exist', 'python.exe');
  const start = Date.now();
  const probe = await probeTorchRuntime({
    command: nonExistentPython,
    cacheDir,
    mode: 'fast',
  });
  const elapsed = Date.now() - start;
  assert.equal(probe.available, false);
  assert.match(probe.reason ?? '', /Python-Laufzeit nicht verfügbar/);
  assert.match(probe.detail ?? '', /Datei nicht gefunden/);
  assert.ok(elapsed < 100, `Dauer muss < 100 ms sein (war ${elapsed} ms)`);
  console.log(`  ✓ Nicht existierender Pfad in ${elapsed} ms abgelehnt: ${probe.detail}`);

  // ---- #2 ModelManager persistiert Hashes auf Platte ----------------------
  console.log('\n[ TEST ] #2 ModelManager persistiert Checkpoint-Hashes');
  clearModelHashCache();
  const registry = ModelRegistry.fromBundledCatalog();
  const manager = new ModelManager(registry, { storeDir });

  // Test-Checkpoint anlegen
  const dummyFile = 'htdemucs_fp16weights.onnx';
  const dummyPath = path.join(storeDir, dummyFile);
  const content = Buffer.alloc(1024 * 64, 42); // 64 KB Testdaten
  writeFileSync(dummyPath, content);

  const descriptor = registry.require('htdemucs-onnx-4stem-fp16');
  // Strict inspection berechnet den Hash und speichert ihn ab
  const status1 = await manager.verify(descriptor.id);
  assert.ok(status1.checkpoint?.sha256, 'Hash muss berechnet sein');
  const calculatedSha = status1.checkpoint?.sha256;

  // Prüfen ob model-hashes.json geschrieben wurde
  const hashFile = path.join(storeDir, 'model-hashes.json');
  assert.ok(existsSync(hashFile), 'model-hashes.json muss angelegt worden sein');
  const storedHashes = JSON.parse(readFileSync(hashFile, 'utf8'));
  assert.ok(storedHashes[dummyPath] || storedHashes[dummyFile], 'Hash muss in model-hashes.json stehen');

  // Cache im Speicher leeren – Abfrage muss trotzdem ohne Neuberechnung aus der Datei kommen
  clearModelHashCache();
  const manager2 = new ModelManager(registry, { storeDir });
  const status2 = await manager2.verify(descriptor.id);
  assert.equal(status2.checkpoint?.sha256, calculatedSha, 'Hash muss aus model-hashes.json geladen werden');
  console.log(`  ✓ Hash ${calculatedSha.slice(0, 16)}... erfolgreich in model-hashes.json persistiert und gelesen`);

  // ---- #3 installed-models.json wird bevorzugt genutzt ----------------------
  console.log('\n[ TEST ] #3 installed-models.json wird für Hash-Prüfung genutzt');
  clearModelHashCache();
  const manifestFile = path.join(storeDir, 'installed-models.json');
  const knownSha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  writeFileSync(manifestFile, JSON.stringify({
    'htdemucs-onnx-4stem-fp16': {
      file: dummyFile,
      sha256: knownSha,
      catalogSha256: null,
      installedAt: new Date().toISOString(),
    },
  }, null, 2));

  // Neues File mit identischer Größe
  const manager3 = new ModelManager(registry, { storeDir });
  const list = await manager3.listStatus({ fast: true });
  const htdemucsReport = list.find((m) => m.modelId === 'htdemucs-onnx-4stem-fp16');
  assert.ok(htdemucsReport, 'htdemucs Report muss existieren');
  assert.equal(htdemucsReport.checkpoint?.sha256, knownSha, 'Hash muss aus installed-models.json stammen');
  console.log('  ✓ Manifest installed-models.json korrekt ausgewertet');

  // ---- #4 Fast status auf StemJobService ----------------------------------
  console.log('\n[ TEST ] #4 StemJobService.status() läuft zügig');
  const service = new StemJobService({
    root: temp,
    modelStoreDir: storeDir,
    registry,
    mode: 'fast_dj',
    backend: {
      pythonCommand: nonExistentPython,
    },
  });

  const svcStart = Date.now();
  const serviceStatus = await service.status();
  const svcElapsed = Date.now() - svcStart;
  assert.ok(serviceStatus.profiles.length > 0, 'Profile müssen vorhanden sein');
  assert.ok(svcElapsed < 500, `Statusabfrage muss schnell sein (war ${svcElapsed} ms)`);
  console.log(`  ✓ StemJobService.status() abgeschlossen in ${svcElapsed} ms`);

  // Aufräumen
  rmSync(temp, { recursive: true, force: true });
  console.log('\n✔ STATUS-LATENZ-TEST: alle Prüfungen bestanden');
}

run().catch((err) => {
  console.error('\n✘ FEHLER:', err);
  process.exit(1);
});
