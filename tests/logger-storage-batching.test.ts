/**
 * Regressionstest für das Schreibverhalten des Renderer-Loggers
 * (`src/utils/logger.ts`).
 *
 * Warum dieser Test existiert:
 *   Jeder Log-Eintrag schrieb früher den kompletten localStorage-Spiegel neu –
 *   `getItem` → `JSON.parse` → `push` → `slice(-400)` → `JSON.stringify` →
 *   `setItem`, alles synchron. Bei 1.000 Einträgen waren das 1.000 vollständige
 *   Serialisierungen. Jetzt wird gepuffert: der Spiegel wird höchstens einmal
 *   pro `STORAGE_WRITE_BATCH` (25) Einträge bzw. mit dem regulären Flush
 *   geschrieben. ERROR schreibt weiterhin sofort (Absturz-Forensik), und der
 *   Inhalt bleibt vollständig.
 *
 * Der Test läuft in Node: `localStorage` wird vor dem Import gestubbt, damit
 * die Singleton-Erzeugung den Stub sieht.
 */

import assert from 'node:assert/strict';

interface StubStorage {
  setItemCalls: number;
  removeItemCalls: number;
  map: Map<string, string>;
}

const stub: StubStorage = { setItemCalls: 0, removeItemCalls: 0, map: new Map() };

(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => stub.map.get(key) ?? null,
  setItem: (key: string, value: string) => {
    stub.setItemCalls += 1;
    stub.map.set(key, value);
  },
  removeItem: (key: string) => {
    stub.removeItemCalls += 1;
    stub.map.delete(key);
  },
};

const { logger } = await import('../src/utils/logger.ts');
const STORAGE_KEY = 'airdox.logs.v1';

// ---------------------------------------------------------------------------
// 1. 1.000 Einträge -> höchstens 40 Spiegel-Schreibvorgänge (25er-Bündel)
// ---------------------------------------------------------------------------
const writesBefore = logger.getStorageWriteCount();
for (let index = 0; index < 1000; index++) {
  logger.info('SYSTEM', `Testeintrag ${index}`);
}
const writes = logger.getStorageWriteCount() - writesBefore;
assert.ok(writes <= 40, `Erwartet ≤ 40 Schreibvorgänge für 1000 Einträge, waren ${writes}`);
assert.ok(writes >= 1, 'Es muss mindestens einmal geschrieben worden sein');

const stored = JSON.parse(stub.map.get(STORAGE_KEY) ?? '[]');
assert.equal(stored.length, 400, 'Der Spiegel ist auf 400 Einträge begrenzt');
assert.ok(
  stored[stored.length - 1].message.startsWith('Testeintrag'),
  'Der jüngste Eintrag muss im Spiegel stehen'
);
console.log(`  ✓ 1000 Einträge ergeben ${writes} Spiegel-Schreibvorgänge (vorher 1000)`);

// ---------------------------------------------------------------------------
// 2. ERROR schreibt sofort (Absturz-Forensik)
// ---------------------------------------------------------------------------
const beforeError = logger.getStorageWriteCount();
logger.error('SYSTEM', 'Ein Fehler muss sofort gesichert sein');
const afterError = logger.getStorageWriteCount();
assert.equal(
  afterError - beforeError,
  1,
  'Ein ERROR muss den Spiegel unmittelbar schreiben – sonst fehlt er nach einem Absturz'
);
const afterErrorStored = JSON.parse(stub.map.get(STORAGE_KEY) ?? '[]');
assert.equal(afterErrorStored[afterErrorStored.length - 1].message, 'Ein Fehler muss sofort gesichert sein');
console.log('  ✓ ERROR schreibt den Spiegel sofort');

// ---------------------------------------------------------------------------
// 3. flush() schreibt ausstehende Einträge mit und clear() setzt zurück
// ---------------------------------------------------------------------------
logger.info('SYSTEM', 'Noch gepuffert');
await logger.flush();
const flushed = JSON.parse(stub.map.get(STORAGE_KEY) ?? '[]');
assert.equal(flushed[flushed.length - 1].message, 'Noch gepuffert', 'flush() muss den Puffer mitschreiben');

logger.clear();
assert.equal(stub.removeItemCalls, 1, 'clear() entfernt den Spiegel');
const writesAfterClear = logger.getStorageWriteCount();
logger.info('SYSTEM', 'Nach dem Zurücksetzen');
assert.equal(
  logger.getStorageWriteCount(),
  writesAfterClear,
  'Nach clear() darf der nächste Eintrag den Spiegel neu aufbauen, aber nicht sofort schreiben'
);
console.log('  ✓ flush() schreibt aus, clear() setzt den Puffer zurück');

console.log('  ✓ Renderer-Logger bündelt Speicher-Schreibvorgänge ohne Inhaltsverlust');
